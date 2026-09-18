---
id: '002'
title: WiFi on-demand link discovery (bounded dns.lookup + TCP 7654 HELLO fallback)
status: open
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

- [ ] For an owned robot with a WiFi path and no current `wifi` link,
      the host resolves `<name>.local` IPv4 with a bounded timeout
      (proposed: 2s, matching the existing connect-timeout order of
      magnitude — confirm against `link/adapters/tcpStream.ts`'s
      existing timeout constants rather than inventing a new one), off
      the hot path (does not block the reconciler's other scheduling
      work).
- [ ] On a successful TCP 7654 dial + `HELLO` reply, the `wifi` link is
      created/refreshed the same way an mDNS-observed one would be.
- [ ] On failure or timeout, nothing is created; the check retries on
      its own bounded schedule (does not busy-loop).
- [ ] Ten consecutive bench-harness runs (`scripts/bench/run.sh`) against
      `tigez` all pass Layer 3's WiFi check — today it is intermittent
      (2 of 2 runs disagreed on 2026-09-17).
- [ ] `gopiv`/`vevov`'s reachability is reconfirmed (ping/ICMP or a
      direct TCP 7654 probe) immediately before this ticket's bench
      verification; if still unreachable, the ticket records that and
      relies on `tigez` alone for the harness pass, rather than blocking
      on absent hardware.
- [ ] The fix covers every owned robot with a WiFi path found at
      verification time, not a hardcoded name.

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
