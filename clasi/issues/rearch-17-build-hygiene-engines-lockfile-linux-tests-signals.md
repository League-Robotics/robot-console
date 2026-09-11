---
status: pending
---

# Build hygiene: Node floor, lockfile drift, Linux-safe tests, dependency risks

## Description

From `docs/reviews/2026-09-11/06-build-tests-history.md` §1 and
`03-host-server-flash-releases.md` §5:

- Root `package.json` declares `engines.node >= 18`, but `serialport@13`
  and `open@11` require `>= 20`, Node 18 and 20 are both EOL, and the
  rearchitecture needs `node:sqlite` (unflagged since 22.13).
- `package-lock.json` root `version` is `0.20260908.2` while
  `package.json` is `0.20260911.2`; every `npm install` dirties the tree.
  Fifteen of 83 commits are `chore: bump version`, so this will recur
  unless the bump script also touches the lockfile.
- Two host tests pass only on macOS: `UsbSerialLink.test.ts:136` and the
  `RelayRadioLink` twin assert the darwin `tty.`→`cu.` translation while
  production `toCalloutPath(path, platform = process.platform)` is a
  no-op elsewhere (`devices.ts:173`). CI on Linux is red by exactly these.
- 94 protocol tests silently don't run without `vendor/` submodules
  (rearch-15 fixes the test files; this issue makes CI init submodules
  and fail loudly if the fixtures are absent).
- Host and UI type-checks require `packages/protocol/dist` (and host
  dist for ui) because workspace `types` point at `dist/`; a clean
  checkout must build protocol first, which nothing documents.
- `dapjs@2.3.0` is effectively unmaintained, UMD-only, and its typings
  disagree with runtime (the `.off` workaround at `flash.ts:381-400`).
  Candidate to vendor.
- `config.ts:115` resolves `.env` relative to the module, which under a
  registry install is `node_modules/robot-console/.env`. With rearch-01
  the source of truth becomes `settings`; `.env` is an importer input.
- 19 comment-only or bare-return `catch` blocks are listed in §5 of the
  build review; most are legitimate best-effort cleanups, but
  `flash.ts:631` (volume listing), `mbrelayRegistry.ts:250/261`
  (registry fetch/parse), and `WsProvider.tsx:943` (unparseable frame)
  should at least log.

## Proposed resolution

- `engines.node >= 22.13` in root and every workspace; `.nvmrc`/`.node-version`
  `22`; README states the floor and why.
- Fix the lockfile drift once; make the version-bump script (or a
  `preversion` hook) run `npm install --package-lock-only`.
- The two platform tests pass an explicit `platform: "darwin"` through
  the link's options (or the adapter's) rather than relying on
  `process.platform`; add the Linux expectation as a second case.
- CI (or `npm test` pretest): `git submodule update --init`; a guard test
  fails with a clear message if `vendor/*/docs` is missing.
- Root `npm run typecheck` script that builds protocol and host dist first
  then runs `tsc --noEmit` per package; README documents it.
- Decide on `dapjs`: vendor the ~5 classes used (`HID`, `CortexM`,
  `DAPLink`) into `packages/host/vendor/dapjs/` with the `.off` fix
  applied, or pin and document the workaround. Recommend vendoring.
- Add logging to the three swallowed catches named above.

## Acceptance

- `npm test` green on Linux and macOS from a clean clone following the
  README, with no dirty files afterward.
- `node --version` below 22.13 fails `npm install` with the engines
  error (with `engine-strict` in `.npmrc`).
- `npx tsc --noEmit` per package works via the documented script on a
  clean checkout.

## Depends on

Nothing; rearch-01 needs the engines bump, so land this first or fold
that one line into rearch-01.

## References

- `docs/reviews/2026-09-11/06-build-tests-history.md` §1, §5
- `docs/reviews/2026-09-11/03-host-server-flash-releases.md` §4, §5
