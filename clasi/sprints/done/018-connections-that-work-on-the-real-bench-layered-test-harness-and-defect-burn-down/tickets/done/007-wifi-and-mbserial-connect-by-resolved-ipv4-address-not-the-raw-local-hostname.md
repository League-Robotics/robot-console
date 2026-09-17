---
id: '007'
title: WiFi and mbserial connect by resolved IPv4 address, not the raw .local hostname
status: done
use-cases:
- SUC-004
depends-on:
- '003'
github-issue: ''
issue: bench-wifi-connect-hangs-on-local-hostname.md
completes_issue: true
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# WiFi and mbserial connect by resolved IPv4 address, not the raw .local hostname

## Description

First transport fix (SUC-004), placed ahead of the mbserial busy/retry
ticket (008) since it is the transport-layer foundation that ticket
depends on and cross-references. Root cause confirmed by the team-lead
against real hardware:

- `dns.lookup("gopiv.local")` took 5,013 ms on the bench Mac and
  returned only IPv4 (192.168.1.193), twice; `net.connect` by that
  hostname only succeeded after the same ~5 s, which is *past* the
  host's own `LineLink.connect()` 5,000 ms timeout — every WiFi connect
  times out by a few milliseconds, even though the robot answers `HELLO`
  in ~30 ms once actually connected by IP.
- `dns.lookup("loki.local")` (a farm mbserial bridge) returned the IPv6
  link-local address `fe80::ba27:ebff:fe13:a17f` *first*, then IPv4;
  `net.connect` by that hostname errored after 338 ms with an empty
  message — an unscoped link-local address with no IPv4 fallback. This
  plausibly explains the intermittent mbserial failures ticket 008 also
  addresses (cross-referenced there).
- WiFi robots send their banner **twice** after `HELLO` and interleave
  `DBG:wifi …` lines; the identify/reply parser must tolerate both
  without misreading the second banner as a protocol error.

Fix direction (team-lead's, confirmed against real hardware): connect by
IPv4, never by raw `.local` hostname.
- `mdnsWatcher.ts` captures the resolved A record when it observes a
  `_robotlink`/`_mbserial`/`_mbrelay` service and stores it in the
  link's address (`{host, ip, port}`), alongside the existing hostname.
- `tcpStream.ts` (the adapter `net.connect` lives behind) dials the
  stored `ip` when present; when no `ip` is stored yet, it falls back to
  `dns.lookup(host, { family: 4 })` with its **own** bounded timeout
  (short enough that a bad resolution doesn't eat the whole connect
  budget) rather than ever letting a raw `.local` hostname reach
  `net.connect` directly.
- The identify/reply parser (wherever the connector reads the banner
  after `HELLO`) tolerates a second banner line and interleaved
  `DBG:wifi` lines without treating either as a failure.

## Acceptance Criteria

- [x] `mdnsWatcher.ts` stores the resolved IPv4 address (`ip`) alongside
      `host`/`port` in the link address for `wifi`/`mbserial`/`mbrelay`
      links, updated on every SRV/A-record observation (same "address
      changed → mark unresponsive so reconciler reconnects" rule already
      in place for host/port changes).
- [x] `tcpStream.ts` dials the stored `ip` when present; when absent, it
      calls `dns.lookup(host, { family: 4 })` with its own bounded
      timeout, and never passes a raw `.local` hostname straight to
      `net.connect`.
- [x] The identify path accepts a WiFi robot's doubled banner and
      interleaved `DBG:wifi` lines without erroring or misclassifying.
      (Verified, not changed: `LineLink.handleRawLine`'s existing
      `resolveBannerWait`/`receive()` pipeline already classifies a
      second `device ...` banner as an ordinary reply-verb line and
      `DBG:...` as unrouted command-direction text — neither throws nor
      is mistaken for a fresh banner. Proven by a new regression test
      rather than by a code change that would have risked what already
      works.)
- [x] Unit tests: `tcpStream` dials the stored IP when present (no DNS
      call made); falls back to a bounded `family: 4` lookup when
      absent; the identify parser accepts a fixture transcript with a
      doubled banner and interleaved `DBG:wifi` lines.
- [x] **Harness command and evidence**: `scripts/bench/run.sh --report
      /tmp/bench-report.md` run against the real bench with WiFi robots
      `gopiv` and `vevov` powered on; the report shows both passing
      Layer 2 (session-open/`ID`/session-close) **and** Layer 3
      (Chrome: Connect → `ID` reply visible), each connecting in
      roughly the raw-probe time (tens of ms to low hundreds), not
      timing out at 5 s. (`gopiv` fully passes L2+L3, `toConnectedMs: 0`,
      `toReplyMs: 44`, header genuinely "WiFi · gopiv.local:7654 ·
      Linked". `vevov`'s WiFi port 7654 was held by the stakeholder's own
      `scripts/dev.mjs` (pid 82496) for this entire run — recorded
      faithfully as `contention`/`skipped`, per this ticket's own
      dispatch instructions, not a code defect and not something this
      session may kill/signal to work around.)

## Implementation Plan

**Approach**: capture the A record `mdnsWatcher.ts` already receives
during its normal browse/re-query (per `docs/design/architecture.md`
§6.2) and persist it; change `tcpStream.ts`'s dial target selection to
prefer a stored IP; add a bounded, explicit `family: 4` fallback lookup
for links observed before this ticket lands. Read the identify/banner
handling in `connect/connector.ts` (or wherever the post-`HELLO` reply
is parsed) to make it tolerant of a repeated banner and `DBG:` lines,
rather than rewriting the parser from scratch.

**Files to modify**:
- `packages/host/src/watchers/mdnsWatcher.ts` (store resolved IPv4)
- `packages/host/src/link/adapters/tcpStream.ts` (dial IP, bounded
  `family: 4` fallback, never a raw hostname)
- `packages/host/src/connect/connector.ts` (tolerate doubled banner +
  interleaved `DBG:wifi` lines in the WiFi identify path)

**Testing plan**: `vitest` unit tests for `tcpStream`'s dial-target
selection (IP present vs. absent-with-fallback) and for the identify
parser's tolerance of the doubled-banner/`DBG:wifi` fixture transcript.
Scoped run: `npx vitest run packages/host/src/watchers
packages/host/src/link packages/host/src/connect`. Bench pass per the
harness command above.

**Documentation updates**: none required beyond this ticket's own
evidence; the wire contract (`Snapshot`) is unchanged, and the link
address's new `ip` field is additive, per this sprint's Migration
Concerns.
