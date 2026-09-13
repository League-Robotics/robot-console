---
id: '002'
title: 'Bench harness Layer 2: host-over-WebSocket session checks and card-truthfulness
  assertions'
status: open
use-cases:
- SUC-001
depends-on:
- '001'
github-issue: ''
issue: bench-layered-connection-test-harness.md
completes_issue: false
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Bench harness Layer 2: host-over-WebSocket session checks and card-truthfulness assertions

## Description

Second layer of the harness (SUC-001), consuming ticket 001's Layer 1
reachability report. Build `scripts/bench/layer2/`:

- Start (or attach to) a real host process on a fresh state dir
  (optionally seeded from a copy of the real `known-robots.json`, never
  the live file itself).
- Wait for the watchers to settle (poll the snapshot until it stops
  changing across a few seconds, matching sprint 015 ticket 011's own
  bench precedent for "settled").
- For every path Layer 1 marked reachable: `session-open`, `send-command
  ID`, expect the matching `line` rx reply, `session-close`. Record
  pass/fail and the exact reply.
- **Card-truthfulness assertions**, read directly from the snapshot (no
  UI needed for these): no link is `stale`/absent while its underlying
  service is currently advertised (services table `last_seen` fresh);
  no device has `kind: "robot"` while its role/banner history says
  relay; exactly one `devices` row per device name (no duplicates).
- Reuse ticket 001's exclusivity check before running.

This layer is the one every later defect-fix ticket (004-010) is
checked against for its Layer 2 half of the acceptance discipline.

## Acceptance Criteria

- [ ] `scripts/bench/layer2` starts a real host against a fresh/seeded
      state dir, waits for settle, and for each Layer-1-reachable path
      performs `session-open` → `send-command ID` → assert `line` reply
      → `session-close`, recording pass/fail per path.
- [ ] The three card-truthfulness assertions (no stale-while-advertising,
      no relay with `kind: robot`, one row per name) run against the
      live snapshot and are reported per-device, not just as one
      pass/fail for the whole run.
- [ ] Refuses to run non-exclusively (reuses ticket 001's `lsof` check).
- [ ] **Harness command and evidence**: `node scripts/bench/layer2/run.js
      --state-dir <scratch-dir> --out /tmp/bench-layer2.json` run
      against the real bench with at least one USB device attached;
      the JSON output (attached to this ticket's completion notes) shows
      at least one path passing session-open/send-command/session-close
      and the three card-truthfulness assertions evaluated (pass or
      fail, each with a reason) against the real live snapshot.

## Implementation Plan

**Approach**: a thin `ws` client (matching the pattern used in prior
sprints' own bench scratch scripts, e.g. sprint 015 ticket 011's
`wsclient.mjs`, but committed and structured this time) plus a small
assertion library reading the `Snapshot` shape directly — no new host
API, this only calls the existing WebSocket contract from
`docs/design/architecture.md` §9.

**Files to create**:
- `scripts/bench/layer2/wsClient.ts` (open/send-command/close helpers)
- `scripts/bench/layer2/pathChecks.ts` (per-path session round-trip)
- `scripts/bench/layer2/truthfulness.ts` (the three snapshot assertions)
- `scripts/bench/layer2/index.ts` (orchestrates: start/attach host, wait
  settle, run path checks + assertions, write JSON)

**Files to modify**: none in `packages/*`.

**Testing plan**: `vitest` coverage for `truthfulness.ts`'s three
assertions against fixture snapshots (one fixture per violation, one
clean fixture); the live host run is this ticket's bench evidence.

**Documentation updates**: extend `scripts/bench/README.md` with Layer
2's usage and its assertions.
