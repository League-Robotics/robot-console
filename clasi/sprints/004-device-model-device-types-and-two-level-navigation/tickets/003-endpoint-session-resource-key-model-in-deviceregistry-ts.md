---
id: '003'
title: Endpoint/session/resource-key model in deviceRegistry.ts
status: done
use-cases:
- SUC-001
- SUC-005
depends-on:
- '002'
github-issue: ''
issue: robot-console-two-level-ui-and-multi-transport-roadmap.md
completes_issue: false
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Endpoint/session/resource-key model in deviceRegistry.ts

## Description

Reshape `deviceRegistry.ts`'s internal state around the endpoint/
session/resource-key vocabulary the roadmap issue specifies, on top of
ticket 002's `Link` interface:

- **Endpoint**: a listable, routable thing, identified by
  `endpointId` (`usb-<serialNumber>` for every endpoint this sprint —
  URL-safe from the start, since `/d/:endpointId` needs it verbatim).
- **Resource key**: the physical thing that can only be operated on by
  one session at a time. For USB this sprint, `resourceKey ===
  endpointId` always (one board, one port, one endpoint) — this
  equality is intentional and documented, not dead code (see
  `sprint.md`'s Design Rationale: sprint 7's relay makes them diverge,
  and introducing the field now, unused-but-equal, avoids a second
  `KeyedMutex`-keying redesign then).
- **Session**: the live state of one open `Link` against one
  `resourceKey` — replaces today's flat `link`/`linkOpen`/`linkError`
  trio on `DeviceState` with a nested optional session object.

Rename `KeyedMutex`'s key type from "device serial number" to
"resource key" (same runtime value this sprint, renamed for clarity of
intent). Rename `DeviceState` → `EndpointState` (or an equivalent name
the programmer judges clearest) with fields restructured to:
`endpointId`, `resourceKey`, `device` (the underlying `DaplinkDevice`),
`name`/`nameError` (unchanged), `classification: DeviceClassification`
(from ticket 001/002's `classifyBanner`), `session?: { link: Link,
unsubscribeLine, unsubscribeError }`, `flashStatus?` (unchanged shape
from ticket 001). Update `toEntry()` to map this into
`EndpointListEntry` (already typed in ticket 001).

**Acceptance criterion for this ticket specifically: observable
behavior unchanged.** This is a structural/vocabulary reshape, not a
new feature — a client-observable snapshot, attach/detach behavior,
naming, identify, and session-open/close must all behave exactly as
they did after ticket 002, just expressed through the new internal
shape. Do not implement reidentify sequencing (ticket 004) or
local-hex (ticket 005) here.

## Acceptance Criteria

- [x] `KeyedMutex` is keyed by `resourceKey` (renamed, not
      behaviorally changed — verify existing concurrency tests, e.g.
      "two operations on the same device never run concurrently, two
      different devices proceed in parallel," still pass unmodified in
      substance).
- [x] `resourceKey` is present on every `EndpointListEntry` in a
      snapshot and equals `endpointId` for every USB endpoint,
      asserted directly in a test (not just implied).
- [x] A new test exercises "two logical targets sharing one physical
      resource key" against a fake `Link` — since no second transport
      exists yet this sprint, simulate this by asserting the mutex
      itself serializes two `run()` calls issued under the same
      `resourceKey` string regardless of which "logical" caller issued
      them (this is the shape sprint 7's relay will exercise for real;
      this sprint proves the mutex mechanism, not a real second
      transport).
- [x] `requestOpen`/`requestClose`/`sendLine`/`requestFlash` all still
      behave exactly as before (same error messages for unknown
      endpoint, same no-op-if-already-open/closed semantics) —
      existing `deviceRegistry.test.ts` cases pass with only naming
      updates, no assertion changes.
- [x] Attach/detach/name-resolution timing and event emission order is
      unchanged (verified by the existing tests that assert emission
      order, e.g. "attached, name pending" emitted before SWD
      resolves).
- [x] `npm test` and `npm run build` pass in full.

## Testing

- **Existing tests to run**: `packages/host/src/deviceRegistry.test.ts`
  in full, plus `server.test.ts` (consumes the registry's snapshot
  shape), full `npm test`.
- **New tests to write**: `resourceKey === endpointId` snapshot
  assertion; the shared-resource-key mutex serialization test
  described above.
- **Verification command**: `npm test && npm run build`

## Implementation Plan

**Approach:** Rename and restructure in place, running the existing
test suite after each mechanical step (state shape rename, then
`KeyedMutex` key rename, then `toEntry` mapping update) to catch any
accidental behavior change immediately rather than at the end. Resist
the temptation to "improve" anything beyond what this ticket's
acceptance criteria ask for — ticket 004 and 005 build directly on
this shape next and a gratuitous extra change here makes their diffs
harder to review.

**Files to modify:**
- `packages/host/src/deviceRegistry.ts`
- `packages/host/src/deviceRegistry.test.ts`

**Documentation updates:** Update `deviceRegistry.ts`'s module doc
comment's "Attach flow"/"Detach flow" sections to use
endpoint/session/resource-key terminology consistently — it currently
describes "device" state throughout, which will misdescribe the
reshaped internals for the next reader.
