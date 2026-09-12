---
id: '006'
title: 'Connector: merge known-robots placeholder on first non-USB identification'
status: in-progress
use-cases:
- SUC-006
depends-on: []
github-issue: ''
issue: placeholder-merge-for-non-usb-transports.md
completes_issue: true
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Connector: merge known-robots placeholder on first non-USB identification

## Description

`connect/connector.ts`'s `mergeUsbPlaceholderIfAny` collapses a
`known-robots.json`-seeded placeholder into the real chip-id row by
matching the USB descriptor serial. A robot first identified over
`mbserial` or `wifi` has no USB serial to match, so the placeholder
(synthetic id, `owned: 1`) and the real row (`owned: 0`) coexist —
seen on the bench for `gopiv` (placeholder 1461 vs. real 2175407711).
This ticket generalizes the merge to any transport's first
identification: if exactly one placeholder row (synthetic id, no
`usb_serial`) shares the banner's name, merge it into the real row via
the existing `Store.mergeDevice`, carrying `owned` across; if names
differ (the vevov/vevav case), do nothing.

## Acceptance Criteria

- [ ] On any transport's first identification, the connector checks
      for exactly one placeholder row (synthetic id, no `usb_serial`)
      sharing the banner's name.
- [ ] A name match merges the placeholder into the real row via
      `Store.mergeDevice`, carrying `owned` across.
- [ ] A name mismatch (e.g. vevov vs. vevav) is a no-op — no merge,
      both rows remain.
- [ ] Seeded placeholder `gopiv` + fake `mbserial` identify of `gopiv`
      → one row, `owned = 1`, no orphaned links or sightings.
- [ ] Table tests cover usb, mbserial, and wifi identification paths
      plus the name-mismatch no-op.
- [ ] The UI's `forget-device` remains the manual escape hatch for
      stale placeholders (unchanged — verify no regression).
- [ ] The placeholder-candidate query is scoped to `kind === 'robot'`:
      a synthetic `kind='relay'` device row (ticket 005's negative-id
      mDNS fallback, or the existing grammar-named `nameToValue` relay
      row) is never treated as a mergeable placeholder, even if its name
      happened to match an identified robot's banner name. Add a test:
      a `kind='relay'` row sharing a name with an identified robot's
      banner → no merge (both rows remain), alongside the existing
      name-mismatch no-op case.

## Implementation Plan

**Approach**: Generalize `mergeUsbPlaceholderIfAny`'s matching logic
(currently keyed on USB serial) to also accept a name-based match when
no USB serial is available, gated to firing only when there is exactly
one candidate placeholder — ambiguous matches (more than one
placeholder with that name) are left alone rather than guessed at. The
name-based candidate query must filter to `kind === 'robot'` explicitly
(not only "no `usb_serial`") — ticket 005 (2026-09-12 revision) confirms
`devices` can now hold `kind='relay'` rows with no `usb_serial` and a
synthetic id, which must never be mistaken for a robot placeholder here.

**Files to modify**:
- `packages/host/src/connect/connector.ts` — generalize the merge
  trigger to run on any transport's first identification, not only
  USB; scope the name-based candidate query to `kind === 'robot'`.
- `packages/host/src/connect/connector.test.ts` — table tests for
  usb/mbserial/wifi merge paths, the name-mismatch no-op, and the
  relay-row-must-not-merge case.

**Testing plan** (scoped vitest run: `connect/connector.test.ts`):
- Seeded placeholder `gopiv` (synthetic id, `owned=1`, no
  `usb_serial`) + fake `mbserial` identification banner named `gopiv`
  → merged to one row, `owned=1`, no orphaned `links`/`sightings` rows.
- Same fixture over `wifi` → same result.
- Same fixture over `usb` → existing behavior preserved (regression
  check).
- Placeholder `vevov` + identification banner `vevav` → no merge, both
  rows present.
- Two placeholders sharing a name (ambiguous case) → no automatic
  merge (documented as intentionally conservative; `forget-device`
  remains the manual path).
- A `kind='relay'` device row (synthetic id, no `usb_serial`) sharing a
  name with an identified robot's banner → no merge, both rows remain
  (guards against ticket 005's negative-id relay rows being picked up
  here).

**Documentation updates**: None; `Store.mergeDevice`'s existing
behavior and `architecture.md`'s data model are unchanged.
