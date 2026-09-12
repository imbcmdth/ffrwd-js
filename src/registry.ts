/**
 * The package index: what is published, what it depends on, and the lock a job
 * is run against.
 *
 * The public index is where this reads first, and for a public package it is
 * where it reads at all -- one JSON file per package, plus a `.sources.json`
 * beside it carrying each recipe's SQL and the files the archive published as
 * text. Both documents are unauthenticated, and no token is sent to either.
 *
 * A PRIVATE package is not in them. The registry writes those two documents for
 * public versions only, so a package only its namespace may see has no document
 * there at all -- which is why a registry with no `auth` answers "no package"
 * for one. Given `auth`, two authorized routes fill the gap:
 *
 *   - the detail document comes from `/private/p/<ns>/<pkg>`, which answers
 *     over every version the token's namespaces may see;
 *   - the SQL and the manifest come from the version's ARCHIVE, since there is
 *     no private sources document. That costs a signing call, a download and a
 *     gunzip per version, so it happens only when the public sources document
 *     has nothing for the version asked about. A public package never gets
 *     there, and never downloads an archive.
 *
 * `Ffrwd` hands its own authorization to the registry it builds, so a caller
 * who passed a token has all of this without asking for it.
 */

import { asText, gunzip, MAX_ARCHIVE_BYTES, readTar } from "./archive.js";
import { sha256Hex } from "./bytes.js";
import { FfrwdError, malformed, refuse } from "./errors.js";
import {
  bearer,
  callJson,
  DEFAULT_API_URL,
  type Auth,
  type FetchLike,
  platformFetch,
  request,
  requiredString,
} from "./http.js";
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
const NAMESPACE_HINT =
  "the token's account is not a member of that namespace; mint one that is";

/**
 * What a missing public document answers with, beyond a plain 404.
 *
 * Object storage answers a missing public object with HTTP 400 and a body that
 * names the 404 the status does not, so the status alone cannot be read as
 * "there it is not". This is the CLI's own list, and getting it wrong is what
 * would keep the private fallback below from ever firing.
 */
const ABSENT_MARKERS = ["404", "not_found", "NoSuchKey"];

/** True when `status` and `body` together mean the document is not there. */
function isAbsent(status: number, body: string): boolean {
  if (status === 404) return true;
  if (status !== 400) return false;
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    return false;
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) return false;
  const said = data as Record<string, unknown>;
  return ["statusCode", "error", "code"].some((key) =>
    ABSENT_MARKERS.includes(String(said[key])),
  );
}

function noSuchPackage(name: string): FfrwdError {
  return new FfrwdError({
    status: 404,
    error: `the registry has no package '${name}'`,
    hint: PUBLISHED_HINT,
  });
}

/**
 * Which archive members are published as text, matching what a public sources
 * document carries: the manifest, every `.sql`, and the readme and licence at
 * the package root.
 */
function isPublishedText(path: string): boolean {
  return (
    path === "ffrwd.json" ||
    path.endsWith(".sql") ||
    /^(README|LICEN[CS]E)(\.[^/]*)?$/.test(path)
  );
}

/** How to reach the index. */
export interface RegistryOptions {
  /** The index's base url. Defaults to the public one. */
  indexUrl?: string;
  /**
   * How to authorize for packages that are not public: the same `{token}` or
   * `{session}` an `Ffrwd` takes.
   *
   * Without one, this registry reads the two public documents and nothing else,
   * and a private package is "no package". With one, a package the public index
   * has no document for is asked for again on the authorized routes, and its
   * SQL and manifest are read out of the version's archive. It is never sent to
   * the public index.
   */
  auth?: Auth;
  /**
   * The job API's base url, which is where the authorized routes live. Defaults
   * to the public one. Only reached when `auth` is set.
   */
  apiUrl?: string;
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
 * The package index.
 *
 * One instance holds no state between calls: every method fetches the
 * documents it needs. `resolve` shares one cache across its own walk, so a
 * package reached twice is fetched once -- an archive included -- and that
 * cache is gone when it returns: two resolves a day apart see two days' worth
 * of publishing.
 *
 * Given `auth`, it also reads the packages that token's namespaces publish
 * privately. See this module's own notes for what that costs.
 */
export class Registry {
  /** The index's base url, without a trailing slash. */
  readonly indexUrl: string;
  /** The job API's base url, where the authorized routes live. */
  readonly apiUrl: string;
  readonly #fetch: FetchLike;
  /** The bearer for the authorized routes, or undefined for public-only. */
  readonly #token: string | undefined;

