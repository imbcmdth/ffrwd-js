/**
 * The public package index: what is published, what it depends on, and the lock
 * a job is run against.
 *
 * Every document this reads is public and unauthenticated -- one JSON file per
 * package, plus a `.sources.json` beside it carrying each recipe's SQL and the
 * files the archive published as text. Nothing here needs a token, and nothing
 * here sends one.
 */

import { FfrwdError, malformed, refuse } from "./errors.js";
import { type FetchLike, platformFetch, request } from "./http.js";
import type {
  Lock,
  LockEntry,
  Manifest,
  PackageDetail,
  Recipe,
  RecipeEntry,
  Sources,
  VersionEntry,
} from "./types.js";

/** Where the public index lives. */
export const DEFAULT_INDEX_URL =
  "https://api.ffrwd.video/storage/v1/object/public/packages";

/** The lock format this client writes and the runner reads. */
export const LOCK_FORMAT_VERSION = 3;

/** The store layout a lock entry's `store` path is written in. */
const STORE_FORMAT = "v1";

const NAME_RE = /^[a-z_][a-z0-9_]*\/[a-z_][a-z0-9_]*$/;
const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9.+-]*$/;
const PUBLISHED_HINT =
  "run a search, or check the name: the index publishes one document per package";

/** How to reach the index. */
export interface RegistryOptions {
  /** The index's base url. Defaults to the public one. */
  indexUrl?: string;
  /** The `fetch` to use. Defaults to the platform's. */
  fetch?: FetchLike;
}

/** A package pinned at one version: what a lock entry is built from. */
interface Release {
  name: string;
  version: string;
  sha256: string;
}

/** The `.sources.json` document, as it is written. */
interface SourcesDocument {
  format_version?: number;
  name?: string;
  versions?: Array<{
    version?: string;
    sha256?: string;
    sources?: Record<string, string>;
    files?: Record<string, string>;
  }>;
}

/**
 * The public package index.
 *
 * One instance holds no state between calls: every method fetches the
 * documents it needs. `resolve` shares one cache across its own walk, so a
 * package reached twice is fetched once, and that cache is gone when it
 * returns -- two resolves a day apart see two days' worth of publishing.
 */
export class Registry {
  /** The index's base url, without a trailing slash. */
  readonly indexUrl: string;
  readonly #fetch: FetchLike;

  constructor(options: RegistryOptions = {}) {
    this.indexUrl = (options.indexUrl ?? DEFAULT_INDEX_URL).replace(/\/+$/, "");
    this.#fetch = options.fetch ?? platformFetch();
  }

  /**
   * One package's detail document: every public version, newest first.
   *
   * Refuses when the name is not `<namespace>/<package>`, and with a 404 when
   * the index has no such document -- a package with no public version has
   * none, which is the same answer as no such package.
   */
  async package(name: string): Promise<PackageDetail> {
    return this.#detail(name, new Map());
  }

  /**
   * The published version `spec` names.
   *
   * `"ns/pkg"` is the highest non-yanked version by `versionKey` -- parts split
   * on dots, numeric ones compared as numbers, so 1.10.0 sorts above 1.9.0.
   * `"ns/pkg@1.2.3"` is exactly that version.
   *
   * Refuses when the package publishes nothing, and when it publishes nothing
   * at the version asked for -- that refusal names every version it does
   * publish, in order.
   */
  async version(spec: string): Promise<VersionEntry> {
    return this.#version(spec, new Map());
  }

  /**
   * One version's sources: each recipe's SQL, the published files as text, and
   * the manifest parsed out of them.
   *
   * Refuses when the package has no `.sources.json`, and when that document
   * carries no such version. A package that published no SQL has a document
   * whose entries carry neither `sources` nor `files`; that is not a refusal,
   * it is an answer with both maps empty and `manifest` null.
   */
  async sources(name: string, version: string): Promise<Sources> {
    const document = await this.#sourcesDocument(name, new Map());
    if (document === null) {
      throw new FfrwdError({
        status: 404,
        error: `the index has no sources document for '${name}'`,
        hint: "only a package that published SQL has one; there is nothing to read",
      });
    }
    const entry = (document.versions ?? []).find((one) => one.version === version);
    if (entry === undefined) {
      throw new FfrwdError({
        status: 404,
        error: `the sources document for '${name}' carries no version ${version}`,
        hint: `published there: ${(document.versions ?? [])
          .map((one) => one.version ?? "?")
          .join(", ")}`,
      });
    }
    return this.#sourcesOf(name, entry);
  }

