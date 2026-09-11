/**
 * Jobs: submitting one, following it, and taking what it wrote.
 *
 * The flow the API asks for, in order: POST the spec, PUT every file input to
 * the presigned url the answer named for its digest, then POST the answer's
 * `ready_url` to join the queue. This module does exactly that and nothing
 * between -- no retries of its own, no polling the caller did not ask for.
 */

import { byteLength, isBytes, sha256Hex, type Bytes } from "./bytes.js";
import { FfrwdError, malformed, refuse } from "./errors.js";
import { callJson, type FetchLike, platformFetch, requiredString } from "./http.js";
import { copyDestinations } from "./query.js";
import { Registry } from "./registry.js";
import type {
  FetchAnswer,
  JobDetail,
  JobList,
  ListQuery,
  Lock,
  Output,
  SubmitAnswer,
  SubmitBody,
  SubmitInput,
  Upload,
  UploadProgress,
} from "./types.js";
import { isTerminal } from "./types.js";
import { put } from "./upload.js";
import { declaredVariables, substitute, unsetVariable } from "./vars.js";

/** Where the job API lives. */
export const DEFAULT_API_URL = "https://api.ffrwd.video/functions/v1";

/** The submit format this client writes. */
export const JOB_FORMAT_VERSION = 2;

/** What this client calls itself to the API when the caller names nothing. */
export const CLIENT_VERSION = "ffrwd-js/0.1.0";

/** How often `wait` asks, when the caller does not say. */
export const DEFAULT_POLL_MS = 3000;

/**
 * How the caller is authorized: an `ffrwd_…` token with the `run` scope, or a
 * signed-in session's JWT. Both travel as `Authorization: Bearer …`; the API
 * tells them apart itself.
 */
export type Auth = { token: string } | { session: string };

/** The rest of what an `Ffrwd` takes. */
export interface FfrwdOptions {
  /** The job API's base url. Defaults to the public one. */
  apiUrl?: string;
  /** The registry to resolve recipes and packages against. Defaults to a new one. */
  registry?: Registry;
  /** The `fetch` to use for everything. Defaults to the platform's. */
  fetch?: FetchLike;
  /** What to record as the client that submitted. Defaults to `ffrwd-js/<version>`. */
  clientVersion?: string;
}

/** What a submit says to run, and with what. */
export interface SubmitSpec {
  /** The SQL to run. Give this or `recipe`, never both. */
  query?: string;
  /** A published recipe to run, written `"ns/pkg:name"` or `"ns/pkg@1.2.3:name"`. */
  recipe?: string;
  /** Values for the query's `:name` references. Sent as written, for the record. */
  variables?: Record<string, string>;
  /** Registry packages to resolve into the lock, beside anything `recipe` needs. */
  packages?: string[];
  /** A lock built elsewhere. Wins over `packages` and the recipe's own package. */
  lock?: Lock | string;
  /**
   * The job's inputs, keyed by the path the query names. A `Blob` or
   * `Uint8Array` is uploaded from here; a `{url}` is the runner's to open, and
   * its key must BE that url, since the API carries one string per input.
   */
  inputs?: Record<string, Bytes | { url: string }>;
  /** What the run is expected to write. Defaults to the query's `COPY ... TO` paths. */
  outputs?: string[];
  /** Clamped by the API to 60-21600 seconds; its default is 3600. */
  timeoutSeconds?: number;
  /** What to call the run, at most 120 characters. */
  title?: string;
  /** Pin the outputs on success, so they outlive the 7-day window. Needs a subscription. */
  pinOutput?: boolean;
}

/** What `submit` takes beyond the spec. */
export interface SubmitOptions {
  signal?: AbortSignal;
  /** Heard as each input's bytes go out. See `hasUploadProgress`. */
  onProgress?: (progress: UploadProgress) => void;
}

/** What `wait` takes. */
export interface WaitOptions {
  signal?: AbortSignal;
  /** Heard once per poll, terminal state included. */
  onUpdate?: (detail: JobDetail) => void;
  /** Milliseconds between polls. Defaults to 3000, which is the CLI's interval. */
  intervalMs?: number;
}