  constructor(options: RegistryOptions = {}) {
    this.indexUrl = (options.indexUrl ?? DEFAULT_INDEX_URL).replace(/\/+$/, "");
    this.apiUrl = (options.apiUrl ?? DEFAULT_API_URL).replace(/\/+$/, "");
    this.#fetch = options.fetch ?? platformFetch();
    const token = options.auth === undefined ? "" : bearer(options.auth);
    this.#token = token === "" ? undefined : token;
  }

  /**
   * One package's detail document: every version this registry may see, newest
   * first.
   *
   * The public document first. With `auth`, a package the public index has no
   * document for is asked for again on the authorized route, which answers over
   * every version the token's namespaces publish -- and only that second call
   * carries the bearer.
   *
   * Refuses when the name is not `<namespace>/<package>`; with a 404 when
   * neither route has such a document -- a package with no version this caller
   * may see is the same answer as no such package -- and with 401 or 403, in
   * the words the CLI uses, when the token is not in the namespace.
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
   * The public `.sources.json` is the cheap path and the usual one. With
   * `auth`, a version that document says nothing about -- a private one, whose
   * document is never written -- is read out of the version's ARCHIVE instead:
   * one signing call, one download, one gunzip, and the same shape comes back.
   * That is the expensive path, and it is taken only when there is nothing to
   * read otherwise.
   *
   * Without `auth`, refuses when the package has no `.sources.json`, and when
   * that document carries no such version. A package that published no SQL has
   * a document whose entries carry neither `sources` nor `files`; that is not a
   * refusal, it is an answer with both maps empty and `manifest` null.
   */
  async sources(name: string, version: string): Promise<Sources> {
    return (await this.#sourcesFor(name, version, new Map())).sources;
  }

  /**
   * One recipe, ready to run: its SQL, and what it asks the caller to set.
   *
   * `spec` names the package (`"ns/pkg"` or `"ns/pkg@1.2.3"`) and `recipeName`
   * the recipe in it. `required` and `optional` come from the detail document's
   * `recipes` entry, `text` from the sources beside it, and `version` is the
   * version both were read at.
   *
   * For a private package this is the whole of the expensive path: the detail
   * document over the authorized route, then the version's archive for the SQL,
   * whose member is the one the `recipes` entry's `file` names. A public
   * package reads two JSON documents and downloads nothing.
   *
   * Refuses when the package publishes no such recipe -- naming the ones it
   * does -- and when what was read carries no SQL for it, which is an index
   * that disagrees with itself.
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
    const { sources, where } = await this.#sourcesFor(name, entry.version, cache);
    const text = sources.recipes[recipeName];
    if (typeof text !== "string") {
      throw malformed(
        `'${name}' ${entry.version} lists a recipe '${recipeName}' ${where} has no SQL for`,
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
   * Nothing about a private package is different here: it pins the same way,
   * with the same `kind`, digest and store path, and its dependencies are read
   * out of the manifest in its archive rather than out of a sources document.
   * The runner signs archives by digest on its own side, so a lock does not
   * say, and does not need to say, which of its packages were public.
   *
   * Refuses on a dependency cycle, naming the loop, and on anything `version`
   * refuses. A package whose sources document publishes no manifest is taken to
   * depend on nothing: that document is all there is to read, and an archive is
   * downloaded only for a version the document has no entry for at all.
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

  /**
   * `name`'s detail document, public first.
   *
   * A public document that is not there -- a plain 404, or the 400 object
   * storage answers a missing object with -- is a private package as far as
   * this can tell, so with a token it is asked for again on the authorized
   * route. Without one there is nothing else to try. The cache is keyed by name
   * alone, as it always was: one document per package, wherever it came from.
   */
  async #detail(name: string, cache: Map<string, unknown>): Promise<PackageDetail> {
    checkName(name);
    const key = `detail:${name}`;
    const held = cache.get(key);
    if (held !== undefined) return held as PackageDetail;
    let url = `${this.indexUrl}/p/${name}.json`;
    let document = await this.#document(url);
    if (document === null) {
      if (this.#token === undefined) throw noSuchPackage(name);
      url = `${this.apiUrl}/private/p/${name}`;
      document = await this.#privateDetail(name, url);
    }
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

  /**
   * The detail document the authorized route answers with, or a refusal.
   *
   * The only request this makes that carries the bearer, beside the archive
   * signing below. A 401 or a 403 is the token not being in the namespace,
   * which is refused in the CLI's own words rather than as a bare status; a 404
   * here means no route has the package, which is the public answer too.
   */
  async #privateDetail(name: string, url: string): Promise<Record<string, unknown>> {
    try {
      return await callJson(this.#fetch, url, { token: this.#token });
    } catch (error) {
      const status = error instanceof FfrwdError ? error.status : 0;
      if (status === 401 || status === 403) {
        throw new FfrwdError({
          status,
          error: `this token does not authorize reading '${name}'`,
          hint: NAMESPACE_HINT,
        });
      }
      if (status === 404) throw noSuchPackage(name);
      throw error;
    }
  }

  /** One public index document, or null when the index does not have it. */
  async #document(url: string): Promise<Record<string, unknown> | null> {
    const response = await request(this.#fetch, url);
    const body = await response.text();
    if (isAbsent(response.status, body)) return null;
    if (!response.ok) {
      throw new FfrwdError({
        status: response.status,
        error: `the index refused ${url} with HTTP ${response.status}`,
        hint: "the index is public; try again, or check the index url",
      });
    }
    return readObject(body, url);
  }

  async #sourcesDocument(
    name: string,
    cache: Map<string, unknown>,
  ): Promise<SourcesDocument | null> {
    checkName(name);
    const key = `sources:${name}`;
    if (cache.has(key)) return cache.get(key) as SourcesDocument | null;
    const url = `${this.indexUrl}/p/${name}.sources.json`;
    const document = (await this.#document(url)) as SourcesDocument | null;
    cache.set(key, document);
    return document;
  }

  /**
   * One version's sources, and a word for where they were read, which the two
   * callers put into their own refusals.
   *
   * The public document decides: an entry for the version is the answer, and
   * the archive is not touched. No entry -- a private package, whose document
   * does not exist, or a version it does not carry -- goes to the archive when
   * there is a token, and refuses the way it always did when there is not.
   */
  async #sourcesFor(
    name: string,
    version: string,
    cache: Map<string, unknown>,
  ): Promise<{ sources: Sources; where: string }> {
    const document = await this.#sourcesDocument(name, cache);
    const entry = (document?.versions ?? []).find((one) => one.version === version);
    if (entry !== undefined) {
      return { sources: this.#sourcesOf(name, entry), where: "the sources document" };
    }
    if (this.#token !== undefined) {
      return { sources: await this.#fromArchive(name, version, cache), where: "its archive" };
    }
    if (document === null) {
      throw new FfrwdError({
        status: 404,
        error: `the index has no sources document for '${name}'`,
        hint: "only a package that published SQL has one; there is nothing to read",
      });
    }
    throw new FfrwdError({
      status: 404,
      error: `the sources document for '${name}' carries no version ${version}`,
      hint: `published there: ${(document.versions ?? [])
        .map((one) => one.version ?? "?")
        .join(", ")}`,
    });
  }

  /** One version's sources, out of its archive. Cached per name and version. */
  async #fromArchive(
    name: string,
    version: string,
    cache: Map<string, unknown>,
  ): Promise<Sources> {
    const key = `archive:${name}@${version}`;
    const held = cache.get(key);
    if (held !== undefined) return held as Sources;
    const detail = await this.#detail(name, cache);
    const entry = detail.versions.find((one) => one.version === version);
    if (entry === undefined) {
      throw refuse(
        `the registry has no version ${version} of '${name}'`,
        `published: ${detail.versions.map((one) => one.version).join(", ")}`,
      );
    }
    const sources = await this.#archive(name, entry);
    cache.set(key, sources);
    return sources;
  }

  /**
   * Download one version's archive and read the sources out of it.
   *
   * In order: the signing call, which is bearer-authorized and answers a GET
   * good for five minutes; the download, which carries nothing; the DIGEST,
   * checked against what the registry published before a single byte is
   * decompressed, let alone parsed; then gunzip and tar.
   *
   * What comes back is the shape a sources document gives: every recipe the
   * detail entry lists, keyed by name and read from the member its `file`
   * names; the manifest, every `.sql`, the readme and the licence as `files`;
   * and the manifest parsed. Anything else in the archive is left in it.
   */
  async #archive(name: string, entry: VersionEntry): Promise<Sources> {
    const url = `${this.apiUrl}/archive/${entry.sha256}`;
    let answer: Record<string, unknown>;
    try {
      answer = await callJson(this.#fetch, url, { token: this.#token });
    } catch (error) {
      const status = error instanceof FfrwdError ? error.status : 0;
      if (status === 401 || status === 403) {
        throw new FfrwdError({
          status,
          error: `this token does not authorize downloading '${name}' ${entry.version}`,
          hint: NAMESPACE_HINT,
        });
      }
      throw error;
    }
    const signed = requiredString(answer, "url", url);
    const response = await request(this.#fetch, signed);
    if (!response.ok) {
      throw new FfrwdError({
        status: response.status,
        error:
          `the signed url for '${name}' ${entry.version} answered HTTP ${response.status}`,
        hint: "a signed url is good for five minutes; ask for another",
      });
    }
    const raw = new Uint8Array(await response.arrayBuffer());
    if (raw.byteLength > MAX_ARCHIVE_BYTES) {
      throw refuse(
        `the archive of '${name}' ${entry.version} is more than ${MAX_ARCHIVE_BYTES} bytes`,
        "this client reads an archive in memory; that one is for the CLI to install",
      );
    }
    const digest = await sha256Hex(raw);
    if (digest !== entry.sha256) {
      throw refuse(
        `the archive downloaded for '${name}' ${entry.version} hashes to ${digest}, ` +
          `not the ${entry.sha256} the registry published`,
        "nothing was read out of it; the download is not what this version published",
      );
    }
    const what = `${name} ${entry.version}`;
    const members = readTar(await gunzip(raw, what), what);
    const files: Record<string, string> = {};
    for (const [path, bytes] of members) {
      if (isPublishedText(path)) files[path] = asText(bytes);
    }
    const recipes: Record<string, string> = {};
    for (const one of entry.recipes ?? []) {
      if (typeof one?.name !== "string" || typeof one.file !== "string") continue;
      const held = members.get(one.file);
      if (held !== undefined) recipes[one.name] = asText(held);
    }
    const manifest = files["ffrwd.json"];
    return {
      name,
      version: entry.version,
      sha256: entry.sha256,
      recipes,
      files,
      manifest:
        typeof manifest === "string" ? parseManifest(manifest, name, entry.version) : null,
    };
  }

  /**
   * One version's manifest, or null when nothing readable publishes one.
   *
   * The sources document's entry decides, and an entry that carries no
   * `ffrwd.json` is a package that depends on nothing -- no archive is
   * downloaded for it. Only a version the document has NO entry for goes to the
   * archive, and only with a token: that is the private case, and it is the
   * only one a resolve pays for.
   */
  async #manifest(
    name: string,
    version: string,
    cache: Map<string, unknown>,
  ): Promise<Manifest | null> {
    const document = await this.#sourcesDocument(name, cache);
    const entry = (document?.versions ?? []).find((one) => one.version === version);
    if (entry !== undefined) {
      const text = entry.files?.["ffrwd.json"];
      if (typeof text !== "string") return null;
      return parseManifest(text, name, version);
    }
    if (this.#token === undefined) return null;
    return (await this.#fromArchive(name, version, cache)).manifest;
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

function readObject(text: string, url: string): Record<string, unknown> {
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
