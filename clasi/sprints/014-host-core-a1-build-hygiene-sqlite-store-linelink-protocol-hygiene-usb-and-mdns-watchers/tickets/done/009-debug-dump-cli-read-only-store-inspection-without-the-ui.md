---
id: 009
title: 'Debug-dump CLI: read-only store inspection without the UI'
status: done
use-cases:
- SUC-006
depends-on:
- '007'
- 008
github-issue: ''
issue: ''
completes_issue: true
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Debug-dump CLI: read-only store inspection without the UI

## Description

Add a small CLI flag to the host's existing entry point (e.g.
`--dump-store`, or a standalone `npm run store:dump` script) that opens
a short-lived, read-only `DatabaseSync` connection to `console.sqlite`
and prints `devices`/`links`/`services`/`sessions`/`tasks` as JSON. This
is the sprint's exit-criterion affordance — "watcher rows visible in a
debug dump" — and is explicitly a throwaway debugging tool: sprint 015's
`rearch-06` replaces it with the real `snapshot` projection and server
endpoint (see `sprint.md` Design Rationale).

This ticket depends on both watchers (007, 008) being in place so there
is something meaningful to dump when it's exercised, though the dump
tool itself only reads — it has no dependency on watcher *code*, only on
there being rows worth checking during the bench pass (ticket 010).

## Acceptance Criteria

- [x] Running the dump against a `console.sqlite` with rows produces
      valid JSON covering `devices`, `links`, `services`, `sessions`,
      `tasks`.
- [x] The dump works whether or not the host process is currently
      running (a second read-only WAL connection does not block or
      corrupt the primary connection).
- [x] The tool ships no write path — a test or code-review check
      confirms it opens the connection read-only.
- [x] Usage is documented (README or `--help` text).

## Testing

- **Existing tests to run**: `packages/host/src/store` suite (must not
  regress from adding a second connection path).
- **New tests to write**: a test that seeds the DB via the store's typed
  operations, runs the dump, and asserts the JSON output contains the
  seeded rows; a concurrent-read test (dump while a write-holding
  connection is open, asserting no error).
- **Verification command**: `npm test -- packages/host/src/debug` (or
  wherever the dump tool's own tests live)

## Implementation Plan

**Approach**: Keep this deliberately small — a read-only query layer
directly over `store/db.ts`'s connection-opening logic (reused, not
duplicated), formatting rows as JSON. No new store typed operations are
needed; `snapshotRows()` from ticket 003 may already cover most of this,
in which case this ticket is mostly a CLI wrapper plus the read-only
connection variant.

**Files to create/modify**:
- `packages/host/src/debug/dumpStore.ts` (new): read-only connection +
  JSON formatting.
- `packages/host/bin/` or the existing CLI entry point: wire the
  `--dump-store` flag (or add a `store:dump` npm script).
- `packages/host/src/debug/dumpStore.test.ts` (new).

**Documentation updates**: README section documenting the flag/script,
explicitly noting it is a sprint-014-only debugging affordance
superseded by the real snapshot endpoint in sprint 015.

## Implementation Notes

- `store/db.ts` gained `openReadOnlyStoreDb` (never creates the file;
  returns `undefined` for a missing one; sets `busy_timeout` only, no
  `journal_mode` assertion). `debug/dumpStore.ts` wraps its result in a
  `Store` and calls only `snapshotRows()` — no raw SQL outside
  `store/`, verified by the existing `noRawSqlOutsideStore.test.ts`
  guard.
- Read-only enforcement is proven both ways: `store/db.test.ts` asserts
  a raw `INSERT` against the read-only connection throws, and
  `debug/dumpStore.test.ts` asserts a `Store` built on that same
  connection throws from `upsertDevice` (the real call path any writer
  would use).
- Concurrent-read safety is proven in `store/db.test.ts`: a second
  connection opens and reads successfully while the primary connection
  holds an uncommitted `BEGIN IMMEDIATE` transaction.
- Team-lead addition, in scope for this ticket (ticket 010's bench pass
  needs it): `cli.ts` also wires `--watch-store`, running both watchers
  headless against the real store/enumerator/SWD-namer/mDNS backend
  (`discovery/mdnsDiscovery.ts`'s `createBonjourBackend`, now exported
  for reuse), logging each coalesced `store.onChange` batch as one JSON
  line, and stopping cleanly on `SIGINT`/`SIGTERM`. `cli.ts` gained an
  injectable `CliDeps` seam (matching `UsbWatcherDeps`/`MdnsWatcherDeps`'s
  own convention) so `cli.test.ts` can unit-test both flags' wiring with
  fakes only — no real store, watchers, ports, or browser in tests.
- Not run against real hardware this pass: the attached USB serial
  ports (`/dev/cu.usbmodem*`) were already held by another `node`
  process (a stakeholder's `npm run dev`, per `lsof`), so `--watch-store`
  was verified only via `cli.test.ts`'s fakes, not a live bench run.
  Ticket 010's bench pass should exercise it live once the ports are
  free.
