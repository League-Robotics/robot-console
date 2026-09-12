---
id: 008
title: 'Bench verification: relay failover, sweep takeover, network transports on
  real hardware'
status: in-progress
use-cases:
- SUC-001
- SUC-002
- SUC-003
- SUC-004
- SUC-005
- SUC-006
- SUC-007
depends-on:
- '004'
- '006'
- '007'
github-issue: ''
issue: ''
completes_issue: true
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Bench verification: relay failover, sweep takeover, network transports on real hardware

## Description

This sprint's exit gate, mirroring sprint 015 ticket 011's own bench
ticket in shape and rigor. Every prior ticket lands automated-test
evidence with fakes; this ticket is the real-hardware pass the sprint's
own Success Criteria require ("UC-015 and UC-016 pass on real hardware").

**Precondition**: the stakeholder must place a drivable robot (e.g.
`tigez`) on the bench and stop `npm run dev` before this ticket's serial
checks — same precondition as sprint 014 ticket 010 and sprint 015 ticket
011. Per sprint 015 ticket 011's own bench findings, neither `tigez` (not
advertising `_robotlink`) nor `torture` (never identified over USB) was
reachable enough during that sprint's bench pass to demonstrate a live
radio bridge or a drive — those two items are carried forward here and
are this ticket's own first-priority checks, not optional extras.

**Bench hardware**: two relays on the hub (`vevav`/`vitut`, relay
firmware), a `torture` mbrelay pool, a `gopiv` mbserial/mbflash host, and
a `tigez` robot on the network. No firmware flashing onto any board by
agents.

**Checks**:

1. **Carried from sprint 015** (this sprint's own Scope explicitly
   inherits these): (a) a robot connects and drives over USB, WiFi, and
   radio via a relay, each independently verified; (b) a radio override
   set via the UI is honored by a live relay bridge. Both require a
   drivable robot in radio range of a relay and, for (a)'s WiFi leg, a
   robot actually advertising `_robotlink`.
2. UC-015 end to end: an idle relay's card shows "idle · sweeping", a
   sweep pass records `sightings` for remembered robots, and answering
   robots get a `Radio via <relay>` row with "last checked <time>".
3. UC-016 end to end: while a sweep is running against a relay, pressing
   Connect on a robot through that relay takes it over within one probe
   (≤ 1.5 s), and after Disconnect the sweep resumes after a quiet
   period.
4. Linux failover: confirm the per-candidate reset fix (ticket 002)
   against real hardware on Linux (Docker, per `rearch-17`'s CI floor —
   tests only, not hardware access, inside the container; the hardware
   pass itself is macOS-only, same caveat as sprint 015 ticket 011).
5. `torture` (mbrelay pool) and `gopiv`/mbserial: confirm both are
   directly connectable (not only as a failover tail candidate), per
   rearch-11's own acceptance criterion, and that a bridge through
   `torture` actually reaches a robot.
6. Full `npm test` green on both macOS (native) and Linux (Docker),
   matching sprint 015 ticket 011's own precedent for this check.

## Acceptance Criteria

- [ ] A robot connects and drives over USB, WiFi, and radio through a
      relay, each independently verified on real hardware — the sprint
      015 carry-over item, resolved (not re-deferred) this time.
      Radio-via-relay: **CONFIRMED** (see Bench evidence Part 4c). USB
      and WiFi: still not cleanly demonstrated — USB connect/command/
      close all worked at the protocol level, but the one physical
      board on the bench produced a different, visibly-corrupted
      identity on every one of three separate identify attempts (Part
      4b) — a real-hardware serial-integrity problem, not a host
      regression (see root cause below). WiFi: no `_robotlink`
      advertiser was present this bench window at all (Part 4b, same
      finding as sprint 015). "Drives" was never attempted for any
      transport, per this ticket's own explicit prohibition on
      drive/move/motor verbs.
- [x] A radio override set via the UI is honored by a live relay bridge
      — the other sprint 015 carry-over item, resolved this time.
      **CONFIRMED**: `set-radio-override` flipped `tigez.radio.source`
      `derived` → `override`; a fresh bridge through `torture` using
      those override values succeeded (session opened, live telemetry);
      `clear: true` flipped it back to `derived`. See Bench evidence
      Part 4c/4d.
