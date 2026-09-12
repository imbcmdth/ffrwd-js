/**
 * The one seam this library talks to the network through.
 *
 * Everything goes out over a `fetch` the caller can replace -- which is how the
 * tests run without a network, and how a caller adds retries, proxies or
 * tracing. Nothing here catches a network failure: a `fetch` that rejects
 * rejects on through, as thrown, because a `TypeError` from the platform says
 * something this library cannot improve on. Only an ANSWER is turned into an
 * `FfrwdError`.
 */

import { FfrwdError, malformed } from "./errors.js";

/** Where the job API lives. */
export const DEFAULT_API_URL = "https://api.ffrwd.video/functions/v1";

/**
 * How the caller is authorized: an `ffrwd_…` token with the `run` scope, or a
 * signed-in session's JWT. Both travel as `Authorization: Bearer …`; the API
 * tells them apart itself.
 *
 * Both the job client and the registry take one -- the registry because a
 * package that is not public is readable only by a member of its namespace.
 */
export type Auth = { token: string } | { session: string };

/** The bearer `auth` travels as, whichever of the two it is. */
export function bearer(auth: Auth): string {
  return "token" in auth ? auth.token : auth.session;
}

/** The shape of `fetch` this library uses. Any compatible function will do. */
export type FetchLike = typeof fetch;

/** The platform's `fetch`, or a refusal naming what is missing. */
export function platformFetch(): FetchLike {
  if (typeof globalThis.fetch !== "function") {
    throw new FfrwdError({
      status: 0,
      error: "this runtime has no global fetch",
      hint:
        "ffrwd-js needs fetch, crypto.subtle and ReadableStream: use Node 18 " +
        "or newer, or pass your own `fetch` to the constructor",
    });
  }
  return globalThis.fetch.bind(globalThis);
}

/** One request, as this library makes it. */
export interface Call {
  method?: "GET" | "POST" | "PATCH" | "PUT";
  /** Sent as JSON; a POST with no body of its own sends `{}`, as the API expects. */
  json?: unknown;
  /** `Authorization: Bearer <token>`, when the route takes one. */
  token?: string | undefined;
  signal?: AbortSignal | undefined;
}

/**
 * Make one request and read its answer as JSON.
 *
 * A non-2xx answer becomes an `FfrwdError` carrying the status and, when the
 * body is the API's `{error, hint}`, the service's own words; a body that is
 * not that becomes a generic sentence naming the status. A 2xx whose body is
 * not a JSON object is `malformed`. `signal` is forwarded untouched.
 */
export async function callJson(
  fetchImpl: FetchLike,
  url: string,
  call: Call = {},
): Promise<Record<string, unknown>> {
  const response = await request(fetchImpl, url, call);
  const text = await response.text();
  if (!response.ok) throw serverRefusal(response.status, text);
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

/** Make one request and hand back the `Response` unread. */
export async function request(
  fetchImpl: FetchLike,
  url: string,
  call: Call = {},
): Promise<Response> {
  const method = call.method ?? "GET";
  const headers: Record<string, string> = {};
  if (call.token !== undefined) headers["Authorization"] = `Bearer ${call.token}`;
  const init: RequestInit = { method, headers };
  if (method === "POST" || method === "PATCH") {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(call.json ?? {});
  }
  if (call.signal !== undefined) init.signal = call.signal;
  return fetchImpl(url, init);
}

const GENERIC_HINT = "the service said no more than that; try again, or report it";

/** The API's own refusal, read out of the body when it carries one. */
export function serverRefusal(status: number, body: string): FfrwdError {
  let error = "";
  let hint = "";
  try {
    const data: unknown = JSON.parse(body);
    if (data !== null && typeof data === "object") {
      const said = (data as Record<string, unknown>)["error"];
      const hinted = (data as Record<string, unknown>)["hint"];
      if (typeof said === "string") error = said;
      if (typeof hinted === "string") hint = hinted;
    }
  } catch {
    // Not JSON: the status is the whole story.
  }
  if (!error) error = `the ffrwd API refused the request with HTTP ${status}`;
  if (!hint) hint = GENERIC_HINT;
  return new FfrwdError({ status, error, hint });
}

/** A string field an answer must carry, or a refusal naming the field. */
export function requiredString(
  data: Record<string, unknown>,
  key: string,
  where: string,
): string {
  const value = data[key];
  if (typeof value !== "string" || value === "") {
    throw malformed(`the answer from ${where} has no '${key}' this client can read`);
  }
  return value;
}
