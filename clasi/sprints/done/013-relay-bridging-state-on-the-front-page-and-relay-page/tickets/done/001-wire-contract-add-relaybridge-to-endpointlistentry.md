---
id: '001'
title: 'Wire contract: add relayBridge to EndpointListEntry'
status: done
use-cases:
- SUC-001
- SUC-002
- SUC-003
depends-on: []
github-issue: ''
issue: relay-card-must-show-radio-connection-state-not-just-linked.md
completes_issue: true
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Wire contract: add relayBridge to EndpointListEntry

## Description

Add the wire-level type for relay-bridging attempt state to
`packages/host/src/wsMessages.ts`, as designed in `sprint.md`'s
Architecture section ("Carrying relay-bridging attempt state on the
wire"). This ticket is types-only groundwork — no behavior changes to
`deviceRegistry.ts` or any UI component. It exists as its own ticket
(ahead of ticket 002) because `wsMessages.ts`'s own module contract is
"no logic of its own," and separating the contract from the logic that
populates it keeps ticket 002's diff reviewable against a fixed target
shape.

Add a new optional field on `EndpointListEntry` (placed near the
existing `viaRelay`/`addressSource`/`failoverTrail` fields, since it
concerns the same relay-mediated-connection area):

```ts
/** Present only while the relay's own entry has an in-flight or
 * recently-failed radio-bridging attempt -- absent once the attempt
 * succeeds (at that point "connected" is derived from the synthesized
 * `-via-<name>` child endpoint's existence + open session, not from
 * this field) or once superseded by a later attempt. Mirrors
 * `sessionError`'s present-only-when-relevant discipline. See
 * `deviceRegistry.ts`'s `openRobotViaRelay` for where this is set and
 * cleared, and `sprint.md` (sprint 013) Architecture for the full state
 * flow (Idle/Connecting/Connected/Failed). */
relayBridge?: {
  state: "connecting" | "failed";
  /** The robot name the attempt is/was targeting. Absent for a no-pick
   * default-failover attempt where the eventual candidate name isn't
   * known yet (see sprint 013 sprint.md, Open Questions). */
  robotName?: string;
  /** Every candidate name considered for this attempt, in order. Only
   * populated once known -- see sprint.md's Open Questions for when
   * ticket 002 populates this (expected: only at `state: "failed"`, not
   * during `"connecting"`). */
  triedNames?: string[];
  /** Present only when `state === "failed"` -- the same message text
   * `openRobotViaRelay` already builds for `emitError`, reused verbatim
   * (see sprint.md Open Questions: one message, not two). */
  error?: string;
};
```

Exact field names/shape may be refined during ticket 002 if
`openRobotViaRelay`'s actual data (e.g. what's available before vs.
after candidates are built) makes a different shape cleaner — this
ticket's job is to land a reasonable, documented starting contract that
ticket 002 fills in and can still adjust before it ships, not to freeze
a shape ticket 002 must work around.

Update `wsMessages.ts`'s module-level doc comment if it enumerates
per-endpoint fields in a summary list (check for one before assuming).

## Acceptance Criteria

- [x] `EndpointListEntry` in `packages/host/src/wsMessages.ts` has a new
      optional `relayBridge` field with the shape above (or a refined
      shape, documented with the same rationale) and a doc comment
      explaining when it is present/absent, cross-referencing
      `openRobotViaRelay`.
- [x] The field is additive only -- no existing field is renamed,
      removed, or changed in meaning. `viaRelay`, `sessionError`,
      `addressSource`, `failoverTrail` are all untouched.
- [x] `packages/host/src/wsMessages.test.ts` (or a new test in that
      file) exercises the type compiles and, if that file has
      runtime assertions for other present-only-when-relevant fields
      (e.g. a shape/serialization check), `relayBridge` gets the same
      treatment for consistency -- otherwise a type-only addition needs
      no new runtime test here (confirm which pattern the file already
      follows before adding one).
- [x] No behavior changes anywhere else in this ticket -- `toEntry` in
      `deviceRegistry.ts` is NOT modified here (that's ticket 002).

## Implementation Plan

**Approach**: Add the type only. Do not wire it up to `toEntry` or any
producer/consumer in this ticket -- that is ticket 002 (host) and
tickets 003/004 (UI).

**Files to modify**:
- `packages/host/src/wsMessages.ts` -- add `relayBridge` to
  `EndpointListEntry`.

**Testing plan**:
- `npx vitest run packages/host/src/wsMessages.test.ts`
- `npm run build` (or the workspace's TypeScript check) to confirm the
  new field type-checks and doesn't break any existing consumer (none
  should reference it yet).

**Documentation updates**:
- The new field's own doc comment, written as part of the change (see
  above) -- no separate doc file exists for the wire contract.

## Testing

- **Existing tests to run**: `npx vitest run packages/host/src/wsMessages.test.ts`
- **New tests to write**: only if `wsMessages.test.ts` already asserts
  shapes/serialization for other present-only-when-relevant fields; add
  the equivalent for `relayBridge` if so, otherwise none needed (type
  addition only).
- **Verification command**: `npx vitest run packages/host/src/wsMessages.test.ts`