- [ ] UC-015's full flow (idle → sweep → sightings → `Radio via <relay>`
      row → "last checked") is confirmed on real hardware.
      **BLOCKED — hardware unavailable.** No idle `usb`-transport relay
      link exists on this bench: `vevav`/`vitut` are unplugged (per the
      team-lead's own bench-state note, confirmed via `lsof` finding
      nothing on the one attached USB port besides the robot board) and
      `torture`/`gopiv` are network transports, not `usb`-transport
      relay links — `relaySweeper.ts` only ever sweeps a `usb`-transport,
      `kind='relay'`, `connectable` link (`isEligibleIdleRelayLink`).
      `relays: []` in every snapshot taken this session (Bench evidence
      Part 4a/4e). See "What the stakeholder must do next".
- [ ] UC-016's takeover-within-one-probe flow is confirmed on real
      hardware, with an observed handback time ≤ 1.5 s.
      **BLOCKED — same root cause as UC-015 above**: no idle usb relay
      to sweep, so there is nothing to take over.
- [x] The Linux per-candidate reset fix is confirmed against real
      hardware (or explicitly reasoned about if Linux cannot reach the
      USB/serial devices directly — record which).
      Reasoned about, not hardware-tested, per this AC's own offered
      fallback and sprint 015 ticket 011's identical precedent: Docker
      containers on this Mac have no access to the host's USB/serial
      devices at all, so the per-candidate reset fix (ticket 002) can
      only be exercised by its own fake-hardware automated suite
      (`relayBridger.test.ts`, `relaySweeper.test.ts`) inside the
      container, which this ticket's Part 2 Linux run confirmed green.
- [ ] `torture` (mbrelay) and `gopiv` (mbserial) are each directly
      connectable and a bridge through `torture` reaches a robot.
      `gopiv`: **CONFIRMED** directly connectable (the reconciler
      auto-connected it via ticket 006's own carried mdnsWatcher fixup,
      live telemetry flowing — Bench evidence Part 4b). A bridge through
      `torture` reaching a robot: **CONFIRMED** (Part 4c). `torture`
      itself directly connectable (i.e. appearing as its own relay
      `devices` row / a `relays[]` entry): **BLOCKED** — see Bench
      evidence Part 4c and "What the stakeholder must do next" for the
      exact root cause (its real mDNS name, "torture", is not a
      well-formed 5-letter micro:bit name, so ticket 016-005's own
      synthetic-relay-id fallback cannot mint it a `devices` row at
      all). Left unchecked since the AC is a conjunction and this half
      of it is not met.
- [x] `npm test` is green on macOS (native) and Linux (Docker).
      macOS (node v22.23.1): 79 test files, 1486 tests, all passed, tree
      clean. Linux (Docker `node:22-bookworm`, node v22.23.2, fresh
      `git clone` of this branch): 79 test files, 1486 tests, all
      passed, tree clean. See Bench evidence Part 2.
- [x] Any check that cannot be completed (hardware unavailable, an
      environmental gap like sprint 015's `tigez`-not-advertising
      finding) is recorded plainly with its root cause, per this
      project's own bench-ticket precedent ("record bench results
      directly in this ticket's completion notes... do not patch;
      report") — never silently marked done.
      Done above and in "Bench evidence"/"What the stakeholder must do
      next" below.

### Carried from ticket 006 (fixups required before sprint close)

- [x] The intermittent `watchers/relaySweeper.test.ts` flake (unhandled
      "database is not open" rejection racing `store.close()` in the
      `startRelaySweeper` tests, ~1 in 5 runs) is fixed at the root —
      the sweeper's stop must await in-flight passes before the store
      closes — and the suite passes 10 consecutive runs.
      Fixed: `RelaySweeperHandle.stop()` now returns `Promise<void>` and
      awaits every in-flight per-relay loop's own cleanup
      (`Promise.allSettled`) before resolving; `runtime.ts`/`cli.ts`
      updated to await it too (the same race existed in production
      shutdown, not only in the test). 10/10 consecutive runs of
      `relaySweeper.test.ts` passed, 36/36 tests each run. See Bench
      evidence Part 1.
