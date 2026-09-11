/**
 * ffrwd-js: a client for the ffrwd job API, for a browser and for Node.
 *
 * Three things live here. `Registry` reads the public package index -- what is
 * published, what a recipe is, and the lock a job runs against -- and needs no
 * authorization at all. `Ffrwd` submits jobs and hands back a `Job` to follow
 * and to take outputs from. `substitute` and its two companions are the
 * query-variable rules, ported from the CLI so that a query written for one
 * runs the same through the other.
 *
 * Everything refuses with `FfrwdError`, which carries the service's own
 * `{error, hint}` and the status it came with -- status 0 when this client
 * refused before asking.
 *
 * ```ts
 * const ffrwd = new Ffrwd({ token: "ffrwd_…" });
 * const job = await ffrwd.submit({
 *   query: "COPY (SELECT f.video[1] FROM input('in.mp4') f) TO 'out.mp4'",
 *   inputs: { "in.mp4": file },
 * });
 * await job.wait({ onUpdate: (d) => console.log(d.state, d.progress_pct) });
 * const blob = await job.download("out.mp4");
 * ```
 *
 * @packageDocumentation
 */

export { FfrwdError } from "./errors.js";
export {
  CLIENT_VERSION,
  DEFAULT_API_URL,
  DEFAULT_POLL_MS,
  Ffrwd,
  JOB_FORMAT_VERSION,
  Job,
  type Auth,
  type FfrwdOptions,
  type SubmitOptions,
  type SubmitSpec,
  type WaitOptions,
} from "./jobs.js";
export {
  DEFAULT_INDEX_URL,
  LOCK_FORMAT_VERSION,
  Registry,
  compareVersions,
  lockOf,
  parseSpec,
  storePath,
  versionKey,
  type RegistryOptions,
} from "./registry.js";
export { copyDestinations } from "./query.js";
export { declaredVariables, referenced, substitute, type Substitution, type Variable } from "./vars.js";
export { byteLength, isBytes, sha256Hex, type Bytes } from "./bytes.js";
export { hasUploadProgress } from "./upload.js";
export type { FetchLike } from "./http.js";
export {
  ACTIVE_STATES,
  TERMINAL_STATES,
  isActive,
  isTerminal,
  type FetchAnswer,
  type Job as JobRow,
  type JobDetail,
  type JobList,
  type JobState,
  type ListQuery,
  type Lock,
  type LockEntry,
  type Manifest,
  type Output,
  type PackageDetail,
  type Recipe,
  type RecipeEntry,
  type RecipeVariable,
  type Remaining,
  type Sources,
  type SubmitAnswer,
  type SubmitBody,
  type SubmitInput,
  type Upload,
  type UploadProgress,
  type VersionEntry,
} from "./types.js";
