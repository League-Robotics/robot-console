---
id: '006'
title: 'Route-driven dock and popup lifecycle: close, retarget, and restore'
status: done
use-cases:
- SUC-004
depends-on:
- '005'
github-issue: ''
issue: ''
completes_issue: true
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Route-driven dock and popup lifecycle: close, retarget, and restore

## Description

Wire up the "active console target" concept from sprint.md's
Architecture §Step 3, module 4. Today (after tickets 002-005),
`DevicePage` feeds `ConsoleDock`/`PopupConsoleWindow` its own
route-derived `link`/`device` directly. That's wrong in one specific,
verified case: when a robot is bridged through a relay,
`RelayPage.tsx` substitutes `<RobotPage device={child.device}
link={child.link} />` for its own content, but the URL and
`DevicePage`'s own `useLink(linkId)`/`useDeviceForLink(linkId)` still
resolve to the *relay's* link, not the bridged child's. The
stakeholder was explicit that the popup should always show "whatever
device is on the main screen" — so the dock/popup must follow the
*displayed* device, which diverges from the *routed* device exactly in
this bridging case.

Introduce `activeTarget: { link: SnapshotLink; name: string }` state
in `DevicePage.tsx`, seeded from its own route-derived link/device.
Thread an `onActiveTargetChange` callback down to whichever child
`DevicePage` renders. `RobotPage`/`UnknownDevicePage` call it once with
their own `link`/`name` (a no-op relative to the route default, added
for a uniform mechanism everywhere). `RelayPage` calls it with the
bridged child's link/name while bridging, and with its own relay
link/name once the child disconnects. `ConsoleDock`/`PopupConsoleWindow`
only ever see `activeTarget` — neither needs to know a relay is
involved.

This same mechanism covers three behaviors at once, because they're
all just `activeTarget` changing identity while `DevicePage` stays
mounted, versus `DevicePage` unmounting entirely:

- **Tab switches within one device** — no `activeTarget` change, no
  effect (already true from ticket 002 onward).
- **Switching to a different device** (`/d/:linkId` → `/d/:otherLinkId`)
  — `DevicePage` doesn't remount (React Router keeps the same route
  element across a param-only change), so `activeTarget` updates via
  the effect below; `PopupConsoleWindow` re-renders its portal content
  for the new target **without calling `window.open` again** — per
  sprint.md's Design Rationale, the window object itself doesn't need
  to change, only what's portaled into it, and re-opening would refight
  the user-gesture requirement for no benefit.
- **Navigating to `/`** — `DevicePage` unmounts entirely (a different
  route element), which is what triggers `ConsoleDock`'s/
  `PopupConsoleWindow`'s own unmount cleanup effect to close an open
  popup. No separate "am I still on a device page" check is needed.
- **Relay bridging/unbridging** — `activeTarget` changes via
  `RelayPage`'s own callback call, with no route change at all.

**Note the one thing this ticket does *not* resolve on its own
authority**: which behavior is correct for the relay-bridging case is
a real design decision the stakeholder's brief didn't cover (he
discussed FrontPage-navigation and direct-device-switch explicitly,
not bridging). This ticket implements "retarget to the bridged child,"
matching the sprint.md Design Rationale's stated choice, but that
choice is flagged in sprint.md's Open Questions for stakeholder
confirmation — do not treat this ticket's acceptance criteria as
foreclosing a change here if the stakeholder says otherwise after
seeing it live.

## Acceptance Criteria

- [x] `DevicePage.tsx` holds `activeTarget` state and an
      `onActiveTargetChange` callback threaded to its dispatched child.
- [x] `RobotPage`, `UnknownDevicePage` call `onActiveTargetChange` with
      their own `link`/`name`.
- [x] `RelayPage` calls `onActiveTargetChange` with the bridged child's
      `link`/`name` while a child is bridged, and with its own relay
      `link`/`name` when idle.
