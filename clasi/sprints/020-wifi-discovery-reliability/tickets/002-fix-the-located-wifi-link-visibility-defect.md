---
id: '002'
title: Fix the located WiFi link visibility defect
status: in-progress
use-cases:
- SUC-002
depends-on:
- '001'
github-issue: ''
issue: bench-wifi-robot-discovery-waits-for-announcement.md
completes_issue: true
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Fix the located WiFi link visibility defect

## Description

Ticket 001 names the specific point where an owned, WiFi-reachable
robot's reachability diverges from its visibility in the live snapshot,
with evidence. This ticket fixes that defect at its actual location —
**this plan is deliberately written to be revised by ticket 001's
findings** rather than pre-committing to one of the sprint
architecture's candidate hypotheses. Do not start implementation until
ticket 001 is done and its finding is read.

Also required by this sprint's Scope: explicitly evaluate whether
`connect/relayLeaseRevocation.ts`'s in-process, no-schema takeover-seam
pattern (register/get/clear over an `AbortController`, rebuilt fresh on
every host restart, no `relay_leases`-style persistence) is a reusable
shape for the WiFi on-demand path — e.g. a `session-open` request for an
owned robot with no live `wifi` link triggering (and bounded-waiting on)
an immediate probe, rather than depending solely on the passive
30-second tick. This evaluation happens regardless of which defect
ticket 001 finds, and its outcome (adopted, adapted as part of the fix,
or rejected) must be recorded either way — not skipped because the fix
ended up elsewhere (e.g. purely in aging/pruning or the owned gate).

**Explicitly out of scope for this ticket**: adding a longer timeout or
another retry layer on top of the existing fallback without addressing
ticket 001's named defect. 019-009's own evidence (failure rate got
*worse*, not better, across ten consecutive runs) argues against "it's
just a slow race" — a timeout/retry change that doesn't address the
named defect does not satisfy this ticket's acceptance criteria even if
it happens to move the pass rate on a given run.

## Acceptance Criteria

- [x] The fix addresses the specific defect ticket 001 named — the
      ticket's closing notes explain how the change closes that
      specific gap, with a citation back to ticket 001's finding.
      **Corrected during this ticket's own further measurement — see
      Closing Notes.**
- [x] The `relayLeaseRevocation.ts` reuse question is explicitly
      answered in this ticket's closing notes: adopted, adapted, or
      rejected, with reasoning either way.
- [x] No broader rewrite beyond the located defect — changes are scoped
      to the module(s) ticket 001 implicated.
- [x] Existing passing behavior is not regressed: the passive mDNS
      `handleWifi` path, `mbserial`/`mbrelay` link handling, and
      existing aging/pruning behavior for those transports are
      unaffected unless ticket 001's finding specifically implicates
      shared code.
- [x] Scoped unit/integration tests pass for every module touched.
- [ ] A first confirming run of `scripts/bench/run.sh` against a
      property-selected WiFi-reachable owned robot passes Layer 2 and
      Layer 3's WiFi checks (full statistical confirmation is ticket
      003's job, not this one's — one clean run here is a smoke check
      before handing off to the repeated-run gate). **NOT satisfied —
      left unchecked deliberately. See Closing Notes' honest verdict:**
      the redesigned mechanism is proven correct at the unit level
      (deterministic tests exercise exactly the "device pending →
      accelerated re-query → passive `handleWifi` creates the link"
      path with no timeout in the loop) and is architecturally sound
      (reuses the already-reliable passive path verbatim, adding no new
      failure mode), but it was **not confirmed against live hardware**
      within this session: the one sanctioned `scripts/bench/run.sh` run
      completed used the *pre-redesign* code and failed `tovez`'s wifi
      check (the run that motivated the redesign); every fixture
      available afterward became unusable in turn (`tovez` claimed by a
      concurrent session, `tigez` left the network entirely, `gopiv`
      itself intermittently unreachable at the OS/mDNS level at every
      window this session could safely test it). This is recorded as an
      open item for ticket 003 to close with a live run, not silently
      passed.

## Implementation Plan

