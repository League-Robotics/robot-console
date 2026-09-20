---
id: "003"
title: "Dock shell: collapse and toggle chrome with persisted open state"
status: open
use-cases: ["SUC-001"]
depends-on: ["002"]
github-issue: ""
issue: ""
# completes_issue: Controls whether linked issues are archived when this ticket
# is moved to done. Default: true (archive when all referencing tickets are done).
# Set to false (scalar) to suppress archival for ALL linked issues on this ticket.
# Set to a mapping {filename.md: false} to suppress archival per issue filename.
# Use false for tickets that partially address a multi-sprint umbrella issue.
completes_issue: true
# exception: Written by a lower agent when it cannot proceed (see architecture §exception-protocol).
# exception:
#   thrown_by: "programmer"          # "programmer" | "sprint-planner"
#   thrown_at: "2026-05-07T14:23:00Z"
#   attempted: |
#     Description of what was attempted before giving up.
#   conflict: "architecture-update.md §3 — reason the agent is blocked"
#   surface: "internal"              # "user-visible" | "internal"
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Dock shell: collapse and toggle chrome with persisted open state

## Description

Give `ConsoleDock` (ticket 002) real dock chrome: a full-width bar
labelled "Debug Console" pinned to the bottom of the device page, with
a toggle control. Collapsed is the state with no log content visible —
just the bar. Toggling open reveals about 10 lines of console (the
existing `DeviceConsole`/`CommandStrip` content from ticket 002) at a
sensible default height; toggling again collapses it. The bar itself
never disappears once a device page with a link is showing (only `/`
has no dock at all, per sprint.md's Scope — unaffected by this ticket
since `DevicePage` already gates the mount on `hasSnapshot && link`).

Per sprint.md's Design Rationale, the dock takes layout space at the
bottom of `DevicePage`'s own render (a flex column: page content above,
`ConsoleDock` below) rather than a `position: fixed` overlay — several
pages have their own bottom-of-column controls (Copy buttons, "Start
over", `PathTracePanel`) that an overlay would cover whenever the dock
is open. Wrap `DevicePage`'s render in this flex container; `App.tsx`/
`main.tsx`/`FrontPage.tsx` need no change (they're outside
`DevicePage`'s subtree).

Persist open/collapsed state to `localStorage` under one fixed key
(e.g. `robot-console:console-dock`), with **collapsed as the fallback
only when nothing is stored yet** — not on every load. Per sprint.md's
Design Rationale, this satisfies "collapsed by default" literally for
a first-ever visit while not discarding a student's deliberate choice
to keep it open across a session.

Also add the collapsed bar's quiet indicator: per sprint.md's Design
Rationale, source it from the existing `useLinkNotices()` mechanism
(already used by `FrontPage` for the same "worth surfacing" purpose),
filtered to the active link, shown only for `warn`/`error` level —
never a numeric `seq`/`pending` badge, which the stakeholder called out
as visual noise on the current calibration screen.

## Acceptance Criteria

- [ ] A full-width bar labelled "Debug Console" is always present at
      the bottom of any device page that has a link (per ticket 002's
      mount condition), with a toggle control.
- [ ] Collapsed state shows no log content, no toolbar, no send box —
      just the bar (and the quiet indicator, when applicable).
- [ ] Toggling open reveals the ticket-002 content (log, toolbar,
      `SequencingIndicator`, send box, `CommandStrip`) at a sensible
      default height (~10 lines).
- [ ] Toggling closed returns to the collapsed bar without unmounting
      the page content above it (page content reflows, not the dock
      overlaying it).
- [ ] Open/collapsed state persists to `localStorage` and is restored
      on reload; a fresh/cleared browser defaults to collapsed.
- [ ] The collapsed bar shows a small indicator only when the active
      link has a `warn`/`error`-level `LinkNotice`; otherwise the bar
      shows no indicator at all.
- [ ] No dock (not even collapsed) renders on `/` (confirmed by a
      `FrontPage.test.tsx` assertion that no dock-related test id is
      present).

## Implementation Plan

**Approach**: Add collapse/toggle state and persistence to the
`ConsoleDock` built in ticket 002; wrap `DevicePage`'s render in the
flex layout described above. Keep the localStorage read/write isolated
in its own small module (`useDockPersistence.ts`) so `ConsoleDock`
itself doesn't need to know about storage mechanics — this also makes
it trivial to fake/reset in tests.

**Files to create**:
- `packages/ui/src/components/console-dock/useDockPersistence.ts` —
  `{ open: boolean; heightPx: number }` get/set, collapsed-fallback
  only when unset.
- `packages/ui/src/components/console-dock/useDockPersistence.test.ts`

**Files to modify**:
- `packages/ui/src/components/console-dock/ConsoleDock.tsx` — add
  collapsed bar, toggle, `useDockPersistence` wiring, quiet indicator
  (via `useLinkNotices()`).
- `packages/ui/src/components/console-dock/ConsoleDock.css` — bar
  styling, collapsed vs. open layout.
- `packages/ui/src/components/console-dock/ConsoleDock.test.tsx` —
  toggle behavior, persistence, quiet-indicator cases.
- `packages/ui/src/pages/DevicePage.tsx` — wrap render in the flex
  column layout.
- `packages/ui/src/pages/DevicePage.test.tsx` / `FrontPage.test.tsx` —
  assert no-dock-on-`/`, dock-reflows-not-overlays.

**Testing plan**: `npm test -- console-dock DevicePage FrontPage` from
`packages/ui`, foreground. Live-browser check that toggling doesn't
cover the Copy button on the Configuration tab.

**Documentation updates**: None.

## Testing

- **Existing tests to run**: `npm test -- DevicePage FrontPage` from
  `packages/ui`.
- **New tests to write**: `useDockPersistence.test.ts`;
  `ConsoleDock.test.tsx` toggle/persistence/indicator cases.
- **Verification command**: `npm test -- console-dock DevicePage
  FrontPage` (run from `packages/ui`).
