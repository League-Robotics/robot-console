---
id: '010'
title: 'UI truthfulness: shared link-status text, correct Linked criteria, relay/mbserial
  card state'
status: open
use-cases:
- SUC-007
depends-on:
- '004'
- '006'
- '008'
- '009'
github-issue: ''
issue: bench-relay-and-mbserial-card-text-is-wrong.md
completes_issue: true
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# UI truthfulness: shared link-status text, correct Linked criteria, relay/mbserial card state

## Description

Makes the UI say only what is true (SUC-007), depending on the data-
correctness and transport fixes above (004, 006, 008, 009) since a card
can only render the truth once the state underneath it is truthful.
Evidenced live: the `torture` card read "Connection to gopiv lost:
relayBridger: candidate "radio-tigez-via-mbrelay-torture" produced no
banner within the identify budget" — naming the wrong robot (`gopiv` vs.
`tigez`), showing raw internal ids, and displaying Switch/Disconnect as
if bridging, while `torture`'s own row said "Not seen since ..." despite
advertising right now (link `stale`, ttl-expired, `last_seen` 0 min).
The `vevav` relay card showed "Connection to gopiv lost: Error: No such
file or directory..." while not bridging anything. The `gopiv` mbserial
row gave USB advice ("check the USB cable") for a network-bridge link.
`vevov`'s card showed a green "Linked" pill while not plugged in, its
mbserial link flapping `connected`/`failed` and the bridge never
answering `HELLO`.

Fix, per this sprint's architecture Design Rationale (centralize, don't
patch each component's text independently):

- Add one shared link-status text module (`linkStatusText` /
  `describeLinkFailure` or similar) used by every card/page that renders
  connection state — `DeviceCard`, `RelayPage`, and wherever notice text
  is rendered — instead of each component formatting its own strings.
- The module: (a) names the robot actually attempted, in plain words,
  matched to the transport that failed (USB: cable/power; mbserial:
  "the bridge answered but the robot didn't - is the robot plugged into
  the farm and powered?"; relay radio: "no radio reply - is the robot on
  and in range?"); (b) shows Switch/Disconnect only while a bridge
  session genuinely exists; (c) never reads "Not seen since ..." for a
  link whose underlying service is currently advertised; (d) defines
  "Linked" as: a link is `connected` **and** has a session that has
  answered within the poll window - never merely TCP-connected.

## Acceptance Criteria

- [ ] One shared link-status text module exists and is used by every
      card/page that renders connection or failure state (no component
      formats its own ad hoc status string).
- [ ] A relay bridge-status line names the robot actually attempted (not
      a mismatched name), in plain words, with no raw internal ids
      (link ids, device ids) visible.
- [ ] Switch/Disconnect controls show only while a bridge session
      actually exists; an idle relay's own row never claims "Not seen
      since ..." while it is advertising.
- [ ] Failure advice text matches the transport that actually failed
      (USB vs. mbserial vs. relay radio each get the appropriate plain-
      language reason, not a mismatched one).
- [ ] "Linked" (and any equivalent green-pill indicator) is shown only
      when a link is `connected` with a session that has answered within
      the poll window; a link that accepts TCP but has never answered a
      command is never shown as Linked.
- [ ] Unit tests: the shared text module's output for each transport ×
      failure-reason combination named in the issue's "Expected" list;
      component tests confirming `DeviceCard`/`RelayPage` call the
      shared module rather than formatting text inline.
- [ ] **Harness command and evidence**: `scripts/bench/run.sh --report
      /tmp/bench-report.md` run against the real bench; the Layer 3
      screenshots in the report show, for every card checked: the right
      robot name, no raw internal ids, "Linked" only where a session has
      actually answered, and Switch/Disconnect only where a bridge
      session exists.

## Implementation Plan

**Approach**: introduce the shared text module first, with unit tests
pinning its output for every case in the issue's "Expected" section,
then thread it through `DeviceCard`, `RelayPage`, and the notice
rendering path, replacing their inline text formatting one call site at
a time (small, reviewable diffs per component) rather than a single
large rewrite.

**Files to create**:
- `packages/ui/src/format/linkStatusText.ts` (or similar path matching
  this codebase's existing `packages/ui/src/format`/shared-component
  conventions from sprint 017 tickets 007-008)

**Files to modify**:
- `packages/ui/src/components/DeviceCard.tsx` (or equivalent)
- `packages/ui/src/pages/RelayPage.tsx`
- wherever notice (`type: "notice"`) text is rendered
- the "Linked" / connected-pill logic, wherever it currently checks only
  `state === "connected"` without the session-answered condition

**Testing plan**: `vitest` unit tests for `linkStatusText.ts` covering
every transport × failure-reason pair the issue names; component tests
(`DeviceCard.test.tsx`, `RelayPage.test.tsx`) confirming the shared
module is called and its output rendered, plus a "Linked requires a
session that has answered" test using a FakeSocket snapshot fixture.
Scoped run: `npx vitest run packages/ui`. Bench pass per the harness
command above.

**Documentation updates**: none beyond this ticket's completion notes.