**Approach**: Read ticket 001's closing notes first. Implement the
targeted fix at the location(s) it names. If it implicates
`projection.ts`'s owned-gate timing (deviceId resolving null at
upsert-time), the fix likely means re-resolving or re-confirming
`deviceId` closer to the point the snapshot is built, or ensuring
`uniqueOwnedDeviceIdByName` is stable across the probe's async gap. If
it implicates aging/pruning, the fix likely means aligning the
on-demand path's `last_seen`/state bookkeeping with the passive path's
guarantees. If it implicates the in-flight `Set` or a Layer 2/3 read
mismatch, fix that specific mechanism. If ticket 001 finds the passive,
tick-driven trigger is fundamentally too loosely coupled to "a session
is being requested right now," implement the evaluated
`relayLeaseRevocation.ts`-style request-driven trigger from
`connect/reconciler.ts` or `sessionOps.ts` instead — but only if ticket
001's evidence supports it, not as a default.

**Files to modify** (exact set depends on ticket 001's finding —
candidates, not a commitment):
- `packages/host/src/watchers/mdnsWatcher.ts`
- `packages/host/src/store/index.ts`
- `packages/host/src/projection.ts`
- `packages/host/src/connect/reconciler.ts` and/or `sessionOps.ts` (only
  if the request-driven-trigger direction is chosen)
