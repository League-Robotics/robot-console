---
id: '006'
title: 'Connector: merge known-robots placeholder on first non-USB identification'
status: done
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

- [x] On any transport's first identification, the connector checks
      for exactly one placeholder row (synthetic id, no `usb_serial`)
      sharing the banner's name.
- [x] A name match merges the placeholder into the real row via
      `Store.mergeDevice`, carrying `owned` across.
- [x] A name mismatch (e.g. vevov vs. vevav) is a no-op — no merge,
      both rows remain.
- [x] Seeded placeholder `gopiv` + fake `mbserial` identify of `gopiv`
      → one row, `owned = 1`, no orphaned links or sightings.
- [x] Table tests cover usb, mbserial, and wifi identification paths
      plus the name-mismatch no-op.
- [x] The UI's `forget-device` remains the manual escape hatch for
      stale placeholders (unchanged — verify no regression).
- [x] The placeholder-candidate query is scoped to `kind === 'robot'`:
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

## Implementation notes

**`connect/connector.ts`** — added a sibling to the existing
`mergeUsbPlaceholderIfAny`, `mergeNamePlaceholderIfAny(store, name,
deviceId, at)`, called unconditionally after the USB-serial merge
whenever the just-identified device's own `kind === 'robot'` (never for
a `kind === 'relay'` identify — a relay identifying is never something a
known-robots placeholder could match, and gating here avoids even
running the query in that case). Its candidate query is:

```
kind === 'robot' && name === <banner name> && usb_serial == null && id !== deviceId
```

Deliberately **not** an additional `id === nameToValue(name)` check,
despite the ticket's own Implementation Plan suggesting it as "a good
test": since `devices.id` is a primary key, requiring an *exact* id
match would make it mathematically impossible for two rows to ever
satisfy the full candidate predicate simultaneously (both would need
the identical `id`) — which would make the ticket's own "ambiguous,
2+ placeholders → no automatic merge" acceptance criterion untestable
and, worse, unreachable in production too (an exact-id-match query can
never return more than one row, since two rows can't share a primary
key). `usb_serial IS NULL` combined with `kind === 'robot'` and the name
match is the operative discriminator instead: it is what already
distinguishes a mergeable known-robots placeholder from (a) a row
already correlated by USB serial (handled by the existing, unchanged
first check) and (b) any `kind='relay'` row (ticket 005's negative-id
mDNS-hash rows), and it is exactly what the existing regression test
("is a no-op for a non-usb identify, even if a placeholder shares that
device's own usb_serial") already required — that placeholder carries a
`usb_serial`, so it is correctly excluded from the new name-based
candidate pool too, or that pre-existing test would have started
failing. Verified empirically (`node -e` against the `naming.ts`
algorithm) that `deviceIdToName` only depends on `id mod 3125`, so two
distinct ids (e.g. `1461` and `1461 + 3125 = 4586`) can both decode to
the same name and both legitimately pass `upsertDevice`'s own
`kind='robot'` name/id invariant — this is exactly how the "ambiguous"
test constructs its second candidate row.

**`connect/connector.test.ts`** — a new `describe` block adds:
an `it.each` table over usb/mbserial/wifi, each seeding a `gopiv`
placeholder (id `1461` = `nameToValue("gopiv")`, `owned: 1`, no
`usb_serial`) and identifying as the real bench chip id `2175407711`
(`deviceIdToName(2175407711) === "gopiv"`, sprint 016 ticket 008's own
bench evidence) — asserts one merged row, `owned: 1`, and the link
re-pointed at the real id; a name-mismatch no-op (`vevov` banner against
a `gopiv` placeholder, both rows survive); an ambiguous case (two
`gopiv`-named, no-`usb_serial`, `kind='robot'` rows — ids `1461` and
`4586` — present when a real `gopiv` identifies; all three rows survive,
neither placeholder touched); and a `kind='relay'` row (synthetic
negative id `-1`, per ticket 005's own `id < 0 && kind === 'relay'`
exemption from the name/id invariant) sharing the name `gopiv` with an
identifying robot — never picked up as a candidate, both rows survive.

**Test commands run** (foreground, scoped per the ticket's repo rules):
`npx vitest run packages/host/src/connect packages/host/src/store
packages/host/src/server.test.ts
packages/host/src/mbserialEndToEnd.test.ts` — 18 test files, 238 tests,
all passing (confirmed `server.ts: forget-device > deletes the device
via store.deleteDevice` still passes unchanged, satisfying the
`forget-device`-regression acceptance criterion). `npm run typecheck` —
clean, no errors.

No exception thrown.
