---
id: 009
title: mbrelay bridge fix against the real torture pool, from an isolated reproduction
status: done
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

- [x] An isolated reproduction script (not the production host)
      demonstrates the working handshake against the real `torture` pool
      for `vevov` and `gopiv`, capturing the exact byte/line sequence
      including the colon-dialect banner's timing.
      (`scripts/bench/repro/mbrelay-reliability.ts`, committed.)
- [x] ~~`connect/relayBridger.ts`'s candidate/reset loop and identify
      schedule after `!GO`, and `link/RelayCommandPlane.ts`'s `!GO`
      confirmation matching (`# entering data plane`) and sync on the
      pool's colon banner, are fixed to match the reproduction's
      observed sequence.~~ **Reproduction finding: not applicable.** The
      isolated reproduction's preamble/banner transcripts (both the raw
      path and the host path composed exactly as `relayBridger.ts`
      builds it) show the handshake through `!GO` and the boot-window
      identify already succeed reliably, byte-for-byte matching the
      manually-verified sequence this ticket's own Description quotes —
      neither module needed a change. The actual, evidence-confirmed
      defect is downstream of a successful connect: an unsequenced query
      (`ID`) with no protocol-level retry, colliding with
      `connect/harvester.ts`'s own `STATUS` poll on the same lossy radio
      hop. See Implementation Plan / completion notes below for the
      real root cause and fix location.
- [x] `connect/connector.ts`'s `buildRelayPreamble` is updated if the
      reproduction shows the preamble itself needs adjustment — the
      reproduction showed it does not; left unchanged (condition not
      triggered).
- [x] A bridge through `torture` to `vevov` or `gopiv` reaches
      `connected`/`Linked` and answers `ID` reliably across repeated
      attempts (not intermittently) — reconnect-then-retry is exercised
      at least 3 times in a row without a failure. (Harness evidence
      below.)
- [x] `tovez`/`tigez` unreachability via `torture` is recorded in this
      ticket's completion notes as a Layer-1 environment result (from
      ticket 001's raw probe), not investigated as a host defect.
- [x] Unit tests: seeded from the isolated reproduction's own captured
      transcript (the exact `id diffdrive ...`/decoded-verb shapes and
      the observed "poll and query sent within the same pacing window"
      collision), added to `link/LineLink.test.ts` (the resend/gate
      mechanism itself) and `connect/harvester.test.ts` (the poll's own
      deferral) — the two files the real fix actually landed in, per
      the reproduction's own finding above. `RelayCommandPlane.test.ts`/
      `relayBridger.test.ts` are unchanged: the reproduction found no
      defect in either module to pin a regression test against.
- [x] **Harness command and evidence**: `scripts/bench/run.sh
      --skip-held --allow-shared-bench --report <path>` run against the
      real `torture` pool, three times in a row; `torture` → `vevov` and
      `torture` → `gopiv` passing Layer 1/2/3, and `torture` →
      `tovez`/`tigez`/`vitut` Layer-1-unreachable with the raw evidence
      cited. See completion notes for the three runs' quoted rows.

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

## Completion Notes (2026-09-13)

### Root cause (evidence-driven, not the ticket's original guess)

