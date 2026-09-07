import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { LocalHexUploadManager, MAX_UPLOAD_BYTE_LENGTH } from "./localHexUpload.js";
import { UPLOAD_ID_BYTE_LENGTH } from "./wsMessages.js";

// Per the ticket's Testing section: pure buffer/hash logic, exercised in
// complete isolation -- no WebSocket, no DeviceRegistry, no real
// hardware or network.

function frameFor(uploadId: string, payload: Buffer): Buffer {
  return Buffer.concat([Buffer.from(uploadId, "ascii"), payload]);
}

function sha256Of(payload: Buffer): string {
  return createHash("sha256").update(payload).digest("hex");
}

describe("LocalHexUploadManager.beginUpload", () => {
  it("rejects a byteLength over the 4MB cap before allocating any buffer", () => {
    const manager = new LocalHexUploadManager();
    const allocSpy = vi.spyOn(Buffer, "alloc");
    const allocUnsafeSpy = vi.spyOn(Buffer, "allocUnsafe");

    const result = manager.beginUpload({
      fileName: "huge.hex",
      byteLength: MAX_UPLOAD_BYTE_LENGTH + 1,
      sha256: "a".repeat(64),
    });

    expect(result).toEqual({ error: expect.stringContaining("too large") });
    expect(allocSpy).not.toHaveBeenCalled();
    expect(allocUnsafeSpy).not.toHaveBeenCalled();

    allocSpy.mockRestore();
    allocUnsafeSpy.mockRestore();
  });

  it("accepts a byteLength at exactly the 4MB cap and mints a fresh uploadId", () => {
    const manager = new LocalHexUploadManager();
    const result = manager.beginUpload({
      fileName: "at-cap.hex",
      byteLength: MAX_UPLOAD_BYTE_LENGTH,
      sha256: "b".repeat(64),
    });

    expect("uploadId" in result).toBe(true);
    if ("uploadId" in result) {
      expect(result.uploadId).toHaveLength(UPLOAD_ID_BYTE_LENGTH);
    }
  });

  it("mints a distinct uploadId on every call", () => {
    const manager = new LocalHexUploadManager();
    const first = manager.beginUpload({ fileName: "a.hex", byteLength: 10, sha256: "c".repeat(64) });
    const second = manager.beginUpload({ fileName: "b.hex", byteLength: 10, sha256: "c".repeat(64) });

    expect("uploadId" in first && "uploadId" in second).toBe(true);
    if ("uploadId" in first && "uploadId" in second) {
      expect(first.uploadId).not.toBe(second.uploadId);
    }
  });
});

describe("LocalHexUploadManager.receiveFrame / consumeUpload", () => {
  it("splits a well-formed frame, verifies length and sha256, and consumeUpload returns the bytes exactly once", () => {
    const manager = new LocalHexUploadManager();
    const payload = Buffer.from(":00000001FF\n", "utf-8");
    const begun = manager.beginUpload({
      fileName: "MICROBIT.hex",
      byteLength: payload.length,
      sha256: sha256Of(payload),
    });
    expect("uploadId" in begun).toBe(true);
    if (!("uploadId" in begun)) {
      return;
    }

    const result = manager.receiveFrame(frameFor(begun.uploadId, payload));
    expect(result).toEqual({ uploadId: begun.uploadId, verified: payload });

    const consumed = manager.consumeUpload(begun.uploadId);
    expect(consumed).toEqual(payload);

    // Consumed exactly once -- a second call for the same uploadId
    // returns undefined, preventing replay into a second flash without
    // a fresh flash-local-begin.
    expect(manager.consumeUpload(begun.uploadId)).toBeUndefined();
  });

  it("a length mismatch returns an error and discards the pending upload", () => {
    const manager = new LocalHexUploadManager();
    const payload = Buffer.from(":00000001FF\n", "utf-8");
    const begun = manager.beginUpload({
      fileName: "MICROBIT.hex",
      byteLength: payload.length + 5, // declared longer than what's sent
      sha256: sha256Of(payload),
    });
    expect("uploadId" in begun).toBe(true);
    if (!("uploadId" in begun)) {
      return;
    }

    const result = manager.receiveFrame(frameFor(begun.uploadId, payload));
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toContain("declared");
    }

    expect(manager.consumeUpload(begun.uploadId)).toBeUndefined();
  });

  it("a sha256 mismatch returns an error and discards the pending upload", () => {
    const manager = new LocalHexUploadManager();
    const payload = Buffer.from(":00000001FF\n", "utf-8");
    const begun = manager.beginUpload({
      fileName: "MICROBIT.hex",
      byteLength: payload.length,
      sha256: "0".repeat(64), // wrong hash
    });
    expect("uploadId" in begun).toBe(true);
    if (!("uploadId" in begun)) {
      return;
    }

    const result = manager.receiveFrame(frameFor(begun.uploadId, payload));
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toContain("sha256 mismatch");
    }

    expect(manager.consumeUpload(begun.uploadId)).toBeUndefined();
  });

  it("an unknown uploadId prefix returns an error", () => {
    const manager = new LocalHexUploadManager();
    const payload = Buffer.from(":00000001FF\n", "utf-8");
    const fakeUploadId = "00000000-0000-0000-0000-000000000000";
    expect(fakeUploadId).toHaveLength(UPLOAD_ID_BYTE_LENGTH);

    const result = manager.receiveFrame(frameFor(fakeUploadId, payload));
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toContain("unknown");
    }
  });

  it("a frame shorter than the uploadId prefix returns an error rather than throwing", () => {
    const manager = new LocalHexUploadManager();
    const result = manager.receiveFrame(Buffer.from("too-short", "ascii"));
    expect("error" in result).toBe(true);
  });

  it("receiveFrame for an already-consumed uploadId (no fresh flash-local-begin) returns an error", () => {
    const manager = new LocalHexUploadManager();
    const payload = Buffer.from(":00000001FF\n", "utf-8");
    const begun = manager.beginUpload({
      fileName: "MICROBIT.hex",
      byteLength: payload.length,
      sha256: sha256Of(payload),
    });
    expect("uploadId" in begun).toBe(true);
    if (!("uploadId" in begun)) {
      return;
    }

    // First frame succeeds and consumes the pending entry.
    expect("verified" in manager.receiveFrame(frameFor(begun.uploadId, payload))).toBe(true);

    // A second binary frame reusing the same uploadId, with no new
    // flash-local-begin, finds no pending upload left to verify against.
    const second = manager.receiveFrame(frameFor(begun.uploadId, payload));
    expect("error" in second).toBe(true);
  });
});

describe("LocalHexUploadManager.consumeUpload", () => {
  it("returns undefined for an uploadId that was never begun", () => {
    const manager = new LocalHexUploadManager();
    expect(manager.consumeUpload("never-begun-id-000000000000000000")).toBeUndefined();
  });
});
