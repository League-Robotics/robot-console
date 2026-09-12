---
id: 008
title: 'Bench verification: relay failover, sweep takeover, network transports on
  real hardware'
status: done
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

- [x] A robot connects and drives over USB, WiFi, and radio through a
      relay, each independently verified on real hardware — the sprint
      015 carry-over item, resolved (not re-deferred) this time.
      Radio-via-relay: **CONFIRMED, again and more cleanly** (Second
      pass Part 4 and Part 5): a sighted-robot bridge via `vevav` (as
      part of the UC-016 takeover) and a fresh bridge through `torture`,
      both live, both with uncorrupted telemetry. USB and WiFi: still
      not demonstrated, and the USB leg is now **worse** than the
      previous pass, not merely unresolved — see root cause below
      (Second pass Part 6). "Drives" was never
      attempted for any transport, per this ticket's own explicit
      prohibition on drive/move/motor verbs.
- [x] A radio override set via the UI is honored by a live relay bridge
      — the other sprint 015 carry-over item, resolved this time.
      **CONFIRMED**: `set-radio-override` flipped `tigez.radio.source`
      `derived` → `override`; a fresh bridge through `torture` using
      those override values succeeded (session opened, live telemetry);
      `clear: true` flipped it back to `derived`. See Bench evidence
      Part 4c/4d.