/** The seam a `Job` reaches the API through. */
interface Client {
  fetch: FetchLike;
  apiUrl: string;
  token: string;
}

/**
 * A client for the ffrwd job API.
 *
 * One instance holds the authorization and the urls; it makes no request until
 * asked. Every method that takes a `signal` forwards it to every request it
 * makes, and a network failure propagates as `fetch` threw it -- only an ANSWER
 * becomes an `FfrwdError`.
 */
export class Ffrwd {
  readonly #client: Client;
  readonly #registry: Registry;
  readonly #clientVersion: string;

  constructor(options: Auth & FfrwdOptions) {
    const token = "token" in options ? options.token : options.session;
    if (typeof token !== "string" || token === "") {
      throw refuse(
        "an ffrwd client needs a token or a session to authorize with",
        "pass {token: 'ffrwd_…'} for a token with the run scope, or " +
          "{session: '<jwt>'} for a signed-in session",
      );
    }
    const fetchImpl = options.fetch ?? platformFetch();
    this.#client = {
      fetch: fetchImpl,
      apiUrl: (options.apiUrl ?? DEFAULT_API_URL).replace(/\/+$/, ""),
      token,
    };
    this.#registry = options.registry ?? new Registry({ fetch: fetchImpl });
    this.#clientVersion = options.clientVersion ?? CLIENT_VERSION;
  }

  /** The registry this client resolves recipes and packages against. */
  get registry(): Registry {
    return this.#registry;
  }

  /**
   * Submit a job: post the spec, upload its bytes, queue it.
   *
   * In order, and nothing else in between:
   *
   * 1. The query text is settled -- a recipe's published SQL, or `query` --
   *    and `variables` are substituted into it. A recipe whose `required`
   *    variables are not all set is refused here, naming the first one.
   * 2. The lock is built: `lock` as given, else a resolve over `packages` and
   *    the recipe's own package, else nothing.
   * 3. Every `file` input is hashed with SHA-256 and declared with its digest
   *    and its size. See `sha256Hex` for what that costs in memory.
   * 4. POST `/jobs`.
   * 5. Every digest is looked up in the answer's `uploads` BEFORE the first
   *    PUT: a digest the answer left out is an answer this client cannot read,
   *    not bytes half sent.
   * 6. Each input is PUT to its url, `onProgress` hearing the bytes.
   * 7. POST the answer's `ready_url`, which queues the job.
   *
   * Refuses when neither or both of `query` and `recipe` are given, when an
   * input is neither bytes nor a `{url}` whose key is that url, when a required
   * recipe variable is unset, when the submit answer is missing `job_id`,
   * `ready_url` or an `uploads` object, and with the API's own words for
   * anything the service refuses.
   */
  async submit(spec: SubmitSpec, options: SubmitOptions = {}): Promise<Job> {
    const variables = spec.variables ?? {};
    const { text, recipePackage } = await this.#queryText(spec, variables);
    const lock = await this.#lock(spec, recipePackage);
    const { inputs, uploads } = await readInputs(spec.inputs ?? {});

    const body: SubmitBody = {
      format_version: JOB_FORMAT_VERSION,
      query: text,
      // The stored query has the variables substituted in; they travel raw as
      // well, so the job's record holds what was asked, not only what it became.
      variables,
      recipe: spec.recipe ?? null,
      lock,
      // Nothing is packed here: a browser has no linked package to send.
      packages: [],
      inputs,
      // The syntactic view alone, which is what the API asks for.
      outputs: spec.outputs ?? copyDestinations(text),
      client_version: this.#clientVersion,
    };
    if (spec.timeoutSeconds !== undefined) body.timeout_s = spec.timeoutSeconds;
    if (spec.pinOutput !== undefined) body.pin_output = spec.pinOutput;
    if (spec.title !== undefined) body.title = spec.title;

    const where = `${this.#client.apiUrl}/jobs`;
    const answered = await callJson(this.#client.fetch, where, {
      method: "POST",
      json: body,
      token: this.#client.token,
      signal: options.signal,
    });
    const answer = readSubmitAnswer(answered, where);

    // Every destination before the first PUT.
    const planned = uploads.map((one) => {
      const destination = answer.uploads[one.sha256];
      if (destination === undefined || typeof destination.url !== "string") {
        throw malformed(
          `the submit answer carries no upload url for '${one.path}' ` +
            `(sha256 ${one.sha256})`,
        );
      }
      return { ...one, destination };
    });
    for (const one of planned) {
      await put(this.#client.fetch, one.destination, one.body, {
        path: one.path,
        onProgress: options.onProgress,
        signal: options.signal,
      });
    }
    await callJson(this.#client.fetch, answer.ready_url, {
      method: "POST",
      json: {},
      token: this.#client.token,
      signal: options.signal,
    });
    return new Job(this.#client, answer.job_id, answer);
  }

  /** A handle on a job by id. Makes no request; every method on it does. */
  job(id: string): Job {
    return new Job(this.#client, id);
  }

  /**
   * One page of the caller's own jobs, newest first, and the total it was cut
   * from. Someone else's job is never in it.
   */
  async list(query: ListQuery = {}): Promise<JobList> {
    const url = new URL(`${this.#client.apiUrl}/jobs`);
    for (const key of ["section", "filter", "q", "state", "limit", "offset"] as const) {
      const value = query[key];
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const answered = await callJson(this.#client.fetch, url.toString(), {
      token: this.#client.token,
      signal: query.signal,
    });
    return answered as unknown as JobList;
  }

  /** The query text to submit, and the package a recipe brings with it. */
  async #queryText(
    spec: SubmitSpec,
    variables: Record<string, string>,
  ): Promise<{ text: string; recipePackage: string | null }> {
    if (spec.query !== undefined && spec.recipe !== undefined) {
      throw refuse(
        "a job runs a query or a recipe, not both",
        "drop one of `query` and `recipe`",
      );
    }
    if (spec.recipe !== undefined) {
      const colon = spec.recipe.lastIndexOf(":");
      if (colon === -1) {
        throw refuse(
          `'${spec.recipe}' does not name a recipe`,
          "a recipe is written <namespace>/<package>:<recipe>, e.g. " +
            "ffrwd/faceage:blur-children",
        );
      }
      const packageSpec = spec.recipe.slice(0, colon);
      const recipeName = spec.recipe.slice(colon + 1);
      const recipe = await this.#registry.recipe(packageSpec, recipeName);
      const declared = declaredVariables(recipe.text);
      for (const wanted of recipe.required) {
        if (!Object.prototype.hasOwnProperty.call(variables, wanted.name)) {
          const said =
            declared.find((one) => one.name === wanted.name)?.description ||
            wanted.description ||
            `${recipe.name} requires it`;
          throw unsetVariable(wanted.name, said);
        }
      }
      return { text: substitute(recipe.text, variables).text, recipePackage: packageSpec };
    }
    if (spec.query === undefined) {
      throw refuse(
        "a job runs a query or a recipe, and this spec names neither",
        "set `query` to the SQL to run, or `recipe` to a published one",
      );
    }
    return { text: substitute(spec.query, variables).text, recipePackage: null };
  }

  /** The lock text to submit: the caller's, a resolve, or nothing. */
  async #lock(spec: SubmitSpec, recipePackage: string | null): Promise<string | null> {
    if (typeof spec.lock === "string") return spec.lock;
    if (spec.lock !== undefined) return spec.lock.text;
    const specs = [...(recipePackage !== null ? [recipePackage] : []), ...(spec.packages ?? [])];
    const wanted = [...new Set(specs)];
    if (wanted.length === 0) return null;
    return (await this.#registry.resolve(wanted)).text;
  }
}

