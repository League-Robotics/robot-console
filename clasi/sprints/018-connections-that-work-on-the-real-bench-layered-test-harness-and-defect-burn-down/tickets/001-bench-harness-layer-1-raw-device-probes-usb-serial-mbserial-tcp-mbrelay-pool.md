---
id: '001'
title: 'Bench harness Layer 1: raw-device probes (USB serial, mbserial TCP, mbrelay
  pool)'
status: open
use-cases:
- SUC-001
depends-on: []
github-issue: ''
issue: bench-layered-connection-test-harness.md
completes_issue: false
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Bench harness Layer 1: raw-device probes (USB serial, mbserial TCP, mbrelay pool)

## Description

First ticket of the harness the whole sprint depends on (SUC-001). Build
`scripts/bench/layer1/` — a set of scripts that talk to every discovered
device **directly, with no host process involved**, per the issue's own
Layer 1 definition:

- **USB serial**: enumerate DAPLink devices the same way `usbWatcher.ts`
  does (read the SWD chip id, open the serial port, send `HELLO`, read
  the banner reply). This is read-only probing, not a replacement for
  the watcher.
- **mbserial TCP**: for each known farm bridge host:port (`loki`,
  `magni`, `hodr` or whatever the bench config names), connect over TCP,
  send `HELLO`/`ID`, and specifically detect and report `ERR busy`
  distinctly from a timeout/no-banner.
- **mbrelay pool**: connect to the pool's TCP endpoint (e.g.
  `torture.local:8760`), run the command-plane probe (`> HELLO`) and,
  separately, the full data-plane handshake (`!ECHO OFF`, `!MODE
  RAW250`, `!CG <ch> <grp>`, `!P 7`, `!GO` → `# entering data plane`,
  then `HELLO`/`ID`) against known robot addresses, exactly matching the
  team-lead's verified live-bench sequence.

Output: a structured (JSON) per-device, per-path reachability result
that Layers 2 and 3 (tickets 002-003) consume to decide what to attempt.
This ticket also builds the **exclusivity check**: before running
anything, use `lsof` to detect a process (e.g. `npm run dev`) already
holding a relevant USB/TCP port and refuse to run, saying which
process/port it is.

Never sends a motion/drive verb. Never flashes firmware.

## Acceptance Criteria

- [ ] `scripts/bench/layer1` runs standalone (no host process, no UI)
      and produces a machine-readable (JSON) reachability report: one
      entry per device × path with pass/fail and, on failure, the raw
      reason (e.g. `ERR busy`, `timeout`, connection refused).
- [ ] USB serial probe: `HELLO`/`ID` round-trip works against at least
      one real board on the bench (e.g. a relay-flashed board) with the
      banner captured verbatim.
- [ ] mbserial probe: distinguishes `ERR busy` from a plain timeout in
      its reported reason (this distinction is what ticket 008 later
      relies on to fix the host's own busy handling).
- [ ] mbrelay probe: demonstrates the full working handshake
      (`!ECHO OFF` … `!GO` → `HELLO`/`ID`) against the real `torture`
      pool for at least one radio-reachable name (`vevov` or `gopiv`,
      per this sprint's bench facts), matching the team-lead's manually
      verified sequence byte-for-byte in the captured transcript.
- [ ] The harness refuses to run when `lsof` shows a relevant port held
      by another process (simulate by starting `npm run dev` or holding
      a port with `nc`, and confirm the harness exits with a clear
      message naming the process).
- [ ] **Harness command and evidence**: `node scripts/bench/layer1/run.js
      --out /tmp/bench-layer1.json` (or the actual entry point built)
      run against the real bench; the resulting JSON/log is attached to
      this ticket's completion notes as Layer 1 evidence, since Layers
      2/3 do not exist yet for this ticket to cite as the acceptance
      discipline's "report row" — this ticket's own acceptance is its
      Layer 1 output being correct and evidenced, checked by the
      sprint-planner's own criteria for the harness issue.

## Implementation Plan

**Approach**: pure Node/TypeScript scripts under `scripts/bench/layer1/`,
reusing the *shape* of existing protocol-layer helpers from
`packages/protocol` where possible (e.g. banner-line parsing) but not
importing host internals — Layer 1 must exercise the wire, not the
host's code paths, so a host bug is never masked by sharing its parser.

**Files to create**:
- `scripts/bench/layer1/usbProbe.ts`
- `scripts/bench/layer1/mbserialProbe.ts`
- `scripts/bench/layer1/mbrelayProbe.ts`
- `scripts/bench/layer1/exclusivity.ts` (the `lsof`-based check, shared
  by Layers 2/3 too)
- `scripts/bench/layer1/index.ts` (runs all three, writes JSON)
- `scripts/bench/README.md` (how to run the harness, its exclusivity
  requirement, and its three-layer shape)

**Files to modify**: none in `packages/*` — this ticket is additive.

**Testing plan**: a small `vitest` suite for the exclusivity check
(mock `lsof` output) and for each probe's parsing logic against
captured byte sequences (not live hardware, for CI); the live-hardware
run itself is this ticket's bench evidence, run by hand against the
real devices.

**Documentation updates**: `scripts/bench/README.md` documents the
exclusivity requirement and how to run Layer 1 alone.
