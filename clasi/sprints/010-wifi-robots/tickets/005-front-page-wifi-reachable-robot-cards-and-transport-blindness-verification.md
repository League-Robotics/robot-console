---
id: '005'
title: 'Front page: WiFi-reachable robot cards and transport-blindness verification'
status: open
use-cases: [SUC-005]
depends-on: ["003"]
github-issue: ''
issue: robot-console-two-level-ui-and-multi-transport-roadmap.md
completes_issue: true
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Front page: WiFi-reachable robot cards and transport-blindness verification

## Description

Two parts, both small verification/labeling work against ticket 003's
already-synthesized `transport: "wifi"` `EndpointListEntry` — no new
`packages/ui` component is needed, since `EndpointCard` already
renders any `EndpointListEntry` generically:

1. **`FrontPage.tsx` / `EndpointCard`**: add a WiFi-distinguishing
   label (e.g. "WiFi" next to the existing "USB"/"via relay `<name>`"
   labels) driven by `transport === "wifi"`. This file is **not** in
   `RobotPage.transportBlind.test.ts`'s scanned list (it is explicitly
   allowed to know about transport — only `RobotPage` and its mounted
   children may not, per that test's own scope note).
2. **Extend `RobotPage.transportBlind.test.ts`'s existing render-describe
   block** with a `transport: "wifi"` endpoint fixture, mirroring the
   file's existing `relayTransportRobotFixture`/`relay-radio` describe
   block exactly (sprint 8 ticket 005's own precedent for a new
   transport value). Assert the same controls (estop, drive, console)
   render, with **zero changes** to `RobotPage.tsx` or any file in
   `FILES_UNDER_TEST`.

Do not touch the existing source-scan assertions themselves (no
`UsbSerialLink` reference, no quoted `"usb"` literal, no
`endpoint.transport`/`device.transport` reference) — this ticket's job
is proving they still hold for a codebase that now also has a `"wifi"`
transport, not changing what they check.

## Acceptance Criteria

- [ ] `FrontPage` renders a WiFi-distinguishing label for a
      `transport: "wifi"` fixture entry (both `sessionOpen: false` —
      the not-yet-connected, clickable card — and `sessionOpen: true`
      states).
- [ ] `FrontPage` renders no card at all, and no console error, for a
      fixture representing a raw (ungated) discovery entry — i.e. the
      UI-level restatement of the negative case ticket 002/003 already
      enforce host-side (this is a defense-in-depth UI test, not the
      primary enforcement point).
- [ ] `RobotPage.transportBlind.test.ts`'s render-describe block passes
      against a new `transport: "wifi"` fixture: estop button, drive
      controls, and console all present, robot name in the rendered
      text.
- [ ] `RobotPage.transportBlind.test.ts`'s existing source-scan
      assertions (all three, across every file in `FILES_UNDER_TEST`)
      continue to pass unmodified — proving this sprint introduced no
      new transport-blindness violation anywhere in `RobotPage`'s
      component family.

## Testing

- **Existing tests to run**: `packages/ui/src/pages/RobotPage.transportBlind.test.ts`,
  `packages/ui/src/pages/FrontPage.test.tsx` (or equivalent existing
  front-page test file) — full files, must keep passing unmodified for
  every pre-existing transport.
- **New tests to write**: the `transport: "wifi"` fixture/describe
  block in `RobotPage.transportBlind.test.ts`; new `FrontPage` cases
  for the WiFi label and the negative (no-card) case.
- **Verification command**: `npm test -w packages/ui` and `npm run
  build`.
