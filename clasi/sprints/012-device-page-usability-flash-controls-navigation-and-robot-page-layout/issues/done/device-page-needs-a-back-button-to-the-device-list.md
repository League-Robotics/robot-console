---
status: done
sprint: '012'
tickets:
- 012-004
---

# The device page needs a back button to the device list

## Description

Navigating into an individual micro:bit from the front-page list is a
one-way trip. Once on `/d/:endpointId` there is no visible affordance
to get back to `/` — the student has to use the browser's back button
or edit the URL.

Reported by the stakeholder from hands-on use.

## What's actually there today

The "back to devices" link exists, but only on the one branch nobody
wants to land on. [DevicePage.tsx:57-68](packages/ui/src/pages/DevicePage.tsx#L57-L68)
renders `<Link to="/" className="device-page-back">Back to devices</Link>`
in the `hasSnapshot && !endpoint` dead-end state — the deliberate
"this device isn't connected, here's a way out" case from sprint 007's
SUC-001 alternate flow.

The three *successful* branches have no back link at all. Confirmed by
grep: none of [RelayPage.tsx](packages/ui/src/pages/RelayPage.tsx),
[RobotPage.tsx](packages/ui/src/pages/RobotPage.tsx), or
[UnknownDevicePage.tsx](packages/ui/src/pages/UnknownDevicePage.tsx)
imports `Link` or renders a route back to `/`. (`UnknownDevicePage`
imports `useNavigate`, but that's its post-flash navigation, not a back
affordance.)

The `!hasSnapshot` "Looking for this device…" branch
([DevicePage.tsx:47-55](packages/ui/src/pages/DevicePage.tsx#L47-L55))
also has no way out, which matters if the socket never delivers a
snapshot — the student is stuck on a spinner with no exit.

So the gap is: **every device-page state except the not-connected one.**

## Suggested direction

Rather than adding a `Link` to each of the three per-type pages
independently, put the back affordance somewhere all of them inherit
it. Two candidates:

1. **A route-aware app header.** [App.tsx:23-25](packages/ui/src/App.tsx#L23-L25)
   already renders a persistent `<header className="app-header">` above
   `<AppRoutes />`. A back control there, shown when the current route
   isn't `/`, covers all four device-page states plus any future nested
   route (`/d/:endpointId/console`, which `router.tsx`'s doc comment
   anticipates) for free.
2. **A shared device-page chrome component** wrapping the switch in
   `DevicePage`, so the back link renders once around whichever
   per-type page is dispatched.

Option 1 is likely the better fit — it also fixes the `!hasSnapshot`
branch without touching it, and keeps the affordance in a stable screen
position as the student moves between device types.

Whichever route is taken, it should reuse the existing
`.device-page-back` styling (or supersede it) rather than introducing a
second visual treatment for the same action, and the existing
not-connected link should be reconciled so there aren't two back
buttons on that one state.

## Acceptance sketch

- From a connected relay, robot, or unknown device page, a visible
  control returns to the device list at `/`.
- The control is reachable by keyboard and has an accessible name
  (it's a navigation link, not an icon-only button with no label).
- The `!hasSnapshot` "Looking for this device…" state also offers a way
  back.
- The not-connected state does not end up with two competing back
  controls.
- Tests: the existing page test files
  ([DevicePage.test.tsx](packages/ui/src/pages/DevicePage.test.tsx),
  [RelayPage.test.tsx](packages/ui/src/pages/RelayPage.test.tsx),
  [RobotPage.test.tsx](packages/ui/src/pages/RobotPage.test.tsx),
  [UnknownDevicePage.test.tsx](packages/ui/src/pages/UnknownDevicePage.test.tsx))
  already render through `renderWithRouter`, so asserting the back link
  per state is cheap.
