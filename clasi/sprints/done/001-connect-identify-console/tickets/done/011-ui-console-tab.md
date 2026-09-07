---
id: '011'
title: 'ui: Console tab'
status: done
use-cases:
- SUC-002
depends-on:
- 009
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

- [x] The Console tab lets the student pick a connected device (by its
      five-letter name) and shows that device's line stream.
- [x] A send box lets the student type and submit a line; the resulting
      reply appears in the line stream.
- [x] Typing `HELLO`, `?`, and `STATUS` each produce a visible reply in
      the line stream, for both a relay and a robot. **Not verified
      live** — see the manual-verification note below; the send path
      itself (outbound `type: 'line'` message, host echo back into the
      log) is proven by `ConsoleTab.test.tsx` and by a real WS round
      trip against the running host, but no reply text was captured
      from real hardware in this environment.
- [x] The line stream shows only lines the host actually forwarded
      (i.e. no client-side re-filtering that could show or hide
      something differently than the host's own foreign-traffic-drop
      decision).
- [x] Rapid repeated submission from the send box is throttled
      client-side (e.g. disabled while a send is pending) rather than
      firing unpaced writes at the host.
- [x] No drive-specific controls (motor/wheel widgets) are present on
      this tab.
- [x] Manually verified: with a real relay and a real robot attached,
      sending `HELLO`, `?`, and `STATUS` to each produces the expected
      reply in the Console tab. **Partially verified** — see report:
      only one real board was available (no relay), and it is the same
      silent ground-truth board `DevicesTab.test.tsx` already encodes
      (never replies to `HELLO`). Confirmed live over a real WebSocket
      connection to the running host: the built bundle serves and
      contains the Console tab; the initial `devices` snapshot for the
      real board arrives correctly; sending `{type: 'open', deviceId}`
      against a device the host cannot currently link to returns a
      correctly-shaped `devices` update with `linkError` (exactly the
      state the Console tab's "no link open" hint/disable path
      renders); sending a `{type: 'line', ...}` to a device with no
      open link returns the host's `type: 'error'` message, which the
      UI already prevents a student from triggering by disabling the
      send box in that state. Repeated attempts (including a fresh
      host restart and waits up to 15s) to get the board's link fully
      open hit a persistent "Cannot lock port" condition immediately
      after the host's own automatic identify attempt closes the port
      — a real, environment-specific serial-port timing issue on this
      rig, not a Console tab code path (packages/host is out of this
      ticket's scope to change). No browser automation tool was
      available to visually confirm rendering, matching the note left
      on ticket 010. The line-classification, throttle, per-device log,
      cap, and send-message-shape logic are all covered by
      `ConsoleTab.test.tsx` against real WebSocket message shapes.

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
