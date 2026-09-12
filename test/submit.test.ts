import { CLIENT_VERSION } from "../src/jobs.js";
/**
 * The submit sequence: what goes out, in what order, carrying what -- and what
 * is refused before a single byte is sent.
 *
 * The three steps are also three methods, and the tests below take them both
 * ways: `submit` end to end, and `prepare` / `upload` / `ready` apart, as a
 * server and a browser run them.
 */

import { describe, expect, it } from "vitest";
import { Ffrwd, FfrwdError, upload } from "../src/index.js";
import type { Prepared, PreparedJob } from "../src/index.js";
import {
  FRESH_UNTIL,
  FakeServer,
  JOB_ID,
  fakeXhr,
  jobRow,
  putUrl,
  signed,
  submitAnswer,
} from "./fake.js";

const API = "https://api.example/functions/v1";
const JOBS = `${API}/jobs`;
const READY = `${JOBS}/${JOB_ID}/ready`;
const TOKEN = "ffrwd_testtoken";

const BYTES = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
const OTHER = new Uint8Array([9, 8, 7]);

const QUERY = "COPY (SELECT f.video[1] FROM input(:'source') f) TO :'dest'";

/**
 * A scripted API: the submit answers with `uploads`, and every url in it takes
 * a PUT. `uploads` is a list, one entry per file input, keyed by position.
 */
function server(uploads: Array<Record<string, unknown>> = []): FakeServer {
  const fake = new FakeServer()
    .on("POST", JOBS, { status: 201, json: submitAnswer(uploads) })
    .on("POST", READY, { json: jobRow({ state: "queued" }) });
  for (const entry of uploads) fake.on("PUT", entry["url"] as string, { status: 200 });
  return fake;
}

function client(fake: FakeServer): Ffrwd {
  return new Ffrwd({ token: TOKEN, apiUrl: API, fetch: fake.fetch });
}