/**
 * One job: what it is doing, and what it wrote.
 *
 * A handle, not a snapshot -- nothing is cached, and each method asks the API.
 */
export class Job {
  /** The job's id. */
  readonly id: string;
  /** The submit answer this job came from, when it came from a submit here. */
  readonly submitted?: SubmitAnswer;
  readonly #client: Client;

  /** @internal Built by `Ffrwd.submit` and `Ffrwd.job`. */
  constructor(client: Client, id: string, submitted?: SubmitAnswer) {
    this.#client = client;
    this.id = id;
    if (submitted !== undefined) this.submitted = submitted;
  }

  /**
   * The job in full: state, progress, the log tail, and -- once it succeeded --
   * what it wrote. Someone else's job is a 404, indistinguishable from no job.
   */
  async detail(signal?: AbortSignal): Promise<JobDetail> {
    const answered = await callJson(this.#client.fetch, this.#url(), {
      token: this.#client.token,
      signal,
    });
    return answered as unknown as JobDetail;
  }

  /**
   * Poll until the job reaches a terminal state, and answer with the row.
   *
   * `onUpdate` hears every poll, including the last. Polling stops at
   * `succeeded`, which resolves; `failed` and `cancelled` REJECT with an
   * `FfrwdError` carrying the row on `job`, its `error` the job's own when it
   * recorded one, so the log tail and the exit code are in hand without a
   * second request. An aborted `signal` rejects with the signal's reason.
   */
  async wait(options: WaitOptions = {}): Promise<JobDetail> {
    const interval = options.intervalMs ?? DEFAULT_POLL_MS;
    for (;;) {
      const detail = await this.detail(options.signal);
      options.onUpdate?.(detail);
      if (isTerminal(detail.state)) {
        if (detail.state === "succeeded") return detail;
        throw new FfrwdError({
          status: 0,
          error: detail.error ?? `the job ${detail.state}`,
          hint:
            detail.state === "cancelled"
              ? "it was cancelled; submit it again to run it"
              : "read `job.log_tail` for what the run said before it stopped",
          job: detail,
        });
      }
      await sleep(interval, options.signal);
    }
  }

  /**
   * The job's outputs, each with a presigned GET good an hour.
   *
   * A job that has not succeeded is a 409 naming its state, and outputs whose
   * window has passed are a 410 -- both the service's own words.
   */
  async outputs(signal?: AbortSignal): Promise<Output[]> {
    const where = `${this.#url()}/fetch`;
    const answered = await callJson(this.#client.fetch, where, {
      method: "POST",
      json: {},
      token: this.#client.token,
      signal,
    });
    const outputs = (answered as unknown as FetchAnswer).outputs;
    if (!Array.isArray(outputs)) {
      throw malformed(`the answer from ${where} has no 'outputs' this client can read`);
    }
    return outputs;
  }

  /**
   * One output's bytes.
   *
   * The request is BARE: the presigned url is the whole credential, and the
   * store refuses a request that carries both a signed query string and an
   * `Authorization` header -- so nothing is set on it, not even from this
   * client's own token. The bytes are checked against the digest the job
   * recorded before they are handed back.
   *
   * A `tree` output is one tar of the directory the run wrote; this hands back
   * that tar, and unpacking it is the caller's.
   *
   * Refuses when the job wrote no such path, naming what it did write, and when
   * the bytes do not hash to what the job recorded.
   */
  async download(path: string, options: { signal?: AbortSignal } = {}): Promise<Blob> {
    const outputs = await this.outputs(options.signal);
    const output = outputs.find((one) => one.path === path);
    if (output === undefined) {
      const wrote = outputs.map((one) => one.path).join(", ");
      throw refuse(
        `the job wrote no output at '${path}'`,
        wrote ? `it wrote: ${wrote}` : "it wrote nothing",
      );
    }
    if (typeof output.url !== "string") {
      throw malformed(`the fetch answer carries no url for '${path}'`);
    }
    const response = await this.#client.fetch(output.url, {
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    });
    if (!response.ok) {
      throw new FfrwdError({
        status: response.status,
        error: `the store refused the download of '${path}' with HTTP ${response.status}`,
        hint: "a fetch url is good for an hour; ask for the outputs again",
      });
    }
    const blob = await response.blob();
    const digest = await sha256Hex(blob);
    if (digest !== output.sha256.toLowerCase()) {
      throw refuse(
        `'${path}' downloaded as ${digest}, not the ${output.sha256} the job recorded`,
        "try the download again",
      );
    }
    return blob;
  }

  /**
   * Cancel the job.
   *
   * One that has not started finishes cancelled here and now; a running one is
   * stamped and the runner's next heartbeat ends it. Asking again changes
   * nothing. A job that already finished is a 409 naming its state.
   */
  async cancel(signal?: AbortSignal): Promise<JobDetail> {
    const answered = await callJson(this.#client.fetch, `${this.#url()}/cancel`, {
      method: "POST",
      json: {},
      token: this.#client.token,
      signal,
    });
    return answered as unknown as JobDetail;
  }

  /**
   * Pin the outputs, so they outlive the 7-day window, or unpin them.
   *
   * The answer waits for the move, so the row comes back with `pinned_at` set.
   * Needs a subscription (402); a job that has not succeeded is a 409, outputs
   * already gone are a 410.
   */
  async pin(pinned = true, signal?: AbortSignal): Promise<JobDetail> {
    const answered = await callJson(this.#client.fetch, this.#url(), {
      method: "PATCH",
      json: { pinned },
      token: this.#client.token,
      signal,
    });
    return answered as unknown as JobDetail;
  }

  #url(): string {
    return `${this.#client.apiUrl}/jobs/${this.id}`;
  }
}

