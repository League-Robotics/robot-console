---
id: '001'
title: Wire contract reshape and device-type union
status: done
use-cases:
- SUC-001
- SUC-002
- SUC-003
- SUC-004
- SUC-006
- SUC-007
depends-on: []
github-issue: ''
issue: robot-console-two-level-ui-and-multi-transport-roadmap.md
completes_issue: false
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Wire contract reshape and device-type union

## Description

Freeze the reshaped wire contract in one ticket so every later ticket
this sprint builds against a stable shape instead of a moving one —
the same strategy sprint 002 used successfully. This ticket:

1. Adds `packages/protocol/src/deviceType.ts`: the `DeviceType` union
   (`"unknown" | "relay" | "robot"`), `DeviceClassification`, and
   `classifyBanner(banner: ParsedBanner | null): DeviceClassification`
   implementing the precedence rule (no banner → unknown; then
   `commonName` "relay"/"robot"; then role allowlist
   `RADIORELAY`/`RADIOBRIDGE` → relay, `NEZHA2` → robot; else unknown
   with `role` preserved verbatim). Also add
   `normalizeDeviceType(value: string): DeviceType`, coercing any
   unrecognized string to `"unknown"` — the mechanism that makes a
   future fourth type purely additive on the client side.
2. Reshapes `packages/host/src/wsMessages.ts` per `sprint.md`'s
   Architecture Step 5 "What changed": `DeviceListEntry` →
   `EndpointListEntry` (`endpointId`, `transport: "usb"`,
   `resourceKey`, `classification: DeviceClassification`,
   `sessionOpen`/`sessionError` replacing `linkOpen`/`linkError`);
   `DevicesMessage` → `EndpointsMessage` (`type: "endpoints"`,
   `endpoints: EndpointListEntry[]`); `open`/`close` client messages →
   `session-open`/`session-close` (`endpointId`, plus an optional,
   currently-unused `robotName?` reserved for sprint 7); `LineMessage`
   and `ErrorMessage`'s `deviceId` → `endpointId`; `FirmwareSourceRef`
   (`{ kind: "release"; firmware: FirmwareKind }` |
   `{ kind: "local-hex"; uploadId: string; fileName: string; sha256:
   string }`); `FlashStartMessage` carries `source: FirmwareSourceRef`
   instead of `firmware`; `FlashPhase` gains `"reidentifying"` after
   `"resetting"`; `FlashProgressMessage` carries `source` instead of
   `firmware`; `FlashResultMessage` gains optional `classification`,
   `name`, and `reidentify?: "timeout"` (present only on
   `status: "ok"`); new `FlashLocalBeginMessage`
   (`{ type: "flash-local-begin"; fileName; byteLength; sha256 }`) and
   `FlashLocalReadyMessage` (`{ type: "flash-local-ready"; uploadId }`);
   a new exported `UPLOAD_ID_BYTE_LENGTH` constant (36 — an ASCII UUID)
   documenting the local-hex binary-frame convention
   (`uploadId || payload`), consumed by ticket 005. Update
   `parseClientMessage` for every renamed/new client message shape.
3. Updates every call site so the whole workspace compiles and the
   existing test suite passes against the new shape with **no new
   behavior** — this ticket is a mechanical rename plus additive
   types, not a functional change. In particular:
   - `deviceRegistry.ts`: rename `DeviceState`'s external-facing
     mapping (`toEntry`) to emit `EndpointListEntry`; call
     `classifyBanner` when a banner is known; keep `role` in sync with
     `classification.role` for now (later tickets restructure the
     internal state further).
   - `server.ts`: rename the broadcast message type and client-message
     switch cases (`open`→`session-open`, `close`→`session-close`);
     `buildDevicesMessage` → `buildEndpointsMessage`.
   - `WsProvider.tsx`, `DevicesTab.tsx`, `ConsoleTab.tsx`: update
     imports/types/field names (`deviceId`→`endpointId`,
     `linkOpen`→`sessionOpen`, etc.) so the UI still renders exactly as
     before.
   - All touched test files (`wsMessages.test.ts`,
     `deviceRegistry.test.ts`, `server.test.ts`,
     `link/UsbSerialLink.test.ts`, `DevicesTab.test.tsx`,
     `ConsoleTab.test.tsx`): rename fields/messages in fixtures and
     assertions to match.

