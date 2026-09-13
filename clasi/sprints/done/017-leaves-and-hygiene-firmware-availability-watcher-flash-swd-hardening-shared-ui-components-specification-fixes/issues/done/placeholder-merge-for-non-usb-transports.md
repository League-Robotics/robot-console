---
status: done
sprint: '017'
tickets:
- 017-006
---

# Known-robots placeholder rows only merge on USB identification; mbserial/WiFi identifies leave a duplicate

## Description

`connect/connector.ts`'s `mergeUsbPlaceholderIfAny` (sprint 015 ticket
003) collapses a `known-robots.json` placeholder into the real chip-id
row by matching the USB descriptor serial. A robot first identified over
`mbserial` or `wifi` has no USB serial to match, so the placeholder
(synthetic id, `owned: 1`) and the real row (`owned: 0`) coexist. Seen on
the bench for `gopiv` (placeholder 1461 vs real 2175407711) in sprint
016 ticket 008.

## Proposed resolution

- On any transport's first identification, if exactly one placeholder
  row (synthetic id, no `usb_serial`) has the same `name` as the banner,
  merge it into the real row via `Store.mergeDevice` and carry `owned`
  across; if the names differ (vevov/vevav case), do nothing.
- Table tests for usb, mbserial, wifi; the name-mismatch no-op.
- The UI's `forget-device` remains the manual escape hatch for stale
  placeholders.

## Acceptance

- Seeded placeholder `gopiv` + fake mbserial identify of `gopiv` → one
  row, `owned = 1`, no orphaned links/sightings.

## Depends on

Sprint 015 (rearch-05). Suggested for sprint 017.

## References

- `clasi/sprints/016-*/tickets/done/008-*.md` "What the stakeholder must do next" item 2