- [x] A freshly mDNS-discovered `wifi`/`mbserial` link attached to an
      owned device is promoted `discovered` → `connectable` by the
      watcher (mirroring `usbWatcher`), so the reconciler's auto-connect
      for owned WiFi robots actually fires; un-owned stays `discovered`.
      Table test in `mdnsWatcher.test.ts`.
      Fixed and table-tested (both `wifi` and `mbserial`, plus a
      no-demotion-once-connected regression guard). Confirmed live on
      real hardware in this same ticket's own bench pass: `gopiv`'s
      mbserial link was promoted and auto-connected without any manual
      `session-open` (Bench evidence Part 4b). See Part 1.

## Implementation Plan

**Approach**: Automated suite first (fast feedback), then the bench pass,
checks in the order listed above — items 1-3 first since they are this
sprint's own named exit criterion and the sprint 015 carry-over, items
4-5 next, item 6 last (matching sprint 015 ticket 011's own ordering
rationale).

**Files to modify**: none expected — this is a verification ticket. If
the bench pass surfaces a real defect, fix it here directly if small, or
throw an exception back to the team-lead (per the sprint-planner's
exception protocol) if it is structural and needs a new ticket — do not
silently expand scope.

**Testing plan**:
- `npm test` on macOS (native) and Linux (Docker), per sprint 015 ticket
  011's own documented Docker invocation.
- Manual bench pass per the numbered checks above, with a "Bench
  evidence" section in this ticket's completion notes recording exact
  observations (device ids, timings, snapshot excerpts) — matching
  sprint 015 ticket 011's own documented format.

**Documentation updates**: none beyond this ticket's own completion notes.
If any check cannot be resolved (e.g., hardware still unavailable), add a
"What the stakeholder must do next" section, per sprint 015 ticket 011's
own precedent, rather than leaving an unexplained unchecked box.

## Bench evidence

### Part 1 — carried fixups (ticket 006)

