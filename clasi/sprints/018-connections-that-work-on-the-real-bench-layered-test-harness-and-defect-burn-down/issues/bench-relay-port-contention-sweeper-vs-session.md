---
status: in-progress
sprint: 018
tickets:
- 018-012
---

# Opening a relay's own USB link while the sweeper holds its port fails with "Cannot lock port"

## Evidence (team-lead, 2026-09-13)

- Harness Layer 2 (ticket 018-002/004 runs): `vitut | usb` → `never reached state "connected"
  … last seen state "failed" (Error Resource temporarily unavailable Cannot lock port)`,
  while no process held `/dev/cu.usbmodem2121202` at the instant of a one-shot `lsof`.
- 20 s of 250 ms `lsof` sampling on that port saw no holder, but the stakeholder's running
  host (`scripts/dev.mjs`, sprint 017 code) had recorded 88 radio `sightings` in the last
  10 min with `relaySweeper` heartbeating: its sweeper opens the relay's raw serial port per
  pass (~30 s cadence) and closes it, so the port is held intermittently. The harness's own
  host also runs a sweeper.
- 016-004's takeover-within-one-probe covers `session-open {relayLinkId, name}` (bridging a
  robot) aborting a sweep. A direct `session-open {linkId: <relay usb link>}` (open the
  relay's own console) does not go through that seam, so it races the sweeper and fails.

## Expected

- Any open of a relay's serial port (direct console session, bridge, flash) takes the
  relay over from an in-flight sweep through the same `relayLeaseRevocation` seam, within
  one probe, and never reports "Cannot lock port" to the student for our own sweeper.
- If the port is held by another *process*, the reason says so in plain words
  ("another app has this relay open").
- Two host processes on one machine do not silently fight: the second host detects the
  first (e.g. port-lock failure + robot-console process present) and reports it once.
