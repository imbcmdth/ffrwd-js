/**
 * ffrwd-js: a client for the ffrwd job API, for a browser and for Node.
 *
 * Three things live here. `Registry` reads the package index -- what is
 * published, what a recipe is, and the lock a job runs against. The public
 * index needs no authorization and is asked first; given an `auth`, a package
 * the public index has no document for is read on the authorized routes
 * instead, which is the only way a private one can be read at all. `Ffrwd`
 * submits jobs and hands back a `Job` to follow and to take outputs from, and
 * hands its own authorization to the registry it builds -- so a caller who
 * passes a token gets that package for free. `substitute` and its two companions are the
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
 * `submit` is also three steps a caller can take one at a time, which is how a
 * web app splits the work: `ffrwd.prepare` and `ffrwd.ready` hold the token and
 * run on a server, while `upload` needs only the signed url the prepare
 * answered and runs in the page.
 *
 * ```ts
 * // on the server
 * const prepared = await ffrwd.prepare({ query, inputs: { "in.mp4": { bytes: size } } });
 * // in the browser, with JSON.parse(JSON.stringify(prepared))
 * await upload(prepared.uploads[0], file, { onProgress: (p) => bar(p.sent / p.total) });
 * // on the server again
 * const job = await ffrwd.ready(prepared);
 * ```
 *
 * @packageDocumentation
 */

export { FfrwdError } from "./errors.js";
export {
  CLIENT_VERSION,
  DEFAULT_API_URL,
  DEFAULT_OUTPUTS_EXPIRE_DAYS,
  DEFAULT_POLL_MS,
  Ffrwd,
  JOB_FORMAT_VERSION,
  Job,
  type Auth,
  type FfrwdOptions,
  type PrepareOptions,
  type PrepareSpec,
  type Prepared,
  type PreparedJob,
  type ReadyOptions,
  type SubmitOptions,
  type SubmitSpec,
  type UploadTicket,
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
export {
  hasUploadProgress,
  upload,
  type Destination,
  type UploadOptions,
} from "./upload.js";
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
  type Progress,
  type Recipe,
  type RecipeEntry,
  type RecipeVariable,
  type Remaining,
  type Sources,
  type SubmitAnswer,
  type SubmitBody,
  type SubmitInput,
  type Upload,
  type UploadEntry,
  type UploadProgress,
  type VersionEntry,
} from "./types.js";