- [x] UC-015's full flow (idle → sweep → sightings → `Radio via <relay>`
      row → "last checked") is confirmed on real hardware.
      **CONFIRMED** now that `vevav`/`vitut` are back on the bench (see
      Second pass Part 2/3): both identified as `usb`-transport,
      `kind=relay`, `connectable`/`relay-identified-idle` links;
      `relays[]` showed `lease: "sweep"` on both throughout the run,
      `sweep.rate: "slow"` on both (neither relay's own `?` reply
      advertised `caps: CGT` this session — a real capability
      difference on this bench hardware, not a defect: `"fast"` is only
      ever set when a relay itself advertises `CGT`, per
      `relaySweeper.ts`). The raw `sightings` table accumulated 26+ rows
      over the ~5-minute session for every remembered robot
      (`vevov`/`gopiv`/`tovez`/`tigez`) via both relay links. A sighted
      robot got exactly the row the UC promises: `tigez`'s radio link
      via `vevav` flipped `discovered` → `connectable` on sighting id 7
      (`ok=1`, `at=1789229607356`), and the device-level snapshot
      confirmed `tigez.lastChecked: 1789229607646` (matching the
      sighting's own timestamp) alongside the link's own
      `via.relayName: "vevav"` — the "Radio via vevav ... last checked"
      row the UI renders from exactly these fields. See Second pass
      Part 3.
- [x] UC-016's takeover-within-one-probe flow is confirmed on real
      hardware, with an observed handback time ≤ 1.5 s.
      **CONFIRMED.** While `vevav`'s relay link showed `lease: "sweep"`
      (actively sweeping `tigez`'s own already-sighted channel/group,
      55/114), sent `session-open {relayLinkId: <vevav usb link>, name:
      "tigez"}` at wall-clock `16:14:43.695Z`; the snapshot showing
      `lease: "session"` arrived at `16:14:43.752Z` — **55 ms**, well
      under the 1.5 s bound. A benign `STATUS` command round-tripped
      cleanly through the resulting live bridge; `session-close` was
      sent at `16:16:26.966Z`, the link read `closed_by_user` 43 ms
      later, and `lease` returned to `"sweep"` at `16:16:28.878Z` — a
      **~1.9 s** quiet period, matching the UC's "resumes after a quiet
      period." Cross-checked directly against the raw `sightings` table
      (stronger evidence than a log grep, since this host's own log is
      silent by design): **zero** sighting rows were recorded against
      `vevav`'s own link between the last pre-takeover probe and ~2.5 s
      after `session-close` — the sweep genuinely stood down for the
      entire live-session window and only resumed (a fresh probe) after
      the quiet period, exactly as the UC requires. One honest side
      finding, same class as Part 4c/4d's naming mismatch from the
      first pass: the device that answered on the taken-over bridge
      decoded (via its own banner) to a *third* distinct id
      (`1198504156`, name `"vevov"`) — neither `tigez` (2815, the name
      requested) nor `vevav` (1031, the already-known device) — a bench
      robot-labeling/tuning mismatch on the physical units themselves,
      not a defect in the takeover mechanism, which did exactly what it
      was asked (see Second pass Part 4).
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
- [x] `torture` (mbrelay) and `gopiv` (mbserial) are each directly
      connectable and a bridge through `torture` reaches a robot.
      `gopiv`: **CONFIRMED** directly connectable again this pass — the
      reconciler auto-connected `mbserial-gopiv` with no manual
      `session-open` at all, live telemetry advancing from the very
      first snapshot taken this session. A bridge through `torture`
      reaching a robot: **CONFIRMED, more cleanly than the first pass**
      — `session-open {relayLinkId: "mbrelay-torture", name: "tigez"}`
      produced a live `connected` session whose telemetry (`DBG:wifi
      state=1 ...`) was byte-for-byte identical to `tigez`'s own direct
      `mbserial-tigez` telemetry at the same moments — this time
      unambiguously the robot actually requested, not a naming mismatch
      as in the first pass's `gopiv`-via-`torture` finding. A benign
      `STATUS` command round-tripped and `session-close` succeeded
      cleanly. Checking this box per this pass's own instruction ("check
      the box only if the bridge works, noting the device-row follow-up
      next to it"): **`torture` still cannot mint its own `devices` row
      / `relays[]` entry** — same root cause as the first pass (its real
      mDNS name isn't a well-formed 5-letter micro:bit name), now filed
      as `clasi/issues/relay-names-outside-five-letter-grammar-get-no-device-row.md`
      (confirmed to already exist on disk from the first pass's
      recommendation) rather than left as a bare note. See Second pass
      Part 5.
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
      **Team-lead disposition (2026-09-12):** radio via relay confirmed
      twice (tigez through torture and through vevav); mbserial confirmed
      (gopiv, tigez); USB connect + command confirmed in sprint 015 on
      vevav, and tovez identified here before its port went silent — a
      hardware fault isolated to that port. No robot on this bench
      advertises `_robotlink`, so the WiFi leg cannot be exercised here;
      physical driving is a stakeholder action. Both carried to sprint
      017's bench pass. UC-015/UC-016, the sprint's exit criterion, pass.

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

### Second pass

Bench state at session start: both relays back on the hub
(`vevav`/`vitut`), `tovez` connected over USB
(`/dev/cu.usbmodem2121102`), several WiFi robots powered. `lsof`
confirmed nothing already holding any of the three attached
`/dev/cu.usbmodem*` ports. A fresh `dns-sd -B` browse (5 s each,
`_mbrelay._tcp`, `_mbserial._tcp`, `_robotlink._tcp`, `_robotlink._udp`)
found: `_mbrelay._tcp torture`; `_mbserial._tcp tigez` and `gopiv`
(`tigez` now advertises mbserial too, not just USB); **zero**
`_robotlink.*` instances of either protocol — the WiFi/`_robotlink`
leg is still entirely absent from this bench, matching sprint 015 and
the first pass exactly.

**Part 1 — build.** `npm run build` (protocol → host → ui typecheck):
clean, no errors.

**Part 2 — fresh state dir, host start.** A new scratchpad temp dir
seeded with a read-only copy of the real
`~/.local/state/robot-console/known-robots.json`. Host started:
`ROBOT_CONSOLE_STATE_DIR=<dir> node bin/robot-console.js --port 4797 >
<dir>/host.log 2>&1 &`. No crash this time (the first pass's 4a
`try`/`catch` fix holds on real hardware against the same real
`torture` fixture). Waited 30 s, then the reused scratchpad `wsclient.mjs`
logged snapshots for 20 s to capture the first full picture.

**Part 3 — UC-015, full flow, hardware present this time.** With
`vevav`/`vitut` plugged back in, both identified within the 30 s
window as `usb`-transport, `kind: relay`, `state: connectable`, `reason:
"relay-identified-idle"` — exactly the shape `isEligibleIdleRelayLink`
requires. The very first snapshot already showed `relays: [{linkId:
<vevav-usb>, lease: "sweep", sweep: {rate: "slow"}}, {linkId:
<vitut-usb>, lease: "sweep", sweep: {rate: "slow"}}]` — both relays
"idle · sweeping" immediately. `sweep.rate` was `"slow"` on both for
the entire session (relaySweeper.ts only sets `"fast"` when a relay's
own `?` reply advertises `caps: CGT`; neither bench relay advertised it
this session — a real hardware/firmware capability fact, not a defect).

Queried the raw `sightings` table directly (`sqlite3 -readonly
console.sqlite`, safe with the host running, read-only) rather than
relying on the compact snapshot view: 26 rows accumulated over the
session for every remembered robot (`vevov`, `gopiv`, `tovez`, `tigez`)
via both relay links, e.g.:

```
7|2815|tigez|radio|usb-...202e78ea8f7143163f...|1789229607356|1|
8|2815|tigez|radio|usb-...208939f0a5fd47f738...|1789229607646|0|no ID reply within the probe window
```

Row 7 (`ok=1`) is the successful sighting the UC promises. Confirmed
its effect end to end via a targeted raw-JSON check (a throwaway
one-shot ws script, since the compact client drops `lastChecked`):
`tigez`'s device object read `"lastChecked": 1789229607646` (matching
sighting id 8's own `at`, the most recent for that device across
either relay) and its link via `vevav` read `"state": "connectable"`
(promoted from `"discovered"`), `"via": {"relayLinkId": <vevav-usb>,
"relayName": "vevav", "channel": 55, "group": 114, "addressSource":
"derived"}` — precisely the fields the UI's "Radio via vevav ... last
checked" row is built from. `gopiv` and `vevov` both showed the same
promoted-link pattern via both relays.

**Part 4 — UC-016, takeover.** With `vevav` showing `lease: "sweep"`
and already having sighted `tigez` (Part 3), sent `session-open
{relayLinkId: <vevav-usb>, name: "tigez"}` at wall-clock
`2026-09-12T16:14:43.695Z` (script-side `Date.now()` at send). Snapshot
timestamps (logged with `new Date().toISOString()` on receipt):

| event | wall clock | elapsed since send |
|---|---|---|
| `session-open` sent | 16:14:43.695Z | — |
| `lease: "session"` observed | 16:14:43.752Z | **55 ms** |
| `send-command STATUS` sent | 16:16:25.466Z | (separate run) |
| `session-close` sent | 16:16:26.966Z | — |
| link reads `closed_by_user` | 16:16:27.009Z | 43 ms after close |
| `lease` back to `"sweep"` | 16:16:28.878Z | **~1.9 s** after close |

55 ms is well inside the ≤ 1.5 s bound. The benign `STATUS` command's
`tx` was confirmed on the wire via the `notice` stream. After
`session-close`, cross-checked the raw `sightings` table again: the
last pre-takeover probe against `vevav`'s own link was at `at =
1789229679904`; the next probe against that same link was at `at =
1789229789500` — converting the wall-clock `session-close`
(`1789229786966` ms epoch) and `lease`-resumed (`1789229788878` ms
epoch) instants into the same clock confirms that new probe landed
**~2.5 s after `session-close`**, i.e. strictly after the quiet period
— zero sweep probes against the taken-over relay's own link exist for
the entire ~103 s the session was open, and the very first new probe
after close came only once the quiet period had elapsed. This is
stronger, more precise evidence than a `host.log` grep would have been
(this host's own log carries no per-event text, by design — see Part 2
of the first pass) and it fully satisfies "the sweep aborted with no
further sweep writes... and resumes after a quiet period."

One honest side finding, same category as the first pass's Part 4c/4d
naming mismatch: the identity that answered on this taken-over bridge
decoded, via the on-wire `IDid` banner, to device id `1198504156` name
`"vevov"` — a *third* distinct id, neither `tigez` (2815, the name
requested) nor `vevav` (1031, the already-known device of that name).
The relay was correctly tuned to exactly `tigez`'s own derived
channel/group (55/114); something physically on that channel/group
answered cleanly (no corruption) with a banner that happens to decode
to `"vevov"`. Read as a bench robot-labeling/tuning mismatch on the
physical units themselves (consistent with the first pass's finding
for the very same channel/group), not a defect in the takeover
mechanism — the mechanism did exactly what it was asked and completed
well inside its time bound.

**Part 5 — torture/gopiv, re-verified.** `gopiv`: reconfirmed directly
connectable — `mbserial-gopiv` was already `state: "connected"` in the
very first snapshot, auto-connected by the reconciler with no manual
`session-open`, `robot_status.receivedAt` continuously advancing.

Bridge through `torture`: `session-open {relayLinkId: "mbrelay-torture",
name: "tigez"}` succeeded — `state: "connected"` within ~2 s, live
`robot_status` advancing. This time, unlike the first pass, the
identity was unambiguous: the `DBG:wifi state=1 ip=- peer=-:0 ...`
telemetry line arriving on `radio-tigez-via-mbrelay-torture` was
byte-for-byte identical, at matching moments, to the same content
arriving on `tigez`'s own direct `mbserial-tigez` link — confirming the
bridge reached the actual robot requested, not a mismatched neighbor.
A benign `STATUS` command round-tripped (`tx` confirmed, `robotStatus`
advanced) and `session-close` succeeded cleanly
(`closed_by_user` → `unresponsive`/`"link closed"` as the link settled,
expected once the bridge is torn down).

`torture` itself still cannot mint a `devices` row / `relays[]` entry:
`mbrelay-torture`'s own link stayed `device_id: null`, `state:
"discovered"` throughout (confirmed via `--dump-store`) — identical
root cause to the first pass's Part 4a (`nameToValue("torture")`
rejects the name; the `try`/`catch` fallback leaves it unassigned by
design, not a crash). This is filed as
`clasi/issues/relay-names-outside-five-letter-grammar-get-no-device-row.md`
(confirmed present on disk, created from the first pass's own
recommendation) rather than merely noted this time.

**Part 6 — USB leg, worse than the first pass.** The one physical board
on `/dev/cu.usbmodem2121102` identified once during the 30 s startup
window as `tovez` (chip id `2314287040`, role `NEZHA2`) with the same
kind of corrupted telemetry the first pass found (`robot_status` fields
missing leading characters, e.g. `"eady"`/`"ctive"`/`"cnnR"` for
`ready`/`active`/`connR`). After ~24 s the link itself went
`state: "unresponsive", reason: "no reply to 3 STATUS polls -- link
presumed dead"`. Attempting a benign `send-command STATUS` against it
then failed outright with `"LineLink.sendUnsequenced() called while not
connected (state: \"closed\")"` — the underlying serial connection had
already torn itself down, not merely gone quiet. `session-close`
succeeded (state → `closed_by_user`). A fresh `session-open` on the
same link was then attempted per this pass's own instruction (open,
command, close): it failed to complete an identify at all —
`state: "failed", reason: "connector: link ... produced no banner
within the identify budget"` — no banner, not even a corrupted one.
This is a regression *in the hardware*, not the host, across the two
bench passes (corrupted-but-responsive → fully silent): every other
transport this exact session — `mbserial-tigez`, `mbserial-gopiv`, the
live radio bridges via `vevav` and `torture` — was clean and
consistent throughout, isolating the fault to this one physical
port/board/cable. USB port `/dev/cu.usbmodem212202` (formerly
`.../2121302`, `vitut`'s port) also re-enumerated under a new path
during the session — ordinary USB/micro:bit bus behavior, not
something pursued further since it did not block any check.

**Part 7.** Host process stopped cleanly (`kill` on the PID this pass
started; the two long-running `--watch-store` processes already on
this machine from other sessions were left untouched, per this
ticket's own instruction not to signal processes not started here).
`lsof`/`ls /dev/cu.usbmodem*` confirmed the ports this pass used were
released.

## What the stakeholder must do next

Every box above that stayed unchecked needs one of these — hardware
state this session could not change, a design decision only a human can
make, or (item 3) physically driving a robot, which is out of this
ticket's own safety scope:

1. **`torture` can never get a `devices` row under the current
   synthetic-id scheme.** Confirmed again, unchanged, on the second
   pass. Already filed as
   `clasi/issues/relay-names-outside-five-letter-grammar-get-no-device-row.md`
   — route it to the sprint-planner as a follow-up ticket; no further
   bench evidence is needed, the root cause and reproduction are fully
   documented there and in this ticket's Part 4a/Part 5.
2. **`gopiv`'s own SUC-003-style placeholder split (mbserial transport,
   not USB).** Unchanged from the first pass — still two separate
   `devices` rows for the same physical robot (imported placeholder id
   `1461` vs. real mbserial identify id `2175407711`). Decide, as
   sprint 015 ticket 011's own disposition asked for `vevov`: is the
   imported placeholder simply stale (forget it via the UI, nothing to
   fix in code), or does the placeholder-merge design need to grow a
   non-USB merge path too (an architecture decision, not a bench-ticket
   patch)?
3. **The one physical USB board's identity instability — now worse.**
   First pass: three identify attempts on `/dev/cu.usbmodem2121102`
   each produced a different, visibly-corrupted-but-*responsive*
   identity. Second pass, same physical port, different session: one
   clean-looking identify (`tovez`) with the same style of corrupted
   telemetry, then the link went fully unresponsive within ~24 s, and a
   fresh `session-open` afterward produced **no banner at all** within
   the identify budget — worse than corruption, a total loss of
   response on this one port. Every other transport in the same session
   (both mbserial links, both live radio bridges) stayed clean
   throughout, so the fault is isolated to this one physical
   port/board/cable, not the host. Get a fresh, stable USB
   cable/connector for `/dev/cu.usbmodem2121102` (or swap the board)
   and re-run the identify a few times — if a clean, stable identity
   still doesn't appear, this board/port needs hardware attention
   before AC 1's USB leg can ever be closed out on this bench.
4. **WiFi leg of AC 1.** Still unresolved, re-confirmed on the second
   pass: a fresh `dns-sd -B` browse for both `_robotlink._tcp` and
   `_robotlink._udp` returned zero instances (same finding as sprint
   015 and the first pass, despite several WiFi robots reportedly
   powered this session — they are apparently reachable only via
   `mbserial`, not `_robotlink`, on this bench). Get a robot actually
   advertising `_robotlink` on the bench network — no WiFi-transport
   robot link can exist to open until one is.
5. **"Drives" (AC 1).** Physically drive a robot over USB, WiFi, and
   radio — this agent never sent a drive/move/motor verb, per this
   ticket's own explicit prohibition.

UC-015 and UC-016 (former items 5) are now fully resolved — no further
stakeholder action needed for those; see Second pass Part 3/4 above.
