/**
 * Packages that are not public: the authorized detail route, and the archive
 * the SQL and the manifest are read out of when there is no sources document.
 *
 * The archive here is a real one -- a ustar tar this file writes byte by byte,
 * gzipped with Node's own `zlib` -- so the reader is exercised over the layout
 * the publisher actually writes: a member over one block, a nested path, a
 * directory member to skip, and a path long enough to need the ustar `prefix`
 * field. Nothing here goes near the network.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { DEFAULT_INDEX_URL, Ffrwd, Registry } from "../src/index.js";
import { FakeServer, type Reply } from "./fake.js";

const INDEX = "https://index.example/packages";
const API = "https://api.example/functions/v1";
const TOKEN = "ffrwd_privatetoken";
const NAME = "ns/secret";
const VERSION = "1.2.0";

const PUBLIC_DETAIL = `${INDEX}/p/${NAME}.json`;
const PUBLIC_SOURCES = `${INDEX}/p/${NAME}.sources.json`;
const PRIVATE_DETAIL = `${API}/private/p/${NAME}`;
const SIGNED = "https://store.example/archives/secret.tgz?X-Amz-Signature=deadbeef";

// ---------------------------------------------------------------------------
// a tar, written the way the publisher writes one
// ---------------------------------------------------------------------------

const BLOCK = 512;

function put(header: Uint8Array, at: number, text: string): void {
  header.set(new TextEncoder().encode(text), at);
}

/** `value` as the octal a tar header field holds: padded, NUL-terminated. */
function octal(value: number, width: number): string {
  return value.toString(8).padStart(width - 1, "0") + "\0";
}

/**
 * One member: a 512-byte ustar header, then its data padded to a whole block.
 *
 * A path over 100 bytes is split at a separator into the `prefix` field, which
 * is what a real archive does and what the reader has to join back.
 */
function member(path: string, body: Uint8Array, type: string): Uint8Array {
  let name = path;
  let prefix = "";
  if (name.length > 100) {
    const cut = name.lastIndexOf("/");
    prefix = name.slice(0, cut);
    name = name.slice(cut + 1);
  }
  const header = new Uint8Array(BLOCK);
  put(header, 0, name);
  put(header, 100, octal(type === "5" ? 0o755 : 0o644, 8));
  put(header, 108, octal(0, 8));
  put(header, 116, octal(0, 8));
  put(header, 124, octal(body.byteLength, 12));
  put(header, 136, octal(0, 12));
  put(header, 148, "        "); // the checksum field counts as spaces while summed
  put(header, 156, type);
  put(header, 257, "ustar\0");
  put(header, 263, "00");
  put(header, 345, prefix);
  let sum = 0;
  for (const byte of header) sum += byte;
  put(header, 148, octal(sum, 7) + " ");

  const out = new Uint8Array(BLOCK + Math.ceil(body.byteLength / BLOCK) * BLOCK);
  out.set(header, 0);
  out.set(body, BLOCK);
  return out;
}

