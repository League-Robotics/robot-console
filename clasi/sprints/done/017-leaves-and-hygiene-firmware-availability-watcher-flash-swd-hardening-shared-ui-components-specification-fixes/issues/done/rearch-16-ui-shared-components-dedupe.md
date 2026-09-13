---
status: done
sprint: '017'
tickets:
- '007'
- 008
---

# UI: extract the shared components that three pages currently copy

## Description

The UI duplicates the same small pieces across pages and components
(`04-ui.md` §4):

| Duplicate | Sites |
|---|---|
| Relay Connect/Disconnect/Switch wiring and status copy ("Connecting to X…", "Trying remembered robots…", "Connection to X lost", "Connected to X on channel…") | `FrontPage.tsx:174-187, 525-544` vs `RelayPage.tsx:286-313, 325-339, 386-395` |
| `RobotSelect` + `buildRobotOptions` exported from a *page* and imported by three other files | `RelayPage.tsx:157, 197, 413` ← `FrontPage.tsx:157`, `ConfigurationPage.tsx:23`, `RadioAddressDialog.tsx:14` |
| Held-drive engine (`WHEELS_V` every 150 ms, `STOP` on release/unmount) | `DriveControls.tsx:346-368` vs `DriveTab.tsx:91-156` |
| Clear E-STOP (`SET estop_clear 1` + `STATUS`) | `StatusPanel.tsx:175-178` vs `DriveControls.tsx:514-515` |
| Calibration table (wheel diameter / track width / effective / slip) and the undefined-stripping merge | `CalibrationPage.tsx:268-332, 174-184` vs `ConfigurationPage.tsx:195-247, 86-96` |
| Wi-Fi save flow and source note | `WifiCredentialsDialog.tsx:105-118, 182-190` vs `ConfigurationPage.tsx:141-157, 290-296` |
| `<dialog>` open/showModal/fallback/close-focus boilerplate | `FlashDialog.tsx:152-171`, `WifiCredentialsDialog.tsx:78-103`, `RadioAddressDialog.tsx:43-53` |
| Connection-state copy ("Linked"/"Unreachable"/"Not linked"/"No link open…") | seven components |
| Name display fallback | `deviceDisplay.ts:25-35` **and** `DeviceConsole.tsx:92-100`; `name ?? endpointId` in seven files |
| Radio address validation | `RadioAddressDialog.tsx:62-69` vs `ConfigurationPage.tsx:107-114`; none on RelayPage inputs |
| Copy-to-clipboard with 1.5 s "Copied" | `CalibrationPage.tsx:216-224` vs `ConfigurationPage.tsx:180-188` |
| Console line prefix sniffers | `DeviceConsole.tsx:75-90`, `CommandStrip.tsx:93`, `DistanceCalibrationWizard.tsx:64` |

Several of these are touched by rearch-07 anyway; this issue is the
sweep that finishes the job so the pages read as pages.

## Proposed resolution

- `components/RelayConnectControls.tsx` (select + Connect/Switch/
  Disconnect + status text) used by both the front-page relay card and
  the relay page; status copy from one `relayStatusText(relay, child)`.
- `components/RobotSelect.tsx` moved out of `RelayPage`.
- `hooks/useHeldDrive.ts` used by `DriveControls` and `DriveTab`; one
  `clearEstop(send)` helper.
- `components/CalibrationTable.tsx` and `lib/calibration.ts` (merge,
  derived values) shared by Calibration and Configuration.
- `components/WifiCredentialsForm.tsx` shared by the dialog and the
  Configuration tab.
- `components/Modal.tsx` `<dialog>` shell.
- `deviceDisplay.ts` gains `linkStateText(link)` and every component uses
  `nameDisplay`; `DeviceConsole`'s local `deviceLabel` goes.
- One `lib/lineClass.ts` for rx-line classification used by console,
  command strip, and wizards.
- `lib/clipboard.ts` `useCopied()`.
- Radio validation comes from the host (`set-radio-override` rejects) or
  protocol's `validateRadioAddress`; remove both UI copies.

## Acceptance

- Each duplicate row above resolves to one definition; a grep for the
  literal status strings finds one site each.
- No page module exports a component imported by another page or
  component.
- Existing FakeSocket tests for the affected pages still pass with
  fixtures updated; the duplicated assertions collapse to the shared
  component's test.

## Depends on

rearch-07 (do after, or fold the overlapping pieces into it).

## References

- `docs/reviews/2026-09-11/04-ui.md` §4, §6
