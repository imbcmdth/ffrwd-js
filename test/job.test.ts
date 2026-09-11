/**
 * Following a job and taking what it wrote: the poll, the two ends, and the
 * bare request a download has to be.
 */

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Ffrwd, FfrwdError } from "../src/index.js";
import type { JobDetail } from "../src/index.js";
import { FakeServer, jobRow } from "./fake.js";

const API = "https://api.example/functions/v1";
const JOB_ID = "0c2f4a1e-7b3d-4e2a-9f1a-3b5c7d9e1f2a";
const JOB = `${API}/jobs/${JOB_ID}`;
const TOKEN = "ffrwd_testtoken";
const OUT = new Uint8Array([9, 8, 7, 6, 5]);
const OUT_DIGEST = createHash("sha256").update(OUT).digest("hex");
const OUT_URL = "https://store.example/outputs/out.mp4?X-Amz-Signature=beef";

function client(fake: FakeServer): Ffrwd {
  return new Ffrwd({ token: TOKEN, apiUrl: API, fetch: fake.fetch });
}

describe("wait", () => {
  it("polls through starting, running and finalizing to succeeded", async () => {
    const fake = new FakeServer().on("GET", JOB, [
      { json: jobRow({ state: "starting" }) },
      { json: jobRow({ state: "running", progress_pct: 40 }) },
      { json: jobRow({ state: "finalizing", progress_pct: 100 }) },
      { json: jobRow({ state: "succeeded", progress_pct: 100, log_tail: "done" }) },
    ]);
    const seen: string[] = [];
    const detail = await client(fake)
      .job(JOB_ID)
      .wait({ intervalMs: 0, onUpdate: (one: JobDetail) => seen.push(one.state) });

    expect(seen).toEqual(["starting", "running", "finalizing", "succeeded"]);
    expect(detail.state).toBe("succeeded");
    expect(fake.requests.length).toBe(4);
    expect(fake.requests.every((one) => one.headers["authorization"] === `Bearer ${TOKEN}`)).toBe(
      true,
    );
  });

  it("rejects on failed, carrying the row", async () => {
    const failed = jobRow({
      state: "failed",
      error: "the pipeline stopped at 00:00:04",
      exit_code: 1,
      log_tail: "ffmpeg: no such filter",
    });
    const fake = new FakeServer().on("GET", JOB, [
      { json: jobRow({ state: "running" }) },
      { json: failed },
    ]);

    const err = await client(fake)
      .job(JOB_ID)
      .wait({ intervalMs: 0 })
      .catch((one: unknown) => one);

    expect(err).toBeInstanceOf(FfrwdError);
    const refusal = err as FfrwdError;
    expect(refusal.error).toBe("the pipeline stopped at 00:00:04");
    expect(refusal.job?.state).toBe("failed");
    expect(refusal.job?.log_tail).toBe("ffmpeg: no such filter");
    expect(refusal.job?.exit_code).toBe(1);
  });

  it("rejects on cancelled, with the job's state when it recorded no error", async () => {
    const fake = new FakeServer().on("GET", JOB, { json: jobRow({ state: "cancelled" }) });
    await expect(client(fake).job(JOB_ID).wait({ intervalMs: 0 })).rejects.toMatchObject({
      error: "the job cancelled",
    });
  });

  it("stops the moment its signal aborts", async () => {
    const fake = new FakeServer().on("GET", JOB, { json: jobRow({ state: "running" }) });
    const controller = new AbortController();
    const waiting = client(fake).job(JOB_ID).wait({ intervalMs: 50, signal: controller.signal });
    controller.abort();
    await expect(waiting).rejects.toBeTruthy();
  });
});

describe("outputs and download", () => {
  const fetchAnswer = {
    job_id: JOB_ID,
    outputs: [
      {
        path: "out.mp4",
        bytes: OUT.byteLength,
        sha256: OUT_DIGEST,
        kind: "file",
        name: "out.mp4",
        url: OUT_URL,
      },
    ],
  };

  it("asks for the outputs with the bearer and downloads with no header at all", async () => {
    const fake = new FakeServer()
      .on("POST", `${JOB}/fetch`, { json: fetchAnswer })
      .on("GET", OUT_URL, { body: OUT });

    const blob = await client(fake).job(JOB_ID).download("out.mp4");
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(OUT);

    const [asked, got] = fake.requests;
    expect(asked?.method).toBe("POST");
    expect(asked?.headers["authorization"]).toBe(`Bearer ${TOKEN}`);
    expect(got?.method).toBe("GET");
    expect(got?.url).toBe(OUT_URL);
    // The url is the credential; a bearer beside it makes the store refuse.
    expect(got?.headers["authorization"]).toBeUndefined();
    expect(Object.keys(got?.headers ?? {})).toEqual([]);
  });

  it("refuses bytes that do not hash to what the job recorded", async () => {
    const fake = new FakeServer()
      .on("POST", `${JOB}/fetch`, { json: fetchAnswer })
      .on("GET", OUT_URL, { body: new Uint8Array([1, 2, 3]) });
    await expect(client(fake).job(JOB_ID).download("out.mp4")).rejects.toMatchObject({
      status: 0,
    });
  });

  it("refuses a path the job did not write, naming what it did", async () => {
    const fake = new FakeServer().on("POST", `${JOB}/fetch`, { json: fetchAnswer });
    await expect(client(fake).job(JOB_ID).download("other.mp4")).rejects.toMatchObject({
      error: "the job wrote no output at 'other.mp4'",
      hint: "it wrote: out.mp4",
    });
  });

  it("surfaces the API's 409 when the job has not succeeded", async () => {
    const fake = new FakeServer().on("POST", `${JOB}/fetch`, {
      status: 409,
      json: { error: "the job is running", hint: "wait for it to finish" },
    });
    await expect(client(fake).job(JOB_ID).outputs()).rejects.toMatchObject({
      status: 409,
      error: "the job is running",
      hint: "wait for it to finish",
    });
  });
});

describe("the rest of the job surface", () => {
  it("cancels, pins and unpins", async () => {
    const fake = new FakeServer()
      .on("POST", `${JOB}/cancel`, { json: jobRow({ state: "cancelled" }) })
      .on("PATCH", JOB, [
        { json: jobRow({ state: "succeeded", pinned_at: "2026-09-11T01:00:00.000Z" }) },
        { json: jobRow({ state: "succeeded", pinned_at: null }) },
      ]);
    const job = client(fake).job(JOB_ID);
    expect((await job.cancel()).state).toBe("cancelled");
    expect((await job.pin()).pinned_at).toBe("2026-09-11T01:00:00.000Z");
    expect((await job.pin(false)).pinned_at).toBe(null);
    expect(JSON.parse(fake.requests[1]?.body as string)).toEqual({ pinned: true });
    expect(JSON.parse(fake.requests[2]?.body as string)).toEqual({ pinned: false });
  });

  it("lists with the query it was given", async () => {
    const fake = new FakeServer().on(
      "GET",
      /\/jobs\?/,
      { json: { jobs: [jobRow()], total: 1 } },
    );
    const list = await client(fake).list({ state: "succeeded", limit: 5, filter: "pinned" });
    expect(list.total).toBe(1);
    expect(fake.requests[0]?.url).toBe(
      `${API}/jobs?filter=pinned&state=succeeded&limit=5`,
    );
  });
});
