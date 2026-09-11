/**
 * Sending one input's bytes to the store.
 *
 * A presigned PUT is the whole credential: the url travels verbatim, query
 * string and all, and the request carries `Content-Length` and nothing else. An
 * `Authorization` header on it makes the store refuse the request outright --
 * a signed query string and a bearer may not both be present -- so this module
 * never sets one, and neither should a caller's replacement `fetch`.
 *
 * Nothing here reads the bytes twice: they are not hashed, only sent, which is
 * what lets a browser upload a file it never held in memory.
 */

import { byteLength, type Bytes } from "./bytes.js";
import { FfrwdError } from "./errors.js";
import { platformFetch, type FetchLike } from "./http.js";
import type { Progress, UploadProgress } from "./types.js";

/**
 * Where one upload's bytes go.
 *
 * A `Prepared`'s upload entry is exactly this, so a browser hands one straight
 * to `upload`. Only `url` is needed: `expiresAt` sharpens the refusal when the
 * store says no to a url whose time is up, and `path` names the input in it.
 */
export interface Destination {
  /** The presigned PUT, query string and all. */
  url: string;
  /** When the url stops working, as the answer wrote it. */
  expiresAt?: string | undefined;
  /** The input's path, for messages. Defaults to the url. */
  path?: string | undefined;
}

/** What `upload` takes beyond the bytes themselves. */
export interface UploadOptions {
  signal?: AbortSignal | undefined;
  /** Heard as the bytes go out. See `hasUploadProgress`. */
  onProgress?: ((progress: Progress) => void) | undefined;
  /** The `fetch` to send through. Defaults to the platform's. */
  fetch?: FetchLike | undefined;
}

/** What the internal PUT needs: a path for its messages, whatever the caller gave. */
interface PutOptions {
  path: string;
  onProgress?: ((progress: UploadProgress) => void) | undefined;
  signal?: AbortSignal | undefined;
}

/**
 * True when this runtime can report upload progress as it happens.
 *
 * `fetch` cannot: a request body is written without a callback anywhere, and
 * request streaming is neither universal nor allowed over HTTP/1.1 without
 * `duplex: "half"` support on both ends. `XMLHttpRequest` can, through
 * `upload.onprogress`, and every browser has it. Node has neither, so a Node
 * caller hears one event at the end of each upload instead.
 */
export function hasUploadProgress(): boolean {
  return typeof XMLHttpRequest !== "undefined";
}

/**
 * PUT one file's bytes to the signed url it was given. Any 2xx is the upload.
 *
 * This is the half of a submit that needs no authorization at all, and the one
 * a browser does: a server calls `Ffrwd.prepare`, hands the `Prepared` over,
 * and the page uploads each file to `prepared.uploads[i]` without ever holding
 * a token. Nothing is hashed and nothing is read back -- the bytes are sent
 * once, straight through.
 *
 * Reports through `onProgress` as `{sent, total}`: per chunk where
 * `XMLHttpRequest` exists and a listener was given, otherwise once, with
 * `sent === total`, after the bytes are in. Retrying is safe -- the same bytes
 * to the same url store the same object -- but retrying is the caller's to do:
 * nothing here swallows a failure.
 *
 * Refuses with an `FfrwdError` carrying the store's status: a 403 on a url
 * whose `expiresAt` has passed says the url expired and to submit again, and
 * anything else says the store refused the upload of this path.
 */
export async function upload(
  target: Destination,
  bytes: Bytes,
  options: UploadOptions = {},
): Promise<void> {
  const heard = options.onProgress;
  await put(options.fetch ?? platformFetch(), target, bytes, {
    path: target.path ?? target.url,
    ...(heard !== undefined
      ? { onProgress: (one: UploadProgress) => heard({ sent: one.sent, total: one.total }) }
      : {}),
    signal: options.signal,
  });
}

/** The PUT itself, with the input's path settled so refusals can name it. */
export async function put(
  fetchImpl: FetchLike,
  target: Destination,
  body: Bytes,
  options: PutOptions,
): Promise<void> {
  const total = byteLength(body);
  if (hasUploadProgress() && options.onProgress !== undefined) {
    await putWithXhr(target, body, total, options);
    return;
  }
  const response = await fetchImpl(target.url, {
    method: "PUT",
    // The only header a presigned PUT takes. A browser will not let this one be
    // set and computes it from the body instead, which is the same value.
    headers: { "Content-Length": String(total) },
    body: body as BodyInit,
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  });
  if (!response.ok) throw storeRefusal(target, options.path, response.status);
  options.onProgress?.({ path: options.path, sent: total, total });
}

/** The same PUT through `XMLHttpRequest`, which does report progress. */
function putWithXhr(
  target: Destination,
  body: Bytes,
  total: number,
  options: PutOptions,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", target.url, true);
    const abort = (): void => xhr.abort();
    if (options.signal !== undefined) {
      if (options.signal.aborted) {
        reject(options.signal.reason ?? new DOMException("aborted", "AbortError"));
        return;
      }
      options.signal.addEventListener("abort", abort, { once: true });
    }
    const done = (): void => options.signal?.removeEventListener("abort", abort);
    xhr.upload.onprogress = (event: ProgressEvent): void => {
      options.onProgress?.({
        path: options.path,
        sent: event.loaded,
        total: event.lengthComputable ? event.total : total,
      });
    };
    xhr.onload = (): void => {
      done();
      if (xhr.status >= 200 && xhr.status < 300) {
        options.onProgress?.({ path: options.path, sent: total, total });
        resolve();
        return;
      }
      reject(storeRefusal(target, options.path, xhr.status));
    };
    xhr.onerror = (): void => {
      done();
      reject(
        new FfrwdError({
          status: 0,
          error: `the upload of '${options.path}' could not be sent`,
          hint: "check the network connection, or try the submit again",
        }),
      );
    };
    xhr.onabort = (): void => {
      done();
      reject(options.signal?.reason ?? new DOMException("aborted", "AbortError"));
    };
    xhr.send(body as XMLHttpRequestBodyInit);
  });
}

/** The store's refusal of a PUT, told apart from a url whose time is up. */
function storeRefusal(target: Destination, path: string, status: number): FfrwdError {
  const expires = Date.parse(target.expiresAt ?? "");
  if (status === 403 && Number.isFinite(expires) && Date.now() >= expires) {
    return new FfrwdError({
      status,
      error: `the upload url for '${path}' expired at ${target.expiresAt}`,
      hint: "submit the job again: an upload url is good for 24 hours",
    });
  }
  return new FfrwdError({
    status,
    error: `the store refused the upload of '${path}' with HTTP ${status}`,
    hint: "try the submit again; if it keeps happening, report it",
  });
}
