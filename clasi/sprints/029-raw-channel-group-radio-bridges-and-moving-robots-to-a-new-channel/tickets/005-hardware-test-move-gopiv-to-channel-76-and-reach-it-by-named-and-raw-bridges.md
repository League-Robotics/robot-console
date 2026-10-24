---
id: '005'
title: 'Hardware test: move gopiv to channel 76 and reach it by named and raw bridges'
status: open
use-cases: [SUC-001, SUC-002, SUC-003, SUC-004, SUC-005]
depends-on: ["001", "002", "003", "004"]
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

- [ ] Baseline recorded: STATUS loss on the derived channel 12 is ~24% (use the 2026-10-23 figure or re-measure).
- [ ] Override set to channel 76 and group g on gopiv (via header dialog and/or Calibration Save); snapshot shows `radio.source: "override"` with 76/g, and both UIs show the same values.
- [ ] Generated code block shows `diffDrive.setupRadio(76, g)`.
- [ ] gopiv reflashed with that code (stakeholder assists if physical steps are needed).
- [ ] A named bridge to gopiv through guvov connects on channel 76/group g (`get_device_status` shows the address).
- [ ] A raw channel 76/group g bridge via MCP `open_session` connects as `radio-ch76-g<g>-via-guvov`; the same from the UI picker.
- [ ] A raw bridge to a channel where nothing answers (e.g. 40/200) fails with the plain no-answer message and does not hang.
- [ ] STATUS loss on channel 76 measured over a comparable idle window and compared with the ~24% baseline on channel 12; result written into the ticket.
- [ ] Override cleared; code block and bridge address revert to the derived channel 12 pair; gopiv reflashed back or left on 76 per the stakeholder.
- [ ] Any defects found are filed as issues or fixed with a follow-up ticket before sprint close.

## Testing

- **Existing tests to run**: full `npm test` green before starting.
- **New tests to write**: none (manual hardware test); record results in this ticket.
- **Verification command**: results documented in the ticket; MCP `get_device_status` / `list_devices` outputs captured.
