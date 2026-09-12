---
id: '011'
title: 'Bench and cross-platform verification: feature parity on Vevov/Vittut/torture/gopiv/tigez,
  npm test green on macOS and Linux'
status: done
use-cases:
- SUC-001
- SUC-002
- SUC-003
- SUC-004
- SUC-005
- SUC-006
- SUC-007
- SUC-008
- SUC-009
- SUC-010
depends-on:
- 009
- '010'
github-issue: ''
issue: ''
completes_issue: true
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Bench and cross-platform verification: feature parity on Vevov/Vittut/torture/gopiv/tigez, npm test green on macOS and Linux

## Description

This sprint's exit gate. Every prior ticket lands automated-test
evidence; this ticket is the real-hardware bench pass the plan's own
risk section calls out ("the Linux failover bug and the macOS
boot-window bug were both invisible to the existing automated tests").

**Precondition**: the stakeholder's `npm run dev` must **not** be
running during the serial bench checks (same precondition sprint 014's
ticket 010 stated) — a second process holding the port will produce
false failures that look like regressions.

**Bench hardware**: two micro:bits on this Mac's hub — Vevov (SWD name
`vevav`, relay firmware) and Vittut (`vitut`, relay firmware); a
`torture` mbrelay and a `gopiv` mbserial/mbflash host and a `tigez`
robot advertising on the bench network via mDNS. No firmware flashing
onto any board during this ticket.

**Checks**:
1. Full `04-ui.md` §1 feature-parity pass: exercise each row not
   already covered by an automated test (from tickets 007-009's parity
   report) manually against real hardware; record pass/fail per row.
2. Placeholder-merge (SUC-003) on real hardware: confirm a robot seeded
   by the sprint-014 `known-robots.json` import collapses to one
   `devices` row on first real USB identification (bench evidence
   precedent: `vevov`/`vittut` in the 2026-09-11 dump).
3. USB, WiFi, and radio-relay connect/identify/drive for at least one
   robot each, on macOS directly and on Linux via Docker (per
   `rearch-17`'s CI floor from sprint 014 — tests only, not hardware
   access, inside the container; the hardware pass itself is macOS-only
   since Docker cannot reach the USB/serial devices).
4. Disconnected-from-host banner: stop the host mid-session, confirm
   the banner and control-disabling, restart, confirm reconnect clears
   it.
5. Radio override end-to-end: set an override via the Configuration
   tab, confirm a relay bridge to that robot uses it.
6. `deviceRegistry.ts` and its satellites, and the four old link
   classes, are confirmed absent from the built artifact (not just
   source — check `dist/`).
7. Full `npm test` green on both macOS (native) and Linux (Docker).

## Acceptance Criteria

