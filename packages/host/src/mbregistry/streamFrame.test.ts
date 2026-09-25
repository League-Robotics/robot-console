/**
 * streamFrame.test.ts — sprint 018 ticket 003's frame-codec suite,
 * mirroring mbtools `tests/registry/test_stream_frame.py`'s own test
 * vectors where feasible (per the ticket's Testing plan), adapted for
 * this module's incremental, chunk-fed {@link FrameReassembler} rather
 * than Python's blocking `read_exact`.
 */
import { describe, expect, it } from "vitest";
import {
  FRAME_BREAK,
  FRAME_CLOSE,
  FRAME_DATA,
  FRAME_SET_DTR,
  FRAME_SET_RTS,
  FRAME_TYPES,
  FrameError,
  FrameReassembler,
  HEADER_SIZE,
  MAX_FRAME_PAYLOAD,
  encodeFrame,
} from "./streamFrame.js";

describe("encodeFrame / FrameReassembler -- round trip, every type", () => {
  it.each([
    [FRAME_DATA, Buffer.from("hello world")],
    [FRAME_DATA, Buffer.alloc(0)],
    [FRAME_BREAK, Buffer.alloc(0)],
    [FRAME_SET_DTR, Buffer.from([0x01])],
    [FRAME_SET_DTR, Buffer.from([0x00])],
    [FRAME_SET_RTS, Buffer.from([0x01])],
    [FRAME_SET_RTS, Buffer.from([0x00])],
    [FRAME_CLOSE, Buffer.alloc(0)],
  ])("round-trips frame type 0x%s", (frameType, payload) => {
    const wire = encodeFrame(frameType, payload);
    expect(wire[0]).toBe(frameType);
    expect(wire.readUInt32BE(1)).toBe(payload.length);
    expect(wire.subarray(HEADER_SIZE)).toEqual(payload);

    const reassembler = new FrameReassembler();
    const [decoded] = reassembler.push(wire);
    expect(decoded).toEqual({ type: frameType, payload });
  });

  it("FRAME_TYPES matches sprint.md Decision 1's five wire values", () => {
    expect(FRAME_TYPES).toEqual(new Set([FRAME_DATA, FRAME_BREAK, FRAME_SET_DTR, FRAME_SET_RTS, FRAME_CLOSE]));
    expect(FRAME_DATA).toBe(0x01);
    expect(FRAME_BREAK).toBe(0x02);
    expect(FRAME_SET_DTR).toBe(0x03);
    expect(FRAME_SET_RTS).toBe(0x04);
    expect(FRAME_CLOSE).toBe(0x05);
  });

  it("HEADER_SIZE is five bytes", () => {
    expect(HEADER_SIZE).toBe(5);
  });

  it("decodes multiple frames back to back from one push()", () => {
    const wire = Buffer.concat([encodeFrame(FRAME_DATA, Buffer.from("one")), encodeFrame(FRAME_DATA, Buffer.from("two"))]);
    const reassembler = new FrameReassembler();
    const frames = reassembler.push(wire);
    expect(frames).toEqual([
      { type: FRAME_DATA, payload: Buffer.from("one") },
      { type: FRAME_DATA, payload: Buffer.from("two") },
    ]);
  });

  it("decodes a frame split across multiple push() calls", () => {
    const wire = encodeFrame(FRAME_DATA, Buffer.from("split-payload"));
    const reassembler = new FrameReassembler();
    expect(reassembler.push(wire.subarray(0, 3))).toEqual([]);
    expect(reassembler.push(wire.subarray(3, 7))).toEqual([]);
    expect(reassembler.push(wire.subarray(7))).toEqual([{ type: FRAME_DATA, payload: Buffer.from("split-payload") }]);
  });
});

describe("FrameReassembler -- boundary / fuzz cases (ticket 007's own acceptance criterion)", () => {
  it("a clean close with nothing buffered is not an error", () => {
    const reassembler = new FrameReassembler();
    expect(() => reassembler.end()).not.toThrow();
  });

  it("a truncated header pending at close raises FrameError", () => {
    const wire = encodeFrame(FRAME_DATA, Buffer.from("payload"));
    const reassembler = new FrameReassembler();
    expect(reassembler.push(wire.subarray(0, 3))).toEqual([]); // only 3 of 5 header bytes
    expect(() => reassembler.end()).toThrow(FrameError);
  });

  it("a truncated payload pending at close raises FrameError", () => {
    const wire = encodeFrame(FRAME_DATA, Buffer.from("payload"));
    const reassembler = new FrameReassembler();
    expect(reassembler.push(wire.subarray(0, 7))).toEqual([]); // full header, short payload
    expect(() => reassembler.end()).toThrow(FrameError);
  });

  it("a zero-length DATA frame decodes to an empty payload, not an error", () => {
    const wire = encodeFrame(FRAME_DATA, Buffer.alloc(0));
    const reassembler = new FrameReassembler();
    expect(reassembler.push(wire)).toEqual([{ type: FRAME_DATA, payload: Buffer.alloc(0) }]);
  });

  it("an oversized declared length raises FrameError from the header alone, never buffering the bogus payload", () => {
    const header = Buffer.concat([Buffer.from([FRAME_DATA]), Buffer.alloc(4)]);
    header.writeUInt32BE(MAX_FRAME_PAYLOAD + 1, 1);
    const reassembler = new FrameReassembler();
    expect(() => reassembler.push(header)).toThrow(FrameError);
    // A subsequent close is clean -- the malformed header's bytes were
    // discarded, not left pending as a "truncated frame".
    expect(() => reassembler.end()).not.toThrow();
  });

  it("a declared length exactly at the limit is accepted", () => {
    const payload = Buffer.alloc(MAX_FRAME_PAYLOAD, "x");
    const wire = encodeFrame(FRAME_DATA, payload);
    const reassembler = new FrameReassembler();
    expect(reassembler.push(wire)).toEqual([{ type: FRAME_DATA, payload }]);
  });

  it("an unrecognized frame type still decodes cleanly -- rejecting it is the caller's job", () => {
    const wire = Buffer.concat([Buffer.from([0xff]), Buffer.alloc(4)]);
    const reassembler = new FrameReassembler();
    expect(reassembler.push(wire)).toEqual([{ type: 0xff, payload: Buffer.alloc(0) }]);
  });
});
