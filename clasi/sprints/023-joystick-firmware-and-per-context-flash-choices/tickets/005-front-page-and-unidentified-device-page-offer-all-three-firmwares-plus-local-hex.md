---
id: "005"
title: "Front page and unidentified device page offer all three firmwares plus local hex"
status: open
use-cases: ["SUC-001"]
depends-on: ["004"]
github-issue: ""
issue: ""
completes_issue: true
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Front page and unidentified device page offer all three firmwares plus local hex

## Description

Wire up the three "permissive" `FlashDialog` call sites to pass
`allowedFirmware={ALL_FLASHABLE_FIRMWARE}` and `allowLocalHex={true}`
(both imported from `packages/ui/src/deviceDisplay.ts`, added in ticket
004):

- `packages/ui/src/pages/FrontPage.tsx`, `DeviceCard`'s identified-device
  `FlashDialog` (the `usbLink && hasWsStore` block, ~line 654-661).
- `packages/ui/src/pages/FrontPage.tsx`, the unassigned-board card's
  `FlashDialog` (~line 1097).
- `packages/ui/src/pages/UnknownDevicePage.tsx`'s `FlashDialog`
  (~line 65).

These are the three surfaces sprint.md's Use Cases (SUC-001) and its
Design Rationale (Decision 2) call "permissive" — a bare/not-yet-
identified board, or an identified device viewed from the front page's
own list, should be offered all three release kinds plus local-hex,
exactly as answered in the stakeholder's own follow-up ("front-page list
is: robot, relay, joystick, PLUS the existing local-hex upload").

## Acceptance Criteria

- [ ] All three call sites listed above pass
      `allowedFirmware={ALL_FLASHABLE_FIRMWARE}` and
      `allowLocalHex={true}`.
- [ ] Front page: an unassigned board's Flash dialog shows Flash relay
      firmware, Flash robot firmware, Flash joystick firmware, and Flash
      a hex file from disk — in that order.
- [ ] Front page: an identified device's card Flash dialog shows the
      same four options (this is a widening from today's two-button
      behavior for an identified device on the front page — confirm this
      matches sprint.md's Goals before treating it as a regression; it
      is the stakeholder's own stated front-page list, not scoped to
      unassigned boards only).
- [ ] `UnknownDevicePage`'s Flash dialog shows the same four options.
- [ ] `UnknownDevicePage.test.tsx`'s existing assertions (lines ~163-164,
      currently checking only for "Flash relay firmware"/"Flash robot
      firmware") are updated to also assert "Flash joystick firmware"
      is present.
- [ ] Any `FrontPage.test.tsx` assertions about the flash dialog's
      button set are updated the same way.

## Testing

- **Existing tests to run**: `npx vitest run packages/ui/src/pages/FrontPage.test.tsx packages/ui/src/pages/UnknownDevicePage.test.tsx --no-coverage`
- **New tests to write**: a case per call site asserting all four
  options render (relay, robot, joystick buttons plus the local-hex file
  input), and that no fifth/extra option appears.
- **Verification command**: run the two files above individually with
  `npx vitest run <path> --no-coverage`, foreground.
