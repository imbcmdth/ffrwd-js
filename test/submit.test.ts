/**
 * The submit sequence: what goes out, in what order, carrying what -- and what
 * is refused before a single byte is sent.
 */

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Ffrwd, FfrwdError } from "../src/index.js";
import { FakeServer, fakeXhr, jobRow } from "./fake.js";

const API = "https://api.example/functions/v1";
const JOBS = `${API}/jobs`;
const JOB_ID = "0c2f4a1e-7b3d-4e2a-9f1a-3b5c7d9e1f2a";
const READY = `${JOBS}/${JOB_ID}/ready`;
const PUT_URL = "https://store.example/inputs/abc?X-Amz-Signature=deadbeef";
const TOKEN = "ffrwd_testtoken";

const BYTES = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
const DIGEST = createHash("sha256").update(BYTES).digest("hex");

const QUERY = "COPY (SELECT f.video[1] FROM input(:'source') f) TO :'dest'";

function server(uploads: Record<string, unknown> = {}): FakeServer {
  return new FakeServer()
    .on("POST", JOBS, {
      status: 201,
      json: {
        job_id: JOB_ID,
        uploads,
        ready_url: READY,
        outputs_expire_days: 7,
        pin_output: false,
        title: null,
        remaining: { cpu_seconds: 6405, gpu_seconds: 2562 },
      },
    })
    .on("PUT", PUT_URL, { status: 200 })
    .on("POST", READY, { json: jobRow({ state: "queued" }) });
}

