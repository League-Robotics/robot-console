---
id: '010'
title: 'UI truthfulness: shared link-status text, correct Linked criteria, relay/mbserial
  card state'
status: in-progress
use-cases:
- SUC-007
depends-on:
- '004'
- '006'
- 008
- 009
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

- [x] One shared link-status text module exists and is used by every
      card/page that renders connection or failure state (no component
      formats its own ad hoc status string).
- [x] A relay bridge-status line names the robot actually attempted (not
      a mismatched name), in plain words, with no raw internal ids
      (link ids, device ids) visible.
- [x] Switch/Disconnect controls show only while a bridge session
      actually exists; an idle relay's own row never claims "Not seen
      since ..." while it is advertising.
- [x] Failure advice text matches the transport that actually failed
      (USB vs. mbserial vs. relay radio each get the appropriate plain-
      language reason, not a mismatched one).
- [x] "Linked" (and any equivalent green-pill indicator) is shown only
      when a link is `connected` with a session that has answered within
      the poll window; a link that accepts TCP but has never answered a
      command is never shown as Linked.
- [x] Unit tests: the shared text module's output for each transport ×
      failure-reason combination named in the issue's "Expected" list;
      component tests confirming `DeviceCard`/`RelayPage` call the
      shared module rather than formatting text inline.
- [ ] **Harness command and evidence**: `scripts/bench/run.sh --report
      /tmp/bench-report.md` run against the real bench; the Layer 3
      screenshots in the report show, for every card checked: the right
      robot name, no raw internal ids, "Linked" only where a session has
      actually answered, and Switch/Disconnect only where a bridge
      session exists.

      **BLOCKED, not met**: run 2026-09-13 (report:
      `scratchpad/018-010-stakeholder-db/../bench-report-010.md`, see
      programmer's own return for the exact path) found the stakeholder's
      own `npm run dev` (pid 12415) holding every network resource the
      five required paths need (gopiv mbserial/wifi, tigez mbserial,
      vevov mbserial; the `torture` radio pool) -- `--skip-held` marked
      all of them "skipped", not "pass" (0 of the 5 required paths were
      actually exercised; only the `vitut` USB relay ran, and it
      genuinely failed L2/L3 on an apparently pre-existing hardware
      issue unrelated to this ticket). Per the "never kill/signal a
      process you didn't start" rule, the harness could not be re-run
      against a clear bench without the stakeholder stopping that
      process first. A separate, non-conflicting truthfulness check DID
      run clean: a host on a throwaway COPY of the stakeholder's real
      `console.sqlite` (`--no-sweep --no-open`, `ROBOT_CONSOLE_STATE_DIR`
      pointed at the copy, verified via `lsof` before screenshotting) --
      every card's text was quoted and inspected; no raw ids, no
      contradictory "Not seen since" on an advertised link, Switch/
      Disconnect only where a session exists, "Linked" only alongside a
      real answered session. See the programmer's own return for the
      full quoted text and screenshot path.

      **Second pass, 2026-09-13 (commit c38fa2c)**: the team-lead found
      the first pass's own evidence screenshot
      (`scratchpad/front-page-full.png`) NOT truthful -- torture/vitut
      showed "lost" banners (one with a raw `ttl-expired` reason) for
      bridges that ended long ago; every card was cluttered with aged/
      stale link rows (including a `tovez` USB row for a port `vitut`
      now physically holds); gopiv's card showed `tigez`'s own radio
      address via a mismatched `device_id`; vevav's card used robot-
      shaped USB advice for a relay, and its `kind` was found to
      actually be `"robot"` in the stakeholder's real store despite
      `role: "RADIOBRIDGE"` (data defect, not just a text bug). All five
      fixed -- `currentRelayChild`/`cardLinks`/`hiddenLinkCount`/
      `plainFailureReason(..., kind)` in `deviceDisplay.ts`,
      `store.upsertLink`'s write-time guard plus two new one-time
      repairs (`repairRadioLinkDeviceAssociation`,
      `repairDeviceKindFromRole`). Still blocked, per this ticket's own
      still-open bullet, on the real-bench harness run (`npm run dev`
      pid 12415 still holds every network resource) -- the same
      throwaway-copy truthfulness check as the first pass, re-run clean
      against this commit: a fresh host (`--no-sweep --no-open`,
      `ROBOT_CONSOLE_STATE_DIR` pointed at a new copy under
      `scratchpad/018-010-stakeholder-db-2/`, verified via `lsof` first)
      rendered `scratchpad/front-page-full-2.png` (visually inspected),
      plus one robot page (`scratchpad/robot-page-gopiv.png`, gopiv) and
      two relay pages (`scratchpad/relay-page-vitut.png`,
      `scratchpad/relay-page-torture.png`). Every card's full text is
      quoted in the programmer's own return for this pass. Confirmed via
      direct DB read: `vevav.kind` is now `"relay"`, and
      `radio-tigez-via-mbrelay-torture.device_id` is now tigez's own id
      (was gopiv's).

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
