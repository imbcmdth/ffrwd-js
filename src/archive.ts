/**
 * A published version's archive, read in memory: gunzip, then tar.
 *
 * The public index publishes a `.sources.json` beside every package, and that
 * document is where a recipe's SQL and a manifest are read from. A package
 * that is not public has no such document -- the registry writes one only for
 * public versions -- so the only place its SQL and its manifest exist is the
 * archive the version was published as. This module opens one.
 *
 * It is deliberately small. An archive is a gzip stream over a tar that the
 * publisher wrote with `tarfile` in PAX format, whose member headers are plain
 * ustar: short ASCII names, zeroed mtimes, uid/gid 0. Nothing here is a general
 * tar reader, and it is not meant to be one:
 *
 *   - only REGULAR FILES come back. A directory, a symlink, a hard link, a
 *     device, a fifo, a PAX extended header (`x`/`g`) and a GNU long-name
 *     header (`L`/`K`) are all skipped WITH their data -- which means a member
 *     whose path is too long for a ustar header (over 100 bytes, or over 255
 *     with the prefix field) is read under the truncated name in its own
 *     header, or not at all. No package this reads has one.
 *   - a size written in GNU base-256 rather than octal is refused rather than
 *     guessed at.
 *   - everything is held in memory, twice over at the peak: the compressed
 *     bytes, and what they unpack to.
 *
 * The caps below are what keeps that honest, and they are the CLI's own:
 * `MAX_ARCHIVE_BYTES` of gzip, `MAX_UNPACKED_BYTES` out of it, `MAX_MEMBERS`
 * headers walked. A package that outgrows them belongs on the sources-document
 * path, not here.
 */

import { FfrwdError, refuse } from "./errors.js";

/** At most this much gzip is downloaded for one archive. */
export const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;

/** At most this much comes out of the gunzip. */
export const MAX_UNPACKED_BYTES = 64 * 1024 * 1024;

/** At most this many member headers are walked. */
export const MAX_MEMBERS = 4096;

/** One tar block. Headers are one; data is padded to a whole number of them. */
const BLOCK = 512;

const ARCHIVE_HINT =
  "the archive is not the one this version published, or not an archive at all; " +
  "nothing was read out of it";

/**
 * `bytes` gunzipped, with a cap on what comes out.
 *
 * `DecompressionStream` does the work -- a browser, Node 18 and a Worker all
 * have it, and it is why there is no dependency here. `what` names the package
 * the archive belongs to, for the refusal.
 */
export async function gunzip(bytes: Uint8Array, what: string): Promise<Uint8Array> {
  if (typeof globalThis.DecompressionStream !== "function") {
    throw new FfrwdError({
      status: 0,
      error: "this runtime has no DecompressionStream, so an archive cannot be read",
      hint:
        "reading a private package's SQL means unpacking its archive: use Node " +
        "18 or newer, a browser, or a Worker",
    });
  }
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  const reader = (
    source.pipeThrough(
      new DecompressionStream("gzip") as unknown as ReadableWritablePair<
        Uint8Array,
        Uint8Array
      >,
    ) as ReadableStream<Uint8Array>
  ).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_UNPACKED_BYTES) {
        throw refuse(
          `the archive of '${what}' unpacks to more than ${MAX_UNPACKED_BYTES} bytes`,
          ARCHIVE_HINT,
        );
      }
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    if (error instanceof FfrwdError) throw error;
    throw refuse(`the archive of '${what}' is not a gzip stream`, ARCHIVE_HINT);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

/**
 * The regular files in the tar `bytes`, keyed by their path in the package.
 *
 * Paths are as the publisher wrote them -- relative to the package root, `/`
 * separated, e.g. `ffrwd.json`, `recipes/faces.sql`, `src/video.sql` -- with
 * the ustar `prefix` field joined back on when a header used one. Every other
 * member type is skipped; see this module's own notes for what that rules out.
 *
 * The values are VIEWS ONTO `bytes`, not copies: they stay valid as long as it
 * does, and hold no memory of their own.
 */
export function readTar(bytes: Uint8Array, what: string): Map<string, Uint8Array> {
  const members = new Map<string, Uint8Array>();
  let offset = 0;
  let walked = 0;
  let empty = 0;
  while (offset + BLOCK <= bytes.byteLength) {
    const header = bytes.subarray(offset, offset + BLOCK);
    if (isZero(header)) {
      // Two zeroed blocks end the archive; one on its own is padding to ignore.
      empty += 1;
      offset += BLOCK;
      if (empty >= 2) break;
      continue;
    }
    empty = 0;
    walked += 1;
    if (walked > MAX_MEMBERS) {
      throw refuse(
        `the archive of '${what}' holds more than ${MAX_MEMBERS} members`,
        ARCHIVE_HINT,
      );
    }
    const size = readSize(header, what);
    const start = offset + BLOCK;
    const end = start + size;
    if (end > bytes.byteLength) {
      throw refuse(
        `the archive of '${what}' ends inside a member it said was ${size} bytes`,
        ARCHIVE_HINT,
      );
    }
    // '0' is a regular file; a NUL type flag is the oldest spelling of one.
    const type = header[156] ?? 0;
    if (type === 0x30 || type === 0) {
      const name = text(header, 0, 100);
      const prefix = text(header, 345, 155);
      members.set(prefix === "" ? name : `${prefix}/${name}`, bytes.subarray(start, end));
    }
    offset = start + Math.ceil(size / BLOCK) * BLOCK;
  }
  return members;
}

/** `bytes` as text, UTF-8, however the publisher wrote it. */
export function asText(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

/** A NUL-terminated header field as a string. */
function text(header: Uint8Array, at: number, length: number): string {
  const raw = header.subarray(at, at + length);
  const end = raw.indexOf(0);
  return new TextDecoder().decode(end === -1 ? raw : raw.subarray(0, end));
}

/** The member's size: 12 bytes of octal at 124, NUL- or space-padded. */
function readSize(header: Uint8Array, what: string): number {
  // A high bit set is GNU's base-256 escape, which only an 8 GB member needs.
  if (((header[124] ?? 0) & 0x80) !== 0) {
    throw refuse(
      `the archive of '${what}' holds a member too large for this reader`,
      ARCHIVE_HINT,
    );
  }
  const written = text(header, 124, 12).trim();
  const size = written === "" ? 0 : Number.parseInt(written, 8);
  if (!Number.isSafeInteger(size) || size < 0) {
    throw refuse(
      `the archive of '${what}' has a member header without a readable size`,
      ARCHIVE_HINT,
    );
  }
  return size;
}

function isZero(block: Uint8Array): boolean {
  for (const byte of block) if (byte !== 0) return false;
  return true;
}
