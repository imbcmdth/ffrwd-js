/**
 * The two ways a caller hands this library bytes, and the digest a download is
 * checked against.
 *
 * Nothing on the upload side is hashed: an input is declared by its size and
 * its position, and the transfer itself is what says the bytes arrived whole.
 */

import { FfrwdError } from "./errors.js";

/** Bytes a caller can give as an input: a `Blob` (or `File`) or a `Uint8Array`. */
export type Bytes = Blob | Uint8Array;

/** True when `value` is bytes rather than a `{url}` the runner is to open. */
export function isBytes(value: unknown): value is Bytes {
  return (
    value instanceof Uint8Array ||
    (typeof Blob !== "undefined" && value instanceof Blob)
  );
}

/** How many bytes `value` is. */
export function byteLength(value: Bytes): number {
  return value instanceof Uint8Array ? value.byteLength : value.size;
}

/**
 * `value`'s SHA-256, as 64 lowercase hex characters.
 *
 * What `Job.download` checks an output against: the job records a digest for
 * everything a run wrote, and the bytes that come back are hashed here before
 * they are handed on. No input is ever hashed -- an upload is keyed by the
 * input's position, not by its content.
 *
 * MEMORY: the whole value is held in one contiguous buffer to be hashed --
 * `crypto.subtle.digest` has no streaming form, and a `Blob` is read into an
 * `ArrayBuffer` first. That is fine for the size class the job API writes an
 * output in, but it does mean a 2 GB download needs 2 GB of heap for as long as
 * the digest takes.
 */
export async function sha256Hex(value: Bytes): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined) {
    throw new FfrwdError({
      status: 0,
      error: "this runtime has no crypto.subtle, so these bytes cannot be hashed",
      hint:
        "a download is checked against the digest the job recorded: use Node 18 " +
        "or newer, or a browser page served over https (crypto.subtle is not " +
        "exposed to an insecure origin)",
    });
  }
  // The view itself, offset and length included -- never `value.buffer`, which
  // for a Node `Buffer` is a shared pool holding far more than these bytes.
  const data =
    value instanceof Uint8Array ? value : new Uint8Array(await value.arrayBuffer());
  // The cast is over `Uint8Array<ArrayBufferLike>` vs `<ArrayBuffer>` alone:
  // WebCrypto reads any byte view, and a SharedArrayBuffer-backed one hashes
  // the same as any other.
  const digest = await subtle.digest("SHA-256", data as unknown as BufferSource);
  return hex(new Uint8Array(digest));
}

/** Bytes as lowercase hex. */
export function hex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}