  /**
   * One recipe, ready to run: its SQL, and what it asks the caller to set.
   *
   * `spec` names the package (`"ns/pkg"` or `"ns/pkg@1.2.3"`) and `recipeName`
   * the recipe in it. `required` and `optional` come from the detail document's
   * `recipes` entry, `text` from the sources document beside it, and `version`
   * is the version both were read at.
   *
   * Refuses when the package publishes no such recipe -- naming the ones it
   * does -- and when the sources document carries no SQL for it, which is an
   * index that disagrees with itself.
   */
  async recipe(spec: string, recipeName: string): Promise<Recipe> {
    const cache = new Map<string, unknown>();
    const { name } = parseSpec(spec);
    const entry = await this.#version(spec, cache);
    const recipes: RecipeEntry[] = Array.isArray(entry.recipes) ? entry.recipes : [];
    const found = recipes.find((one) => one.name === recipeName);
    if (found === undefined) {
      const published = recipes.map((one) => one.name).join(", ");
      throw refuse(
        `'${name}' ${entry.version} publishes no recipe '${recipeName}'`,
        published ? `it publishes: ${published}` : "it publishes no recipes at all",
      );
    }
    const document = await this.#sourcesDocument(name, cache);
    const version = (document?.versions ?? []).find((one) => one.version === entry.version);
    const text = version?.sources?.[recipeName];
    if (typeof text !== "string") {
      throw malformed(
        `'${name}' ${entry.version} lists a recipe '${recipeName}' the sources ` +
          "document has no SQL for",
      );
    }
    return {
      name: recipeName,
      text,
      required: found.required ?? [],
      optional: found.optional ?? [],
      usage: found.usage ?? "",
      version: entry.version,
    };
  }

  /**
   * The lock pinning `specs` and everything they depend on.
   *
   * Resolution is the CLI's, exactly: a spec without a version takes the
   * highest published non-yanked one; a dependency a manifest names is resolved
   * BY NAME, at the highest published version, and the version the manifest
   * wrote is not consulted -- so a lock can pin a dependency newer than the
   * manifest that asked for it. Each package appears once, at one version: a
   * name reached twice is left at the version already pinned.
   *
   * `packages` comes back in post-order -- a package after everything it
   * depends on -- and an entry carries `dependencies` only when it has some.
   * `text` is the `ffrwd.lock` document, which is what a submit sends.
   *
   * Refuses on a dependency cycle, naming the loop, and on anything `version`
   * refuses. A package whose sources document publishes no manifest is taken to
   * depend on nothing: the index is all there is to read, and an archive is
   * never downloaded here.
   */
  async resolve(specs: string[]): Promise<Lock> {
    const cache = new Map<string, unknown>();
    const entries: LockEntry[] = [];
    const dependencies: Record<string, string> = {};
    for (const spec of specs) {
      const entry = await this.#version(spec, cache);
      const { name } = parseSpec(spec);
      const release: Release = { name, version: entry.version, sha256: entry.sha256 };
      await this.#ensure(release, entries, [], cache);
      dependencies[name] = entry.version;
    }
    return lockOf(entries, dependencies);
  }

