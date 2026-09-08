---
id: '005'
title: 'RobotPage: drive controls, STATUS, and GET/SET panels'
status: done
use-cases:
- SUC-001
- SUC-003
- SUC-004
depends-on:
- '003'
- '004'
github-issue: ''
issue: robot-console-two-level-ui-and-multi-transport-roadmap.md
completes_issue: false
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# RobotPage: drive controls, STATUS, and GET/SET panels

## Description

Replace `RobotPage.tsx`'s sprint-4 placeholder shell ("Drive controls
and live telemetry aren't built yet...") with the real control
surface, built entirely on `WsProvider`'s hooks/actions (ticket 004) —
no direct socket access, no transport awareness.

**Drive controls target `WHEELS_V` only.** Per
`vendor/radio-robot-lib/docs/design/motion-api.md`, `DiffDriveAdapter`
— the only concrete `Adapter` this project's firmware ships — has no
planner and answers `WHEELS_X`/`MOVE_X`/`MOVE_V`/`GO_TO_R`/`GO_TO_W`
with an unknown-command error. Only `WHEELS_V left right duration`
(velocity, with `duration` as a **lease**, not a persistent command)
is implemented, alongside `STOP`/`STOP now`. Read that document's verb
table before wiring the payload. Because `duration` is a lease, a held
directional control must **re-issue `WHEELS_V` periodically while
held** (before the lease expires) and send `STOP` on release — this is
a distinct, UI-side timer discipline layered on top of (not a
replacement for) the host's own ~10ms write pacing (ticket 003).

**`StatusPanel`** sends unsequenced `STATUS` (`sendCommand("STATUS")`,
no fields) and displays the most recent `status ...` reply — `STATUS`
is unsequenced per protocol.md, so it never touches `sequencing`
directly; its reply arrives as an ordinary line, same as any raw
console traffic.

**`GetSetPanel`** is a free-text name/value form — per protocol.md,
"no config field table lives in this library," so there is no
enumerable list of legal `GET`/`SET` names to build a dropdown from.
`GET` sends `GET <name>` (sequenced) or bare `GET` if the name field is
empty (returns one `get` line per field); `SET` sends `SET <name>
<value>` (sequenced). An `err` reply for an unknown name must be shown
to the operator, not swallowed.

**`SequencingIndicator`** renders `seq`/`pendingCount`/`lastDone`/
`lastDoneReason` from `useSequencing(endpointId)` (ticket 004), with an
explicit "no session" state when it is `undefined`.

`DeviceConsole` stays embedded exactly as sprint 4 left it — this
ticket adds structured controls above/around it, it does not replace
it.

**Transport-blindness is a checked property, not just an intention.**
Nothing under `RobotPage` may import or reference `UsbSerialLink`, the
literal string `"usb"`, or `endpoint.transport`. Add an explicit
test/scan that fails if it does, rather than relying on review alone —
this is the property that makes sprint 7's "same page, no rewrite"
claim checkable.

## Acceptance Criteria

- [x] `DriveControls` sends `WHEELS_V <left> <right> <duration>` via
      `sendCommand`; while a directional control is held, it re-issues
      before the `duration` lease expires; on release it sends `STOP`.
- [x] `StatusPanel` sends unsequenced `STATUS` via `sendCommand` and
      displays the most recent `status ...` reply.
- [x] `GetSetPanel`: `GET` sends `GET <name>` (or bare `GET` if empty)
      sequenced; `SET` sends `SET <name> <value>` sequenced; an `err`
      reply for an unknown name is visibly shown to the operator.
- [x] `SequencingIndicator` renders `seq`/`pendingCount`/`lastDone`/
      `lastDoneReason` from `useSequencing`; shows a clear "no session"
      state when undefined.
- [x] `RobotPage` and every component under it contains no import of
      or reference to `UsbSerialLink`, the literal `"usb"`, or
      `endpoint.transport` — enforced by an explicit test (e.g. a
      source-scan over the relevant files), not left to review alone.
