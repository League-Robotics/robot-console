---
id: '005'
title: 'RelayPage UI: dropdown, connected/not-connected states, manual entry'
status: in-progress
use-cases:
- SUC-003
- SUC-004
- SUC-005
depends-on:
- '004'
- '006'
github-issue: ''
issue: robot-console-architecture-and-roadmap.md
completes_issue: false
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# RelayPage UI: dropdown, connected/not-connected states, manual entry

## Description

Rewrite `packages/ui/src/pages/RelayPage.tsx` from sprint 4's
disabled-dropdown placeholder shell into the real relay page.
**Exactly two states**, per `sprint.md`'s Solution:

- **Not connected**: the robot dropdown, populated from `WsProvider`'s
  `rememberedRobots` (sprint 5's roster) plus any names currently
  visible in `discoveredServices` (ticket 001/004's snapshot list) —
  **never** a speculative registry lookup just to populate the list (a
  dropdown entry is a name string only; no address is resolved until a
  connection is actually attempted). A manual channel/group entry
  affordance for when no name is chosen. A "Connect" action sends
  `session-open { endpointId: <this relay>, robotName }` (explicit
  pick) or, with none selected, no `robotName` at all — triggering
  ticket 004's default failover-through-the-roster behavior.
- **Connected**: renders sprint 006's `RobotPage` for the synthesized
  robot-via-relay endpoint, **completely unchanged** — `RelayPage`'s
  own job here is only to find the right `endpointId` (via
  `WsProvider`'s selectors, matching on the relay's own `endpointId` as
  a prefix/parent, per ticket 004's derivation scheme) and render
  `<RobotPage endpoint={...} />`, exactly as `DevicePage.tsx` already
  does for a directly-attached robot. Mounts ticket 006's
  `AddressSourceChip` above `RobotPage` (not inside it) using the
  synthesized endpoint's `addressSource`.

**Failover trail** (SUC-005): while a failover attempt is in progress
or has just completed, render the "gave up on X, trying Y" trail
visibly (from the synthesized endpoint's `failoverTrail`, or a
transient in-progress indicator sourced from `WsProvider` state)
— never swallowed.

Switching robots: selecting a different name while connected sends
`session-close` for the current robot-via-relay endpoint, then
`session-open` with the new `robotName` — two round trips, per
`sprint.md`'s Design Rationale (never a client-side "retarget"
illusion).

**Transport-blindness applies to `RobotPage` here exactly as it does
everywhere else** — this ticket must not add any relay-aware branch
inside `RobotPage` or its children. Extend
`RobotPage.transportBlind.test.ts`'s source-scan fixture list to also
exercise a relay-transport endpoint, proving the existing scan still
finds nothing relay-specific.

## Acceptance Criteria

- [x] Not-connected state: dropdown lists roster + discovered names,
      manual channel/group entry available, no registry call is ever
      triggered by rendering or opening the dropdown (assert against a
      fake `WsProvider`/socket that no `resolveRobotAddress`-shaped
      message is sent until "Connect" is actually clicked).
- [x] Explicit dropdown pick + Connect sends `session-open` with the
      chosen `robotName`.
- [x] Connect with no pick sends `session-open` with no `robotName`
      (default failover path).
- [x] Connected state renders `<RobotPage>` for the synthesized
      endpoint, with `AddressSourceChip` mounted above it (not inside
      `RobotPage`).
- [x] `RobotPage.transportBlind.test.ts`'s source scan, extended to a
      relay-transport endpoint fixture, still passes with zero changes
      to `RobotPage.tsx` or its child components.
- [x] Switching the dropdown selection while connected sends
      `session-close` then `session-open` (two distinct messages, in
      that order) — never a single "retarget" message (none exists).
- [x] A failover trail (fixture data: two given-up-on candidates, one
      success) renders visibly on the page, not hidden behind an
      expand/collapse control by default.
- [x] `npm test` and `npm run build` pass.

## Testing

- **Existing tests to run**: `npm test -- ui` (packages/ui), full
  `npm test` before considering this ticket done (touches the shared
  `RobotPage.transportBlind.test.ts` fixture list).
- **New tests to write**: `RelayPage.test.tsx` rewritten for the real
  two-state behavior (replacing the sprint-4 placeholder's disabled-
  dropdown assertions), against `WsProvider`'s existing fake-socket
  testing harness.
- **Verification command**: `npm test`, `npm run build`.

## Implementation Plan

### Approach

Depends on ticket 004 (the wire shapes/selectors this page reads and
the `session-open`/`session-close` semantics it drives) and ticket 006
(the chip component it mounts). Build the not-connected state first
(dropdown + manual entry, no session yet), then the connected state
(matching-endpoint lookup + `RobotPage` reuse + chip), then the
failover-trail rendering and the switch/close message sequencing.

### Files to create/modify

- `packages/ui/src/pages/RelayPage.tsx` — rewritten.
- `packages/ui/src/pages/RelayPage.css` — updated.
- `packages/ui/src/pages/RelayPage.test.tsx` — rewritten.
- `packages/ui/src/pages/RobotPage.transportBlind.test.ts` — extended
  fixture list (relay-transport endpoint), no change to the scan logic
  itself.

### Testing plan

See Acceptance Criteria / Testing above.

### Documentation updates

Update `RelayPage.tsx`'s own module doc comment (replacing the sprint-4
placeholder doc comment, which explicitly said "sprint 7 populates
connected/not-connected behavior") to describe the real two-state
behavior and cross-reference `sprint.md`'s Design Rationale for the
switch-is-close-then-open sequencing, rather than re-explaining it.
