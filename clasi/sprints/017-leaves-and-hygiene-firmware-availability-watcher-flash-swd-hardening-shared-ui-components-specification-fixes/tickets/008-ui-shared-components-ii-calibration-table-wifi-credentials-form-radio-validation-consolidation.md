---
id: 008
title: 'UI shared components II: calibration table, WiFi credentials form, radio validation
  consolidation'
status: in-progress
use-cases:
- SUC-007
depends-on:
- '007'
github-issue: ''
issue: rearch-16-ui-shared-components-dedupe.md
completes_issue: true
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# UI shared components II: calibration table, WiFi credentials form, radio validation consolidation

## Description

Completes rearch-16's dedupe sweep: the calibration table (wheel
diameter / track width / effective / slip, and the undefined-stripping
merge) is duplicated between `CalibrationPage` and `ConfigurationPage`;
the WiFi save flow and source note between `WifiCredentialsDialog` and
`ConfigurationPage`; and radio address validation between
`RadioAddressDialog` and `ConfigurationPage` (with no validation at all
on `RelayPage`'s inputs). This ticket depends on ticket 007's `Modal`
and `lib/clipboard.ts`.

## Acceptance Criteria

- [ ] `components/CalibrationTable.tsx` and `lib/calibration.ts` (the
      merge and derived-value logic) are shared by `CalibrationPage`
      and `ConfigurationPage`.
- [ ] `components/WifiCredentialsForm.tsx` is shared by
      `WifiCredentialsDialog` and the `ConfigurationPage` WiFi tab.
- [ ] Radio address validation comes from one place — the host's
      `set-radio-override` rejection or protocol's
      `validateRadioAddress` — and both UI copies
      (`RadioAddressDialog.tsx`, `ConfigurationPage.tsx`) are removed
      in favor of it; `RelayPage`'s inputs gain the same validation
      they previously lacked.
- [ ] Copy-to-clipboard (1.5 s "Copied") on `CalibrationPage` and
      `ConfigurationPage` both use ticket 007's `lib/clipboard.ts`
      `useCopied()`.
- [ ] Every duplicate row catalogued in `docs/reviews/2026-09-11/
      04-ui.md` §4 now resolves to one definition (this ticket
      completes the set ticket 007 started).
- [ ] No page module in this ticket's scope exports a component
      imported by another page.
- [ ] Existing FakeSocket tests for `CalibrationPage`,
      `ConfigurationPage`, `WifiCredentialsDialog`, `RadioAddressDialog`,
      and `RelayPage` pass with fixtures updated; duplicated assertions
      collapse to the shared component's test.

## Implementation Plan

**Approach**: Same extraction discipline as ticket 007 — pure
extraction, no behavior change. `CalibrationTable`/`lib/calibration.ts`
first (self-contained), then `WifiCredentialsForm` (uses ticket 007's
`Modal` already wired into `WifiCredentialsDialog`), then radio
validation consolidation last since it touches three components at
once (`RadioAddressDialog`, `ConfigurationPage`, `RelayPage`).

**Files to create**:
- `packages/ui/src/components/CalibrationTable.tsx` (+ test, css)
- `packages/ui/src/lib/calibration.ts` (+ test)
- `packages/ui/src/components/WifiCredentialsForm.tsx` (+ test)

**Files to modify**:
- `CalibrationPage.tsx`, `ConfigurationPage.tsx` — use
  `CalibrationTable`/`lib/calibration.ts`; use `lib/clipboard.ts`.
- `WifiCredentialsDialog.tsx`, `ConfigurationPage.tsx` — use
  `WifiCredentialsForm`.
- `RadioAddressDialog.tsx`, `ConfigurationPage.tsx`, `RelayPage.tsx` —
  remove local radio-address validation copies; route through the
  host's `set-radio-override` rejection or protocol's
  `validateRadioAddress`; add validation to `RelayPage`'s inputs.

**Testing plan** (scoped vitest run: all touched component test files
plus affected pages' FakeSocket tests):
- `lib/calibration.ts` merge/derived-value unit tests (undefined-
  stripping cases).
- `CalibrationTable` rendering test shared by both pages' fixtures.
- `WifiCredentialsForm` save-flow test shared by dialog and
  configuration-tab fixtures.
- Radio validation: valid/invalid address cases for
  `RadioAddressDialog`, `ConfigurationPage`, and (new coverage)
  `RelayPage`.
- Full grep-based check: every row in `04-ui.md` §4 resolves to one
  definition (spot-checked, not automated).

**Documentation updates**: None; parity-preserving extraction. Note in
the ticket's completion notes which `04-ui.md` §4 rows are now
resolved, for the final bench ticket's reference.
