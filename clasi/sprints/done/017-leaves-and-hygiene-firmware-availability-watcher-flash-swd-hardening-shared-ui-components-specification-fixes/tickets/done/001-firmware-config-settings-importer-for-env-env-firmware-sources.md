---
id: '001'
title: 'Firmware config: settings importer for env/.env firmware sources'
status: done
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

- [x] `packages/host/src/store/importers/firmwareConfig.ts` exists,
      following the shape of the existing `knownRobots.ts`/
      `wifiCredentials.ts` importers.
- [x] On store bootstrap, the importer reads `process.env` first, then
      the `.env` file (state dir, falling back to repo root when
      running from a checkout), and writes `settings` keys
      `firmware.relay.source` / `firmware.robot.source`.
- [x] The import is idempotent; a present env var always overwrites a
      stale `settings` row on every bootstrap.
- [x] `getFirmwareConfig` reads `settings` via the store; no code path
      outside the importer reads the `.env` file for firmware sources.
- [x] `defaultDotenvPath()`'s module-relative resolution is removed.
- [x] A packaged install with only env vars set shows both flash
      sources configured; a checkout with only `.env` set also does.
- [x] Changing `.env` and restarting the host updates `settings`; a
      stale `settings` row never overrides a present env var.
- [x] README's configuration section documents the precedence.

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

## Implementation notes

- Added `packages/host/src/store/importers/firmwareConfig.ts`:
  `importFirmwareConfig(store, {env, stateDir}, deps)` resolves each of
  `ROBOT_CONSOLE_RELAY_FIRMWARE`/`ROBOT_CONSOLE_ROBOT_FIRMWARE` from
  `env` first, then a `.env` file (state dir if it has one at all, else
  a checkout's repo root), and writes non-empty raw values to
  `settings` keys `firmware.relay.source`/`firmware.robot.source`
  (`config.ts`'s new `SETTINGS_KEY_BY_FIRMWARE`). It is **not**
  one-time-guarded like `knownRobots.ts`/`wifiCredentials.ts` -- it
  re-resolves and overwrites on every bootstrap by design, so a present
  env var always beats a stale row and an edited `.env` takes effect on
  the next restart.
- Repo-root detection (`findRepoRootEnvPath`, exported for direct
  testing) walks up from the importer's own module directory looking
  for an ancestor `package.json` whose `"name"` is `"robot-console"` --
  not a fixed `../../../.env` guess (the bug this ticket fixes) and not
  merely "a `package.json` exists here" (which would false-positive
  under `node_modules`). Returns `undefined` (no repo-root fallback
  attempted) when no such ancestor exists, e.g. a packaged/registry
  install.
- `config.ts`: `defaultDotenvPath()` is removed; `parseEnvFile`/
  `loadEnvFile` keep their parsing logic but `dotenvPath` is now a
  required parameter (no more implicit module-relative default).
  `getFirmwareConfig(store: Store)` reads `settings` via
  `Store.getSetting` instead of `env`/a file; it no longer takes `env`/
  `dotenvPath` parameters at all.
- `store/bootstrap.ts`'s `openStoreWithImports` now also calls
  `importFirmwareConfig` alongside the two existing importers.
- Callers updated to the new store-backed `getFirmwareConfig` signature:
  `cli.ts` (moved the call to after `startRuntimeFn` so `runtime.store`
  exists) and `server.ts` (both the constructor call and the
  `FirmwareAvailabilityCache`'s `loadConfig` closure now close over
  `store`, which was already in scope).
- `store/wifiCredentials.ts` had its own, unrelated `.env` fallback (for
  `WIFI_SSID`/`WIFI_PASSWORD`) via `parseEnvFile()` called with no
  argument, relying on the same now-removed module-relative default.
  Since this ticket's scope is firmware config only, that module keeps
  its own private `defaultDotenvPath()` (relocated verbatim, same
  module-relative shape, same pre-existing limitation under a
  packaged/registry install) rather than either breaking the build or
  silently changing WiFi-credential behavior.
- `store/bootstrap.test.ts`'s existing tests don't pass an explicit
  `env`, so without a state-dir `.env` present they would have caused
  the new importer to fall back to this **real repo's own real
  `.env`** (confirmed present on disk during implementation). Added an
  empty `.env` to each test's temp state dir to keep that test file
  fully isolated, per this ticket's "no test reads `.env` from anywhere
  but the importer's own test" testing-plan bullet.
- New `packages/host/src/store/importers/firmwareConfig.test.ts` covers:
  env-only resolution, state-dir-`.env`-only resolution, repo-root
  fallback (via an injected fake `findRepoRootEnvPath`, never the real
  filesystem walk), state-dir `.env` taking precedence over repo-root
  even when empty, env overwriting a stale `settings` row, empty-string
  env falling through to the file, neither source present yielding
  `undefined` via `getFirmwareConfig` without throwing, and
  `findRepoRootEnvPath` itself against constructed fixture directory
  trees (found / not-found / name-mismatch cases).
- `packages/host/src/config.test.ts` rewritten for the new signatures:
  `getFirmwareConfig` cases now seed a real in-memory `Store` via
  `setSetting` instead of passing `env`/`dotenvPath`; `parseEnvFile`/
  `loadEnvFile` cases are otherwise unchanged (still exercised with
  explicit paths).
- Test run (foreground): `npx vitest run packages/host/src/store
  packages/host/src/config.test.ts packages/host/src/server.test.ts
  packages/host/src/cli.test.ts packages/host/src/releases.test.ts` --
  12 files, 178 tests, all passing. `npm run typecheck` clean.
