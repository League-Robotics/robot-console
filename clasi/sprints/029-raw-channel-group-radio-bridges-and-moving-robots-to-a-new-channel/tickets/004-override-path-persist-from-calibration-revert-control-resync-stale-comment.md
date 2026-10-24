---
id: '004'
title: 'Override path: persist from Calibration, revert control, resync, stale comment'
status: open
use-cases: [SUC-004, SUC-005]
depends-on: []
github-issue: ''
issue: verify-moving-a-robot-to-a-new-radio-channel.md
completes_issue: true
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Override path: persist from Calibration, revert control, resync, stale comment

## Description

Fix the move-a-robot override path. Findings: header "Set Radio" works and already gets `device.id`/`device.radio` (its doc comment saying otherwise is stale); the Calibration "Wi-Fi and radio" panel's Save only validates and updates a local draft and never sends `set-radio-override`, and its draft is never re-synced from `device.radio`; no UI sends `set-radio-override {clear:true}` although host, wire and `store.clearRadioOverride` support it.

## Acceptance Criteria

- [ ] Calibration panel Save sends `set-radio-override {deviceId, channel, group}` when the valid draft differs from `device.radio`; the snapshot then shows `radio.source: "override"`.
- [ ] The panel's draft re-syncs when `device.radio` changes (e.g. after the header dialog sets it), so both UIs agree.
- [ ] Both the panel and `RadioAddressDialog` show a "Revert to derived" control only when `device.radio.source === "override"`; it sends `{type:"set-radio-override", deviceId, clear:true}` and the radio returns to the derived/registry address.
- [ ] The generated code block (`lib/programCode.ts` via `CalibrationPage`) shows the override's `diffDrive.setupRadio(c, g)` immediately after set and the derived pair after revert.
- [ ] `RadioAddressDialog.tsx` doc comment corrected (callers pass `deviceId` and `radio`); `NetworkSettingsPanel.tsx` header comment states Save persists the override.
- [ ] Host: a test confirms `set-radio-override` set then clear round-trips through `resolveDeviceRadio` for a bridged open.

## Testing

- **Existing tests to run**: `packages/ui/src/components/NetworkSettingsPanel.test.tsx`, `RadioAddressDialog.test.tsx`, `CalibrationPage.test.tsx`, `AppHeader.test.tsx`, `packages/host/src/server.test.ts`, `packages/host/src/radioOverride.test.ts`
- **New tests to write**: panel Save sends override / does not when unchanged; panel resync on prop change; revert button visibility and message in both components; server test set-then-clear snapshot `radio.source`.
- **Verification command**: `npm test` and `npm run typecheck`
