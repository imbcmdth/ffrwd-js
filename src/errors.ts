import type { JobDetail } from "./types.js";

/**
 * Every refusal this client raises, whatever raised it.
 *
 * The API answers a refusal as `{error, hint}` with a status, and this carries
 * all three unchanged: `error` is what was refused, `hint` is what to do about
 * it, and `status` is the HTTP status it came with. A refusal this client makes
 * on its own -- an unset variable, an answer it cannot read, an input it will
 * not send -- carries `status` 0, which is how a caller tells "the service said
 * no" from "this client said no before asking".
 *
 * `message` is `error`, so an uncaught one reads as the service's own sentence.
 * `job` is set only on the rejection `Job.wait` makes for a job that failed or
 * was cancelled, and holds the row it read.
 */
export class FfrwdError extends Error {
  /** The HTTP status the refusal came with, or 0 when this client refused. */
  readonly status: number;
  /** What was refused, in a sentence. */
  readonly error: string;
  /** What to do about it. */
  readonly hint: string;
  /** The job row, on a rejection about a job that failed or was cancelled. */
  readonly job?: JobDetail;

  constructor(init: { status: number; error: string; hint: string; job?: JobDetail }) {
    super(init.error);
    this.name = "FfrwdError";
    this.status = init.status;
    this.error = init.error;
    this.hint = init.hint;
    if (init.job !== undefined) this.job = init.job;
  }
}

/** A refusal this client makes before or instead of asking the service. */
export function refuse(error: string, hint: string): FfrwdError {
  return new FfrwdError({ status: 0, error, hint });
}

const MALFORMED_HINT =
  "the API answered something this client cannot read; it may be newer than " +
  "this library, or the url may not be an ffrwd API";

/**
 * An answer this client cannot read: status 0, and a hint that says so.
 *
 * `what` names the part that was wrong -- a missing `job_id`, an `uploads` that
 * is not an object, a digest the answer left out -- so the sentence points at
 * the document rather than at the request.
 */
export function malformed(what: string): FfrwdError {
  return new FfrwdError({ status: 0, error: what, hint: MALFORMED_HINT });
}