  /**
   * Put `release`, and everything its manifest depends on, into `entries`.
   *
   * Post-order, as the CLI's `_ensure` is: a package's own entry is appended
   * only once every dependency it names is resolved, so the `dependencies` map
   * recorded on it is complete the moment it is written. `chain` is the names
   * being walked -- an ancestor reappearing is a cycle, checked first, since it
   * is what stops an infinite walk.
   */
  async #ensure(
    release: Release,
    entries: LockEntry[],
    chain: string[],
    cache: Map<string, unknown>,
  ): Promise<void> {
    if (chain.includes(release.name)) {
      const loop = [...chain.slice(chain.indexOf(release.name)), release.name].join(" -> ");
      throw refuse(
        `dependency cycle: ${loop}`,
        "there is no resolver here to break it; one of these packages has to " +
          "stop depending on another in the loop",
      );
    }
    if (entries.some((one) => one.name === release.name)) return;
    const manifest = await this.#manifest(release.name, release.version, cache);
    const named = Object.keys(manifest?.dependencies ?? {});
    chain.push(release.name);
    const resolved: Record<string, string> = {};
    for (const name of named) {
      // A name already pinned stays at the version it was pinned at, and that
      // is the version recorded here: an entry's `dependencies` has to name
      // versions the same lock actually carries.
      const held = entries.find((one) => one.name === name);
      if (held !== undefined) {
        resolved[name] = held.version;
        continue;
      }
      const entry = await this.#version(name, cache);
      await this.#ensure(
        { name, version: entry.version, sha256: entry.sha256 },
        entries,
        chain,
        cache,
      );
      resolved[name] = entry.version;
    }
    chain.pop();
    entries.push({
      kind: "registry",
      name: release.name,
      version: release.version,
      sha256: release.sha256,
      store: storePath(release.sha256),
      ...(Object.keys(resolved).length > 0 ? { dependencies: resolved } : {}),
    });
  }

  async #version(spec: string, cache: Map<string, unknown>): Promise<VersionEntry> {
    const { name, version } = parseSpec(spec);
    const detail = await this.#detail(name, cache);
    const published = detail.versions.filter((one) => one.yanked !== true);
    if (published.length === 0) {
      throw refuse(`the registry publishes no version of '${name}'`, PUBLISHED_HINT);
    }
    if (version === null) {
      return published.reduce((best, one) =>
        compareVersions(one.version, best.version) > 0 ? one : best,
      );
    }
    const found = published.find((one) => one.version === version);
    if (found === undefined) {
      const listed = [...published]
        .sort((a, b) => compareVersions(a.version, b.version))
        .map((one) => one.version)
        .join(", ");
      throw refuse(
        `the registry has no version ${version} of '${name}'`,
        `published: ${listed}`,
      );
    }
    return found;
  }

  async #detail(name: string, cache: Map<string, unknown>): Promise<PackageDetail> {
    checkName(name);
    const key = `detail:${name}`;
    const held = cache.get(key);
    if (held !== undefined) return held as PackageDetail;
    const url = `${this.indexUrl}/p/${name}.json`;
    const response = await request(this.#fetch, url);
    if (response.status === 404) {
      throw new FfrwdError({
        status: 404,
        error: `the registry has no package '${name}'`,
        hint: PUBLISHED_HINT,
      });
    }
    const document = await readDocument(response, url);
    const versions = document["versions"];
    if (typeof document["name"] !== "string" || !Array.isArray(versions)) {
      throw malformed(`${url} is not a package detail document`);
    }
    if (document["name"] !== name) {
      throw malformed(`${url} describes another package than '${name}'`);
    }
    for (const one of versions as VersionEntry[]) {
      if (typeof one?.version !== "string" || typeof one?.sha256 !== "string") {
        throw malformed(`${url} has a version entry without a version and a sha256`);
      }
    }
    const detail = document as unknown as PackageDetail;
    cache.set(key, detail);
    return detail;
  }

  async #sourcesDocument(
    name: string,
    cache: Map<string, unknown>,
  ): Promise<SourcesDocument | null> {
    checkName(name);
    const key = `sources:${name}`;
    if (cache.has(key)) return cache.get(key) as SourcesDocument | null;
    const url = `${this.indexUrl}/p/${name}.sources.json`;
    const response = await request(this.#fetch, url);
    if (response.status === 404) {
      cache.set(key, null);
      return null;
    }
    const document = (await readDocument(response, url)) as SourcesDocument;
    cache.set(key, document);
    return document;
  }

  /** One version's manifest, or null when the index publishes none for it. */
  async #manifest(
    name: string,
    version: string,
    cache: Map<string, unknown>,
  ): Promise<Manifest | null> {
    const document = await this.#sourcesDocument(name, cache);
    const entry = (document?.versions ?? []).find((one) => one.version === version);
    const text = entry?.files?.["ffrwd.json"];
    if (typeof text !== "string") return null;
    return parseManifest(text, name, version);
  }

  #sourcesOf(
    name: string,
    entry: { version?: string; sha256?: string; sources?: Record<string, string>; files?: Record<string, string> },
  ): Sources {
    const files = entry.files ?? {};
    const text = files["ffrwd.json"];
    return {
      name,
      version: entry.version ?? "",
      sha256: entry.sha256 ?? "",
      recipes: entry.sources ?? {},
      files,
      manifest:
        typeof text === "string" ? parseManifest(text, name, entry.version ?? "") : null,
    };
  }
}

