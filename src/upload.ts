/**
 * Sending one input's bytes to the store.
 *
 * A presigned PUT is the whole credential: the url travels verbatim, query
 * string and all, and the request carries `Content-Length` and nothing else. An
 * `Authorization` header on it makes the store refuse the request outright --
 * a signed query string and a bearer may not both be present -- so this module
 * never sets one, and neither should a caller's replacement `fetch`.
 */

import { byteLength, type Bytes } from "./bytes.js";
import { FfrwdError } from "./errors.js";
import type { FetchLike } from "./http.js";
import type { Upload, UploadProgress } from "./types.js";

/** What a PUT needs beyond the bytes themselves. */
export interface PutOptions {
  /** The input's path, as the query names it; it names the input in refusals. */
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
 * PUT `body` to `upload.url`. Any 2xx is the upload.
 *
 * Reports through `onProgress` as `{path, sent, total}`: per chunk where
 * `XMLHttpRequest` exists and a listener was given, otherwise once, with
 * `sent === total`, after the bytes are in. Retrying is safe -- the same bytes
 * to the same url store the same object -- but retrying is the caller's to do:
 * nothing here swallows a failure.
 *
 * Refuses with an `FfrwdError` carrying the store's status: a 403 on a url
 * whose `expires_at` has passed says the url expired and to submit again, and
 * anything else says the store refused the upload of this path.
 */
export async function put(
  fetchImpl: FetchLike,
  upload: Upload,
  body: Bytes,
  options: PutOptions,
): Promise<void> {
  const total = byteLength(body);
  if (hasUploadProgress() && options.onProgress !== undefined) {
    await putWithXhr(upload, body, total, options);
    return;
  }
  const response = await fetchImpl(upload.url, {
    method: "PUT",
    // The only header a presigned PUT takes. A browser will not let this one be
    // set and computes it from the body instead, which is the same value.
    headers: { "Content-Length": String(total) },
    body: body as BodyInit,
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  });
  if (!response.ok) throw storeRefusal(upload, options.path, response.status);
  options.onProgress?.({ path: options.path, sent: total, total });
}

/** The same PUT through `XMLHttpRequest`, which does report progress. */
function putWithXhr(
  upload: Upload,
  body: Bytes,
  total: number,
  options: PutOptions,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", upload.url, true);
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
      reject(storeRefusal(upload, options.path, xhr.status));
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
function storeRefusal(upload: Upload, path: string, status: number): FfrwdError {
  const expires = Date.parse(upload.expires_at ?? "");
  if (status === 403 && Number.isFinite(expires) && Date.now() >= expires) {
    return new FfrwdError({
      status,
      error: `the upload url for '${path}' expired at ${upload.expires_at}`,
      hint: "submit the job again: an upload url is good for 24 hours",
    });
  }
  return new FfrwdError({
    status,
    error: `the store refused the upload of '${path}' with HTTP ${status}`,
    hint: "try the submit again; if it keeps happening, report it",
  });
}
