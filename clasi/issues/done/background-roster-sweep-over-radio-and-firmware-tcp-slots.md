---
status: pending
---

# Keep the robot list solid: a background sweep that checks remembered robots over every link, including radio

## Description

Stakeholder direction, 2026-09-10: "You should have some background
process that's going through and checking what machines exist. You
listen for their DNS. You listen for when they come online. Serial:
occasionally, you look for a radio link, and you go check them on the
radio link when you can. You got to keep that list solid and up to
date."

Done out of process the same day (commits `8b5adf1`, `3ba2043`,
`9250aa1`):

- WiFi robots are connected and identified (HELLO, then ID/STATUS/FUNCS)
  the moment they are discovered, not on first click.
- A dropped or failed WiFi link is retried every 10 s.
- WiFi advertisements are aged out after 150 s of silence, and a
  returning robot fires a fresh discovery event.
- USB attach already identifies at attach time.
- The front page shows one card per robot name with every link listed.

Still missing, and the reason for this issue:

1. **Radio sweep.** When a relay is attached and idle (no student
   session through it), the host should periodically try each
   remembered robot that is not currently reachable over USB or WiFi
   through the relay (`openRobotViaRelay` with the roster's names, one
   at a time, with a short liveness probe), record the sighting, and
   surface it on the front page as "reachable over radio via <relay>".
   Constraints: never steal a relay that has a session open; keep the
   sweep slow (one name every few seconds) so a student's own handshake
   is never queued behind it; back off names that have failed several
   sweeps in a row.
2. **Remembered-but-unreachable robots** should carry a "last checked"
   time and which links were tried, so a stale card is visibly stale.
3. **WiFi link while USB is open.** Auto-connect deliberately skips a
   name that already has an open direct USB session, so the WiFi row
   for that robot reads "Not linked" even when the robot is reachable.
   Decide whether to probe it anyway (cheap: connect, HELLO, close) so
   the card says "reachable over WiFi" without holding a second session.

## Firmware note (raise with the pxt-nezha-diffdrive agent)

Observed 2026-09-10 on `vevov`: after three abrupt host restarts (each
dropping its TCP client without a clean close), the robot answered ping
but refused every new connection on port 7654, including from a plain
`nc`. It recovered only after a power cycle. That looks like the
firmware's three TCP client slots are not reclaimed when a peer
disappears without a FIN. The host cannot work around that; the
firmware should reap idle or half-open clients (keepalive, or an idle
timeout on slots that have sent nothing for a minute).

## Proposed resolution

Plan as a sprint: a `RosterSweeper` in the host owning the radio sweep
schedule and the "last checked" bookkeeping, wired into the same
`KnownRobotsStore` and `DeviceRegistry` seams the WiFi work uses, with
the front page reading the sighting data it publishes. Item 3 can be
a small ticket in the same sprint.