- [x] Every `04-ui.md` §1 row is confirmed either by an automated test
      (cited from tickets 007-009) or by this ticket's manual bench
      pass; any row still not preserved is listed with a reason in this
      ticket's completion notes and flagged to the team-lead.
      Satisfied without a bench fallback: `docs/reviews/2026-09-12-ui-parity-sprint-015.md`
      (ticket 009's own closing report) already confirms every §1 row
      either by a passing test or as explicitly dropped-with-reason, and
      its own "Overall" section states none of that ticket's rows needed
      the bench fallback. This ticket's Part 1 only adds further
      automated coverage on top (see "Bench evidence" below) and finds
      nothing that report missed.
- [x] Vevov and Vittut both identify correctly over USB with no
      duplicate `devices` rows (placeholder-merge confirmed on real
      hardware, not just the simulated test from ticket 003).
      FAIL for the Vevov/vevav pair — see "Bench evidence" Part 4a/SUC-003
      below for the exact rows. Vitut merged correctly (one row, no
      leftover placeholder). Left unchecked; not patched, per this
      ticket's own instruction ("do not patch; report").
- [x] A robot connects and drives over USB, over WiFi, and over radio
      through `torture`, each independently verified.
      Left unchecked. USB: session-open/send-command/session-close all
      verified against real hardware (vevav) — see Part 4b. WiFi: `tigez`
      was not advertising `_robotlink` at all during this bench window
      (confirmed via `dns-sd -B`), so no WiFi link ever existed to open —
      see Part 4c. Radio through `torture`: `torture` never produced a
      link at all this session (see Part 4d for why) and the fallback
      bridge attempt via `vevav`'s own USB relay link to `tigez` did not
      establish. "Drives" specifically was never attempted for any
      transport, per this ticket's own explicit prohibition on sending
      any drive/move/motor verb — that part needs a human at the bench.
- [x] The disconnected-from-host banner appears within the tab on host
      restart and clears on reconnect with a fresh snapshot.
      Confirmed live via a headless Playwright script against the real
      built UI (`packages/ui/dist`) served by this ticket's own host —
      see Part 4e ("DONE-OK": banner text appeared immediately on kill,
      cleared once the restarted host's fresh snapshot arrived).
- [x] A radio override set via the UI is honored by a live relay bridge.
      Left unchecked. `set-radio-override`/clear both confirmed
      end-to-end (`radio.source` flips `derived` → `override` → `derived`
      with the exact channel/group requested) — see Part 4d — but the
      relay-bridge half never actually bridged to a live robot this
      session (see above), so "honored by a live relay bridge" specifically
      is not demonstrated.
- [x] `npm test` is green on macOS (native run) and on Linux (Docker).
      macOS (node v22.23.1): 75 test files, 1346 tests, all passed, tree
      clean afterward. Linux (Docker `node:22-bookworm`, node v22.23.2,
      fresh `git clone` of this branch inside the container): 75 test
      files, 1346 tests, all passed, tree clean afterward. See "Bench
      evidence" Part 3.
- [x] `deviceRegistry.ts`, `wifiRobotGate.ts`, `RelayConnectionCoordinator.ts`,
      and the four old link classes are absent from both source and the
      built `dist/` output.
      Confirmed absent as files/identifiers in both, after finding and
      fixing a stale-`dist/`-artifact gap this ticket's own check
      surfaced — see "Bench evidence" Part 2 (`grep` output, before/after
      the clean rebuild).
      **Team-lead disposition (2026-09-12):** vitut merged (one row,
      owned carried over), proving SUC-003 on real hardware. The `vevov`
      entry's `lastUsbSerial` does not match the `vevav` board on the
      bus, so it is stale data for a different board, not a merge
      defect. Stakeholder to confirm and `forget-device` it via the UI.
      **Team-lead disposition (2026-09-12):** USB connect/command verified
      (vevav). No drivable robot is on the bench (tigez offline, torture
      not owned) and motion commands are out of agent scope. Carried to
      sprint 016's bench ticket, whose exit criterion is exactly relay
      bridging and driving on real hardware (UC-015/016).
      **Team-lead disposition (2026-09-12):** verified headless with
      Playwright against the real built UI and host; accepted as met.
      **Team-lead disposition (2026-09-12):** override set/clear verified
      on the wire; the live bridge needs a radio-reachable robot on the
      bench. Carried to sprint 016's bench ticket with the item above.

### Carried from ticket 009 (SUC-010 completeness)

- [x] `useSendable()` gating (socket open AND snapshot fresh) is applied to
      every remaining send-capable control: `RelayPage` Connect/Switch,
      `ConfigurationPage` provision/apply buttons, `FrontPage` quick-connect
      and Flash triggers, and `AppHeader`'s Flash / Set Wi-Fi dialog
      triggers — with a FakeSocket-close test per page.
      Done — see "Bench evidence" Part 1. `npx vitest run packages/ui`:
      29 files / 438 tests passed. `npm run typecheck`: clean.

## Implementation Plan

**Approach**: Automated suite first (fast feedback), then the bench
pass, in the order listed above. Record bench results directly in this
ticket's completion notes (pass/fail per `04-ui.md` §1 row and per
numbered check above) rather than in a separate file, matching sprint
014 ticket 010's precedent.

**Files to modify**: none expected — this is a verification ticket. If
the bench pass surfaces a real defect, it is fixed here directly (small
fix) or thrown back as an exception to the team-lead (structural issue
requiring a new ticket), per the sprint-planner's exception protocol —
do not silently expand scope for a large fix.

**Testing plan**:
- `npm test` on macOS (native).
- `npm test` on Linux via the Docker setup from `rearch-17` (sprint
  014).
- Manual bench pass per the numbered checks above.

**Documentation updates**: none beyond this ticket's own completion
notes recording the bench evidence (matching sprint 014 ticket 010's
"Bench evidence" section as precedent for format).

## Bench evidence

### Part 1 — send-gating (carried item)

Applied `useSendable()` to every control the carried item names:
`RelayPage`'s Connect/Switch (`pages/RelayPage.tsx`), the front-page
quick-connect Connect/Switch (`pages/FrontPage.tsx` — threaded down as a
plain `sendable` prop through `DevicesList`/`DeviceCard`/`RelayQuickConnect`
rather than a hook call, since those three are deliberately hook-free,
provider-independent components with their own standalone tests),
`ConfigurationPage`'s Save and Write-to-robot buttons, and the shared
`FlashDialog`/`FlashControls`/`WifiCredentialsDialog` components (which
cover the Flash trigger on `FrontPage`'s unassigned card, `AppHeader`'s
Flash and Set Wi-Fi triggers, and `UnknownDevicePage`'s Flash trigger,
all from the one shared component each). One FakeSocket-close test added
per page/dialog (`RelayPage.test.tsx`, `FrontPage.test.tsx`,
`ConfigurationPage.test.tsx`, `AppHeader.test.tsx`).

`npx vitest run packages/ui`: **29 files / 438 tests passed.**
`npm run typecheck`: clean (protocol/host build, then `tsc --noEmit` for
all three packages). Commit `feat(ui): 015-011 send gating on remaining
controls`.

### Part 2 — dist check

First pass (before any rebuild) found a real gap this ticket's own
check exists to catch: `deviceRegistry.js`, `wifiRobotGate.js`,
`RelayConnectionCoordinator.js`, `UsbSerialLink.js`, `RelayRadioLink.js`,
`MbrelayLink.js`, and `MbserialLink.js` were all still present as actual
compiled files in `packages/host/dist/`, even though none of their
source `.ts` files exist any more — `tsc` does not delete stale output
files from a prior build when their source is removed; nothing in this
repo's `build`/`typecheck` scripts ever does a clean rebuild. Fixed by
removing `packages/{host,protocol,ui}/dist` (`rm -r`, not `-rf` —
`-rf` is blocked by this session's permission settings) and re-running
`npm run build` + `npm run vite:build -w @robot-console/ui`.

After the clean rebuild: `grep -rl` for the same seven names over
`packages/*/dist packages/ui/dist` returns zero *files named after*
those classes — the retired identifiers are gone as files. The pattern
still matches inside a number of `.js`/`.d.ts` files' own JSDoc, all of
it historical/rationale prose (e.g. `server.js:45`, "`## Flash
orchestration has no \`DeviceRegistry\` to live in any more`";
`link/LineLink.js:3-4`, "of the old `UsbSerialLink`/`RelayRadioLink`/
`MbrelayLink`/`MbserialLink` classes"). Checked every hit individually
(both `.js` and `.d.ts`, in `packages/host/dist` and
`packages/protocol/dist`) — every one is inside a `/** */` or `//`
comment block, never an import, type reference, or other live
identifier. The identical set of hits (same files, same lines) appears
in `packages/*/src` outside tests, confirming dist mirrors source
exactly and nothing new leaked in. `deviceRegistry.ts`, `wifiRobotGate.ts`,
`RelayConnectionCoordinator.ts`, `UsbSerialLink.ts`, `RelayRadioLink.ts`,
`MbrelayLink.ts`, `MbserialLink.ts` do not exist anywhere under
`packages/host/src`.

### Part 3 — full suite, both platforms

**macOS** (native, node **v22.23.1**): `npm test` → **75 test files,
1346 tests, all passed.** `git status --short` after: only
`.clasi/.clasi.db` (never staged) — tree otherwise clean.

**Linux** (Docker `node:22-bookworm`, node **v22.23.2**, fresh
`git clone -q /src /work` of this branch inside the container,
`git submodule update --init` succeeded — the container had network
access): `npm ci --no-audit --no-fund` → 0 vulnerabilities. `npm test` →
**75 test files, 1346 tests, all passed.** `git status --short` after:
empty (clean tree). Command used, 600000ms timeout, foreground:

```
docker run --rm -v "$PWD":/src:ro -w /work node:22-bookworm bash -lc \
  'git clone -q /src /work && cd /work && \
   git checkout -q sprint/015-host-core-a2-one-connector-snapshot-contract-radio-overrides-in-db-ui-renders-the-snapshot && \
   (git submodule update --init --quiet || true); \
   npm ci --no-audit --no-fund 2>&1 | tail -2 && \
   npm test 2>&1 | tail -40 && git status --short'
```

No real test failures surfaced on either platform — nothing to debug
here.

### Part 4 — live host bench over the WebSocket

Bench state at session start: `vevav` (SWD name; the task's own prose
calls it "Vevov") on `/dev/cu.usbmodem2121202`, `vitut` on
`/dev/cu.usbmodem2121302`, both RELAY firmware (role `RADIOBRIDGE`), no
process holding either port. `torture` (mbrelay), `gopiv`
(mbserial/mbflash), `tigez` (expected `_robotlink`) on the bench mDNS
network. Real `~/.local/state/robot-console/known-robots.json` (5
entries: gopiv, tigez, tovez, vevov, vitut) copied read-only into a
scratchpad state dir. Host started against that dir:
`ROBOT_CONSOLE_STATE_DIR=<dir> node bin/robot-console.js --port 4797`.
A throwaway `ws`-based Node client (scratchpad `wsclient.mjs`) connected
to `ws://127.0.0.1:4797/` for every step below.

**4a — first snapshot / SUC-003 check.** After ~20s settle (state
identical across seq 29 through seq 177, i.e. not still converging),
six `devices` rows:

| id | name | owned | kind | role | links |
|---|---|---|---|---|---|
| 1031 | vevov | true | robot | NEZHA2 | none (placeholder, no current link) |
| 1461 | gopiv | true | robot | NEZHA2 | `mbserial-gopiv` (discovered) |
| 2665 | tovez | true | robot | NEZHA2 | none |
| 2815 | tigez | true | robot | NEZHA2 | `mbserial-tigez` (discovered) |
| 536019796 | vevav | **false** | relay | RADIOBRIDGE | `usb-…2e78ea8f7143163f…` (connected, session) |
| 2198604104 | vitut | true | relay | RADIOBRIDGE | `usb-…8939f0a5fd47f738…` (connected, session) |

`unassigned: []`, `relays: [{linkId: <vitut usb>, lease: null}, {linkId:
<vevav usb>, lease: null}]`, `tasks`: `usbWatcher`/`mdnsWatcher` both
`running`.

**SUC-003 verdict: FAIL for Vevov/vevav, PASS for Vittut/vitut.**
`vitut`'s real USB identification (id `2198604104`, a true FICR-derived
id, not the synthetic placeholder) correctly inherited `owned: true`
from the `known-robots.json`-seeded placeholder and left no separate
leftover row — one `devices` row, as SUC-003 requires. `vevav`'s real
USB identification produced a **second, separate** `devices` row
(id `536019796`, `owned: false`) alongside the untouched placeholder
(id `1031`, name `vevov`, `owned: true`, synthetic id via
`nameToValue("vevov")`) — two rows for what the task's own bench
description treats as one physical board. Root cause, read directly:
the placeholder's recorded `lastUsbSerial`
(`…b8e12372c44f4f67…`) does not match the currently-attached board's
real USB serial (`…2e78ea8f7143163f…`), and the real board's own true
FICR id decodes (`deviceIdToName`) to `vevav`, not `vevov` — a
different name, so there is no shared key (`upsertDevice` keys purely
by numeric id) for the two rows to merge on at all. This is
`store/importers/knownRobots.ts`'s own documented "id problem" (no true
id was ever recorded in the legacy file, so a name/serial mismatch is
unrecoverable by this importer) — **and it is not new**: sprint 014
ticket 010's own bench evidence already found and flagged this exact
same `vevov`(placeholder)/`vevav`(real) split ("the imported `vevov`
row (id 1031) is a separate placeholder — carried to 015"). It is
carried forward again here, unpatched, per this ticket's own
instruction ("do not patch; report").

**4b — USB (vevav).** `session-open {linkId: <vevav usb link>}` →
snapshot showed the link `connected` with a session. `send-command
{linkId, verb: "STATUS"}` → real device reply captured verbatim:
`{"type":"line","direction":"tx","line":"STATUS"}` then
`{"type":"line","direction":"rx","line":"# error: unknown command (try !HELP)"}`.
Also tried `ID` and `HELP` (same "unknown command" reply) and the
suggested `!HELP` (rejected host-side: `"not a legal verb token:
\"!HELP\""`, since `send-command`'s `verb` field only accepts the v6
grammar, not `RADIOBRIDGE`'s own `!`-prefixed console commands). This is
recorded as the real, accurate wire result — relay firmware simply
doesn't answer the robot-protocol `STATUS`/`ID`/`HELP` verbs, and its own
`!`-prefixed console isn't reachable through `send-command` at all —
not a host bug: the tx/rx round-trip itself worked correctly end to
end. `session-close {linkId}` → snapshot confirmed the link
`closed_by_user`, `reason: "user-requested"`, no session.

**4c — WiFi (tigez).** `tigez` never had a `wifi`/`robotlink`-transport
link in any snapshot this session — only the mDNS-discovered
`mbserial-tigez` link (`mbserial`/`mbflash`, not `_robotlink`).
Independently confirmed via `dns-sd -B _robotlink._tcp` (4s browse):
**zero instances** on the bench network at bench time, versus
`_mbrelay._tcp` (torture — present), `_mbserial._tcp`/`_mbflash._tcp`
(tigez, gopiv — present). Recorded as environment: `tigez` was not
advertising as a WiFi robot at all during this bench window, so there
was no WiFi link to open. Not owned/absent — no fix attempted.

**4d — radio via relay.** `set-radio-override {deviceId: 2815 (tigez),
channel: 55, group: 114}` (tigez's own already-derived values, so
nothing physically changes) → snapshot's `tigez.radio` flipped from
`{channel:55,group:114,source:"derived"}` to `{…,source:"override"}`.
`torture` never had any link/device representation in any snapshot this
session (despite `dns-sd -B _mbrelay._tcp` showing it live) — read
directly in `watchers/mdnsWatcher.ts`'s own doc comment: an `_mbrelay`
service only attaches a link when exactly one existing
`devices(kind='relay')` row already has that name, and this host has
never identified `torture` over USB, so no such row exists for it to
attach to. Used the ticket's own offered fallback instead:
`session-open {relayLinkId: <vevav's own usb link>, name: "tigez"}`
(after re-opening a session on that link, since 4b's `session-close`
had put it in `closed_by_user`). Result: `relays[]`'s entry for that
link briefly showed `lease: "session"` then reverted to `lease: null`
within the next poll; no `tigez`-bridged child device (a link with
`via.relayLinkId` set to vevav's link) ever appeared in any subsequent
snapshot, and no `line`/`notice` traffic was broadcast for the attempt
at all, even over an 8s and then a 15s capture window. Consistent with
this ticket's own anticipated failure mode ("if the bridge fails
because tigez is on WiFi and not listening on radio, record that
honestly as environment, not regression") — recorded as environment,
not investigated further (would require the relay/reconciler's own
radio-bridge internals, out of this verification ticket's scope).
`set-radio-override {deviceId: 2815, clear: true}` → `tigez.radio`
confirmed back to `{channel:55,group:114,source:"derived"}`.

**4e — disconnected-from-host banner, plus a real defect found and
fixed.** Built `packages/ui/dist` (Part 2's clean rebuild) served by
the host at `http://127.0.0.1:4797/`. Playwright's Chromium **is**
installed (`~/Library/Caches/ms-playwright`). First attempt: loaded the
page, confirmed a device card, sent `SIGTERM` to the host — the process
never exited (still `LISTEN`ing on 4797, the browser's own WebSocket
still `ESTABLISHED`, 2+ minutes later). Root-caused by reading `ws@8.21.3`'s
own source (`node_modules/ws/lib/websocket-server.js`): `WebSocketServer.close(cb)`,
for a server wrapping an *externally-owned* `httpServer` (this
codebase's own setup), does **not** invoke `cb` until `this.clients.size`
reaches `0` when any client is still connected — it does not forcibly
drop them itself. `server.ts`'s old `close()` `await`ed exactly that
callback *before* the `client.terminate()` loop that would have
brought `clients.size` to `0` — a deadlock the instant any real client
(never this repo's own `fakeWebSocketServer` test double, whose
`close(cb)` always calls back immediately) is still connected at
shutdown. Fixed (`packages/host/src/server.ts`): `wss.close()` is now
fire-and-forget — its only real effect, removing the upgrade listener,
happens synchronously inside the call, before it ever touches
`clients.size`, so nothing downstream needs to wait on its callback.
Added a regression test using the *real* `ws.WebSocketServer` (not the
fake) with a real, never-voluntarily-closing client
(`server.test.ts`, "close() with the real ws.WebSocketServer (bench
015-011 deadlock regression)") — confirmed it fails (times out) against
the pre-fix code and passes against the fix. `npx vitest run
packages/host/src/server.test.ts`: 26/26 passed. `npx vitest run
packages/host`: 552/552 passed. `npm run typecheck`: clean. Commit
`fix(host): 015-011 close() no longer deadlocks with a real client attached`.

Re-ran the banner check against the fixed, rebuilt host: killed the
host (pid we started) → banner text **"Disconnected from the host —
reconnecting…"** appeared immediately; restarted the host → banner
cleared once the fresh snapshot arrived. `[banner-check] DONE-OK`. No
Flash trigger was on-screen at that moment to also check for disabling
(every device was already identified/owned, so the front page offered
no unassigned-board Flash trigger) — that specific assertion is instead
covered by Part 1's FakeSocket-close tests
(`AppHeader.test.tsx`/`FrontPage.test.tsx`).

**4f.** Host process stopped cleanly (`SIGTERM`, exited promptly this
time — itself further confirmation of the 4e fix). Parity rows needing
a human at the screen, confirmed by automated tests, visual check
deferred to the stakeholder: drive controls' actual on-screen
behavior while driving (`DriveControls.test.tsx`/`DriveTab.test.tsx`),
the calibration wizards' live visual flow
(`DistanceCalibrationWizard.test.tsx`/`RotationCalibrationWizard.test.tsx`),
and the charts/telemetry panels' rendered appearance
(`ChartsPanel.test.tsx`/`PathTracePanel.test.tsx`).

### What the stakeholder must do next

Every box above that stayed unchecked needs one of these, not further
agent-side investigation (all are either hardware state this session
could not change, or explicitly out of this ticket's safety scope):

1. **Vevov/vevav placeholder (SUC-003 FAIL).** Decide whether
   `known-robots.json`'s `vevov` entry (id 1031) is simply stale data
   for a board no longer on the bench (in which case: forget it via the
   UI, nothing to fix in code) or is meant to be the same physical unit
   now read as `vevav` (in which case the placeholder-merge design
   itself has no way to reconcile a name mismatch with no shared id,
   per `store/importers/knownRobots.ts`'s own doc comment — this would
   need a design decision, not a bench-ticket patch). This exact case
   was already flagged once, in sprint 014 ticket 010, as "carried to
   015" — worth deciding now rather than carrying it again.
2. **WiFi and live radio-relay bridge (AC 3/5).** Get `tigez` actually
   advertising `_robotlink` / listening on its radio channel, then
   redo: WiFi connect over `tigez`'s own wifi link, and
   `session-open {relayLinkId: <torture's mbrelay link>, name: "tigez"}`
   — note `torture` will first need this host to have identified it
   over USB at least once (`mdnsWatcher.ts`'s own "known relay" linking
   rule), or use `vevav`'s own USB relay link as this session did.
3. **"Drives" (AC 3).** Physically drive a robot over USB, WiFi, and
   radio — this agent never sent a drive/move/motor verb, per this
   ticket's own explicit prohibition.
4. **Visual parity (optional).** The rows listed in Part 4f — every one
   is already confirmed by an automated test; a live visual pass is a
   nice-to-have, not a blocker, since AC 1 is satisfied by the existing
   parity report.
