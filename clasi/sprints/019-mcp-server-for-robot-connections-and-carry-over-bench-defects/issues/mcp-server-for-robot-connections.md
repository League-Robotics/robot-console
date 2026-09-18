---
status: in-progress
sprint: 019
tickets:
- 019-004
- 019-005
- 019-006
- 019-007
- 019-008
- 019-009
---

# MCP server for robot connections, sharing the robot console's library and database

## Idea (stakeholder, 2026-09-17)

Expose the robot fleet to agents over the Model Context Protocol: an MCP
server that is *not* a separate stack but a second front end on the same
host code the robot console already runs on.

- **Same code library.** The MCP server links the existing host packages
  (`@robot-console/host` connect/watchers/store, `@robot-console/protocol`)
  rather than reimplementing transports. Connecting to a robot over USB,
  WiFi, farm mbserial or relay radio goes through the same connector,
  reconciler and session machinery the console's WebSocket server uses.
- **Same database.** It opens the same `console.sqlite` state store, so
  devices, links, sessions and users are one shared set of rows — not a
  parallel world.
- **Visible in the console.** A connection an agent opens through MCP
  shows up on the console's device cards and robot pages like any other
  session: same identity, same link rows, same "who holds this board"
  accounting. Shutting down or stealing a session works in both
  directions.

## Why

Agents currently drive robots by scripting the console's WebSocket
protocol or by talking to bridges directly, which bypasses the host's
own contention handling (board ownership, relay leases, single-TCP-slot
WiFi robots) and leaves the console showing a world it does not actually
control. A first-class MCP front end makes agent-driven robot work a
peer of human-driven robot work instead of a competitor for the same
ports.

## Open questions for planning

- **Process model**: does the MCP server run *inside* the existing host
  process (a second listener alongside the WebSocket server, one owner
  of the serial ports and relay leases), or as a separate process that
  shares the SQLite file? The bench has repeatedly shown that two
  processes fighting over one port/lease is a defect source
  (sprint 018 ticket 012), which argues for in-process.
- **Identity/users**: what is an MCP caller's identity in the shared
  store, and how does it appear in the console's session/ownership UI?
- **Tool surface**: which verbs are exposed — list devices, connect,
  send command, read telemetry, flash? Which are deliberately withheld
  (motion verbs, flashing) and behind what confirmation?
- **Transport**: stdio MCP server launched per agent, or a long-lived
  HTTP/SSE server the way the console itself is long-lived?
- Whether this ships as part of the `robot-console` package or as a
  sibling package in the same monorepo.
