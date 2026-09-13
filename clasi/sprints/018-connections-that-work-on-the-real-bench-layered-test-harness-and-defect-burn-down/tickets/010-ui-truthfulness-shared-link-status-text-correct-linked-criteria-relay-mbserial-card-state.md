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

      **Third pass, 2026-09-13**: team-lead review of the second pass's
      own screenshots found four more defects, all fixed this pass: (1)
      `relay_leases`/`board_owner`/`sessions` rows and a `links.state` of
      `connecting`/`connected` all describe something only the *running*
      process can be doing, but survive a crash/restart as plain SQLite
      rows -- confirmed live, not hypothetically: the seed copy used for
      this pass's own evidence run still carried a `relay_leases`
      `{owner: "sweep"}` row on `vitut`'s own connectivity link from the
      stakeholder's still-running `npm run dev` (pid 12415), which a
      pre-fix host would have rendered as "idle · sweeping (slow)"
      exactly as the bug report described. New `Store.
      deadProcessStateRows()` (`packages/host/src/store/index.ts`) plus
      `store/repair/clearDeadProcessState.ts`, wired into `openStore()`
      (run first, before the three existing repairs) release every
      `board_owner`/`relay_leases` row by its own current owner, close
      every open `sessions` row, and reset any `connecting`/`connected`
      link to `connectable` -- the last of these also fixes a real
      reconciler defect, not just display: `connect/reconciler.ts`'s own
      `deviceHasActiveLink` treats both states as "already connected",
      so a stale one blocked reconnection forever, not merely
      mislabeled. `fastSweepByRelayLinkId` (the sweep-rate capability
      flag) is deliberately left untouched -- it is a hardware fact, not
      a liveness claim; see `clearDeadProcessState.ts`'s own doc comment.
      (2) `AppHeader`'s relay-link branch no longer runs through the
      session-based robot text at all -- `torture` used to read "No
      open session on this link" plus a Connect button, both
      meaningless for a relay; a robot link with no session now reads
      plain "Not connected" (the stakeholder's own rejection of the old
      wording), and a surviving-session failure reason is always routed
      through `plainFailureReason` (no raw reasons). New
      `relayConnectionStatusText`/updated `connectionStatusText` in
      `AppHeader.tsx`. (3) `AppHeader.css` gained actual layout for
      `.app-header-connection` (flex, gap) -- label/state/button/link had
      no separating CSS at all before this pass. (4) `FlashDialog`'s
      `forceShow` on the header is now `link.transport === "usb"` only --
      `server.ts`'s own `runFlashTask` refuses any other transport
      outright ("flashing requires a directly attached USB link"), so
      unconditional `forceShow` was offering a trigger that could never
      work on `torture` (mbrelay/TCP) or any WiFi robot link.

      Tests: `packages/host/src/store/repair/clearDeadProcessState.test.ts`
      (new, 8 cases) plus a new `openStore` wiring test in
      `packages/host/src/store/index.test.ts`; new/updated cases in
      `packages/ui/src/components/AppHeader.test.tsx` (relay text, Flash
      gating by transport, reworded "Not connected"/cleaned-reason
      cases). Full required scope (`packages/ui
      packages/host/src/projection.test.ts packages/host/src/store
      packages/host/src/connect packages/host/src/watchers scripts/bench`)
      1266 passed; `npm run typecheck`, `npm run vite:build -w
      @robot-console/ui`, `npm run build` all clean.

      Evidence: a fresh copy of the stakeholder's own live
      `console.sqlite` (+ `-wal`/`-shm`, taken while pid 12415 was still
      running) under `scratchpad/018-010-stakeholder-db-3/`, opened via
      `node bin/robot-console.js --port 18734 --no-open --no-sweep` with
      `ROBOT_CONSOLE_STATE_DIR` pointed at that copy, confirmed via
      `lsof -p <pid>` to hold only the copy's `.sqlite`/`-wal`/`-shm`
      before any screenshot. Direct `sqlite3` reads of the copy before
      start confirmed the real leftover state (a `sweep` relay lease on
      vitut's own link, 5 open `sessions` rows, 3 links `connected`) from
      the still-running stakeholder process; after 30s+ of the new
      host's own uptime the lease/board-owner tables were empty, 4 of 5
      sessions closed (the fifth, `wifi-vevov`, became a genuine new
      session this process itself opened -- WiFi has no single-client
      exclusivity, so this is expected, not contention), and the
      previously-`connected`/`connecting` links read `connectable` with
      `state_reason: "process-restarted"` until the reconciler acted on
      them. Screenshots (visually inspected, quoted in the programmer's
      own return for this pass): `scratchpad/front-page-full-3.png`,
      `scratchpad/relay-page-torture-3.png` (vitut/torture cards read
      plain "idle", not "idle · sweeping (slow)"), `scratchpad/
      relay-page-vitut-3.png`, `scratchpad/robot-page-gopiv-3.png`,
      `scratchpad/robot-page-vevov-mbserial-3.png` (a robot page with no
      session, per this ticket's own acceptance-evidence requirement).
      Real bench-network contention (mbserial `gopiv`/`tigez` against
      the stakeholder's still-running dev server) rendered as plain text
      ("Couldn't connect: another app is connected to this bridge ·
      retrying in Ns"), as expected. Still blocked, unchanged from the
      second pass, on the full `scripts/bench/run.sh` harness run itself
      (same pid-12415 contention) -- this pass's own evidence is again
      the throwaway-copy truthfulness check, not the harness.

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
