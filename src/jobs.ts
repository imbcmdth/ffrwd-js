/**
 * Jobs: submitting one, following it, and taking what it wrote.
 *
 * The flow the API asks for, in order: POST the spec, PUT every file input to
 * the presigned url the answer signed for that input's POSITION in the spec,
 * then POST the answer's `ready_url` to join the queue. This module does
 * exactly that and nothing between -- no retries of its own, no polling the
 * caller did not ask for.
 *
 * The three steps are also three public methods. `prepare` and `ready` need the
 * token and nothing else; `upload`, in `./upload.js`, needs the signed url and
 * nothing else. That is the seam a web app is built over: a server prepares and
 * readies, a browser uploads, and no token ever reaches the page.
 */

import { byteLength, isBytes, sha256Hex, type Bytes } from "./bytes.js";
import { FfrwdError, malformed, refuse } from "./errors.js";
import {
  bearer,
  callJson,
  DEFAULT_API_URL,
  type Auth,
  type FetchLike,
  platformFetch,
  requiredString,
} from "./http.js";
import { copyDestinations } from "./query.js";
import { Registry } from "./registry.js";
import type {
  FetchAnswer,
  JobDetail,
  JobList,
  ListQuery,
  Lock,
  Output,
  Remaining,
  SubmitAnswer,
  SubmitBody,
  SubmitInput,
  UploadEntry,
  UploadProgress,
} from "./types.js";
import { isTerminal } from "./types.js";
import { upload } from "./upload.js";
import { declaredVariables, substitute, unsetVariable } from "./vars.js";

/** The submit format this client writes. */
export const JOB_FORMAT_VERSION = 2;

/** What this client calls itself to the API when the caller names nothing. */
export const CLIENT_VERSION = "ffrwd-js/0.1.0";

/** How often `wait` asks, when the caller does not say. */
export const DEFAULT_POLL_MS = 3000;

/**
 * How long outputs live, for an answer that did not say.
 *
 * The API sends `outputs_expire_days` with every submit; this is the window the
 * service documents, carried so a `Prepared` always names one.
 */
export const DEFAULT_OUTPUTS_EXPIRE_DAYS = 7;

// `Auth` and `DEFAULT_API_URL` live in ./http.js, where the registry can reach
// them too, and are re-exported here because this is where a caller meets them.
export { DEFAULT_API_URL, type Auth } from "./http.js";

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

/**
 * What a `prepare` declares, when the bytes are somewhere else.
 *
 * A `SubmitSpec` in every part but its inputs, where a file may also be given
 * as `{bytes: <size>}`: a prepare declares each file's size and nothing more,
 * so a server can sign the uploads for a file only the browser holds.
 */
export interface PrepareSpec extends Omit<SubmitSpec, "inputs"> {
  /**
   * The job's inputs, keyed by the path the query names. A `Blob` or
   * `Uint8Array` declares the bytes it holds; `{bytes: <size>}` declares a file
   * of that size that something else will upload; a `{url}` is the runner's to
   * open, and its key must BE that url.
   */
  inputs?: Record<string, Bytes | { url: string } | { bytes: number }>;
}

/** What `prepare` takes beyond the spec. */
export interface PrepareOptions {
  signal?: AbortSignal;
}

/** What `ready` takes beyond the prepared job. */
export interface ReadyOptions {
  signal?: AbortSignal;
}

/** What `submit` takes beyond the spec. */
export interface SubmitOptions extends PrepareOptions {
  /** Heard as each input's bytes go out. See `hasUploadProgress`. */
  onProgress?: (progress: UploadProgress) => void;
}

/**
 * Where one file input's bytes go: the signed PUT, and which input it is for.
 *
 * `index` is the input's position in the submitted inputs, which is what the
 * url was signed against; url inputs hold their position, so the indexes can
 * have gaps. `path` is this client's own, from the spec it sent, never the
 * answer's. `expiresAt` is empty only for an answer that named no expiry.
 */
export interface UploadTicket {
  index: number;
  path: string;
  url: string;
  expiresAt: string;
}

/**
 * A prepared job as plain data: what `JSON.stringify` writes for a `Prepared`.
 *
 * Every field is JSON, so a server hands one to a browser as it stands and the
 * browser hands what comes back to `Ffrwd.ready`.
 */