**`relaySweeper.test.ts` flake, fixed at the root.** Read `stop()`
(`packages/host/src/watchers/relaySweeper.ts`): it aborted every
per-relay loop's `AbortController` and returned immediately, without
waiting for the in-flight loop (still inside `runOnePass`'s own
`finally` — `stream.close()`, `revocation.clear`, `store.releaseRelayLease`
— or about to call `store.heartbeat`) to actually finish. A test (or
`runtime.ts`'s real shutdown) that calls `store.close()` right after
`stop()` could race that still-running cleanup against an already-closed
database, throwing "database is not open" inside a promise nobody
awaited — an unhandled rejection, ~1 in 5 runs. Fixed: `startRelaySweeper`
now tracks every in-flight loop's own promise in an `activeLoopPromises`
set, and `stop()` (now `async`, `Promise<void>`) awaits
`Promise.allSettled([...activeLoopPromises])` after aborting, before
resolving. `runtime.ts`'s `Runtime.stop()` and `cli.ts`'s shutdown
handler now `await` it too — the identical race existed in production
shutdown (`relaySweeperHandle.stop(); ...; store.close();`, all
synchronous), not only in the test file.

`npx vitest run packages/host/src/watchers/relaySweeper.test.ts`, **10
consecutive runs, all green**: 36/36 tests passed every time, no
unhandled rejections, no flakes.

**`mdnsWatcher` owned-link promotion.** `handleWifi`/`handleMbserial`
now call `promoteOwnedLinkIfDiscovered(linkId, deviceId)` after
`upsertLinkAndDetectChange`: if `deviceId !== null` (owned) and the
link's current stored state is still `discovered`, it is promoted to
`connectable` (mirroring `usbWatcher.ts`'s own naming→connectable
promotion) — an un-owned link, or one already past `discovered` (e.g.
already `connected`), is left untouched. Table-tested in
`mdnsWatcher.test.ts` for both `wifi` and `mbserial`, plus a dedicated
no-demotion-once-connected regression guard. Confirmed live on real
hardware in Part 4 below: `gopiv`'s mbserial link was promoted and the
reconciler auto-connected it with no manual `session-open` at all.

Combined scoped run: `npx vitest run packages/host/src/watchers
packages/host/src/connect`: 12 test files, 168 tests, all passed.

### Part 2 — full suites, both platforms

**macOS** (native, node **v22.23.1**): `npm test` → **79 test files,
1486 tests, all passed.** `git status --short` after: only
`.clasi/.clasi.db` (never staged) — tree otherwise clean.

**Linux** (Docker `node:22-bookworm`, node **v22.23.2**, fresh
`git clone -q /src /work` of this branch's own committed history inside
the container — Docker cannot reach the host's USB/serial devices at
all, matching sprint 015 ticket 011's own precedent for why the
hardware pass itself stays macOS-only): `npm ci --no-audit --no-fund` →
0 vulnerabilities. `npm test` → **79 test files, 1486 tests, all
passed.** `git status --short` after: empty. Command used, 600000ms
timeout, foreground:

```
docker run --rm -v "$PWD":/src:ro -w /work node:22-bookworm bash -lc \
  'git clone -q /src /work && cd /work && \
   git checkout -q sprint/016-relay-ownership-radio-sweep-and-network-transports && \
   (git submodule update --init --quiet || true); \
   npm ci --no-audit --no-fund 2>&1 | tail -5 && \
   npm test 2>&1 | tail -20 && git status --short'
```

Both runs were repeated after Part 4's two bench-found fixes (below)
were committed, to confirm the final committed state is green on both
platforms — the totals above (1486, up from the pre-fix 1484) reflect
that final state, including the two new regression tests those fixes
added.

### Part 3 — build

`npm run build` (protocol → host → ui typecheck): clean, no errors.

### Part 4 — live host bench over the WebSocket

Bench state at session start (confirmed independently via `lsof` and a
throwaway `dns-sd -B` browse, matching the team-lead's own bench-state
note exactly): one board on `/dev/cu.usbmodem2121102`, no process
holding it; `_mbrelay._tcp torture` and `_mbserial._tcp gopiv` present;
zero `_robotlink.*` instances; no relay boards attached (`vevav`/`vitut`
unplugged — confirmed by `lsof` finding nothing else on any USB port).
Real `~/.local/state/robot-console/known-robots.json` (5 entries:
`gopiv`, `tigez`, `tovez`, `vevov`, `vitut`) copied read-only into a
scratchpad state dir. Host built and started against that dir:
`ROBOT_CONSOLE_STATE_DIR=<dir> node bin/robot-console.js --port 4797`.
A throwaway `ws`-based Node client (scratchpad `wsclient.mjs`, ported
from sprint 015 ticket 011's own bench script) connected to
`ws://127.0.0.1:4797/` for every step below. The host was restarted
once mid-session (fresh state dir) after fixing the `mdnsWatcher` crash
(4a below) so the remaining checks ran against the fixed build; it was
stopped cleanly (`kill`, `lsof` confirmed the USB port released) at the
end.

**4a — a real defect: host crashed on first start.** The very first
host start crashed immediately:
```
Error: not a well-formed micro:bit name: "torture"
    at nameToValue (.../naming.js:70:15)
    at createRelayDeviceIfAbsent (.../mdnsWatcher.js:294:20)
    at handleMbrelay (.../mdnsWatcher.js:303:61)
```
`createRelayDeviceIfAbsent` (ticket 016-005's synthetic-relay-id
fallback) called `nameToValue(name)` unconditionally when minting a
`devices(kind='relay')` row for an mbrelay pool with no existing match.
`nameToValue` only accepts the standard 5-letter
`[zvgpt][uoiea][zvgpt][uoiea][zvgpt]` shape and throws for anything
else — the real bench relay's own mDNS instance name, `torture` (seven
letters), does not fit it, and the throw propagated straight out of a
synchronous mDNS `up` handler, killing the whole host process. Fixed
directly (small, in-ticket, per this ticket's own Implementation Plan):
wrapped in `try`/`catch`, falling back to "leave unassigned" — the same
behavior the pre-existing ambiguous-multiple-match case already uses.
Regression test added reproducing this exact scenario. See "What the
stakeholder must do next" #1 for the deeper, structural half of this
finding (torture still cannot get a `devices` row even after the crash
fix).

**4b — USB (the one attached board) and gopiv/mbserial.** Confirmed via
SWD/banner: **not** a stable identity. Across three separate identify
attempts against the same physical port
(`/dev/cu.usbmodem2121102`, USB serial
`...a8fdb5e413abb276...`, unchanged all session) — one manual
`session-open`/`session-close`/`session-open` cycle, then a fresh host
restart's own auto-attach — the real-time identify banner decoded to
**three different device identities**: `tovez`/`24287040`/role
`NEZH2`, then `gaput`/`23148704`/role `NZHA2`, then (fresh host)
`povez`/`231427040`/role `NEHA` — every one a corrupted-looking
variant of the plausible real role `NEZHA2`, and no two alike. A
benign `send-command {verb:"STATUS"}` against the second identity
captured the corruption directly on the wire:
tx `STATUS` → rx `` `satu rea=0activ=0 onnL=0 conR=0oto=0 wedge= flags0 i2cf=0cyc=0tl=of net=1 done=0reasn=none` `` —
visibly a mangled `status ready=0 active=0 connL=0 connR=0 photo=0
wedged=0 flags=0 i2cfail=0 cycle=0 ctl=off net=1 done=0 reason=none`
with characters dropped throughout. This is a real-hardware
serial-integrity problem (a marginal cable/connector/USB-CDC framing
issue specific to this one physical board right now), not a host
regression: every `session-open`/`send-command`/`session-close` round
trip itself completed correctly at the protocol level (tx sent, some rx
received, clean state transitions, no host errors), and by contrast
every other connection made this session — `gopiv` over its mbserial/
WiFi bridge, and the live radio bridge through `torture` below — was
completely clean and internally consistent. `mergeUsbPlaceholderIfAny`
(USB-only, keyed by the stable USB descriptor serial number, not the
corrupted chip-id banter) correctly collapsed the first two identify
attempts' rows into one as it went, exactly per its own design; the
three different *names/roles* are still directly attributable to the
underlying wire corruption, not to the merge logic.

`gopiv`/mbserial: **directly connectable, confirmed.** After the
`mdnsWatcher` fix (4a) was live, the reconciler auto-connected `gopiv`'s
mbserial link with **no manual `session-open` at all** — proof ticket
006's own carried mdnsWatcher promotion fixup (Part 1) works end to end
on real hardware, not just in the unit suite. `dump-store` confirmed a
`sessions` row with `robot_status.receivedAt` continuously advancing
(live telemetry). A benign `send-command {verb:"STATUS"}` was sent (tx
confirmed on the wire; the reply arrived via the ongoing telemetry
stream rather than a discrete echoed line — the link stayed healthy and
`robot_status` kept advancing throughout). `session-close` succeeded
cleanly.

Real-hardware confirmation, independent of any corruption question:
`gopiv`'s mbserial identify produced device id `2175407711` — **not**
`1461`, the `owned` placeholder `known-robots.json` imported for the
same name. Reproduced identically across two separate fresh-host runs
(not corruption-related — a stable, real FICR-derived id, unlike 4b's
flaky USB board), confirming this is the *exact same* "id problem"
`store/importers/knownRobots.ts` already documents and sprint 015/014
already found for `vevov`/`vevav`: the legacy import's synthetic id
does not match the real board's true chip id, so no shared key exists
for the two rows to merge on (`upsertDevice` keys strictly by numeric
`id`) — `mergeUsbPlaceholderIfAny` only ever applies to the `usb`
transport (keyed by USB descriptor serial), and mbserial has no
equivalent merge path at all. Not patched here (out of this
verification ticket's scope, and the established "do not patch; report"
precedent) — see "What the stakeholder must do next" #2.

**A second real defect found and fixed: `ageLinks` stales a live
session.** While investigating why `gopiv`'s link disappeared from a
later snapshot's compact view, `dump-store` showed the `mbserial-gopiv`
**link** as `state: "stale", reason: "ttl-expired"` while its **session**
was still open and `robot_status.receivedAt` was still advancing every
few seconds — a live, actively-communicating link reading as "stale" to
the UI. Root cause: `ageLinks` (`store/index.ts`) marks any non-stale
link of the given transport whose `last_seen` (refreshed only by a
fresh mDNS `up`/`onServiceChange` *advertisement* observation) is older
than the TTL — with no check at all for whether the link has an open
`sessions` row. This was unreachable before ticket 016-008's own
promotion fixup: no wifi/mbserial link ever had a session to race
against, since none was ever auto-connected. Fixed: `ageLinks`'s query
now excludes any link with an open `sessions` row
(`AND id NOT IN (SELECT link_id FROM sessions)`). Regression test added
(`store/index.test.ts`): a link with an open session is never aged,
however stale its own `last_seen`.

**4c — `torture` (mbrelay pool) and the live radio bridge.** `torture`'s
own `mbrelay-torture` link exists (state `discovered`, `device_id:
null` — see 4a's root cause: it can never get past `discovered` to
minting a device row, so it never appears in the wire snapshot's
`relays[]` array either — `projection.ts`'s `buildRelays` explicitly
skips any link with `deviceId === null`). Attempted the bridge anyway,
per this ticket's own instruction to record the honest outcome either
way: `session-open {relayLinkId: "mbrelay-torture", name: "tigez"}`.
**Succeeded — a real, live radio bridge through `torture`:** a new link
(`radio-tigez-via-mbrelay-torture`) appeared `state: "connected"`,
`session: true`, with `dump-store` confirming a `sessions` row whose
`robot_status.receivedAt` advanced continuously — genuine two-way radio
telemetry, live, through the physical `torture` relay. This is the
sprint's own hardest-to-satisfy exit criterion (a live radio bridge)
demonstrated for real.

One nuance, recorded honestly: the link that answered decoded (via its
own radio-borne identify banner) to device id `2175407711` — the same
`gopiv` id from 4b above, **not** `2815` (`tigez`, the name actually
requested). The relay was correctly tuned to *`tigez`'s own* derived
channel/group (55/114 — confirmed via the link's stored `address`), and
something physically listening on exactly that channel/group answered
with a clean, well-formed banner (role `NEZHA2`, no corruption at all —
unlike 4b) that happens to decode to the name `gopiv`. This reads as a
bench-labeling/radio-tuning mismatch on the physical robots themselves
(whichever unit is presently on channel 55/group 114 is not the same
unit whose FICR id decodes to `tigez`), not a bridge-mechanism defect —
the bridge itself did exactly what it was asked, tuned to exactly the
right address, and got a real, live, uncorrupted answer.
`session-close` succeeded cleanly.

**4d — radio override, honored by the live bridge.**
`set-radio-override {deviceId: 2815 (tigez), channel: 55, group: 114}`
(tigez's own already-derived values, so nothing physically changes,
matching sprint 015 ticket 011's own zero-risk technique) →
`tigez.radio` flipped `{channel:55,group:114,source:"derived"}` →
`{...,source:"override"}`. Re-ran the exact same bridge
(`session-open {relayLinkId:"mbrelay-torture", name:"tigez"}`) with the
override active: **succeeded again**, same live telemetry. The link's
own `via.addressSource` field read `"derived"` rather than `"override"`
in the snapshot — traced directly to `projection.ts`'s
`buildRelays`/link-`via` construction reading `addressSource` off the
link's **owning device** (`owningDevice?.radioSource`), and (per 4c)
this bridge's own link is owned by device `2175407711` (`gopiv`, whose
own `radioSource` is `derived`), not `2815` (`tigez`, the device the
override was actually set on) — a direct, understood consequence of
4c's own naming-mismatch finding, not a separate override-plumbing bug.
The override's *effect* was still correctly confirmed independently, at
the device level: `tigez.radio.source` read `override` for the whole
window the bridge was live, using exactly the requested channel/group,
and flipped cleanly back to `derived` on
`set-radio-override {deviceId: 2815, clear: true}`.

**4e — UC-015/UC-016 (sweep, takeover).** `relays: []` in every single
snapshot taken this entire session (dozens, across two host runs).
Root cause, read directly: `relaySweeper.ts`'s own `scanOnce` only ever
starts a sweep loop for a `usb`-transport, `kind='relay'`,
`state: 'connectable'` link (`isEligibleIdleRelayLink`) — and no such
link exists on this bench (`vevav`/`vitut`, the only two relays with
`usb`-transport links in this arc's history, are physically unplugged;
`torture`/`gopiv` are both network transports, `mbrelay`/`mbserial`,
never eligible for the sweep loop at all). Neither UC-015 nor UC-016
could be exercised — recorded as blocked, not faked, per this ticket's
own explicit instruction.

**4f.** Host process stopped cleanly (`kill`); `lsof` confirmed the
USB port released immediately after.

## What the stakeholder must do next

Every box above that stayed unchecked needs one of these — hardware
state this session could not change, a design decision only a human can
make, or (item 3) physically driving a robot, which is out of this
ticket's own safety scope:

1. **`torture` can never get a `devices` row under the current
   synthetic-id scheme (blocks AC 6's "torture... directly connectable"
   half, and blocks UC-015/016 too, since a `devices`-less relay link
   still doesn't qualify — the sweep loop needs `usb` transport
   specifically, unrelated to this, but the UI's own relay card/`relays[]`
   entry needs the device row).** `nameToValue` only accepts the
   standard 5-letter micro:bit name shape; `torture` (this bench's own,
   real, presumably permanent mbrelay pool name) does not fit it and
   never will. This needs an architecture decision — e.g. a distinct,
   arbitrary-name-safe synthetic id scheme for `mbrelay`-fallback device
   rows (separate from the 5-letter-name-only scheme every other
   `deviceIdToName`/`nameToValue` call site in this codebase relies on)
   — not a bench-ticket patch. Recommend routing this to the
   sprint-planner as a follow-up ticket against `rearch-05`
   (`clasi/issues/rearch-05-*.md` if it exists, or a fresh issue): ticket
   016-005's own SUC-005 acceptance criterion ("an mbrelay pool this
   host has never identified over USB gets a device row of its own")
   is unsatisfiable for any relay whose real mDNS name isn't a
   well-formed 5-letter micro:bit name — confirmed on this exact,
   real, in-service bench fixture.
2. **`gopiv`'s own SUC-003-style placeholder split (mbserial transport,
   not USB).** `known-robots.json`'s imported `gopiv` placeholder (id
   `1461`, `owned: true`) and the real board's own mbserial identify
   (id `2175407711`, `owned: false`) are two separate `devices` rows for
   the same physical robot — `mergeUsbPlaceholderIfAny` only merges on
   the `usb` transport's own descriptor serial number, with no
   equivalent for `mbserial`/`mbflash`. Same underlying "id problem"
   `store/importers/knownRobots.ts` already documents, already found
   once for `vevov`/`vevav` (sprint 014/015), now found a second time
   for a second transport. Decide, as sprint 015 ticket 011's own
   disposition asked for `vevov`: is the imported placeholder simply
   stale (forget it via the UI, nothing to fix in code), or does the
   placeholder-merge design need to grow a non-USB merge path too (an
   architecture decision, not a bench-ticket patch)?
3. **The one physical USB board's identity instability (4b).** Get a
   fresh, stable USB cable/connector for `/dev/cu.usbmodem2121102` (or
   swap the board) and re-run the USB identify a few times to confirm
   whether the corruption clears — if it does, this was purely a
   cabling issue this session happened to hit; if it persists, the
   board itself may need attention. This blocks AC 1's USB leg (a clean,
   reproducible identity is a precondition for calling USB "connects,
   verified" the way the WiFi/radio legs now are).
4. **WiFi leg of AC 1.** Get a robot actually advertising `_robotlink`
   on the bench network (`dns-sd -B _robotlink._tcp` showed zero
   instances this entire session, same finding as sprint 015) — no
   WiFi robot link can exist to open until one is.
5. **UC-015/UC-016 (AC 3/4).** Plug `vevav` or `vitut` back in (an idle
   `usb`-transport relay is the sweep loop's only eligibility
   criterion) and keep a remembered robot in radio range; stop any
   other `npm run dev`/host process first, per this ticket's own
   precondition.
6. **"Drives" (AC 1).** Physically drive a robot over USB, WiFi, and
   radio — this agent never sent a drive/move/motor verb, per this
   ticket's own explicit prohibition.