/**
 * Sort key for a version: dot-separated parts, numeric ones compared as
 * numbers. Enough for the exact-pin world this registry lives in -- it orders
 * 1.10.0 above 1.9.0, which string order does not.
 */
export function versionKey(version: string): Array<[number, number, string]> {
  return version.split(".").map((piece) =>
    /^[0-9]+$/.test(piece)
      ? ([0, Number.parseInt(piece, 10), ""] as [number, number, string])
      : ([1, 0, piece] as [number, number, string]),
  );
}

/** Negative, zero or positive as `a` sorts below, with, or above `b`. */
export function compareVersions(a: string, b: string): number {
  const left = versionKey(a);
  const right = versionKey(b);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const one = left[i];
    const other = right[i];
    if (one === undefined) return -1;
    if (other === undefined) return 1;
    for (let part = 0; part < 3; part += 1) {
      const x = one[part] as number | string;
      const y = other[part] as number | string;
      if (x === y) continue;
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/** Where content of this digest belongs in a store, as a lock entry writes it. */
export function storePath(sha256: string): string {
  return `${STORE_FORMAT}/${sha256.slice(0, 2)}/${sha256}`;
}

/**
 * A lock document over `entries`, with its text.
 *
 * The text is what `ffrwd.lock` holds: keys in written order, 2-space indent,
 * a trailing newline. `dependencies` is written only when something was
 * directly asked for, which is how the CLI writes it.
 */
export function lockOf(entries: LockEntry[], dependencies: Record<string, string>): Lock {
  const payload: Record<string, unknown> = {
    format_version: LOCK_FORMAT_VERSION,
    reproducible: true,
  };
  if (Object.keys(dependencies).length > 0) payload["dependencies"] = { ...dependencies };
  payload["packages"] = entries;
  return {
    format_version: LOCK_FORMAT_VERSION,
    reproducible: true,
    dependencies,
    packages: entries,
    text: JSON.stringify(payload, null, 2) + "\n",
  };
}

/** `<name>` or `<name>@<version>` split, both halves checked for shape. */
export function parseSpec(spec: string): { name: string; version: string | null } {
  const at = spec.indexOf("@");
  const name = at === -1 ? spec : spec.slice(0, at);
  checkName(name);
  if (at === -1) return { name, version: null };
  const version = spec.slice(at + 1);
  if (!VERSION_RE.test(version)) {
    throw refuse(
      `'${spec}' does not name a version`,
      "a version is written after '@', e.g. ffrwd/faceage@0.1.0",
    );
  }
  return { name, version };
}

function checkName(name: string): void {
  if (!NAME_RE.test(name)) {
    throw refuse(
      `'${name}' does not name a package`,
      "a package name is <namespace>/<package>, e.g. ffrwd/faceage",
    );
  }
}

function parseManifest(text: string, name: string, version: string): Manifest {
  try {
    const data: unknown = JSON.parse(text);
    if (data === null || typeof data !== "object" || Array.isArray(data)) {
      throw new Error("not an object");
    }
    return data as Manifest;
  } catch {
    throw malformed(`the manifest '${name}' ${version} published is not a JSON object`);
  }
}

async function readDocument(
  response: Response,
  url: string,
): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (!response.ok) {
    throw new FfrwdError({
      status: response.status,
      error: `the index refused ${url} with HTTP ${response.status}`,
      hint: "the index is public; try again, or check the index url",
    });
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw malformed(`${url} answered with something that is not JSON`);
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw malformed(`${url} answered with something that is not a JSON object`);
  }
  return data as Record<string, unknown>;
}
