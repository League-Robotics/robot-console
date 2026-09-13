---
status: pending
---

# Stale radio links and duplicate robot rows persist and clutter every card

## Evidence (team-lead, 2026-09-13, stakeholder's real state dir `~/.local/state/robot-console/console.sqlite`)

- Radio links created by the sweeper/bridger yesterday are never aged or removed:
  `radio-gopiv-via-usb-…2e78…` `failed` "cannot open /dev/cu.usbmodem2121202", last seen
  849 min ago; `radio-vevov-via-usb-…2e78…`, `radio-tovez-via-usb-…2e78…` `discovered`,
  849 min. The relay behind them (vevav) has since moved to `/dev/cu.usbmodem2121402`.
  The gopiv card lists two such radio rows with 14-hour-old errors and Connect buttons.
- A radio link's failure text names a USB path that no longer belongs to that relay.
- Duplicate robot rows survive in an existing database: `gopiv 1461` (known-robots
  placeholder, `owned 1`) and `gopiv 2175407711` (real, `owned 0`). The mbserial and
  radio links hang off the placeholder, so the real row is un-owned. Fixes from 017-006
  and 017-010 only merge at identify/SWD time; a database created before them is never
  repaired.
- `mbserial-tovez` has `device_id: null` and is `stale` for 177 min.

## Expected

- Radio links age like mDNS links: a radio link whose relay link is gone/stale, or with
  no successful sighting within a TTL, becomes `stale` and is hidden from cards.
- A radio link's address resolves the relay's *current* transport at connect time; stale
  failure text is cleared when the relay's address changes.
- On store open, a one-time repair merges placeholder rows (`id === nameToValue(name)`,
  `kind robot`) into a real row of the same name and re-points links, carrying `owned`.
