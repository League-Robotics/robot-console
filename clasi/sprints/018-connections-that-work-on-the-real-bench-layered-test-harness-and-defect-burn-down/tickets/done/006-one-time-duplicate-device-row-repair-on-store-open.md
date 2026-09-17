---
id: '006'
title: One-time duplicate device-row repair on store open
status: done
use-cases:
- SUC-003
depends-on:
- '005'
github-issue: ''
issue: bench-stale-radio-links-and-duplicate-rows-persist.md
completes_issue: true
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# One-time duplicate device-row repair on store open

## Description

Second half of the radio-hygiene fix (SUC-003), completing the
stale-radio-links-and-duplicate-rows issue. Evidenced live: duplicate
robot rows survive in the stakeholder's existing database — `gopiv 1461`
(known-robots placeholder, `owned 1`) and `gopiv 2175407711` (real,
`owned 0`); the mbserial and radio links hang off the placeholder, so
the real row is un-owned. Fixes from sprints 016-017 (017-006's
connector merge-on-first-non-USB-identification) only merge at
identify/SWD time going forward; a database created before those fixes
landed is never repaired, and the stakeholder's live database is exactly
such a database.

Fix: on store open, a one-time repair pass finds placeholder rows
(`id === nameToValue(name)`, `kind: "robot"`) and merges each into a
real row of the same name if one exists, carrying `owned` forward and
re-pointing every link that referenced the placeholder's `device_id` to
the real row's id. Idempotent: a store with no placeholders left does
nothing on subsequent opens.

## Acceptance Criteria

- [x] On store open, any placeholder device row (`id ===
      nameToValue(name)`, `kind: "robot"`) with a matching real row of
      the same name is merged into the real row: `owned` is carried
      forward (true if either row had it true), and every link
      previously pointing at the placeholder's `device_id` now points
      at the real row's id.
- [x] The repair is idempotent — running it again on an already-repaired
      store makes no changes and does not error.
- [x] A placeholder row with **no** matching real row (e.g. a robot
      never re-identified since) is left alone — this ticket only merges
      when both rows exist, per the issue's own scope.
- [x] Unit test: seed a store with the exact shape of the stakeholder's
      `gopiv` duplicate (placeholder `1461`/`owned 1`, real
      `2175407711`/`owned 0`, links on the placeholder) and confirm one
      row remains, `owned` true, links re-pointed.
- [x] **Harness command and evidence**: `scripts/bench/run.sh --report
      /tmp/bench-report.md` run against a **copy** of the stakeholder's
      real, already-affected `console.sqlite` (never the live file);
      the report's Layer 2 card-truthfulness check ("one device row per
      name") shows `gopiv` (and any other duplicated name found) as a
      single row after store open, with `owned` and links intact.

      **Evidence gathered (2026-09-13):**

      *Real-shape proof.* Copied the stakeholder's real
      `~/.local/state/robot-console/console.sqlite` (+`-wal`/`-shm`)
      into a scratch state dir (`ROBOT_CONSOLE_STATE_DIR` pointed there
      explicitly and printed/verified before every host start — the
      real file was never opened for writing). Before: 8 device rows,
      exactly one duplicated name — `gopiv` `1461`
      (`owned: 1`, `usb_serial` set) and `gopiv` `2175407711`
      (`owned: 0`, `usb_serial: null`), with `mbserial-gopiv`, both
      `radio-gopiv-via-usb-…` links, and `wifi-gopiv` all pointing at
      `1461`. Started this branch's host
      (`bin/robot-console.js --port 4917 --no-open --no-sweep`) against
      the scratch copy, let it settle, then `SIGTERM`'d it (only
      process this session started/killed). After: **7 device rows,
      `gopiv` collapsed to a single row at `2175407711`, `owned: 1`,
      `usb_serial` carried from the placeholder
      (`9906360200052820…`)**; every formerly-`1461` link
      (`mbserial-gopiv`, both `radio-gopiv-via-usb-…` links,
      `wifi-gopiv`) now has `device_id: 2175407711`; no link references
      `1461` any more. No other device name was duplicated before or
      after.

      *Harness*: `scripts/bench/run.sh --skip-held --allow-shared-bench
      --audit-db <post-repair copy of the seeded db above> --report
      scratchpad/bench-report-006.md`, run in the foreground against
      the stakeholder's `scripts/dev.mjs` (pid 82496) still running
      (`--allow-shared-bench`, so contention failures are labeled
      `contention`, not `defect`). The `--audit-db` truthfulness
      section's `one-row-per-name` check is `pass` for every one of the
      7 names present, `gopiv` included:

      ```
      | one-row-per-name | torture | pass | exactly one devices row for "torture" |
      | one-row-per-name | vevav   | pass | exactly one devices row for "vevav" |
      | one-row-per-name | vevov   | pass | exactly one devices row for "vevov" |
      | one-row-per-name | gopiv   | pass | exactly one devices row for "gopiv" |
      | one-row-per-name | vitut   | pass | exactly one devices row for "vitut" |
      | one-row-per-name | tovez   | pass | exactly one devices row for "tovez" |
      | one-row-per-name | tigez   | pass | exactly one devices row for "tigez" |
      ```

      The `--audit-db` findings section still lists `relay-as-robot`
      (`vevav`), `would-be-hidden-radio-link` (9 rows), and
      `usb-path-mismatch` (1 row) — these are tickets 004/009's own
      scope (SWD naming / radio aging propagation), not this ticket's;
      `gopiv`'s duplicate-row finding from ticket 005's own evidence
      pass is gone, since this ticket's repair is exactly what removes
      it. Robot x path table: `gopiv`/`vevov` mbserial and
      `radio-via-mbrelay:torture` all pass L1/L2/L3; `gopiv` wifi fails
      L2/L3 (labeled `defect`, ticket 007's own scope — WiFi connect
      timing, unrelated to device-row identity); `tigez`/`tovez`/`vitut`
      radio-via-torture are `environment` (out of `torture`'s reach,
      sprint scope's own documented exclusion); one usb path is
      `contention` and one `skipped` (both against `dev.mjs`'s held
      resources, expected under `--allow-shared-bench`).

## Implementation Plan

**Approach**: add a repair step run once during store initialization
(after schema/migration, before watchers start), reading all
`kind: "robot"` rows whose `id` equals `nameToValue(name)` (the
synthetic placeholder id scheme from `store/importers/knownRobots.ts`),
and for each, looking for a same-named row with a different (real,
FICR-derived) id. On a match: update all `links.device_id` and
`sightings.device_id` references from the placeholder id to the real
id, OR the `owned` flags, then delete the placeholder row.

**Files to modify**:
- `packages/host/src/store/store.ts` (or a new
  `store/repair/mergeDuplicateDeviceRows.ts` module, called once from
  store open)
- `packages/host/src/store/importers/knownRobots.ts` only if its
  placeholder-id documentation needs updating to note the repair now
  exists (read its own "id problem" doc comment referenced in sprint
  015 ticket 011's bench evidence)

**Testing plan**: `vitest` unit tests for the merge logic (happy path,
idempotency, no-match-left-alone case) using an in-memory/temp SQLite
db seeded to match the stakeholder's real shape. Scoped run: `npx vitest
run packages/host/src/store`. Bench pass per the harness command above,
against a **copy** of the real affected database — this is the
Migration Concerns item the sprint architecture calls out explicitly:
proving this against a synthetic fixture alone is not sufficient given
the bug's entire cost is in already-affected real databases.

**Documentation updates**: none beyond this ticket's completion notes.