The isolated reproduction (`scripts/bench/repro/mbrelay-reliability.ts`)
showed the `!ECHO OFF -> !MODE RAW250 -> !CG -> !P 7 -> !GO` command-plane
preamble and the `HELLO`/banner identify already succeed reliably against
the real `torture` pool, for both `vevov` and `gopiv`, over both the raw
path and the host path composed exactly as `relayBridger.ts` builds it
(`LineLink` + `tcpStream` + `connector.ts`'s `buildRelayPreamble`) — no
defect in `relayBridger.ts`, `RelayCommandPlane.ts`, or
`connector.ts`'s preamble. The real defect is downstream of a successful
connect: `ID` is an **unsequenced** verb (`isSequencedVerb` does not
list it — protocol.md's 11 id-bearing verbs are `GET/SET/TLM/STOP/RUN/
WHEELS_X/WHEELS_V/MOVE_X/MOVE_V/GO_TO_R/GO_TO_W/FUNCS/WIFICRED`), so it
gets none of the ack/nack resend the sequenced verbs get — one lost
packet on the radio hop is simply gone. `connect/harvester.ts`'s own
`STATUS` poll (every 2s, also unsequenced) can be scheduled at the same
moment a student's own `ID` query is sent, and a live capture confirms
the two colliding:

```
{t: 694, dir: 'info', line: 'banner in 24ms: ...gopiv...'}
{t: 694, dir: 'info', line: 'STATUS poll sent'}
{t: 694, dir: 'info', line: 'sending ID (ungated)'}
{t: 2697, dir: 'info', line: 'STATUS poll sent'}
{t: 2735, dir: 'rx', line: '[decoded status] [...]'}   <- STATUS #2 answered
{t: 4699, dir: 'info', line: 'STATUS poll sent'}
{t: 4734, dir: 'rx', line: '[decoded status] [...]'}   <- STATUS #3 answered
{t: 5697, dir: 'info', line: 'no id reply within 5000ms'}   <- ID never answered
```

Both `STATUS` and `ID` were sent at the same instant (t=694); `STATUS`
was answered twice over the following 5s, `ID` never was — the exact
"STATUS-poll-colliding-with-a-student's-own-query" mechanism the
dispatch instructions flagged as the prime suspect.

### The rule implemented

1. **One bounded resend for a foreign (student-originated) unsequenced
   query.** `LineLink.sendUnsequencedQuery()` (new method,
   `packages/host/src/link/LineLink.ts`) sends once, waits
   `DEFAULT_UNSEQUENCED_QUERY_RESEND_MS` (1500ms) for the matching
   decoded reply verb, and if none arrived, resends the identical line
   once and waits the same bound again before giving up — safe because
   every verb ever sent unsequenced is either a pure query or an
   idempotent state-set (`ESTOP`), never ordering-sensitive the way a
   sequenced verb's own id is. `server.ts`'s `send-command` dispatch now
   calls this method for any non-sequenced verb (`ID`/`STATUS`/`HELP`/
   `DEBUG`/`VER`/`ESTOP`/...), replacing the old plain `sendUnsequenced`
   call there.
2. **The harvester's own `STATUS` poll defers to a foreign query still
   in flight.** `LineLink.hasPendingUnsequencedQuery` is `true` for the
   whole window above; `connect/harvester.ts`'s `pollStatus()` checks it
   before every tick and skips sending `STATUS` entirely while `true` —
   a skipped tick is not counted as a missed poll. The harvester's own
   internal sends (its initial `ID` probe, `STATUS` itself) deliberately
   keep using the plain, unchanged `sendUnsequenced()` — gating the poll
   on its own prior send would let a link that never answers at all
   starve every later tick indefinitely, defeating the missed-poll
   watchdog (caught by a real regression while writing this ticket's own
   unit tests — see below).

Applied uniformly to every transport (not scoped to radio only), matching
this codebase's existing posture on the missed-poll-ceiling
generalization.

### Reproduction counts

`scripts/bench/repro/mbrelay-reliability.ts`, real `torture` pool
(`torture.local:8760`), same night, same shared-bench conditions
(stakeholder's own `scripts/dev.mjs`, pid 82496, running throughout —
never signaled). Two confounds identified and separated from this
ticket's own target defect (both documented in the repro script's own
doc comment):

- **Pool relay-recycling** (`# ERROR: no relay available (N devices, 0
  in use, N being handed back)`): rapid back-to-back reconnection can
  outrun the pool's own relay handback — a real-hardware constraint of
  the shared pool, not fixed by this ticket. Mitigated (not eliminated)
  by `--interAttemptDelayMs`.
- **Concurrent independent traffic** from the stakeholder's own
  already-running host (also bridging to these same robots over the
  same channel) appears as unprompted `HELLO`/banner lines in captured
  transcripts — expected on a genuinely shared bench.

First pair (20 attempts/name/path, back-to-back, `ungated` vs a version
of `gated` that — caught only after this first pair had already run —
mistakenly still called the plain `sendUnsequenced`, not the new
`sendUnsequencedQuery`; kept only as the `ungated` baseline, since that
mode's own behavior was unaffected by the mistake):

| | vevov host | vevov raw | gopiv host | gopiv raw |
|---|---|---|---|---|
| before (ungated) | 14/20 | 10/20 | 13/20 | 10/20 |

Corrected pair (15 attempts/name/path, `--interAttemptDelayMs 800`,
`gated` now genuinely calling `sendUnsequencedQuery`):

| | vevov host | vevov raw | gopiv host | gopiv raw |
|---|---|---|---|---|
| after (gated) | 12/15 | 8/15 | 12/15 | 9/15 |

Every host-path failure in the corrected "after" run (6 of 60 attempts)
was `preamble/connect failed` (the pool-recycling confound above) —
**zero** "no id reply" failures on the host path once past the
preamble, across both robots. One attempt (`vevov` host `#11`) shows the
resend firing and recovering a lost first send: `id reply within
1529ms` — 1500ms is exactly `DEFAULT_UNSEQUENCED_QUERY_RESEND_MS`. The
raw-path counts (unaffected by any host-side change, included for
comparison) confirm the radio hop itself is independently lossy
(`vevov`/`gopiv` raw both show "no id reply" and preamble-step timeouts
of their own) — the aggregate before/after host numbers are dominated by
the pool-recycling confound rather than isolating this ticket's own
fix's effect at 15-20 samples; the clean single-attempt harness runs
below are the more representative evidence for real usage (a student
connects once, not 15 times back-to-back).

### Harness evidence — three consecutive clean runs

`scripts/bench/run.sh --skip-held --allow-shared-bench --report <path>`,
three runs in a row, each showing `torture` → `vevov` and `torture` →
`gopiv` passing Layer 1/2/3 (a fourth run, "run1b", is also on record;
its `gopiv` Layer 3 check alone failed with "relay torture never showed
Connected to gopiv within the bound" — the same pool-recycling confound,
L1/L2 for both robots still passed — so runs 2/3/4 below are the three
*consecutive* clean passes cited as evidence):

**Run 2** (`bench-report-009-run2.md`):
```
| gopiv | radio-via-mbrelay:torture | pass | pass | pass | pass | - |
| vevov | radio-via-mbrelay:torture | pass | pass | pass | pass | - |
```
**Run 3** (`bench-report-009-run3.md`):
```
| gopiv | radio-via-mbrelay:torture | pass | pass | pass | pass | - |
| vevov | radio-via-mbrelay:torture | pass | pass | pass | pass | - |
```
**Run 4** (`bench-report-009-run4.md`):
```
| gopiv | radio-via-mbrelay:torture | pass | pass | pass | pass | - |
| vevov | radio-via-mbrelay:torture | pass | pass | pass | pass | - |
```

Layer 3 screenshot headers (quoted verbatim, per the dispatch's own
"paste the counts" instruction):
- `vevov`: "Radio · ch37/grp43 (via relay torture)Linked" — console shows
  `» ID` / `« id diffdrive calibration-0.20260913.1 1.20260912.8 vevov`.
- `gopiv`: "Radio · ch47/grp60 (via relay torture)Linked" — console shows
  `» ID` / `« id diffdrive calibration-0.20260913.1 1.20260912.8 gopiv`.

Every run also shows `tigez`/`tovez`/`vitut` via `torture` as Layer-1
`environment` ("timeout: no radio reply (name likely unreachable via
this pool)") — matching ticket 001's own already-recorded evidence
(`tigez, tovez, vitut | radio-via-mbrelay:torture (sweep) | fail |
timeout: no radio reply`) — not investigated as a host defect, per this
sprint's own Scope.

### Test totals

`npx vitest run packages/host/src/connect packages/host/src/link
scripts/bench`: **493 passed** (35 files), including 6 new
`LineLink.test.ts` cases (`sendUnsequencedQuery`'s resend/gate behavior)
and 2 new `harvester.test.ts` cases (the poll's own deferral). `npm run
typecheck` and `npm run build` both clean.

### Files touched

- `scripts/bench/repro/mbrelay-reliability.ts` (new — the required
  isolated reproduction).
- `packages/host/src/link/LineLink.ts` (`sendUnsequencedQuery`,
  `hasPendingUnsequencedQuery`, `expectedReplyVerbFor`,
  `DEFAULT_UNSEQUENCED_QUERY_RESEND_MS`).
- `packages/host/src/connect/harvester.ts` (`pollStatus` defers to
  `hasPendingUnsequencedQuery`).
- `packages/host/src/server.ts` (`send-command` dispatch calls
  `sendUnsequencedQuery` for a non-sequenced verb).
- `packages/host/src/link/LineLink.test.ts`,
  `packages/host/src/connect/harvester.test.ts` (new coverage).
- Not modified: `connect/relayBridger.ts`, `link/RelayCommandPlane.ts`,
  `connect/connector.ts` — the reproduction found no defect in any of
  the three.
