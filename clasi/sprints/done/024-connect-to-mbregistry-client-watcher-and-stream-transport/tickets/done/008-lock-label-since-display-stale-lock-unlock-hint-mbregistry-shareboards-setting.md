---
id: 008
title: Lock label/since display, stale-lock unlock hint, mbregistry.shareBoards setting
status: done
use-cases:
- SUC-005
- SUC-006
depends-on:
- '001'
- '003'
github-issue: ''
issue: use-mbregistry-for-boards-locks-and-flashing.md
completes_issue: true
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Lock label/since display, stale-lock unlock hint, mbregistry.shareBoards setting

## Description

Two small, independent pieces bundled together since both are
"finish the UI/config surface" work left after tickets 001-004 and
006-007 land the core mechanism:

1. **Lock display verification** (SUC-005/SUC-006): ticket 003 already
   makes `mbregistryStream.open()` reject with the right message text
   flowing through the existing `state_reason`/`linkStateText` pipeline
   (`packages/ui/src/deviceDisplay.ts`) with **no** new UI component.
   This ticket is where that end-to-end path gets its own explicit
   UI-level test/verification: seed a link row with the exact
   `state_reason` shape ticket 003 produces (`"in use by <label>"`,
   plain `"in use"`, and the stale-lock `unlock --force` hint) and assert
   `linkStateText`/the front-page card render it correctly, including the
   two graceful-degradation cases (no `label`, no `since`). Do not add a
   take-over button — the design doc is explicit that this is an operator
   action only (§7, "no pre-emption across processes").
2. **`mbregistry.shareBoards` setting**: add a `settings` row (reuse the
   existing `settings` table pattern, `store/index.ts`) read at
   spawn-decision time in ticket 001's resolver — `true` passes
   `--peer` peering on (omit `--no-peering`) for a spawned instance;
   `false`/absent (default) keeps `--no-peering`. Expose it through
   whatever settings surface this codebase already uses for similar
   host-only toggles (check `config.ts`/existing settings UI, if any,
   for the established pattern before adding a new one).

## Acceptance Criteria

- [x] A link with `state_reason: "in use by alice-laptop"` renders that
      text on the front page exactly as any other connect-failure reason
      does today.
- [x] A link with `state_reason: "in use"` (no label) renders that plain
      text — no `undefined`/`null` leaks into the UI.
- [x] A link with the stale-lock hint text renders it verbatim, including
      the `mbregistry unlock --force <name>` command.
- [x] No UI control anywhere calls `unlock --force`; the hint is
      display-only text.
- [x] `mbregistry.shareBoards = true` results in a spawned instance
      started without `--no-peering`; `false`/absent keeps it.
- [x] The setting persists across a restart (stored in `settings`, not
      in-memory only), matching this codebase's existing settings
      convention.

## Implementation Notes (deviations from plan)

- **Part 1 (lock display) needed no source changes at all.** Confirmed
  ticket 003's `formatLockedMessage` (`mbregistryStream.ts`) produces
  plain strings ("in use", "in use by `<label>`", the stale
  `unlock --force` hint) that contain none of the shapes
  `stripInternalIds`/`plainFailureReason` (`deviceDisplay.ts`) recognize
  or mangle — they flow through `linkStateText` verbatim, exactly like
  any other unrecognized-but-clean failure reason already does. Added
  test-only coverage: three new `linkStateText` cases in
  `deviceDisplay.test.ts` plus a new `FrontPage.test.tsx` describe block
  asserting the same three shapes render on the actual card DOM and that
  no button/link anywhere contains "unlock". Did **not** touch
  `remoteFlash.ts`'s own separate `formatLockedMessage` (no staleness
  hint, by deliberate one-shot-flash design per that module's own doc
  comment) — unifying it with `mbregistryStream.ts`'s copy would change
  working, already-documented behavior outside this ticket's acceptance
  criteria, not just remove duplication.
- **Part 2 (`mbregistry.shareBoards`) followed the `firmwareConfig.ts`
  pattern exactly**, since this codebase has no settings UI at all yet
  (`config.ts`'s own doc comment): a new bootstrap-time importer
  (`store/importers/mbregistryConfig.ts`) resolves
  `ROBOT_CONSOLE_MBREGISTRY_SHARE_BOARDS` into the `mbregistry
  .shareBoards` `settings` row on every bootstrap (not one-time-guarded,
  same as `importFirmwareConfig` — a present env var always takes effect
  on the next restart; an absent one leaves the existing row untouched,
  which is what makes the setting persist across a restart). `config.ts`
  gained `getMbregistryShareBoards(store)` as the typed reader.
  `runtime.ts#startRuntime` reads it right after opening the store and
  passes it as `createMbregistryClient`'s own `shareBoards` default —
  an explicit `shareBoards` in `options.mbregistryClientDeps` (the
  existing test seam) still overrides it. `spawnMbregistry`
  (`mbregistry/client.ts`, ticket 006) already turns `shareBoards` into
  presence/absence of `--no-peering`; this ticket's own new coverage is
  the settings-row-to-runtime wiring, not that translation itself
  (already tested in `client.test.ts`).
- **Files actually touched beyond the plan's list**: `config.ts`/
  `config.test.ts` (new `getMbregistryShareBoards`/settings key, not
  `client.ts` itself — `client.ts` already took `shareBoards` as a
  `MbregistryClientDeps` field since ticket 006), `runtime.ts`/
  `runtime.test.ts` (the read-and-default-in wiring), a new
  `store/importers/mbregistryConfig.ts` + its test file, and
  `store/bootstrap.ts`/`bootstrap.test.ts` (wiring the new importer into
  the same bootstrap sequence `importFirmwareConfig` runs in). No
  `FrontPage.test.tsx` front-page-only change was needed for the setting
  itself (host-only, no UI surface).

## Implementation Plan

- **Approach**: reuse existing display/settings machinery — this ticket
  should not introduce new UI components for the lock-reason text itself
  (ticket 003 already produces plain strings the existing pipeline
  renders); it adds test coverage for that path plus the one genuinely
  new setting.
- **Files to modify**: `packages/host/src/config.ts` (or wherever
  settings keys are declared), `packages/ui/src/deviceDisplay.test.ts`
  (new cases), `packages/ui/src/pages/FrontPage.test.tsx` (if front-page
  rendering needs its own assertion), `packages/host/src/mbregistry/client.ts`
  (read the setting at spawn time — ticket 001's own module, revisited
  here rather than there since the setting doesn't exist until this
  ticket).
- **Testing plan**: unit tests for `linkStateText`/front-page rendering
  against seeded `state_reason` strings; a `mbregistryClient` spawn test
  asserting `--no-peering` is present/absent per the setting.
- **Documentation updates**: README or settings doc, if one exists,
  gains a line describing `mbregistry.shareBoards`.
