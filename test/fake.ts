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

/** The job id every fake answer here is about. */
export const JOB_ID = "0c2f4a1e-7b3d-4e2a-9f1a-3b5c7d9e1f2a";

/** When the fake's signed urls stop working. Far enough out to be fresh. */
export const FRESH_UNTIL = "2026-09-12T15:00:00.000Z";

/** The store url a submit signs for the file input at `index`. */
export function putUrl(index: number): string {
  return `https://store.example/inputs/${JOB_ID}/${index}?X-Amz-Signature=deadbeef`;
}

/**
 * One `uploads` entry per index, as the submit answer writes them.
 *
 * `index` is the input's position in the submitted `inputs`, which is the only
 * part of an entry this client matches on: the `path` written here is the
 * answer's own echo, and `region` is a key the client does not read at all.
 */
export function signed(...indexes: number[]): Array<Record<string, unknown>> {
  return indexes.map((index) => ({
    index,
    path: `the answer's name for input ${index}`,
    url: putUrl(index),
    expires_at: FRESH_UNTIL,
    region: "auto",
  }));
}

/**
 * A submit answer: `uploads` a list, `packages` a map, both always present.
 *
 * `uploads` is one entry per file input, in the order the submit listed them;
 * `packages` is keyed by the digests the spec sent, which this client never
 * sends, so it is empty unless a test says otherwise.
 */
export function submitAnswer(
  uploads: Array<Record<string, unknown>> = [],
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    job_id: JOB_ID,
    uploads,
    packages: {},
    ready_url: `https://api.example/functions/v1/jobs/${JOB_ID}/ready`,
    outputs_expire_days: 7,
    pin_output: false,
    title: null,
    remaining: { cpu_seconds: 6405, gpu_seconds: 2562 },
    ...over,
  };
}

/** A job row with every column the client reads, overridden as a test needs. */
export function jobRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: JOB_ID,
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