- [x] `DeviceConsole` remains embedded and functions exactly as before.
- [x] Component tests (fake `WsProvider` socket, following this
      project's existing `renderWithRouter`/`FakeSocket` testing
      harness) cover: drive control press/hold/release produces the
      expected `WHEELS_V`.../`STOP` sequence; `STATUS`/`GET`/`SET`
      controls send the expected messages; `SequencingIndicator`
      renders correctly from a fixture snapshot including the
      no-session state.
- [x] **Hardware-deferred, not covered by the tests above:** drive
      commands actually moving the robot converted in ticket 001;
      `STATUS`/`GET`/`SET` returning real, sensible firmware values.
      See the manual smoke-test result note under Testing below —
      `STATUS`/`GET`/`SET` values are confirmed real and sensible;
      actual robot motion remains deferred (not exercised, per this
      ticket's own safety instruction not to drive the motors without
      a confirmed-safe physical setup).

## Testing

- **Existing tests to run**: `npm test -- RobotPage` (packages/ui);
  full `npm test` before considering this ticket done.
- **New tests to write**: see Acceptance Criteria; plus a manual smoke
  pass against the real board from ticket 001 once available, recorded
  as a result note on this ticket (not a blocking pass/fail gate for
  ticket completion — see hardware-deferred criteria above).
- **Verification command**: `npm test`, `npm run build`, `npm run dev`
  for the manual smoke pass.

**Manual smoke-test result (2026-09-07):** ran `npm run dev`, drove the
real UI at `http://localhost:5173/` (via Playwright) against the real
bench, and navigated to `zavaz` (NEZHA2, the real robot converted in
ticket 001) at `/d/usb-9906360200052820e9d16c3809a44554000000006e052820`.
Confirmed against real hardware, through this ticket's own components
(not a raw console line):
- `StatusPanel`: "Send STATUS" produced
  `status ready=0 active=0 connL=0 connR=0 otos=0 wedge=0 flags=0
  i2cf=0 cyc=0 tlm=off next=1 done=0 reason=none`, rendered verbatim.
- `GetSetPanel`: bare `GET` produced `ack 1 0 none`; `SET
  nonexistent_field_xyz 1` produced `ack 2 0 none` followed by
  `err 1 #2` — both reply lines shown to the operator, the `err` not
  swallowed.
- `SequencingIndicator`: `seq` advanced 1 → 2 across the two sequenced
  sends above, matching the ack/nack traffic; `pendingCount` returned
  to 0 after each.
No drive command was sent to real hardware — per this ticket's own
safety instruction, a nonzero `WHEELS_V` was not issued to a robot on
an unconfirmed physical setup. `DriveControls`'s `WHEELS_V`/`STOP`
wire-level correctness is proven by its own component tests (fake
socket) only; actual motion stays hardware-deferred, per the
Acceptance Criteria above. Dev server was stopped and port 4795
verified free afterward, per this ticket's server-discipline
instruction.

## Implementation Plan

### Approach

Build bottom-up: the read-only `SequencingIndicator` first (no write
path to get wrong), then `StatusPanel` (simplest write, unsequenced),
then `GetSetPanel`, then `DriveControls` (the most complex, with the
lease-resend timer), then assemble `RobotPage`.

### Files to create/modify

- `packages/ui/src/pages/RobotPage.tsx`, `RobotPage.css`,
  `RobotPage.test.tsx` — replace the placeholder shell.
- New components under `packages/ui/src/components/`, each with a
  matching `.css`/`.test.tsx`, following this project's existing
  per-component file convention (see `DeviceConsole.tsx` for the
  pattern): `DriveControls.tsx`, `StatusPanel.tsx`, `GetSetPanel.tsx`,
  `SequencingIndicator.tsx`.

### Testing plan

See Acceptance Criteria / Testing above.

### Documentation updates

Update `RobotPage.tsx`'s own module doc comment (it currently states
"drive controls and live telemetry aren't built yet — sprint 6/8's
work") to reflect what this ticket actually built, following the
file's existing self-documenting convention.
