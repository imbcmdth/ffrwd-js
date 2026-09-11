/**
 * A live smoke test against the real API.
 *
 * Run it after a build, since it exercises what `dist/` holds:
 *
 * ```
 * npm run build && node --experimental-strip-types scripts/smoke.ts <input> <outDir>
 * ```
 *
 * The token comes from this machine's `%APPDATA%\ffrwd\credentials.json` (or
 * `~/.config/ffrwd/credentials.json`), is held only in memory, and is never
 * printed: the lines below say what happened, never what authorized it.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Ffrwd, Registry } from "../dist/index.js";
import type { JobDetail, UploadProgress } from "../dist/index.js";

const QUERY = "COPY (SELECT f.video[1] FROM input('t.mp4') f) TO 'out.mp4'";

function credentialsPath(): string {
  const appData = process.env["APPDATA"];
  if (appData !== undefined && appData !== "") return join(appData, "ffrwd", "credentials.json");
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

async function main(): Promise<void> {
  const input = process.argv[2];
  const outDir = process.argv[3];
  if (input === undefined || outDir === undefined) {
    throw new Error("usage: smoke.ts <input t.mp4> <output directory>");
  }

  // 1. the registry, unauthenticated
  const registry = new Registry();
  const lock = await registry.resolve(["ffrwd/faceage"]);
  console.log("--- registry.resolve(['ffrwd/faceage']) ---");
  console.log(lock.text.trimEnd());

  // 2. a job, with this machine's token
  const ffrwd = new Ffrwd({ token: token() });
  const bytes = new Uint8Array(readFileSync(input));
  console.log(`\n--- submitting (${bytes.byteLength} bytes in) ---`);
  const started = Date.now();
  const job = await ffrwd.submit(
    { query: QUERY, inputs: { "t.mp4": bytes }, title: "ffrwd-js smoke" },
    {
      onProgress: (p: UploadProgress) =>
        console.log(`upload ${p.path}: ${p.sent}/${p.total}`),
    },
  );
  console.log(`job ${job.id}`);

  const seen: string[] = [];
  const detail = await job.wait({
    intervalMs: 2000,
    onUpdate: (one: JobDetail) => {
      if (seen[seen.length - 1] !== one.state) {
        seen.push(one.state);
        console.log(`state ${one.state}${one.progress_pct === null ? "" : ` ${one.progress_pct}%`}`);
      }
    },
  });
  console.log(`states: ${seen.join(" -> ")} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  console.log(`outputs: ${JSON.stringify(detail.outputs)}`);

  // 3. the bytes back
  const blob = await job.download("out.mp4");
  const written = new Uint8Array(await blob.arrayBuffer());
  const target = join(outDir, "out.mp4");
  writeFileSync(target, written);
  console.log(`wrote ${target} (${written.byteLength} bytes)`);
}

main().catch((err: unknown) => {
  const said = err as { error?: string; hint?: string; message?: string };
  console.error(`FAILED: ${said.error ?? said.message ?? String(err)}`);
  if (said.hint !== undefined) console.error(`hint: ${said.hint}`);
  process.exitCode = 1;
});
