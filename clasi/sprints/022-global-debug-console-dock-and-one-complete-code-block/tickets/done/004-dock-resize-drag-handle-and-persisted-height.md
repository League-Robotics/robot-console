---
id: '004'
title: 'Dock resize: drag handle and persisted height'
status: done
use-cases:
- SUC-002
depends-on:
- '003'
github-issue: ''
issue: ''
completes_issue: true
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Dock resize: drag handle and persisted height

## Description

Add a resize handle at the top edge of the open `ConsoleDock` (ticket
003) that lets the student drag it taller or shorter. The dock stays
pinned to the bottom and full width throughout the drag — only its
height changes. Persist the chosen height via the same
`useDockPersistence` module ticket 003 introduced (it already carries
`heightPx` in its stored shape; this ticket is the first to actually
change it from a pointer drag rather than a code default).

Pick reasonable min/max bounds (e.g. a minimum tall enough for the
send box plus a couple of log lines, a maximum that leaves the page
content above it at least some minimum usable height) — the exact
numbers are an implementation judgment call, not a stakeholder-specified
value; document the chosen bounds and why in a code comment.

## Acceptance Criteria

- [x] A visible, grabbable handle sits at the top edge of the open
      dock only (not shown when collapsed).
- [x] Dragging the handle up/down changes the dock's height live,
      while it remains pinned to the bottom and full width.
- [x] The height is clamped to a documented min/max range.
- [x] The chosen height persists to `localStorage` (via
      `useDockPersistence`) and is restored on the next page load,
      while the dock is open.
- [x] Collapsing and reopening the dock within the same session
      preserves the last chosen height (doesn't reset to a default).
- [x] Resize works via mouse drag; keyboard/touch resize is not
      required for this ticket (note this as a documented limitation
      if not implemented, rather than silently absent).

## Implementation Plan

**Approach**: A `pointerdown`/`pointermove`/`pointerup` drag handler on
a thin handle element at the top of the open pane, updating a local
`heightPx` state during the drag (for live feedback) and writing the
final value to `useDockPersistence` on `pointerup`. Avoid writing to
`localStorage` on every `pointermove` (needless churn); write once per
drag gesture.

**Files to modify**:
- `packages/ui/src/components/console-dock/ConsoleDock.tsx` — resize
  handle, drag state, min/max clamping.
- `packages/ui/src/components/console-dock/ConsoleDock.css` — handle
  styling/cursor.
- `packages/ui/src/components/console-dock/ConsoleDock.test.tsx` —
  simulate a drag (via pointer events) and assert height changes and
  persistence; assert clamping at the bounds.

**Testing plan**: `npm test -- console-dock` from `packages/ui`,
foreground. Live-browser check that resizing doesn't fight with page
scroll or with a mobile/narrow-viewport layout (this app is desktop-
oriented per its existing tabs, but confirm nothing breaks at a
smaller width).

**Documentation updates**: None.

## Testing

- **Existing tests to run**: `npm test -- console-dock` from
  `packages/ui`.
- **New tests to write**: drag-to-resize, clamping, and
  persistence-of-height cases in `ConsoleDock.test.tsx`.
- **Verification command**: `npm test -- console-dock` (run from
  `packages/ui`).
