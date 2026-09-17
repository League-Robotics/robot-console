---
id: '002'
title: 'Bench harness Layer 2: host-over-WebSocket session checks and card-truthfulness
  assertions'
status: done
use-cases:
- SUC-001
depends-on:
- '001'
github-issue: ''
issue: bench-layered-connection-test-harness.md
completes_issue: false
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Bench harness Layer 2: host-over-WebSocket session checks and card-truthfulness assertions

## Description

Second layer of the harness (SUC-001), consuming ticket 001's Layer 1
reachability report. Build `scripts/bench/layer2/`:

- Start (or attach to) a real host process on a fresh state dir
  (optionally seeded from a copy of the real `known-robots.json`, never
  the live file itself).
- Wait for the watchers to settle (poll the snapshot until it stops
  changing across a few seconds, matching sprint 015 ticket 011's own
  bench precedent for "settled").
- For every path Layer 1 marked reachable: `session-open`, `send-command
  ID`, expect the matching `line` rx reply, `session-close`. Record
  pass/fail and the exact reply.
- **Card-truthfulness assertions**, read directly from the snapshot (no
  UI needed for these): no link is `stale`/absent while its underlying
  service is currently advertised (services table `last_seen` fresh);
  no device has `kind: "robot"` while its role/banner history says
  relay; exactly one `devices` row per device name (no duplicates).
- Reuse ticket 001's exclusivity check before running.

This layer is the one every later defect-fix ticket (004-010) is
checked against for its Layer 2 half of the acceptance discipline.

## Acceptance Criteria

- [x] `scripts/bench/layer2` starts a real host against a fresh/seeded
      state dir, waits for settle, and for each Layer-1-reachable path
      performs `session-open` → `send-command ID` → assert `line` reply
      → `session-close`, recording pass/fail per path.
- [x] The three card-truthfulness assertions (no stale-while-advertising,
      no relay with `kind: robot`, one row per name) run against the
      live snapshot and are reported per-device, not just as one
      pass/fail for the whole run.
