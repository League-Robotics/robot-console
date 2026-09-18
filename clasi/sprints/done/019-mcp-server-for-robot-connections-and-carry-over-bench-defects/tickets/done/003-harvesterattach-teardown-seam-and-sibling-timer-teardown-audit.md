---
id: '003'
title: HarvesterAttach teardown seam and sibling timer/teardown audit
status: done
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

- [x] `HarvesterAttach` (the interface in `connect/connector.ts` and the
      implementation in `connect/harvester.ts`) gains a `stop()` (or
      equivalent teardown) that clears every attached session's
      `pollStatus` interval and makes `fail()` inert afterward — modeled
      directly on `watchers/relaySweeper.ts`'s own `stop()` (016-008),
      not a new shape.
- [x] `runtime.ts`'s `stop()` calls it, in the same block as the other
      four `stop()` calls it already makes (`runtime.ts:354-364`),
      positioned before `store.close()`.
- [x] A regression test attaches a harvester to a real (or realistic
      fake) store, opens a session, calls `runtime.stop()` (or the
      harvester's own `stop()` directly if `runtime.test.ts`'s fakes
      make that cleaner), advances fake timers, and asserts no store
      write/read occurs afterward. The test is written so that removing
      the new `stop()` wiring makes it fail (per the issue's own
      requirement) — verify this by temporarily reverting the wiring
      locally and confirming the test catches it, then restore.
- [x] Sibling audit is written down explicitly in this ticket's closing
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

## Closing Notes

**What changed**:

- `packages/host/src/connect/connector.ts` — `HarvesterAttach` gained
  `stop(): void`, documented on the interface itself (modeled on
  `watchers/relaySweeper.ts`'s own `stop()`, 016-008, but synchronous —
  see below for why). `NO_OP_HARVESTER` implements it as a no-op.
- `packages/host/src/connect/harvester.ts` — `createHarvester` now
  tracks every still-live attached session in an `attachedSessions` Set
  (removed by a session's own `fail()` once it dies naturally, so the
  set only ever holds sessions `stop()` still needs to reach). `stop()`
  clears every remaining session's `pollTimer` and flips its `failed`
  guard to `true` directly (never routing through `fail()` itself, which
  would perform the very store write this is trying to prevent). A
  session `attach()`ed after `stop()` has already run starts pre-failed
  and never starts a poll timer at all (defensive — see the interface
  doc comment for why this race is considered vanishingly unlikely
  today, not eliminated by construction).
