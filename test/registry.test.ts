/**
 * The registry, over the real index documents.
 *
 * `test/fixtures/*.json` are the public documents as `curl` fetched them from
 * `api.ffrwd.video` -- detail and sources for `ffrwd/faceage` and the three
 * packages it reaches. Nothing here goes near the network.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Registry, compareVersions, storePath, versionKey } from "../src/index.js";
import { FakeServer } from "./fake.js";

const INDEX = "https://index.example/packages";

function document(name: string): Record<string, unknown> {
  const path = new URL(`./fixtures/${name}`, import.meta.url);
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

/** The index as the fixtures hold it: four packages, detail and sources each. */
function index(): FakeServer {
  const fake = new FakeServer();
  for (const name of ["faceage", "wasm", "rfdetr", "mask_tools"]) {
    fake.on("GET", `${INDEX}/p/ffrwd/${name}.json`, { json: document(`${name}.json`) });
    fake.on("GET", `${INDEX}/p/ffrwd/${name}.sources.json`, {
      json: document(`${name}.sources.json`),
    });
  }
  return fake;
}

function registry(fake: FakeServer): Registry {
  return new Registry({ indexUrl: INDEX, fetch: fake.fetch });
}

/** A version entry's sha256, straight out of the fixture. */
function sha(name: string, version: string): string {
  const versions = document(`${name}.json`)["versions"] as Array<Record<string, string>>;
  const found = versions.find((one) => one["version"] === version);
  if (found === undefined) throw new Error(`fixture has no ${name} ${version}`);
  return found["sha256"] as string;
}

describe("version selection", () => {
  it("orders numeric parts as numbers, not as strings", () => {
    expect(compareVersions("1.10.0", "1.9.0")).toBeGreaterThan(0);
    expect(compareVersions("0.2.0", "0.2.0")).toBe(0);
    expect(compareVersions("1.0", "1.0.1")).toBeLessThan(0);
    expect(versionKey("1.2b")).toEqual([
      [0, 1, ""],
      [1, 0, "2b"],
    ]);
  });

  it("takes the highest published version for a bare name", async () => {
    const fake = index();
    // the fixture publishes 0.9.0 through 0.15.0, so string order would be wrong
    expect((await registry(fake).version("ffrwd/wasm")).version).toBe("0.15.0");
    expect((await registry(fake).version("ffrwd/rfdetr")).version).toBe("0.3.0");
  });

  it("takes exactly the version a spec pins", async () => {
    const entry = await registry(index()).version("ffrwd/rfdetr@0.2.0");
    expect(entry.version).toBe("0.2.0");
    expect(entry.sha256).toBe(sha("rfdetr", "0.2.0"));
  });

  it("refuses an unknown version, naming what is published", async () => {
    await expect(registry(index()).version("ffrwd/faceage@9.9.9")).rejects.toMatchObject({
      status: 0,
      error: "the registry has no version 9.9.9 of 'ffrwd/faceage'",
      hint: "published: 0.1.0",
    });
  });

  it("skips a yanked version, and refuses when every version is yanked", async () => {
    const yanked = new FakeServer()
      .on("GET", `${INDEX}/p/ns/one.json`, {
        json: {
          format_version: 2,
          name: "ns/one",
          versions: [
            { version: "1.0.0", sha256: "a".repeat(64), size: 1 },
            { version: "2.0.0", sha256: "b".repeat(64), size: 1, yanked: true },
          ],
        },
      })
      .on("GET", `${INDEX}/p/ns/all.json`, {
        json: {
          format_version: 2,
          name: "ns/all",
          versions: [{ version: "1.0.0", sha256: "c".repeat(64), size: 1, yanked: true }],
        },
      });
    expect((await registry(yanked).version("ns/one")).version).toBe("1.0.0");
    await expect(registry(yanked).version("ns/all")).rejects.toMatchObject({
      error: "the registry publishes no version of 'ns/all'",
    });
  });

  it("refuses a name that is not one, and a 404 as no such package", async () => {
    const fake = index().on("GET", `${INDEX}/p/ffrwd/nothing.json`, { status: 404 });
    await expect(registry(fake).version("faceage")).rejects.toMatchObject({ status: 0 });
    await expect(registry(fake).package("ffrwd/nothing")).rejects.toMatchObject({
      status: 404,
      error: "the registry has no package 'ffrwd/nothing'",
    });
  });
});