/** The inputs a submit declares, and the bytes it has to send. */
interface PlannedUpload {
  path: string;
  sha256: string;
  body: Bytes;
}

async function readInputs(
  given: Record<string, Bytes | { url: string }>,
): Promise<{ inputs: SubmitInput[]; uploads: PlannedUpload[] }> {
  const inputs: SubmitInput[] = [];
  const uploads: PlannedUpload[] = [];
  const staged = new Set<string>();
  for (const [path, value] of Object.entries(given)) {
    if (isBytes(value)) {
      const sha256 = await sha256Hex(value);
      inputs.push({ path, kind: "file", sha256, bytes: byteLength(value) });
      // One upload per distinct digest: two names over the same bytes are one
      // object in the store, and the answer carries one url for them.
      if (!staged.has(sha256)) {
        staged.add(sha256);
        uploads.push({ path, sha256, body: value });
      }
      continue;
    }
    if (value !== null && typeof value === "object" && typeof value.url === "string") {
      if (value.url !== path) {
        throw refuse(
          `input '${path}' is given as the url '${value.url}', and the job ` +
            "carries only one string for an input",
          "a url input is opened by the runner at the path the query names, so " +
            "write the url in the query and key the input by that same url",
        );
      }
      inputs.push({ path, kind: "url" });
      continue;
    }
    throw refuse(
      `input '${path}' is neither bytes nor a url`,
      "an input is a Blob, a Uint8Array, or {url: 'https://…'} for something " +
        "the runner opens itself",
    );
  }
  return { inputs, uploads };
}

/** The submit answer, checked down to the parts the next steps need. */
function readSubmitAnswer(data: Record<string, unknown>, where: string): SubmitAnswer {
  const job_id = requiredString(data, "job_id", where);
  const ready_url = requiredString(data, "ready_url", where);
  const uploads = data["uploads"];
  if (uploads === null || typeof uploads !== "object" || Array.isArray(uploads)) {
    throw malformed(`the answer from ${where} has no 'uploads' object`);
  }
  return {
    ...(data as unknown as SubmitAnswer),
    job_id,
    ready_url,
    uploads: uploads as Record<string, Upload>,
  };
}

/** Wait `ms`, or reject the moment `signal` aborts. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(signal.reason ?? new DOMException("aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException("aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
