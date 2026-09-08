---
id: '002'
title: Freeze the send-command wire contract
status: done
use-cases:
- SUC-001
- SUC-002
- SUC-003
- SUC-004
depends-on: []
github-issue: ''
issue: robot-console-two-level-ui-and-multi-transport-roadmap.md
completes_issue: false
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Freeze the send-command wire contract

## Description

Today the only client→host verb-sending path is `LineMessage` (`type:
"line"`), a raw, unstructured string sent via `DeviceRegistry.sendLine`
→ `link.sendLine` — this bypasses `Session` entirely (no id, no
sequencing, no ack/nack tracking beyond whatever `LineRouter` happens
to observe on the way back in). This sprint's drive/`STATUS`/`GET`/
`SET`/e-stop controls need a second, structured client→host message
that names a verb and fields and lets the host decide how to dispatch
it through `Session`.

Per this project's established convention (sprint 4's own ticket 001:
"freeze the wire contract entirely in the first ticket"), this ticket
freezes `wsMessages.ts`'s shape for the whole sprint before any host or
UI behavior is built against it. This ticket is **types and validation
only** — no `DeviceRegistry`/`server.ts`/UI behavior changes here (that
is tickets 003–006).

Two additions:

1. A new client→server `SendCommandMessage`: `{ type: "send-command";
   endpointId: string; verb: string; fields?: WireField[] }`, added to
   `ClientMessage`. `WireField` (from `@robot-console/protocol`) is
   already JSON-serializable (`number | string | FlagsField`, and
   `FlagsField` is already a plain `{ wireType: "flags"; value: number
   }` object) — no new wire-value encoding is needed.
2. A new `sequencing` field on `EndpointListEntry`: `{ seq: number;
   pendingCount: number; lastDone: number; lastDoneReason: string } |
   undefined`, present only when a session is open (mirroring
   `sessionError`'s present-only-when-relevant shape) — this is what
   ticket 003 populates and the UI reads for SUC-003.

## Acceptance Criteria

- [x] `SendCommandMessage` type added and included in the `ClientMessage`
      union.
- [x] `parseClientMessage` validates `"send-command"`: non-empty
      `endpointId`, non-empty `verb` (string), and — if `fields` is
      present — it is an array where every entry is a legal `WireField`
      (`string`, `number`, or an object shaped exactly like
      `FlagsField`, i.e. `{ wireType: "flags"; value: number }`).
      Malformed input returns `undefined`, exactly like every other
      case in this function — never a thrown exception.
- [x] New `sequencing?: { seq: number; pendingCount: number; lastDone:
      number; lastDoneReason: string }` field added to
      `EndpointListEntry`.
- [x] No existing field on any wire type is renamed or removed — purely
      additive, per this module's existing discipline.
- [x] Module doc comment updated to record this sprint's reshape (a
      short new subsection), matching the file's existing per-sprint
      documentation convention (see its "Sprint 4 reshape" section for
      the precedent).
- [x] `wsMessages.test.ts` covers: a well-formed `send-command` message
      parses correctly; missing/empty `endpointId` or `verb` is
      rejected; a `fields` array containing an illegal entry (e.g. a
      boolean, or an object without `wireType: "flags"`) is rejected;
      `fields` omitted entirely is accepted (equivalent to `[]`, for
      bare-`GET`-style verbs).

## Testing

- **Existing tests to run**: `npm test -- wsMessages` (packages/host);
  `npm run build` to confirm no downstream type errors from the
  `ClientMessage`/`EndpointListEntry` changes.
- **New tests to write**: the `parseClientMessage` cases listed above,
  added to `wsMessages.test.ts` alongside the existing per-message-type
  test blocks.
- **Verification command**: `npm test`, `npm run build`.

## Implementation Plan

### Approach

Additive-only change to `packages/host/src/wsMessages.ts`, following
the exact shape of the file's existing types/guards (e.g.
`isFirmwareSourceRef`'s validation style) rather than introducing a new
validation idiom.

### Files to create/modify

- `packages/host/src/wsMessages.ts` — add `SendCommandMessage`, extend
  `ClientMessage`, extend `EndpointListEntry` with `sequencing`, add a
  `send-command` case (and a small `isWireField`/`isWireFieldArray`
  guard) to `parseClientMessage`.
- `packages/host/src/wsMessages.test.ts` — new test cases.

### Testing plan

See Acceptance Criteria / Testing above.

### Documentation updates

Module doc comment in `wsMessages.ts` gains a short note recording this
sprint's addition, mirroring the existing "Sprint 4 reshape" section's
style and level of detail (a few sentences, not a full rewrite).
