/**
 * A live check of the private path, against the real API.
 *
 * Run it after a build, since it exercises what `dist/` holds:
 *
 * ```
 * npm run build && node --experimental-strip-types scripts/private.ts
 * ```
 *
 * Three things, in order: one recipe out of a private package -- which is the
 * authorized detail route and then the archive -- the lock that package
 * resolves to, and a public package resolved beside it to show that the cheap
 * path is untouched. Every request is counted, so the last of those can assert
 * what matters most: a public resolve downloads NO archive.
 *
 * The token comes from this machine's `%APPDATA%\ffrwd\credentials.json` (or
 * `~/.config/ffrwd/credentials.json`), is held only in memory, and is never
 * printed.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Ffrwd } from "../dist/index.js";

/** The private package this checks, and the recipe in it. */
const PACKAGE = "ffrwd/censor";
const RECIPE = "faces";
/** A public package, for the comparison. */
const PUBLIC = "ffrwd/faceage";

function credentialsPath(): string {
  const appData = process.env["APPDATA"];
  if (appData !== undefined && appData !== "") {
    return join(appData, "ffrwd", "credentials.json");
  }
  return join(homedir(), ".config", "ffrwd", "credentials.json");
}

function token(): string {
  const path = credentialsPath();
  const held = JSON.parse(readFileSync(path, "utf8")) as { token?: string };
  if (typeof held.token !== "string" || held.token === "") {
    throw new Error(`${path} holds no token`);
  }
  return held.token;
}

/** Every url asked for, in order, with the archive calls easy to pick out. */
const asked: string[] = [];

function counting(): typeof fetch {
  const platform = globalThis.fetch.bind(globalThis);
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    asked.push(typeof input === "string" ? input : input.toString());
    return platform(input, init);
  }) as typeof fetch;
}

/** The urls asked for since `from`, shortened to the part worth reading. */
function since(from: number): string[] {
  return asked.slice(from).map((url) => url.replace(/\?.*$/, "").replace(/^https:\/\//, ""));
}

function archives(from: number): string[] {
  return since(from).filter((url) => url.includes("/archive/") || url.includes("/archives/"));
}

async function main(): Promise<void> {
  // A token and nothing else: the default registry is given this client's own
  // authorization, so the private package reads with no further setup.
  const ffrwd = new Ffrwd({ token: token(), fetch: counting() });
  const registry = ffrwd.registry;

  console.log(`--- registry.recipe('${PACKAGE}', '${RECIPE}') ---`);
  let mark = asked.length;
  const recipe = await registry.recipe(PACKAGE, RECIPE);
  console.log(`version: ${recipe.version}`);
  console.log(`required: ${recipe.required.map((one) => one.name).join(", ") || "(none)"}`);
  console.log(`optional: ${recipe.optional.map((one) => one.name).join(", ") || "(none)"}`);
  console.log(`usage: ${recipe.usage}`);
  console.log(`SQL: ${recipe.text.length} bytes, first line: ${recipe.text.split("\n")[0]}`);
  for (const url of since(mark)) console.log(`  asked ${url}`);

  console.log(`\n--- registry.resolve(['${PACKAGE}']) ---`);
  mark = asked.length;
  const lock = await registry.resolve([PACKAGE]);
  for (const entry of lock.packages) {
    console.log(`  ${entry.name} ${entry.version}  ${entry.store}`);
  }
  console.log(`dependencies: ${JSON.stringify(lock.dependencies)}`);
  console.log(`archive calls: ${archives(mark).length}`);
  for (const url of since(mark)) console.log(`  asked ${url}`);

  console.log(`\n--- registry.resolve(['${PUBLIC}']), the public path ---`);
  mark = asked.length;
  const publicLock = await registry.resolve([PUBLIC]);
  for (const entry of publicLock.packages) {
    console.log(`  ${entry.name} ${entry.version}`);
  }
  const fetched = since(mark).length;
  const downloaded = archives(mark);
  console.log(`fetches: ${fetched}, archive calls: ${downloaded.length}`);
  if (downloaded.length > 0) {
    throw new Error(`a public resolve downloaded an archive: ${downloaded.join(", ")}`);
  }
  console.log("the public path downloads no archive: as it was");
}

main().catch((err: unknown) => {
  const said = err as { error?: string; hint?: string; message?: string };
  console.error(`FAILED: ${said.error ?? said.message ?? String(err)}`);
  if (said.hint !== undefined) console.error(`hint: ${said.hint}`);
  process.exitCode = 1;
});
