---
id: '007'
title: 'UI shared components I: relay connect controls, robot select, held-drive,
  modal shell, display/line/clipboard helpers'
status: open
use-cases: [SUC-007]
depends-on: []
github-issue: ''
issue: rearch-16-ui-shared-components-dedupe.md
completes_issue: false
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# UI shared components I: relay connect controls, robot select, held-drive, modal shell, display/line/clipboard helpers

## Description

`FrontPage`, `RelayPage`, `ConfigurationPage`, and several dialogs
currently copy the same connect-controls, robot-select, held-drive,
e-stop-clear, modal-shell, and status-copy logic
(`docs/reviews/2026-09-11/04-ui.md` §4). This ticket extracts the
first half of the catalogued duplicates into single shared definitions.
Ticket 008 covers the remaining half (calibration table, WiFi form,
radio validation) since it depends on the `Modal` shell this ticket
introduces.

## Acceptance Criteria

- [ ] `components/RelayConnectControls.tsx` (select + Connect/Switch/
      Disconnect + status text) is used by both the front-page relay
      card and the relay page, with one `relayStatusText(relay, child)`
      helper as the single source of the status copy strings.
- [ ] `components/RobotSelect.tsx` is moved out of `RelayPage` into its
      own module; `RelayPage`, `FrontPage`, `ConfigurationPage`, and
      `RadioAddressDialog` all import it from there, not from
      `RelayPage`.
- [ ] `hooks/useHeldDrive.ts` (the `WHEELS_V`-every-150ms / `STOP`-on-
      release/unmount engine) is used by both `DriveControls` and
      `DriveTab`.
- [ ] A single `clearEstop(send)` helper (`SET estop_clear 1` +
      `STATUS`) replaces the two independent copies in `StatusPanel`
      and `DriveControls`.
- [ ] `components/Modal.tsx` provides the `<dialog>` open/showModal/
      fallback/close-focus boilerplate; `FlashDialog`,
      `WifiCredentialsDialog`, and `RadioAddressDialog` all use it.
- [ ] `deviceDisplay.ts` gains `linkStateText(link)`; every component
      uses it and `nameDisplay` instead of a local copy;
      `DeviceConsole`'s local `deviceLabel` is removed.
- [ ] `lib/lineClass.ts` provides one rx-line classifier used by
      `DeviceConsole`, `CommandStrip`, and `DistanceCalibrationWizard`.
- [ ] `lib/clipboard.ts`'s `useCopied()` (1.5 s "Copied" state) is
      added (consumed by ticket 008's calibration/configuration copy
      buttons).
- [ ] No page module in this ticket's scope exports a component
      imported by another page or component.
- [ ] Existing FakeSocket tests for the affected pages/components pass
      with fixtures updated; duplicated assertions collapse to one
      test per shared component.

## Implementation Plan

**Approach**: Extract in dependency order — `Modal` first (dialogs
depend on it), then `RelayConnectControls`/`RobotSelect`
(front-page/relay-page depend on them), then `useHeldDrive`/
`clearEstop` (drive components), then the cross-cutting helpers
(`deviceDisplay.linkStateText`, `lib/lineClass.ts`, `lib/clipboard.ts`).
Behavior must not change — this is a pure extraction; any test
assertion that referred to the duplicated inline logic moves to the
new shared component's own test file.

**Files to create**:
- `packages/ui/src/components/Modal.tsx` (+ `.test.tsx`, `.css`)
- `packages/ui/src/components/RelayConnectControls.tsx` (+ test, css)
- `packages/ui/src/components/RobotSelect.tsx` (+ test)
- `packages/ui/src/hooks/useHeldDrive.ts` (+ test)
- `packages/ui/src/lib/lineClass.ts` (+ test)
- `packages/ui/src/lib/clipboard.ts` (+ test)

**Files to modify**:
- `FrontPage.tsx`, `RelayPage.tsx` — use `RelayConnectControls`,
  `RobotSelect` from their new locations; remove local copies.
- `ConfigurationPage.tsx`, `RadioAddressDialog.tsx` — import
  `RobotSelect` from its new location.
- `DriveControls.tsx`, `DriveTab.tsx` — use `useHeldDrive`.
- `StatusPanel.tsx`, `DriveControls.tsx` — use shared `clearEstop`.
- `FlashDialog.tsx`, `WifiCredentialsDialog.tsx`,
  `RadioAddressDialog.tsx` — use `Modal`.
- `deviceDisplay.ts` — add `linkStateText`; remove
  `DeviceConsole`'s local `deviceLabel`.
- `DeviceConsole.tsx`, `CommandStrip.tsx`,
  `DistanceCalibrationWizard.tsx` — use `lib/lineClass.ts`.
- Existing FakeSocket test fixtures for all touched pages/components.

**Testing plan** (scoped vitest run: all touched component test files
plus the affected pages' FakeSocket tests):
- Each new shared component/hook gets its own focused unit test
  (status text variants, held-drive timing/cleanup, modal open/close/
  focus-return, line classification cases, copy-then-revert timing).
- Existing FakeSocket tests for `FrontPage`, `RelayPage`,
  `ConfigurationPage`, `DriveControls`/`DriveTab`, and the three
  dialogs pass with fixtures updated; duplicated assertions collapse
  to the shared component's own test (grep for the previously-
  duplicated status strings finds exactly one definition site).

**Documentation updates**: None; UI behavior is unchanged by
construction (parity, not redesign). `docs/reviews/2026-09-11/04-ui.md`
§4 rows this ticket resolves can be checked off in the PR description.
