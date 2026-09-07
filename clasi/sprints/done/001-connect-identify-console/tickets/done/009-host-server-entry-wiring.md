---
id: 009
title: 'host: server.ts + npx entry wiring'
status: done
use-cases:
- SUC-001
- SUC-002
depends-on:
- '006'
- '007'
- 008
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

- [x] A single WebSocket connection carries both device-list update
      messages and line-traffic messages, discriminated by a `type`
      field.
- [x] Device-list messages include, per attached device: five-letter
      name, role, port, and USB serial number (UID), and update live as
      devices are attached/detached (no page refresh needed).
- [x] A client can send a line for a specific device and receive that
      device's reply line(s) back over the same WebSocket.
- [x] `server.ts` contains no naming, banner-parsing, framing, or
      sequencing logic of its own — it only calls into `devices.ts`,
      `swdName.ts`, and `UsbSerialLink`.
- [x] `npx robot-console` (completing ticket 001's stub) starts the
      Express/`ws` server and opens the browser to the UI.
- [x] Manually verified: see "Manual verification" below. Only one
      board (a single, silent, never-flashed micro:bit `zeguz`) was
      physically available for this ticket's hardware smoke test — no
      relay/robot pair was attached. Naming, live device-list updates,
      the silent-board degrade-gracefully path, and the WebSocket
      open/line/error round trip were all verified against it. Sending
      `HELLO`/`?`/`STATUS` to a *named* relay/robot pair and observing
      real reply lines is exercised by `server.test.ts`'s end-to-end
      suite against fakes (a `HELLO`-reply banner and a `status` reply
      line), but was not re-verified against a second, non-silent
      physical board in this sprint — flagged for the sprint's overall
      hardware smoke test once a relay/robot pair is available.

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

## Implementation Notes (as built)

**Files created**:
- `packages/host/src/wsMessages.ts` — the shared, `type`-discriminated
  WebSocket contract (both directions in one place, per the ticket):
  `DevicesMessage` (server -> client, full snapshot), `LineMessage`
  (both directions, discriminated further by its own `direction: "tx" |
  "rx"` field, exactly per the ticket's own example shape),
  `OpenDeviceMessage`/`CloseDeviceMessage` (client -> server),
  `ErrorMessage` (server -> client). Also exports `parseClientMessage`,
  the one place untrusted client JSON is validated/narrowed.
- `packages/host/src/deviceRegistry.ts` — a `DeviceRegistry` class that
  composes `devices.ts`'s `DeviceWatcher` + `swdName.ts`'s
  `readSwdName` + `UsbSerialLink` into live `DeviceListEntry` snapshots
  and per-device line/error events. This is where the ticket's
  "serialize per-device access" requirement is implemented: a
  `KeyedMutex` (per USB serial number) ensures name resolution, link
  open, link close, and line sends against one physical board never
  overlap, while different boards proceed fully in parallel. A newly
  attached device is listed immediately (name `null`) so the device
  list never blocks on SWD/serial I/O; name resolution then link-open
  are kicked off asynchronously and serially. `server.ts` composes this
  module rather than talking to `devices.ts`/`swdName.ts`/
  `UsbSerialLink` directly, so it can stay free of naming/framing/
  sequencing logic per the ticket's boundary.
- `packages/host/src/server.ts` — Express + `ws`, binds to `127.0.0.1`
  only (never `0.0.0.0`), serves `packages/ui/dist` if built (a plain
  status-text page otherwise, since `packages/ui` has no build output
  yet ahead of tickets 010/011), and bridges one `DeviceRegistry` to
  every connected WebSocket client per `wsMessages.ts`'s contract.
  Rejects clearly (`"port <n> is already in use..."`) rather than
  silently choosing another port if the requested one is busy; on that
  failure it also tears down the `DeviceRegistry` it had already
  started, rather than leaking a running device watcher behind a server
  that never came up.
- `packages/host/src/cli.ts` — the real logic behind `npx robot-console`:
  parses `--port`/`ROBOT_CONSOLE_PORT`, calls `startServer`, and opens
  the browser via the `open` package. A browser-open failure (e.g. a
  headless environment) is logged as a warning, not fatal — the server
  stays usable by pointing a browser or WebSocket client at the printed
  URL manually.
- `packages/host/src/wsMessages.test.ts`, `deviceRegistry.test.ts`,
  `server.test.ts` — see "Testing" below.

**Files modified**:
- `packages/host/src/index.ts` — now re-exports `wsMessages.ts`,
  `server.ts`, and `deviceRegistry.ts` for `packages/ui` (and later
  sprints) to import. The ticket-001 `PROTOCOL_PACKAGE_NAME` linkage
  marker is no longer imported/re-exported here — see "For the
  team-lead / architect" below, since removing it from
  `packages/protocol/src/index.ts` itself is out of this ticket's edit
  scope.
- `bin/robot-console.js` — replaces the ticket-001 placeholder; see
  "Runtime execution strategy" below for why it is a `tsx`-loading shim
  rather than a direct `import`.
- `packages/host/package.json` — added `express`, `ws`, `open`
  dependencies and `@types/express`/`@types/ws` devDependencies.
- `/package.json` (repo root) — added `tsx` as a production dependency
  (needed by `bin/robot-console.js` at `npx robot-console` runtime, not
  just for local dev) — see "Runtime execution strategy" below.

**Message-type contract** (the ticket's requested short note, also in
`wsMessages.ts`'s own doc comment):

| `type`  | Direction       | Shape                                              |
|---------|-----------------|-----------------------------------------------------|
| `devices` | server -> client | `{ type: "devices", devices: DeviceListEntry[] }` — always a full snapshot, sent on connect and again on every attach/detach/state change. |
| `line`    | both, discriminated by `direction` | `{ type: "line", deviceId, direction: "tx" \| "rx", line }` — `"tx"` client -> server -> device (also echoed back to *every* connected client on send, so multiple open UI tabs stay in sync); `"rx"` device -> server -> client. |
| `open`    | client -> server | `{ type: "open", deviceId }` — (re)open a link, e.g. retrying after a silent-board timeout. |
| `close`   | client -> server | `{ type: "close", deviceId }` |
| `error`   | server -> client | `{ type: "error", deviceId?, message }` — `deviceId` present for a device-scoped error (failed open, send with no open link), absent for a connection-level one (malformed message). |

**Runtime execution strategy (`tsx`) — flagged for the team-lead/architect**:
Every package in this monorepo currently resolves via its
`package.json`'s `main`/`types` fields directly to TypeScript source
(`./src/index.ts`), with no `dist` build output — `npm run build` in
every package currently runs `tsc --noEmit` (typecheck only). That
source also uses NodeNext-style `".js"` import specifiers pointing at
sibling `.ts` files, and (in `UsbSerialLink.ts`'s `WritePacer`, which
this ticket may not edit) constructor parameter properties. I verified
empirically that plain Node (v22.23.1, which does support unflagged
TypeScript type-stripping) cannot run this code as-is: type-stripping
alone rejects parameter properties outright
(`TypeScript parameter property is not supported in strip-only mode`),
and even `--experimental-transform-types` (which does support parameter
properties) still cannot resolve a `".js"` specifier against a sibling
`.ts` file — that remapping is a `tsc`/bundler-time convention, not
something plain Node's resolver does. Since I could not edit
`packages/protocol/package.json` to point it at a real, pre-built
`dist` + `exports` map (out of this ticket's scope), a build-only,
loader-free `bin/robot-console.js` was not achievable without also
building `packages/protocol` and changing its package entry points.
I used `tsx` (already proven to correctly handle both traps — verified
directly against `devices.ts`, `swdName.ts`, and `UsbSerialLink.ts`)
as a production dependency instead: `bin/robot-console.js` registers
`tsx/esm/api`'s `register()` as a loader hook, then dynamically imports
`packages/host/src/cli.ts`. This is a real, working `npx robot-console`
today, but it is a stopgap given each package's `main`/`types` fields —
a real per-package build + `exports` map (making `tsx` unnecessary at
runtime) is a reasonable follow-up ticket, and touches `packages/
protocol`'s own `package.json`, which is outside this ticket's scope.

**`PROTOCOL_PACKAGE_NAME` — flagged per the dispatch instructions**:
per its own doc comment ("ticket 009 removes it"),
`packages/protocol/src/index.ts`'s `PROTOCOL_PACKAGE_NAME` export was
ticket 001's workspace-linkage marker, to be removed once a later
ticket built something that actually linked the two packages for real.
This ticket's `swdName.ts`/`deviceRegistry.ts` (pre-existing and new,
respectively) now do that for real via `@robot-console/protocol`'s
substantive exports. `packages/host/src/index.ts` no longer imports or
re-exports it. It can now be deleted from
`packages/protocol/src/index.ts` — that file is outside this ticket's
edit scope, so it hasn't been touched here.

**A `ws`/WebSocketServer trap found and fixed during manual testing**:
`ws`'s `WebSocketServer` re-emits the underlying `http.Server`'s
`"error"` event (e.g. `EADDRINUSE` from `listen()`) as its own
`"error"` event. Node's `EventEmitter` throws for an unhandled
`"error"` event, so without a (deliberately empty) `wss.on("error", ...)`
listener, a port-busy startup crashed the process instead of cleanly
rejecting `startServer()`'s promise — confirmed by literally starting a
second server on an already-bound port before the fix (uncaught throw)
and after (clean rejection, `cli.ts`'s catch prints
`robot-console: port <n> is already in use...` and exits 1).

## Manual verification (real hardware)

Hardware available for this ticket: one attached, unflashed/silent
micro:bit at `/dev/cu.usbmodem2121102`, USB serial
`9906360200052820aba2e384f40cfd6c000000006e052820`, expected five-letter
name `zeguz`. No relay/robot pair was available (see the acceptance
criteria note above).

Steps:

1. `npm test` — 327 tests pass (298 pre-existing + 29 new: 10 in
   `wsMessages.test.ts`, 13 in `deviceRegistry.test.ts`, 6 in
   `server.test.ts`).
2. `npm run build` — all three packages typecheck clean.
3. `lsof -nP -iTCP:4795 -sTCP:LISTEN` before starting: nothing bound.
4. `ROBOT_CONSOLE_PORT=4795 node bin/robot-console.js` (backgrounded):
   printed `robot-console: listening on http://127.0.0.1:4795` within
   ~1s; attempting to open a browser failed harmlessly in this headless
   environment (warning only, process stayed up).
5. `lsof -nP -iTCP:4795 -sTCP:LISTEN` while running:
   ```
   COMMAND   PID USER   FD   TYPE  ...  NAME
   node    94930 eric   13u  IPv4  ...  127.0.0.1:4795 (LISTEN)
   ```
   confirms localhost-only binding (no `0.0.0.0`, no `*:4795`).
6. A `ws` client connected to `ws://127.0.0.1:4795` and received the
   real device-list message for the attached board:
   ```json
   {
     "type": "devices",
     "devices": [
       {
         "id": "9906360200052820aba2e384f40cfd6c000000006e052820",
         "serialNumber": "9906360200052820aba2e384f40cfd6c000000006e052820",
         "displaySerial": "aba2e384f40cfd6c",
         "name": "zeguz",
         "role": null,
         "port": "/dev/tty.usbmodem2121102",
         "linkOpen": false,
         "linkError": "timed out after 3000ms waiting for a HELLO banner reply from /dev/tty.usbmodem2121102"
       }
     ]
   }
   ```
   This confirms, end-to-end through the real server: SWD-based
   enumeration and naming work against the real board (`name: "zeguz"`,
   matching the board's known identity — resolved with **no serial port
   ever opened**, satisfying the ticket's "naming must not require
   opening the serial port" point); and the silent-board path degrades
   gracefully — the device stays listed and named, `role` is `null`,
   `linkOpen` is `false`, a specific `linkError` explains why, and the
   whole thing is bounded by `UsbSerialLink`'s own 3-second open
   timeout rather than hanging.
7. Sent `{"type":"line","deviceId":"<serial>","direction":"tx","line":"HELLO"}`
   to the (link-not-open) device: received back
   `{"type":"error","deviceId":"<serial>","message":"device <serial> has no open link"}`
   — a graceful, device-scoped error, not a crash or a hang. Server
   process was confirmed still alive and listening afterward.
8. Started a second `robot-console` process on the same port: got
   `robot-console: port 4795 is already in use on 127.0.0.1. Pass a
   different port (e.g. \`--port <port>\` or ROBOT_CONSOLE_PORT=<port>)
   rather than relying on an automatically-chosen one.` and exit code
   1, rather than silently choosing a different port.
9. Stopped the server (`SIGTERM`/`pkill`); confirmed the port was free
   again via `lsof`.

Not verified against real hardware in this ticket (flagged for the
sprint's overall hardware smoke test, once a relay/robot pair is
available): a real `HELLO`/`?`/`STATUS` round trip against a live,
non-silent board's actual reply lines, and two simultaneously attached
named devices in one device-list snapshot. Both are covered against
fakes by `server.test.ts`'s end-to-end suite (a fake link that resolves
a banner on `open()` and emits a `status` reply line on demand) and by
`deviceRegistry.test.ts`.
