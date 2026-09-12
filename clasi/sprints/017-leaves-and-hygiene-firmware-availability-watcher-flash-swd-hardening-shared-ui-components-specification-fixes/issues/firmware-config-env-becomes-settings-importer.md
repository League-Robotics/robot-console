---
status: in-progress
sprint: '017'
tickets:
- 017-001
---

# Firmware config: import `.env` firmware sources into `settings` instead of resolving `.env` relative to the module

## Description

`packages/host/src/config.ts` resolves the dotconfig-assembled `.env`
relative to its own module location (`<repo root>/.env`). Under a
registry or packaged install that path is `node_modules/robot-console/.env`,
which never exists, so both flash buttons render "not configured".
rearch-17 (sprint 014) flagged this and said the fix belongs with the
SQLite store: `.env` becomes an importer input and `settings` becomes
the source of truth. Sprint 014 shipped only the `known-robots.json`
and `wifi-credentials.json` importers; sprint 015's planner confirmed
neither rearch-06 nor rearch-08 covers this.

## Proposed resolution

- Add `packages/host/src/store/importers/firmwareConfig.ts`: on store
  bootstrap, read `ROBOT_CONSOLE_RELAY_FIRMWARE` / `ROBOT_CONSOLE_ROBOT_FIRMWARE`
  from `process.env` first, then from the `.env` in the state dir (or the
  repo root when running from a checkout), and write them to `settings`
  keys `firmware.relay.source` / `firmware.robot.source`. Idempotent;
  env always wins over a stale row.
- `getFirmwareConfig` reads `settings` via the store, not the file; the
  re-read-on-demand behaviour becomes "re-run the importer".
- Remove `defaultDotenvPath()`'s module-relative resolution.
- Document the precedence in README's configuration section.

## Acceptance

- A packaged install with only env vars set shows both flash sources
  configured; a checkout with only `.env` set also does.
- Changing `.env` and restarting updates `settings`; a stale `settings`
  row does not override a present env var.
- No `.env` read outside the importer.

## Depends on

rearch-01 (done, sprint 014). Best landed with rearch-13 in sprint 017.

## References

- rearch-17 description, `config.ts:115` note
- `docs/reviews/2026-09-11/03-host-server-flash-releases.md` §4
