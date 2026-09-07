---
id: '001'
title: Monorepo skeleton, TS/vitest config, npx entry point
status: pending
use-cases: []
depends-on: []
github-issue: ''
issue: robot-console-architecture-and-roadmap.md
completes_issue: false
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Monorepo skeleton, TS/vitest config, npx entry point

## Description

Stand up the npm-workspaces TypeScript monorepo that every other ticket
in this sprint builds inside. Per `sprint.md`'s Architecture (Step 5,
"What Changed"), this is infrastructure shared by all three packages,
not a module of its own — it produces no protocol/host/ui behavior, only
the scaffolding that lets those packages exist, build, and be tested
together.

Three workspace packages, matching `docs/design/specification.md` §2:

```
packages/protocol/   pure TS, zero I/O
packages/host/       Node: USB, SWD, mDNS, TCP, UDP, hex fetch
packages/ui/         Vite + React, talks to host over one WebSocket
```

This ticket creates each package's `package.json` and a `src/` directory
containing nothing but a placeholder so later tickets have somewhere to
add files (do not add any naming/banner/codec/session/devices/server/UI
logic here — that is every ticket after this one). It also creates:

- A root `package.json` declaring the three workspaces, with `npm test`
  wired to run `vitest` across all workspaces.
- A shared base `tsconfig.json` at the repo root, extended by each
  package's own `tsconfig.json` (strict mode on, since `protocol` in
  particular needs to be trustworthy without hardware to catch mistakes
  against).
- A root `vitest` config (or workspace-aware equivalent) that discovers
  tests in all three packages, run via `npm test`.
- An `npx`-able `bin` entry point (e.g. a `bin/robot-console.js` or
  `packages/host`'s own `bin` field per `package.json` convention —
  implementer's choice, but it must be reachable as `npx robot-console`
  once published/linked). In this ticket the entry point only needs to
  exist and run without crashing (e.g. print a placeholder message) —
  wiring it to actually start the host server and open the browser is
  ticket 009's job, once `server.ts` exists. Do not stub out a fake
  server start here; leave a clear `// TODO(ticket 009)`-style marker
  instead, so ticket 009 has one obvious place to land the real
  behavior.

## Acceptance Criteria

- [ ] `npm install` succeeds from a clean checkout with no manual steps.
- [ ] `packages/protocol`, `packages/host`, `packages/ui` each exist
      with their own `package.json` and `tsconfig.json` extending a
      shared root config.
- [ ] `npm test` runs (via `vitest`) across all three workspaces and
      exits 0 with zero tests found (no test files exist yet).
- [ ] `npm run build` (or equivalent per-package build script) type-
      checks all three packages with no errors.
- [ ] `npx robot-console` (run locally via `npm link` or `npx --package
      . robot-console`) executes the entry point without crashing.
- [ ] `vendor/pxt-nezha-diffdrive` and `vendor/radio-robot-lib` exist
      as git submodules with HTTPS URLs, `.gitmodules` is committed,
      and `vendor/pxt-nezha-diffdrive/docs/radio-address-vectors.json`
      and `vendor/radio-robot-lib/tests/protocol/golden_vectors.txt`
      are both readable after `git submodule update --init`.
- [ ] `vendor/` is excluded from the TypeScript build and no package
      imports source code from it.
- [ ] `README.md` tells a fresh cloner how to initialize submodules.
- [ ] No naming/banner/codec/session/devices/server/UI logic exists yet
      in any package — this ticket is scaffolding only.

## Testing

- **Existing tests to run**: none exist yet.
- **New tests to write**: none — this ticket is pure tooling/config; a
  passing `npm test` with zero discovered tests is itself the
  verification that the workspace + vitest wiring is correct. (The
  first real tests land in ticket 002.)
- **Verification command**: `npm install && npm test && npm run build`,
  plus a manual `npx robot-console` smoke run.

## Implementation Plan

**Approach**:
1. Create the root `package.json` with `"workspaces": ["packages/*"]`
   and `npm test`/`npm run build` scripts that fan out to each
   workspace.
2. Create `packages/protocol/package.json`, `packages/host/package.json`,
   `packages/ui/package.json` (each a minimal, valid package with a
   `name`, `version`, and `main`/`types` pointing at a `src/` entry).
3. Create a root `tsconfig.base.json` (strict, ES2022 target or similar,
   module resolution appropriate for Node ESM/CJS as the implementer
   judges best for `serialport`/`dapjs` compatibility) and a
   `tsconfig.json` per package extending it, with `packages/host` and
   `packages/ui` referencing `packages/protocol` via TS project
   references or a workspace path alias.
4. Add a root `vitest.config.ts` (or `vitest.workspace.ts`) that
   discovers `*.test.ts` files under all three `packages/*/src`.
5. Add the `bin` entry point per the Description above, with a `TODO`
   marker for ticket 009.
6. **Add the two reference-spec submodules** (stakeholder decision —
   these repos are submoduled, never copied into this tree):

   ```
   git submodule add https://github.com/League-Robotics/pxt-nezha-diffdrive.git vendor/pxt-nezha-diffdrive
   git submodule add https://github.com/League-Robotics/radio-robot-lib.git   vendor/radio-robot-lib
   ```

   Use the **HTTPS** URLs exactly as written (both upstream repos use
   HTTPS remotes; HTTPS also needs no SSH key, which matters for the
   student audience). Commit the resulting `.gitmodules`.

   These supply the test fixtures later tickets read at repo-relative
   paths — `vendor/pxt-nezha-diffdrive/docs/radio-address-vectors.json`
   (ticket 002) and `vendor/radio-robot-lib/tests/protocol/golden_vectors.txt`
   (tickets 004, 005). They are **reference data only**: nothing in
   `packages/*` may import source code from `vendor/`, and the
   TypeScript build must not compile anything under `vendor/` (add it
   to `exclude` in the root tsconfig and to `.gitignore`-adjacent build
   globs as needed).
7. Add a short `README.md` note telling a fresh cloner to use
   `git clone --recurse-submodules`, or run
   `git submodule update --init` before `npm test`.
8. Verify `npm install`, `npm test`, `npm run build`, and a manual
   `npx robot-console` run all succeed.

**Files to create**:
- `package.json`, `tsconfig.base.json`, `vitest.config.ts` (or
  `vitest.workspace.ts`) at the repo root.
- `packages/protocol/package.json`, `packages/protocol/tsconfig.json`,
  `packages/protocol/src/index.ts` (placeholder export).
- `packages/host/package.json`, `packages/host/tsconfig.json`,
  `packages/host/src/index.ts` (placeholder export), the `bin` entry
  point file.
- `packages/ui/package.json`, `packages/ui/tsconfig.json`, a minimal
  Vite scaffold (`packages/ui/src/main.tsx`, `packages/ui/index.html`)
  sufficient to build, with no real UI yet.

**Files to create (cont.)**: `.gitmodules` (via `git submodule add`),
a root `README.md` with the submodule-init note.

**Files to modify**: none — greenfield.

**Testing plan**: `npm install`, `npm test` (expect 0 tests, exit 0),
`npm run build` (expect success), manual `npx robot-console` run
(expect no crash).

**Documentation updates**: none required by this ticket; a root
`README.md` with setup instructions may be added but is not required by
this sprint's Success Criteria — do not let it expand scope.
