---
id: '012'
title: 'Relays and WiFi robots are reachable without races: sweeper yields the port
  to any open; host finds WiFi robots without waiting for an announcement'
status: open
use-cases:
- SUC-004
- SUC-006
depends-on:
- '010'
github-issue: ''
issue:
- bench-relay-port-contention-sweeper-vs-session.md
- bench-wifi-robot-discovery-waits-for-announcement.md
completes_issue: true
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Relays and WiFi robots are reachable without races: sweeper yields the port to any open; host finds WiFi robots without waiting for an announcement

## Description

Two related "found reachable, but not really" defects surfaced by
tonight's harness runs, both about a link existing/being openable at
the moment something actually needs it, not eventually:

**1. Relay port contention (`bench-relay-port-contention-sweeper-vs-session.md`).**
016-004 already made bridging (`session-open {relayLinkId, name}`)
take a sweep over through the `relayLeaseRevocation` seam. A *direct*
console open of the relay's own USB link (`session-open {linkId: <relay
usb link>}`) does not go through that seam, so it races the relay
sweeper's intermittent raw-port open (~30 s cadence) and fails "Cannot
lock port" even though no other process holds the port at that
instant — confirmed by 20 s of 250 ms `lsof` sampling showing no
external holder while the sweeper's own heartbeat kept advancing.
Every open of a relay's serial port — console session, bridge, or
flash — must go through the same takeover seam. A port genuinely held
by a different *process* is a separate, distinguishable failure and
must say so in plain words, not "Cannot lock port."

**2. WiFi discovery waits for an announcement
(`bench-wifi-robot-discovery-waits-for-announcement.md`).** The WiFi
robots' mDNS responder (`gopiv` 192.168.1.193, `vevov` 192.168.1.184,
`_robotlink._tcp` port 7654) only sends unsolicited periodic
announcements and never answers queries, so `mdnsWatcher` may leave an
owned WiFi robot with no `wifi` link at all for tens of seconds after
host start. Harness run bench-report-008 hit this directly: `gopiv
wifi` failed Layer 3 with "no live-snapshot link of transport wifi
found," and the harness itself had to grow a name-lookup fallback in
its own Layer 1 to route around the gap. For an owned robot with no
current `wifi` link, the host should resolve `<name>.local` IPv4 with
a bounded timeout, off the hot path, and create/refresh the `wifi`
link when TCP 7654 answers `HELLO` — without blocking other host work.

Both defects share a shape: something the host already knows how to do
correctly in one path (sweeper takeover for bridging; IPv4-first
dialing once a link exists, per ticket 007/SUC-004) needs to also
happen in a second path that currently has no such guarantee (direct
relay console open; link creation itself, before any dial is even
possible).

## Acceptance Criteria

- [ ] A direct relay console open (`session-open {linkId: <relay usb
      link>}`) that races an in-flight sweeper pass takes the relay
      over through the `relayLeaseRevocation` seam within one probe and
      reaches `connected` — it never reports "Cannot lock port" for our
      own sweeper.
- [ ] A port genuinely held by another *process* reports a distinct,
      plain-language reason ("another app has this relay open"), not
      "Cannot lock port."
- [ ] Two host processes on one machine do not silently fight over the
      same relay: the second host detects the first (port-lock failure
      plus a robot-console process present) and reports it once.
- [ ] For an owned robot with no current `wifi` link, the host resolves
      `<name>.local` IPv4 with a bounded timeout, off the hot path, and
      creates/refreshes the `wifi` link once TCP 7654 answers `HELLO`.
- [ ] This resolution never blocks other host work (watcher loop,
      other links' polling) while it waits on the bounded timeout.
- [ ] **Unit tests**:
  - Sweep-in-flight + direct relay console open → takeover within one
    probe, no "Cannot lock port".
  - Port held by another process → distinct "another app has this
    relay open" reason.
  - WiFi fallback creates the link within N s of host start for a
    robot whose announcement never arrives during the test window.
- [ ] **Harness evidence**: `scripts/bench/run.sh --skip-held` on an
      exclusive bench (or `--allow-shared-bench` with any contention
      rows explained), with the harness host's own sweeper ENABLED, for
      a dedicated relay-console case, showing:
  - `vitut usb` (relay console, not bridging) passing Layer 2 and Layer
    3.
  - `gopiv wifi` passing Layer 3 within 10 s of host start, in three
    consecutive runs.

## Implementation Plan

**Approach**:
- Relay contention: extend the `relayLeaseRevocation` takeover seam
  (016-004) so that a direct console `session-open` on a relay's own
  USB link goes through the same lease-takeover path bridging already
  uses, rather than opening the raw port independently. Distinguish
  "sweeper holds it" (takeover, no error) from "another process holds
  it" (distinct reason string) by classifying the port-open failure
  (e.g. `EBUSY`/`EAGAIN` plus a liveness check against the sweeper's
  own in-process state, vs. a failure that persists after takeover is
  attempted).
- WiFi discovery: give the mDNS watcher (or the connector, whichever
  owns "no current wifi link for an owned robot") a bounded, off-hot-path
  `dns.lookup(<name>.local, {family: 4})` fallback that fires when an
  owned robot has no `wifi` link yet, then confirms the resolved
  address by dialing TCP 7654 and checking for `HELLO` before creating
  the link — mirroring the IPv4-first approach ticket 007/SUC-004
  already established for dialing an *existing* link, applied here to
  creating the link in the first place.

**Files likely touched** (host-side; exact modules per the current
architecture's watcher/connector boundaries — confirm against source
before editing): the relay sweeper / lease-revocation seam (per
016-004 and ticket 009's mbrelay work), and `mdnsWatcher`/connector
(per ticket 007's WiFi IPv4-first fix).

**Testing plan**: unit tests as listed in Acceptance Criteria, run
scoped to the touched modules (per this project's per-ticket testing
rule — the full suite runs once at `close_sprint`), plus the harness
evidence run described above against the real bench.

**Documentation updates**: none expected beyond this ticket's own
completion notes recording the harness evidence; if the takeover seam
or WiFi discovery flow's documented behavior in the architecture
changes materially, note it in this ticket's completion notes for the
sprint's closing architecture reconciliation.
