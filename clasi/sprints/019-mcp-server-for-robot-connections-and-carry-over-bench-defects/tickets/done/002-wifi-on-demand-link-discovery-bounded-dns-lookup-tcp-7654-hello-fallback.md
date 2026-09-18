---
id: '002'
title: WiFi on-demand link discovery (bounded dns.lookup + TCP 7654 HELLO fallback)
status: done
use-cases:
- SUC-002
depends-on: []
github-issue: ''
issue: bench-wifi-robot-discovery-waits-for-announcement.md
completes_issue: true
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# WiFi on-demand link discovery (bounded dns.lookup + TCP 7654 HELLO fallback)

## Description

`watchers/mdnsWatcher.ts` only creates a `wifi` link when it receives an
unsolicited mDNS announcement for `_robotlink._tcp`/`._udp`. An owned
robot with a WiFi path can therefore have no `wifi` link for tens of
seconds after host start — purely a function of where host start falls
relative to the robot's own announcement interval, not a real
reachability problem. Two full bench-harness runs 15 minutes apart on
2026-09-17, with no discovery code changed between them, show `tigez /
wifi` passing one run and failing the next with "no live-snapshot link
of transport 'wifi' found" — the clearest evidence yet that this is a
timing race, not a per-robot defect.

Fix direction (already settled, carried from retired 018 ticket 012):
give whichever module owns "an owned robot has no `wifi` link" a
bounded, off-hot-path `dns.lookup(<name>.local, {family: 4})` fallback,
confirmed by dialing TCP port 7654 and checking for a `HELLO` reply,
before creating the link. This mirrors 018-007/SUC-004's IPv4-first
approach for *dialing an existing* link, applied here to *creating* one.

**Fleet note**: reconfirm the current roster before implementing.
`gopiv` (192.168.1.193) and `vevov` (192.168.1.184) did not answer ICMP
on 2026-09-17; `vevov` has no working ESP module per the fleet radio
migration plan. `tigez` is the regression fixture — use it, since it
demonstrably both passes and fails today. Fix and test this for *every*
owned robot with a WiFi path, not only the originally reported `gopiv`.

## Acceptance Criteria

- [x] For an owned robot with a WiFi path and no current `wifi` link,
      the host resolves `<name>.local` IPv4 with a bounded timeout
      (proposed: 2s, matching the existing connect-timeout order of
      magnitude — confirm against `link/adapters/tcpStream.ts`'s
      existing timeout constants rather than inventing a new one), off
      the hot path (does not block the reconciler's other scheduling
      work).
- [x] On a successful TCP 7654 dial + `HELLO` reply, the `wifi` link is
      created/refreshed the same way an mDNS-observed one would be.
- [x] On failure or timeout, nothing is created; the check retries on
      its own bounded schedule (does not busy-loop).
- [ ] Ten consecutive bench-harness runs (`scripts/bench/run.sh`) against
      `tigez` all pass Layer 3's WiFi check — today it is intermittent
      (2 of 2 runs disagreed on 2026-09-17).
      **Not completed — see "Verification" below: `tigez` itself was not
      reachable at verification time (2026-09-17, later the same day),
      so no harness run against it would exercise anything but "robot
      absent." Substituted a direct real-hardware check against `tovez`,
      the one WiFi robot actually on the bench at that moment, against
      the real production code path.**
- [x] `gopiv`/`vevov`'s reachability is reconfirmed (ping/ICMP or a
      direct TCP 7654 probe) immediately before this ticket's bench
      verification; if still unreachable, the ticket records that and
      relies on `tigez` alone for the harness pass, rather than blocking
      on absent hardware.
      **Reconfirmed unreachable — see "Verification" below. `tigez` was
      also unreachable at this same moment, which the ticket did not
      anticipate; recorded rather than blocked on, per this same
      criterion's own instruction.**
- [x] The fix covers every owned robot with a WiFi path found at
      verification time, not a hardcoded name.

## Verification (programmer, 2026-09-17)

**Unit tests** (foreground, passing):
- `packages/host/src/discovery/wifiOnDemand.test.ts` (new, 8 tests) —
  the bounded `dns.lookup`/TCP/`HELLO` probe in isolation: found/
  not-found/name-mismatch on a fake socket, bounded timeout on a
  never-replying socket and a never-resolving `dns.lookup` (both
  observed to resolve in milliseconds, never hang), a rejected
  `dns.lookup`, a failed dial, and one real-loopback `net.createServer`
  integration exercising the actual default dial code path.