describe("resolve", () => {
  it("builds the lock for ffrwd/faceage, in post-order, with store paths", async () => {
    const fake = index();
    const lock = await registry(fake).resolve(["ffrwd/faceage"]);

    expect(lock.format_version).toBe(3);
    expect(lock.reproducible).toBe(true);
    expect(lock.dependencies).toEqual({ "ffrwd/faceage": "0.1.0" });

    // post-order: every package after everything it depends on
    expect(lock.packages.map((one) => `${one.name}@${one.version}`)).toEqual([
      "ffrwd/wasm@0.15.0",
      "ffrwd/mask_tools@1.0.4",
      "ffrwd/rfdetr@0.3.0",
      "ffrwd/faceage@0.1.0",
    ]);

    for (const entry of lock.packages) {
      expect(entry.kind).toBe("registry");
      expect(entry.store).toBe(storePath(entry.sha256));
      expect(entry.store).toBe(`v1/${entry.sha256.slice(0, 2)}/${entry.sha256}`);
    }
    expect(lock.packages[3]?.sha256).toBe(sha("faceage", "0.1.0"));

    // a leaf that published no manifest carries no dependencies key at all
    expect(lock.packages[0]).toEqual({
      kind: "registry",
      name: "ffrwd/wasm",
      version: "0.15.0",
      sha256: sha("wasm", "0.15.0"),
      store: storePath(sha("wasm", "0.15.0")),
    });

    // a dependency is resolved BY NAME at its highest version: faceage's
    // manifest writes mask_tools 1.0.3 and rfdetr 0.2.0, and the lock pins
    // 1.0.4 and 0.3.0 -- which is what the CLI does too.
    expect(lock.packages[3]?.dependencies).toEqual({
      "ffrwd/wasm": "0.15.0",
      "ffrwd/rfdetr": "0.3.0",
      "ffrwd/mask_tools": "1.0.4",
    });
    expect(lock.packages[2]?.dependencies).toEqual({
      "ffrwd/wasm": "0.15.0",
      "ffrwd/mask_tools": "1.0.4",
    });
  });

  it("writes the lock text the way ffrwd.lock is written", async () => {
    const lock = await registry(index()).resolve(["ffrwd/faceage"]);
    expect(lock.text.endsWith("\n")).toBe(true);
    expect(lock.text.split("\n")[0]).toBe("{");
    expect(lock.text).toContain('  "format_version": 3,\n  "reproducible": true,');
    const parsed = JSON.parse(lock.text) as Record<string, unknown>;
    const { text: _text, ...object } = lock;
    expect(parsed).toEqual(object);
  });

  it("fetches each document once across the whole walk", async () => {
    const fake = index();
    await registry(fake).resolve(["ffrwd/faceage"]);
    const urls = fake.requests.map((one) => one.url);
    expect(new Set(urls).size).toBe(urls.length);
    // four packages, detail and sources each
    expect(urls.length).toBe(8);
  });

  it("pins a package once when two specs reach it", async () => {
    const lock = await registry(index()).resolve(["ffrwd/faceage", "ffrwd/rfdetr"]);
    expect(lock.packages.filter((one) => one.name === "ffrwd/rfdetr").length).toBe(1);
    expect(lock.dependencies).toEqual({
      "ffrwd/faceage": "0.1.0",
      "ffrwd/rfdetr": "0.3.0",
    });
  });

  it("answers an empty lock for no specs at all", async () => {
    const lock = await registry(index()).resolve([]);
    expect(lock.packages).toEqual([]);
    expect(lock.text).toBe('{\n  "format_version": 3,\n  "reproducible": true,\n  "packages": []\n}\n');
  });

  it("refuses a dependency cycle, naming the loop", async () => {
    const detail = (name: string, digest: string): Record<string, unknown> => ({
      format_version: 2,
      name,
      versions: [{ version: "1.0.0", sha256: digest.repeat(64), size: 1 }],
    });
    const sources = (name: string, depends: string): Record<string, unknown> => ({
      format_version: 2,
      name,
      versions: [
        {
          version: "1.0.0",
          sha256: "a".repeat(64),
          sources: {},
          files: {
            "ffrwd.json": JSON.stringify({
              name,
              version: "1.0.0",
              dependencies: { [depends]: "1.0.0" },
            }),
          },
        },
      ],
    });
    const fake = new FakeServer()
      .on("GET", `${INDEX}/p/ns/a.json`, { json: detail("ns/a", "a") })
      .on("GET", `${INDEX}/p/ns/a.sources.json`, { json: sources("ns/a", "ns/b") })
      .on("GET", `${INDEX}/p/ns/b.json`, { json: detail("ns/b", "b") })
      .on("GET", `${INDEX}/p/ns/b.sources.json`, { json: sources("ns/b", "ns/a") });

    await expect(registry(fake).resolve(["ns/a"])).rejects.toMatchObject({
      status: 0,
      error: "dependency cycle: ns/a -> ns/b -> ns/a",
    });
  });
});

describe("sources and recipes", () => {
  it("reads a version's recipes and its manifest", async () => {
    const sources = await registry(index()).sources("ffrwd/faceage", "0.1.0");
    expect(Object.keys(sources.recipes).sort()).toEqual(["ages", "blur-children", "mosaic-children"]);
    expect(sources.manifest?.dependencies).toEqual({
      "ffrwd/wasm": "0.15.0",
      "ffrwd/rfdetr": "0.2.0",
      "ffrwd/mask_tools": "1.0.3",
    });
    expect(sources.files["ffrwd.json"]).toContain('"name": "ffrwd/faceage"');
  });

  it("answers empty maps for a package that published no SQL", async () => {
    const sources = await registry(index()).sources("ffrwd/wasm", "0.15.0");
    expect(sources.recipes).toEqual({});
    expect(sources.files).toEqual({});
    expect(sources.manifest).toBe(null);
  });

  it("hands back one recipe: its SQL, what it requires and what it takes", async () => {
    const recipe = await registry(index()).recipe("ffrwd/faceage", "blur-children");
    expect(recipe.name).toBe("blur-children");
    expect(recipe.version).toBe("0.1.0");
    expect(recipe.text).toContain("-- variables:");
    expect(recipe.required.map((one) => one.name)).toEqual(["source", "dest"]);
    expect(recipe.optional.map((one) => one.name)).toContain("max_age");
    expect(recipe.usage).toContain("ffrwd run ffrwd/faceage:blur-children");
  });

  it("refuses a recipe the package does not publish, naming the ones it does", async () => {
    await expect(registry(index()).recipe("ffrwd/faceage", "nope")).rejects.toMatchObject({
      error: "'ffrwd/faceage' 0.1.0 publishes no recipe 'nope'",
      hint: "it publishes: blur-children, mosaic-children, ages",
    });
  });
});
