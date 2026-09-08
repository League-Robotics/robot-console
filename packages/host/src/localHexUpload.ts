/**
 * localHexUpload.ts — the in-memory server side of the local-hex upload
 * handshake documented in `wsMessages.ts`'s module doc comment (the
 * `flash-local-begin` -> `flash-local-ready` -> one binary WebSocket
 * frame -> verify sequence). This is the concrete implementation of the
 * convention `wsMessages.ts` freezes near {@link UPLOAD_ID_BYTE_LENGTH};
 * that module only documents the wire shape, this module is what
 * actually splits a frame, verifies it, and holds the bytes.
 *
 * ## Why this exists (`sprint.md`'s Design Rationale)
 *
 * The stakeholder wanted a "flash it with some other hex file off the
 * disk" affordance, which this sprint also adopted as the agreed
 * substitute for a calibration-firmware slot (no calibration hex exists
 * yet — `specification.md` §9 Q1). A browser file input sends its bytes
 * as one binary WebSocket frame rather than base64-encoded JSON — a
 * universal hex is ~1.8MB of ASCII text and base64 would inflate that
 * further inside a JSON message for no benefit.
 *
 * ## In memory only — never a temp file
 *
 * Nothing in this codebase writes to disk today except `flash.ts`'s MSD
 * fallback (writing the already-verified hex onto a mounted MICROBIT
 * volume, which is the point of that write). A local-hex upload's bytes
 * are held as a plain in-process `Buffer`, keyed by `uploadId`, and
 * never touch the filesystem — a stray temp hex left behind by a crashed
 * process would be a needless cleanup liability this module avoids
 * entirely.
 *
 * ## One class instance per running server, not a module-level singleton
 *
 * `server.ts` constructs one {@link LocalHexUploadManager} per
 * {@link startServer} call (mirroring how it constructs one
 * `DeviceRegistry`/`FirmwareAvailabilityCache` per call) and shares that
 * one instance between its own WebSocket message handling (`beginUpload`/
 * `receiveFrame`) and the `DeviceRegistry`'s injected `consumeUpload`
 * seam — see `deviceRegistry.ts`'s `DeviceRegistryOptions.consumeUpload`.
 * A module-level singleton would leak pending/verified uploads across
 * independent server instances in tests and would give two servers
 * running in the same process (not a real deployment shape, but a test
 * one) a shared, colliding `uploadId` space.
 *
 * ## Verification, not trust
 *
 * `beginUpload` records what the client *claims* about the file it is
 * about to send (`byteLength`, `sha256`) without touching any bytes yet;
 * `receiveFrame` is the one place those claims are checked against the
 * bytes that actually arrived. A mismatch on either axis discards the
 * pending upload outright (never partially trusted) and reports an
 * error — the same "failure is a value" precedent `releases.ts` and
 * `flash.ts` already follow, just via a plain result object instead of
 * a thrown exception (this module has no async I/O of its own, so there
 * is nothing to `await`, but the "always come back with a clear
 * classified result" shape carries over regardless).
 *
 * ## Single-use uploads
 *
 * `consumeUpload` returns and removes the verified bytes so the same
 * `uploadId` can never be replayed into two flashes without a fresh
 * `flash-local-begin` round trip — the ticket's own "consumed exactly
 * once" requirement. There is deliberately no expiry timer on a pending
 * or verified upload beyond that single consumption: this class is
 * loop-free, holding at most a handful of small (<=4MB) buffers for the
 * life of one local dev/classroom session, so an unbounded-but-tiny map
 * is an acceptable tradeoff against the complexity of a timer-based
 * eviction policy that has no real caller yet.
 */

import { createHash, randomUUID } from "node:crypto";
import { UPLOAD_ID_BYTE_LENGTH } from "./wsMessages.js";

/** Hard cap on an uploaded file's declared size, per `sprint.md`'s
 * local-hex design (a universal hex is ~1.8MB; this leaves generous
 * headroom while still rejecting anything wildly out of range before a
 * single byte of the binary frame is ever read). Enforced by
 * {@link LocalHexUploadManager.beginUpload} *before* any buffer for the
 * upload is allocated -- see that method's own doc comment. */
export const MAX_UPLOAD_BYTE_LENGTH = 4 * 1024 * 1024;

/** What the client declares in a `flash-local-begin` message, before any
 * bytes are sent -- mirrors `wsMessages.ts`'s `FlashLocalBeginMessage`
 * minus its `type` discriminant. */
export interface BeginUploadRequest {
  fileName: string;
  byteLength: number;
  sha256: string;
}

export type BeginUploadResult = { uploadId: string } | { error: string };

/** Result of splitting and verifying one binary WebSocket frame against
 * whatever {@link LocalHexUploadManager.beginUpload} recorded for its
 * `uploadId` prefix. */
