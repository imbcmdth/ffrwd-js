/**
 * A live smoke test against the real API.
 *
 * Run it after a build, since it exercises what `dist/` holds:
 *
 * ```
 * npm run build && node --experimental-strip-types scripts/smoke.ts <input> <outDir>
 * ```
 *
 * Two runs of the same job go out, one after the other: `submit`, which does
 * everything, and then the three halves apart -- `prepare`, `upload` over a
 * `Prepared` that went through JSON the way a browser would get it, and
 * `ready`. Both wait for the job and take the output back, and the lines below
 * say what each did.
 *
 * The token comes from this machine's `%APPDATA%\ffrwd\credentials.json` (or
 * `~/.config/ffrwd/credentials.json`), is held only in memory, and is never
 * printed: the lines below say what happened, never what authorized it. The
 * split run's second half is the only place the token is used at all -- the
 * `upload` between them carries nothing but the signed url.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Ffrwd, Registry, upload } from "../dist/index.js";
import type { Job, JobDetail, PreparedJob, UploadProgress } from "../dist/index.js";

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

/** What one run of the job did, for the summary at the end. */
interface Run {
  what: string;
  jobId: string;
  states: string[];
  seconds: number;
  wrote: string;
  bytes: number;
}

/** Wait the job out, take `out.mp4` back, and write it as `name`. */
async function collect(
  what: string,
  job: Job,
  outDir: string,
  name: string,
  started: number,
): Promise<Run> {
  const states: string[] = [];
  const detail = await job.wait({
    intervalMs: 2000,
    onUpdate: (one: JobDetail) => {
      if (states[states.length - 1] !== one.state) {
        states.push(one.state);
        console.log(`state ${one.state}${one.progress_pct === null ? "" : ` ${one.progress_pct}%`}`);
      }
    },
  });
  const seconds = (Date.now() - started) / 1000;
  console.log(`states: ${states.join(" -> ")} in ${seconds.toFixed(1)}s`);
  console.log(`outputs: ${JSON.stringify(detail.outputs)}`);

  const blob = await job.download("out.mp4");
  const written = new Uint8Array(await blob.arrayBuffer());
  const target = join(outDir, name);
  writeFileSync(target, written);
  console.log(`wrote ${target} (${written.byteLength} bytes)`);
  return { what, jobId: job.id, states, seconds, wrote: target, bytes: written.byteLength };
}

/** The whole flow in one call: post, upload, queue. */
async function whole(ffrwd: Ffrwd, bytes: Uint8Array, outDir: string): Promise<Run> {
  console.log(`\n--- submit: everything in one call (${bytes.byteLength} bytes in) ---`);
  const started = Date.now();
  const job = await ffrwd.submit(
    { query: QUERY, inputs: { "t.mp4": bytes }, title: "ffrwd-js smoke (submit)" },
    {
      onProgress: (p: UploadProgress) => console.log(`upload ${p.path}: ${p.sent}/${p.total}`),
    },
  );
  console.log(`job ${job.id}`);
  return collect("submit", job, outDir, "out-submit.mp4", started);
}

/** The same job as three steps, with the prepared job carried over as JSON. */
async function split(ffrwd: Ffrwd, bytes: Uint8Array, outDir: string): Promise<Run> {
  console.log(`\n--- prepare + upload + ready (${bytes.byteLength} bytes in) ---`);
  const started = Date.now();

  // 1. the server's half: the size is all a prepare needs of the file.
  const prepared = await ffrwd.prepare({
    query: QUERY,
    inputs: { "t.mp4": { bytes: bytes.byteLength } },
    title: "ffrwd-js smoke (split)",
  });
  console.log(`job ${prepared.jobId}`);
  console.log(
    `prepared ${prepared.uploads.length} upload(s), outputs live ${prepared.outputsExpireDays} days`,
  );

  // 2. over the wire to the browser and back, which is what a `Prepared` has to
  // survive: plain data, and a `toJSON` that is the same shape.
  const carried = JSON.parse(JSON.stringify(prepared)) as PreparedJob;
  console.log(`through JSON: ${Object.keys(carried).join(", ")}`);

  // 3. the browser's half: one PUT per file, on the signed url alone.
  for (const ticket of carried.uploads) {
    console.log(`uploading '${ticket.path}' at index ${ticket.index} (expires ${ticket.expiresAt})`);
    await upload(ticket, bytes, {
      onProgress: (p) => console.log(`upload ${ticket.path}: ${p.sent}/${p.total}`),
    });
  }

  // 4. the server's half again: the bearer goes out here, and the job queues.
  const job = await ffrwd.ready(carried);
  return collect("prepare+upload+ready", job, outDir, "out-split.mp4", started);
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

  // 2. the same job twice, with this machine's token
  const ffrwd = new Ffrwd({ token: token() });
  const bytes = new Uint8Array(readFileSync(input));
  const runs = [await whole(ffrwd, bytes, outDir), await split(ffrwd, bytes, outDir)];

  console.log("\n--- both runs ---");
  for (const run of runs) {
    console.log(
      `${run.what}: job ${run.jobId}, ${run.states.join(" -> ")} in ${run.seconds.toFixed(1)}s, ` +
        `${run.wrote} (${run.bytes} bytes)`,
    );
  }
}

main().catch((err: unknown) => {
  const said = err as { error?: string; hint?: string; message?: string };
  console.error(`FAILED: ${said.error ?? said.message ?? String(err)}`);
  if (said.hint !== undefined) console.error(`hint: ${said.hint}`);
  process.exitCode = 1;
});
