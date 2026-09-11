/**
 * The two things that read the query itself: the `COPY ... TO` scan a submit
 * defaults its outputs from, and the recipe path, which substitutes published
 * SQL and resolves the package it came from into the lock.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Ffrwd, Registry, copyDestinations } from "../src/index.js";
import { FakeServer, jobRow } from "./fake.js";

const INDEX = "https://index.example/packages";
const API = "https://api.example/functions/v1";
const JOBS = `${API}/jobs`;
const JOB_ID = "0c2f4a1e-7b3d-4e2a-9f1a-3b5c7d9e1f2a";
const READY = `${JOBS}/${JOB_ID}/ready`;

function document(name: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"),
  ) as Record<string, unknown>;
}

function world(): FakeServer {
  const fake = new FakeServer();
  for (const name of ["faceage", "wasm", "rfdetr", "mask_tools"]) {
    fake.on("GET", `${INDEX}/p/ffrwd/${name}.json`, { json: document(`${name}.json`) });
    fake.on("GET", `${INDEX}/p/ffrwd/${name}.sources.json`, {
      json: document(`${name}.sources.json`),
    });
  }
  return fake
    .on("POST", JOBS, {
      status: 201,
      // No file inputs here, so `uploads` is the empty list the answer sends
      // for a job with nothing to upload; `packages` is always a map.
      json: { job_id: JOB_ID, uploads: [], packages: {}, ready_url: READY },
    })
    .on("POST", READY, { json: jobRow() });
}

function client(fake: FakeServer): Ffrwd {
  return new Ffrwd({
    token: "ffrwd_testtoken",
    apiUrl: API,
    fetch: fake.fetch,
    registry: new Registry({ indexUrl: INDEX, fetch: fake.fetch }),
  });
}

describe("copyDestinations", () => {
  it("reads the string-literal destinations, in written order", () => {
    expect(copyDestinations("COPY (SELECT 1) TO 'out.mp4' WITH (video_codec 'libx264')")).toEqual([
      "out.mp4",
    ]);
    expect(
      copyDestinations("COPY (SELECT 1) TO 'a.mp4';\nCOPY (SELECT 2) TO 'b.ndjson';"),
    ).toEqual(["a.mp4", "b.ndjson"]);
  });

  it("reads nothing out of STDOUT, a computed destination, or a comment", () => {
    expect(copyDestinations("COPY (SELECT 1) TO STDOUT")).toEqual([]);
    expect(copyDestinations("COPY (SELECT 1) TO ('frame' || i || '.png')")).toEqual([]);
    expect(copyDestinations("-- COPY (SELECT 1) TO 'x.mp4'\nSELECT 1")).toEqual([]);
    expect(copyDestinations("/* COPY (SELECT 1) TO 'x.mp4' */")).toEqual([]);
    expect(copyDestinations("SELECT 'not a copy' AS to")).toEqual([]);
  });

  it("keeps a doubled quote as one", () => {
    expect(copyDestinations("COPY (SELECT 1) TO 'it''s.mp4'")).toEqual(["it's.mp4"]);
  });
});

describe("submit with a recipe", () => {
  it("substitutes the published SQL and resolves the package into the lock", async () => {
    const fake = world();
    await client(fake).submit({
      recipe: "ffrwd/faceage:blur-children",
      variables: { source: "class.mp4", max_age: "16", dest: "blurred.mp4" },
      inputs: { "class.mp4": { url: "class.mp4" } },
    });

    const submit = fake.requests.find((one) => one.url === JOBS);
    const body = JSON.parse(submit?.body as string) as Record<string, unknown>;
    expect(body["recipe"]).toBe("ffrwd/faceage:blur-children");
    expect(body["query"]).toContain("'class.mp4'");
    expect(body["query"]).not.toContain(":'source'");
    // the variables travel as written beside the substituted text
    expect(body["variables"]).toEqual({
      source: "class.mp4",
      max_age: "16",
      dest: "blurred.mp4",
    });
    // the recipe's own package came along in the lock, with what it depends on
    const lock = JSON.parse(body["lock"] as string) as {
      dependencies: Record<string, string>;
      packages: Array<{ name: string }>;
    };
    expect(lock.dependencies).toEqual({ "ffrwd/faceage": "0.1.0" });
    expect(lock.packages.map((one) => one.name)).toEqual([
      "ffrwd/wasm",
      "ffrwd/mask_tools",
      "ffrwd/rfdetr",
      "ffrwd/faceage",
    ]);
    expect(body["outputs"]).toEqual(["blurred.mp4"]);
  });

  it("refuses before anything is sent when a required variable is unset", async () => {
    const fake = world();
    await expect(
      client(fake).submit({
        recipe: "ffrwd/faceage:blur-children",
        variables: { source: "class.mp4", max_age: "16" },
      }),
    ).rejects.toMatchObject({ status: 0, error: "':dest' was not set" });
    expect(fake.requests.filter((one) => one.url === JOBS).length).toBe(0);
  });

  it("leaves an optional variable unset, which substitutes to NULL", async () => {
    const fake = world();
    await client(fake).submit({
      recipe: "ffrwd/faceage:blur-children",
      variables: { source: "class.mp4", max_age: "16", dest: "blurred.mp4" },
    });
    const body = JSON.parse(
      fake.requests.find((one) => one.url === JOBS)?.body as string,
    ) as Record<string, unknown>;
    expect(body["query"]).toContain("NULL");
  });

  it("adds extra packages beside the recipe's own", async () => {
    const fake = world();
    await client(fake).submit({
      query: "COPY (SELECT 1) TO 'o.txt'",
      packages: ["ffrwd/mask_tools"],
    });
    const body = JSON.parse(
      fake.requests.find((one) => one.url === JOBS)?.body as string,
    ) as Record<string, unknown>;
    const lock = JSON.parse(body["lock"] as string) as { packages: Array<{ name: string }> };
    expect(lock.packages.map((one) => one.name)).toEqual(["ffrwd/mask_tools"]);
  });

  it("refuses a recipe written without a recipe name", async () => {
    const fake = world();
    await expect(client(fake).submit({ recipe: "ffrwd/faceage" })).rejects.toMatchObject({
      status: 0,
    });
  });
});
