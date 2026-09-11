/**
 * psql-style variable substitution for query text, and the header that
 * declares them. A faithful port of the CLI's `ffrwd/vars.py`: the same scan,
 * the same replacements, the same refusals, word for word.
 */

import { FfrwdError, refuse } from "./errors.js";

/** Anchored name match: a SQL identifier's shape. */
const NAME_AT = /[A-Za-z_][A-Za-z0-9_]*/y;
/** Unanchored name search, for the declaring header's body. */
const NAME_IN = /[A-Za-z_][A-Za-z0-9_]*/g;
/** A subscript body that is a positive integer literal. */
const INT_BODY = /^[0-9]+$/;
/** A subscript body that is a dot-qualified row column (`i.i`, `r.name`). */
const COLUMN_BODY = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)+$/;

const NULL = "NULL";

/**
 * Substituted query text, plus where each unset variable's NULL landed.
 *
 * `unset` is keyed by the NULL keyword's 1-based `"line:col"` in `text`, so a
 * later refusal at the NULL's point of use can say which variable was not set
 * instead of "NULL is not a path". The map is for messages only.
 */
export interface Substitution {
  text: string;
  unset: Map<string, string>;
}

/** One variable a query declares: its name, and what the header says it is. */
export interface Variable {
  name: string;
  description: string;
}

/**
 * Replace every `:'name'`, `:"name"` and `:name` in `text` with its value.
 *
 * The scan skips the spans a SQL lexer skips -- `'...'` strings, `"..."`
 * identifiers, `--` line comments and block comments -- so a colon inside one
 * of those is left alone. A `::` cast and a lone `:` pass through unchanged.
 * Each form takes an optional `[k]` subscript: the value splits on commas and
 * the reference becomes ONE element, 1-based, quoted the way the form asks. A
 * dot-qualified subscript body (`:widths[i.i]`) cannot be known until the query
 * runs, so it becomes an `ARRAY[...]` element access instead -- raw elements
 * for `:name`, string literals for `:'name'`. Without a subscript a
 * comma-carrying value stays the one raw text it always was.
 *
 * A reference to a variable `variables` does not hold becomes the bare keyword
 * `NULL` -- absence, which every binding site treats as "not written".
 *
 * Refuses, as an `FfrwdError` with status 0:
 * - `:name[0]`, which subscripts below the start of the list;
 * - a subscript past the end of the list, naming the list's length;
 * - `:"name"[i.i]`, since an identifier is a compile-time name and its
 *   subscript must be an integer literal;
 * - any other subscript body, which is neither an integer nor a row column.
 */
export function substitute(text: string, variables: Record<string, string>): Substitution {
  const out: string[] = [];
  let length = 0; // of the output built so far
  const nulls: Array<[number, string]> = []; // (output offset, variable name)
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i] as string;
    if (ch === "'" || ch === '"') {
      const end = scanQuoted(text, i, ch);
      out.push(text.slice(i, end));
      length += end - i;
      i = end;
      continue;
    }
    if (text.startsWith("--", i)) {
      const found = text.indexOf("\n", i);
      const end = found === -1 ? n : found;
      out.push(text.slice(i, end));
      length += end - i;
      i = end;
      continue;
    }
    if (text.startsWith("/*", i)) {
      const found = text.indexOf("*/", i + 2);
      const end = found === -1 ? n : found + 2;
      out.push(text.slice(i, end));
      length += end - i;
      i = end;
      continue;
    }
    if (ch === ":" && text.startsWith("::", i)) {
      out.push("::");
      length += 2;
      i += 2;
      continue;
    }
    if (ch === ":") {
      const found = matchReference(text, i);
      if (found !== null) {
        const [name, referenceEnd] = found;
        let end = referenceEnd;
        const subscript = matchSubscript(text, referenceEnd);
        if (subscript !== null) end = subscript[1];
        let replacement: string;
        if (!Object.prototype.hasOwnProperty.call(variables, name)) {
          // Unset stays NULL-is-absence, subscripted or not.
          replacement = NULL;
          nulls.push([length, name]);
        } else if (subscript !== null) {
          replacement = element(text[i + 1] ?? "", name, variables[name] as string, subscript[0]);
        } else {
          replacement = replacementFor(text[i + 1] ?? "", variables[name] as string);
        }
        out.push(replacement);
        length += replacement.length;
        i = end;
        continue;
      }
    }
    out.push(ch);
    length += 1;
    i += 1;
  }
  const result = out.join("");
  const unset = new Map<string, string>();
  for (const [offset, name] of nulls) {
    const [line, col] = lineCol(result, offset);
    unset.set(`${line}:${col}`, name);
  }
  return { text: result, unset };
}

