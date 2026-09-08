---
id: '002'
title: 'Wire contract: remembered-robots snapshot field and forget message'
status: done
use-cases:
- SUC-002
- SUC-003
depends-on:
- '001'
github-issue: ''
issue: ''
completes_issue: true
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Wire contract: remembered-robots snapshot field and forget message

## Description

Extend `packages/host/src/wsMessages.ts` — the one place the host/UI wire
contract is defined — with the shapes this sprint needs. Per `sprint.md`'s
Architecture (Step 3, "wsMessages.ts additions") and Design Rationale
("a separate `rememberedRobots` wire list, not a synthetic endpoint
entry"): a remembered robot is **not** represented as an
`EndpointListEntry` (it has no `resourceKey`, no session, no route to
open this sprint) — it gets its own small, independent shape.

Sequenced after ticket 001 only so the wire type's field names can be
lifted directly from the now-real `KnownRobotRecord` shape rather than
guessed at; this ticket does not import anything from
`store/knownRobots.ts` (that would be a layering violation — `wsMessages.ts`
has no dependency on `host`'s other modules today and must not gain one).

**New type**:
```ts
export interface RememberedRobotEntry {
  name: string;
  lastSeenAt: string;
  lastSeenVia: "usb";
  lastRole: string | null;
  lastUsbSerial: string;
}
```
(Deliberately omits `firstSeenAt`/`lastType` — not needed by any consumer
this sprint; adding wire fields nothing reads is exactly the kind of
speculative generality `sprint.md`'s Architecture warns against. Add
`firstSeenAt` later if/when something actually displays it.)

**`EndpointsMessage` gains a required field**:
```ts
export interface EndpointsMessage {
  type: "endpoints";
  endpoints: EndpointListEntry[];
  firmwareStatus: Record<FirmwareKind, FirmwareAvailability>;
  rememberedRobots: RememberedRobotEntry[];
}
```

**New client→server message**:
```ts
export interface ForgetKnownRobotMessage {
  type: "forget-known-robot";
  name: string;
}
```
Add to the `ClientMessage` union, and add a `parseClientMessage` case
(`case "forget-known-robot":`) requiring `isNonEmptyString(value.name)`,
mirroring the existing `session-close` case's shape exactly (a single
required string field, no optional fields).

Update the module doc comment's "Direction" list to include
`ForgetKnownRobotMessage` under client→server.

## Acceptance Criteria

All of the following are provable without hardware — this is a pure
type/validation-logic ticket with no I/O.

- [x] `RememberedRobotEntry` and the extended `EndpointsMessage` compile
      and are exported; `npm run build` typechecks cleanly across all
      three workspaces (an existing test/fixture asserting the old
      `EndpointsMessage` shape without `rememberedRobots` will now fail
      to typecheck or fail an equality assertion — update those fixtures
      as part of this ticket, do not leave them broken).
- [x] `parseClientMessage({ type: "forget-known-robot", name: "zeguz" })`
      returns a `ForgetKnownRobotMessage` with `name: "zeguz"`.
- [x] `parseClientMessage({ type: "forget-known-robot" })` (missing
      `name`) returns `undefined`.
- [x] `parseClientMessage({ type: "forget-known-robot", name: "" })`
      (empty string) returns `undefined` — matches `isNonEmptyString`'s
      existing behavior for `session-close`'s `endpointId`.
- [x] `parseClientMessage({ type: "forget-known-robot", name: 5 })`
      (wrong type) returns `undefined`.
- [x] The existing `parseClientMessage` test suite's other cases
      (`session-open`, `session-close`, `line`, `flash-start`,
      `flash-local-begin`) are unaffected — no regressions from the new
      `switch` case.

## Testing

- **Existing tests to run**: `npm test -w @robot-console/host` — in
  particular `wsMessages.test.ts`, and any test in `server.test.ts`/
  `deviceRegistry.test.ts` that constructs a literal `EndpointsMessage`
  and will need its fixture updated to include `rememberedRobots: []`.
- **New tests to write**: extend `wsMessages.test.ts` with the
  `forget-known-robot` parsing cases above.
- **Verification command**: `npm test -w @robot-console/host` and
  `npm run build`.