- `packages/host/src/runtime.ts` — `stop()` now calls `harvester.stop()`
  immediately after `await relaySweeperHandle.stop()` and before
  `usbHandle.stop()`/`mdnsHandle.stop()`/`firmwareHandle.stop()`/
  `store.close()`. Doc comments updated (both the module-level
  composition-order comment and `Runtime.stop`'s own).
- Tests: `packages/host/src/connect/harvester.test.ts` gained a
  `createHarvester -- stop()` describe block (5 tests — see "Regression
  test" below). `packages/host/src/runtime.test.ts`'s `fakeDeps()` now
  gives the fake harvester a `stop` mock wired into the same `calls`
  ledger every other collaborator's stop uses, and the two `stop()`
  ordering assertions (plus the `disableSweep: true` one) were updated
  to include `"harvester.stop"` at its new position.

**Sync, not async — deviation from the plan's own suggestion**: the
Implementation Plan asked me to "decide by symmetry with
`relaySweeper.ts`'s own signature, which is async." I chose
`stop(): void` (synchronous) instead: `relaySweeper.ts`'s own `stop()`
awaits real in-flight work (`Promise.allSettled` over every per-relay
loop's own `finally` cleanup, which itself awaits `stream.close()`).
The harvester's `pollStatus` is a bare `setInterval` callback with no
awaited work inside it — `clearInterval` and flipping an in-memory
`failed` boolean are both synchronous — so there is nothing to await.
`runtime.ts` calls it as a plain statement, not `await`ed, matching this.

**Latent vs. live — confirmed, not just taken on faith**: I re-traced
`cli.ts`'s SIGINT/SIGTERM handler myself. It calls `await
runtime.stop()` then, in the very next statement with no other await
between them, `process.exit(0)`. Node's event loop runs the full
microtask queue after each synchronous phase but does not run pending
macrotask timers (`setInterval`/`setTimeout` callbacks) in between two
synchronous statements in the same tick — `runtime.stop()`'s own
resolution and the following `process.exit(0)` call happen within the
same macrotask turn, so a `pollStatus` interval callback scheduled for
some future tick genuinely never gets a chance to run before the
process exits. This confirms the issue's own claim: **the hazard is
latent (no reproducing production crash today), not live.** It remains
real and worth having fixed, exactly per the issue's own reasoning: the
protection depends entirely on there being no `await` between
`runtime.stop()` and `process.exit()` in `cli.ts`, which is one ordinary
refactor away from changing, and `fail()` writes to the store
(`setLinkState`), not just reads it.

**Regression test — how it fails when the wiring is removed**: I
temporarily reverted `createHarvester`'s returned `stop()` to an empty
function (`stop(): void { }`) with the rest of the fix (interface
change, `attachedSessions` tracking, `runtime.ts`'s call site) left in
place, then ran `npx vitest run packages/host/src/connect/harvester.test.ts`.
Two of the five new tests failed, and the run additionally surfaced an
**uncaught exception reproducing sprint 018's own incident verbatim**:

```
Error: database is not open
 ❯ Store.reconcilerRows packages/host/src/store/index.ts:1589:29
 ❯ fail packages/host/src/connect/harvester.ts:248:31
 ❯ Timeout.pollStatus packages/host/src/connect/harvester.ts:276:13
 ❯ listOnTimeout node:internal/timers:585:17
Serialized Error: { code: 'ERR_INVALID_STATE' }
```

This came from the third new test ("is safe to call even after the
store it was built against has already closed"), which calls
`harvester.stop()` then `store.close()` then waits — with the wiring
reverted, the still-running `pollTimer` fired mid-wait and threw exactly
the original incident's error out of a bare timer callback. I restored
the real `stop()` implementation and re-ran the full scoped suite
(`harvester.test.ts` + `runtime.test.ts`, 38 tests) to confirm a clean
pass with no unhandled errors.

**Full sibling audit**:

| Module | Timer | Verdict |
| --- | --- | --- |
| `connect/reconciler.ts` | `setInterval` (`tickIntervalMs`, slow tick) | **Already wired.** `runtime.ts`'s `stop()` calls `reconciler.stop()` (`runtime.ts:370`, current line numbers post-fix). Confirmed still true by reading the current file, not assumed. |
| `watchers/relaySweeper.ts` | `setInterval` (scan tick) + per-pass loop | **Already wired**, and awaited: `await relaySweeperHandle.stop()` (`runtime.ts:376`). Its own `stop()` already awaits every in-flight pass's cleanup (016-008) — the precedent this ticket's own fix follows. |
| `watchers/usbWatcher.ts` | `setInterval` (poll) + per-attach `setTimeout` | **Already wired.** `usbHandle.stop()` (`runtime.ts:388`), called before `store.close()`. |
| `watchers/mdnsWatcher.ts` | `setInterval` (`requeryIntervalMs`, `browseCycle`) | **Already wired.** `mdnsHandle.stop()` (`runtime.ts:389`). |
| `watchers/firmwareWatcher.ts` | Per-kind `setTimeout` self-rescheduling chain (never a shared `setInterval` — see that module's own doc comment) | **Already wired.** `firmwareHandle.stop()` (`runtime.ts:390`). |
| `connect/harvester.ts` (`HarvesterAttach`) | `setInterval` per attached session (`pollStatus`) | **Fixed by this ticket.** Was the one component with no teardown at all; now has `stop()`, called from `runtime.ts:387`, right after `await relaySweeperHandle.stop()` and before the three watchers and `store.close()` (`runtime.ts:391`). |
| `watchers/mdnsWatcher.ts`'s `triggerWifiOnDemandProbes` (019-002, commit `11b7ad1`) | Unawaited `probeWifiOnDemandDep(name)` promises per device name, tracked in `wifiOnDemandInFlight: Set<string>` | **Checked — already safe, no fix needed.** This is new code from the ticket immediately before this one, called out by name in my task brief as worth checking. Its `.then()` callback (`mdnsWatcher.ts:530-538`) checks `if (stopped || result.status !== "found") return;` *before* touching the store, where `stopped` is the same module-level flag `stop()` sets to `true` at the very top of its own body (`mdnsWatcher.ts:791-802`), ahead of `wifiOnDemandInFlight.clear()`. A probe still in flight when `stop()` runs is not cancelled (no `AbortController` here), but any such probe resolving *after* `stop()` — including after the store it would have written to has since closed — sees `stopped === true` and returns before ever calling `upsertLinkAndDetectChange`/`promoteOwnedLinkIfDiscovered`. This is the same class of hazard the harvester had (an async callback landing after shutdown, capable of writing to the store), guarded correctly from the start rather than needing this ticket's fix. |
| `packages/host/src/devices.ts` (`DeviceWatcher` class) | `setInterval` (poll), with its own `start()`/`stop()` already | **Checked — has its own teardown already, and is dead code in production regardless.** `DeviceWatcher.start()`/`.stop()` exist and are correctly paired, but grepping every import of `devices.ts` across the host package shows only `enumerateDaplinkDevices`/`diffDaplinkDevices`/types are ever imported (by `watchers/usbWatcher.ts`) — the `DeviceWatcher` class itself is never constructed or `.start()`ed anywhere `runtime.ts` composes, including `usbWatcher.ts` (superseded by the newer watcher architecture; `usbWatcher.test.ts`/`devices.test.ts` are the only other references). It also never touches the store at all (no `Store` parameter; it only diffs an in-memory device list and notifies its own listeners) — even if it were composed, it would not be the shape of hazard this ticket is about. No fix needed. |
| `connect/flasher.ts` | `setTimeout` (`defaultDelay`, acquire-retry loop) | **Bounded per-operation timeout — no teardown needed.** Real, `unref()`'d, resolves and clears itself once the acquire-retry loop's own short deadline is reached; never a long-lived loop, never touches the store from inside the timer callback itself (the delay only gates retrying an already-bounded acquire loop). |
| `link/pacing.ts` (`WritePacer`/`realScheduler`) | `setTimeout` (`realScheduler.delay`) | **Bounded per-operation timeout — no teardown needed.** A pure per-write pacing delay inside a promise chain; resolves and the chain moves on. No store access, no persistent timer. |
| `link/LineLink.ts` | Two `setTimeout`s: `connect()`'s own connect-timeout, `identify()`'s own banner-wait timeout | **Bounded per-operation timeouts — no teardown needed.** Both are cleared in a `finally`/on-settle path the moment the operation they bound completes (`cleanups` array in `connect()`; `clearTimeout(timer)` inside `resolveBannerWait` in `identify()`). Neither touches the store; both are scoped to one connect/identify attempt, not a long-lived loop. |
| `link/adapters/tcpStream.ts` | `setTimeout` (`resolveIpv4`'s own DNS-lookup bound) | **Bounded per-operation timeout — no teardown needed.** Cleared via its own `cleanup()` the moment the lookup settles or the bounding `signal` aborts; no store access. |
| `lib/withTimeout.ts` | `setTimeout` (races one promise against a deadline) | **Bounded per-operation timeout — no teardown needed.** `unref()`'d, cleared the moment the raced promise settles either way; a generic per-call helper with no store access and no state of its own beyond the one timer. |

**Conclusion**: `connect/harvester.ts` was the only component with a
long-lived, store-touching timer and no teardown seam. Every other
`setInterval`/`setTimeout` site this ticket's own grep and my own
follow-up audit found is either (a) already wired into `runtime.ts`'s
`stop()` block ahead of `store.close()`, (b) a bounded per-operation
timeout that clears itself on settle and never touches the store from
inside the timer callback, or (c) new code (019-002's on-demand WiFi
probes) that already guards its own late-arriving async callback
against a closed store via an explicit `stopped` check. No sibling fix
was needed beyond the harvester itself.

**Scoped test results**: `npx vitest run
packages/host/src/connect/harvester.test.ts
packages/host/src/runtime.test.ts --no-coverage` — 38/38 passed, no
unhandled errors. Also ran `packages/host/src/connect/connector.test.ts`
and `packages/host/src/connect/relayBridger.test.ts` (both consume
`HarvesterAttach`/`NO_OP_HARVESTER`) and `packages/host/src/cli.test.ts`
(constructs a fake harvester in one fixture) as a broader regression
check — 86/86 passed. `npm run typecheck` passed cleanly (both packages
build, all four `tsc --noEmit` project references pass).