/**
 * Every variable name `text` references, over the same scan as `substitute`.
 *
 * Names inside strings, identifiers and comments are not references and are not
 * reported; a subscript is consumed with the reference it belongs to.
 */
export function referenced(text: string): Set<string> {
  const names = new Set<string>();
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i] as string;
    if (ch === "'" || ch === '"') {
      i = scanQuoted(text, i, ch);
      continue;
    }
    if (text.startsWith("--", i)) {
      const found = text.indexOf("\n", i);
      i = found === -1 ? n : found;
      continue;
    }
    if (text.startsWith("/*", i)) {
      const found = text.indexOf("*/", i + 2);
      i = found === -1 ? n : found + 2;
      continue;
    }
    if (ch === ":" && text.startsWith("::", i)) {
      i += 2;
      continue;
    }
    if (ch === ":") {
      const found = matchReference(text, i);
      if (found !== null) {
        const [name, referenceEnd] = found;
        let end = referenceEnd;
        const subscript = matchSubscript(text, referenceEnd);
        if (subscript !== null) end = subscript[1];
        names.add(name);
        i = end;
        continue;
      }
    }
    i += 1;
  }
  return names;
}

const HEADER = /^--\s*variables:\s*(.+)$/m;

/**
 * The variables `text`'s `-- variables:` header declares, in written order.
 *
 * ```sql
 * -- variables: source (input media path), prefix (output name prefix)
 * ```
 *
 * Empty for a query with no such header: the header is documentation, and a
 * query is free not to carry one. A description is whatever the parentheses
 * after a name hold, commas and all; a name written without them declares
 * itself and nothing more. Nothing here refuses anything.
 */
export function declaredVariables(text: string): Variable[] {
  const header = HEADER.exec(text);
  if (header === null) return [];
  const body = header[1] as string;
  const found: Variable[] = [];
  let at = 0;
  while (at < body.length) {
    NAME_IN.lastIndex = at;
    const match = NAME_IN.exec(body);
    if (match === null) break;
    const [description, after] = descriptionAt(body, match.index + match[0].length);
    found.push({ name: match[0], description });
    // Past the separating comma, so a description's own words are not read as
    // further names.
    const comma = body.indexOf(",", after);
    at = comma === -1 ? body.length : comma + 1;
  }
  return found;
}

/**
 * End offset (exclusive) of the `'...'`/`"..."` run at `start`; a doubled quote
 * stays inside the run, and an unclosed one runs to the end of the text.
 */
