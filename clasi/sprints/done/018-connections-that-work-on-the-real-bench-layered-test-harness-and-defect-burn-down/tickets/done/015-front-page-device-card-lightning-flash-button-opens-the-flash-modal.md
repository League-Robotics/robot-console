---
id: '015'
title: 'Front-page device card: lightning Flash button opens the flash modal'
status: done
use-cases: []
depends-on:
- '013'
- '014'
github-issue: ''
issue: ''
completes_issue: true
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Front-page device card: lightning Flash button opens the flash modal

## Description

Stakeholder request (2026-09-13, verbatim intent): "Make the flash
button pop up when the device is on USB. We used to have it where it
would pop up a modal, and then I could flash the RADIORELAY, the
calibration software, or some other micro:bit hex file. The flash
button shows up below the open arrow; the open arrow is in the upper
corner, the flash button in the lower right. It's just a lightning
icon that pops up a modal, and that's how you flash it."

The modal itself already exists and is not being rebuilt:
`packages/ui/src/components/FlashDialog.tsx` wraps
`FlashControls.tsx` (relay firmware, robot/calibration firmware, local
`.hex` upload) and already accepts an overridable trigger
label/class. The gap is on the front page: `DeviceCard` in
`packages/ui/src/pages/FrontPage.tsx` has an "open" arrow in the
upper-right corner but no per-card flash entry point, except the
unassigned-board card, which currently has a plain text "Flash"
button instead of the lightning icon. This ticket wires a lightning
icon button into every device card that has a current `usb` link, in
the lower-right corner directly below the open arrow, and normalizes
the unassigned-board card's existing text button to the same icon.

## Acceptance Criteria

- [x] Every front-page device card (robots and radio bridges,
      `packages/ui/src/pages/FrontPage.tsx` `DeviceCard`) whose device
      has a current `usb` link shows a lightning-icon button in the
      card's lower-right corner, directly below the open arrow (which
      sits in the upper-right corner); the icon button has an
      accessible label "Flash <name>" and a tooltip.
- [x] Clicking it opens the existing `FlashDialog` modal for that usb
      link, offering Radio relay firmware, Robot (calibration)
      firmware, and a local .hex file, with progress and result shown
      in the modal.
- [x] No lightning button on cards with no USB link; no layout shift
      for those cards (the arrow stays upper-right).
- [x] The unassigned-board card's existing text "Flash" button becomes
      the same lightning icon in the same position.
- [x] **Unit tests**: icon present only when a usb link exists; clicking
      it opens the modal with the three sources (relay, robot/
      calibration, local .hex); accessible label is present and
      correct; existing FrontPage/FlashDialog tests updated as needed
      for the new trigger.
- [x] **Evidence**: `npx vitest run packages/ui`, `npm run typecheck`,
      and `npm run vite:build -w @robot-console/ui` all green;
      headless-Chrome screenshots of the front page (showing the
      lightning icon under the open arrow on a usb-linked card) and of
      the opened modal, captured from a host running against a scratch
      copy of the state DB; nothing is actually flashed during
      evidence capture.

## Implementation Plan

**Approach**:
- In `packages/ui/src/pages/FrontPage.tsx`'s `DeviceCard`, add a
  lightning-icon `IconButton` (or equivalent) positioned in the
  card's lower-right corner, rendered only when the card's device has
  a current `usb` link. Position it independently of the existing
  upper-right open-arrow control so neither shifts the other, and so
  cards without a usb link keep the arrow in its current position with
  no reserved empty space that shifts other content.
- Wire the icon button's `onClick` to open the existing `FlashDialog`
  for that device's usb link — reuse the dialog's existing props/API
  rather than duplicating flash logic; pass whatever link identifier
  `FlashDialog`/`FlashControls` already expects (mirror how the
  unassigned-board card currently invokes it).
- Replace the unassigned-board card's plain-text "Flash" trigger with
  the same lightning-icon component/trigger override so both entry
  points render identically and stay in sync going forward.
- Give the icon button an accessible name of the form "Flash <name>"
  (device name or board identifier for the unassigned case) plus a
  tooltip, matching the pattern used for other icon-only controls in
  this codebase (e.g. the open arrow) if one exists.

**Files likely touched**: `packages/ui/src/pages/FrontPage.tsx`
(DeviceCard and the unassigned-board card), and possibly
`packages/ui/src/components/FlashDialog.tsx` if the trigger override
needs a small extension to support an icon-only trigger cleanly.
Confirm exact current structure against source before editing, since
FrontPage.tsx has changed across recent tickets (013, 014).

**Testing plan**: unit tests as listed in Acceptance Criteria, run
scoped to `packages/ui` per this project's per-ticket testing rule
(the full suite runs once at `close_sprint`). Follow with the
headless-Chrome evidence capture described above against a scratch
copy of the state DB — never against live hardware being flashed.

**Documentation updates**: none expected beyond this ticket's own
completion notes; if the front-page card layout or flash-entry-point
convention documented elsewhere changes materially, note it in this
ticket's completion notes for the sprint's closing architecture
reconciliation.
