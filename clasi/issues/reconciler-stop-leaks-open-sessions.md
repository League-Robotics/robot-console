---
status: pending
---

# `reconciler.stop()` never closes open sessions, so a stopped runtime keeps holding real robots

## The defect

`packages/host/src/connect/reconciler.ts`'s `stop()` (around line 882):

```ts
stop(): void {
  if (stopped) return;
  stopped = true;
  unsubscribe();
  clearInterval(timer);
}
```

It stops the reconciler's own scheduling loop and **nothing else**. It
never iterates `sessions.values()`, never closes any of them. Every
`ConnectedSession` open at the moment `stop()` is called — each one a
live TCP socket to a real robot — stays open indefinitely, orphaned,
until the process exits or the OS reaps it.

**The code contradicts its own documentation.** `packages/host/src/runtime.ts`'s
`Runtime.stop()` doc comment (around line 148) claims stopping "mirrors
the reconciler's own `stop()` contract" for "any already-open session".
There is no such contract. A reader of `runtime.ts` is told sessions are
handled; they are not.

## How it was found — this one bit real people, twice

Found incidentally during sprint 020 ticket 002's before/after
measurements (2026-09-18), which ran repeated `startRuntime`/`stop()`
cycles against real bench robots.

A finished test process (`bench-ab.mjs`, PID 57459) was still holding
`192.168.1.40:54840 -> 192.168.4.53:37481` — `tovez`'s mbserial daemon —
minutes after its script had printed its summary and long after `await
runtime.stop()` had resolved. This **blocked a concurrent Claude session**
(`pxt-nezha-diffdrive-ea`) from opening its own session to `tovez`:
mbdeploy answered "refused the connection: busy". Two of its staging runs
died with `BrokenPipeError`, leaving a robot physically half-positioned
in the north rail on the playfield. It happened a second time the same
afternoon with a different process of ours.

Both times the diagnosis at the time was "a lingering process". That was
wrong, or at least shallow: **the process had leaked a session that
`stop()` claimed to have closed.**

## Why it matters beyond tidiness

- **It silently corrupts our own measurements.** Ticket 002's repeated
  iterations (10 `startRuntime` cycles in ~5 minutes against the same
  robots) very likely left overlapping leaked sessions, so a later
  iteration's connect attempt raced an earlier iteration's orphaned
  socket. That is a **more parsimonious explanation for `tovez`'s
  intermittent "after" failures than any surviving discovery defect** —
  which means some of that measurement is untrustworthy, and ticket 003
  should not treat it as a clean baseline.
- **It breaks the premise of the next sprint.** Sprint 021 builds a
  daemon with `stop` and `status` verbs on the assumption that stopping
  the host releases the hardware. If `stop()` leaves sessions open, then
  "stopped" and "not holding your robots" are different claims — the
  exact distinction [[bench-exclusivity-census-is-unsound]] is about,
  arriving from the other direction. **Sprint 021 ticket 003 should not
  ship a `stop` verb on top of this.**
- It is a lifecycle sibling of [[harvester-has-no-teardown-seam]] (fixed
  in 019-003, where `HarvesterAttach` had no teardown at all). Same
  family: a component whose shutdown path does not actually shut things
  down. Worth checking whether anything else in `connect/` has the same
  gap — 019-003's audit covered timers, not sessions.

## What to do

- `reconciler.stop()` closes every open session before clearing its
  timer, and `runtime.stop()`'s ordering guarantees that happens before
  `store.close()` (compare 019-003's `harvester.stop()` placement).
- Decide and document whether a stop-initiated close should record
  `closed_by_user` or a distinct reason — a session torn down by
  shutdown is not the same event as a human closing one, and 018-010's
  work made the console's text depend on that distinction.
- Regression test shaped like 019-003's: **removing the fix must make it
  fail.** Assert no socket survives `runtime.stop()`.
- While in there, verify the doc comment in `runtime.ts` matches
  reality, since it is currently the misleading part.

## Fixed in sprint 021 ticket 003 (team-lead, 2026-09-18)

Fixed **at the root**, not worked around. `connect/reconciler.ts`'s
`stop()` now closes every session it holds, and `runtime.stop()` awaits
that before `store.close()`.

One design choice worth recording: a stop-initiated close sets the link
state to **`connectable`**, not `closed_by_user`. That matters — a
`closed_by_user` row is durable and would make a *later* process refuse
to reconnect, so a shutdown would silently poison the next run. Using
`connectable` matches `clearInheritedSessions`'s existing symmetry, so a
later process auto-reconnects normally.

The daemon `stop` verb (same ticket) is therefore honest by construction
rather than by assertion: `cli.ts`'s shutdown handler does not call
`exit(0)` until `runtime.stop()` resolves, and `runStop` sends SIGTERM
then waits for the pid to actually disappear. A gone pid means sessions
were already released; a timeout is reported as **`"timed-out"`**, never
as `"stopped"`. That was the requirement — a `stop` that printed success
while robots stayed held would have been worse than no `stop` at all.

**Resolved.** The two collisions that motivated this issue — a peer
session blocked from `tovez` twice, once leaving a robot half-positioned
in the north rail — should not recur from this cause.
