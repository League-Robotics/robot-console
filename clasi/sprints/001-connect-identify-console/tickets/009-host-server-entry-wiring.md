---
id: '009'
title: 'host: server.ts + npx entry wiring'
status: pending
use-cases:
- SUC-001
- SUC-002
depends-on:
- '006'
- '007'
- '008'
github-issue: ''
issue: robot-console-architecture-and-roadmap.md
completes_issue: false
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# host: server.ts + npx entry wiring

## Description

Build `packages/host/src/server.ts`, per `sprint.md`'s Architecture:
purpose is to expose the host's device list and line traffic to the
browser over **one** WebSocket, composing `devices.ts` (ticket 006) +
`swdName.ts` (ticket 007) for identity and `UsbSerialLink` (ticket 008)
for per-device I/O. Per `docs/design/specification.md` §4.7: Express +
`ws`, one WebSocket carrying device-list updates and line traffic
(telemetry frames join the same channel in sprint 4, not this one).

`server.ts` itself must contain **no** naming, framing, or sequencing
logic of its own — it only composes the modules above into WebSocket
messages. If a bug looks like it needs new protocol logic in
`server.ts`, that is a sign the logic belongs in `protocol` or `host`'s
other modules instead (per `sprint.md`'s Architecture boundary for this
module).

**Message shape**: define a `type`-discriminated message format on the
single WebSocket (e.g. `{ type: 'devices', devices: [...] }` and
`{ type: 'line', deviceId, direction, line }`) so both UI tabs (Devices,
Console — tickets 010, 011) can share one connection and dispatch on
`type`. Device-list messages must reflect live attach/detach (via
`devices.ts`'s live-update capability from ticket 006) and must include,
per device: five-letter name (from `swdName.ts`), role (from the banner
read during `UsbSerialLink` open), port, and UID (the USB
`serial_number` — shown alongside the name, not instead of it, since
this sprint's whole point is that the name and the USB serial number are
different values from different chips).

**`npx` entry wiring**: this ticket completes the `TODO(ticket 009)`
marker left in the `bin` entry point by ticket 001 — the entry point
must now actually start `server.ts`'s Express/`ws` server and open the
student's default browser to the served UI page.

## Acceptance Criteria

- [ ] A single WebSocket connection carries both device-list update
      messages and line-traffic messages, discriminated by a `type`
      field.
- [ ] Device-list messages include, per attached device: five-letter
      name, role, port, and USB serial number (UID), and update live as
      devices are attached/detached (no page refresh needed).
- [ ] A client can send a line for a specific device and receive that
      device's reply line(s) back over the same WebSocket.
- [ ] `server.ts` contains no naming, banner-parsing, framing, or
      sequencing logic of its own — it only calls into `devices.ts`,
      `swdName.ts`, and `UsbSerialLink`.
- [ ] `npx robot-console` (completing ticket 001's stub) starts the
      Express/`ws` server and opens the browser to the UI.
- [ ] Manually verified: with a relay and a robot both attached, the
      device-list messages show correct names/roles/ports/UIDs for
      both, and sending `HELLO`/`?`/`STATUS` to either over the
      WebSocket produces the expected reply line(s).

## Testing

- **Existing tests to run**: `npm test` (protocol and other `host`
  suites continue passing).
- **New tests to write**: unit tests for the message-shaping logic
  (given fake `devices.ts`/`swdName.ts`/`UsbSerialLink` outputs, does
  `server.ts` produce the correct WebSocket message shape?) using fakes/
  mocks for the composed modules, since the real end-to-end path needs
  hardware. A full end-to-end WebSocket round-trip (real Express/`ws`
  server, a test WebSocket client, fake underlying device modules) is
  valuable here and should be added if practical, since it does not
  require real hardware — only the device/link layer needs faking.
- **Verification command**: `npm test -- packages/host`; manual
  end-to-end smoke test with real hardware and a browser (or a WebSocket
  client) attached, satisfying this sprint's overall Success Criteria.

## Implementation Plan

**Approach**:
1. Implement the Express app (serving the built `packages/ui` output;
   coordinate with ticket 010/011 on the exact static-serving setup) and
   the `ws` WebSocket server.
2. Implement the device-list composition: subscribe to `devices.ts`'s
   live updates, resolve each device's name via `swdName.ts` and role
   via the `UsbSerialLink` banner read, and push `type: 'devices'`
   messages to all connected clients on change.
3. Implement per-device line traffic: on WebSocket `type: 'line'`
   (outbound) messages from a client, forward to the correct device's
   `UsbSerialLink`; on inbound lines from any open `UsbSerialLink`, push
   `type: 'line'` (inbound) messages to clients.
4. Wire the `bin` entry point (from ticket 001) to call this module's
   server-start function and open the browser (e.g. via the `open`
   package or Node's platform-specific opener commands) to the served
   UI's local URL.
5. Manually verify end-to-end with a real relay and robot attached,
   recording the exact steps/output in this ticket once run.

**Files to create**:
- `packages/host/src/server.ts`
- `packages/host/src/server.test.ts`

**Files to modify**:
- `packages/host/package.json` (add `express`, `ws`, and a browser-
  opener dependency).
- The `bin` entry point file created in ticket 001 (replace its
  `TODO(ticket 009)` marker with the real server-start + browser-open
  call).

**Testing plan**: unit tests for message shaping against faked
`devices.ts`/`swdName.ts`/`UsbSerialLink`; an end-to-end WebSocket test
using a real server against faked device modules if practical; manual
hardware smoke test satisfying this sprint's Success Criteria.

**Documentation updates**: a short note on the WebSocket message
`type` discriminants, since tickets 010/011 (UI) and every later
sprint's link additions will extend this same channel and need to agree
on its shape.
