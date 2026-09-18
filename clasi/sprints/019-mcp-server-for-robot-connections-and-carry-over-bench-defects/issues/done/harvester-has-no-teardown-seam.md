---
status: done
sprint: 019
tickets:
- 019-003
- 019-009
---

# `HarvesterAttach` has no teardown seam, so its STATUS-poll timer can outlive the store

## Found (programmer + team-lead, 2026-09-17, sprint 018 close gate)

Sprint 018's `close_sprint` full-suite run reported **2331 tests passed,
126 files passed — and exit code 1**, because vitest caught one unhandled
error:

```
Error: database is not open
 ❯ Store.reconcilerRows packages/host/src/store/index.ts:1589:29
 ❯ fail packages/host/src/connect/harvester.ts:214:31
 ❯ Timeout.pollStatus packages/host/src/connect/harvester.ts:242:13
 ❯ listOnTimeout node:internal/timers:585:17
Serialized Error: { code: 'ERR_INVALID_STATE' }
```

The immediate cause was a **test**-teardown omission in
`harvester.test.ts` (tests that call `harvester.attach()`, never stop the
resulting `pollStatus` `setInterval`, and then `store.close()` while it
keeps ticking on real timers). That part was fixed under 018-011 to
unblock the sprint close, and is **not** what this issue is about.

## The actual gap

While tracing whether the same crash is reachable in production, the
programmer found that **`HarvesterAttach` (`connect/connector.ts`)
exposes no `stop()` or teardown method at all**, and `runtime.ts`'s
`stop()` never tells the harvester to stop polling before it calls
`store.close()`.

Compare `watchers/relaySweeper.ts`, whose own `stop()` was built for
exactly this hazard under ticket **016-008** — its doc comment records
the intent: *"this `store.close()` below can never again race a pass
still mid-`finally`"*. The harvester has the same shape of hazard and
none of that protection.

## Why it was not fixed on the spot

Deliberate scope call by the team-lead at the close gate: **no
reproducing production crash could be constructed.** Today's only real
shutdown path is `cli.ts`'s SIGINT/SIGTERM handler, which calls
`process.exit(0)` synchronously immediately after `runtime.stop()`
resolves, with no `await` in between — so under Node's
microtask-before-macrotask ordering, a pending interval callback never
gets a turn after `store.close()`. The crash is latent, not live.

Adding a teardown seam means changing the `HarvesterAttach` interface in
`connector.ts` and wiring it through `runtime.ts` — a new cross-module
seam. That deserves its own ticket and its own verification, not a
ride-along on a close-recovery pass after the sprint's bench
verification had already been run and signed off.

## What to do

- Give `HarvesterAttach` a `stop()` (or equivalent teardown) that clears
  the `pollStatus` interval and makes `fail()` inert afterwards,
  following the `relaySweeper.stop()` precedent rather than inventing a
  new shape.
- Wire it into `runtime.ts`'s `stop()`, **before** `store.close()`.
- Audit for siblings: any other module that registers a timer or async
  loop touching the store and has no teardown. `relaySweeper` has one;
  the harvester did not. Check the rest rather than fixing only the one
  that happened to surface.
- Regression test: a harvester attached to a store, then a runtime stop,
  must not throw from a timer afterwards — and it should be written so
  that removing the `stop()` call makes it fail.

## Why it matters beyond tidiness

`fail()` is not a no-op path: it writes `setLinkState({state:
"unresponsive"})`. A poll tick that lands during shutdown is therefore
one that can also try to *write* to a store that is closing. The
observed symptom was a read throwing; the write is the same race with
worse consequences if the ordering ever shifts — and it would shift the
moment anything is awaited between `runtime.stop()` and `process.exit()`,
which is an ordinary refactor away.

See also [[bench-relay-port-contention-sweeper-vs-session]] — sprint
018's `clearDeadProcessState` repair exists because process-scoped state
(`relay_leases`, `board_owner`, open `sessions`, `connecting`/`connected`
links) routinely survives a process that did not shut down cleanly. A
harvester that can still write during shutdown is another source of
exactly that kind of leftover row.
