---
status: pending
---

# The UI shows no "disconnected from host" state; a dead tab looks live

## Description

Observed 2026-09-10: after the dev host was restarted, the stakeholder's
open tab kept rendering its last `endpoints` snapshot with every control
enabled. Holding Forward on a WiFi robot sent nothing — a 45 s wire watch
on the host saw zero drive lines — because the tab's WebSocket was gone
and `WsProvider.send` had no live socket. Nothing on screen said so.

`WsProvider` does reconnect (1.5 s retry) and tracks
`useConnectionStatus()` ("connecting" | "open" | "closed"), but no
component renders it: `AppHeader` and `App` never read it.

## Proposed resolution

- `AppHeader` (or a top-of-page strip) renders a persistent banner when
  the status is not `"open"`: "Disconnected from the robot console host —
  reconnecting…", with the host URL, and clears it on reconnect.
- While disconnected, every send-capable control (drive pad, command
  strip, console send, flash, connect) is disabled the same way it is
  when no link is open, and `WsProvider.send` reports a host-style
  console line ("not connected to the host") instead of dropping
  silently.
- On reconnect, request a fresh snapshot (the server sends one on
  connect already) and drop stale per-endpoint "open" state until it
  arrives, so a stale open flag can never enable a button against a
  socket that isn't there.
- Tests: FakeSocket close → banner shown, controls disabled, a send
  produces the console line; emitOpen → banner gone.
