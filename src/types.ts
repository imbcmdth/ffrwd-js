/**
 * The shapes the ffrwd API sends and takes, mirrored key for key.
 *
 * Every type in this file is the wire document as the API writes it,
 * `snake_case` and all, so that what a caller reads here is what the service
 * said and nothing this client invented. Client-side inputs -- the things a
 * caller hands to `Ffrwd.submit` -- are camelCase and live beside the code
 * that consumes them.
 */

/** A job's state. The first five are active; the last three are terminal. */
export type JobState =
  | "submitted"
  | "queued"
  | "starting"
  | "running"
  | "finalizing"
  | "succeeded"
  | "failed"
  | "cancelled";

/**
 * The states a job is still under way in, in the order it passes through them.
 *
 * `submitted` is waiting for its uploads, `queued` for a slot, `starting` is a
 * coordinator staging and compiling, `running` is the pipeline, and
 * `finalizing` is the outputs being hashed and stored.
 */
export const ACTIVE_STATES = [
  "submitted",
  "queued",
  "starting",
  "running",
  "finalizing",
] as const satisfies readonly JobState[];

/** The three ends a job can come to. */
export const TERMINAL_STATES = [
  "succeeded",
  "failed",
  "cancelled",
] as const satisfies readonly JobState[];

/** True when `state` is one a job is still under way in. */
export function isActive(state: string): boolean {
  return (ACTIVE_STATES as readonly string[]).includes(state);
}

/** True when `state` is one a job never leaves. */
export function isTerminal(state: string): boolean {
  return (TERMINAL_STATES as readonly string[]).includes(state);
}

/**
 * The window's unspent credit, read as the seconds each class could still run.
 * Empty for a billed account, which runs unbudgeted.
 */
export interface Remaining {
  period?: string;
  resets_on?: string;
  cpu_seconds?: number;
  gpu_seconds?: number;
  free_cpu_min?: number;
  free_gpu_min?: number;
}

/**
 * A job as a listing shows it.
 *
 * The pin columns read together: nothing set is unpinned; `pin_requested_at`
 * alone is a move on its way; `pinned_at` with `pinned_location` is pinned;
 * `pin_error` names why the last move failed, and the request stands.
 */
export interface Job {
  id: string;
  title: string | null;
  state: JobState;
  recipe: string | null;
  gpu: boolean;
  progress_pct: number | null;
  exit_code: number | null;
  error: string | null;
  client_version: string | null;
  image_ffrwd_version: string | null;
  duration_cpu_s: number | null;
  duration_gpu_s: number | null;
  bytes_in: number | null;
  bytes_out: number | null;
  budget_exhausted: boolean;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  cancelled_at: string | null;
  heartbeat_at: string | null;
  outputs_expire_at: string | null;
  pin_requested_at: string | null;
  pinned_at: string | null;
  pinned_location: string | null;
  pinned_bytes: number | null;
  pin_error: string | null;
  /** Whatever else a newer API sends: kept, never read. */
  [key: string]: unknown;
}

/**
 * One job in full: the listing's fields plus the log tail and what it wrote.
 *
 * Both extras are optional here because the endpoints that answer with a bare
 * row -- ready, cancel, pin -- send the same document without them, and
 * `outputs` is null until the job succeeds.
 */
export interface JobDetail extends Job {
  log_tail?: string | null;
  outputs?: Output[] | null;
}

/** One thing a run wrote. `url` is present only in a fetch answer. */
export interface Output {
  path: string;
  bytes?: number;
  sha256: string;
  kind: "file" | "tree";
  /** For a tree: how many files the tar holds. */
  files?: number;
  /** What the object is stored and downloaded as. */
  name?: string;
  /** In a fetch answer only: a presigned GET, good an hour. */
  url?: string;
}

/** One page of the caller's own jobs, newest first, and the total it was cut from. */
export interface JobList {
  jobs: Job[];
  total: number;
  remaining?: Remaining;
}

/** The answer to a fetch: every output, each with a presigned GET. */
export interface FetchAnswer {
  job_id: string;
  outputs: Output[];
}

/** Where one upload's bytes go, and when the url stops working. */
export interface Upload {
  url: string;
  expires_at: string;
}

/** What a submit hands back. */
export interface SubmitAnswer {
  job_id: string;
  /** One entry per distinct file input, keyed by sha256. May be empty. */
  uploads: Record<string, Upload>;
  ready_url: string;
  outputs_expire_days?: number;
  pin_output?: boolean;
  title?: string | null;
  remaining?: Remaining;
}

