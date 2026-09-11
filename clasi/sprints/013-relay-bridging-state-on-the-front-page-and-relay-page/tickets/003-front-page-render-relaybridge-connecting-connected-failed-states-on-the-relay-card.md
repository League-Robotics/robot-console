---
id: '003'
title: 'Front page: render relayBridge connecting/connected/failed states on the relay
  card'
status: done
use-cases:
- SUC-001
- SUC-002
- SUC-003
depends-on:
- '002'
github-issue: ''
issue: relay-card-must-show-radio-connection-state-not-just-linked.md
completes_issue: true
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Front page: render relayBridge connecting/connected/failed states on the relay card

## Description

Consume the `relayBridge` field (shipped by tickets 001/002) in
`packages/ui/src/pages/FrontPage.tsx` so the relay's own front-page card
shows the three bridging states per the issue's acceptance criteria and
`sprint.md`'s SUC-001/002/003. Today `connectionState` (around line 309)
only distinguishes "Linked"/"Unreachable: ..."/"Not linked" from
`sessionOpen`/`sessionError`, and `RelayQuickConnect` (around line 453)
only shows a "Connected to `<name>`…" line when a `viaRelay` child
already exists -- nothing renders while connecting or after a failure.

**`connectionState`**: must NOT change its meaning -- it keeps
describing only the relay's own transport session (`sessionOpen`/
`sessionError`), per sprint.md's Architecture ("`relayBridge` is a
different field, read separately"). Do not fold `relayBridge` into this
function's return value.

**`RelayQuickConnect`**: add rendering for the relay's own
`relayBridge` field (read directly off the `relay: EndpointListEntry`
prop already passed in), alongside the existing `child?.viaRelay`
connected-state paragraph:
- `relay.relayBridge?.state === "connecting"`: render "Connecting to
  `<name>`…" when `relayBridge.robotName` is present, or a generic
  in-progress message (e.g. "Connecting…") when it's the no-pick case
  (match `RelayPage.tsx`'s "Trying remembered robots…" copy/tone if
  ticket 004 lands first and establishes wording -- otherwise pick
  wording here and ticket 004 should match it; whichever ticket lands
  second should reconcile so both surfaces use the same words for the
  same state, per sprint.md's Open Questions about not having two
  messages drift).
- `relay.relayBridge?.state === "failed"`: render the failure reason
  (`relayBridge.error`) visibly on the card -- this is the acceptance
  criterion the issue specifically calls out as currently missing
  ("today an exhausted connect only goes to the relay's console log").
- `child?.viaRelay` (already existing): unchanged, still the "connected"
  rendering, since connected state is derived from the child, not from
  `relayBridge`.
- These three are mutually exclusive in practice (see sprint.md's state
  diagram) but render defensively -- don't assume the host always
  clears `relayBridge` in the same tick the child appears; prefer
  `child?.viaRelay` taking rendering priority if both were somehow
  present in one snapshot (this should not normally happen per ticket
  002's contract, but the UI should degrade sensibly, not double-render,
  if it does).

Also verify (per the issue's acceptance criteria) that a robot connected
through the relay reliably appears as its own device-list card --
`groupEndpointsByRobot`/the existing child-card rendering already do
this structurally (per the team-lead's research, there's existing
coverage around `FrontPage.test.tsx` ~line 871-903); this ticket's job
is to add regression coverage specifically tied to the `relayBridge`
success-clears-and-child-appears transition, not to build new grouping
logic.

## Acceptance Criteria

- [x] Front-page relay card shows "Connecting to `<name>`…" (or the
      no-pick equivalent) as soon as `relayBridge.state === "connecting"`
      appears in a snapshot -- no waiting for a child endpoint.
- [x] Front-page relay card shows the failure reason from
      `relayBridge.error` when `relayBridge.state === "failed"`.
- [x] Front-page relay card shows "Connected to `<name>`" (existing
      behavior, unchanged) once the child endpoint exists with an open
      session, and the child's own card is present in the device list.
- [x] `connectionState`'s output ("Linked"/"Unreachable: ..."/"Not
      linked") is provably unaffected by `relayBridge`'s value -- a test
      asserts the relay's own connection-state text is identical whether
      `relayBridge` is absent, `"connecting"`, or `"failed"`.
- [x] No interactive element inside the card's `<a>`/`Link` region (this
      sprint doesn't touch that structure, but don't regress it --
      reference sprint 012's `FrontPage.test.tsx` DOM-structure
      assertion if extending near it).

## Implementation Plan

**Approach**: Extend `RelayQuickConnect` to read `relay.relayBridge`
and render the connecting/failed cases as new conditional blocks
alongside the existing `child?.viaRelay` block. No new props needed --
`relay: EndpointListEntry` already carries `relayBridge` once tickets
001/002 ship. No changes to `connectionState`.

**Files to modify**:
- `packages/ui/src/pages/FrontPage.tsx` -- `RelayQuickConnect`.
- `packages/ui/src/pages/FrontPage.css` (or wherever
  `device-relay-connected`/`device-relay-connect-row` are styled) --
  add classes for the connecting/failed rows if new markup needs
  distinct styling (e.g. a `device-relay-connecting`/
  `device-relay-failed` class paralleling the existing
  `device-relay-connected` one).

**Testing plan**:
- Extend `packages/ui/src/pages/FrontPage.test.tsx`: a fixture relay
  entry with `relayBridge: { state: "connecting", robotName: "GoPiv" }`
  renders "Connecting to GoPiv…"; one with `relayBridge: { state:
  "failed", error: "..." }` renders that error text; the existing
  connected-child fixture still renders "Connected to `<name>`" and the
  child's own card (regression, referencing the existing ~871-903
  coverage); a fixture with no `relayBridge` and `sessionOpen: true`
  still renders plain "Linked" with none of the new text.

**Documentation updates**:
- None beyond inline comments on the new conditional blocks, matching
  this file's existing comment density.

## Testing

- **Existing tests to run**: `npx vitest run packages/ui/src/pages/FrontPage.test.tsx`
- **New tests to write**: see Implementation Plan's Testing plan above.
- **Verification command**: `npx vitest run packages/ui/src/pages/FrontPage.test.tsx`
