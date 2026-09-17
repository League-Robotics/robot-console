---
status: in-progress
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


## Reproduced on an exclusive bench (team-lead, 2026-09-17)

Sprint 018 closed without this fix; the issue returns to the pool for the
next sprint. The full harness ran on a genuinely exclusive bench that day
(the stakeholder stopped his own `npm run dev`, pid 38933; the report's
"Holders / skips" section reads "No resources held by another process at
Layer 1 run time" — 0 skipped, 0 contention), so the evidence below is
free of the contention that muddied every earlier attempt.

**Not exercised at all on this run**: there were **no USB serial devices
attached to the Mac** (`/dev/cu.usbmodem*` empty; `ioreg` shows
`AppleUSBSerial = 0`), so both Mac USB relays (`vitut`, `vevav`) were off
the bus. `vitut` and `tovez` appear in the console's "Not seen recently"
group, and the two `radio-via-mbrelay:torture` rows for them were labeled
`environment` (_"timeout: no radio reply"_), not `defect`.

This issue therefore remains **unreproduced-on-a-clear-bench**: the
sweeper-vs-session port race needs a physically attached USB relay. Before
implementing, plug `vitut` (and/or `vevav`) back in and confirm the race
still occurs — the relay sweeper and lease-revocation seam have both been
touched since the issue was filed (018-009, 018-010's
`clearDeadProcessState` repair, which now resets stale `relay_leases` and
`board_owner` rows on store open and may have changed this issue's shape).


## Carried forward from sprint 018, ticket 012 (team-lead, 2026-09-17)

Sprint 018 planned this work as ticket 012 ("Relays and WiFi robots are
reachable without races"). **No implementation ever landed** — only the
planner's ticket-creation commit (`cc0e868`). At the stakeholder's
direction the sprint closed on what was actually done and this work moves
to the next sprint, where it will be re-ticketed from this issue. The
retired ticket's own analysis and implementation plan are preserved in git
history at that commit, and the design direction it settled on is worth
keeping:

- **Relay contention**: extend the `relayLeaseRevocation` takeover seam
  (016-004) so a *direct* console `session-open {linkId: <relay usb link>}`
  goes through the same lease-takeover path bridging already uses, instead
  of opening the raw port independently and racing the sweeper's ~30 s
  probe. Distinguish "our own sweeper holds it" (take over, no error) from
  "another *process* holds it" (a distinct plain-language reason — "another
  app has this relay open", never "Cannot lock port").
- **WiFi discovery**: give whichever module owns "an owned robot has no
  `wifi` link" a bounded, off-hot-path `dns.lookup(<name>.local, {family:
  4})` fallback, confirmed by dialing TCP 7654 and checking for `HELLO`
  before creating the link — the same IPv4-first approach 018-007 / SUC-004
  established for dialing an *existing* link, applied to creating one.

Both defects share a shape worth restating: something the host already does
correctly in one path needs to also happen in a second path that currently
has no such guarantee.