/** A tar over `files`, plus `directories` as members the reader must skip. */
function tar(files: Record<string, string>, directories: string[] = []): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const path of directories) parts.push(member(path, new Uint8Array(0), "5"));
  for (const [path, text] of Object.entries(files)) {
    parts.push(member(path, new TextEncoder().encode(text), "0"));
  }
  parts.push(new Uint8Array(BLOCK * 2)); // the two zeroed blocks that end one
  const out = new Uint8Array(parts.reduce((sum, one) => sum + one.byteLength, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
}

// ---------------------------------------------------------------------------
// what the archive holds
// ---------------------------------------------------------------------------

/** A member over one block, so the reader has to walk the padding correctly. */
const README = `# ns/secret\n\n${"a private package. ".repeat(60)}\n`;

/** Long enough that its header needs the ustar prefix field. */
const LONG = `src/${"deeply/".repeat(14)}nested.sql`;

const FACES = "-- variables: source, dest\nCOPY (SELECT 1) TO :'dest';\n";

const MANIFEST = JSON.stringify(
  {
    name: NAME,
    version: VERSION,
    description: "not public",
    dependencies: { "ns/pub": "1.0.0" },
  },
  null,
  2,
);

const ARCHIVE = new Uint8Array(
  gzipSync(
    Buffer.from(
      tar(
        {
          LICENSE: "Apache-2.0\n",
          "README.md": README,
          "ffrwd.json": MANIFEST,
          "recipes/faces.sql": FACES,
          "src/video.sql": "-- the lib\n",
          [LONG]: "-- deep\n",
          "notes.txt": "not published as text",
        },
        ["recipes/", "src/"],
      ),
    ),
  ),
);

const SHA256 = createHash("sha256").update(ARCHIVE).digest("hex");
const SIGN = `${API}/archive/${SHA256}`;

function detail(): Record<string, unknown> {
  return {
    format_version: 2,
    name: NAME,
    versions: [
      {
        version: VERSION,
        sha256: SHA256,
        size: ARCHIVE.byteLength,
        namespace: "ns",
        recipes: [
          {
            name: "faces",
            file: "recipes/faces.sql",
            usage: "ffrwd run ns/secret:faces -v source=in.mp4",
            required: [{ name: "source" }, { name: "dest" }],
            optional: [{ name: "conf" }],
          },
          { name: "missing", file: "recipes/gone.sql" },
        ],
      },
    ],
  };
}

/** What object storage answers for a public document that is not there. */
const NOT_THERE: Reply = {
  status: 400,
  json: {
    statusCode: "404",
    error: "not_found",
    message: "Object not found",
    code: "NoSuchKey",
  },
};

/** What one of the four routes answers with, when a test wants another answer. */
interface World {
  publicDetail?: Reply;
  privateDetail?: Reply;
  sign?: Reply;
  download?: Reply;
  /** Also answer the PUBLIC index's own url, for the default registry. */
  defaultIndex?: boolean;
}

/**
 * The private world: nothing public for `ns/secret`, everything authorized, and
 * one public package beside it for a resolve to reach.
 */
function world(over: World = {}): FakeServer {
  const fake = new FakeServer()
    .on("GET", PUBLIC_DETAIL, over.publicDetail ?? NOT_THERE)
    .on("GET", PUBLIC_SOURCES, NOT_THERE)
    .on("GET", PRIVATE_DETAIL, over.privateDetail ?? { json: detail() })
    .on("GET", SIGN, over.sign ?? {
      json: { url: SIGNED, expires_at: "2026-09-12T00:05:00.000Z", name: NAME, version: VERSION },
    })
    .on("GET", SIGNED, over.download ?? { body: ARCHIVE })
    .on("GET", `${INDEX}/p/ns/pub.json`, {
      json: {
        format_version: 2,
        name: "ns/pub",
        versions: [{ version: "2.0.0", sha256: "b".repeat(64), size: 10 }],
      },
    })
    .on("GET", `${INDEX}/p/ns/pub.sources.json`, {
      json: {
        format_version: 2,
        name: "ns/pub",
        versions: [{ version: "2.0.0", sha256: "b".repeat(64), sources: {}, files: {} }],
      },
    });
  if (over.defaultIndex === true) {
    fake.on("GET", `${DEFAULT_INDEX_URL}/p/${NAME}.json`, NOT_THERE);
    fake.on("GET", `${DEFAULT_INDEX_URL}/p/${NAME}.sources.json`, NOT_THERE);
  }
  return fake;
}

function registry(fake: FakeServer, auth = true): Registry {
  return new Registry({
    indexUrl: INDEX,
    apiUrl: API,
    fetch: fake.fetch,
    ...(auth ? { auth: { token: TOKEN } } : {}),
  });
}

/** Every archive request the fake saw: the signing call and the download. */
function archiveCalls(fake: FakeServer): string[] {
  return fake.requests
    .map((one) => one.url)
    .filter((url) => url.startsWith(`${API}/archive/`) || url === SIGNED);
}

/** What a call refused with, as the three fields an `FfrwdError` carries. */
async function refusal(
  work: Promise<unknown>,
): Promise<{ status: number; error: string; hint: string }> {
  return work.then(
    () => {
      throw new Error("it did not refuse");
    },
    (error: unknown) => error as { status: number; error: string; hint: string },
  );
}

describe("the authorized detail route", () => {
  it("falls through to it, and sends the bearer only there", async () => {
    const fake = world();
    const document = await registry(fake).package(NAME);

    expect(document.name).toBe(NAME);
    expect(document.versions.map((one) => one.version)).toEqual([VERSION]);

    // public first, private second, and nothing else: reading the detail
    // document downloads no archive at all.
    expect(fake.requests.map((one) => one.url)).toEqual([PUBLIC_DETAIL, PRIVATE_DETAIL]);
    expect(fake.to(PUBLIC_DETAIL)[0]?.headers["authorization"]).toBeUndefined();
    expect(fake.to(PRIVATE_DETAIL)[0]?.headers["authorization"]).toBe(`Bearer ${TOKEN}`);
  });

  it("reads a plain 404 on the public document as absent too", async () => {
    const fake = world({ publicDetail: { status: 404 } });
    expect((await registry(fake).package(NAME)).name).toBe(NAME);
  });

  it("is not asked at all without auth: a private package is no package", async () => {
    const fake = world();
    expect(await refusal(registry(fake, false).package(NAME))).toMatchObject({
      status: 404,
      error: `the registry has no package '${NAME}'`,
    });
    expect(fake.requests.map((one) => one.url)).toEqual([PUBLIC_DETAIL]);
  });

  it("says what a 403 means, in the words the CLI uses", async () => {
    const fake = world({
      privateDetail: { status: 403, json: { error: "forbidden", hint: "not yours" } },
    });
    expect(await refusal(registry(fake).package(NAME))).toMatchObject({
      status: 403,
      error: `this token does not authorize reading '${NAME}'`,
      hint: "the token's account is not a member of that namespace; mint one that is",
      name: "FfrwdError",
      message: `this token does not authorize reading '${NAME}'`,
    });
  });

  it("keeps 'no package' for a 404 on the authorized route", async () => {
    const fake = world({ privateDetail: { status: 404, json: { error: "nope" } } });
    expect(await refusal(registry(fake).package(NAME))).toMatchObject({
      status: 404,
      error: `the registry has no package '${NAME}'`,
    });
  });
});

describe("sources out of the archive", () => {
  it("reads the recipes, the published files and the manifest", async () => {
    const fake = world();
    const sources = await registry(fake).sources(NAME, VERSION);

    expect(sources.name).toBe(NAME);
    expect(sources.version).toBe(VERSION);
    expect(sources.sha256).toBe(SHA256);
    expect(sources.recipes).toEqual({ faces: FACES });
    expect(sources.manifest?.dependencies).toEqual({ "ns/pub": "1.0.0" });

    // the manifest, every .sql, the readme and the licence -- and nothing else:
    // `notes.txt` is in the archive and is not published as text, and the two
    // directory members are skipped rather than read as files.
    expect(Object.keys(sources.files).sort()).toEqual(
      ["LICENSE", "README.md", LONG, "ffrwd.json", "recipes/faces.sql", "src/video.sql"].sort(),
    );
    // a member over one block comes back whole, and the ustar prefix is joined
    expect(README.length).toBeGreaterThan(BLOCK);
    expect(sources.files["README.md"]).toBe(README);
    expect(LONG.length).toBeGreaterThan(100);
    expect(sources.files[LONG]).toBe("-- deep\n");

    // sign, then download: the bearer goes to the first and not to the second
    expect(archiveCalls(fake)).toEqual([SIGN, SIGNED]);
    expect(fake.to(SIGN)[0]?.headers["authorization"]).toBe(`Bearer ${TOKEN}`);
    expect(fake.to(SIGNED)[0]?.headers["authorization"]).toBeUndefined();
  });

  it("hands back one recipe, its SQL read from the member its `file` names", async () => {
    const fake = world();
    const recipe = await registry(fake).recipe(NAME, "faces");
    expect(recipe.name).toBe("faces");
    expect(recipe.version).toBe(VERSION);
    expect(recipe.text).toBe(FACES);
    expect(recipe.required.map((one) => one.name)).toEqual(["source", "dest"]);
    expect(recipe.optional.map((one) => one.name)).toEqual(["conf"]);
    expect(recipe.usage).toContain("ns/secret:faces");
    // one archive for the whole call, not one per document read
    expect(archiveCalls(fake)).toEqual([SIGN, SIGNED]);
  });

  it("refuses a recipe whose file is not in the archive, naming the archive", async () => {
    expect(await refusal(registry(world()).recipe(NAME, "missing"))).toMatchObject({
      status: 0,
      error: `'${NAME}' ${VERSION} lists a recipe 'missing' its archive has no SQL for`,
    });
  });

  it("refuses a download whose digest is not the published one, unread", async () => {
    // Not a gzip stream at all: were the digest checked after the fact, the
    // refusal would be about gzip, and this asserts that it is not.
    const fake = world({ download: { body: new TextEncoder().encode("not an archive") } });
    const said = await refusal(registry(fake).sources(NAME, VERSION));
    expect(said.status).toBe(0);
    expect(said.error).toContain(
      `the archive downloaded for '${NAME}' ${VERSION} hashes to`,
    );
    expect(said.error).toContain(`not the ${SHA256} the registry published`);
    expect(said.hint).toContain("nothing was read out of it");
  });

  it("says what a 403 on the signing call means", async () => {
    const fake = world({ sign: { status: 403, json: { error: "forbidden", hint: "no" } } });
    expect(await refusal(registry(fake).sources(NAME, VERSION))).toMatchObject({
      status: 403,
      error: `this token does not authorize downloading '${NAME}' ${VERSION}`,
      hint: "the token's account is not a member of that namespace; mint one that is",
    });
    // refused at the signing call: nothing was downloaded
    expect(archiveCalls(fake)).toEqual([SIGN]);
  });
});

describe("resolve over a private package", () => {
  it("pins it like any other, with the dependencies its archived manifest names", async () => {
    const fake = world();
    const lock = await registry(fake).resolve([NAME]);

    expect(lock.dependencies).toEqual({ [NAME]: VERSION });
    expect(lock.packages.map((one) => `${one.name}@${one.version}`)).toEqual([
      "ns/pub@2.0.0",
      `${NAME}@${VERSION}`,
    ]);
    // the lock entry says nothing about the package being private: same kind,
    // same digest, same store path -- the runner signs archives by digest.
    expect(lock.packages[1]).toEqual({
      kind: "registry",
      name: NAME,
      version: VERSION,
      sha256: SHA256,
      store: `v1/${SHA256.slice(0, 2)}/${SHA256}`,
      // resolved BY NAME at the highest published version, as ever: the
      // archived manifest writes ns/pub 1.0.0 and the lock pins 2.0.0
      dependencies: { "ns/pub": "2.0.0" },
    });
    // one archive across the whole walk, and none for the public dependency
    expect(archiveCalls(fake)).toEqual([SIGN, SIGNED]);
  });

  it("downloads no archive for a public package, auth or not", async () => {
    const fake = new FakeServer();
    const document = (file: string): Record<string, unknown> =>
      JSON.parse(readFileSync(new URL(`./fixtures/${file}`, import.meta.url), "utf8")) as Record<
        string,
        unknown
      >;
    for (const name of ["faceage", "wasm", "rfdetr", "mask_tools"]) {
      fake.on("GET", `${INDEX}/p/ffrwd/${name}.json`, { json: document(`${name}.json`) });
      fake.on("GET", `${INDEX}/p/ffrwd/${name}.sources.json`, {
        json: document(`${name}.sources.json`),
      });
    }
    const lock = await registry(fake).resolve(["ffrwd/faceage"]);
    expect(lock.packages).toHaveLength(4);
    expect(archiveCalls(fake)).toEqual([]);
    // eight public documents, and not one bearer among them
    expect(fake.requests).toHaveLength(8);
    expect(fake.requests.every((one) => one.headers["authorization"] === undefined)).toBe(true);
  });
});

describe("Ffrwd's own registry", () => {
  it("is given the client's auth and api url, so a token is all a caller needs", async () => {
    const fake = world({ defaultIndex: true });
    const ffrwd = new Ffrwd({ token: TOKEN, apiUrl: API, fetch: fake.fetch });

    expect(ffrwd.registry.apiUrl).toBe(API);
    expect(ffrwd.registry.indexUrl).toBe(DEFAULT_INDEX_URL);
    expect((await ffrwd.registry.package(NAME)).name).toBe(NAME);
    expect(fake.to(PRIVATE_DETAIL)[0]?.headers["authorization"]).toBe(`Bearer ${TOKEN}`);
  });

  it("leaves a registry the caller passed exactly as it was given", async () => {
    const fake = world();
    const passed = new Registry({ indexUrl: INDEX, apiUrl: API, fetch: fake.fetch });
    const ffrwd = new Ffrwd({ token: TOKEN, apiUrl: API, fetch: fake.fetch, registry: passed });
    expect(ffrwd.registry).toBe(passed);
    // no auth was put into it, so the private package stays unreadable
    expect(await refusal(ffrwd.registry.package(NAME))).toMatchObject({ status: 404 });
    expect(fake.requests.map((one) => one.url)).toEqual([PUBLIC_DETAIL]);
  });
});
