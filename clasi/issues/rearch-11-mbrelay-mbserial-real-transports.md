---
status: pending
sprint: '016'
---

# Make the remote mbrelay and mbserial transports real: discovered as links, connectable through the one connector

## Description

Both network transports exist as code but neither works end to end
(`01-host-device-model.md` §2.3):

- `MbrelayLink` and `MbrelayCandidate` exist, but neither
  `buildSingleCandidate` (`deviceRegistry.ts:2035-2052`) nor
  `buildDefaultFailoverCandidates` (`:2069-2110`) ever emits an
  `"mbrelay"` candidate. **The mbrelay transport is dead.**
- `_mbserial._tcp` robots become connectable **only** as tail candidates
  of a local USB relay's default failover (`:2095-2107`), i.e. only when a
  student presses Connect on a relay with no name picked. There is no
  direct "connect to this discovered mbserial robot".
- Remote `_mbrelay._tcp` discoveries are used solely to find a registry
  port when the instance name happens to match a *locally attached*
  relay's SWD name (`:2015-2026`).

Stakeholder decision (2026-09-11): reinvigorate both. In the v2
architecture they are just another watcher's rows plus connector
support, so the cost is low.

## Proposed resolution

- mDNS watcher (rearch-03) already upserts `links(mbserial)` per
  `_mbserial._tcp` instance (robot name) and `links(mbrelay)` per
  `_mbrelay._tcp` instance (a relay *pool*, with `registry` port). This
  issue adds:
- **mbserial**: device linking by name to an owned robot (same rule as
  WiFi: one owned device with that name, else hidden). Connector opens a
  `tcpStream` to `host:port` with no preamble, HELLO, identify. Link
  preference `usb > wifi > mbserial > radio > mbrelay` (architecture §8)
  so an mbserial-only robot auto-connects. Age and address-change
  handling come from rearch-03.
- **mbrelay** (a remote relay pool reached over TCP on :8760 with the
  same command grammar as the USB relay, `TCP_NODELAY` required): model
  the pool as a `devices(kind='relay')` row named by the mDNS instance
  (pool host), with one `links(mbrelay)` row. Bridging through it reuses
  `relayBridger` (rearch-09) with the `tcpStream` adapter and the
  preamble; the reset step for a TCP relay is disconnect+reconnect (the
  spec §6 note: a break cannot be sent over TCP). A child radio link
  through an mbrelay pool has `address = {relayLinkId, channel, group}`
  exactly like a local relay.
- Registry: `mbrelayRegistry.ts`'s three-outcome resolver stays. Its
  location comes from the pool's `links.address.registryPort`, not from
  matching a local relay's name. Cache moves from the module singleton
  (`:154`) into the store (`devices.radio_*` with `source = 'registry'`
  when authoritative) or an injected cache.
- The relay page and front-page relay card render an mbrelay pool the
  same way as a USB relay (Connect a robot, Disconnect), with the label
  "Network relay · <host>".
- Sweeping through an mbrelay pool is out of scope for this issue (a
  shared classroom pool must not be commandeered by one host); the
  sweeper only uses `links(usb)` relays.

## Acceptance

- Fake mDNS backend advertises `_mbserial._tcp` for an owned robot →
  `links(mbserial, connectable)`; reconciler connects when no USB/WiFi
  link is connected; the robot page opens over it.
- Same advertisement for an un-owned name → hidden, no connection.
- Fake `_mbrelay._tcp` with `registry=8761` → a relay-pool device and
  link; a bridge through it runs the preamble over the fake TCP stream
  with `NODELAY` set and reconnects (not break) as its reset step;
  registry lookups go to the advertised port.
- Removing the advertisement ages both link kinds out.
- `grep -rn "mbrelay" packages/host/src/connect` shows the transport is
  handled by the shared connector/bridger, not a separate class.

## Depends on

rearch-03, rearch-04, rearch-05, rearch-09.

## References

- `docs/design/architecture.md` §2, §6.2, §8
- `docs/reviews/2026-09-11/01-host-device-model.md` §2.3
- `docs/reviews/2026-09-11/02-host-transport.md` §1 (MbrelayLink/MbserialLink rows), §6
- `docs/design/specification.md` §4.3, §6 (registry traps)
