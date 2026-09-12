---
id: '001'
title: 'Build hygiene: Node floor, lockfile, Linux-safe tests, submodule/typecheck
  guards'
status: in-progress
use-cases: []
depends-on: []
github-issue: ''
issue: rearch-17-build-hygiene-engines-lockfile-linux-tests-signals.md
completes_issue: true
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Build hygiene: Node floor, lockfile, Linux-safe tests, submodule/typecheck guards

## Description

Raise the whole repo's Node floor to `>=22.13` (required for `node:sqlite`,
which every later ticket in this sprint depends on), fix the lockfile
drift that dirties every `npm install`, make the two macOS-only host
tests pass on Linux, and add guard rails (submodule init, a root
typecheck script) so CI is trustworthy before the rest of the sprint
lands on top of it. This ticket has no use case of its own — it is pure
build/CI tooling with no runtime behavior a request ever executes (see
`sprint.md`'s Architecture §Step 3, "build tooling" module, for the
reasoned exception).

Foundation ticket: nothing else in this sprint can safely use
`node:sqlite` or trust Linux CI until this lands.

## Acceptance Criteria

- [ ] `engines.node >= 22.13` in root and every workspace `package.json`;
      `.nvmrc`/`.node-version` set to `22`; README states the floor and why.
- [ ] `.npmrc` sets `engine-strict=true`; `node --version` below 22.13
      fails `npm install` with the engines error.
- [ ] Lockfile drift is fixed once, and the version-bump script (or a
      `preversion` hook) runs `npm install --package-lock-only` so it
      cannot recur.
- [ ] `UsbSerialLink.test.ts:136` and the `RelayRadioLink` twin pass an
      explicit `platform` through the link's options instead of relying
      on `process.platform`, with both a darwin and a Linux expectation.
- [ ] `npm test`'s pretest (or CI) runs `git submodule update --init`;
      a guard test fails with a clear message if `vendor/*/docs` is
      missing.
- [ ] Root `npm run typecheck` script builds `packages/protocol/dist`
      (and host dist for ui) first, then runs `tsc --noEmit` per package;
      README documents it.
- [ ] `dapjs`'s ~5 used classes (`HID`, `CortexM`, `DAPLink`) are vendored
      into `packages/host/vendor/dapjs/` with the `.off` fix applied;
      `flash.ts` imports from there.
- [ ] `flash.ts:631`, `mbrelayRegistry.ts:250`/`261`, and
      `WsProvider.tsx:943` log instead of silently swallowing their catch.
- [ ] `npm test` is green on both Linux and macOS from a clean clone,
      with no dirty files afterward.

## Testing

- **Existing tests to run**: full `npm test` on both a Linux and a
  macOS runner (or CI matrix), from a clean clone following the README.
- **New tests to write**: Linux-case assertions for the two
  platform-coupled tests; a submodule-guard test that fails clearly when
  `vendor/*/docs` is absent; a lockfile-drift regression check
  (`npm install --package-lock-only --dry-run` produces no diff after
  a version bump).
- **Verification command**: `npm test` (full suite — this ticket has no
  narrower module to scope to, since it changes the test-running
  mechanism itself).

## Implementation Plan

**Approach**: Land the engines/lockfile/CI changes first (no code
dependents yet), then the two platform-test fixes, then the submodule
guard and typecheck script, then the dapjs vendoring and the three
logged catches — each independently verifiable.

**Files to create/modify**:
- `package.json` (root and each workspace): `engines.node`.
- `.nvmrc`, `.node-version`, `.npmrc` (new).
- `package-lock.json`: regenerate once; wire the bump script/`preversion`
  hook that keeps it in sync.
- `packages/host/src/link/UsbSerialLink.ts` (or its options type) and
  `RelayRadioLink.ts`: accept an explicit `platform` option;
  `devices.ts:173`'s `toCalloutPath` call sites pass it through.
- `packages/host/src/link/UsbSerialLink.test.ts` and the `RelayRadioLink`
  twin: add the Linux case.
- CI config / `package.json` `pretest`: `git submodule update --init`
  plus a new guard test module.
- New root `package.json` `typecheck` script; README section.
- `packages/host/vendor/dapjs/` (new): the ~5 vendored classes.
- `packages/host/src/flash.ts`, `packages/host/src/mbrelayRegistry.ts`,
  `packages/ui/.../WsProvider.tsx`: add logging to the three named catches.

**Documentation updates**: README — Node floor and why, the typecheck
script, the submodule requirement.