describe("submit", () => {
  it("posts the spec, puts the file, posts ready, and nothing else", async () => {
    const fake = server({ [DIGEST]: { url: PUT_URL, expires_at: "2026-09-12T00:00:00.000Z" } });
    const ffrwd = new Ffrwd({ token: TOKEN, apiUrl: API, fetch: fake.fetch });

    const job = await ffrwd.submit({
      query: QUERY,
      variables: { source: "t.mp4", dest: "out.mp4" },
      inputs: { "t.mp4": BYTES },
      title: "a test",
      timeoutSeconds: 120,
    });

    expect(job.id).toBe(JOB_ID);
    expect(fake.requests.length).toBe(3);

    const [submit, upload, ready] = fake.requests;

    // 1. the spec
    expect(submit?.method).toBe("POST");
    expect(submit?.url).toBe(JOBS);
    expect(submit?.headers["authorization"]).toBe(`Bearer ${TOKEN}`);
    const body = JSON.parse(submit?.body as string) as Record<string, unknown>;
    expect(body["format_version"]).toBe(2);
    // the query travels substituted ...
    expect(body["query"]).toBe(
      "COPY (SELECT f.video[1] FROM input('t.mp4') f) TO 'out.mp4'",
    );
    // ... and the variables travel as written, for the record
    expect(body["variables"]).toEqual({ source: "t.mp4", dest: "out.mp4" });
    expect(body["inputs"]).toEqual([
      { path: "t.mp4", kind: "file", sha256: DIGEST, bytes: BYTES.byteLength },
    ]);
    // the outputs default to what the query says it writes
    expect(body["outputs"]).toEqual(["out.mp4"]);
    expect(body["packages"]).toEqual([]);
    expect(body["lock"]).toBe(null);
    expect(body["recipe"]).toBe(null);
    expect(body["timeout_s"]).toBe(120);
    expect(body["title"]).toBe("a test");
    expect(body["client_version"]).toBe("ffrwd-js/0.1.0");

    // 2. the upload: the url is the whole credential
    expect(upload?.method).toBe("PUT");
    expect(upload?.url).toBe(PUT_URL);
    expect(Object.keys(upload?.headers ?? {})).toEqual(["content-length"]);
    expect(upload?.headers["content-length"]).toBe(String(BYTES.byteLength));
    expect(upload?.headers["authorization"]).toBeUndefined();
    expect(upload?.body).toEqual(BYTES);

    // 3. ready, with the same bearer as the submit
    expect(ready?.method).toBe("POST");
    expect(ready?.url).toBe(READY);
    expect(ready?.headers["authorization"]).toBe(`Bearer ${TOKEN}`);
    expect(ready?.body).toBe("{}");
  });

  it("refuses a digest the answer left out before any PUT", async () => {
    const fake = server({}); // an empty uploads object: no url for our input
    const ffrwd = new Ffrwd({ token: TOKEN, apiUrl: API, fetch: fake.fetch });

    await expect(
      ffrwd.submit({ query: QUERY, inputs: { "t.mp4": BYTES } }),
    ).rejects.toMatchObject({
      status: 0,
      error: `the submit answer carries no upload url for 't.mp4' (sha256 ${DIGEST})`,
    });

    // the spec went out; nothing else did
    expect(fake.requests.map((one) => one.method)).toEqual(["POST"]);
    expect(fake.requests[0]?.url).toBe(JOBS);
  });

  it("refuses an answer with no ready_url, and an uploads that is not an object", async () => {
    const noReady = new FakeServer().on("POST", JOBS, {
      status: 201,
      json: { job_id: JOB_ID, uploads: {} },
    });
    await expect(
      new Ffrwd({ token: TOKEN, apiUrl: API, fetch: noReady.fetch }).submit({ query: QUERY }),
    ).rejects.toMatchObject({ status: 0 });

    const badUploads = new FakeServer().on("POST", JOBS, {
      status: 201,
      json: { job_id: JOB_ID, ready_url: READY, uploads: [] },
    });
    await expect(
      new Ffrwd({ token: TOKEN, apiUrl: API, fetch: badUploads.fetch }).submit({ query: QUERY }),
    ).rejects.toMatchObject({
      status: 0,
      hint: expect.stringContaining("cannot read") as unknown as string,
    });
  });

  it("surfaces a refusal body as an FfrwdError with status, error and hint", async () => {
    const fake = new FakeServer().on("POST", JOBS, {
      status: 402,
      json: {
        error: "the free allotment is spent: 0m cpu and 0m gpu left",
        hint: "it resets on 2026-09-04; until then, run without --remote",
      },
    });
    const ffrwd = new Ffrwd({ token: TOKEN, apiUrl: API, fetch: fake.fetch });

    const err = await ffrwd.submit({ query: QUERY }).catch((one: unknown) => one);
    expect(err).toBeInstanceOf(FfrwdError);
    const refusal = err as FfrwdError;
    expect(refusal.status).toBe(402);
    expect(refusal.error).toBe("the free allotment is spent: 0m cpu and 0m gpu left");
    expect(refusal.hint).toBe("it resets on 2026-09-04; until then, run without --remote");
    expect(refusal.message).toBe(refusal.error);
  });

  it("gives a status and a generic sentence when the refusal carries no words", async () => {
    const fake = new FakeServer().on("POST", JOBS, { status: 500, body: "<html>nope" });
    const ffrwd = new Ffrwd({ token: TOKEN, apiUrl: API, fetch: fake.fetch });
    await expect(ffrwd.submit({ query: QUERY })).rejects.toMatchObject({
      status: 500,
      error: "the ffrwd API refused the request with HTTP 500",
    });
  });

  it("declares a url input without uploading anything", async () => {
    const fake = server({});
    const ffrwd = new Ffrwd({ token: TOKEN, apiUrl: API, fetch: fake.fetch });
    const url = "https://media.example/in.mp4";
    await ffrwd.submit({
      query: `COPY (SELECT * FROM input('${url}')) TO 'out.mp4'`,
      inputs: { [url]: { url } },
    });
    const body = JSON.parse(fake.requests[0]?.body as string) as Record<string, unknown>;
    expect(body["inputs"]).toEqual([{ path: url, kind: "url" }]);
    expect(fake.requests.map((one) => one.method)).toEqual(["POST", "POST"]);
  });

  it("refuses a url input keyed by something other than that url", async () => {
    const fake = server({});
    const ffrwd = new Ffrwd({ token: TOKEN, apiUrl: API, fetch: fake.fetch });
    await expect(
      ffrwd.submit({ query: QUERY, inputs: { "t.mp4": { url: "https://media.example/x" } } }),
    ).rejects.toMatchObject({ status: 0 });
    expect(fake.requests.length).toBe(0);
  });

  it("uploads one object for two names over the same bytes", async () => {
    const fake = server({ [DIGEST]: { url: PUT_URL, expires_at: "2026-09-12T00:00:00.000Z" } });
    const ffrwd = new Ffrwd({ token: TOKEN, apiUrl: API, fetch: fake.fetch });
    await ffrwd.submit({
      query: "COPY (SELECT 1) TO 'out.txt'",
      inputs: { "a.bin": BYTES, "b.bin": BYTES },
    });
    const body = JSON.parse(fake.requests[0]?.body as string) as Record<string, unknown>;
    expect((body["inputs"] as unknown[]).length).toBe(2);
    expect(fake.requests.filter((one) => one.method === "PUT").length).toBe(1);
  });

  it("reports progress once per upload without XMLHttpRequest", async () => {
    const fake = server({ [DIGEST]: { url: PUT_URL, expires_at: "2026-09-12T00:00:00.000Z" } });
    const ffrwd = new Ffrwd({ token: TOKEN, apiUrl: API, fetch: fake.fetch });
    const seen: Array<{ path: string; sent: number; total: number }> = [];
    await ffrwd.submit(
      { query: QUERY, inputs: { "t.mp4": BYTES } },
      { onProgress: (one) => seen.push(one) },
    );
    expect(seen).toEqual([{ path: "t.mp4", sent: 10, total: 10 }]);
  });

  it("reports progress as it happens where XMLHttpRequest exists", async () => {
    const xhr = fakeXhr(200, 2);
    try {
      const fake = server({ [DIGEST]: { url: PUT_URL, expires_at: "2026-09-12T00:00:00.000Z" } });
      const ffrwd = new Ffrwd({ token: TOKEN, apiUrl: API, fetch: fake.fetch });
      const seen: Array<{ path: string; sent: number; total: number }> = [];
      await ffrwd.submit(
        { query: QUERY, inputs: { "t.mp4": BYTES } },
        { onProgress: (one) => seen.push(one) },
      );
      // the bytes went through XHR, so the fake fetch saw only the two API calls
      expect(fake.requests.map((one) => one.method)).toEqual(["POST", "POST"]);
      expect(xhr.sent.length).toBe(1);
      expect(xhr.sent[0]?.url).toBe(PUT_URL);
      expect(xhr.sent[0]?.headers).toEqual({});
      expect(seen).toEqual([
        { path: "t.mp4", sent: 5, total: 10 },
        { path: "t.mp4", sent: 10, total: 10 },
        { path: "t.mp4", sent: 10, total: 10 },
      ]);
    } finally {
      xhr.restore();
    }
  });

  it("refuses a spec that names neither a query nor a recipe, and one that names both", async () => {
    const fake = server({});
    const ffrwd = new Ffrwd({ token: TOKEN, apiUrl: API, fetch: fake.fetch });
    await expect(ffrwd.submit({})).rejects.toMatchObject({ status: 0 });
    await expect(
      ffrwd.submit({ query: "SELECT 1", recipe: "ffrwd/faceage:ages" }),
    ).rejects.toMatchObject({ status: 0 });
    expect(fake.requests.length).toBe(0);
  });

  it("sends a lock the caller built, verbatim", async () => {
    const fake = server({});
    const ffrwd = new Ffrwd({ token: TOKEN, apiUrl: API, fetch: fake.fetch });
    await ffrwd.submit({ query: "COPY (SELECT 1) TO 'o.txt'", lock: '{"format_version": 3}\n' });
    const body = JSON.parse(fake.requests[0]?.body as string) as Record<string, unknown>;
    expect(body["lock"]).toBe('{"format_version": 3}\n');
  });
});
