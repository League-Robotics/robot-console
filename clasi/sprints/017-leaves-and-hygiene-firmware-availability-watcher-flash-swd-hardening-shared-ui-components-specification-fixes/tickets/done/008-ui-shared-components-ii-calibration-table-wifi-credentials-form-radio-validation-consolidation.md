---
id: 008
title: 'UI shared components II: calibration table, WiFi credentials form, radio validation
  consolidation'
status: done
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

- [x] `components/CalibrationTable.tsx` and `lib/calibration.ts` (the
      merge and derived-value logic) are shared by `CalibrationPage`
      and `ConfigurationPage`.
- [x] `components/WifiCredentialsForm.tsx` is shared by
      `WifiCredentialsDialog` and the `ConfigurationPage` WiFi tab.
- [x] Radio address validation comes from one place — the host's
      `set-radio-override` rejection or protocol's
      `validateRadioAddress` — and both UI copies
      (`RadioAddressDialog.tsx`, `ConfigurationPage.tsx`) are removed
      in favor of it; `RelayPage`'s inputs gain the same validation
      they previously lacked. **Scope note**: the "one place" is
      `lib/radioAddress.ts`, a new module mirroring the host's
      `radioOverride.ts::isValidRadioOverride` range (0-83/0-255), not
      protocol's `validateRadioAddress` (a narrower, different-purpose
      check) — see Implementation notes. `RelayPage` has had no
      channel/group inputs at all since sprint 015's rewrite (only a
      name picker via `RelayConnectControls`), so there is nothing
      there to add validation to — see Implementation notes.
- [x] Copy-to-clipboard (1.5 s "Copied") on `CalibrationPage` and
      `ConfigurationPage` both use ticket 007's `lib/clipboard.ts`
      `useCopied()`.
- [x] Every duplicate row catalogued in `docs/reviews/2026-09-11/
      04-ui.md` §4 now resolves to one definition (this ticket
      completes the set ticket 007 started).
- [x] No page module in this ticket's scope exports a component
      imported by another page.
- [x] Existing FakeSocket tests for `CalibrationPage`,
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

## Implementation notes

Files created:
- `packages/ui/src/lib/calibration.ts` (+ `.test.ts`) — moved verbatim
  out of `CalibrationPage.tsx`: `CalibrationState`, `DerivedCalibration`,
  `CALIBRATION_IMAGE_BASELINE_DIAMETER_MM`, `round`, `correctTrackWidth`,
  `deriveCalibration`, `calibrationCode`, `readCalibrationState`/
  `writeCalibrationState`, `parsePositiveNumber`, plus a new
  `applyCalibrationPatch(previous, patch)` — the undefined-stripping
  merge `CalibrationPage`'s `update` and `ConfigurationPage`'s
  `patchCalibration` each used to duplicate inline.
- `packages/ui/src/components/CalibrationTable.tsx` (+ `.test.tsx`,
  `.css`) — the "current calibration" table, with a `variant:
  "calibration" | "configuration"` reproducing each pre-extraction
  page's own exact copy: only the `calibration` variant shows the
  "from distance calibration" / "wheel centre to wheel centre" notes
  and the explanatory unmeasured-slip sentence
  ("1 (no measured track width...)"); the `configuration` variant's
  effective-track/slip cells were already phrased differently
  (plain "run the rotation calibration"; the bare slip number with no
  explanatory text even when unmeasured) in the pre-extraction code --
  verified by reading both source files side by side before writing the
  shared component, not assumed. `CalibrationTable.css` holds the
  `.calibration-table`/`.calibration-source` rules, moved out of
  `CalibrationPage.css` since `ConfigurationPage.tsx`'s own Wi-Fi/Radio
  tables (unrelated to this component) reuse the same class and need
  it too.
