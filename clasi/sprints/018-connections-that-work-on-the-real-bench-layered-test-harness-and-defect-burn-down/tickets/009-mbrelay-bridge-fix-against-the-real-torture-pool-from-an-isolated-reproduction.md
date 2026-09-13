---
id: 009
title: mbrelay bridge fix against the real torture pool, from an isolated reproduction
status: open
use-cases:
- SUC-006
depends-on:
- '003'
github-issue: ''
issue: bench-mbrelay-bridge-fails-where-manual-handshake-works.md
completes_issue: true
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# mbrelay bridge fix against the real torture pool, from an isolated reproduction

## Description

Third transport fix (SUC-006). The host's bridge through the real
`torture` mbrelay pool fails ("relayBridger: candidate … produced no
banner within the identify budget", "transport closed") even though the
identical manual handshake succeeds every time over raw TCP to the same
pool: `!ECHO OFF` → `# echo: OFF`, `!MODE RAW250` → `# mode: RAW250`,
`!CG 47 60` → `# channel: 47 group: 60 …`, `!P 7`, `!GO` → `# entering
data plane`, then `HELLO` → `device NEZHA2 robot gopiv 2175407711` in
~35 ms, `ID` → the full id line. The command plane also answers `>
HELLO` without `!GO`.

Complicating facts from live evidence: `torture` is a **pool** — each
TCP connection is served by a different physical relay
(`zetog:3446622357`, then `gozop:4267970133` on reconnect), so
reconnecting always returns to the command plane (a failed `!GO` never
strands the pool). The pool's first line on connect is the relay's own
banner in **colon dialect**
(`DEVICE:RADIOBRIDGE:relay:<name>:<serial>`), possibly delivered only
after the first command is sent. Updated bench facts (team-lead,
2026-09-13): radio through `torture` reaches `vevov` (ch37/grp43) and
`gopiv` (ch47/grp60) but **not** `tovez` (ch55/grp108) or `tigez`
(ch55/grp114) — this ticket's fix target is the bridging mechanism for
the names `torture` can actually reach; `tovez`/`tigez` staying
unreachable is recorded as Layer-1 environment, not chased here (see
this sprint's Scope and Open Questions).

Per this sprint's Design Rationale, **reproduce the failure in an
isolated script against the real pool before changing production
code** — the pool's per-connection relay reassignment and
possibly-delayed banner are exactly the kind of timing detail that
produces a plausible but wrong fix if guessed at from source alone.

## Acceptance Criteria

- [ ] An isolated reproduction script (not the production host)
      demonstrates the working handshake against the real `torture` pool
      for `vevov` and `gopiv`, capturing the exact byte/line sequence
      including the colon-dialect banner's timing.
- [ ] `connect/relayBridger.ts`'s candidate/reset loop and identify
      schedule after `!GO`, and `link/RelayCommandPlane.ts`'s `!GO`
      confirmation matching (`# entering data plane`) and sync on the
      pool's colon banner, are fixed to match the reproduction's
      observed sequence.
- [ ] `connect/connector.ts`'s `buildRelayPreamble` is updated if the
      reproduction shows the preamble itself needs adjustment (e.g.
      banner-wait timing before the first command).
- [ ] A bridge through `torture` to `vevov` or `gopiv` reaches
      `connected`/`Linked` and answers `ID` reliably across repeated
      attempts (not intermittently) — reconnect-then-retry is exercised
      at least 3 times in a row without a failure.
- [ ] `tovez`/`tigez` unreachability via `torture` is recorded in this
      ticket's completion notes as a Layer-1 environment result (from
      ticket 001's raw probe), not investigated as a host defect.
- [ ] Unit tests: `RelayCommandPlane`/`relayBridger` tests updated or
      added to model the pool's per-connection relay reassignment and
      the possibly-delayed colon banner, using a fake transport seeded
      from the isolated reproduction's captured transcript (so the test
      pins real observed behavior, not a guess).
- [ ] **Harness command and evidence**: `scripts/bench/run.sh --report
      /tmp/bench-report.md` run against the real `torture` pool; the
      report shows `torture` → `vevov` and `torture` → `gopiv` passing
      Layer 2 (session-open/`ID`/session-close) and Layer 3 (Chrome:
      Connect → `ID` reply visible), and shows `torture` → `tovez` /
      `torture` → `tigez` as Layer-1-unreachable with the raw evidence
      cited.

## Implementation Plan

**Approach**: first, write and run a standalone Node script (scratch,
not committed, or placed under `scripts/bench/layer1` if it overlaps
with ticket 001's mbrelay probe — coordinate with that ticket to avoid
duplicating the pool-handshake logic) that reproduces the manual
handshake exactly, against the real pool, for `vevov` and `gopiv`,
capturing full transcripts including timing. Only then modify
`relayBridger.ts`/`RelayCommandPlane.ts`/`connector.ts` to match what
the reproduction shows actually happens, rather than what the source
currently assumes happens.

**Files to modify**:
- `packages/host/src/connect/relayBridger.ts` (reset/`reconnect`
  handling, candidate loop, identify schedule after `!GO`)
- `packages/host/src/link/RelayCommandPlane.ts` (`!GO` confirmation
  matching, sync on the pool's colon banner)
- `packages/host/src/connect/connector.ts` (`buildRelayPreamble`, if the
  reproduction shows it needs adjustment)

**Testing plan**: `vitest` unit tests using a fake transport seeded from
the isolated reproduction's real captured transcript (both the
command-plane and full `!GO` data-plane sequences, including the
per-connection relay-reassignment behavior). Scoped run: `npx vitest run
packages/host/src/connect packages/host/src/link`. Bench pass per the
harness command above — repeated at least 3 times to confirm the fix is
not intermittent, matching the issue's own framing ("the same handshake
works by hand" every time; the host's failure must become equally
reliable, not merely "less often").

**Documentation updates**: none beyond this ticket's completion notes
and the isolated reproduction's captured transcript, kept as this
ticket's regression evidence.
