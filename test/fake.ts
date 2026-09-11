/**
 * A fake `fetch` (and a fake `XMLHttpRequest`) that answers from a script and
 * records what it was asked. No test in this suite touches the network.
 */

import type { FetchLike } from "../src/index.js";

/** One request as the fake saw it. */
export interface Recorded {
  method: string;
  url: string;
  /** Header names lowercased, so a test can assert the whole set. */
  headers: Record<string, string>;
  body: string | Uint8Array | null;
}

/** What the fake answers with. */
export interface Reply {
  status?: number;
  json?: unknown;
  body?: string | Uint8Array;
}

interface Route {
  method: string;
  url: string | RegExp;
  replies: Reply[];
}

/** A scripted server: routes in, requests recorded, answers out. */
export class FakeServer {
  readonly requests: Recorded[] = [];
  readonly #routes: Route[] = [];

  /**
   * Answer `method url` with `reply`. An array of replies is consumed in order
   * and the last one repeats, which is what a polling test wants.
   */
  on(method: string, url: string | RegExp, reply: Reply | Reply[]): this {
    this.#routes.push({
      method,
      url,
      replies: Array.isArray(reply) ? [...reply] : [reply],
    });
    return this;
  }

  /** The `fetch` to hand the client under test. */
  get fetch(): FetchLike {
    return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input.toString();
      const method = (init?.method ?? "GET").toUpperCase();
      const headers: Record<string, string> = {};
      new Headers(init?.headers ?? {}).forEach((value, key) => {
        headers[key.toLowerCase()] = value;
      });
      this.requests.push({ method, url, headers, body: readBody(init?.body) });
      const route = this.#routes.find(
        (one) =>
          one.method === method &&
          (typeof one.url === "string" ? one.url === url : one.url.test(url)),
      );
      if (route === undefined) {
        return new Response(JSON.stringify({ error: "no route", hint: url }), {
          status: 599,
        });
      }
      const reply = route.replies.length > 1 ? (route.replies.shift() as Reply) : (route.replies[0] as Reply);
      return answer(reply);
    }) as FetchLike;
  }

  /** Just the requests that went to `url`. */
  to(url: string): Recorded[] {
    return this.requests.filter((one) => one.url === url);
  }
}

function answer(reply: Reply): Response {
  const status = reply.status ?? 200;
  if (reply.json !== undefined) {
    return new Response(JSON.stringify(reply.json), {
      status,
      headers: { "content-type": "application/json" },
    });
  }
  if (reply.body !== undefined) {
    const body = typeof reply.body === "string" ? reply.body : (reply.body.slice().buffer as ArrayBuffer);
    return new Response(body, { status });
  }
  return new Response(null, { status });
}

function readBody(body: BodyInit | null | undefined): string | Uint8Array | null {
  if (body === null || body === undefined) return null;
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  return String(body);
}

/** What a fake XHR recorded: the same shape, plus what progress it reported. */
export interface RecordedXhr {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

/**
 * Install a fake `XMLHttpRequest` on `globalThis` that answers `status` and
 * reports progress in `steps` fractions. Returns what it recorded and a way to
 * put the global back.
 */
export function fakeXhr(status = 200, steps = 2): {
  sent: RecordedXhr[];
  restore: () => void;
} {
  const sent: RecordedXhr[] = [];
  const held = (globalThis as Record<string, unknown>)["XMLHttpRequest"];

  class FakeXhr {
    status = 0;
    #method = "";
    #url = "";
    readonly #headers: Record<string, string> = {};
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onabort: (() => void) | null = null;
    readonly upload = { onprogress: null as ((event: ProgressEvent) => void) | null };

    open(method: string, url: string): void {
      this.#method = method;
      this.#url = url;
    }

    setRequestHeader(name: string, value: string): void {
      this.#headers[name.toLowerCase()] = value;
    }

    abort(): void {
      this.onabort?.();
    }

    send(body: unknown): void {
      sent.push({ method: this.#method, url: this.#url, headers: this.#headers, body });
      const total =
        body instanceof Uint8Array ? body.byteLength : ((body as Blob)?.size ?? 0);
      for (let step = 1; step <= steps; step += 1) {
        this.upload.onprogress?.({
          loaded: Math.round((total * step) / steps),
          total,
          lengthComputable: true,
        } as ProgressEvent);
      }
      this.status = status;
      this.onload?.();
    }
  }

  (globalThis as Record<string, unknown>)["XMLHttpRequest"] = FakeXhr;
  return {
    sent,
    restore: () => {
      if (held === undefined) delete (globalThis as Record<string, unknown>)["XMLHttpRequest"];
      else (globalThis as Record<string, unknown>)["XMLHttpRequest"] = held;
    },
  };
}

/** A job row with every column the client reads, overridden as a test needs. */
export function jobRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "0c2f4a1e-7b3d-4e2a-9f1a-3b5c7d9e1f2a",
    title: null,
    state: "queued",
    recipe: null,
    gpu: false,
    progress_pct: null,
    exit_code: null,
    error: null,
    client_version: "ffrwd-js/0.1.0",
    image_ffrwd_version: null,
    duration_cpu_s: null,
    duration_gpu_s: null,
    bytes_in: null,
    bytes_out: null,
    budget_exhausted: false,
    created_at: "2026-09-11T00:00:00.000Z",
    started_at: null,
    finished_at: null,
    cancelled_at: null,
    heartbeat_at: null,
    outputs_expire_at: null,
    pin_requested_at: null,
    pinned_at: null,
    pinned_location: null,
    pinned_bytes: null,
    pin_error: null,
    ...over,
  };
}
