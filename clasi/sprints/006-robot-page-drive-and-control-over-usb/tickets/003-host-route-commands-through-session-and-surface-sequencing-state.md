---
id: '003'
title: 'Host: route commands through Session and surface sequencing state'
status: done
use-cases:
- SUC-001
- SUC-003
- SUC-004
depends-on:
- '002'
github-issue: ''
issue: robot-console-two-level-ui-and-multi-transport-roadmap.md
completes_issue: false
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Host: route commands through Session and surface sequencing state

## Description

`deviceRegistry.ts` currently uses **none** of what `UsbSerialLink`
already exposes for reliable, sequenced communication —
`sendCommand`/`sendUnsequenced`/`checkLiveness`/`onAckNack`/`session`
all exist and nothing calls them; only `sendLine` is used. This ticket
is the integration work that finally attaches `DeviceRegistry` to
`Session`, per ticket 002's now-frozen `send-command` wire message.

**Verb classification, dispatch, and the `HELLO` guard.** Add
`DeviceRegistry.sendCommand(endpointId, verb, fields)`: runs through
the existing per-endpoint `KeyedMutex` (same as `sendLine`/
`requestOpen`/`requestClose`/`requestFlash` — no new synchronization
primitive), and dispatches by verb:
- `verb === "HELLO"` → `emitError` immediately, explaining that `HELLO`
  cannot be sent as a live command (it resets the robot's sequence
  state — protocol.md §8.3) — **never** forwarded to `Session` at all,
  not even to let `Session.sendUnsequenced`'s own refusal fire.
- `isSequencedVerb(verb)` (from `@robot-console/protocol`) → 
  `link.sendCommand(verb, fields)`.
- otherwise → `link.sendUnsequenced(verb, fields)` (covers `STATUS`,
  `PING`, `ESTOP`, etc. — note `STATUS` is **unsequenced** per
  protocol.md's verb table, despite `sprint.md`'s looser "surfaced
  through the sequenced path" phrasing, which means "through `Session`'s
  discipline," not literally "assigned an id").
- A thrown `SessionError`/`CodecError` from either call is caught and
  reported via `emitError`, never left to crash the process — mirrors
  `sendLine`'s existing try/catch exactly.

**`Link` interface gains a `session` accessor.** Add `readonly session:
Session` to `link/Link.ts`'s `Link` interface (import `Session` type
from `@robot-console/protocol`). `UsbSerialLink` already exposes this
(sprint 4) — no change needed there. This lets `DeviceRegistry` read
live sequencing state without knowing which concrete transport it
holds (see `sprint.md`'s Design Rationale for why this is on the
interface, not a `UsbSerialLink`-only special case).

**Sequencing state visibility.** Both places this file already
constructs an `EndpointSession` (`connectAndIdentify` and
`reidentifyAfterFlash`) subscribe `link.onAckNack` alongside the
existing `onLine`/`onError` subscriptions, calling `emitDevices()` on
every ack/nack event so the next snapshot reflects current state.
Extend `toEntry()` to project `state.session.link.session.{seq,
pendingCount, lastDone, lastDoneReason}` into `EndpointListEntry.sequencing`
when a session is open, `undefined` otherwise.

**Wire `server.ts`.** Add one `case "send-command":` forwarding to
`registry.sendCommand(message.endpointId, message.verb, message.fields
?? [])` — no logic beyond routing, per that module's existing
"composition only" contract.

**Test double update (mechanical, not a new defect).** `deviceRegistry
.test.ts`'s `FakeLink` currently throws on `sendCommand`/`sendUnsequenced`
("not exercised by DeviceRegistry") and has no `session` property. Give
it a real `Session` instance (from `@robot-console/protocol`, no I/O)
and implement `sendCommand`/`sendUnsequenced` by delegating to it, plus
a working `onAckNack`.

