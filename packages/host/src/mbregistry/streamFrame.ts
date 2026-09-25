/**
 * streamFrame.ts — the wire format `mbregistryStream` (ticket 003) speaks
 * once a `stream` request's `{"ok": true}` line arrives and the
 * connection permanently leaves newline-JSON framing: `[1-byte
 * type][4-byte big-endian length][payload]`. Ported field-for-field from
 * mbtools `src/mbtools/registry/stream_frame.py` (the authoritative
 * encode/decode this ticket's own Description calls out — cross-checked
 * against that module, not re-derived from doc prose alone).
 *
 * Pure encode/decode with no socket knowledge, mirroring
 * `stream_frame.py`'s own design note: {@link FrameReassembler} is fed
 * chunks as they arrive (Node's own `net.Socket` "data" event model,
 * rather than Python's blocking `read_exact`), and reports the same two
 * outcomes `stream_frame.py`'s `read_frame` does — zero or more complete
 * frames per `push()` call, or a thrown {@link FrameError} for a
 * declared length over {@link MAX_FRAME_PAYLOAD} (as soon as the
 * oversized header is seen) or a truncated frame still pending when the
 * connection ends ({@link FrameReassembler.end}).
 */

/** Sprint 003 Decision 1's five frame types — the wire values are part of
 * the protocol contract (`registry-api.md`), never renumbered. Mirrors
 * `stream_frame.py`'s `FRAME_*` constants exactly. */
export const FRAME_DATA = 0x01;
export const FRAME_BREAK = 0x02;
export const FRAME_SET_DTR = 0x03;
export const FRAME_SET_RTS = 0x04;
export const FRAME_CLOSE = 0x05;

export const FRAME_TYPES: ReadonlySet<number> = new Set([
  FRAME_DATA,
  FRAME_BREAK,
  FRAME_SET_DTR,
  FRAME_SET_RTS,
  FRAME_CLOSE,
]);

/** 1-byte type + 4-byte big-endian length — mirrors `stream_frame.py`'s
 * `HEADER_SIZE`. */
export const HEADER_SIZE = 5;

/** Mirrors `stream_frame.py`'s `MAX_FRAME_PAYLOAD` — a generous ceiling
 * that a real `DATA` frame never comes close to, small enough that a
 * corrupt/hostile declared length can never drive an unbounded
 * allocation. */
export const MAX_FRAME_PAYLOAD = 1 << 20; // 1 MiB

/** A frame could not be decoded: an oversized declared length (raised
 * the instant the header is seen), or a truncated frame still pending
 * when the connection ends. Mirrors `stream_frame.py`'s `FrameError` —
 * never raised for a well-formed frame, regardless of whether its type
 * byte is one of {@link FRAME_TYPES} (an unrecognized type is a
 * well-formed frame the caller may reject on its own terms). */
export class FrameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FrameError";
  }
}

export interface DecodedFrame {
  type: number;
  payload: Buffer;
}

/** `[1-byte type][4-byte BE length][payload]` — sprint.md Decision 1's
 * exact wire shape. `frameType` is written as-is (not validated against
 * {@link FRAME_TYPES}), mirroring `stream_frame.py`'s `encode_frame`. */
export function encodeFrame(frameType: number, payload: Buffer = Buffer.alloc(0)): Buffer {
  const header = Buffer.alloc(HEADER_SIZE);
  header.writeUInt8(frameType, 0);
  header.writeUInt32BE(payload.length, 1);
  return Buffer.concat([header, payload]);
}

/**
 * Incrementally decodes a byte stream into frames as chunks arrive.
 * `push()` returns every complete frame the newly-arrived bytes finish
 * (zero, one, or several), buffering a partial frame across calls.
 * Throws {@link FrameError} the instant a declared length exceeds
 * {@link MAX_FRAME_PAYLOAD} — that frame's bytes are never buffered
 * further. Call {@link end} when the underlying connection closes to
 * detect a frame left truncated by that close.
 */
export class FrameReassembler {
  private buffer: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): DecodedFrame[] {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    const frames: DecodedFrame[] = [];
    for (;;) {
      if (this.buffer.length < HEADER_SIZE) {
        break;
      }
      const type = this.buffer.readUInt8(0);
      const length = this.buffer.readUInt32BE(1);
      if (length > MAX_FRAME_PAYLOAD) {
        // Nothing left worth buffering -- the caller is expected to tear
        // the connection down on this error, mirroring the server's own
        // "logs it and tears the connection down" handling.
        this.buffer = Buffer.alloc(0);
        throw new FrameError(`declared frame length ${length} exceeds the ${MAX_FRAME_PAYLOAD}-byte limit`);
      }
      if (this.buffer.length < HEADER_SIZE + length) {
        break; // wait for more bytes
      }
      const payload = this.buffer.subarray(HEADER_SIZE, HEADER_SIZE + length);
      this.buffer = this.buffer.subarray(HEADER_SIZE + length);
      frames.push({ type, payload: Buffer.from(payload) });
    }
    return frames;
  }

  /** Call once the underlying connection has closed. Throws {@link
   * FrameError} if a partial frame (header or payload) is still
   * pending — the ordinary way a stream session ends cleanly is with no
   * bytes left buffered at all. */
  end(): void {
    if (this.buffer.length > 0) {
      const pending = this.buffer.length;
      this.buffer = Buffer.alloc(0);
      throw new FrameError(`truncated frame: ${pending} byte(s) pending when the connection closed`);
    }
  }
}