- `packages/ui/src/components/WifiCredentialsForm.tsx` (+ `.test.tsx`)
  — `WIFI_SSID_MAX`/`WIFI_PASSWORD_MAX`/`validateWifiInput`  moved
  verbatim out of `WifiCredentialsDialog.tsx`, plus a new
  `WifiCredentialsForm` component covering the ssid/password fields,
  the show/hide toggle (dialog variant only), and the source-note
  text. `variant: "dialog" | "tab"` reproduces each site's own prior
  DOM exactly: the dialog's `<label>`-wrapped inputs with length limits
  and a trailing "Written to the robot's credential slot 0..." sentence
  vs. the tab's own `calibration-table`-styled rows with no length
  limits, no show/hide toggle, and a note with no trailing sentence --
  these were real, verified differences in the pre-extraction code, not
  redesigned away. The *save flow* (the dialog's one submit vs. the
  tab's separate Save/Write-to-robot buttons) stays with each caller,
  same division of labor as ticket 007's `Modal`.
- `packages/ui/src/lib/radioAddress.ts` (+ `.test.ts`) —
  `validateRadioOverrideInput(channel, group)`, replacing the identical
  inline `0-83`/`0-255` check (and identical error strings) duplicated
  in `RadioAddressDialog.tsx` and `ConfigurationPage.tsx`.

Files modified: `CalibrationPage.tsx`/`.css`/`.test.tsx`,
`ConfigurationPage.tsx`, `WifiCredentialsDialog.tsx`/`.test.tsx`,
`RadioAddressDialog.tsx` — each switched to the new shared module(s);
`CalibrationPage.test.tsx`'s "calibration maths" describe and
`WifiCredentialsDialog.test.tsx`'s "validateWifiInput" describe moved to
the new modules' own test files instead of staying duplicated.

**One acceptance item resolved narrower than its literal wording, a
documented scope deviation** (same discipline as ticket 007's own two):

**"Radio address validation ... from the host's `set-radio-override`
rejection or protocol's `validateRadioAddress`"**: verified against the
actual code before choosing. `packages/host/src/radioOverride.ts`'s
`isValidRadioOverride` -- the function `server.ts`'s `set-radio-override`
handler actually calls -- validates the raw hardware range (`channel`
`0-83`, `group` `0-255`, both integers, no oddness/reserved-group
constraint), explicitly wider than derived addresses "because an
instructor may want any hardware-valid nRF24 address, not only one a
five-letter name could derive" (that module's own doc comment).
`@robot-console/protocol`'s `validateRadioAddress` checks the narrower
*derived*-address space instead (odd channel 25-73, group 1-126
excluding the reserved 10) -- the space `nameToRadioAddress` can
actually produce, a different purpose. Both pre-extraction UI copies
(`RadioAddressDialog.tsx:62-69`, `ConfigurationPage.tsx:107-114`)
already matched the *wider* host range (identical 0-83/0-255 checks and
identical error strings), confirmed by the existing test suite
(`RadioAddressDialog.test.tsx`'s "0 to 83"/"0 to 255" assertions,
`ConfigurationPage.test.tsx`'s "0 to 83" assertion). Routing this input
through protocol's narrower `validateRadioAddress` would have newly
rejected values the host accepts today (e.g. an even channel, or
`group: 10`) -- a real behavior change the ticket's own "pure
extraction, no behavior change" mandate forbids, and it would have
silently defeated the wider-range design `isValidRadioOverride`'s doc
comment describes on purpose. Importing `radioOverride.ts` itself was
also rejected: it imports `mbrelayRegistry.ts` (reaching into
`store/index.ts`), pulling the host's server-only dependency graph into
a browser bundle. Resolution: a new `lib/radioAddress.ts` re-states the
same two range constants and the same one check, so client and host
enforce the identical rule without sharing a module graph -- the host's
`set-radio-override` handler remains the actual authority regardless.
Full reasoning is in that module's own doc comment.

**One acceptance item was already moot before this ticket started, also
verified rather than assumed**: "`RelayPage`'s inputs gain the same
validation they previously lacked" -- `pages/RelayPage.tsx` (rewritten
by sprint 015 ticket 008, well after this ticket's own text was
written) has rendered no channel/group inputs at all since that
rewrite; connecting is name-only, through the shared
`RelayConnectControls` picker. `RelayPage.test.tsx` has no
channel/group input assertions either. There is nothing left on that
page to validate.

**`docs/reviews/2026-09-11/04-ui.md` §4 rows resolved** (the complete
set across tickets 007 and 008):

| Row | Resolved by |
|---|---|
| Connection-state text ("Linked"/"Unreachable"/"Not linked"/"No link open…") | Ticket 007 -- `deviceDisplay.ts`'s `linkStateText` |
| Name display fallback | Ticket 007 -- `deviceDisplay.ts`'s `nameDisplay` |
| Relay-bridge status copy | Ticket 007 -- `RelayConnectControls.tsx`'s `relayStatusText` |
| Relay Connect/Disconnect/Switch wiring | Ticket 007 -- `RelayConnectControls.tsx` |
| `RobotSelect` + `buildRobotOptions` exported from a page | Ticket 007 -- `components/RobotSelect.tsx` (see that ticket's own scope note: no current importer besides `RelayPage`) |
| Radio address validation (0-83 / 0-255) | Ticket 008 (this ticket) -- `lib/radioAddress.ts` |
| Wi-Fi save flow and source note text | Ticket 008 (this ticket) -- `components/WifiCredentialsForm.tsx` (fields/validation/note; each caller's own save flow, per that module's own doc comment) |
| Calibration table | Ticket 008 (this ticket) -- `components/CalibrationTable.tsx` |
| `patchCalibration`/`update` undefined-stripping merge | Ticket 008 (this ticket) -- `lib/calibration.ts`'s `applyCalibrationPatch` |
| `<dialog>` open/showModal/fallback/close-focus boilerplate | Ticket 007 -- `components/Modal.tsx` |
| closed→open "probe once" `wasOpenRef` effect | Out of this sweep's scope -- `04-ui.md` §3 item 6 flags this as UI-side policy the host should absorb (redundant polling), not a UI duplication to consolidate; no ticket in this sprint targets it |
| Held-drive engine | Ticket 007 -- `hooks/useHeldDrive.ts` |
| Clear E-STOP | Ticket 007 -- `lib/estop.ts`'s `clearEstop` |
| Copy-to-clipboard with 1.5 s "Copied" | Ticket 007 introduced `lib/clipboard.ts`'s `useCopied()`; ticket 008 (this ticket) is its first consumer, on both `CalibrationPage` and `ConfigurationPage` |
| Console line classification (`classifyLine` vs. `GET_REPLY_PATTERN` vs. `RUN_ERR_REPLY_PATTERN`) | Ticket 007 -- `lib/lineClass.ts` for `DeviceConsole`'s true duplicate; `CommandStrip`/`DistanceCalibrationWizard` keep their own narrower patterns by design (see ticket 007's own scope note) |

Every row in `04-ui.md` §4 is accounted for: either resolved to one
definition, or (the one `wasOpenRef` row) explicitly out of this
sweep's scope per the review's own §3/§4 framing.

**Test results** (`npx vitest run packages/ui`, foreground): 40 files,
524 tests, all passing. `npm run typecheck`: clean.
