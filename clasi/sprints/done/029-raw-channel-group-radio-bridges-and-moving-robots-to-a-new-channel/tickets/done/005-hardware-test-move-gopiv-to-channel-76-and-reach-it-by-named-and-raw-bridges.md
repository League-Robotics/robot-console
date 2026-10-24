---
id: '005'
title: 'Hardware test: move gopiv to channel 76 and reach it by named and raw bridges'
status: done
use-cases:
- SUC-001
- SUC-002
- SUC-003
- SUC-004
- SUC-005
depends-on:
- '001'
- '002'
- '003'
- '004'
github-issue: ''
issue:
- connect-a-radio-bridge-to-a-raw-channel-and-group.md
- verify-moving-a-robot-to-a-new-radio-channel.md
completes_issue: true
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Hardware test: move gopiv to channel 76 and reach it by named and raw bridges

## Description

Interactive hardware test run by the team lead through the robot-console MCP: gopiv bridged through guvov on ferranti (reach: ssh ansible@ferranti, tunnel 22015). Short, camera-safe actions only. Reflashing gopiv with the new channel may need physical steps by the stakeholder; stop and ask rather than proceed blind. Channel 76 (2476 MHz) avoids Wi-Fi; the group is the stakeholder's choice (open question) or gopiv's derived group.

## Acceptance Criteria

- [x] Baseline recorded: STATUS loss on the derived channel 12 is ~24% (use the 2026-10-23 figure or re-measure).
- [x] Override set to channel 76 and group g on gopiv (via header dialog and/or Calibration Save); snapshot shows `radio.source: "override"` with 76/g, and both UIs show the same values.
- [x] Generated code block shows `diffDrive.setupRadio(76, g)`.
- [x] gopiv reflashed with that code (stakeholder assists if physical steps are needed).
- [x] A named bridge to gopiv through guvov connects on channel 76/group g (`get_device_status` shows the address).
- [x] A raw channel 76/group g bridge via MCP `open_session` connects as `radio-ch76-g<g>-via-guvov`; the same from the UI picker.
- [x] A raw bridge to a channel where nothing answers (e.g. 40/200) fails with the plain no-answer message and does not hang.
- [x] STATUS loss on channel 76 measured over a comparable idle window and compared with the ~24% baseline on channel 12; result written into the ticket.
- [x] Override cleared; code block and bridge address revert to the derived channel 12 pair; gopiv reflashed back or left on 76 per the stakeholder.
- [x] Any defects found are filed as issues or fixed with a follow-up ticket before sprint close.

## Testing

- **Existing tests to run**: full `npm test` green before starting.
- **New tests to write**: none (manual hardware test); record results in this ticket.
- **Verification command**: results documented in the ticket; MCP `get_device_status` / `list_devices` outputs captured.

## Results (2026-10-24, ferranti, robot-console 0.20261016.1-29/-30 built from this branch)

gopiv bridged through guvov (`mbregistry-…52f41cc6…`, ferranti `/dev/ttyACM0`). Group kept at gopiv's derived 30.

| Check | Result |
|---|---|
| Baseline, named bridge on ch12/g30 | 40/50 STATUS answered, **20% lost** |
| Raw bridge ch12/g30 via MCP (before reflash) | connected as `radio-ch12-g30-via-…`, attached to gopiv |
| Calibration panel Save 76/30 | host `radio = {76, 30, override}`; code block `diffDrive.setupRadio(76, 30)`; header dialog shows 76/30 |
| Reflash | template program with the code block's `setupRadio(76, 30)`, built `--robot gopiv`, flashed with mbdeploy on ferranti (console stopped during flash) |
| gopiv STATUS | `channel=76 group=30` |
| Named bridge after reflash | connected, label `Radio · ch76/grp30` |
| STATUS loss on ch76 | 50/50, then 100/100 after reinstall: **0% lost** over 150 queries |
| Raw bridge ch76/g30 via MCP | connected as `radio-ch76-g30-via-…`, attached to gopiv |
| Raw bridge ch76/g30 via UI picker | "Connected to gopiv via guvov on channel 76, group 30" |
| Raw bridge ch12/g30 after the move (nothing answers) | link `failed` (no banner within identify budget) in seconds; UI shows "no radio reply — is the robot on and in range?" |
| Revert to derived (header dialog) | host `{12, 30, derived}`, Revert button hidden; then re-set to 76/30 to match the flashed robot |

gopiv is left flashed on 76/30 with a matching 76/30 override.

### Defects found

- **Header Set Radio dialog discarded typed input** whenever a snapshot re-broadcast arrived (effect keyed on the `radio` object identity). Pre-existing on main. Fixed in 510558f with a regression test; verified on ferranti with -30.
- **UI typecheck regression from ticket 001**: `wsMessages.ts` imported `radioOverride.ts`, pulling the store into the UI build so `npm run build` / the .deb failed. Fixed in f6a40ea.
- **Relay Switch fails with "in use"** on an mbregistry relay, for raw and named switches alike; pre-existing. Filed as `clasi/issues/relay-switch-fails-with-in-use-on-an-mbregistry-relay.md`.
- Note: a fresh mbregistry USB link to gopiv kept re-grabbing the board's serial lock after `close_session` (identify retry), which blocks `mbdeploy`; worked around by stopping the console for the flash. Covered by the existing `mbregistry-flash-races-the-consoles-own-session-close.md`.