export type ReceiveFrameResult = { uploadId: string; verified: Buffer } | { error: string };

/** What {@link LocalHexUploadManager.beginUpload} records about a
 * pending upload -- the client's claims, not yet verified against any
 * bytes. */
interface PendingUpload {
  byteLength: number;
  sha256: string;
}

/**
 * Holds the server side of one running server's local-hex upload
 * handshake: pending uploads awaiting their binary frame, and verified
 * uploads awaiting a `flash-start` to consume them. See the module doc
 * comment for the full design rationale.
 */
export class LocalHexUploadManager {
  private readonly pending = new Map<string, PendingUpload>();
  private readonly verified = new Map<string, Buffer>();

  /**
   * Begin a local-hex upload: reject a `byteLength` over
   * {@link MAX_UPLOAD_BYTE_LENGTH} before doing anything else --
   * deliberately the very first check in this method, and one that
   * never allocates a `Buffer` of any size for the rejected request (the
   * rejected size is only ever compared as a number, never passed to
   * `Buffer.alloc`/`Buffer.allocUnsafe` or read from). On success, mints
   * a fresh `uploadId` via `crypto.randomUUID()` (36 ASCII characters,
   * matching `wsMessages.ts`'s {@link UPLOAD_ID_BYTE_LENGTH}) and
   * records `byteLength`/`sha256` for {@link receiveFrame} to verify the
   * eventual binary frame against.
   */
  beginUpload(request: BeginUploadRequest): BeginUploadResult {
    if (request.byteLength > MAX_UPLOAD_BYTE_LENGTH) {
      return {
        error:
          `file is too large to upload: ${request.byteLength} bytes exceeds the ` +
          `${MAX_UPLOAD_BYTE_LENGTH}-byte limit`,
      };
    }
    const uploadId = randomUUID();
    this.pending.set(uploadId, {
      byteLength: request.byteLength,
      sha256: request.sha256.toLowerCase(),
    });
    return { uploadId };
  }

  /**
   * Split one binary WebSocket frame into its
   * {@link UPLOAD_ID_BYTE_LENGTH}-byte ASCII `uploadId` prefix and
   * payload (per `wsMessages.ts`'s module doc comment: no length prefix
   * or delimiter -- the frame boundary *is* the message boundary), look
   * up the pending upload that `uploadId` names, and verify the
   * payload's actual length and sha256 against what {@link beginUpload}
   * recorded.
   *
   * The pending upload is discarded (removed from the pending map)
   * whether verification succeeds or fails -- a frame is consumed
   * exactly once against a given `beginUpload` call, matching/
   * mismatching. On success the verified bytes are stored for a later
   * {@link consumeUpload}. On a length or hash mismatch, or an unknown/
   * already-consumed `uploadId`, nothing is stored -- a subsequent
   * {@link consumeUpload} for that id returns `undefined`, and the
   * client must start over with a fresh `flash-local-begin`.
   */
  receiveFrame(frame: Buffer): ReceiveFrameResult {
    if (frame.length < UPLOAD_ID_BYTE_LENGTH) {
      return {
        error: `binary frame (${frame.length} bytes) is shorter than the ${UPLOAD_ID_BYTE_LENGTH}-byte upload id prefix`,
      };
    }

    const uploadId = frame.subarray(0, UPLOAD_ID_BYTE_LENGTH).toString("ascii");
    const payload = frame.subarray(UPLOAD_ID_BYTE_LENGTH);

    const pending = this.pending.get(uploadId);
    if (!pending) {
      return { error: `unknown or already-used upload id: ${uploadId}` };
    }
    // Consumed exactly once from here on, regardless of outcome -- see
    // this method's own doc comment.
    this.pending.delete(uploadId);

    if (payload.length !== pending.byteLength) {
      return {
        error:
          `uploaded payload is ${payload.length} bytes, but flash-local-begin declared ` +
          `${pending.byteLength} bytes`,
      };
    }

    const actualSha256 = createHash("sha256").update(payload).digest("hex");
    if (actualSha256 !== pending.sha256) {
      return {
        error: `sha256 mismatch: flash-local-begin declared ${pending.sha256}, uploaded bytes hash to ${actualSha256}`,
      };
    }

    this.verified.set(uploadId, payload);
    return { uploadId, verified: payload };
  }

  /**
   * Return and remove a previously verified upload's bytes -- consumed
   * exactly once, by the matching `flash-start`. `undefined` for an
   * unknown, never-verified, or already-consumed `uploadId`; this is a
   * normal, expected result for `deviceRegistry.ts#runFlash` to turn
   * into a `flash-result` error, never a reason to throw.
   */
  consumeUpload(uploadId: string): Buffer | undefined {
    const bytes = this.verified.get(uploadId);
    this.verified.delete(uploadId);
    return bytes;
  }
}
