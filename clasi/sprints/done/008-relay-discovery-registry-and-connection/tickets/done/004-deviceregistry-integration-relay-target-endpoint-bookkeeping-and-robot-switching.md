---
id: '004'
title: 'DeviceRegistry integration: relay-target endpoint bookkeeping and robot switching'
status: done
use-cases:
- SUC-003
- SUC-004
depends-on:
- '003'
github-issue: ''
issue: robot-console-architecture-and-roadmap.md
completes_issue: false
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# DeviceRegistry integration: relay-target endpoint bookkeeping and robot switching

## Description

Extend `deviceRegistry.ts`: inject `RelayConnectionCoordinator` (ticket
003) as one more constructor seam, following the exact pattern
`resolveName`/`createLink`/`flash`/`knownRobotsStore` already establish
(default to a real instance; tests substitute a fake). Route
`SessionOpenMessage.robotName` (reserved since sprint 004, live for the
first time this sprint) through `requestOpen`: when `robotName` is
present and the target `endpointId` classifies as `"relay"`, call the
coordinator instead of the plain USB open path, and turn its result
into a **new** `EndpointState`/`EndpointListEntry` — not a mutation of
the relay's own endpoint — with:

- `endpointId` derived deterministically from the relay's own
  `endpointId` plus the robot name (e.g. `` `${relayEndpointId}-${name}` ``
  — pick a concrete, URL-safe scheme and document it, mirroring
  `usbEndpointId`'s own doc comment).
- `resourceKey` equal to the relay's own `resourceKey` for
  `relay-radio`/`mbrelay` transports (never an independent key — this
  is what makes flashing the relay and driving through it mutually
  exclusive via the existing `KeyedMutex`, no new mechanism).
- `transport` one of `relay-radio`/`mbrelay`/`mbserial`; `classification`
  from the coordinator's result.

Run this whole operation through the **relay's own** `resourceKey` in
`KeyedMutex.run` (not a new key), so it correctly queues behind (or
blocks) a concurrent flash/open/close on the same physical relay.

**Switching robots** (a new `session-open` with a different `robotName`
for the same relay while a robot-via-relay endpoint already exists for
it): tear down the old synthesized endpoint's session and remove it
from `states` entirely, then repeat the coordinator flow for the new
name — never an in-place retarget (no such method exists on `Link`).
**Closing** (`session-close` on the robot-via-relay `endpointId`):
tears down its session and removes it from `states`, leaving the
relay's own endpoint (if it has a separate raw-console session open)
untouched.

Extend `wsMessages.ts`: `EndpointListEntry` gains an optional
`addressSource`/`failoverTrail`-shaped field (present only for a
relay-mediated, non-`mbserial` endpoint — mirrors `sessionError`'s
present-only-when-relevant discipline). `server.ts`: no new message
type needed — thread `robotName` through the existing `"session-open"`
case to `registry.requestOpen`.

## Acceptance Criteria

- [x] `session-open { endpointId: <relay>, robotName }` against a fake
      `RelayConnectionCoordinator` produces a new `EndpointListEntry` in
      `snapshot()` with the derived `endpointId`, shared `resourceKey`,
      correct `transport`/`classification`.
- [x] The relay's own `endpointId` and the synthesized robot-via-relay
      `endpointId` are both present in `snapshot()` simultaneously (the
      relay endpoint is never replaced or hidden by the synthesized
      one).
- [x] A flash request (`requestFlash`) against the relay's own
      `endpointId` while a robot-via-relay session is open on the
      shared `resourceKey` queues behind it — a direct `KeyedMutex`
      ordering test, not just an assertion about eventual consistency.
- [x] Switching `robotName` for the same relay removes the old
      synthesized endpoint from `snapshot()` and adds a new one for the
      new name — never both present at once, never the old one silently
      reused for the new name.
- [x] `session-close` on a robot-via-relay `endpointId` removes it from
      `snapshot()` and leaves the relay's own endpoint entry unaffected.
- [x] No code path in `deviceRegistry.ts` calls a `retarget`-shaped
      method on `Link` (it does not exist on the interface — enforced
      by the type system, not a runtime check; note this in the test
      file's own comment rather than asserting it at runtime).
- [x] `EndpointListEntry.addressSource`/`failoverTrail` are present only
      for a relay-mediated, non-`mbserial` endpoint with an open
      session — absent otherwise, mirroring `sequencing`'s existing
      present-only-when-open discipline.
- [x] `server.ts` forwards `robotName` from `"session-open"` to
      `registry.requestOpen` unchanged.
- [x] `npm test` and `npm run build` pass.

## Testing

- **Existing tests to run**: `npm test -- deviceRegistry`, `npm test --
  server`, full `npm test` before considering this ticket done (touches
  `wsMessages.ts`, a shared contract).
- **New tests to write**: see Acceptance Criteria — extend
  `deviceRegistry.test.ts` with a fake `RelayConnectionCoordinator`
  (never a real one); extend `server.test.ts` for the `robotName`
  forwarding.
- **Verification command**: `npm test`, `npm run build`.

## Implementation Plan

### Approach

Depends on ticket 003 (the coordinator's exact result shape). Add the
`wsMessages.ts` fields first (frozen shape for the rest of this ticket
to build against, mirroring sprint 004's own ticket-001-freezes-the-
contract precedent), then the `DeviceRegistry` integration, then the
`server.ts` one-line forward.

### Files to create/modify

- `packages/host/src/wsMessages.ts` — `addressSource`/`failoverTrail`
  fields on `EndpointListEntry`.
- `packages/host/src/deviceRegistry.ts` — inject
  `RelayConnectionCoordinator`, extend `requestOpen`/`requestClose`,
  synthesized-endpoint bookkeeping.
- `packages/host/src/server.ts` — forward `robotName`.
- `packages/host/src/deviceRegistry.test.ts` — new fake coordinator,
  new test cases.
- `packages/host/src/server.test.ts` — `robotName` forwarding test.

### Testing plan

See Acceptance Criteria / Testing above.

### Documentation updates

Extend `deviceRegistry.ts`'s module doc comment with a new section on
relay-target endpoint synthesis and switching, matching its existing
per-sprint documentation convention (see its "Flash flow" / "Post-flash
reidentify sequencing" sections for the level of detail expected) —
explicitly reference `RelayConnectionCoordinator`'s own doc comment
rather than re-explaining resolution/failover policy here.
