---
id: '002'
title: Extract console rendering into a dockable ConsoleDock component
status: done
use-cases:
- SUC-001
depends-on: []
github-issue: ''
issue: ''
completes_issue: true
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Extract console rendering into a dockable ConsoleDock component

## Description

This is the foundational ticket for the console dock (sprint.md
Architecture §Step 3, module 1). Build `ConsoleDock.tsx` in a new
`packages/ui/src/components/console-dock/` module: it takes
`{ link: SnapshotLink; name: string }` — "the device currently active
for console purposes" — and renders the existing `DeviceConsole` (log,
toolbar, `SequencingIndicator`, send box) and `CommandStrip`
(HELLO/ID/VER/STATUS/FUNCS, GET/SET) inside it, unchanged. Mount
exactly one `ConsoleDock` from `DevicePage.tsx`, fed by the route's own
`link`/`device` (via `useLink`/`useDeviceForLink`, which `DevicePage`
already computes).

This ticket is deliberately scoped to *relocation only* — no
collapse/toggle UI (ticket 003), no resize (004), no pop-out (005), no
route-driven retargeting/teardown (006). For this ticket, render
`ConsoleDock` always-open, at a fixed default height, with no toggle
control at all. Per sprint.md's Migration Concerns, this means the
running app will show **both** the new dock and the existing per-tab
consoles at once for the next several tickets — that's intentional
incremental delivery (verify the dock live before deleting the old
mounts in ticket 007), not a bug to fix here.

Do **not** yet touch the "active console target" concept (relay
bridging, sprint.md Architecture §Step 3 module 4) — that's ticket
006's job. For this ticket, `DevicePage`'s own route-derived
`link`/`device` is sufficient (it will be visibly wrong for a
bridged-relay child until ticket 006 lands; note this in a code
comment so it isn't mistaken for an oversight).

Do **not** yet delete `ConsolePane.tsx` or any existing per-tab mount
— that's ticket 007.

## Acceptance Criteria

- [x] `packages/ui/src/components/console-dock/ConsoleDock.tsx` exists,
      takes `{ link, name }`, and renders `DeviceConsole` + `CommandStrip`
      unchanged (same props each already takes today).
- [x] `DevicePage.tsx` mounts exactly one `ConsoleDock`, fed by its own
      `useLink(linkId)`/`useDeviceForLink(linkId)` results, only when
      `hasSnapshot && link` (the same condition under which it already
      dispatches to `RobotPage`/`RelayPage`/`UnknownDevicePage`).
- [x] No existing per-tab `ConsolePane` mount is removed in this ticket
      — `RobotPage`, `RelayPage`, `UnknownDevicePage`, `DriveTab`,
      `CalibrationPage`, `ConfigurationPage` are all unchanged.
- [x] `DeviceConsole`, `CommandStrip`, `SequencingIndicator` are
      unmodified (confirmed by their existing test suites passing
      unchanged).
- [x] A code comment on `DevicePage.tsx`'s `ConsoleDock` mount explains
      that relay-bridging retargeting is deliberately deferred to a
      later ticket (avoids the change looking incomplete to the next
      reader).

## Implementation Plan

**Approach**: Add the new module and one new mount site; touch nothing
that already exists. This keeps the ticket's diff reviewable and its
test surface small — it's purely additive.

**Files to create**:
- `packages/ui/src/components/console-dock/ConsoleDock.tsx`
- `packages/ui/src/components/console-dock/ConsoleDock.css` (basic
  fixed-height, full-width layout for now; refined in later tickets)
- `packages/ui/src/components/console-dock/ConsoleDock.test.tsx`

**Files to modify**:
- `packages/ui/src/pages/DevicePage.tsx` — add the `ConsoleDock` mount.
- `packages/ui/src/pages/DevicePage.test.tsx` — add a test asserting
  the dock renders alongside the dispatched page content.

**Testing plan**: `npm test -- console-dock DevicePage` from
`packages/ui`, foreground. Confirm in a live browser (per this
project's practice) that the new dock appears below the existing
per-tab console without disturbing it, on the Main tab of a connected
robot.

**Documentation updates**: None beyond the code comment called out in
Acceptance Criteria.

## Testing

- **Existing tests to run**: `npm test -- DevicePage DeviceConsole
  CommandStrip` from `packages/ui`.
- **New tests to write**: `console-dock/ConsoleDock.test.tsx` (renders
  `DeviceConsole`/`CommandStrip` for a given link); `DevicePage.test.tsx`
  addition asserting the dock is present.
- **Verification command**: `npm test -- console-dock DevicePage` (run
  from `packages/ui`).
