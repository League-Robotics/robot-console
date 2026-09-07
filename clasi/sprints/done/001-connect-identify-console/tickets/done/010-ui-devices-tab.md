---
id: '010'
title: 'ui: Devices tab'
status: done
use-cases:
- SUC-001
depends-on:
- 009
github-issue: ''
issue: robot-console-architecture-and-roadmap.md
completes_issue: false
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# ui: Devices tab

## Description

Build the Devices tab in `packages/ui`, per `sprint.md`'s Architecture
and Success Criteria: a live list of attached devices showing, per
device, the five-letter friendly name, role (relay/robot), port, and
UID (USB serial number). Connects to `server.ts` (ticket 009) over its
one WebSocket, listens for `type: 'devices'` messages, and re-renders on
each update — no polling, no manual refresh needed when a device is
plugged in or removed.

Per `sprint.md`'s Architecture Step 7 (Open Question 3) and this
sprint's Scope, build only what SUC-001 needs. Do not add flash buttons,
calibration entry points, or any other control surface for a future
sprint's feature — those are out of scope here and their absence is a
deliberate scope decision, not an oversight.

Per `docs/design/overview.md`, the audience is students and instructors
with no assumed command-line/firmware background — favor plain labels
(e.g. "Name", "Role", "Port", "Device ID" rather than raw wire-protocol
terminology) over exposing internal field names verbatim.

Devices for which `swdName.ts` failed to produce a name (per ticket
007's detected-but-unnamed error path) must still appear in the list,
visibly flagged as unnamed/error rather than omitted — per UC-001's
error flow.

## Acceptance Criteria

- [x] The Devices tab renders one row/card per attached device, showing
      name, role, port, and UID.
- [x] The list updates live over the WebSocket connection when a device
      is attached or detached — no manual refresh required.
- [x] A device that failed SWD naming (per ticket 007) is shown in the
      list flagged as unnamed/error, not omitted.
- [x] A device that never received a `HELLO` reply is shown as
      unresponsive rather than assigned a role.
- [x] Labels are plain-language, appropriate for an audience with no
      assumed command-line/protocol background.
- [x] No flash, calibration, or other future-sprint control is present
      on this tab.
- [x] Manually verified: with a real relay and a real robot attached,
      both appear with correct name/role/port/UID; unplugging one
      removes it from the list live. **Partially verified** — see
      report: real host+board data confirmed end-to-end over a live
      WebSocket connection and the built bundle serves correctly, but
      only one board was available (no relay) and no browser
      automation tool was available in this environment to visually
      confirm rendering/hotplug in an actual browser window. The exact
      real payload was captured and is asserted against directly in
      `DevicesTab.test.tsx`.

## Testing

- **Existing tests to run**: `npm test` (protocol/host suites continue
  passing).
- **New tests to write**: component-level tests (e.g. React Testing
  Library, if that is the chosen test approach for `packages/ui` —
  implementer's choice consistent with the Vite/React scaffold from
  ticket 001) rendering the Devices tab against fake `type: 'devices'`
  WebSocket messages, covering: normal device row rendering, the
  unnamed/error flag, and the unresponsive-device case. Real end-to-end
  rendering against a live host is verified manually, not via `npm
  test`.
- **Verification command**: `npm test -- packages/ui`; manual smoke
  test with real hardware and a browser.

## Implementation Plan

**Approach**:
1. Establish the WebSocket client connection (likely shared with the
   Console tab, ticket 011 — coordinate on a single connection/context
   both tabs consume, rather than each tab opening its own).
2. Implement a Devices-tab component subscribing to `type: 'devices'`
   messages and rendering the current device list.
3. Implement the unnamed/error and unresponsive visual states.
4. Style plainly per the target audience (no raw protocol jargon in
   visible labels).
5. Manually verify against real hardware.

**Files to create**:
- `packages/ui/src/components/DevicesTab.tsx` (or equivalent, per the
  project's chosen component structure)
- `packages/ui/src/components/DevicesTab.test.tsx`
- A shared WebSocket client/context module, if not already established
  by whichever of tickets 010/011 lands first (coordinate to avoid
  duplicating the connection logic).

**Files to modify**:
- `packages/ui/src/App.tsx` (or equivalent) to add the Devices tab to
  the UI's tab structure.

**Testing plan**: component tests against faked WebSocket messages;
manual hardware smoke test.

**Documentation updates**: none required beyond in-code comments on the
shared WebSocket message shape, if not already covered by ticket 009.
