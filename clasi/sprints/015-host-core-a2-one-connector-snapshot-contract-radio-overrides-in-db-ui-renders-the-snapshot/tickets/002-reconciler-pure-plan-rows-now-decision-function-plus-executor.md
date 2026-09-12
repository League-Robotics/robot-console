---
id: '002'
title: 'Reconciler: pure plan(rows, now) decision function plus executor'
status: in-progress
use-cases:
- SUC-002
- SUC-009
depends-on:
- '001'
github-issue: ''
issue: rearch-05-connector-reconciler-harvester-retire-deviceregistry.md
completes_issue: false
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Reconciler: pure plan(rows, now) decision function plus executor

## Description

Build `packages/host/src/connect/reconciler.ts`: the only component
that decides what should be connected. This replaces the six separate
policy sites in `deviceRegistry.ts` (`syncWifiEndpoints`,
`retryWifiAutoConnects`, `autoConnectWifiRobot`, `autoSwitchRadioToWifi`,
`requestOpen`'s no-op rules, `pollStatus`'s watchdog) with one pure
function plus a thin executor.

`plan(rows: ReconcilerRows, now: number): Job[]` — table-testable, no
I/O:
1. Link preference per device: `usb > wifi > mbserial > radio > mbrelay`.
   If the preferred link is `connectable` and nothing for that device is
   `connected`, emit a connect job.
2. Never a `wifi`/`mbserial` job for a link whose device is not `owned`.
3. Never reopen a `closed_by_user` link.
4. `failed` links only get a retry job at/after `next_retry_at`
   (exponential backoff, capped at 60 s).
5. A relay child switch (`session-open {relayLinkId, name}`, whether
   from ticket 001's connect flow or a user command forwarded by the
   server in ticket 005) is **one** job: close the old child, then open
   the new one — never two separately-issued jobs.
6. At most one notice per state change, never one per attempt/poll.

The executor turns each `Job` into a call to ticket 001's
`connectAndIdentify`, runs on every store change-feed event and a slow
(5 s) tick, and also exposes the narrow entry point the server (ticket
005) forwards an explicit user `session-open`/`session-close` command
to — the same ownership/precedence rules apply to a user-requested job
as to an automatic one (e.g., a user cannot bypass another student's
open session on a link that isn't theirs to close).

## Acceptance Criteria

- [ ] `plan()` is a pure function: same `(rows, now)` input always
      produces the same `Job[]` output, with no store or network access.
- [ ] Table-driven tests cover every rule above as a distinct case:
      owned WiFi link with nothing connected → connect job; un-owned
      WiFi link → no job; USB and WiFi both connectable for one device →
      USB-only job; `closed_by_user` → no job ever; `failed` before
      `next_retry_at` → no job, at/after → job; relay child switch → one
      job with close+open, not two.
- [ ] The executor calls `connectAndIdentify` at most once per job and
      never re-issues a job already in flight for the same link.
- [ ] A user-forwarded `session-open`/`session-close` goes through the
      same `plan()`-equivalent precedence checks as an automatic job
      (e.g., does not reopen a link another session already owns).
- [ ] `grep -rn "autoConnectWifiRobot\|autoSwitchRadioToWifi\|syncWifiEndpoints\|retryWifiAutoConnects" packages/host/src` returns nothing once ticket 003 deletes the old registry (this ticket only needs the new code to not reintroduce the pattern).

## Implementation Plan

**Approach**: `plan()` is pure and lives in its own file so it is
trivially unit-testable in isolation from the executor's timers/change-
feed wiring; the executor is a thin wrapper subscribed to
`store.onChange` plus a `setInterval` (unref'd, matching sprint 014's
watcher convention).

**Files to create**:
- `packages/host/src/connect/reconciler.ts` (`plan()` + executor)
- `packages/host/src/connect/reconciler.test.ts`

**Files to modify**: none yet (wiring into `runtime.ts`/`server.ts`
happens in ticket 005; deletion of the old policy sites happens in
ticket 003).

**Testing plan**:
- Unit: table-driven `plan()` tests, one row-state combination per
  table entry, per the acceptance criteria.
- Integration: executor against a real in-memory `Store` and the
  connector from ticket 001 (using its fake `ByteStream`), asserting
  jobs actually run.
- Run: `npx vitest run packages/host/src/connect`.

**Documentation updates**: none beyond the module doc comment.
