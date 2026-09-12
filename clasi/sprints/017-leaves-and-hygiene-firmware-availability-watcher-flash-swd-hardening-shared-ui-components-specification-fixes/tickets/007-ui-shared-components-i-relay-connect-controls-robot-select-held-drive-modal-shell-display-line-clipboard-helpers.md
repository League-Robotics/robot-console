---
id: '007'
title: 'UI shared components I: relay connect controls, robot select, held-drive,
  modal shell, display/line/clipboard helpers'
status: done
use-cases:
- SUC-007
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

- [x] `components/RelayConnectControls.tsx` (select + Connect/Switch/
      Disconnect + status text) is used by both the front-page relay
      card and the relay page, with one `relayStatusText(relay, child)`
      helper as the single source of the status copy strings.
- [x] `components/RobotSelect.tsx` is moved out of `RelayPage` into its
      own module; `RelayPage`, `FrontPage`, `ConfigurationPage`, and
      `RadioAddressDialog` all import it from there, not from
      `RelayPage`. **Scope note**: in the current (post sprint 015/016)
      code, only `RelayPage` ever imported `RobotSelect`, and neither
      `ConfigurationPage` nor `RadioAddressDialog` render a name-based
      picker at all (both operate on one already-identified device via
      channel/group inputs) — see Implementation notes.
- [x] `hooks/useHeldDrive.ts` (the `WHEELS_V`-every-150ms / `STOP`-on-
      release/unmount engine) is used by both `DriveControls` and
      `DriveTab`.
- [x] A single `clearEstop(send)` helper (`SET estop_clear 1` +
      `STATUS`) replaces the two independent copies in `StatusPanel`
      and `DriveControls`.
- [x] `components/Modal.tsx` provides the `<dialog>` open/showModal/
      fallback/close-focus boilerplate; `FlashDialog`,
      `WifiCredentialsDialog`, and `RadioAddressDialog` all use it.
- [x] `deviceDisplay.ts` gains `linkStateText(link)`; every component
      uses it and `nameDisplay` instead of a local copy;
      `DeviceConsole`'s local `deviceLabel` is removed. **Scope note**:
      `DeviceConsole`'s `deviceLabel` was already removed by sprint
      015/016 (its own doc comment says so); nothing left to remove
      there. `nameDisplay` is now used at every device-identity heading
      (`FrontPage`'s device card and "not seen recently" card,
      `RelayPage`'s and `RobotPage`'s own `<h2>`).
- [x] `lib/lineClass.ts` provides one rx-line classifier used by
      `DeviceConsole`, `CommandStrip`, and `DistanceCalibrationWizard`.
      **Scope note**: only `DeviceConsole` actually duplicated this
      classifier; `CommandStrip`'s `GET_REPLY_PATTERN` and
      `DistanceCalibrationWizard`'s `RUN_ERR_REPLY_PATTERN` are
      different, narrower operations — see Implementation notes.
- [x] `lib/clipboard.ts`'s `useCopied()` (1.5 s "Copied" state) is
      added (consumed by ticket 008's calibration/configuration copy
      buttons).
- [x] No page module in this ticket's scope exports a component
      imported by another page or component.
- [x] Existing FakeSocket tests for the affected pages/components pass
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

## Implementation notes

Files created:
- `packages/ui/src/components/Modal.tsx` (+ `.test.tsx`, `.css`) — the
  `<dialog>` open/`showModal()`/fallback boilerplate. Deliberately thin:
  close/cancel/backdrop/keydown handlers and the dialog element itself
  (via a caller-supplied `dialogRef`) stay owned by each caller, since
  `FlashDialog`'s dismissal-suppression-while-flashing and Tab-cycling
  focus trap are load-bearing and not shared by the other two dialogs.
- `packages/ui/src/components/RelayConnectControls.tsx` (+ test, css)
  — `relayStatusText(relay, child)` plus the picker/Connect/Switch/
  Disconnect markup, in two variants (`"card"` = `FrontPage`'s former
  `RelayQuickConnect` markup/classes/per-relay `data-testid`s exactly;
  `"page"` = `RelayPage`'s own markup/classes/static `data-testid`s,
  appending "via `<relay>`" to the connected line). Each variant
  reproduces its own pre-extraction DOM/copy/order exactly — a pure
  extraction, not a redesign.
