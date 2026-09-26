---
id: '001'
title: Commit robot-console-e6's uncommitted mbregistry watcher/client fix
status: done
use-cases:
- SUC-001
depends-on: []
github-issue: ''
issue:
- gone-mbregistry-board-link-is-reattributed-to-the-next-board-on-its-port.md
- mbregistry-own-uid-link-never-identifies.md
completes_issue: false
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Commit robot-console-e6's uncommitted mbregistry watcher/client fix

## Description

The working tree on `main` already carries a finished, tested fix,
authored out-of-process by another session (robot-console-e6, for "vevov
on loki never shows"), touching:

- `packages/host/src/mbregistry/client.ts` — `watch()` now opens its own
  dedicated `JsonLinesConnection`, tracked in a `watchConnections` set
  and closed alongside the control connection, instead of running on
  the shared `controlConnection`. Before this, any `list()`/`find()`/
  `lock()` call issued after `watch()` started hung forever, because
  the watch-mode parser swallowed the response line those calls were
  waiting on.
- `packages/host/src/watchers/mbregistryWatcher.ts` — `client.list()`
  now polls every `pollIntervalMs` (default 1000 ms), not just once at
  start. Each poll reconciles against the store by a fingerprint of
  each entry (`fingerprint()`, everything except per-probe timestamps),
  so an unchanged entry costs no write. A UID that drops out of the
  list (and is not already `stale`) is aged `stale` and its session
  closed (`markGone`, the same helper `handleDetach` already used). A
  `peer_up`/`peer_down` watch event triggers an immediate extra poll.
  `upsertFromListEntry`'s own `identify()` call gained a `promote`
  predicate so a poll only ever promotes a link that is currently idle
  (`discovered`/`stale`) — never clobbers a `connecting`/`connected`/
  `unresponsive`/`failed`/`closed_by_user` link, which stays the
  connector/reconciler's own business.
- `packages/host/src/watchers/mbregistryWatcher.test.ts` — the new
  coverage for the above (already written).

This ticket lands that work on `main` (or the sprint branch, per normal
flow) essentially as-is. **Do not redesign it.** Every later ticket in
this sprint (002-005) is written and tested assuming this fix is
already in place — the two primary issues this sprint addresses both
explicitly note "the picture may change once this lands," and 002/003
build directly on `markGone`'s existing `stale` semantics rather than
inventing a second one.

## Acceptance Criteria

- [x] `packages/host/src/mbregistry/client.ts` and
      `packages/host/src/watchers/mbregistryWatcher.ts`'s uncommitted
      changes are committed with no functional changes from their
      current working-tree state (a mechanical `git add`/`git commit`,
      not a rewrite).
- [x] `packages/host/src/watchers/mbregistryWatcher.test.ts` (as already
      written, uncommitted) is committed alongside them and passes.
- [x] `tsc` is clean across `packages/host` (and any other package the
      type-only `LinkState` import change in `mbregistryWatcher.ts`
      touches).
- [x] The commit message credits robot-console-e6 as the fix's author
      (e.g. a trailer or a sentence naming the out-of-process session),
      per this sprint's Solution section.
- [x] No other file changes ride along in this commit — this ticket is
      scoped to exactly the three files above.

## Testing

- **Existing tests to run**: `npm test --workspace packages/host -- watchers/mbregistryWatcher.test.ts`
  (or the equivalent `vitest run` invocation this repo uses), plus a full
  `packages/host` typecheck (`tsc --noEmit` or the workspace's own
  typecheck script).
- **New tests to write**: none — the test file is already written,
  uncommitted; this ticket does not add coverage, it lands what already
  exists.
- **Verification command**: run the workspace's existing vitest/tsc
  scripts for `packages/host` (see `package.json`); do not invent a new
  command. Do not run the full suite here — `client.test.ts`'s 18
  pre-existing failures against a real daemon, and `daemon/cli.test.ts`
  failing while a console runs on port 4795, are both known and
  pre-existing (sprint.md's own Test Strategy) and are not this
  ticket's concern; scope the run to the watcher test file plus
  typecheck.
