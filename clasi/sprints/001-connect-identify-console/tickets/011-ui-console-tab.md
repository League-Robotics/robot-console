---
id: '011'
title: 'ui: Console tab'
status: pending
use-cases:
- SUC-002
depends-on:
- '009'
- '010'
github-issue: ''
issue: robot-console-architecture-and-roadmap.md
completes_issue: false
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# ui: Console tab

## Description

Build the Console tab in `packages/ui`, per `sprint.md`'s Architecture
and Success Criteria: a raw line stream for a selected device, plus a
send box. This is the tab that directly delivers this sprint's
`HELLO`/`?`/`STATUS` done-criterion.

Per `docs/design/overview.md`/`specification.md` §5, the Console tab is
deliberately the one place raw protocol traffic is exposed, unlike the
guided-flow style of the rest of the UI — this is intentional for
troubleshooting and learning, not an inconsistency to "fix" toward the
plainer style used elsewhere.

Device selection: reuse the device list/identity established by the
Devices tab (ticket 010) so the student picks a device by its
five-letter name, not by raw port path. Depends on ticket 010 for this
reason, in addition to depending on `server.ts` (ticket 009) for the
WebSocket itself.

Scope per `sprint.md`: this is a **generic** line console (type
anything, see the reply), not a drive-control UI — no `WHEELS_X`/
`WHEELS_V`/motor-control-specific widgets. That is sprint 3's UC-003.

Behavior to preserve from the protocol/host layers, surfaced correctly
in the UI rather than re-decided here:
- A line the host silently dropped as foreign traffic (per ticket 004's
  codec classification) must not appear in the line stream at all — the
  host already drops it before it reaches the WebSocket, so this is
  naturally satisfied as long as the UI does not add its own filtering
  logic that could disagree with the host's.
- The UI should not allow sending faster than the host's pacing budget
  would want — a simple client-side throttle/disable-while-pending on
  the send box is sufficient; the host's own pacing (ticket 008) is the
  actual enforcement point, so the UI's throttle is a UX nicety, not the
  correctness mechanism.

## Acceptance Criteria

- [ ] The Console tab lets the student pick a connected device (by its
      five-letter name) and shows that device's line stream.
- [ ] A send box lets the student type and submit a line; the resulting
      reply appears in the line stream.
- [ ] Typing `HELLO`, `?`, and `STATUS` each produce a visible reply in
      the line stream, for both a relay and a robot.
- [ ] The line stream shows only lines the host actually forwarded
      (i.e. no client-side re-filtering that could show or hide
      something differently than the host's own foreign-traffic-drop
      decision).
- [ ] Rapid repeated submission from the send box is throttled
      client-side (e.g. disabled while a send is pending) rather than
      firing unpaced writes at the host.
- [ ] No drive-specific controls (motor/wheel widgets) are present on
      this tab.
- [ ] Manually verified: with a real relay and a real robot attached,
      sending `HELLO`, `?`, and `STATUS` to each produces the expected
      reply in the Console tab.

## Testing

- **Existing tests to run**: `npm test` (protocol/host/ui suites
  continue passing).
- **New tests to write**: component-level tests rendering the Console
  tab against fake `type: 'line'` WebSocket messages, covering: line
  stream rendering, send-box submission producing an outbound WebSocket
  message, and the client-side send throttle. Real end-to-end behavior
  against live hardware is verified manually, not via `npm test`.
- **Verification command**: `npm test -- packages/ui`; manual smoke
  test with real hardware — this is the test that directly proves this
  sprint's `HELLO`/`?`/`STATUS` Success Criterion.

## Implementation Plan

**Approach**:
1. Reuse the WebSocket client/context established in ticket 010 (or
   establish it here if ticket 010 has not landed it yet — coordinate to
   avoid duplication).
2. Implement device selection reusing the device list/identity from
   ticket 010.
3. Implement the line-stream display, appending inbound `type: 'line'`
   messages for the selected device.
4. Implement the send box: on submit, send a `type: 'line'` (outbound)
   WebSocket message for the selected device; disable/throttle while a
   send is pending.
5. Manually verify `HELLO`/`?`/`STATUS` against a real relay and robot,
   recording the exact interaction/output in this ticket once run —
   this is the sprint's headline done-criterion.

**Files to create**:
- `packages/ui/src/components/ConsoleTab.tsx` (or equivalent)
- `packages/ui/src/components/ConsoleTab.test.tsx`

**Files to modify**:
- `packages/ui/src/App.tsx` (or equivalent) to add the Console tab to
  the UI's tab structure.

**Testing plan**: component tests against faked WebSocket messages;
manual hardware smoke test against a real relay and robot, directly
exercising `HELLO`/`?`/`STATUS`.

**Documentation updates**: none required beyond in-code comments if the
send-throttle behavior needs explanation for a future editor.
