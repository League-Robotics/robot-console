---
id: '003'
title: HarvesterAttach teardown seam and sibling timer/teardown audit
status: open
use-cases:
- SUC-003
depends-on: []
github-issue: ''
issue: harvester-has-no-teardown-seam.md
completes_issue: true
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# HarvesterAttach teardown seam and sibling timer/teardown audit

## Description

`connect/harvester.ts`'s `HarvesterAttach` (the real implementation
behind `connect/connector.ts`'s seam) starts a `pollStatus` `setInterval`
per attached session and exposes no `stop()`/teardown at all.
`runtime.ts`'s `stop()` never tells it to stop before calling
`store.close()`. This was found (not carried from a retired ticket) at
sprint 018's close gate: a **test**-teardown gap in `harvester.test.ts`
let a real timer outlive `store.close()` and throw `Error: database is
not open` from `Store.reconcilerRows` — that specific test gap was
already fixed under 018-011 to unblock the close. This ticket is about
the **production** gap the investigation surfaced: no reproducing
production crash exists today (deliberate scope call at the 018 close
gate — `cli.ts`'s SIGINT/SIGTERM handler calls `process.exit(0)`
synchronously right after `runtime.stop()` resolves, with no `await` in
between, so a pending interval callback never gets a turn under Node's
microtask-before-macrotask ordering). The hazard is latent, not live,
but real: `fail()` writes to the store (`setLinkState`), not just reads,
so a poll tick landing during shutdown could try to write to a closing
database the moment anything is ever awaited between `runtime.stop()`
and `process.exit()` — an ordinary refactor away.

**Already confirmed** (this sprint's own architecture read of
`runtime.ts:342-367`): `connect/reconciler.ts`, `watchers/
relaySweeper.ts`, `watchers/usbWatcher.ts`, `watchers/mdnsWatcher.ts`,
and `watchers/firmwareWatcher.ts` are *all already* wired into
`runtime.ts`'s `stop()` before `store.close()` (`reconciler.stop()`,
`await relaySweeperHandle.stop()`, `usbHandle.stop()`,
`mdnsHandle.stop()`, `firmwareHandle.stop()`). `connect/harvester.ts` is
the one component with no returned handle and no `stop()` call at all —
the audit below should confirm this remains true and check the
remaining files that touch timers.

## Acceptance Criteria

- [ ] `HarvesterAttach` (the interface in `connect/connector.ts` and the
      implementation in `connect/harvester.ts`) gains a `stop()` (or
      equivalent teardown) that clears every attached session's
      `pollStatus` interval and makes `fail()` inert afterward — modeled
      directly on `watchers/relaySweeper.ts`'s own `stop()` (016-008),
      not a new shape.
- [ ] `runtime.ts`'s `stop()` calls it, in the same block as the other
      four `stop()` calls it already makes (`runtime.ts:354-364`),
      positioned before `store.close()`.
- [ ] A regression test attaches a harvester to a real (or realistic
      fake) store, opens a session, calls `runtime.stop()` (or the
      harvester's own `stop()` directly if `runtime.test.ts`'s fakes
      make that cleaner), advances fake timers, and asserts no store
      write/read occurs afterward. The test is written so that removing
      the new `stop()` wiring makes it fail (per the issue's own
      requirement) — verify this by temporarily reverting the wiring
      locally and confirming the test catches it, then restore.
- [ ] Sibling audit is written down explicitly in this ticket's closing
      notes: confirm the five components named above remain wired (cite
      the current `runtime.ts` line numbers), and check
      `packages/host/src/devices.ts`, `connect/flasher.ts`,
      `link/pacing.ts`, `link/LineLink.ts`,
      `link/adapters/tcpStream.ts`, and `lib/withTimeout.ts` (all use
      `setInterval`/`setTimeout` per this ticket's own grep) — for each,
      state whether its timer is a bounded per-operation timeout (no
      teardown needed) or a long-lived loop touching the store (needs
      one). Fix any found in the latter category using the same
      pattern; if none are found, say so with the reasoning, not just
      "audited."

## Implementation Plan

**Approach**: add `stop()` to the `HarvesterAttach` interface
(`connect/connector.ts`) and its real implementation
(`connect/harvester.ts`), following `relaySweeper.ts`'s own doc comment
("this `store.close()` below can never again race a pass still
mid-`finally`") as the model for what correctness looks like. Wire the
call into `runtime.ts`.

**Files to modify**:
- `packages/host/src/connect/connector.ts` — extend `HarvesterAttach`
  with `stop(): void` (or `Promise<void>` if any in-flight write needs
  awaiting — decide by symmetry with `relaySweeper.ts`'s own signature,
  which is async).
- `packages/host/src/connect/harvester.ts` — implement `stop()`: clear
  every attached session's `pollTimer`, set each `failed = true`-
  equivalent guard so a stray callback already in flight is a no-op.
- `packages/host/src/runtime.ts` — call the new `stop()` in the existing
  teardown block, before `store.close()`.
- Any of the sibling files named in the audit above found to need the
  same fix.

**Testing plan**:
- Scoped `vitest` run: `connect/harvester.test.ts`, `runtime.test.ts` —
  not the full suite.
- New regression test per the acceptance criterion above.
- If the audit finds and fixes a sibling gap, that file's own test gets
  an equivalent regression test.

## Documentation Updates

- None beyond this ticket's own record — no schema or component-
  boundary change; this closes an existing seam gap rather than adding
  a new one. If the audit finds and fixes an unexpected sibling gap, note
  it in the ticket's closing summary so sprint close can cite it.
