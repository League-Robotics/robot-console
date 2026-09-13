---
status: done
sprint: '017'
tickets:
- 017-011
---

# Robot page must say which connection it is using

## Description

The robot screen is per link (`/d/<linkId>`), but nothing on it tells
the student which connection they are on. `AppHeader` renders only the
robot's name; `RobotPage` is deliberately transport-blind. When a robot
has several links (gopiv: mbserial via loki, WiFi, radio via torture)
the student cannot tell whether they are driving over mbserial, WiFi,
USB, or a relay, nor whether that link is connected, connecting, or
unresponsive. Stakeholder request from the sprint 017 bench, 2026-09-12.

## Proposed resolution

- `AppHeader` shows, under the name, the active link's host-built
  `label` (e.g. "USB · /dev/cu.usbmodem2121102", "mbserial · loki.local",
  "Radio · ch47/grp60 (via relay torture)") and its state via
  `linkStateText(link)`; reuse `FrontPage`'s `connectionLabel` by moving
  it into `deviceDisplay.ts`.
- If the same device has other links, the header offers a compact
  "switch connection" list linking to `/d/<otherLinkId>` (no host
  policy in the client; navigation only).
- `RobotPage.transportBlind.test.ts` stays untouched: the transport text
  lives in the header, not the page body.

## Acceptance

- Opening gopiv's mbserial link shows "mbserial · loki.local · Linked";
  opening a radio link shows the relay name; state text updates live.
- FakeSocket tests for the header cover USB, mbserial, and via-relay.

## Depends on

Sprint 015 snapshot contract. Small; fits sprint 017.