export interface PreparedJob {
  jobId: string;
  /** One per file input, in the order the spec declared them. May be empty. */
  uploads: UploadTicket[];
  /** Where `ready` posts, which is what queues the job. Bearer-authorized. */
  readyUrl: string;
  /** How many days the outputs live once the run succeeds. */
  outputsExpireDays: number;
  /** The window's unspent credit, when the answer reported it. */
  remaining?: Remaining;
}

/**
 * What `prepare` answers: the job, and every url its files go to.
 *
 * Plain data with a `toJSON` that hands back the same shape, so
 * `JSON.parse(JSON.stringify(prepared))` is a `PreparedJob` every later step
 * still takes. It carries no token and nothing private: the signed urls are
 * write-only, for one job, for 24 hours.
 */
export interface Prepared extends PreparedJob {
  toJSON(): PreparedJob;
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
    const token = bearer(options);
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
    // The default registry is given this client's own authorization and API
    // url, so a caller who passed only a token can read the private packages
    // that token's namespaces publish. A registry passed in is used as given.
    this.#registry =
      options.registry ??
      new Registry({
        fetch: fetchImpl,
        auth: "token" in options ? { token: options.token } : { session: options.session },
        apiUrl: this.#client.apiUrl,
      });
    this.#clientVersion = options.clientVersion ?? CLIENT_VERSION;
  }

  /** The registry this client resolves recipes and packages against. */
  get registry(): Registry {
    return this.#registry;
  }

  /**
   * Submit a job: post the spec, upload its bytes, queue it.
   *
   * `prepare`, then `upload` for each file input in the order the spec listed
   * them, then `ready` -- the whole flow, for a caller that holds both the
   * token and the bytes.
   *
   * In order, and nothing else in between:
   *
   * 1. The query text is settled -- a recipe's published SQL, or `query` --
   *    and `variables` are substituted into it. A recipe whose `required`
   *    variables are not all set is refused here, naming the first one.
   * 2. The lock is built: `lock` as given, else a resolve over `packages` and
   *    the recipe's own package, else nothing.
   * 3. Every `file` input is declared with its size. Nothing is hashed: the
   *    answer signs each upload against the input's position.
   * 4. POST `/jobs`.
   * 5. Every file's url is looked up by its index BEFORE the first PUT: an
   *    index the answer left out is an answer this client cannot read, not
   *    bytes half sent.
   * 6. Each input is PUT to its url, `onProgress` hearing the bytes with the
   *    input's path.
   * 7. POST the answer's `ready_url`, which queues the job.
   *
   * Refuses when neither or both of `query` and `recipe` are given, when an
   * input is neither bytes nor a `{url}` whose key is that url, when an input
   * is the `{bytes}` placeholder only `prepare` takes, when a required recipe
   * variable is unset, when the submit answer is missing `job_id`, `ready_url`
   * or an `uploads` list, and with the API's own words for anything the service
   * refuses.
   */
  async submit(spec: SubmitSpec, options: SubmitOptions = {}): Promise<Job> {
    // Before the spec goes out: submit sends the bytes itself, so a size
    // standing in for them is a spec for `prepare`, not for this.
    const bodies = bytesByPath(spec.inputs ?? {});
    const prepared = await this.prepare(spec, options);
    for (const ticket of prepared.uploads) {
      const body = bodies.get(ticket.path);
      if (body === undefined) {
        throw malformed(
          `the submit answer named an upload for '${ticket.path}', ` +
            "which this submit did not declare",
        );
      }
      await upload(ticket, body, {
        fetch: this.#client.fetch,
        signal: options.signal,
        ...(options.onProgress !== undefined
          ? {
              onProgress: (one: { sent: number; total: number }) =>
                options.onProgress?.({ path: ticket.path, sent: one.sent, total: one.total }),
            }
          : {}),
      });
    }
    return this.ready(prepared, options);
  }

  /**
   * The first half of a submit: settle the query, resolve the lock, POST
   * `/jobs`, and answer with the job and the url every file input goes to.
   *
   * Steps 1 to 5 of `submit`, and not one byte of any input: a file is declared
   * by its size alone, so `{bytes: <size>}` is as good as the bytes here. That
   * is what lets this run on a server for a file only the browser holds -- the
   * page is handed `prepared.uploads` and calls `upload` for each, with no
   * token and no API url of its own.
   *
   * The job exists after this and sits in the `submitted` state, waiting for its
   * uploads; it queues when `ready` is posted, and nothing runs until then.
   *
   * Refuses everything `submit` refuses about a spec, plus a file input given
   * as `{bytes}` with anything that is not a byte count, and an answer that
   * leaves out the index of a file input this spec declared -- before any byte
   * is sent, since the bytes are not here at all.
   */
  async prepare(spec: PrepareSpec, options: PrepareOptions = {}): Promise<Prepared> {
    const variables = spec.variables ?? {};
    const { text, recipePackage } = await this.#queryText(spec, variables);
    const lock = await this.#lock(spec, recipePackage);
    const { inputs, files } = readInputs(spec.inputs ?? {});

    const body: SubmitBody = {
      format_version: JOB_FORMAT_VERSION,
      query: text,
      // The stored query has the variables substituted in; they travel raw as
      // well, so the job's record holds what was asked, not only what it became.
      variables,
      recipe: spec.recipe ?? null,
      lock,
      // Nothing is packed here: a browser has no linked package to send. The
      // answer's `packages` map is therefore always empty, and never read.
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
    return asPrepared({
      jobId: answer.job_id,
      // Every destination, looked up before anything is uploaded.
      uploads: tickets(files, answer.uploads),
      readyUrl: answer.ready_url,
      outputsExpireDays:
        typeof answer.outputs_expire_days === "number"
          ? answer.outputs_expire_days
          : DEFAULT_OUTPUTS_EXPIRE_DAYS,
      ...(answer.remaining !== undefined ? { remaining: answer.remaining } : {}),
    });
  }

  /**
   * The last half of a submit: POST the prepared job's `ready_url`, which
   * queues it.
   *
   * Takes what `prepare` answered, or anything carrying its `jobId` and
   * `readyUrl` -- a `Prepared` that went through `JSON.stringify` and came back
   * from a browser is exactly that. This is the authorized half again: the
   * bearer goes out here, so it runs where the token is.
   *
   * Post it once every file input's bytes are in the store. A job whose uploads
   * are not all there is the runner's to fail, not this client's to check.
   */
  async ready(
    prepared: PreparedJob | { jobId: string; readyUrl: string },
    options: ReadyOptions = {},
  ): Promise<Job> {
    const { jobId, readyUrl } = prepared;
    if (typeof jobId !== "string" || jobId === "" || typeof readyUrl !== "string" || readyUrl === "") {
      throw refuse(
        "a job is readied by its `jobId` and its `readyUrl`, and this carries neither",
        "pass what `prepare` answered, or the object it became through JSON",
      );
    }
    await callJson(this.#client.fetch, readyUrl, {
      method: "POST",
      json: {},
      token: this.#client.token,
      signal: options.signal,
    });
    const held = "uploads" in prepared && Array.isArray(prepared.uploads) ? prepared : undefined;
    return new Job(this.#client, jobId, held === undefined ? undefined : asPrepared(held));
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
    spec: PrepareSpec,
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
  async #lock(spec: PrepareSpec, recipePackage: string | null): Promise<string | null> {
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
  /** What `prepare` answered, when this job was prepared or submitted here. */
  readonly submitted?: Prepared;
  readonly #client: Client;

  /** @internal Built by `Ffrwd.submit`, `Ffrwd.ready` and `Ffrwd.job`. */
  constructor(client: Client, id: string, submitted?: Prepared) {
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

/** One file input as the spec declared it: where it sits, and how big it is. */
interface DeclaredFile {
  /** The entry's position in the submitted `inputs`. */
  index: number;
  path: string;
  bytes: number;
}

/**
 * The inputs a spec declares, and which of them are files to upload.
 *
 * One entry per key, in the order the object wrote them, which is the order the
 * answer signs its urls against -- two names over the same bytes are two
 * inputs, two positions and two uploads, because the runner opens each at the
 * path the query names. Nothing is read and nothing is hashed: a file is its
 * size and its position, and `{bytes: <size>}` says both without the bytes.
 */
function readInputs(
  given: Record<string, Bytes | { url: string } | { bytes: number }>,
): { inputs: SubmitInput[]; files: DeclaredFile[] } {
  const inputs: SubmitInput[] = [];
  const files: DeclaredFile[] = [];
  for (const [path, value] of Object.entries(given)) {
    if (isBytes(value)) {
      const bytes = byteLength(value);
      files.push({ index: inputs.length, path, bytes });
      inputs.push({ path, kind: "file", bytes });
      continue;
    }
    if (value !== null && typeof value === "object") {
      if (typeof (value as { url?: unknown }).url === "string") {
        const url = (value as { url: string }).url;
        if (url !== path) {
          throw refuse(
            `input '${path}' is given as the url '${url}', and the job ` +
              "carries only one string for an input",
            "a url input is opened by the runner at the path the query names, so " +
              "write the url in the query and key the input by that same url",
          );
        }
        inputs.push({ path, kind: "url" });
        continue;
      }
      if ("bytes" in value) {
        const size: unknown = (value as { bytes: unknown }).bytes;
        if (typeof size !== "number" || !Number.isFinite(size) || size < 0) {
          throw refuse(
            `input '${path}' is given as {bytes: ${String(size)}}, which is not a size`,
            "a file declared without its bytes carries the byte count instead, " +
              "e.g. {bytes: file.size}",
          );
        }
        files.push({ index: inputs.length, path, bytes: size });
        inputs.push({ path, kind: "file", bytes: size });
        continue;
      }
    }
    throw refuse(
      `input '${path}' is neither bytes nor a url`,
      "an input is a Blob, a Uint8Array, {url: 'https://…'} for something the " +
        "runner opens itself, or -- for `prepare` alone -- {bytes: <size>} for " +
        "a file something else uploads",
    );
  }
  return { inputs, files };
}

/**
 * The bytes each file input holds, by path, for the step that sends them.
 *
 * Refuses a `{bytes}` placeholder: it declares a file whose bytes are somewhere
 * else, which `prepare` takes and `submit`, which does the uploading, cannot.
 * Everything else is left to `readInputs` to accept or refuse, so a spec is
 * judged in one place.
 */
function bytesByPath(
  given: Record<string, Bytes | { url: string } | { bytes: number }>,
): Map<string, Bytes> {
  const bodies = new Map<string, Bytes>();
  for (const [path, value] of Object.entries(given)) {
    if (isBytes(value)) {
      bodies.set(path, value);
      continue;
    }
    if (
      value !== null &&
      typeof value === "object" &&
      "bytes" in value &&
      typeof (value as { url?: unknown }).url !== "string"
    ) {
      throw refuse(
        `input '${path}' is given as a size, and a submit uploads the bytes itself`,
        "pass the Blob or the Uint8Array here, or use prepare + upload + ready " +
          "when the bytes are somewhere else",
      );
    }
  }
  return bodies;
}

/**
 * Where each declared file's bytes go, matched by index.
 *
 * The answer's entries are read into a map by `index` and every declared file
 * looked up in it, so an index the answer left out stops the flow before the
 * first PUT. The path carried on is the spec's own, not the answer's: the
 * answer echoes it for messages, and this client matches on position alone.
 */
function tickets(files: DeclaredFile[], offered: UploadEntry[]): UploadTicket[] {
  const signed = new Map<number, UploadEntry>();
  for (const entry of offered) {
    if (
      entry !== null &&
      typeof entry === "object" &&
      typeof entry.index === "number" &&
      typeof entry.url === "string"
    ) {
      signed.set(entry.index, entry);
    }
  }
  return files.map((file) => {
    const found = signed.get(file.index);
    if (found === undefined) {
      throw malformed(
        `the submit answer carries no upload url for '${file.path}' ` +
          `(the input at index ${file.index})`,
      );
    }
    return {
      index: file.index,
      path: file.path,
      url: found.url,
      expiresAt: typeof found.expires_at === "string" ? found.expires_at : "",
    };
  });
}

/** A `Prepared` over plain data: the same fields, and a `toJSON` that is them. */
function asPrepared(data: PreparedJob): Prepared {
  const held: PreparedJob = {
    jobId: data.jobId,
    uploads: data.uploads.map((one) => ({ ...one })),
    readyUrl: data.readyUrl,
    outputsExpireDays: data.outputsExpireDays,
    ...(data.remaining !== undefined ? { remaining: data.remaining } : {}),
  };
  return { ...held, toJSON: (): PreparedJob => ({ ...held }) };
}

/** The submit answer, checked down to the parts the next steps need. */
function readSubmitAnswer(data: Record<string, unknown>, where: string): SubmitAnswer {
  const job_id = requiredString(data, "job_id", where);
  const ready_url = requiredString(data, "ready_url", where);
  const uploads = data["uploads"];
  if (!Array.isArray(uploads)) {
    throw malformed(`the answer from ${where} has no 'uploads' list`);
  }
  return {
    ...(data as unknown as SubmitAnswer),
    job_id,
    ready_url,
    uploads: uploads as UploadEntry[],
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
