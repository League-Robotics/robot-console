---
id: '008'
title: Per-device pages (unknown/relay/robot) and post-flash navigation
status: open
use-cases: ["SUC-002", "SUC-003", "SUC-006", "SUC-007"]
depends-on: ["007", "005"]
github-issue: ''
issue: robot-console-two-level-ui-and-multi-transport-roadmap.md
completes_issue: false
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Per-device pages (unknown/relay/robot) and post-flash navigation

## Description

Fill in `DevicePage` (ticket 007's shell) with real per-type dispatch
and content, complete the two flash affordances, embed the raw
console, and wire up post-flash navigation.

**Dispatch:** `DevicePage` reads `useEndpoint(endpointId)` and
switches on `entry.classification.type`: `"relay"` → `RelayPage`,
`"robot"` → `RobotPage`, and a `default` arm (covering `"unknown"` and
any unrecognized string, per the "fourth type is purely additive"
contract — `normalizeDeviceType`, ticket 001, is what guarantees the
value reaching here is safe, but the dispatch's own `default` arm is
the actual mechanism the roadmap issue requires) → `UnknownDevicePage`.

**`UnknownDevicePage`:** carries forward the two flash affordances:
- Release flash (existing flow, UC-002/SUC-002): relay/robot buttons
  gated on `firmwareStatus` exactly as `DeviceCard` gates them today,
  moved from the front page onto this page. Progress phases render
  here (through `"reidentifying"`, ticket 004).
- Local-hex flash (new, SUC-003): a file input; on selection, compute
  `{ fileName, byteLength, sha256 }` client-side (Web Crypto
  `crypto.subtle.digest("SHA-256", ...)`), send `flash-local-begin`,
  await `flash-local-ready`, send one binary WebSocket frame
  (`uploadId` bytes + payload, per `UPLOAD_ID_BYTE_LENGTH` from ticket
  001/005), then a "Flash this file" button sends `flash-start` with
  `source: { kind: "local-hex", uploadId, fileName, sha256 }`. Reuse
  the same progress-rendering path as the release flow.

**`RelayPage`/`RobotPage`:** minimal shells per `sprint.md`'s Scope —
`RelayPage` shows a header and a robot-name dropdown that is present
but intentionally empty (sprint 5 populates it from the roster);
`RobotPage` shows a minimal placeholder (drive/telemetry are sprints
6/8). Both embed `DeviceConsole` (below).

**`DeviceConsole`:** extracted from `ConsoleTab.tsx`, scoped to one
`endpointId` (no device-picker dropdown — the route already picked the
device) via `useEndpointLog(endpointId)` (ticket 006). Preserves
`ConsoleTab`'s existing behavior: classification styling
(comment/debug/error/ack/data), autoscroll toggle, clear log, send
box with cooldown, the "some commands get no reply" note, and the
"open a link first" hint when `sessionOpen` is false. Embedded in
every per-device page (unknown/relay/robot) per `sprint.md`'s Design
Rationale — not a nested route this sprint.

**Post-flash navigation:** subscribe to `onFlashResult` on
`UnknownDevicePage`; when it fires for the currently-viewed
`endpointId` with `status: "ok"`, navigate to `/` (the front page) —
**only if the user is still on that device's page** (check the route
param against the message's `endpointId` before navigating; a student
who has already clicked elsewhere must not be yanked away).

## Acceptance Criteria

- [ ] `DevicePage` dispatches to `UnknownDevicePage`/`RelayPage`/
      `RobotPage` correctly per `classification.type`, including the
      `default` arm for a fixture entry carrying an unrecognized type
      string.
- [ ] `UnknownDevicePage`'s release-flash controls match `DeviceCard`'s
      existing gating/disabled-reason behavior exactly (moved, not
      redesigned) — verified by porting the relevant existing
      `DevicesTab.test.tsx` assertions.
- [ ] Local-hex flow: selecting a file computes and sends
      `flash-local-begin` with correct `fileName`/`byteLength`/`sha256`;
      on `flash-local-ready`, sends one binary frame with the
      `uploadId` prefix followed by the file bytes; "Flash this file"
      sends `flash-start` with the right `source` shape — verified
      against a fake socket capturing sent frames.
- [ ] `RelayPage` renders its dropdown present-but-empty (not hidden,
      not an error state) for a `relay`-classified fixture entry.
      `RobotPage` renders its shell for a `robot`-classified fixture
      entry.
- [ ] `DeviceConsole` embedded in all three page types shows the
      correct per-endpoint log (via `useEndpointLog`) and preserves
      every existing `ConsoleTab` behavior listed above — ported
      `ConsoleTab.test.tsx` assertions pass against the new component.
- [ ] Post-flash navigation: a `flash-result ok` for the currently
      viewed endpoint navigates to `/`; a `flash-result` for a
      *different* endpoint (e.g. arriving after the student already
      navigated away) does **not** navigate anywhere.
- [ ] `ConsoleTab.tsx`/`ConsoleTab.test.tsx` and any remaining
      `DevicesTab.tsx`/`DevicesTab.test.tsx` content not already
      retired by ticket 007 are removed once `DeviceConsole`/
      `UnknownDevicePage` fully cover their behavior.
- [ ] `npm test` and `npm run build` pass in full.

## Testing

- **Existing tests to run**: full `npm test`, paying particular
  attention to any assertion ported from `DevicesTab.test.tsx`/
  `ConsoleTab.test.tsx` that must still hold in its new location.
- **New tests to write**: `DevicePage.test.tsx` (dispatch by type
  including `default`); `UnknownDevicePage.test.tsx` (release flash
  gating ported from `DevicesTab.test.tsx`; local-hex handshake
  against a fake socket capturing binary frames); `RelayPage.test.tsx`/
  `RobotPage.test.tsx` (shell rendering); `DeviceConsole.test.tsx`
  (behavior ported from `ConsoleTab.test.tsx`); a post-flash-navigation
  test using a router test wrapper asserting the "still on that page"
  guard.
- **Verification command**: `npm test && npm run build`

## Implementation Plan

**Approach:** Build `DeviceConsole` first (it's needed by all three
page types and is the most direct port of existing, well-tested
behavior from `ConsoleTab.tsx`), then `RelayPage`/`RobotPage` (small
shells), then `UnknownDevicePage` (the largest piece — release flash
ported from `DeviceCard`, then local-hex built fresh on top of ticket
005's host-side handshake), then wire dispatch and post-flash
navigation last, once every page type exists to dispatch to.

**Files to create:**
- `packages/ui/src/pages/UnknownDevicePage.tsx` (+ test)
- `packages/ui/src/pages/RelayPage.tsx` (+ test)
- `packages/ui/src/pages/RobotPage.tsx` (+ test)
- `packages/ui/src/components/DeviceConsole.tsx` (+ test)

**Files to modify:**
- `packages/ui/src/pages/DevicePage.tsx` (ticket 007's shell — fill in
  dispatch)
- `packages/ui/src/components/DevicesTab.tsx`/`.test.tsx` (retire
  remaining flash-control rendering once ported)
- `packages/ui/src/components/ConsoleTab.tsx`/`.test.tsx` (retire once
  `DeviceConsole` fully covers its behavior)

**Documentation updates:** Add a module doc comment to
`DeviceConsole.tsx` explaining it is the sprint-4 successor to
`ConsoleTab.tsx`, embedded per-device rather than a standalone tab —
cross-reference `sprint.md`'s Design Rationale entry on why this isn't
a nested route yet, so a sprint 6/8 reader considering promoting it
understands the prior decision instead of re-litigating it from
scratch.
