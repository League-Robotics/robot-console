---
id: '011'
title: 'Full-bench gate: harness green across every reachable path'
status: done
use-cases:
- SUC-001
depends-on:
- '004'
- '005'
- '006'
- '007'
- 008
- 009
- '010'
- '012'
github-issue: ''
issue: ''
completes_issue: true
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Full-bench gate: harness green across every reachable path

## Description

This sprint's exit gate, mirroring the shape and rigor of sprints
015/016/017's own final bench-verification tickets. Every prior ticket
in this sprint lands its own harness evidence for its specific fix; this
ticket runs the full three-layer harness once more, across the whole
bench, to confirm nothing regressed and every path this sprint set out
to fix now passes (or is honestly recorded as environment-blocked).

**Precondition**: `npm run dev` and any other harness run stopped
(the harness's own exclusivity check, ticket 001, enforces this).

**Paths to check** (per this sprint's Success Criteria and Scope):
- USB: `tovez` (and any other USB-attached robot/relay on the bench).
- WiFi: `gopiv` and `vevov`.
- Farm mbserial: `gopiv` (via `loki`), `tigez` (via `magni`), and
  `vevov` (via `hodr`) if reachable.
- Radio via `torture`: `vevov` and `gopiv` (the two names `torture`
  reaches per this sprint's bench facts); `tovez`/`tigez` recorded as
  Layer-1-unreachable, not re-investigated.
- Radio via a host-attached relay (e.g. a USB relay bridging to a
  radio-reachable robot), per UC-016's failover path.

No firmware flashing. No motion/drive verbs — motion stays out of scope
for this whole sprint.

## Acceptance Criteria

- [x] Full `scripts/bench/run.sh` run against the complete bench
      produces one report covering every path listed above.
- [x] USB `tovez` passes Layer 2 and Layer 3, or is recorded as
      Layer-1-unreachable with evidence.
- [ ] WiFi `gopiv` and `vevov` pass Layer 2 and Layer 3 (ticket 007's
      fix holds up under the full run, not just its own isolated bench
      pass).

      **NOT MET — recorded, not silently accepted.** `gopiv / wifi`
      passes L1 and L2 and fails L3 ("no live-snapshot link of transport
      'wifi' found"). `vevov` has no WiFi path in the run at all: per
      the fleet migration plan's own §7 robot table it has **no working
      ESP module** ("80 s over magni: empty `reply=` for every AT
      command, `wifi=0` in all STATUS lines"), which is a hardware fact,
      not a regression of 007. `tigez / wifi` fails the same way in the
      final run — though it **passed** in the team-lead's earlier run
      the same evening, which is itself the signature of the defect
      (discovery arriving or not depending on where the announcement
      interval falls). All of this is ticket 012's deferred mDNS
      discovery defect, routed per the gate bullet below.
- [x] Farm mbserial `gopiv` (via `loki`) and `tigez` (via `magni`) pass
      Layer 2 and Layer 3 (ticket 008's fix holds up).
- [x] Radio via `torture` to `vevov` and `gopiv` pass Layer 2 and Layer
      3 (ticket 009's fix holds up); `torture` to `tovez`/`tigez` is
      recorded as Layer-1-unreachable, consistent with this sprint's
      Scope.
- [ ] Radio via a host-attached relay to a radio-reachable robot passes
      Layer 2 and Layer 3.

      **NOT MET — environment, not a defect.** There were **no USB
      serial devices attached to this Mac** during either run
      (`/dev/cu.usbmodem*` empty; `ioreg` reports `AppleUSBSerial = 0`),
      so both Mac USB relays (`vitut`, `vevav`) were off the bus and no
      host-attached relay existed to bridge through. `vitut` and `tovez`
      show in the console's own "Not seen recently" group, and their
      `radio-via-mbrelay:torture` rows are labeled `environment`
      ("timeout: no radio reply"). UC-016's failover path is therefore
      **unverified by this sprint** — carried forward as a known gap,
      and the first thing to re-check once a USB relay is plugged back
      in.
- [x] Every card checked in the Layer 3 screenshots shows truthful text
      per ticket 010 (right robot name, no raw ids, correct Linked
      state).
- [x] Any path that still fails Layer 2 or 3 (not just Layer 1) is
      thrown back to the team-lead as a defect found late, not silently
      accepted — this ticket is a gate, not a formality.
- [x] **Harness command and evidence**: `scripts/bench/run.sh --report
      /tmp/bench-final-report.md` run against the complete real bench;
      the full report is attached to this ticket's completion notes as
      the sprint's closing evidence, superseding each individual
      ticket's own narrower report run.

## Implementation Plan

**Approach**: no code changes expected — this is a verification ticket,
matching the precedent of sprints 015/016/017's own final bench tickets
("no files to modify expected... If the bench pass surfaces a real
defect, it is fixed here directly (small fix) or thrown back as an
exception... per the sprint-planner's exception protocol").

**Files to modify**: none expected.

**Testing plan**: the full `scripts/bench/run.sh` run is the test. If a
path that passed its own ticket's isolated bench check now fails under
the full run (e.g. a resource-contention interaction between fixes),
investigate and fix directly if small, or throw an exception if
structural.

**Documentation updates**: this ticket's own completion notes record the
full report, mirroring sprint 015/016/017's "Bench evidence" precedent,
so a future sprint has one place to see the state of every path at this
sprint's close.


## Gate result (team-lead, 2026-09-17)

The gate ran twice on a genuinely exclusive bench — the stakeholder
stopped his own `npm run dev` (pid 38933) for it. Both reports record
**0 skipped, 0 contention** in their "Holders / skips" section.

**Run 1 (team-lead)** — `scripts/bench/run.sh --report
<scratchpad>/bench-final-report.md`, L1 22:45:43Z → L3 22:48:54Z.
10 rows: 4 pass, 4 defect, 2 environment.

Three of those four "defects" turned out to be **one stale harness
driver, not a product defect**: `gopiv`, `tigez` and `vevov`
`radio-via-mbrelay:torture` each failed L3 with the identical `relay
card "torture" has no robot picker`, while passing L1 and L2 — i.e. the
radio path itself worked end to end. Cause: the front-page relay card's
robot picker was deliberately retired 2026-09-14
(`RelayConnectControls.tsx:35`, `FrontPage.tsx`'s `RelayBridgeStatus`:
"connections are made from a robot's radio chip, never here"), and
`scripts/bench/layer3/uiDriver.ts` still drove the retired control.
Fixed under this ticket per its own Implementation Plan ("fixed here
directly (small fix)"): commit **`342ceec`**, rewriting the driver's
relay branch to press the robot's own `device-radio-toggle-<deviceId>`
chip, keeping the 018-007 Step 0 sibling-link close and the
`findRadioChildLink(..., via.relayLinkId)` resolution intact. Product
code (`packages/*`) was deliberately **not** touched — verified by the
team-lead against the commit's own file list. The programmer also caught
a screenshot-filename collision introduced by their first draft (the
radio "before" shot overwriting the mbserial one in a shared screenshot
dir) and renamed it.

**Run 2 (final, post-fix)** — `scripts/bench/run.sh --report
<scratchpad>/bench-018-011-report-v2.md`, L1 23:01:21Z → L3 23:03:25Z.
10 rows: **6 pass, 2 defect, 2 environment, 0 skipped, 0 contention.**

| device | path | L1 | L2 | L3 |
| --- | --- | --- | --- | --- |
| gopiv | mbserial | pass | pass | **pass** |
| gopiv | radio-via-mbrelay:torture | pass | pass | **pass** |
| gopiv | wifi | pass | pass | fail (defect — ticket 012) |
| tigez | mbserial | pass | pass | **pass** |
| tigez | radio-via-mbrelay:torture | pass | pass | **pass** |
| tigez | wifi | pass | pass | fail (defect — ticket 012) |
| tovez | radio-via-mbrelay:torture | fail | n/a | n/a (environment) |
| vevov | mbserial | pass | pass | **pass** |
| vevov | radio-via-mbrelay:torture | pass | pass | **pass** |
| vitut | radio-via-mbrelay:torture | fail | n/a | n/a (environment) |

Team-lead verification of the headline claim, not taken on report:
`02-gopiv-radio-via-mbrelay-torture-…-final.png` shows the robot page
header reading **`Radio · ch12/grp30 (via relay torture)  Linked`** with
`« id diffdrive calc 1.20260914.1 gopiv` in the console — a real reply
over the radio path, and `ch12/grp30` is gopiv's **new 73-map pair**,
so 018-019's map is confirmed live on the bench as well.

**Defects thrown back, per this ticket's gate bullet** — not silently
accepted:
- The WiFi L3 failures (`gopiv`, and `tigez` intermittently) are ticket
  012's mDNS discovery defect. Ticket 012 was retired from this sprint
  at the stakeholder's direction with no implementation; both of its
  issues are back in the pool
  (`bench-wifi-robot-discovery-waits-for-announcement.md`,
  `bench-relay-port-contention-sweeper-vs-session.md`) carrying this
  run's evidence, for the next sprint. **`tigez` should be added to
  that issue's scope** — it was not named in the original report and
  its intermittency is useful evidence.
- `tovez` and `vitut` radio rows: `environment`, consistent with this
  sprint's own Scope.

**Closing with two bullets unmet** (both annotated above): the WiFi
bullet, and the host-attached-relay bullet. Neither is a silent pass —
the first is a deferred, ticketed defect plus a dead ESP module, the
second is absent hardware. Every path that *could* be exercised on this
bench passes all three layers.

**Bench facts worth carrying forward** (the fleet has moved since this
sprint was planned): no USB serial devices are attached at all;
`192.168.1.193` (gopiv) and `192.168.1.184` (vevov) do not answer ICMP,
while `tigez` now has a WiFi path that works when discovery finds it;
`torture`, `loki`, `magni`, `hodr` and `meili` are all up. Also noted in
passing on gopiv's radio page: `Moving: Yes` with `I2C faults 2867`
while no motion verb was ever sent — not investigated (motion is out of
this sprint's scope) but worth a look.

**Evidence paths**: report 1 `<scratchpad>/bench-final-report.md` +
`bench-final-report-screenshots/bench-run.8NVIz7/`; report 2
`<scratchpad>/bench-018-011-report-v2.md` +
`bench-018-011-report-v2-screenshots/bench-run.7GR9kO/`. Scoped tests
`npx vitest run scripts/bench` (245 passed) and `npm run typecheck`
green in the foreground.
