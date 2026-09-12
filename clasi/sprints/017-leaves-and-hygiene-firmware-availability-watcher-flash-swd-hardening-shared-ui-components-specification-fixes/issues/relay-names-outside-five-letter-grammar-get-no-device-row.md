---
status: in-progress
sprint: '017'
tickets:
- 017-005
---

# Relays whose mDNS name is not a valid five-letter micro:bit name never get a `devices` row

## Description

`watchers/mdnsWatcher.ts`'s `createRelayDeviceIfAbsent` (sprint 016
ticket 005) mints a synthetic device id with `nameToValue(name)`, which
only accepts the five-letter micro:bit name grammar. The bench mbrelay
pool is named `torture`, so the call threw; ticket 008 wrapped it in a
try/catch that leaves the link unassigned. Result: a bridge through
`torture` works, but `torture` never appears as a relay card, has no
`relays[]` entry, no lease, and cannot be swept or shown as idle.

## Proposed resolution

- Give mDNS-discovered relays a synthetic id that does not depend on the
  micro:bit name grammar (e.g. a stable hash of `mbrelay:<instance>`
  into the negative id range, or a dedicated `devices.id_source`
  column), keeping the existing fast path for relays whose name matches
  an already-identified USB relay.
- Projection lists such relays under `relays[]` with `transport:
  mbrelay`; the UI shows them as relay cards.
- Table test with `torture` and a five-letter name.

## Acceptance

- A fake `_mbrelay._tcp` advertisement named `torture` produces a relay
  device + card; a bridge through it still works; aging removes it.

## Depends on

Sprint 016 (rearch-11). Suggested for sprint 017.

## References

- `clasi/sprints/016-*/tickets/done/008-*.md` Bench evidence
