---
id: '003'
title: Store typed operations, change feed, and JSON importers
status: done
use-cases:
- SUC-005
depends-on:
- '002'
github-issue: ''
issue: rearch-01-sqlite-store-schema-migrations-change-feed.md
completes_issue: true
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Store typed operations, change feed, and JSON importers

## Description

Build `packages/host/src/store/index.ts`: the typed operations every
later watcher/ticket calls instead of writing SQL — `upsertDevice`,
`setOwned`, `upsertLink`, `setLinkState`, `ageLinks(transport, ttl)`,
`upsertService`, `recordSighting`,
`openSession`/`updateSession`/`closeSession`,
`acquireBoardOwner`/`releaseBoardOwner`,
`acquireRelayLease`/`releaseRelayLease`, `setFirmware`,
`getSetting`/`setSetting`, `heartbeat(task)`, `snapshotRows()`. Every
write appends a `changes` row in the same transaction and emits
`{seq, tbl, key}` on an in-process `EventEmitter`, coalesced per
macrotask. Add the one-time, idempotent JSON importers
(`known-robots.json` → `devices`, `wifi-credentials.json` → `settings`)
and the `upsertDevice` name/serial consistency assertion
(`deviceIdToName(id) === name`).

This ticket delivers SUC-005 (previously-owned robots appear from the
one-time import) directly, and is the dependency every other ticket in
this sprint needs before it can write or read a row.

## Acceptance Criteria

- [x] Every typed operation listed above exists, is the only way any
      other module writes to the store, and has a test.
- [x] The change feed emits exactly one coalesced event per transaction
      burst (a test that performs several writes in one macrotask and
      asserts one event).
- [x] Both importers run against fixture JSON files, are idempotent
      (running twice produces no duplicate rows), and leave the source
      files in place.
- [x] A fresh host start with an existing `known-robots.json` yields
      `SELECT count(*) FROM devices WHERE owned = 1` equal to the file's
      entry count (SUC-005 acceptance).
- [x] `upsertDevice` refuses a `deviceIdToName(id) !== name` mismatch
      with a typed error, tested against the fixture disagreement noted
      in the protocol review.
- [x] `grep -rn "prepare(\|exec(" packages/host/src --include=*.ts` outside
      `packages/host/src/store/` returns nothing.

## Testing

- **Existing tests to run**: `packages/host/src/store/db.test.ts` (from
  ticket 002) must still pass.
- **New tests to write**: one test per typed operation; change-feed
  coalescing test; importer tests against fixture `known-robots.json`/
  `wifi-credentials.json`; the name/serial mismatch rejection test; the
  no-raw-SQL-outside-store grep as a CI-runnable test.
- **Verification command**: `npm test -- packages/host/src/store`

## Implementation Plan

**Approach**: Build the typed operations as thin, individually-testable
wrappers over prepared statements owned by `db.ts`; wire the change feed
as a single `EventEmitter` owned by `index.ts` that every write function
calls into within its transaction; write the importers last, since they
exercise the typed operations rather than raw SQL.

**Files to create/modify**:
- `packages/host/src/store/index.ts` (new): typed operations, change
  feed emitter.
- `packages/host/src/store/importers/knownRobots.ts`,
  `packages/host/src/store/importers/wifiCredentials.ts` (new).
- `packages/host/src/store/index.test.ts`,
  `packages/host/src/store/importers/*.test.ts` (new).
- Fixture JSON files under `packages/host/src/store/__fixtures__/` (new).

**Documentation updates**: a short `packages/host/src/store/README.md`
(or module-top comment) stating the "no SQL outside `store/`" rule for
future contributors, since it's enforced by a grep test rather than the
type system.
