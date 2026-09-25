---
id: '006'
title: Robot page and relay page restrict flashing to their own firmware kind
status: done
use-cases:
- SUC-002
- SUC-003
depends-on:
- '004'
github-issue: ''
issue: ''
completes_issue: true
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Robot page and relay page restrict flashing to their own firmware kind

## Description

Wire up `AppHeader.tsx`'s one `FlashDialog` call site (line ~358) to
compute `allowedFirmware`/`allowLocalHex` from the resolved `device`
(`useDeviceForLink`, already read in this file) instead of nothing:

```
const allowedFirmware: readonly FirmwareKind[] =
  device?.kind === "robot" ? ["robot"]
  : device?.kind === "relay" ? ["relay"]
  : ALL_FLASHABLE_FIRMWARE; // no identified device yet
const allowLocalHex = device === undefined; // false whenever a device IS identified
```

(Pseudocode — write this however reads cleanest in the actual file; the
behavior is what the acceptance criteria check, not this exact shape.
Import `ALL_FLASHABLE_FIRMWARE` from `deviceDisplay.ts`, added in ticket
004.)

This is sprint.md's Design Rationale, Decision 2: the stakeholder's own
words named only the robot page ("Inside the robot page... should only
allow flashing the robot calibration software"), but this ticket
generalizes the same protection to a relay's own device page too — see
that Decision's own reasoning for why, and its note that this is a
planning-time judgment call worth a quick confirm with the stakeholder,
not a certainty. If the stakeholder says the relay page should stay
permissive instead, that's a one-line change to this ticket's own
acceptance criteria — flag it back rather than guessing further.

Read `AppHeader.tsx`'s own module doc comment (particularly "The
`canBeFlashed` vs. identified-device tension, resolved") before editing
— it explains why this header's `FlashDialog` already uses `forceShow`
for an identified device, which is unrelated to and unaffected by this
ticket's `allowedFirmware`/`allowLocalHex` change.

## Acceptance Criteria

- [x] Routed to an identified `kind: "robot"` device's own page,
      `AppHeader`'s Flash dialog renders exactly one option: "Flash
      robot firmware". No relay button, no joystick button, no
      local-hex uploader — verify by asserting their absence from the
      DOM, not merely that they're disabled.
- [x] Routed to an identified `kind: "relay"` device's own page,
      `AppHeader`'s Flash dialog renders exactly one option: "Flash
      relay firmware", with the same absence checks.
- [x] Routed to a link with no resolved device yet (an unassigned board
      reached via `/d/:linkId`), `AppHeader`'s Flash dialog renders all
      four options (relay, robot, joystick, local hex) — matching
      `UnknownDevicePage`'s own permissive behavior (ticket 005), since
      the same link is simultaneously shown by both components on that
      route.
- [x] This restriction holds regardless of what firmware is or isn't
      configured for the other kinds — they are absent from the DOM,
      never merely disabled.
- [x] Existing `AppHeader.test.tsx` assertions about its Flash dialog are
      updated to check the exact button set per device kind, not just
      that a trigger exists (new describe block "AppHeader Flash button
      set restricted to device kind (sprint 023 ticket 006)" pins the
      exact set per case; the older forceShow-mechanism tests are
      untouched since they test a different, unrelated concern).

## Testing

- **Existing tests to run**: `npx vitest run packages/ui/src/components/AppHeader.test.tsx --no-coverage`
- **New tests to write**: three cases — routed to a robot device (assert
  exactly one button, by text, and assert the other three are absent),
  routed to a relay device (same), routed to an unassigned link with no
  device (assert all four present).
- **Verification command**: `npx vitest run packages/ui/src/components/AppHeader.test.tsx --no-coverage`, foreground.
