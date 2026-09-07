---
id: '002'
title: 'config.ts and dotconfig scaffold: firmware source configuration'
status: done
use-cases: []
depends-on:
- '001'
github-issue: ''
issue: flash-firmware-buttons-for-unresponsive-boards.md
completes_issue: true
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# config.ts and dotconfig scaffold: firmware source configuration

## Description

Two independent but tightly coupled changes, done together per
`sprint.md`'s correction note:

1. **Populate and commit** the existing untracked, empty `dotconfig
   init` scaffold at `config/` (it already exists — this ticket does
   not run `dotconfig init` again). Add the two firmware-source
   variables to `config/prod/public.env`, following
   `vendor/radio-robot-lib/config/`'s layout convention. Commit the
   `config/` directory and the already-uncommitted `.gitignore`
   addition (`.env.*` / `!.env.example`) together — both are this same
   scaffold's own changes.
2. **`packages/host/src/config.ts`** (new): parse those two variables
   into typed `FirmwareSource` values, with an absent variable handled
   gracefully (never fatal to host startup).

See `sprint.md`'s Architecture, Step 5 ("What Changed" — `config.ts`
bullet and the `config/` bullet) for the exact variable names, parsing
rule, and `.env`-reading behavior; this ticket implements them.

## Acceptance Criteria

- [x] `config/prod/public.env` contains
      `ROBOT_CONSOLE_RELAY_FIRMWARE=https://github.com/League-Robotics/microbit-radio-relay:latest`
      and
      `ROBOT_CONSOLE_ROBOT_FIRMWARE=https://github.com/League-Robotics/pxt-nezha-diffdrive:latest`.
- [x] `config/dev/public.env`, `config/local/eric/public.env`,
      `config/{dev,prod,local/eric}/secrets.env`, `config/sops.yaml`,
      and `config/dotconfig.yaml` are committed as-is (empty overlays
      stay empty, matching `vendor/radio-robot-lib/config/dev/
      public.env`'s own convention).
- [x] `.gitignore`'s already-present-but-uncommitted `.env.*` /
      `!.env.example` addition is committed in this same ticket.
- [x] `git status` shows `config/` no longer untracked and `.gitignore`
      no longer modified-but-uncommitted after this ticket.
- [x] `getFirmwareConfig(env?, dotenvPath?): Record<FirmwareKind,
      FirmwareSource | undefined>` (`FirmwareSource = { repoUrl:
      string; tag: string }`) parses `<repo-url>:<tag>` correctly,
      including when `repo-url` itself contains `:` (the `https://`
      scheme) — the tag split must not misfire on that colon.
- [x] A value with no trailing `:<tag>` defaults `tag` to `"latest"`.
- [x] An unset/missing variable yields `undefined` for that entry —
      `getFirmwareConfig()` never throws.
- [x] The minimal `.env` file reader: parses `KEY=value` lines, skips
      blank lines and `#`-comments, and never overwrites a key already
      present in `process.env` (explicit env wins over the assembled
      file). A missing `.env` file is a no-op, not an error.
- [x] No new npm dependency added for `.env` parsing.

## Implementation Plan

**Approach**: `config.ts` exports `FirmwareSource`, a
`parseFirmwareSource(raw: string): FirmwareSource` pure function (unit
tested directly against edge cases), a `loadEnvFile(path?, env?)`
side-effecting helper, and `getFirmwareConfig(env?, dotenvPath?)` that
combines them. `loadEnvFile`'s default path is resolved relative to
this module's own location (mirroring `server.ts`'s
`defaultStaticDir()` pattern), not `process.cwd()`.

**Files to create**:
- `packages/host/src/config.ts`
- `packages/host/src/config.test.ts`

**Files to modify**:
- `config/prod/public.env`
- `.gitignore` (commit the existing working-tree change; do not
  re-edit its content)

**Testing plan**: Unit tests for `parseFirmwareSource` (bare URL
defaults to `latest`; URL with `:tag` suffix; malformed input);
`getFirmwareConfig` against a fake `env` object (both vars set, one
set, neither set); `loadEnvFile` against a fixture `.env` file path
(sets an unset key, does not override an already-set key, no-ops on a
missing file) — no real filesystem dependency on the repo's own
`config/` output, so this test suite passes even before ticket work
lands `config/prod/public.env`'s real values.

**Documentation updates**: `config.ts`'s own module doc comment,
following the file's established pattern in this codebase (see
`swdName.ts`/`devices.ts` for the style: what this owns, what it
deliberately does not do, and why an absent variable is not an error).