- [x] Refuses to run non-exclusively (reuses ticket 001's `lsof` check).
- [x] **Harness command and evidence**: `node scripts/bench/layer2/run.js
      --state-dir <scratch-dir> --out /tmp/bench-layer2.json` run
      against the real bench with at least one USB device attached;
      the JSON output (attached to this ticket's completion notes) shows
      at least one path passing session-open/send-command/session-close
      and the three card-truthfulness assertions evaluated (pass or
      fail, each with a reason) against the real live snapshot.

## Implementation Plan

**Approach**: a thin `ws` client (matching the pattern used in prior
sprints' own bench scratch scripts, e.g. sprint 015 ticket 011's
`wsclient.mjs`, but committed and structured this time) plus a small
assertion library reading the `Snapshot` shape directly — no new host
API, this only calls the existing WebSocket contract from
`docs/design/architecture.md` §9.

**Files to create**:
- `scripts/bench/layer2/wsClient.ts` (open/send-command/close helpers)
- `scripts/bench/layer2/pathChecks.ts` (per-path session round-trip)
- `scripts/bench/layer2/truthfulness.ts` (the three snapshot assertions)
- `scripts/bench/layer2/index.ts` (orchestrates: start/attach host, wait
  settle, run path checks + assertions, write JSON)

**Files to modify**: none in `packages/*`.

**Testing plan**: `vitest` coverage for `truthfulness.ts`'s three
assertions against fixture snapshots (one fixture per violation, one
clean fixture); the live host run is this ticket's bench evidence.

**Documentation updates**: extend `scripts/bench/README.md` with Layer
2's usage and its assertions.

## Completion Notes (2026-09-13)

**Step 0 — two Layer 1 gaps fixed first** (separate commit
`fix(bench): 018-002 Layer 1 WiFi paths and relay data-plane
detection`):

1. **No `wifi` path rows at all.** Root-caused live: `bonjour-service`'s
   `_robotlink._tcp`/`_udp` browse produced zero `up` events within the
   original 4s window even though `dns-sd -B _robotlink._tcp local.`
   showed `gopiv`/`vevov` advertising it continuously. Direct
   instrumentation of the underlying `multicast-dns` socket showed why:
   unlike the farm's Avahi-based `_mbserial`/`_mbrelay` responders
   (instant reply to a fresh PTR query), these robots only ever emit
   **unsolicited periodic announcements** (observed live at +23s and
   +50s in a 75s capture) and never answer an on-demand query at all —
   `dns-sd`/`dns.lookup` only return instantly because macOS's own
   long-running `mDNSResponder` already caches those announcements.
   `mdnsBrowse.ts`'s `browseServices()` now gives `_robotlink` up to an
   extra 65s (only when nothing has appeared yet) before giving up. The
   TXT `name=` → robot-name mapping was already correct.
2. **A relay parked in the data plane after a host `!GO`** forwards
   `HELLO` over radio and never answers directly. `usbProbe.ts` now
   performs one UART break-reset (`port.set({brk:true})` ~250ms then
   `{brk:false}`, matching `serialStream.ts`'s own `sendBreak`) on a
   `HELLO` timeout, waits ~1.5s, and retries `HELLO`/`?` once, recording
   the outcome as its own transcript segment.
3. **A misclassification bug the first live re-run itself exposed**:
   `index.ts` derived a USB device's `kind` by substring-matching
   `"relay"` in `result.reason`, which the new break-reset failure text
   ("relay may be parked in the data plane") false-positived even when
   no banner was ever captured. Fixed: classification now reads only
   the actual captured banner transcript line, extracted into a pure,
   tested `classifyUsbDevice()`.

**Layer 2 implementation**: `scripts/bench/layer2/{types,wsClient,
pathChecks,truthfulness,index}.ts`. `packages/host/src/cli.ts` gained
`--no-open`/`ROBOT_CONSOLE_NO_OPEN` (no existing flag suppressed the
browser launch; needed so a headless bench run never tries to open a
desktop browser), tested in `cli.test.ts`. Root `package.json` gained
`bench:layer2` and explicit `ws`/`@types/ws` devDependencies (already
transitively installed via `@robot-console/host`, now declared
explicitly for `scripts/`'s own use, matching ticket 001's precedent).
`scripts/bench/README.md` extended with Layer 2's usage/module map.

**Layer 2 runs the actual shipped host** (`bin/robot-console.js`, which
dynamically imports `packages/host/dist/cli.js` and calls `main()` —
*not* `dist/cli.js` directly, which only exports `main` and never calls
it itself; spawning it directly loads the module and exits immediately
with nothing listening, caught live while building this ticket and
fixed before the first successful run), against a fresh state dir
seeded with a read-only copy of the real `known-robots.json`.

**Settle**: `wsClient.ts`'s `waitForSettle` polls the snapshot stream,
fingerprinting every link's `(device, transport, id, state)` and
declaring settled once that fingerprint has not changed for 5s
(matching sprint 015 ticket 011's own "state identical across seq 29
through seq 177" precedent), bounded at 90s. Correct even when no
further snapshot ever arrives (silence for the full stability window is
itself settlement, not a stall) — covered by `wsClient.test.ts` against
a scripted fake driver, no real socket.

**Exclusivity**: reuses `layer1/exclusivity.ts`'s `findHolders`/
`evaluateExclusivity` directly against every resource a
Layer-1-reachable path's own `endpoint` names — same default-refuse /
`--skip-held` contract, same "never kill or signal a holder" rule.

**Tests**: 125 passed across 15 files in `scripts/bench`
(`npx vitest run scripts/bench`) — `truthfulness.ts`'s three assertions
against the ticket's own four fixture shapes (clean, stale-while-
advertised, relay-as-robot, duplicate names), `wsClient.ts`'s
`fingerprintSnapshot`/`waitForSettle` against scripted fake drivers
(including the "total silence = settled" and "never stabilizes by the
bound" edge cases), `pathChecks.ts`'s link-resolution helpers
(`resolveOpenPayload`/`findLinkById`/`findRadioChildLink`) against
snapshot fixtures, `index.ts`'s `parseArgs`/`targetForPath`/
`resourceForEndpoint` — no live hardware in any of these. `npx vitest
run packages/host/src/cli.test.ts`: 11 passed, including the two new
`--no-open`/`ROBOT_CONSOLE_NO_OPEN` cases. `npm run typecheck` clean.

**Live bench evidence** (real bench, 2026-09-13, `--skip-held` —
`/dev/cu.usbmodem2121102` and `192.168.1.184:7654` held by the
stakeholder's `npm run dev`, pid 82496, throughout). Layer 1 re-run
first (`npm run bench:layer1`), then Layer 2 against it
(`npx tsx scripts/bench/layer2/index.ts --skip-held --layer1
<l1.json> --out <l2.json> --state-dir <scratch> --port 4799`), host
started as `node bin/robot-console.js --port 4799 --no-open`. Settled
after 10953ms.

| device | path | L1 | L2 | L2 reason (verbatim) |
|---|---|---|---|---|
| gopiv | mbserial | pass | **pass** | session-open -> connected -> send-command ID -> matching line rx -> session-close (reply: id diffdrive calibration-0.20260913.1 1.20260912.8 gopiv) |
| tigez | mbserial | pass | **fail** | never reached state "connected" with a session within 15000ms -- last seen state "failed" (connector: link "mbserial-tigez" produced no banner within the identify budget) |
| vevov | mbserial | pass | **pass** | session-open -> connected -> send-command ID -> matching line rx -> session-close (reply: id diffdrive calibration-0.20260913.1 1.20260912.8 vevov) |
| vevov | radio-via-mbrelay:torture | pass | **pass** | session-open -> connected -> send-command ID -> matching line rx -> session-close (reply: id diffdrive calibration-0.20260913.1 1.20260912.8 vevov) |
| vitut | usb | pass | **fail** | never reached state "connected" with a session within 15000ms -- last seen state "failed" (Error Resource temporarily unavailable Cannot lock port) |

**Layer 2 failures found** (recorded faithfully, not worked around —
these are the sprint's own defects for tickets 004-010 to fix):
- `tigez` via `mbserial`: Layer 1's raw wire probe got a clean banner +
  ID reply directly, but the host's own connector never identified it
  within its 15s budget ("produced no banner within the identify
  budget") — a host-side connector defect, not an environment fact.
- `vitut` via `usb`: Layer 1 opened, `HELLO`'d, and closed the same port
  cleanly; the host's own connector then failed to open it at all
  ("Cannot lock port") — likely the host's USB watcher already holding
  the port for identification when `session-open` triggers a second,
  colliding open attempt.

**Card-truthfulness assertions**: all 17 (7 devices × up to 3 assertions
present that run) passed clean on this live snapshot — no stale-while-
advertised, no relay recorded `kind: "robot"`, exactly one `devices` row
per name (`torture`, `vevav`, `vevov`, `gopiv`, `vitut`, `tovez`,
`tigez`). No card-truthfulness violation reproduced on this run (the
sprint 015 ticket 011 duplicate-`vevov`-row defect the bench facts
describe did not reproduce here — `vevav`/`vevov` each had exactly one
row this session).

Full JSON:
`/private/tmp/claude-501/-Volumes-Proj-proj-league-projects-microbit-robot-console/2adee9e5-9c06-4d70-bfc8-e8df62ded3f1/scratchpad/bench-layer1.json`,
`/private/tmp/claude-501/-Volumes-Proj-proj-league-projects-microbit-robot-console/2adee9e5-9c06-4d70-bfc8-e8df62ded3f1/scratchpad/bench-layer2.json`

The host process this run started was killed (`SIGTERM`, in a
`finally`) on completion; no other process was touched. Verified clean
afterward (`lsof -nP -iTCP:4799` empty, no lingering
`bin/robot-console.js` process).
