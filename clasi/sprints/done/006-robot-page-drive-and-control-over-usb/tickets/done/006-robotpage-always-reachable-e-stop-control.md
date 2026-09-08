---
id: '006'
title: 'RobotPage: always-reachable e-stop control'
status: done
use-cases:
- SUC-002
depends-on:
- '003'
- '004'
github-issue: ''
issue: robot-console-two-level-ui-and-multi-transport-roadmap.md
completes_issue: false
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# RobotPage: always-reachable e-stop control

## Description

E-stop is treated as a first-class safety affordance, not a menu item
or an incidental button — this ticket is kept separate from ticket
005's general command panels specifically so its safety-critical path
gets its own focused review (see `sprint.md`'s Design Rationale).

**Dispatch.** `ESTOP` is outside the sequence entirely (protocol.md
§8.3/§9): no id, never acked/nacked in the sequencing sense, maximally
forgiving. `EstopControl` sends it via `sendCommand("ESTOP")`
(ticket 004), which the host (ticket 003) routes to
`link.sendUnsequenced` — **never** `link.sendCommand`. Do not gate
sending on `sequencing`/`pendingCount` state in any way; e-stop must
not wait behind or depend on anything drive/`GET`/`SET` is doing.

**Reachability.** `EstopControl` renders unconditionally on
`RobotPage` — not inside a modal, a tab, or a collapsible section that
could hide it, and not affected by which of ticket 005's panels
(`DriveControls`/`StatusPanel`/`GetSetPanel`) is currently focused or
mid-interaction. When no session is open, it is disabled with a hint
(following `DeviceConsole`'s existing "open a link" affordance
pattern) rather than hidden — a student should always be able to see
where it is, even if it currently can't do anything.

**This ticket proves the UI's behavior only.** Its tests establish
that the correct unsequenced `ESTOP` line is sent at the correct time
against a fake link. **They must not be described, in this ticket or
anywhere else, as proving that a real robot stops** — that is a safety
claim, verified only against real hardware (ticket 001's converted
board), and is recorded as hardware-deferred per `sprint.md`'s Success
Criteria.

## Acceptance Criteria

- [x] `EstopControl` renders on `RobotPage` unconditionally — reachable
      regardless of which other panel is open or mid-interaction, and
      not nested inside anything that could hide it (a tab, modal, or
      collapsible section).
- [x] Activating it sends unsequenced `ESTOP` with no fields via
      `sendCommand("ESTOP")`.
- [x] Sending is never gated on `sequencing`/`pendingCount` or any
      drive/`GET`/`SET` in-flight state.
- [x] Disabled-with-a-hint (not hidden) when no session is open,
      matching `DeviceConsole`'s existing pattern.
- [x] Component test (fake `WsProvider` socket) proves: pressing it
      sends the exact unsequenced `ESTOP` command; it remains reachable
      and functional while another panel has pending sequenced
      activity (simulate a pending `WHEELS_V`/`GET` and confirm e-stop
      still sends immediately).
- [x] **This ticket's own text (Description, Acceptance Criteria, test
      names/comments) does not claim, anywhere, that a real robot
      stopping is verified.** That is explicitly hardware-deferred.

## Result Notes

- **Test-provable (done, verified):** `EstopControl.test.tsx` (7 tests)
  proves: unconditional rendering (`aria-label="Emergency stop"`);
  pressing sends exactly `{ type: "send-command", endpointId, verb:
  "ESTOP" }` (no `fields` key at all, matching `sendCommand`'s
  no-fields-key-when-omitted contract); it sends immediately while the
  device snapshot carries `sequencing.pendingCount` > 0 (simulating a
  pending `WHEELS_V` lease and a pending `GET`, in two separate cases);
  three repeated presses each send an independent `ESTOP` with the
  button staying enabled throughout (no cooldown/dedup/queueing); and
  it disables-with-a-hint ("No link open — there is nothing to stop.")
  rather than hiding when `sessionOpen` is false, sending nothing if
  clicked in that state. `RobotPage.test.tsx` and
  `RobotPage.transportBlind.test.ts` were extended to cover/scan
  `EstopControl` as part of the page.
- **Hardware-safe, done:** started the local dev server (port 4795,
  confirmed no prior listener), drove the real UI at
  `http://localhost:5173/` with Playwright against the real, stationary
  `zavaz` board (`NEZHA2`, endpoint
  `usb-9906360200052820e9d16c3809a44554000000006e052820`). Opened a
  session, confirmed the E-STOP button was enabled, clicked it, and the
  device console showed the reply `« estop` — matching
  `radio-robot-lib`'s `specification.md` ("`ESTOP` ... always executes
  and always replies `estop`"). This confirms the command reached the
  wire and the robot acknowledged it. The robot was not driven and did
  not move during this check. Server was stopped afterward (port 4795
  confirmed free) and the one-off Playwright script was deleted — no
  artifact of it remains in the tree.
- **Hardware-deferred, not claimed here:** whether `ESTOP` actually
  halts a robot that is in motion. That requires driving the robot
  first, which this ticket explicitly avoids on this bench (`zavaz` may
  be positioned where movement is unsafe). To be confirmed by the
  stakeholder once the robot is on a surface where motion is safe.

## Testing

- **Existing tests to run**: `npm test -- RobotPage` (packages/ui).
- **New tests to write**: `EstopControl` component tests per Acceptance
  Criteria above.
- **Verification command**: `npm test`, `npm run build`; a hardware
  smoke pass against ticket 001's converted board once available,
  recorded as a result note on this ticket — **not** a pass/fail gate
  for closing this ticket (see the hardware-deferred callout above).

## Implementation Plan

### Approach

Build `EstopControl` as a fully standalone component (not nested
inside `DriveControls` or any other panel) so its reachability is
structural, not incidental to how another component happens to be
laid out.

### Files to create/modify

- `packages/ui/src/components/EstopControl.tsx`, `.css`, `.test.tsx` —
  new.
- `packages/ui/src/pages/RobotPage.tsx` — mount `EstopControl` in a
  layout position that is unconditionally rendered (e.g. outside/above
  any panel that toggles or scrolls independently).

### Testing plan

See Acceptance Criteria / Testing above.

### Documentation updates

`EstopControl.tsx`'s own module doc comment should state plainly (for
the next reader) that its tests prove UI behavior only, and that "a
robot actually stops" is a hardware-deferred claim never checked off
by this component's own test suite — mirroring the same explicit
callout `sprint.md` makes at the sprint level.
