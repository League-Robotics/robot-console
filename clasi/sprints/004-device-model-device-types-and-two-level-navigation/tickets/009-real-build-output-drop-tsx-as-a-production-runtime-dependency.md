---
id: 009
title: 'Real build output: drop tsx as a production runtime dependency'
status: done
use-cases:
- SUC-008
depends-on: []
github-issue: ''
issue: no-build-pipeline-tsx-is-a-runtime-dependency.md
completes_issue: true
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Real build output: drop tsx as a production runtime dependency

## Description

Give `packages/host` and `packages/protocol` a real build: emit
compiled JS to `dist/`, point `main`/`types` there instead of at `.ts`
source, and move `tsx` from `robot-console`'s top-level production
`dependencies` to a devDependency. Keep `vitest` running against
source (unchanged — tests do not need the build output).

Per the folded-in issue: `bin/robot-console.js` currently loads the
app through `tsx` at runtime, and `tsx` is a **production** dependency
only because nothing is ever emitted (`npm run build` today is
`tsc --noEmit`, a type-check only). Plain Node cannot load `.ts`
sources directly — `UsbSerialLink.ts`'s constructor parameter
properties are rejected outright even with
`--experimental-transform-types`.

No functional/runtime behavior change for any feature — this ticket is
packaging only. It is deliberately sequenced last in this sprint (not
because anything technically depends on it, but so it doesn't collide
with the package.json/tsconfig churn every other ticket in this sprint
is making to `packages/host`/`packages/ui`).

## Acceptance Criteria

- [x] `packages/host` and `packages/protocol` each emit real `dist/`
      output from their build script (replacing/extending the current
      `tsc --noEmit`-only `build` script).
- [x] `main`/`types` in both packages' `package.json` point at
      `dist/` output, not `.ts` source.
- [x] `tsx` is removed from the top-level `package.json`'s production
      `dependencies` and added as a devDependency (or removed
      entirely, if `bin/robot-console.js` no longer needs it at
      runtime once it loads compiled JS — programmer's judgment on
      which, but production `dependencies` must not list it).
- [x] `bin/robot-console.js` runs the compiled `dist/` output directly
      via plain `node`, with no `tsx`/type-stripping loader involved
      at runtime.
- [x] A clean-install smoke check: from a fresh `npm install`
      (or `npm pack`/install-from-tarball, whichever the programmer
      judges most faithfully simulates an `npx` consumer), running the
      package's bin entry point works with `tsx` absent from the
      resolved production dependency tree.
- [x] `npm test` continues to run against `.ts` source via vitest,
      unaffected by the new build output — full suite still passes.
- [x] `npm run build` still passes across all three workspaces (now
      producing real output for `host`/`protocol`, not just
      type-checking).

## Verification Notes (programmer)

- `npm ls tsx --omit=dev` → empty: `tsx` does not appear anywhere in
  the production dependency tree (top-level `dependencies` no longer
  lists it; it only remains as a devDependency, pulled in again
  transitively by `vite`, also dev-only).
- Direct runtime smoke check (more faithful than a full `npm pack`
  given the workspace-private, unpublished nature of these packages):
  temporarily moved `node_modules/tsx` out of the way entirely, then
  ran `node bin/robot-console.js --port 4799` against the built
  `dist/` output — it started and served HTTP 200 with `tsx` completely
  absent from `node_modules`, then `tsx` was restored for `npm run dev`.
- End-to-end hardware check against built output only (no `tsx`, no
  `--noEmit`-only source resolution): started
  `node bin/robot-console.js --port 4797` from `dist/`, connected a
  `ws` client, and read the `endpoints` broadcast. `zapig` (a real
  `RADIOBRIDGE` relay) came back as
  `classification: { type: "relay", role: "RADIOBRIDGE", ... }` —
  confirming protocol + host + wire contract all survived the build
  change. (The other two attached boards returned
  `sessionError: "Cannot lock port"` — a pre-existing serial-port
  contention condition in this environment, unrelated to this ticket's
  build change and not a regression it introduced.)
- `npm run dev` (via `scripts/dev.mjs`) still starts host + Vite in one
  process from one command — verified by running it and observing both
  `robot-console: host listening on ...` and
  `robot-console: UI (hot reload) on ...` from a single invocation.
- `npm test` → 557/557 passing, unaffected.
- `npm run build` → real `dist/` emitted for `protocol` and `host`
  (root `build` script now runs them in explicit dependency order,
  `protocol` then `host` then `ui`, since `host`'s `tsc` needs
  `protocol`'s emitted `dist/index.d.ts`); `ui`'s `build` is unchanged
  (`tsc --noEmit`, still a type-check only, per scope boundary).

## Testing

- **Existing tests to run**: full `npm test` (must be unaffected —
  vitest keeps running against source); `npm run build` across all
  workspaces.
- **New tests to write**: no new vitest unit tests are expected for
  this ticket (it's build tooling); instead, document and run the
  clean-install smoke check described in the acceptance criteria as
  a manual/scripted verification step, and record its exact command
  and result in this ticket's own notes or the sprint's closing
  verification record — this is a "test-provable, no board required"
  criterion per `sprint.md`'s Success Criteria (SUC-008), but it is
  provable only by actually running it, not by code inspection.
- **Verification command**: `npm test && npm run build`, plus the
  clean-install smoke check above.

## Implementation Plan

**Approach:** Convert one package at a time (`packages/protocol`
first — it has no other workspace dependency, so it's the simplest
case to get right; then `packages/host`, which depends on
`protocol`'s build output once `protocol`'s `main` points at `dist/`),
verifying `npm run build` and `npm test` after each package before
touching `bin/robot-console.js` or the top-level `tsx` dependency.

**Files to modify:**
- `packages/protocol/package.json`, `packages/protocol/tsconfig.json`
  (or a new build-specific tsconfig, if the existing one is
  `--noEmit`-configured in a way that can't just be pointed at an
  `outDir`)
- `packages/host/package.json`, `packages/host/tsconfig.json` (same)
- `package.json` (top-level `dependencies`/`devDependencies` for `tsx`)
- `bin/robot-console.js`

**Documentation updates:** Update `package.json` descriptions/scripts
comments if any reference the old `tsc --noEmit`-only build; no
architecture doc changes needed beyond what `sprint.md`'s own
Architecture section already recorded for this module (Step 3's table
entry, Step 5's "What changed" bullet).
