---
id: '003'
title: Classify mbtools not_found as stale, not a retrying failure
status: done
use-cases:
- SUC-003
depends-on:
- '002'
github-issue: ''
issue: gone-mbregistry-board-link-is-reattributed-to-the-next-board-on-its-port.md
completes_issue: true
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Classify mbtools not_found as stale, not a retrying failure

## Description

mbtools 0.20260925.3 (commit 95c70bd) now fails `lock`/`stream`/`flash`
against a disconnected UID fast, with `MbregistryError` code
`"not_found"` (`packages/host/src/mbregistry/client.ts`'s own
`MbregistryErrorCode` union already includes `"not_found"`, line ~97),
and closes (EOF) an already-open stream whose UID leaves its port.
`packages/host/src/link/adapters/mbregistryStream.ts`'s
`translateError` (~line 312) already special-cases only `"locked"`:

```ts
private translateError(err: unknown): Error {
  if (err instanceof MbregistryError && err.code === "locked") {
    const holder = ...;
    return new Error(formatLockedMessage(...));
  }
  return err instanceof Error ? err : new Error(String(err));
}
```

— every other code, including `"not_found"`, already passes through
unchanged with `.code` intact (it is still an `Error` via `MbregistryError
extends Error`). The gap is entirely on the *receiving* side:
`connect/connector.ts`'s `attempt()` funnels every stream-open/identify
failure through `recordFailure` (writes `state: "failed"` +
exponential backoff, capped at 60 s) — see the call sites around lines
1117, 1132, 1198, 1236, 1247, 1263, 1286. That is correct for a
transient failure, but `not_found` is mbtools affirmatively saying "this
UID is not attached right now" — a durable fact, not a "try again
soon" one. Live evidence
(`gone-mbregistry-board-link-is-reattributed-...md`): hodr's registry
retried a flash against a gone UID three times (20:04, 20:05, 20:08),
each ending in mbtools' own 60 s no-progress watchdog SIGKILL
(`exit -9`), before giving up.

### What to change

In `connect/connector.ts`'s `attempt()`, before falling through to the
generic `recordFailure` call on a `stream()`/`lock()` rejection (the
call site(s) that can receive a `MbregistryError` — i.e. the
`mbregistry`-transport path through `buildStreamPlan`'s
`createMbregistryStream`), add one branch: if the caught error is a
`MbregistryError` with `code === "not_found"`, call
`store.setLinkState({id: link.id, state: "stale", at: now(), reason:
err.message})` instead of `recordFailure`. This mirrors
`watchers/mbregistryWatcher.ts`'s own `markGone` — same target state,
same "no retry storm" reasoning — so there is one consistent meaning
for "this UID is gone" across the watcher's poll and the connector's
own identify attempt.

Do **not** add a port-keyed re-lock fallback anywhere: `buildStreamPlan`'s
`mbregistry` case, `mbregistryWatcher`'s `mbregistryLinkId(uid)`, and
`resolveFlashLinkTarget`'s `mbregistry` branch (ticket 004) all already
address a link by UID, never by port — "re-lock by UID, never by port"
is already the structural default this codebase has; this ticket is
purely a failure-classification fix on top of it, not a re-addressing
change.

A stream that closes (EOF) mid-session because its UID left the port
is already routed through `reconciler.ts`'s `reapDeadSession`, which
calls `recordFailure` with `"transport closed"` — leave that path as
is for this ticket (a plain EOF is not necessarily a `not_found`; the
next reconnect attempt against the same UID-keyed link will itself hit
`not_found` and get the `stale` classification above on that attempt,
not this one). Do not try to distinguish "closed because UID left" from
any other transport close at the EOF site itself — the `not_found`
classification on the *next connect attempt* is where this sprint draws
the line, per sprint.md's Design Rationale.

## Acceptance Criteria

- [x] A `MbregistryError` with `code === "not_found"` from
      `client.stream()`/`client.lock()` during an mbregistry identify
      attempt results in `store.setLinkState` writing `state: "stale"`,
      not `state: "failed"`.
- [x] No `next_retry_at`/`fail_count` write accompanies this path — it
      is not a `recordFailure` call, so `plan()`'s own `isAutoConnectEligible`
      never sees a backoff-eligible `failed` link for this UID.
- [x] Every other `MbregistryError` code (e.g. `"locked"`, anything
      unrecognized) continues to flow through the existing
      `recordFailure` path unchanged.
- [x] A card-rendering regression alongside ticket 002's: a `not_found`-
      classified (now `stale`) link does not appear in `cardLinks()` for
      any device.
- [x] Fakes only — a fake `MbregistryClient`/`MbregistryStreamOptions.client`
      that rejects `stream()`/`lock()` with `new MbregistryError(...,
      "not_found")`. No real mbregistry daemon.

## Testing

- **Existing tests to run**: `connector.test.ts` (full file, confirm no
  regression to the `"locked"` message path or any other identify
  failure), `link/adapters/mbregistryStream.test.ts` if present (confirm
  `translateError`'s existing passthrough for non-`"locked"` codes is
  unchanged — this ticket does not modify that file, only asserts
  against its existing behavior).
- **New tests to write**: a `connector.test.ts` case per the acceptance
  criteria — fake client rejecting with `not_found`, assert `stale` not
  `failed`, assert no backoff fields written. A `deviceDisplay.test.ts`
  card-rendering case per the last acceptance criterion.
- **Verification command**: run the workspace's vitest scripts scoped
  to `packages/host/src/connect/connector.test.ts` and
  `packages/ui/src/deviceDisplay.test.ts` — do not run the full suite.
