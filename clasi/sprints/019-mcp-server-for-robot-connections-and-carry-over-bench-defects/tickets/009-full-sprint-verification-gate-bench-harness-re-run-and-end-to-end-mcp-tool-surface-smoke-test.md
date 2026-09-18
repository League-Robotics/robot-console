---
id: '009'
title: 'Full-sprint verification gate: bench harness re-run and end-to-end MCP tool
  surface smoke test'
status: open
use-cases:
- SUC-001
- SUC-002
- SUC-003
- SUC-004
- SUC-005
- SUC-006
- SUC-007
depends-on:
- '001'
- '002'
- '003'
- '004'
- '005'
- '006'
- '007'
- '008'
github-issue: ''
issue:
- mcp-server-for-robot-connections.md
- bench-relay-port-contention-sweeper-vs-session.md
- bench-wifi-robot-discovery-waits-for-announcement.md
- harvester-has-no-teardown-seam.md
completes_issue: true
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Full-sprint verification gate: bench harness re-run and end-to-end MCP tool surface smoke test

## Description

Sprint exit gate, mirroring sprint 018 ticket 011's role: not new
feature work, but the point where every prior ticket's evidence is
assembled and re-checked together, on the real bench where hardware
permits. Depends on every other ticket in this sprint.

Three things this ticket must produce:

1. **Carry-over defect re-verification** against the current bench
   roster: ticket 001's relay-lease-takeover fix (hardware-conditional —
   requires a physically attached USB relay, absent as of 2026-09-17),
   ticket 002's WiFi on-demand discovery fix (`tigez` as the fixture,
   `gopiv`/`vevov` reconfirmed or explicitly recorded as still
   unreachable), and ticket 003's harvester teardown regression test
   (already covered by ticket 003's own unit test — this ticket's job
   is to confirm it's still green after everything else in the sprint
   landed, not to re-derive it).
2. **End-to-end MCP tool surface smoke test**: inspect → connect/
   command → drive-with-approval → flash-with-approval, run against a
   fake/in-memory store per the host's existing test convention (per
   `sprint.md`'s Test Strategy), plus a live smoke test against a real
   running host if a real MCP client is available to drive it.
3. **Sprint 018 carry-forward item**: UC-016's radio-via-host-attached-
   relay failover path, unverified at 018's close purely because no USB
   relay was attached. Verify it now if a relay is attached at execution
   time; if not, state so explicitly and carry it forward again rather
   than silently dropping it.

## Acceptance Criteria

- [ ] `scripts/bench/run.sh` is re-run on a genuinely exclusive bench
      (no `npm run dev`, no concurrent harness run — verified via `lsof`
      the way the harness already checks); the report is attached/cited
      in this ticket's closing notes.
- [ ] Ticket 001's relay-lease-takeover fix: verified against a
      physically attached USB relay if one is available at execution
      time; if not, this criterion is marked explicitly
      unverified-hardware-absent, with the date, not silently checked
      off.
- [ ] Ticket 002's WiFi fix: `tigez` passes Layer 3 across at least ten
      consecutive runs (per ticket 002's own criterion) — cite the
      report rows here rather than re-deriving new evidence.
      `gopiv`/`vevov` reachability is reconfirmed at execution time.
- [ ] Ticket 003's harvester regression test is confirmed still green
      after every other ticket's changes (a full scoped run of
      `connect/harvester.test.ts` and `runtime.test.ts`, not a re-audit).
- [ ] An end-to-end scripted test exercises, against a fake store:
      `list_devices` → `open_session` → `send_command STATUS` →
      `request_drive` → simulated Approve → confirm the command was
      sent → `close_session`; and separately, `request_flash` →
      simulated Approve → confirm `startFlash` was called. Both paths
      also confirm a Deny/expire produces no send/flash.
- [ ] If a real MCP client is available (e.g. Claude Code itself, via a
      temporary `.mcp.json` entry pointed at a locally running `npx
      robot-console`), a live smoke test connects, lists devices, and
      calls `get_device_status` for at least one real robot; documented
      manually in this ticket's closing notes. Not blocking if no client
      is conveniently available at execution time — state so explicitly.
- [ ] Sprint 018's UC-016 (radio-via-host-attached-relay failover) is
      verified if a USB relay is attached at execution time; otherwise
      explicitly recorded as still-carried-forward, with the date, for
      whichever future sprint next has bench access to a relay.
- [ ] `docs/design/architecture.md` gains a consolidated section for the
      MCP subsystem (transport, tool categories, the confirmation
      mechanism, the new `pending_actions`/`sessions` columns),
      synthesizing tickets 004-008's design rather than restating
      `sprint.md`'s own Architecture section verbatim — per the
      `consolidate-architecture` convention this project already
      follows sprint-over-sprint.
- [ ] One full `npm test` run happens as part of `close_sprint`'s own
      pre-close gate (per `.claude/rules/source-code.md`) — this ticket
      does not itself run the full suite; it names the scoped test files
      above.

## Implementation Plan

**Approach**: assemble and cite evidence from every prior ticket, run
the harness fresh, write the new integration-style end-to-end test, and
write the consolidated architecture doc update. This ticket should
produce no substantial new production code beyond what wiring the
end-to-end test reveals is missing (if the end-to-end test finds a real
gap between tickets, fix it here and note why it wasn't caught earlier).

**Files to create**:
- An end-to-end test file, e.g. `packages/host/src/mcp/
  endToEnd.test.ts`, covering the full inspect → connect → drive-
  approve → flash-approve path against a fake store.

**Files to modify**:
- `docs/design/architecture.md` — new MCP subsystem section.
- `scripts/bench/README.md` if the harness needs any note about the new
  MCP surface (likely not required — the harness tests the WS/UI path,
  not MCP — but confirm during implementation rather than assuming).

**Testing plan**:
- Scoped `vitest` run: the new end-to-end test, plus
  `connect/harvester.test.ts`/`runtime.test.ts` (re-confirm ticket 003),
  `mcp/**/*.test.ts` (re-confirm tickets 004-008) — not the full suite.
- Bench harness run per the acceptance criteria above, with hardware
  preconditions stated explicitly where unmet.
- Full `npm test` is `close_sprint`'s own job, not this ticket's.

## Documentation Updates

- `docs/design/architecture.md`: new consolidated MCP subsystem section
  (see Acceptance Criteria).
- `sprint.md`'s own Architecture/Use Cases sections stay as the
  sprint-scoped record; the consolidated doc update here is what carries
  the design forward past this sprint, per this project's existing
  `consolidate-architecture` pattern.