Do **not** yet: implement the endpoint/session/resource-key model
internals (ticket 003), split `Link.connect()`/`identify()` (ticket
002), implement reidentify sequencing (ticket 004), implement the
local-hex upload handshake body (ticket 005), or touch
`WsProvider`'s internal store shape (ticket 006) or routing (tickets
007/008). This ticket only freezes the *shapes* those tickets will
build against.

## Acceptance Criteria

- [x] `classifyBanner()` implements the exact precedence rule (no
      banner → unknown, evidence `"none"`; `commonName` "relay"/"robot"
      → that type; else role allowlist; else unknown with `role`
      preserved verbatim), unit-tested against fixtures covering every
      branch, including an unrecognized `commonName` *and*
      unrecognized `role` together.
- [x] `normalizeDeviceType()` coerces any string other than
      `"relay"`/`"robot"` to `"unknown"`, unit-tested including a
      fabricated future value (e.g. `"calibration"`).
- [x] `wsMessages.ts` compiles with every type/message shape listed in
      the Description; `parseClientMessage` accepts every valid new
      client message shape and rejects malformed ones (mirroring the
      existing test file's coverage style for `open`/`close`/`line`/
      `flash-start`).
- [x] `npm run build` passes across all three workspaces.
- [x] `npm test` passes in full (475+ tests), with every renamed
      field/message updated in fixtures — no test is skipped or
      weakened to make this pass.
- [x] No behavior changes: a device attaching, naming, identifying
      (or failing to), and flashing via the release path all work
      exactly as before this ticket, verified by the (renamed but
      otherwise unchanged) existing test assertions in
      `deviceRegistry.test.ts` and `server.test.ts`.
- [x] `FlashResultMessage`'s new `classification`/`name`/`reidentify`
      fields exist in the type but are not yet populated with real
      reidentify logic (`deviceRegistry.ts` still clears `flashStatus`
      and reports `flash-result` immediately after a successful write,
      exactly as today) — ticket 004 is what makes them real. Note
      this explicitly in code comments so ticket 004's diff is clear.

## Testing

- **Existing tests to run**: `npm test` (full suite — this ticket
  touches shared types every workspace depends on).
- **New tests to write**: `deviceType.test.ts` covering
  `classifyBanner()`'s full precedence table and
  `normalizeDeviceType()`'s coercion; extend `wsMessages.test.ts` for
  the new/renamed message shapes and `parseClientMessage` branches.
- **Verification command**: `npm test && npm run build`

## Implementation Plan

**Approach:** Bottom-up — write `deviceType.ts` and its tests first
(pure, no dependencies), then reshape `wsMessages.ts` and its tests,
then propagate the rename outward through `deviceRegistry.ts` →
`server.ts` → `WsProvider.tsx` → `DevicesTab.tsx`/`ConsoleTab.tsx`,
running `npm run build` after each layer to catch type errors early
rather than all at once at the end.

**Files to create:**
- `packages/protocol/src/deviceType.ts`
- `packages/protocol/src/deviceType.test.ts`

**Files to modify:**
- `packages/protocol/src/index.ts` (export the new module)
- `packages/host/src/wsMessages.ts`
- `packages/host/src/wsMessages.test.ts`
- `packages/host/src/deviceRegistry.ts` (mapping only — see Description)
- `packages/host/src/deviceRegistry.test.ts`
- `packages/host/src/server.ts`
- `packages/host/src/server.test.ts`
- `packages/host/src/link/UsbSerialLink.test.ts` (if it references
  renamed wire types — check before assuming)
- `packages/ui/src/ws/WsProvider.tsx`
- `packages/ui/src/components/DevicesTab.tsx`
- `packages/ui/src/components/DevicesTab.test.tsx`
- `packages/ui/src/components/ConsoleTab.tsx`
- `packages/ui/src/components/ConsoleTab.test.tsx`

**Documentation updates:** Update `wsMessages.ts`'s own module doc
comment (direction lists, message inventory) to match the new shapes —
it currently documents the pre-reshape contract verbatim and will
mislead the next reader if left as-is.