- `packages/host/src/discovery/wifiOnDemand.ts` (only if ticket 001
  implicates the probe itself, which 019-009's evidence argues against)

**Testing Plan**:
- **Existing tests to run**: the full test file(s) for every module
  touched (e.g. `mdnsWatcher.test.ts`, `store/index.test.ts`,
  `projection.test.ts`, `reconciler.test.ts`/`sessionOps.test.ts` if
  touched) — scoped to modules this ticket touches, not the full suite.
- **New tests to write**: a regression test that reproduces ticket 001's
  named defect against a fake backend/store (no real network/socket, per
  this codebase's existing test conventions — see
  `mdnsWatcher.test.ts`'s and `wifiOnDemand.test.ts`'s own fixtures) and
  asserts the fix closes it. This is the test that would have caught
  019-002's own incomplete fix.
- **Verification command**: scoped `npm test --workspace=@robot-console/host -- <touched module test files>`, plus one manual `scripts/bench/run.sh` pass against a property-selected WiFi-reachable robot before handing off to ticket 003.
- **Documentation updates**: if the fix changes documented behavior
  (e.g. `watchers/mdnsWatcher.ts`'s own "WiFi on-demand fallback" doc
  comment section, or `projection.ts`'s owned-gate doc comment), update
  those doc comments in the same commit — this codebase's own
  convention (see how 018-007/016-008/017-005 are cited inline in the
  modules read for this sprint's architecture). No `docs/design/`
  changes are anticipated unless the fix changes the data model (not
  expected — see sprint.md's Migration Concerns).

## Closing Notes (programmer, 2026-09-18)

**Ticket 001's threadpool-starvation conclusion was wrong as a primary
cause — recorded plainly so no future reader inherits it.** This is a
normal outcome of diagnosis-first sequencing (exactly why this sprint
split diagnosis from fix), not a criticism of that ticket's own
discipline — it correctly identified a real, reproducible effect
(unbounded concurrency), just not the dominant one.

**The corrected root cause**, established with evidence gathered during
this ticket's own further measurement (all under
`<scratchpad>/020-002/`, cited by file below):

- A solo, completely uncontended `dns.lookup(<name>.local)` for a name
  with **no live mDNS answer takes ~5000ms** on this network/OS
  combination — confirmed **three independent ways**: (1) a bare
  isolated script with nothing else running
  (`timing-isolated-run1.log`: `vitut`/`vevov`/`gopiv`/`tigez` all
  5003-5012ms to `ENOTFOUND`, while a *resolvable* name — `tovez` at that
  moment — took 5ms); (2) the sanctioned `scripts/bench/layer1` tool's
  own, unrelated `wifi-by-name` check independently measuring the same
  ~5000-5020ms for the same four names in the same run
  (`bench-run/console.log` lines 56-59); (3) a single-device,
  single-probe repro against the dedicated `gopiv` fixture with
  `probedNonTarget: false` (zero contention, structurally impossible for
  another name to be probed) still timing out at exactly 2000ms
  (`diag-gopiv-run1.log`) — a name with **no contention at all** still
  lost the race.
- `discovery/wifiOnDemand.ts`'s own DNS-lookup bound
  (`DEFAULT_WIFI_DNS_LOOKUP_TIMEOUT_MS`, 2000ms) sits **below that
  floor**. Every cache-miss lookup was guaranteed to hit the timeout
  before the OS resolver could ever answer — the probe could not
  structurally distinguish "this robot is not there" from "this name is
  not cached yet," independent of concurrency.
- Concurrency **is** a real, confirmed **multiplier**, not the cause: 5
  concurrent uncapped lookups measured at 2x the solo wall-clock time
  (`timing-isolated-run1.log`: 10008ms for 5-concurrent vs ~5007ms
  solo/2-concurrent) — each `dns.lookup` occupies a libuv threadpool
  worker for its *entire* ~5s duration, and `withTimeout` never cancels
  the underlying call, so a "settled" (timed-out, from this module's own
  point of view) lookup keeps silently occupying a real thread for its
  full natural duration. This is exactly why 020-001's own
  `UV_THREADPOOL_SIZE=32` A/B looked like a fix: more workers halve
  queueing delay stacked on top of a budget that was already too tight,
  occasionally landing a lookup under 2000ms by luck (55-95ms in that
  A/B) rather than by the mechanism actually being fixed.

**`gopiv`'s own intermittent presence** (the sprint's dedicated,
uncontended fixture, parked by the stakeholder specifically for this
work): confirmed reachable (`TCP 7654 open`, `192.168.1.218`) at one
point, then `ENOTFOUND`/unreachable via both `dns.lookup` and a direct
`nc` port check minutes later with no code change in between. **mDNS
presence is intermittent at the OS level even for a robot sitting still
on a dedicated field** — this bounds what ticket 003 can honestly claim
about "a WiFi-reachable robot": the property itself can flicker within
the same measurement session, independent of any host-side defect.

**`dns.resolve4` — rejected, with evidence.** Ticket 001's own "more
robust" recommendation (c-ares async I/O, off the libuv threadpool
entirely) was tested directly against two robots confirmed live via
`dns-sd` moments earlier:
```
tigez.local   dns.lookup: OK -> 192.168.1.224     dns.resolve4: FAIL -> ENOTFOUND
tovez.local   dns.lookup: OK -> 192.168.1.220     dns.resolve4: FAIL -> ENOTFOUND
```
(`<scratchpad>/020-002/resolve-ab-run1.log`). `dns.resolve4` bypasses the
system resolver and queries configured unicast DNS servers directly — it
does not speak mDNS at all, so it fails **outright and universally** for
every `.local` name this module needs, trading an intermittent failure
for a total one. Confirmed exactly as ticket 002's own dispatch warned;
rejected.

**The fix landed**: replaced the `dns.lookup`-based on-demand probe
entirely with an **accelerated re-query of the already-running passive
`_robotlink._tcp`/`._udp` browsers** (`watchers/mdnsWatcher.ts`'s
`triggerWifiOnDemandProbes`/`requeryWifiBrowsersNow`/the new
fast-requery timer). This was chosen over "raise the timeout to ~6000ms"
specifically because it **removes the failure mode** rather than
widening the window a future fleet/network could still exceed:
`browser.update()` has no failure/timeout semantics of its own — it is a
bare re-send of the identical query the passive path already performs on
its own 30s cadence, and any answer arrives through the *already-wired*
`up`/`onServiceChange` → `handleWifi` path (the same trust model the
`mbserial`/`mbrelay` passive paths already use, with no independent
TCP/HELLO confirmation either — this is not a rigor downgrade, it brings
`wifi` in line with how every other transport in this module already
behaves). A device with no actual WiFi path never answers, exactly like
today's passive path already behaves for it — there is no "waiting to
fail" cost imposed on it at all. `triggerWifiOnDemandProbes` now:
immediately re-queries when any owned, non-relay device lacks a live
`wifi` link; arms a {@link DEFAULT_WIFI_FAST_REQUERY_INTERVAL_MS} (2s)
retry for up to {@link DEFAULT_WIFI_FAST_REQUERY_MAX_ATTEMPTS} (10)
attempts (~20s, comfortably under the normal 30s tick) while any such
device remains unlinked; and falls back to the ordinary
`DEFAULT_REQUERY_INTERVAL_MS` cadence forever after for a device that
never answers, so nothing is abandoned outright and nothing loops
indefinitely for a robot that will never be there. Full reasoning is in
the module doc comment's "WiFi on-demand fallback" section.

**The concurrency cap built earlier in this ticket was removed, not kept
alongside the new mechanism** — and this needs to be stated plainly
rather than glossed over: the cap capped concurrent `dns.lookup` calls,
which no longer happen at all from this call site (the only I/O now is a
synchronous, non-blocking `browser.update()` send — there is no
concurrent async operation left to bound). Keeping an inert cap around
would have been dead code, not a hedge. If a future change reintroduces
a concurrent-I/O-per-device shape here, the concurrency lesson from this
ticket (cap it; a "settled" `withTimeout` does not mean the real work
stopped) still applies and is documented in the module doc comment for
that reason.

**`tigez` excluded from any pass-rate accounting.** It answered
`ECONNREFUSED` on port 7654 after resolving correctly (a real device
declining a real connection — a true negative, not a discovery defect),
and a `dns-sd -B _robotlink._tcp` browse later in the same session showed
it gone from the network entirely (present at 11:55, absent at 12:13,
no code change between). Not a usable fixture for this ticket's own
measurements and not counted in any rate reported here.

**Honest verdict on live confirmation**: **not obtained within this
session.** The one sanctioned `scripts/bench/run.sh` run completed
(`<scratchpad>/020-002/bench-run/report.md`,
`<scratchpad>/020-002/bench-run/console.log`) used the pre-redesign code
and failed `tovez`'s wifi check at both Layer 2 and Layer 3 (`"no link
found in the snapshot for tovez via wifi"`) — Layer 1's own raw probe
passed for `tovez` in the same run, confirming it really was reachable.
That failure, plus the gopiv single-probe repro showing a **confirmed
live** device still timing out under only 2-way concurrency
(`diag-gopiv-run1.log`), is what falsified the concurrency-only
diagnosis and drove the redesign. After the redesign, every fixture that
could re-confirm it live became unavailable in turn: `tovez` was claimed
by a concurrent session working the physical playfield (correctly
yielded — see below), `tigez` left the network, and `gopiv` itself was
unreachable (`ENOTFOUND` / `nc` port check failed) at the one window
available to retest. The redesigned mechanism is verified correct at the
unit level (`mdnsWatcher.test.ts`'s new "020-002 accelerated WiFi
re-query" suite: immediate re-query on start, no re-query when nothing is
pending, fast-retry cadence and its bounded give-up, multi-device
fan-out via one shared query, clean `stop()`) and is architecturally
lower-risk than the code it replaces (reuses an already-proven path,
introduces no new timeout), but **this is not the same as a live-hardware
pass, and ticket 003 should not assume one.** Recommend ticket 003's own
statistical run treat this as unconfirmed on real hardware until its own
first runs land.

**Bench-safety incident, recorded per the coordinator's request**: an
early ad hoc measurement script (`bench-ab.mjs`) imported the *real*
5-robot `known-robots.json` while only intending to observe one device,
so the real runtime owned, on-demand-probed, and ultimately
auto-connected to all five — including `tovez`, which a concurrent
session needed exclusively on the live playfield. The resulting
connection had to be identified and terminated by the coordinator.
Root cause: `--allow-shared-bench` only skips a resource *held at census
time*; a workload that opens and closes connections per step (like the
concurrent session's own tooling) can look free at the moment a host
looks, then get claimed in the gap. Lesson applied for the rest of this
ticket: seed a *synthetic*, single-robot `known-robots.json` to
structurally prevent a host from ever owning/dialing anything but the
intended target, rather than relying on post-hoc cleanup. This is
direct, first-hand evidence for sprint 021's "attach, don't start a
second host" framing — a host process reaches for whatever it can
discover, by design, and any test harness (this one included) inherits
that reach unless deliberately fenced off.

**`relayLeaseRevocation.ts` reuse — REJECTED**, not adopted or adapted.
Reasoning:
1. **Wrong primitive for the need.** `relayLeaseRevocation.ts`'s
   register/get/clear-over-`AbortController` shape exists to let one
   in-process caller *signal a running task to stop* (a takeover). The
   WiFi on-demand gap is about *triggering new work sooner*, not
   cancelling in-flight work — there is nothing to abort. The two needs
   don't share a shape.
2. **The diagnosed defect was unrelated to trigger cadence.** The
   original fallback already fired immediately at start and every 30s
   tick; ticket 001 and this ticket's own further work both show the
   failure was in the *bound*, not in *when* the check ran. A
   request-driven trigger (a `session-open` for an owned, unlinked robot
   immediately re-arming discovery) would not have fixed 019-009's 2/10
   pass rate, and does not fix the corrected defect either — it only
   would shave time off an already-short (~20s worst case, now
   self-renewing every 30s) window.
3. **Would have been exactly the "broader rewrite beyond the located
   defect" this ticket's own scope excludes** — it requires a new
   cross-module dependency (`connect/reconciler.ts`/`sessionOps.ts`
   calling into `mdnsWatcher.ts`), not justified once the actual defect
   turned out to live entirely inside `mdnsWatcher.ts`/
   `discovery/wifiOnDemand.ts`.

If the team later wants session-open to shave latency off the fast-retry
window, the natural seam is `triggerWifiOnDemandProbes` itself — it is
already idempotent and safely re-callable at any time (a no-op if
nothing is pending or a fast cycle is already running) — not
`relayLeaseRevocation.ts`'s cancellation-shaped primitive. Worth its own
ticket if the stakeholder wants it; not required to close this one.

**`withTimeout`'s queued-vs-slow blindness — not fixed here; recommend
its own issue.** This ticket's own measurement surfaced the concrete
mechanism the sprint architecture only speculated about: a `withTimeout`
caller that "gives up" does not mean the underlying operation stopped —
`dns.lookup`'s own libuv worker kept running for its full ~5s regardless
of the 2000ms `TimeoutError`. `discovery/wifiOnDemand.ts` no longer being
called from this module's on-demand path removes *this* ticket's own
exposure to that flaw, but `withTimeout` itself is shared infrastructure
(`tcpStream.ts`, `flash.ts`, `swdName.ts`, and `wifiOnDemand.ts`'s own
remaining connect/HELLO steps all still use it) and none of those other
call sites were diagnosed or touched here — recommend a separate issue
evaluating whether `withTimeout` should gain real cancellation (e.g. an
`AbortSignal`-based variant, where the underlying operation supports
one) rather than folding that broader change into this ticket.

**What `reconciler-stop-session-leak-finding.md` is** (found incidentally
while running this ticket's own bench measurements, not part of the
diagnosed WiFi-visibility defect): `connect/reconciler.ts`'s `stop()`
(lines 882-889) only unsubscribes and clears its own timer — it never
closes any `ConnectedSession` that was open when `stop()` was called,
despite `runtime.ts`'s own doc comment (line ~148) claiming stopping
"mirrors the reconciler's own `stop()` contract" for "any already-open
session." Reproduced twice, for real, this session: once against
`tovez` (the incident above, which blocked a concurrent session) and
once against `gopiv`'s own mbserial bridge (`diag-gopiv-only-run1.log`
and `diag-gopiv-only-v2-run1.log/output` both show the diagnostic
process still holding an `ESTABLISHED` connection to `zilch`'s bridge,
`192.168.4.52:35279`, after `await runtime.stop()` had already resolved
— I terminated the leaked process manually each time). This is a real
production hazard (any restart, or any test harness that starts/stops
runtimes repeatedly, can strand live robot connections) independent of
WiFi discovery, living in a different module (`connect/reconciler.ts`'s
session lifecycle, not `mdnsWatcher.ts`'s link visibility). **Not fixed
in this ticket** — out of scope per this ticket's own "no broader
rewrite" constraint. Recommend filing it as its own issue; full writeup
at `<scratchpad>/020-002/reconciler-stop-session-leak-finding.md`.

**Files changed**: `packages/host/src/watchers/mdnsWatcher.ts` (module
doc comment's "WiFi on-demand fallback" section rewritten; new
`DEFAULT_WIFI_FAST_REQUERY_INTERVAL_MS`/
`DEFAULT_WIFI_FAST_REQUERY_MAX_ATTEMPTS` constants and matching
`MdnsWatcherOptions` fields; `triggerWifiOnDemandProbes` reimplemented
around `requeryWifiBrowsersNow`/a self-clearing fast-requery timer;
removed `MdnsWatcherDeps.probeWifiOnDemand` and the now-inapplicable
concurrency-cap machinery; `discovery/wifiOnDemand.ts` import removed).
`packages/host/src/watchers/mdnsWatcher.test.ts` (the old
`probeWifiOnDemand`-based on-demand suites replaced with a suite
exercising the accelerated-requery mechanism). `discovery/wifiOnDemand.ts`
itself is **untouched** — it has no other production caller, is left in
the codebase with its own test suite intact, and is available again if a
future need for an active reachability probe (distinct from passive
discovery) arises.

**Scoped tests**: `npx vitest run mdnsWatcher wifiOnDemand projection
--no-coverage` — 3 test files, 79 tests, all passing (2026-09-18, this
session, foreground). `npm run typecheck` — clean across all four
project tsconfigs.