- [x] `ConsoleDock`/`PopupConsoleWindow` are fed `activeTarget`, not
      `DevicePage`'s own raw route-derived link/device.
- [x] Tabbing within one device (Main → Drive → Calibration →
      Configuration) never closes an open popup or resets dock state.
- [x] Switching the routed device (`/d/:linkId` → `/d/:otherLinkId`)
      retargets an open popup's content in place — same `Window`
      object (assert `openPopupWindow`/`window.open` is not called a
      second time), new portaled content.
- [x] Navigating to `/` closes any open popup (verified via the fake
      `popupWindow.ts` seam) and unmounts the dock entirely.
- [x] Bridging a child robot through a relay retargets the dock/popup
      to the child's link; unbridging reverts to the relay's own link
      — both without any route change.

## Implementation Plan

**Approach**: This is wiring, not new mechanism — tickets 002-005
already built everything `activeTarget` needs to drive. The work is
threading the callback correctly through `DevicePage`'s existing
three-way dispatch and `RelayPage`'s existing bridged/idle branching,
and adding the retarget-vs-close distinction to
`PopupConsoleWindow`'s own effect (already has open/close logic from
ticket 005; this ticket adds "re-render content in place" as a third
case, driven by `activeTarget` identity changing while the popup
`Window` itself stays the same).

**Files to modify**:
- `packages/ui/src/pages/DevicePage.tsx` — `activeTarget` state,
  `onActiveTargetChange` prop threaded to children.
- `packages/ui/src/pages/RobotPage.tsx` — call
  `onActiveTargetChange(link, name)` once.
- `packages/ui/src/pages/UnknownDevicePage.tsx` — same.
- `packages/ui/src/pages/RelayPage.tsx` — call
  `onActiveTargetChange` with either its own link or the bridged
  child's, matching its existing bridged/idle branching.
- `packages/ui/src/components/console-dock/ConsoleDock.tsx` — accept
  `activeTarget` instead of a raw `link`/`name` pair (or keep the same
  prop shape if `activeTarget`'s shape already matches — reconcile
  with tickets 002/003's existing prop naming rather than introducing
  a second name for the same thing).
- `packages/ui/src/components/console-dock/PopupConsoleWindow.tsx` —
  re-render portaled content on `activeTarget` change without
  reopening the window; close on unmount (already partly covered by
  ticket 005's cleanup, now driven by `DevicePage` unmounting instead
  of `ConsoleDock` unmounting, if that distinction matters given where
  `PopupConsoleWindow` is actually mounted).
- `packages/ui/src/pages/DevicePage.test.tsx` — retarget-on-switch,
  close-on-`/` tests.
- `packages/ui/src/pages/RelayPage.test.tsx` — bridging/unbridging
  retarget tests.

**Testing plan**: `npm test -- DevicePage RelayPage RobotPage
UnknownDevicePage console-dock` from `packages/ui`, foreground. This
is the ticket most worth a deliberate live-browser walkthrough (per
project memory on verifying in a real browser): open the popup on a
robot, switch to a different robot via the front page cards, confirm
retarget; bridge a relay to a robot with the popup open, confirm it
follows the child; navigate to `/`, confirm the popup closes.

**Documentation updates**: None beyond sprint.md's own Open Questions
entry (already present) — no separate `docs/design/` change, since
this is UI-only per sprint.md's Architecture Migration Concerns.

## Testing

- **Existing tests to run**: `npm test -- DevicePage RelayPage
  RobotPage UnknownDevicePage` from `packages/ui`.
- **New tests to write**: retarget-without-reopen assertion in
  `PopupConsoleWindow.test.tsx` or `DevicePage.test.tsx`; close-on-`/`
  assertion; relay bridging/unbridging retarget assertions in
  `RelayPage.test.tsx`.
- **Verification command**: `npm test -- DevicePage RelayPage
  RobotPage UnknownDevicePage console-dock` (run from `packages/ui`),
  plus a live Chromium walkthrough of the three transition cases
  above.
