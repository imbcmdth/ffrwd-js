/**
 * What a query says about itself, read off the text alone.
 *
 * No SQL parser ships in this library, so these are scans, not parses: they
 * skip the spans a lexer skips -- strings, quoted identifiers, comments -- and
 * read the shapes that matter to a submit. The CLI does the same job off a real
 * parse tree; where the two could disagree is noted on each function.
 */

/**
 * Every `COPY ... TO '<path>'` destination in `text`, in written order.
 *
 * This is what `Ffrwd.submit` sends as the job's `outputs` when the caller
 * names none: a PRE-FLIGHT VIEW of what the query says it will write, which is
 * what the API asks for -- the run itself discovers what it actually wrote, and
 * a fetch reads that back. `TO STDOUT` names no file and a parenthesized
 * `TO (<expression>)` computes its paths, so neither appears here.
 *
 * The scan is textual. It skips comments and quoted identifiers, requires a
 * `COPY` earlier in the same statement (statements split on `;`), and takes the
 * string literal that follows the word `TO`. A destination built by an
 * expression is not one it can see, and a caller with such a query should pass
 * `outputs` itself. Nothing here refuses anything: a query it reads nothing out
 * of yields an empty list.
 */
export function copyDestinations(text: string): string[] {
  const found: string[] = [];
  let lastWord = "";
  let lastChar = "";
  let copySeen = false;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i] as string;
    if (ch === "-" && text.startsWith("--", i)) {
      const end = text.indexOf("\n", i);
      i = end === -1 ? n : end;
      continue;
    }
    if (ch === "/" && text.startsWith("/*", i)) {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }
    if (ch === '"') {
      i = endOfQuoted(text, i, '"');
      lastWord = "";
      lastChar = '"';
      continue;
    }
    if (ch === "'") {
      const end = endOfQuoted(text, i, "'");
      // `TO (` starts an expression, whose first literal is not a destination.
      if (copySeen && lastWord === "to" && lastChar !== "(") {
        found.push(text.slice(i + 1, end - 1).replace(/''/g, "'"));
      }
      i = end;
      lastWord = "";
      lastChar = "'";
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let end = i + 1;
      while (end < n && /[A-Za-z0-9_]/.test(text[end] as string)) end += 1;
      lastWord = text.slice(i, end).toLowerCase();
      lastChar = "w";
      if (lastWord === "copy") copySeen = true;
      i = end;
      continue;
    }
    if (ch === ";") {
      copySeen = false;
      lastWord = "";
      lastChar = ";";
      i += 1;
      continue;
    }
    if (!/\s/.test(ch)) lastChar = ch;
    i += 1;
  }
  return found;
}

/** End offset (exclusive) of the quoted run at `start`; a doubled quote stays inside. */
function endOfQuoted(text: string, start: number, quote: string): number {
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
