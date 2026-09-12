---
id: '002'
title: 'SQLite store: schema, migrations, and db.ts'
status: done
use-cases: []
depends-on:
- '001'
github-issue: ''
issue: rearch-01-sqlite-store-schema-migrations-change-feed.md
completes_issue: false
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# SQLite store: schema, migrations, and db.ts

## Description

Build `packages/host/src/store/db.ts`: open/create `console.sqlite`
under the existing state directory (reusing
`resolveKnownRobotsFilePath`'s directory logic), WAL mode, a
`busy_timeout`, and `PRAGMA user_version`-driven migrations that create
the schema exactly as `docs/design/architecture.md` §4 — `devices`,
`links`, `services`, `sightings`, `sessions`, `board_owner`,
`relay_leases`, `firmware`, `settings`, `tasks`, `changes`. This ticket
is schema/migrations only; typed operations, the change feed, and the
importers are ticket 003. No use case is directly observable yet — this
ticket alone doesn't make anything visible in the debug dump (that
starts with ticket 003's importers and completes with the watchers).

Depends on ticket 001 for the `engines.node >= 22.13` floor that
`node:sqlite` requires.

## Acceptance Criteria

- [x] `db.ts` opens/creates `console.sqlite` in the existing state
      directory, in WAL mode, with `busy_timeout` set.
- [x] Schema matches `architecture.md` §4 exactly: all 11 tables, their
      columns, primary keys, and the two indexes (`devices_name`,
      `links_device`, `sightings_device_at`).
- [x] Migrations are driven by `PRAGMA user_version`; a test creates a
      fresh DB (`user_version 0`) and asserts every table exists after
      migration.
- [x] A second migration run against an already-migrated DB is a no-op
      (idempotent).
- [x] `@types/node` coverage for `node:sqlite` is present (root already
      pins `^26`).

## Testing

- **Existing tests to run**: none yet exist for `store/` — this is new
  code.
- **New tests to write**: schema-creation test (every table present with
  correct columns); migration-from-`user_version-0` test; idempotent
  re-migration test.
- **Verification command**: `npm test -- packages/host/src/store`

## Implementation Plan

**Approach**: Write the schema as a single versioned migration (version
1) applied via `PRAGMA user_version` check-and-apply on open, matching
architecture.md §4 verbatim rather than approximating it, since ticket
003's typed operations and every downstream watcher assume these exact
column names and types.

**Files to create/modify**:
- `packages/host/src/store/db.ts` (new): open/migrate.
- `packages/host/src/store/migrations/0001-initial.ts` (or inline SQL
  constant): the 11-table schema.
- `packages/host/src/store/db.test.ts` (new): schema/migration tests.
- `packages/host/package.json`: `engines.node` (if ticket 001 only did
  root; confirm host workspace inherits or sets its own).

**Documentation updates**: none beyond what ticket 003 adds when the
store's public surface exists.
