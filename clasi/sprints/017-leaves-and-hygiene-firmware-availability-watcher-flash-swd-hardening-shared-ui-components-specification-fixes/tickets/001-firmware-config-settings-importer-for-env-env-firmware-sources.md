---
id: '001'
title: 'Firmware config: settings importer for env/.env firmware sources'
status: in-progress
use-cases:
- SUC-001
depends-on: []
github-issue: ''
issue: firmware-config-env-becomes-settings-importer.md
completes_issue: true
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Firmware config: settings importer for env/.env firmware sources

## Description

`packages/host/src/config.ts` resolves the dotconfig-assembled `.env`
relative to its own module location. Under a registry or packaged
install that path never exists, so both flash buttons render "not
configured" even when the environment is correctly set up otherwise.
This ticket adds a bootstrap-time importer that reads
`ROBOT_CONSOLE_RELAY_FIRMWARE` / `ROBOT_CONSOLE_ROBOT_FIRMWARE` from
`process.env` first, then from `.env` in the state dir (or repo root
when running from a checkout), and writes the resolved values into the
`settings` table. `getFirmwareConfig` becomes a `settings` reader
instead of a file reader. This is a foundation ticket: ticket 002's
firmware watcher reads firmware sources from `settings`, not from
`config.ts` directly, so this ticket lands first.

## Acceptance Criteria

- [ ] `packages/host/src/store/importers/firmwareConfig.ts` exists,
      following the shape of the existing `knownRobots.ts`/
      `wifiCredentials.ts` importers.
- [ ] On store bootstrap, the importer reads `process.env` first, then
      the `.env` file (state dir, falling back to repo root when
      running from a checkout), and writes `settings` keys
      `firmware.relay.source` / `firmware.robot.source`.
- [ ] The import is idempotent; a present env var always overwrites a
      stale `settings` row on every bootstrap.
- [ ] `getFirmwareConfig` reads `settings` via the store; no code path
      outside the importer reads the `.env` file for firmware sources.
- [ ] `defaultDotenvPath()`'s module-relative resolution is removed.
- [ ] A packaged install with only env vars set shows both flash
      sources configured; a checkout with only `.env` set also does.
- [ ] Changing `.env` and restarting the host updates `settings`; a
      stale `settings` row never overrides a present env var.
- [ ] README's configuration section documents the precedence.

## Implementation Plan

**Approach**: Add `firmwareConfig.ts` under `store/importers/`, wired
into store bootstrap alongside the existing importers. Keep `config.ts`'s
env-var parsing helpers (per the issue: "`config.ts` parsers stay") but
remove its file-path resolution responsibility — the importer owns
finding and reading `.env`, `config.ts` owns turning a resolved string
into a typed `FirmwareSource`.

**Files to create**:
- `packages/host/src/store/importers/firmwareConfig.ts`
- `packages/host/src/store/importers/firmwareConfig.test.ts`

**Files to modify**:
- `packages/host/src/config.ts` — remove `defaultDotenvPath()`'s
  module-relative resolution; `getFirmwareConfig` reads `settings`.
- `packages/host/src/store/bootstrap.ts` — register the new importer
  alongside `knownRobots`/`wifiCredentials`.
- `README.md` — configuration/precedence section.

**Testing plan** (scoped vitest run, this ticket's modules only):
- Env-only fixture → both firmware kinds resolve from `settings`.
- `.env`-only fixture (state dir and repo-root fallback) → both kinds
  resolve.
- Env var present + stale `settings` row present → env wins.
- Missing both → `settings` has no row; `getFirmwareConfig` returns
  `undefined` for that kind, not a throw.
- No test reads `.env` from anywhere but the importer's own test.

**Documentation updates**: README configuration section; note in
`docs/design/architecture.md` §4 if the `settings` key names need
recording there (they are already implied by the existing `settings`
table entry).