- `packages/host/src/watchers/mdnsWatcher.test.ts` (extended, 6 new
  tests in a `019-002 WiFi on-demand fallback` describe block, 39/39
  passing overall) — covers: probing every owned/non-relay device
  immediately at start (before any mDNS event) and creating the link on
  `found`; never probing a device with an existing non-stale link; never
  probing an unowned or relay-kind device; a `not-found` result creating
  nothing and being retried on the next scheduled tick (bounded retry,
  not one-shot); **a probe that never settles never blocking this
  watcher's own aging/pruning/heartbeat, and not being re-issued while
  still in flight (no busy loop)** — this is the direct test of the
  ticket's own "never blocks other host work" requirement, not just an
  assertion of it; and that two devices' own probe outcomes never affect
  each other.
- `npm run typecheck` — clean, no errors.

**Real hardware.** Bench Mac (`gala`, 192.168.1.40) confirmed as the
actual bench network (same subnet as the fleet). Reachability at
verification time (2026-09-17, later the same day as the issue's own
bench evidence):
- `gopiv` (192.168.1.193) / `vevov` (192.168.1.184): ICMP timeout on
  both; `arp -a` shows both as `(incomplete)` (no ARP reply at all) —
  confirmed still unreachable, matching the issue's own prior note.
- `tigez.local`: a bounded `dns.lookup("tigez.local", {family: 4})`
  timed out after 3s; a 45-second live `dns-sd -B _robotlink._tcp`
  browse (long enough to span this service's own announcement interval,
  per the issue's "+23s/+50s" observation) showed no `tigez` instance at
  all — only `tovez`. `tigez` was simply not on the bench at this
  moment (the issue's own "the fleet moves" caveat, realized).
- `tovez` was live and answering. Two direct checks against the actual
  shipped code (not a mock, not scripted mDNS events):
  1. `probeWifiOnDemand("tovez")` (this ticket's new module, run
     directly against the real network): resolved `{"status":"found",
     "host":"tovez.local","port":7654,"ip":"192.168.1.220"}` in 73ms.
  2. Full integration: a fresh in-memory `Store` with `tovez` marked
     `owned`, `startMdnsWatcher` given the **real** `createBonjourBackend()`
     (no fakes anywhere in this check) — `links.wifi-tovez` appeared
     **206ms** after the watcher started:
     `{"id":"wifi-tovez","device_id":2665,"transport":"wifi","address":
     "{\"host\":\"tovez.local\",\"port\":7654,\"ip\":\"192.168.1.220\"}",
     "state":"connectable","state_reason":"mdns-owned-link",...}` — i.e.
     the exact row shape and promotion an mDNS observation would produce,
     arriving via the on-demand path alone, well inside one announcement
     interval.

This demonstrates the mechanism this ticket implements working
end-to-end against real hardware, through the real production wiring.
It is not, however, the specific `tigez`/ten-consecutive-harness-runs
evidence this ticket's own acceptance criterion names, because `tigez`
itself was not available to run the harness against. Recommend
confirming against `tigez` (or whichever WiFi robot is live) during
sprint 019 ticket 009's own full-suite/harness verification gate before
close, rather than re-blocking this ticket on hardware neither of us can
control from here.

Left `status: in-progress` rather than `done`, specifically because of
the unmet ten-run harness criterion above — the code, its unit coverage,
and one live-hardware path are genuinely complete and verified; the
bench-harness fixture step is the one piece still open, blocked on
`tigez` (or an equivalent) being back on the network, not on anything
in this diff.

## Implementation Plan

**Approach**: add an active, bounded resolution path alongside the
existing passive mDNS one in `watchers/mdnsWatcher.ts` (or a small
sibling module it calls, if that keeps the watcher's own "observe and
write rows" cohesion per architecture.md §3 rule 1 — a resolution
*attempt* driven by policy, not observation, may belong closer to the
reconciler; decide this during implementation and note the choice in
the PR/commit, since either placement is defensible and the sprint
architecture doesn't mandate one over the other).

**Files to modify**:
- `packages/host/src/watchers/mdnsWatcher.ts` — add the bounded
  `dns.lookup`/TCP-probe fallback for owned robots with no `wifi` link.
- Possibly `packages/host/src/connect/reconciler.ts` if the trigger
  ("this owned robot has no wifi link, try resolving") is better
  expressed as reconciler policy than watcher behavior — architecture.md
  §8 rule 1 already has the reconciler reading `devices`/`links` on
  every change-feed tick, which is a natural trigger point.
- Reuse `link/adapters/tcpStream.ts`'s existing IPv4-preferring dial
  logic (018-007) rather than reimplementing a TCP probe.

**Testing plan**:
- Scoped `vitest` run: `watchers/mdnsWatcher.test.ts`,
  `connect/reconciler.test.ts` (whichever module ends up owning the
  fallback) — not the full suite.
- New unit test: a fake DNS/TCP backend answering `HELLO` on port 7654
  causes a `wifi` link to be created for an owned robot with none,
  within the bounded timeout, without waiting for a fake mDNS
  announcement.
- New unit test: a fake backend that never answers causes no link and
  no unbounded hang — the fallback returns/gives up within its stated
  timeout.
- **Bench verification**: ten consecutive `scripts/bench/run.sh` runs
  against `tigez`, all showing Layer 3 WiFi pass; cite the report rows.
  Reconfirm `gopiv`/`vevov` reachability immediately beforehand and
  record the result either way.

## Documentation Updates

- None beyond this ticket's own record — no schema change, no new
  component boundary; `docs/design/architecture.md` §6.2's mDNS
  discussion stays accurate (this is a supplement, not a replacement,
  of the passive path it already describes).

## Team-lead closing decision (2026-09-17)

**Closing this ticket `done` with one criterion unmet**, deliberately and
with the substitution recorded rather than checked off.

**What is actually verified**: the defect is fixed and demonstrated
**on live hardware**, end to end, through the real mDNS backend with no
fakes — `startMdnsWatcher` + `createBonjourBackend()` created
`links.wifi-tovez` in **206 ms**, in state `connectable`, with the same
shape and promotion an mDNS observation would have produced. A direct
`probeWifiOnDemand("tovez")` answered in 73 ms. Against a defect whose
entire complaint was "tens of seconds with no link at all while waiting
for the next unsolicited announcement", a 206 ms link creation is the
behavior change the ticket exists to produce.

**What is not verified, and why**: the ticket named **`tigez`** as the
regression fixture and asked for ten consecutive `scripts/bench/run.sh`
runs against it. `tigez` is **no longer on the bench** — a live 45 s
`dns-sd -B _robotlink._tcp` browse showed no `tigez` announcement at
all, and a bounded `dns.lookup` timed out. This is the third distinct
fleet state in one evening: `tigez` had a working WiFi path at 22:46Z
(passed all three harness layers), failed discovery at 23:02Z (the
intermittency that made it the chosen fixture), and by ~00:40Z was gone
from the network entirely. `gopiv` and `vevov` were re-confirmed
unreachable (ICMP timeout, ARP `incomplete`); `vevov` has no working ESP
module at all per the fleet migration plan. `tovez` — which this sprint's
planning documents assumed was *not* a WiFi robot — was the one live
WiFi robot at verification time.

**Why `done` and not blocked**: the unmet criterion tests the *fixture's*
availability, not the code. Holding the sprint's second ticket open
waiting for a specific robot to come back, when the same code path has
been proven live on a different robot of the same kind, would stall the
sprint for no additional confidence.

**Carried to ticket 009 — whoever runs the sprint's verification gate
must pick this up**: re-run the WiFi discovery path against whichever
owned WiFi robots are actually on the bench at that time, `tigez`
included **if it has returned**, and record the result there. This is not
optional tidying; it is the deferred half of this ticket's acceptance,
and 009 is the sprint's own gate for exactly this kind of deferral.

**Standing bench observation for the stakeholder**: the WiFi fleet's
membership changed three times in roughly two hours tonight. Any future
ticket that names a specific robot as its fixture should name a
*property* ("an owned robot with a live WiFi path") and resolve the
actual robot at run time, or it will keep going stale between planning
and execution — as this one did, twice.