- `packages/ui/src/components/RobotSelect.tsx` (+ test) — moved
  verbatim out of `RelayPage.tsx`.
- `packages/ui/src/hooks/useHeldDrive.ts` (+ test) — the `WHEELS_V`
  resend/lease/`STOP`-on-release-or-unmount engine. `DriveControls`
  calls `setTarget` directly (single button, its own "already held"
  guard unchanged); `DriveTab`'s own `useDriveEngine` keeps its
  keyboard/gamepad merge policy and calls `held.setTarget(merged)`.
- `packages/ui/src/lib/lineClass.ts` (+ test) — `classifyLine`, moved
  verbatim out of `DeviceConsole.tsx`.
- `packages/ui/src/lib/clipboard.ts` (+ test) — `useCopied()`, matching
  both pre-existing copies' try/catch shape exactly (a synchronously-
  throwing `navigator.clipboard` skips the "Copied" flash, not just the
  write). Not yet consumed — ticket 008's own scope.
- `packages/ui/src/lib/estop.ts` (+ test) — `clearEstop(sendCommand,
  linkId)`. No filename was specified in this ticket's own "Files to
  create" list for the `clearEstop` helper; `lib/` (already introduced
  by this ticket for `lineClass`/`clipboard`) was the natural home.

Files modified: `FrontPage.tsx`/`.css`, `RelayPage.tsx`/`.css`,
`RobotPage.tsx`, `DriveControls.tsx`, `DriveTab.tsx`, `StatusPanel.tsx`,
`DeviceConsole.tsx`/`.test.tsx`, `FlashDialog.tsx`,
`WifiCredentialsDialog.tsx`, `RadioAddressDialog.tsx`, `deviceDisplay.ts`/
`.test.ts`, `FrontPage.test.tsx` — each switched to the new shared
module; duplicated assertions (relay status copy, `classifyLine` cases,
`linkStatusText`/`linkStateText` cases) moved to the new shared
component/module's own test file instead of staying duplicated.

**Two acceptance items came out narrower than written**, both because
the ticket's wording predates sprint 015/016's `Snapshot`-contract
rewrite of this package (the ticket text matches an older shape of the
code, per `docs/reviews/2026-09-11/04-ui.md`'s own note that it audited
the pre-rearch `EndpointsMessage` contract):

1. **`RobotSelect` "imported by `FrontPage`/`ConfigurationPage`/
   `RadioAddressDialog`"**: verified against the current code — none of
   the three actually rendered a robot-name picker before this ticket.
   `FrontPage`'s relay card had its own separate inline `<select>` with
   different copy/attributes (no `<label>` wrapper, a different empty-
   state string, no `disabled` on the placeholder `<option>`); forcing
   it onto `RobotSelect`'s exact markup would have changed visible
   output, which this ticket's "parity, not redesign" mandate forbids.
   `ConfigurationPage`/`RadioAddressDialog` operate on one already-
   known device (channel/group inputs), never a name picker, so there
   is nothing there to import. `RobotSelect` is moved to its own module
   and every current importer (`RelayPage`, via `RelayConnectControls`)
   uses that location, not `RelayPage`.
2. **`lib/lineClass.ts` "used by `CommandStrip`/`DistanceCalibrationWizard`"**:
   verified those two files — `CommandStrip`'s `GET_REPLY_PATTERN`
   captures a field *name* out of a `get <name> <value>` reply (a
   different operation from classifying a line's *style*), and
   `DistanceCalibrationWizard`'s `RUN_ERR_REPLY_PATTERN` deliberately
   matches only a bare `err` reply, narrower than `classifyLine`'s
   `"error"` kind (`err` *or* `nack`) — routing either through
   `classifyLine` would silently broaden what they match, a real
   behavior change. Both keep their own regex; `lib/lineClass.ts`'s
   `classifyLine` is used by its one true duplicate, `DeviceConsole`.

**Test results** (`npx vitest run packages/ui`, foreground): 36 files,
507 tests, all passing. `npm run typecheck`: clean.
