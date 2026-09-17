---
id: '003'
title: 'Bench harness Layer 3: headless Chrome pass and the per-robot x path report'
status: done
use-cases:
- SUC-001
depends-on:
- '002'
github-issue: ''
issue: bench-layered-connection-test-harness.md
completes_issue: true
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Bench harness Layer 3: headless Chrome pass and the per-robot x path report

## Description

Third and final layer of the harness (SUC-001), completing the harness
issue. Build `scripts/bench/layer3/` (Playwright, headless Chrome
against the real built UI, `packages/ui/dist`, served by the same host
Layer 2 started) and the report generator that ties all three layers
together into the one Markdown report every other ticket in this sprint
cites as evidence.

- For each path Layer 1 found reachable and Layer 2 attempted: load the
  UI, click Connect (or the card's arrow), type `ID` in the console,
  expect the reply to appear; assert enabled controls only on a
  genuinely `Linked` page; assert card text is plain language and names
  the right robot (no raw internal ids); screenshot every page checked.
- **Report generator**: one Markdown file, one row per robot × path,
  columns for Layer 1/2/3 pass-fail, the failure reason when failing,
  and links to screenshots. A path failing only Layer 1 is labeled
  "environment"; a path passing Layer 1 but failing Layer 2 or 3 is
  labeled a defect, per the issue's own framing.
- Reuses tickets 001/002's exclusivity check and Layer 1/2 outputs as
  input.

## Acceptance Criteria

- [x] `scripts/bench/layer3` drives the real built UI in headless
      Chrome for every Layer-2-attempted path: Connect, type `ID`,
      assert the reply appears in the console.
- [x] Asserts enabled controls only on a page the snapshot says is
      actually `Linked` (not merely `connecting` or TCP-connected).
- [x] Screenshots every page checked, saved under a path the report can
      link to.
- [x] The report generator produces one committed-format Markdown file
      with one row per robot × path and Layer 1/2/3 pass-fail, failure
      reasons, and screenshot links — this is the artifact every
      subsequent ticket in this sprint (004-011) cites as its harness
      evidence.
- [x] **Harness command and evidence**: `scripts/bench/run.sh
      --report /tmp/bench-report.md` (the full three-layer run) against
      the real bench; the generated report is attached to this ticket's
      completion notes, showing at least one full robot × path row
      passing all three layers end to end (e.g. USB to a relay-flashed
      board on the hub).

## Implementation Plan

**Approach**: Playwright (already installed per sprint 015 ticket 011's
own bench evidence — `~/Library/Caches/ms-playwright` has Chromium)
driving the production build, not a dev server; the report generator is
a small Markdown templater reading Layer 1/2's JSON plus its own Layer 3
results.

**Files to create**:
- `scripts/bench/layer3/uiDriver.ts` (Playwright: load, Connect, type,
  assert, screenshot)
- `scripts/bench/layer3/index.ts`
- `scripts/bench/report/generate.ts` (Layer 1+2+3 JSON → Markdown report)
- `scripts/bench/run.sh` (the one committed entry point: exclusivity
  check, build the UI if needed, run Layer 1 → 2 → 3, generate report)

**Files to modify**: none in `packages/*`.

**Testing plan**: `vitest` coverage for the report generator (fixture
Layer 1/2/3 JSON → expected Markdown, including the
environment-vs-defect labeling rule); the live Playwright run against
real hardware is this ticket's bench evidence and cannot be meaningfully
faked in CI.

**Documentation updates**: `scripts/bench/README.md` gets the full
three-layer usage, the exclusivity requirement, and the report format,
since this becomes the standing reference every future ticket in this
sprint (and beyond) points back to.

## Completion Notes (2026-09-13)

### Step 0 — Layer 1/2 hardening (commit `fix(bench): 018-003 harden
Layer 1/2`)

1. **Torture flake, root-caused and fixed.** `runCommandPlaneSweep`
   treated any `< ...` line as the definitive reply to its own
   `> HELLO`, so a stale echo of an earlier, unrelated unprefixed
   data-plane command (or a reply meant for a previous name's
   already-timed-out request) could be misattributed — live-verified as
   `pass-through reply did not parse as a banner: "ID"` for gopiv, one
   run after the identical request passed cleanly.
   `classifyRadioSweepReplies`/`sweepOneName` (`layer1/mbrelayProbe.ts`)
   now skip stale echoes within the same window and tolerate one lost
   radio packet with a bounded resend. **Live re-check, 5 runs each,
   post-fix**: gopiv 5/5 pass; vevov 4/5 pass — the one vevov failure
   was a distinct `!CG` tune-confirmation timeout (`"could not tune to
   37/43: timeout (2500ms) waiting for confirmation"`), not the original
   echo/misattribution flake, which did not reproduce across all 10
   runs.
2. **WiFi coverage.** `_robotlink` is periodic-announcement-only
   (`mdnsBrowse.ts`'s own doc comment) — a robot whose next announcement
   hadn't landed within one run's browse window went missing from the
   report entirely. `layer1/wifiNameLookup.ts` resolves every known
   name's own `<name>.local` directly (bounded, ~8s) and probes TCP
   7654 after the mDNS pass; a row found this way is marked "found by
   name lookup, not announcement". Live: gopiv and vevov (when not held
   by the stakeholder's own `npm run dev`) both answered this way on
   at least one run.
3. **`assertNoRelayAsRobot` strengthened** — it was passing vacuously
   ("vevav: kind robot consistent with role (none)"). Now also fires
   from Layer 1's own banner-based `kind:"relay"` classification or a
   link's own reason/history mentioning a relay banner, and flags a USB
   device with `kind:"robot"` and `role: null` as "unidentified,
   recorded as robot". Live: `vevav` and `tovez` both now correctly
   fail this assertion every run.
4. **`--audit-db <path>`**: copies a real `console.sqlite` (+`-wal`/
   `-shm`) read-only into scratch and checks one-row-per-name,
   relay-as-robot, would-be-hidden radio links, and USB-path-mismatch.
   Run against a copy of the stakeholder's real database, it reproduced
   every screenshot defect: duplicate `gopiv` rows (ids **1461**,
   **2175407711**), `vevav` recorded `kind:"robot"` with role
   `RADIOBRIDGE`, and stale radio links through relay ids containing
   `2e78` (~2.8-3h old at run time, all past the 180s TTL), including a
   `usb-path-mismatch` (a link's `state_reason` naming
   `/dev/cu.usbmodem2121202` while its relay currently reports
   `/dev/cu.usbmodem2121402`).
5. **vevav DAPLink reset**: `layer1/hidReset.ts` adds an opt-in
   (`--hid-reset-silent-relays`, off by default) vendor-command HID
   reset for a USB device that never banners even after the existing
   break-reset retry, importing the compiled `packages/host/dist/
   {devices,flash}.js` (`resetViaDapLink`/`enumerateDaplinkDevices`) —
   the one deliberate exception to this harness's "no host internals"
   rule, since a vendor HID reset protocol isn't wire-level logic worth
   reimplementing. Not exercised against real hardware in the live runs
   below (vevav was not the specific silent device on this bench
   session; no run needed the flag to reach its evidence).

### Step 1 — Layer 3, report generator, `run.sh` (commit `feat(bench):
018-003 Layer 3 Chrome pass and three-layer report`)

Built `scripts/bench/layer3/{uiDriver,index,types}.ts` (Playwright via
`playwright-core`'s bundled Chromium), `scripts/bench/report/
generate.ts`, and `scripts/bench/run.sh`. Three real bugs were found and
fixed against the live bench while building this (not guessed from
source — see `uiDriver.ts`'s own doc comments for each): a relay card's
Connect/Switch button locator matching its own Disconnect button once a
bridge already had a child; reaching a robot page via `page.goto(href)`
dropping and re-establishing the WebSocket connection (producing a false
"not Linked"), fixed by clicking the link element directly instead; and
a direct-transport path's own row never showing an open arrow when that
link is the card's "primary" link (the arrow is the card's own
top-level one instead) — the driver now checks both shapes. Also,
`looksLinked` was changed from a `\b`-bounded regex to a plain substring
check, since `innerText()` concatenates adjacent header text with no
whitespace in between (`"...36627Linked"`).

**Live bench evidence** (`scripts/bench/run.sh --skip-held --audit-db
<scratch copy of the real console.sqlite> --report
.../scratchpad/bench-report.md`, real hardware, 2026-09-13):

| device | path | L1 | L2 | L3 | label | reason |
| --- | --- | --- | --- | --- | --- | --- |
| 99063602...e052820 | usb | fail | n/a | n/a | environment | no banner -- relay may be parked in the data plane; retried HELLO after break-reset but still no banner |
| 9906360200052820a8f...052820 | usb | skipped | n/a | n/a | skipped | held by pid 82496 (node) |
| gopiv | mbserial | pass | pass | **pass** | **pass** | - |
| gopiv | radio-via-mbrelay:torture | pass | pass | **pass** | **pass** | - |
| gopiv | wifi | pass | fail | fail | defect | no link found in the snapshot for gopiv via wifi |
| tigez | mbserial | fail | n/a | n/a | environment | timeout waiting 3000ms for a HELLO reply |
| tigez | radio-via-mbrelay:torture | fail | n/a | n/a | environment | timeout: no radio reply (unreachable via this pool, per Scope) |
| tovez | radio-via-mbrelay:torture | fail | n/a | n/a | environment | timeout: no radio reply (unreachable via this pool, per Scope) |
| vevov | mbserial | pass | pass | **pass** | **pass** | - |
| vevov | radio-via-mbrelay:torture | pass | pass | **pass** | **pass** | - |
| vevov | wifi | skipped | n/a | n/a | skipped | held by pid 82496 (node) |
| vitut | radio-via-mbrelay:torture | fail | n/a | n/a | environment | timeout: no radio reply (unreachable via this pool, per Scope) |
| vitut | usb | pass | fail | fail | defect | connected, but no "line" rx matching "id " within 5000ms |

13 rows: **4 pass** (all three layers, end to end), 2 defect, 5
environment, 2 skipped. `gopiv`/`vevov` mbserial and
radio-via-mbrelay:torture each reached `Linked`, answered `ID` within
5s, showed no enabled drive/send control anywhere it shouldn't, no raw
internal id in any page's text, and (radio paths) the relay card
correctly named the robot actually attempted. Full JSON/screenshots
under the run's own kept work dir (`bench-run.xjUQF4` at report-
generation time); Markdown report:
`/private/tmp/claude-501/-Volumes-Proj-proj-league-projects-microbit-robot-console/2adee9e5-9c06-4d70-bfc8-e8df62ded3f1/scratchpad/bench-report.md`.

The `gopiv`/`wifi` and `vitut`/`usb` failures are recorded faithfully,
not worked around — they are tickets 007/008/009's own targets, not
this ticket's to fix.

**Tests**: 206 passing (`npx vitest run scripts/bench`); `npm run
typecheck` clean.

**Files**: `scripts/bench/layer1/{mbrelayProbe,index}.ts` (+tests),
`scripts/bench/layer1/wifiNameLookup.ts` (+test),
`scripts/bench/layer1/hidReset.ts` (+test),
`scripts/bench/layer2/{truthfulness,index}.ts` (+tests),
`scripts/bench/layer2/auditDb.ts` (+test),
`scripts/bench/layer2/types.ts`, `scripts/bench/layer3/{uiDriver,index,
types}.ts` (+tests), `scripts/bench/report/generate.ts` (+test),
`scripts/bench/run.sh`, `scripts/bench/README.md`, `package.json`/
`package-lock.json` (added `playwright-core`, `bench:layer3` script).