/** One input as the submit declares it. */
export interface SubmitInput {
  path: string;
  kind: "file" | "url";
  sha256?: string;
  bytes?: number;
}

/** The submit body, `format_version` 2. */
export interface SubmitBody {
  format_version: 2;
  query: string;
  variables?: Record<string, string>;
  recipe?: string | null;
  lock?: string | null;
  packages: string[];
  inputs: SubmitInput[];
  outputs: string[];
  timeout_s?: number;
  client_version: string;
  pin_output?: boolean;
  title?: string;
}

/** Which page of jobs to list. */
export interface ListQuery {
  section?: "current" | "archived";
  filter?: "all" | "unpinned" | "pinned" | "failed";
  /** Matched literally, case-insensitively, against title, query and paths. */
  q?: string;
  state?: JobState;
  limit?: number;
  offset?: number;
  signal?: AbortSignal;
}

/** One variable a recipe declares, as the index document records it. */
export interface RecipeVariable {
  name: string;
  description?: string;
}

/** One recipe as the package's detail document lists it. */
export interface RecipeEntry {
  name: string;
  file?: string;
  usage?: string;
  description?: string;
  compiles?: boolean;
  required?: RecipeVariable[];
  optional?: RecipeVariable[];
}

/** One published version, as the public index holds it. */
export interface VersionEntry {
  version: string;
  sha256: string;
  size: number;
  namespace?: string;
  capabilities?: string[];
  engines_ffrwd?: string | null;
  license?: string | null;
  homepage?: string | null;
  models?: Record<string, unknown> | null;
  yanked?: boolean;
  published_at?: string;
  description?: string;
  readme_html?: string;
  recipes?: RecipeEntry[];
  functions?: unknown[];
  [key: string]: unknown;
}

/** A package's public index document: every public version, newest first. */
export interface PackageDetail {
  format_version: number;
  name: string;
  versions: VersionEntry[];
}

/** A package's manifest (`ffrwd.json`), as far as this client reads it. */
export interface Manifest {
  name?: string;
  version?: string;
  description?: string;
  license?: string;
  homepage?: string;
  /**
   * Package name to the version the manifest wrote. Resolution goes by NAME:
   * the written version is not what a resolve pins. See `Registry.resolve`.
   */
  dependencies?: Record<string, string>;
  [key: string]: unknown;
}

/**
 * One version's sources: each recipe's SQL, the files the archive published as
 * text, and the manifest parsed out of them.
 */
export interface Sources {
  name: string;
  version: string;
  sha256: string;
  /** Recipe name to its SQL text. */
  recipes: Record<string, string>;
  /** Published file path to its text. Empty for a package that published none. */
  files: Record<string, string>;
  /** `ffrwd.json` parsed, or null when the document carries no files. */
  manifest: Manifest | null;
}

/** One recipe, ready to run: its SQL and what it asks the caller to set. */
export interface Recipe {
  name: string;
  /** The recipe's SQL, as published. */
  text: string;
  required: RecipeVariable[];
  optional: RecipeVariable[];
  usage: string;
  /** The package version the text came from. */
  version: string;
}

/** One `registry` entry in a lock document. */
export interface LockEntry {
  kind: "registry";
  name: string;
  version: string;
  sha256: string;
  /** Where the content belongs in a store: `v1/<first two hex>/<sha256>`. */
  store: string;
  /** Present only when non-empty: what this version's manifest resolved to. */
  dependencies?: Record<string, string>;
}

/**
 * A lock document, format 3, plus the exact text a submit sends.
 *
 * The fields mirror `ffrwd.lock` key for key, so `JSON.parse(lock.text)` is
 * this object without `text`. `packages` is in post-order: a package comes
 * after everything it depends on, so an entry's `dependencies` map never
 * names something further down the list.
 */
export interface Lock {
  format_version: 3;
  reproducible: true;
  /** What was directly asked for: package name to the version it resolved to. */
  dependencies: Record<string, string>;
  packages: LockEntry[];
  /** The document as `ffrwd.lock` text: 2-space indent, LF, trailing newline. */
  text: string;
}

/** How far one upload has got. */
export interface UploadProgress {
  /** The input's path, as the query names it. */
  path: string;
  /** Bytes sent so far. */
  sent: number;
  /** Bytes in all. */
  total: number;
}