describe("submit", () => {
  it("posts the spec, puts the file, posts ready, and nothing else", async () => {
    const fake = server(signed(0));
    const job = await client(fake).submit({
      query: QUERY,
      variables: { source: "t.mp4", dest: "out.mp4" },
      inputs: { "t.mp4": BYTES },
      title: "a test",
      timeoutSeconds: 120,
    });

    expect(job.id).toBe(JOB_ID);
    expect(fake.requests.length).toBe(3);

    const [submit, sent, ready] = fake.requests;

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
    // a file input is its path, its kind and its size: nothing is hashed
    expect(body["inputs"]).toEqual([
      { path: "t.mp4", kind: "file", bytes: BYTES.byteLength },
    ]);
    const first = (body["inputs"] as Array<Record<string, unknown>>)[0] as Record<string, unknown>;
    expect(Object.keys(first)).toEqual(["path", "kind", "bytes"]);
    expect("sha256" in first).toBe(false);
    // the outputs default to what the query says it writes
    expect(body["outputs"]).toEqual(["out.mp4"]);
    expect(body["packages"]).toEqual([]);
    expect(body["lock"]).toBe(null);
    expect(body["recipe"]).toBe(null);
    expect(body["timeout_s"]).toBe(120);
    expect(body["title"]).toBe("a test");
    expect(body["client_version"]).toBe(CLIENT_VERSION);

    // 2. the upload: to the url signed for the input's index, and the url is
    // the whole credential
    expect(sent?.method).toBe("PUT");
    expect(sent?.url).toBe(putUrl(0));
    expect(Object.keys(sent?.headers ?? {})).toEqual(["content-length"]);
    expect(sent?.headers["content-length"]).toBe(String(BYTES.byteLength));
    expect(sent?.headers["authorization"]).toBeUndefined();
    expect(sent?.body).toEqual(BYTES);

    // 3. ready, with the same bearer as the submit
    expect(ready?.method).toBe("POST");
    expect(ready?.url).toBe(READY);
    expect(ready?.headers["authorization"]).toBe(`Bearer ${TOKEN}`);
    expect(ready?.body).toBe("{}");
  });

  it("refuses an index the answer left out before any PUT", async () => {
    // Two file inputs, and only the first is signed for.
    const fake = server(signed(0));
    await expect(
      client(fake).submit({
        query: "COPY (SELECT 1) TO 'out.txt'",
        inputs: { "a.bin": BYTES, "b.bin": OTHER },
      }),
    ).rejects.toMatchObject({
      status: 0,
      error: "the submit answer carries no upload url for 'b.bin' (the input at index 1)",
    });

    // The spec went out; not even the input that WAS signed for was sent.
    expect(fake.requests.map((one) => one.method)).toEqual(["POST"]);
    expect(fake.requests[0]?.url).toBe(JOBS);
  });

  it("leaves a gap for a url input, and each file finds its own url", async () => {
    const between = "https://media.example/mid.mp4";
    // The url input holds position 1, so the second file is at index 2.
    const fake = server(signed(0, 2));
    await client(fake).submit({
      query: "COPY (SELECT 1) TO 'out.txt'",
      inputs: { "a.bin": BYTES, [between]: { url: between }, "b.bin": OTHER },
    });

    const body = JSON.parse(fake.requests[0]?.body as string) as Record<string, unknown>;
    expect((body["inputs"] as Array<Record<string, unknown>>).map((one) => one["kind"])).toEqual([
      "file",
      "url",
      "file",
    ]);
    const puts = fake.requests.filter((one) => one.method === "PUT");
    expect(puts.map((one) => one.url)).toEqual([putUrl(0), putUrl(2)]);
    expect(puts[0]?.body).toEqual(BYTES);
    expect(puts[1]?.body).toEqual(OTHER);
  });

  it("sends two names over the same bytes as two inputs and two uploads", async () => {
    const fake = server(signed(0, 1));
    await client(fake).submit({
      query: "COPY (SELECT 1) TO 'out.txt'",
      inputs: { "a.bin": BYTES, "b.bin": BYTES },
    });
    const body = JSON.parse(fake.requests[0]?.body as string) as Record<string, unknown>;
    expect(body["inputs"]).toEqual([
      { path: "a.bin", kind: "file", bytes: BYTES.byteLength },
      { path: "b.bin", kind: "file", bytes: BYTES.byteLength },
    ]);
    expect(fake.requests.filter((one) => one.method === "PUT").map((one) => one.url)).toEqual([
      putUrl(0),
      putUrl(1),
    ]);
  });

  it("refuses an answer with no ready_url, and an uploads that is not a list", async () => {
    const noReady = new FakeServer().on("POST", JOBS, {
      status: 201,
      json: { job_id: JOB_ID, uploads: [], packages: {} },
    });
    await expect(client(noReady).submit({ query: QUERY })).rejects.toMatchObject({ status: 0 });

    const badUploads = new FakeServer().on("POST", JOBS, {
      status: 201,
      json: { job_id: JOB_ID, ready_url: READY, uploads: {}, packages: {} },
    });
    await expect(client(badUploads).submit({ query: QUERY })).rejects.toMatchObject({
      status: 0,
      error: `the answer from ${JOBS} has no 'uploads' list`,
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

    const err = await client(fake)
      .submit({ query: QUERY })
      .catch((one: unknown) => one);
    expect(err).toBeInstanceOf(FfrwdError);
    const refusal = err as FfrwdError;
    expect(refusal.status).toBe(402);
    expect(refusal.error).toBe("the free allotment is spent: 0m cpu and 0m gpu left");
    expect(refusal.hint).toBe("it resets on 2026-09-04; until then, run without --remote");
    expect(refusal.message).toBe(refusal.error);
  });

  it("gives a status and a generic sentence when the refusal carries no words", async () => {
    const fake = new FakeServer().on("POST", JOBS, { status: 500, body: "<html>nope" });
    await expect(client(fake).submit({ query: QUERY })).rejects.toMatchObject({
      status: 500,
      error: "the ffrwd API refused the request with HTTP 500",
    });
  });

  it("declares a url input without uploading anything", async () => {
    const fake = server();
    const url = "https://media.example/in.mp4";
    await client(fake).submit({
      query: `COPY (SELECT * FROM input('${url}')) TO 'out.mp4'`,
      inputs: { [url]: { url } },
    });
    const body = JSON.parse(fake.requests[0]?.body as string) as Record<string, unknown>;
    expect(body["inputs"]).toEqual([{ path: url, kind: "url" }]);
    expect(fake.requests.map((one) => one.method)).toEqual(["POST", "POST"]);
  });

  it("refuses a url input keyed by something other than that url", async () => {
    const fake = server();
    await expect(
      client(fake).submit({ query: QUERY, inputs: { "t.mp4": { url: "https://media.example/x" } } }),
    ).rejects.toMatchObject({ status: 0 });
    expect(fake.requests.length).toBe(0);
  });

  it("refuses a {bytes} placeholder, which is a spec for prepare", async () => {
    const fake = server(signed(0));
    await expect(
      // @ts-expect-error -- a size stands in for bytes in a PrepareSpec alone
      client(fake).submit({ query: QUERY, inputs: { "t.mp4": { bytes: 10 } } }),
    ).rejects.toMatchObject({
      status: 0,
      error: "input 't.mp4' is given as a size, and a submit uploads the bytes itself",
    });
    expect(fake.requests.length).toBe(0);
  });

  it("reports progress once per upload without XMLHttpRequest", async () => {
    const fake = server(signed(0));
    const seen: Array<{ path: string; sent: number; total: number }> = [];
    await client(fake).submit(
      { query: QUERY, inputs: { "t.mp4": BYTES } },
      { onProgress: (one) => seen.push(one) },
    );
    // The path is the spec's own, not the one the answer echoed back.
    expect(seen).toEqual([{ path: "t.mp4", sent: 10, total: 10 }]);
  });

  it("reports progress as it happens where XMLHttpRequest exists", async () => {
    const xhr = fakeXhr(200, 2);
    try {
      const fake = server(signed(0));
      const seen: Array<{ path: string; sent: number; total: number }> = [];
      await client(fake).submit(
        { query: QUERY, inputs: { "t.mp4": BYTES } },
        { onProgress: (one) => seen.push(one) },
      );
      // the bytes went through XHR, so the fake fetch saw only the two API calls
      expect(fake.requests.map((one) => one.method)).toEqual(["POST", "POST"]);
      expect(xhr.sent.length).toBe(1);
      expect(xhr.sent[0]?.url).toBe(putUrl(0));
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
    const fake = server();
    await expect(client(fake).submit({})).rejects.toMatchObject({ status: 0 });
    await expect(
      client(fake).submit({ query: "SELECT 1", recipe: "ffrwd/faceage:ages" }),
    ).rejects.toMatchObject({ status: 0 });
    expect(fake.requests.length).toBe(0);
  });

  it("sends a lock the caller built, verbatim", async () => {
    const fake = server();
    await client(fake).submit({
      query: "COPY (SELECT 1) TO 'o.txt'",
      lock: '{"format_version": 3}\n',
    });
    const body = JSON.parse(fake.requests[0]?.body as string) as Record<string, unknown>;
    expect(body["lock"]).toBe('{"format_version": 3}\n');
  });
});

describe("prepare", () => {
  it("declares a file by the size it was given, and uploads nothing", async () => {
    const fake = server(signed(0));
    const prepared = await client(fake).prepare({
      query: QUERY,
      variables: { source: "t.mp4", dest: "out.mp4" },
      inputs: { "t.mp4": { bytes: 4096 } },
    });

    const body = JSON.parse(fake.requests[0]?.body as string) as Record<string, unknown>;
    expect(body["inputs"]).toEqual([{ path: "t.mp4", kind: "file", bytes: 4096 }]);
    // the spec went out, and that is all: no PUT, no ready
    expect(fake.requests.map((one) => one.method)).toEqual(["POST"]);
    expect(fake.requests[0]?.url).toBe(JOBS);

    expect(prepared.jobId).toBe(JOB_ID);
    expect(prepared.readyUrl).toBe(READY);
    expect(prepared.outputsExpireDays).toBe(7);
    expect(prepared.remaining).toEqual({ cpu_seconds: 6405, gpu_seconds: 2562 });
    // the ticket is the answer's url at this input's index, under the path the
    // spec named it by
    expect(prepared.uploads).toEqual([
      { index: 0, path: "t.mp4", url: putUrl(0), expiresAt: FRESH_UNTIL },
    ]);
  });

  it("refuses a {bytes} that is not a byte count, before asking", async () => {
    const fake = server(signed(0));
    await expect(
      // @ts-expect-error -- a size is a number, and this is not one
      client(fake).prepare({ query: QUERY, inputs: { "t.mp4": { bytes: "4096" } } }),
    ).rejects.toMatchObject({
      status: 0,
      error: "input 't.mp4' is given as {bytes: 4096}, which is not a size",
    });
    expect(fake.requests.length).toBe(0);
  });

  it("takes the bytes themselves as well, for a caller that holds them", async () => {
    const fake = server(signed(0));
    const prepared = await client(fake).prepare({ query: QUERY, inputs: { "t.mp4": BYTES } });
    const body = JSON.parse(fake.requests[0]?.body as string) as Record<string, unknown>;
    expect(body["inputs"]).toEqual([{ path: "t.mp4", kind: "file", bytes: 10 }]);
    expect(prepared.uploads.length).toBe(1);
  });
});

describe("ready", () => {
  it("posts the ready url with the bearer, and nothing else", async () => {
    const fake = new FakeServer().on("POST", READY, { json: jobRow({ state: "queued" }) });
    const job = await client(fake).ready({ jobId: JOB_ID, readyUrl: READY });

    expect(job.id).toBe(JOB_ID);
    expect(fake.requests.length).toBe(1);
    const [posted] = fake.requests;
    expect(posted?.method).toBe("POST");
    expect(posted?.url).toBe(READY);
    expect(posted?.headers["authorization"]).toBe(`Bearer ${TOKEN}`);
    expect(posted?.body).toBe("{}");
  });

  it("takes a prepared job that went through JSON and came back", async () => {
    const fake = server(signed(0));
    const ffrwd = client(fake);
    const prepared = await ffrwd.prepare({
      query: QUERY,
      variables: { source: "t.mp4", dest: "out.mp4" },
      inputs: { "t.mp4": { bytes: BYTES.byteLength } },
    });

    // What a server hands a browser, and what the browser hands back.
    const written = JSON.stringify(prepared);
    const read = JSON.parse(written) as PreparedJob;
    expect(read).toEqual({
      jobId: JOB_ID,
      uploads: [{ index: 0, path: "t.mp4", url: putUrl(0), expiresAt: FRESH_UNTIL }],
      readyUrl: READY,
      outputsExpireDays: 7,
      remaining: { cpu_seconds: 6405, gpu_seconds: 2562 },
    });
    // toJSON hands back the data and nothing of itself
    expect(Object.keys(read)).not.toContain("toJSON");
    expect((prepared as Prepared).toJSON()).toEqual(read);

    // the browser's upload, then the server's ready over what came back
    await upload(read.uploads[0] as { url: string }, BYTES, { fetch: fake.fetch });
    const job = await ffrwd.ready(read);

    expect(job.id).toBe(JOB_ID);
    expect(job.submitted?.uploads).toEqual(read.uploads);
    expect(fake.requests.map((one) => `${one.method} ${one.url}`)).toEqual([
      `POST ${JOBS}`,
      `PUT ${putUrl(0)}`,
      `POST ${READY}`,
    ]);
  });

  it("refuses something that names neither a job nor a ready url", async () => {
    const fake = new FakeServer();
    await expect(
      client(fake).ready({ jobId: "", readyUrl: "" }),
    ).rejects.toMatchObject({ status: 0 });
    expect(fake.requests.length).toBe(0);
  });
});

describe("upload", () => {
  it("sends only content-length, and carries no authorization", async () => {
    const fake = new FakeServer().on("PUT", putUrl(0), { status: 200 });
    const seen: Array<{ sent: number; total: number }> = [];
    await upload({ url: putUrl(0), path: "t.mp4", expiresAt: FRESH_UNTIL }, BYTES, {
      fetch: fake.fetch,
      onProgress: (one) => seen.push(one),
    });

    expect(fake.requests.length).toBe(1);
    const [sent] = fake.requests;
    expect(sent?.method).toBe("PUT");
    expect(sent?.url).toBe(putUrl(0));
    expect(Object.keys(sent?.headers ?? {})).toEqual(["content-length"]);
    expect(sent?.headers["content-length"]).toBe(String(BYTES.byteLength));
    expect(sent?.headers["authorization"]).toBeUndefined();
    expect(sent?.body).toEqual(BYTES);
    // a bare progress report: how far, with no job and no path in it
    expect(seen).toEqual([{ sent: 10, total: 10 }]);
  });

  it("says the url expired when the store refuses one whose time has passed", async () => {
    const fake = new FakeServer().on("PUT", putUrl(0), { status: 403 });
    await expect(
      upload({ url: putUrl(0), path: "t.mp4", expiresAt: "2020-01-01T00:00:00.000Z" }, BYTES, {
        fetch: fake.fetch,
      }),
    ).rejects.toMatchObject({
      status: 403,
      error: "the upload url for 't.mp4' expired at 2020-01-01T00:00:00.000Z",
    });
  });
});
