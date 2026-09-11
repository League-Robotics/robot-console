---
status: pending
---

# mDNS watcher: write service and link rows, re-query periodically, age every type, follow address changes

## Description

`discovery/mdnsDiscovery.ts` has good parsers and a clean backend seam
(`:137-150, :305-355`) but the behaviour around them is why a robot that
turns on is not seen quickly (`02-host-transport.md` §4):

- `Bonjour.find()` sends one PTR query at start and never re-queries.
  A robot that boots after the host, whose single boot announcement is
  lost, is invisible until its next periodic announcement (up to 60 s).
- Only WiFi robots age out (150 s sweep, via a private-field hack on the
  library, `:198-215`). `_mbrelay` and `_mbserial` records are never
  aged; a powered-off relay stays listed forever.
- A re-announce with a **new IP** emits no `up`/`down` event; the host
  keeps dialling the old address every 10 s for up to 180 s.
- `_mbflash._tcp` from spec §4.4 is not browsed.
- Every `up`/`down` triggers a full endpoint broadcast; no coalescing.
- `stop()` keeps `relays/robots/wifiRobots` but clears `wifiLiveness`, so
  after a restart WiFi records can never age out (`:531-547`).

## Proposed resolution

- New `packages/host/src/watchers/mdnsWatcher.ts` task wrapping the
  existing `MdnsBackend` seam and parsers. Browse all five types:
  `_mbrelay._tcp`, `_mbserial._tcp`, `_mbflash._tcp`, `_robotlink._tcp`,
  `_robotlink._udp`.
- Every observation upserts `services(instance, type)` with `last_seen`,
  `host`, `port`, `txt`. Then upsert a `links` row:
  - `_robotlink.*` → `links(wifi)` keyed by TXT `name` (fallback instance
    name), address `{host, port}`; both protocols collapse to one row.
  - `_mbserial._tcp` → `links(mbserial)`; the instance name is the robot
    name (`wsMessages.ts:572-575`).
  - `_mbrelay._tcp` → `links(mbrelay)` on a `devices(kind='relay')` row
    keyed by the relay's name when it is a known relay, else an
    `unassigned` relay-pool link; store `registry=<port>` from TXT in
    the address.
  - `_mbflash._tcp` → `services` only (no link) for now.
- Call `browser.update()` on an interval (default 30 s) so a missed boot
  announcement is recovered within one interval.
- Handle SRV/TXT changes: compare the parsed address with the stored row;
  on change, update the address and, if a session is open on that link,
  `setLinkState(unresponsive, 'address changed')` so the reconciler
  reconnects.
- Age every type with `ageLinks(transport, ttl)` and
  `DELETE FROM services WHERE last_seen < now - ttl`; TTLs per type in
  one constants block. Remove the `server.mdns` private-field hack; use
  the library's `lastSeen`/`expire()` or our own `last_seen`.
- Device linking: a `wifi`/`mbserial` link attaches to a `devices` row by
  name only when exactly one owned device has that name; otherwise it
  stays unassigned and hidden (name collisions are real, architecture §4).
- Heartbeat a `tasks` row per browse cycle.

## Acceptance

- Fake backend emits `up` for a robot once, then the fake clock advances
  past the re-query interval with a second robot answering only the
  re-query → both have `links(wifi)` rows.
- Fake backend changes a robot's SRV host with no `down`/`up` → the row's
  address changes and an open session on it is marked `unresponsive`.
- Fake clock advances past each TTL with no traffic → `links` for wifi,
  mbserial, and mbrelay all go `stale`; `services` rows are gone.
- `stop()`/`start()` round-trip leaves no in-memory maps that survive
  the restart (state is in the DB).
- A `wifi` advertisement for a name that is not owned produces a
  `services` row and an unassigned link that the projection hides.

## Depends on

rearch-01.

## References

- `docs/design/architecture.md` §6.2
- `docs/reviews/2026-09-11/02-host-transport.md` §4
- `docs/reviews/2026-09-11/01-host-device-model.md` §1.3 items 5, 8; §2.2
