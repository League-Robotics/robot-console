---
status: done
sprint: '016'
tickets:
- '003'
- '004'
---

# Relay sweeper: probe remembered robots over radio from an idle relay and record sightings

## Description

Stakeholder direction (2026-09-10 and 2026-09-11): when a relay is
attached and no student is using it, the host should go check the air
for remembered robots and make it obvious, quickly, which ones answer.
The earlier issue `background-roster-sweep-over-radio-and-firmware-tcp-slots.md`
captured the ask; this issue is its design under the v2 architecture.

Key fact that changes the design (architecture §7.1, verified in
`microbit-radio-relay/docs/radio-relay-protocol.md` §2, §3.1 and
`source/relay/RadioRelay.cpp:953`): the relay's **command plane already
has the radio live**. `> <text>` sends one line over the radio, `< <text>`
delivers received lines, and `!CG <ch> <grp>` retunes — all without
`!GO`. A sweep therefore never enters the data plane and never needs a
reset per robot. The earlier estimate of 2–3 s per robot (reset + boot)
does not apply; a probe is ~0.5 s.

Remaining constraint: every `!CG` is persisted to flash by the relay
firmware (`saveConfig()` skips only unchanged values,
`RadioRelay.cpp:194-217`). A sweep retuning every few seconds would write
flash thousands of times a day. rearch-12 requests a non-persisting
tune; until it ships, the sweeper rate-limits itself.

## Proposed resolution

- `packages/host/src/watchers/relaySweeper.ts` task. For each `links(usb)`
  row whose device is `kind = 'relay'`, `connected`, and has no lease:
  acquire `relay_leases.owner = 'sweep'` with an `AbortController`
  registered so a bridge (rearch-09) can revoke it.
- Candidate list: owned robots with no `connected` `usb`/`wifi`/`mbserial`
  link, ordered by oldest `sightings.at` first. Skip names whose recent
  sightings show N consecutive failures until a backoff elapses.
- Per candidate: address per rearch-08 order (override → last successful
  radio sighting → derived; **no registry GET during sweeps**).
  `!CG ch grp` → wait for `# channel: ch group: grp` (≤ 500 ms, using
  the exported `setChannelGroup` step from rearch-04). `> ID` → wait
  ≤ 500 ms for a `< id …` line (parse with `parseIdReply`) whose name
  matches. Record `sightings(radio, via_link_id = relay, ok, detail)`.
  On ok, upsert `links(radio, state = connectable, address =
  {relayLinkId, channel, group})` for the device; on fail, leave any
  existing radio link but bump its `fail_count`.
- Use `ID`, not `HELLO` (HELLO resets sequence state of any robot on
  that channel mid-session with another host) and not `PING` (no
  identity; 125 names share a channel).
- Rate limit: without firmware support for a non-persisting tune, at
  most one `!CG` per relay per `SWEEP_MIN_INTERVAL_MS` (default 30 s),
  so a full pass over 20 robots takes ~10 min and flash sees ≤ 2,880
  writes/day. When the firmware advertises the transient tune (rearch-12
  adds a capability line to `?`), drop the interval to 2 s.
- After the list is exhausted, release the lease, sleep a quiet period,
  re-acquire. Between probes check the abort signal; on abort finish the
  current wait (≤ 500 ms), release, and return.
- If the relay does not answer `?` on lease acquisition (parked in the
  data plane by a previous crash), perform the rearch-09 reset step
  once, then continue.
- Projection/UI: relay card shows "idle · sweeping <name>" or "idle";
  robot cards show a `Radio via <relay>` row with state and
  "last checked <time>"; `devices.lastChecked` from the newest sighting.
- Heartbeat a `tasks` row per probe.

## Acceptance

- Fake relay that answers `!CG` with the echo line and `> ID` for a
  subset of names: after one pass, `sightings` has one row per
  candidate, `links(radio)` rows exist for the answering subset in state
  `connectable`, and the non-answering ones have `fail_count = 1`.
- Abort during a probe: lease released within 600 ms of abort; no
  further writes to the fake relay.
- Rate limit: with the default interval, the fake relay sees no two
  `!CG` writes closer than the interval; with the capability flag set,
  the interval drops.
- A sweep never writes `!GO` or `HELLO` to the fake relay.
- Front page renders "last checked" and the radio row from a snapshot
  fixture.

## Depends on

rearch-01, rearch-04, rearch-05, rearch-09. rearch-12 (firmware) lifts
the rate limit but is not required.

## References

- `docs/design/architecture.md` §7
- `docs/design/usecases.md` UC-015, UC-016
- `docs/reviews/2026-09-11/02-host-transport.md` §7 (pre-dates the `>` finding; the reset-per-robot cost there is superseded)
- `docs/reviews/2026-09-11/05-protocol.md` §4 (helpers the sweep needs from protocol)
- `clasi/issues/background-roster-sweep-over-radio-and-firmware-tcp-slots.md`