function scanQuoted(text: string, start: number, quote: string): number {
  let i = start + 1;
  const n = text.length;
  while (i < n) {
    if (text[i] === quote) {
      if (i + 1 < n && text[i + 1] === quote) {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i += 1;
  }
  return n;
}

/**
 * The `:name`/`:'name'`/`:"name"` reference at `start` as `[name, end]`, or null
 * when nothing there fits the shape -- the caller then copies the colon as-is.
 */
function matchReference(text: string, start: number): [string, number] | null {
  const next = start + 1 < text.length ? (text[start + 1] as string) : "";
  const quote = next === "'" || next === '"' ? next : "";
  const nameStart = quote ? start + 2 : start + 1;
  NAME_AT.lastIndex = nameStart;
  const match = NAME_AT.exec(text);
  if (match === null) return null;
  const nameEnd = nameStart + match[0].length;
  if (quote) {
    if (nameEnd >= text.length || text[nameEnd] !== quote) return null;
    return [match[0], nameEnd + 1];
  }
  return [match[0], nameEnd];
}

/**
 * The `[<body>]` subscript at `start` as `[body, end]`, or null when the
 * reference has none: no `[` directly after it, or no `]` on the same line --
 * a real subscript never spans one.
 */
function matchSubscript(text: string, start: number): [string, number] | null {
  if (start >= text.length || text[start] !== "[") return null;
  const close = text.indexOf("]", start + 1);
  if (close === -1) return null;
  const body = text.slice(start + 1, close);
  if (body.includes("\n")) return null;
  return [body.trim(), close + 1];
}

/**
 * One element of a list variable, or the `ARRAY[...]` access that reads it per
 * row; a subscript the grammar has no reading for is a refusal, never text left
 * in the query.
 */
function element(quote: string, name: string, value: string, body: string): string {
  const elements = value.split(",");
  if (INT_BODY.test(body)) {
    const index = Number.parseInt(body, 10);
    if (index === 0) {
      throw refuse(
        `':${name}[0]' subscripts below the start of the list`,
        `list subscripts are 1-based: :${name}[1] is the first element`,
      );
    }
    if (index > elements.length) {
      throw refuse(
        `':${name}[${index}]' is past the end: the list has ${counted(elements.length)}`,
        `-v ${name}=... splits on commas; subscript from 1 to ${elements.length}`,
      );
    }
    return replacementFor(quote, elements[index - 1] as string);
  }
  if (COLUMN_BODY.test(body)) {
    if (quote === '"') {
      throw refuse(
        `':"${name}"[${body}]' picks an identifier per row`,
        "an identifier is a compile-time name, so its subscript must be an " +
          `integer literal, e.g. :"${name}"[1]`,
      );
    }
    const listed =
      quote === "'"
        ? elements.map((one) => "'" + one.replace(/'/g, "''") + "'").join(",")
        : value;
    return `ARRAY[${listed}][${body}]`;
  }
  throw refuse(
    `':${name}[${body}]' is not a list subscript`,
    "a list subscript is a positive integer literal or a row column, e.g. " +
      `:${name}[1] or :${name}[i.i]`,
  );
}

/** `n` elements, spelled for a message. */
function counted(n: number): string {
  return `${n} element` + (n === 1 ? "" : "s");
}

/** A set variable's value, quoted the way the reference form asks. */
function replacementFor(quote: string, value: string): string {
  if (quote === "'") return "'" + value.replace(/'/g, "''") + "'";
  if (quote === '"') return '"' + value.replace(/"/g, '""') + '"';
  return value;
}

/** 1-indexed [line, col] of `offset` in `text`. */
function lineCol(text: string, offset: number): [number, number] {
  let line = 1;
  for (let i = 0; i < offset; i += 1) if (text[i] === "\n") line += 1;
  // lastIndexOf clamps a negative start to 0, which would find a newline AT 0;
  // offset 0 is column 1 whatever the text begins with.
  const lastNewline = offset === 0 ? -1 : text.lastIndexOf("\n", offset - 1);
  return [line, offset - lastNewline];
}

/** The `(...)` description at `start`, and where it ends; `["", start]` if none. */
function descriptionAt(body: string, start: number): [string, number] {
  let at = start;
  while (at < body.length && /\s/.test(body[at] as string)) at += 1;
  if (at >= body.length || body[at] !== "(") return ["", start];
  let depth = 0;
  for (let end = at; end < body.length; end += 1) {
    if (body[end] === "(") depth += 1;
    else if (body[end] === ")") {
      depth -= 1;
      if (depth === 0) return [body.slice(at + 1, end).trim(), end + 1];
    }
  }
  return [body.slice(at + 1).trim(), body.length]; // unclosed: the rest of the line
}

/**
 * The refusal for a required variable a caller did not set.
 *
 * `Ffrwd.submit` raises it, naming the variable, before anything is sent.
 */
export function unsetVariable(name: string, what: string): FfrwdError {
  return refuse(`':${name}' was not set`, `${what}; set it with variables.${name}`);
}