**Pacing, proven through the real path, not just in isolation.**
`WritePacer`/`pacing.test.ts` already prove pacing in isolation. This
ticket adds a test that sends a burst of sequenced commands through
`DeviceRegistry.sendCommand` back-to-back (simulating a held drive
control) against a fake `Scheduler`, proving the *whole* path —
`sendCommand` → `Link.sendCommand` → `WritePacer` — holds writes ~10ms
apart, not just that `WritePacer` does when called directly.

## Acceptance Criteria

- [x] `Link` interface declares `readonly session: Session`;
      `UsbSerialLink` satisfies it with no changes.
- [x] `DeviceRegistry.sendCommand(endpointId, verb, fields)` exists,
      runs through `KeyedMutex`, and reports `emitError` for an unknown
      endpoint or no open session (matching `sendLine`'s pattern).
- [x] `verb === "HELLO"` is rejected via `emitError` and never reaches
      `Session` in any form.
- [x] `isSequencedVerb(verb)` verbs dispatch to `link.sendCommand`;
      all others dispatch to `link.sendUnsequenced`.
- [x] A thrown `SessionError`/`CodecError` from either call is caught
      and reported via `emitError`, never thrown to the caller.
- [x] `connectAndIdentify` and `reidentifyAfterFlash` both subscribe
      `onAckNack` on the `EndpointSession` they construct, calling
      `emitDevices()` on every event; the subscription is disposed by
      `teardownLink` alongside `unsubscribeLine`/`unsubscribeError`.
- [x] `toEntry()` populates `sequencing` from the open session's
      `Session` state; `undefined` when no session is open.
- [x] `server.ts` forwards `"send-command"` to `registry.sendCommand`.
- [x] `deviceRegistry.test.ts`'s `FakeLink` gets a real `Session`
      instance and working `sendCommand`/`sendUnsequenced`/`onAckNack`.
- [x] New tests: a sequenced verb reaches `link.sendCommand`; an
      unsequenced verb (`STATUS`, `PING`, `ESTOP`) reaches
      `link.sendUnsequenced`; `HELLO` reaches neither and produces an
      `onError` event; `sequencing` reflects `seq`/`pendingCount` after
      a send and after a simulated ack/nack; a client reading a fresh
      snapshot after connecting sees current `sequencing` immediately
      (no separate event needed to resync).
- [x] New pacing test: a burst of sequenced sends through
      `DeviceRegistry.sendCommand` stays paced ~10ms apart end to end
      (fake `Scheduler`).
- [x] `server.test.ts` covers the new `send-command` case end-to-end
      against a fake registry.
- [x] `npm test` and `npm run build` pass.

## Testing

- **Existing tests to run**: `npm test -- deviceRegistry`, `npm test --
  server` (packages/host); full `npm test` before considering this
  ticket done, since it touches a shared interface (`Link`).
- **New tests to write**: see Acceptance Criteria.
- **Verification command**: `npm test`, `npm run build`.

## Implementation Plan

### Approach

Extend `Link`, then `DeviceRegistry`, then `server.ts`, in that order —
each step's tests can run against the previous step's real
implementation rather than a temporary stub.

### Files to create/modify

- `packages/host/src/link/Link.ts` — add `session: Session` to the
  interface.
- `packages/host/src/deviceRegistry.ts` — add `sendCommand`, extend
  `EndpointSession`'s subscriptions, extend `toEntry()`.
- `packages/host/src/server.ts` — add the `send-command` case.
- `packages/host/src/deviceRegistry.test.ts` — update `FakeLink`; add
  new test cases.
- `packages/host/src/server.test.ts` — add the new case's test.

### Testing plan

See Acceptance Criteria / Testing above.

### Documentation updates

Update `deviceRegistry.ts`'s module doc comment with a short new
section describing command routing and sequencing-state projection,
matching its existing per-sprint documentation convention (see its
"Flash flow" / "Post-flash reidentify sequencing" sections for the
level of detail expected).
