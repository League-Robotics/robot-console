---
id: '005'
title: 'Local-hex upload path: binary frame handshake and in-memory flash source'
status: open
use-cases: ["SUC-003"]
depends-on: ["004"]
github-issue: ''
issue: robot-console-two-level-ui-and-multi-transport-roadmap.md
completes_issue: false
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Local-hex upload path: binary frame handshake and in-memory flash source

## Description

Implement the local-hex-from-disk flash affordance's host-side
plumbing: the `flash-local-begin` → `flash-local-ready` → binary frame
→ verify handshake, holding the verified bytes in memory only (never a
temp file), and wire the result into `runFlash` as a second
`FirmwareSourceRef` branch alongside the existing `release` path.

**New `packages/host/src/localHexUpload.ts`:**
- `beginUpload({ fileName, byteLength, sha256 }): { uploadId } | { error: string }`
  — rejects (before allocating anything) if `byteLength` exceeds 4MB;
  generates a fresh `uploadId` (`crypto.randomUUID()`, 36 ASCII chars —
  matches `wsMessages.ts`'s `UPLOAD_ID_BYTE_LENGTH`) and records the
  expected `byteLength`/`sha256` for later verification.
- `receiveFrame(frame: Buffer): { uploadId: string; verified: Buffer } | { error: string }`
  — splits `frame` into its `UPLOAD_ID_BYTE_LENGTH`-byte `uploadId`
  prefix and payload; looks up the pending upload; verifies the
  payload's actual length and sha256 against what `beginUpload`
  recorded; on success stores the verified `Buffer` and returns it; on
  mismatch, discards the pending upload and returns an error.
- `consumeUpload(uploadId: string): Buffer | undefined` — returns and
  removes a previously verified upload's bytes (consumed exactly once,
  by the matching `flash-start`).

**`server.ts`:** add an `isBinary` branch in the `ws.on("message", ...)`
handler (today's handler does `data.toString()` unconditionally) —
binary frames go to `localHexUpload.receiveFrame`, everything else goes
through the existing `JSON.parse`/`parseClientMessage` path exactly as
today. Handle `flash-local-begin` (call `beginUpload`, reply
`flash-local-ready` or an `error` message) the same composition-only
way every other message type is handled.

**`deviceRegistry.ts`'s `runFlash`:** branch once on
`source.kind` — `"release"` keeps today's `resolveRelease` +
`fetchAndVerifyHex` path unchanged; `"local-hex"` calls
`consumeUpload(source.uploadId)` instead (an upload not found is a
flash-start error, not a crash). From the resulting hex bytes onward
(`isUniversalHex`/`extractV2Hex`/`isValidIntelHexText`/`flashOverSwd`/
`flashViaMsd` in `flash.ts`), the pipeline is **completely unchanged**
— `flash.ts` itself is not modified by this ticket. The "warn, don't
block" behavior for a hex that parses but isn't confirmed v2 already
exists in `flash.ts` implicitly (nothing there currently rejects a
non-v2-but-valid hex); this ticket's job is only to surface that as a
**warning in the UI copy**, not to add a new host-side check — verify
`isValidIntelHexText`'s existing behavior already permits this and
does not need modification.

## Acceptance Criteria

- [ ] `beginUpload` rejects a `byteLength` over 4MB with a clear error
      **before** allocating any buffer (assert no `Buffer` is
      allocated for the rejected size — e.g. via a spy/counter, not
      just that the function returns an error).
- [ ] `receiveFrame` correctly splits `uploadId`/payload for a
      well-formed frame, and verifies length and sha256; a
      length or hash mismatch returns an error and the upload is
      discarded (a subsequent `consumeUpload` for that id returns
      `undefined`).
- [ ] `consumeUpload` returns the bytes exactly once — a second call
      for the same `uploadId` returns `undefined` (prevents replaying
      one upload into two flashes without a fresh `flash-local-begin`).
- [ ] `server.ts`'s message handler correctly distinguishes binary
      frames from JSON text messages (`isBinary` branch), verified
      against a fake WebSocket that can send both.
- [ ] `runFlash` with `source: { kind: "local-hex", ... }` flashes the
      consumed bytes through the unchanged `flash.ts` pipeline —
      verified against a fake `flash` implementation, asserting the
      hex bytes passed through match what was uploaded.
- [ ] `runFlash` with `source: { kind: "local-hex", uploadId }` for an
      unknown/already-consumed `uploadId` reports `flash-result`
      `status: "error"` with a clear message, never throws.
- [ ] The full handshake round-trips end-to-end against a fake socket
      in a `server.test.ts`-style test: `flash-local-begin` →
      `flash-local-ready` → binary frame → `flash-start` with the
      returned `uploadId` → successful flash.
- [ ] `npm test` and `npm run build` pass in full.

## Testing

- **Existing tests to run**: `packages/host/src/server.test.ts`,
  `packages/host/src/deviceRegistry.test.ts`, `packages/host/src/flash.test.ts`
  (confirm untouched/still green), full `npm test`.
- **New tests to write**: `localHexUpload.test.ts` (begin/receive/
  consume, size cap, hash/length mismatch, double-consume rejection);
  `server.test.ts` additions for the `isBinary` branch and the full
  handshake round-trip; `deviceRegistry.test.ts` additions for the
  `local-hex` `runFlash` branch (success and unknown-uploadId error).
- **Verification command**: `npm test && npm run build`

## Implementation Plan

**Approach:** Build and unit-test `localHexUpload.ts` in complete
isolation first (no WebSocket, no registry) since it's pure
buffer/hash logic; then wire it into `server.ts`'s message handler;
then wire the `local-hex` branch into `runFlash` last, since that's
the piece with the most existing surrounding logic (mutex, phases,
reidentify from ticket 004) to be careful not to disturb.

**Files to create:**
- `packages/host/src/localHexUpload.ts`
- `packages/host/src/localHexUpload.test.ts`

**Files to modify:**
- `packages/host/src/server.ts`
- `packages/host/src/server.test.ts`
- `packages/host/src/deviceRegistry.ts` (the `runFlash` source-kind
  branch only)
- `packages/host/src/deviceRegistry.test.ts`

**Documentation updates:** `server.ts`'s module doc comment currently
states it "contains no naming, framing, or sequencing logic of its
own" for JSON messages — extend that statement to explicitly cover the
new binary-frame branch (still composition-only: splitting is
`localHexUpload.ts`'s job, `server.ts` only routes based on
`isBinary`). Note in `wsMessages.ts` near `UPLOAD_ID_BYTE_LENGTH` that
`localHexUpload.ts` is the concrete implementation of the convention
documented there.
