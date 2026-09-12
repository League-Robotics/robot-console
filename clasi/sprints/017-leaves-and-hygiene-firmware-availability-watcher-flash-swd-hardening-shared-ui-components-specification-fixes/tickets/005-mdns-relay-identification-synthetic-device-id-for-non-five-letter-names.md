---
id: '005'
title: 'mDNS relay identification: synthetic device id for non-five-letter names'
status: open
use-cases:
- SUC-005
depends-on: []
github-issue: ''
issue: relay-names-outside-five-letter-grammar-get-no-device-row.md
completes_issue: true
exception:
  thrown_by: programmer
  thrown_at: '2026-09-12T18:16:49.145656+00:00'
  attempted: "Read mdnsWatcher.ts's createRelayDeviceIfAbsent/handleMbrelay, store/index.ts's\
    \ upsertDevice, and packages/protocol/src/naming.ts's deviceIdToName/nameToValue\
    \ to design the negative-hash-id fallback the plan describes. Before writing code,\
    \ traced what upsertDevice would do with a hash-derived negative id paired with\
    \ a non-grammar relay name (e.g. \"torture\"): Store.upsertDevice (store/index.ts:424-428)\
    \ unconditionally asserts deviceIdToName(id) === name and throws DeviceNameMismatchError\
    \ otherwise. deviceIdToName (naming.ts:45-56) truncates any id via `>>> 0` and\
    \ always produces a well-formed five-letter grammar string for any integer, so\
    \ no hash/id choice can ever make it equal \"torture\". Verified empirically in\
    \ a scratch script: FNV-1a of \"mbrelay:torture\" mapped into the negative range\
    \ decodes to \"gegug\", not \"torture\". Also checked every other production upsertDevice\
    \ caller (usbWatcher.ts) and confirmed none has ever written a devices row whose\
    \ name disagrees with deviceIdToName(id) \u2014 the invariant has held universally\
    \ since it was introduced in 014-003, so this isn't a corner case with an existing\
    \ workaround to copy."
  conflict: "sprint.md's own Design Rationale (\"Decision: synthetic relay id via\
    \ stable hash, not a new devices.id_source column\") chose between two alternatives,\
    \ both of which require Store.upsertDevice to accept a devices row whose name\
    \ (the mDNS instance name, e.g. \"torture\", which the ticket requires as the\
    \ relay's display name) does not decode from its id via deviceIdToName. Store.upsertDevice\
    \ (packages/host/src/store/index.ts:424-428, DeviceNameMismatchError) forbids\
    \ this unconditionally for every device, a deliberate invariant introduced in\
    \ ticket 014-003 and cross-referenced from docs/reviews/2026-09-11/05-protocol.md\
    \ \xA72 item 6 (which found a real name/id mismatch bug this check exists to catch).\
    \ The sprint architecture never reconciled its chosen id scheme with this invariant,\
    \ so the fallback as specified will throw DeviceNameMismatchError on every non-grammar\
    \ relay name it's meant to fix. Resolving it requires changing store/index.ts's\
    \ consistency check (e.g. scoping it to kind==='robot' only) \u2014 a store-layer\
    \ decision outside this ticket's file scope (mdnsWatcher.ts / its test) and a\
    \ call that trades off against the exact corruption class that review flagged."
  surface: internal
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# mDNS relay identification: synthetic device id for non-five-letter names

**Resolved by architecture revision 2026-09-12** — see `sprint.md`'s
`## Revision` note and the new Design Rationale entry. The exception
above is preserved as the historical record of what was found; the
Description/Acceptance Criteria/Implementation Plan below have been
rewritten to match the resolved decision.

## Description

`watchers/mdnsWatcher.ts`'s `createRelayDeviceIfAbsent` mints a
synthetic device id with `nameToValue(name)`, which only accepts the
five-letter micro:bit name grammar. The bench mbrelay pool is named
`torture`; the call throws, is caught, and the link is left
unassigned — the relay never gets a `devices` row, never appears as a
card, and cannot be swept or shown as idle. This ticket gives every
mDNS-discovered relay a device row regardless of name shape: keep the
existing fast path for relays whose name matches an already-identified
USB relay, and fall back to a stable hash of `mbrelay:<instance>` into
the negative id range (same `devices.id INTEGER PRIMARY KEY` shape, no
schema change) instead of throwing.

That fallback pairs a negative id with a non-grammar name, which
`Store.upsertDevice`'s existing `deviceIdToName(id) === name` assertion
(`store/index.ts:424-428`, `DeviceNameMismatchError`) unconditionally
rejects — `deviceIdToName` always produces a well-formed five-letter
name for any integer, so no id choice can ever satisfy it for a name
like `torture`. This ticket therefore also narrows that check: it is
skipped only when `id < 0 && kind === 'relay'` (negative ids are never
real chip ids — `FICR.DEVICEID[1]` is unsigned 32-bit — so a negative id
is unambiguously synthetic). Every other row shape (all `kind='robot'`
rows, and grammar-named `kind='relay'` rows via the existing
`nameToValue` fast path) is asserted exactly as before, unchanged.

## Acceptance Criteria

- [ ] A relay whose mDNS instance name matches an already-identified
      USB relay's name still takes the existing fast path.
- [ ] A relay whose mDNS instance name does not parse as a five-letter
      name gets a synthetic id via a stable hash of
      `mbrelay:<instance>` into the negative id range, instead of
      throwing.
- [ ] `Store.upsertDevice`'s `deviceIdToName(id) === name` check is
      skipped when, and only when, `id < 0 && kind === 'relay'`; every
      `kind='robot'` row and every grammar-named `kind='relay'` row
      (positive/`nameToValue`-range id) still enforces the check exactly
      as before (a regression test: a `kind='robot'` row with a
      mismatched name still throws `DeviceNameMismatchError`).
- [ ] The projection lists such relays under `relays[]` with
      `transport: mbrelay`; the UI shows them as relay cards.
- [ ] A fake `_mbrelay._tcp` advertisement named `torture` produces a
      relay device + card.
- [ ] A bridge through the `torture` relay still works.
- [ ] Aging removes the `torture` relay's link like any other relay
      once `last_seen` ages out.
- [ ] A table test covers the mdnsWatcher fast path (five-letter name)
      and the fallback path (non-grammar name) in one test file.
- [ ] A separate table test in `store/index.test.ts` covers
      `upsertDevice`'s narrowed check: negative id + non-grammar name +
      `kind='relay'` → accepted; negative id + non-grammar name +
      `kind='robot'` → still throws; positive/chip id + mismatched name
      (any kind) → still throws (the existing 014-003 regression
      fixture, protocol review §2 item 6, must keep passing unchanged).

## Implementation Plan

**Approach**: Two coordinated changes:
1. Add the negative-range hash fallback inside
   `createRelayDeviceIfAbsent`, gated behind a check for whether
   `nameToValue` would throw (or a pre-validation of the name shape
   before calling it) rather than relying on try/catch as the control
   flow. Keep the function's existing fast-path behavior for grammar-
   matching names unchanged.
2. In `Store.upsertDevice`, narrow the `deviceIdToName(input.id) ===
   input.name` assertion so it is not evaluated (or its failure is not
   thrown) when `input.id < 0 && input.kind === 'relay'`. Add a code
   comment at the check documenting the id-range convention (negative
   ⇒ synthetic, never a real chip id) so a future reader does not
   mistake the narrowing for a loosened invariant across the board.

**Files to modify**:
- `packages/host/src/watchers/mdnsWatcher.ts` —
  `createRelayDeviceIfAbsent`'s id-generation fallback.
- `packages/host/src/watchers/mdnsWatcher.test.ts` — table test for
  both paths; `torture`-named fixture.
- `packages/host/src/store/index.ts` — narrow `upsertDevice`'s name/id
  consistency check (see Description).
- `packages/host/src/store/index.test.ts` — table test for the
  narrowed check, plus a regression case confirming the existing
  014-003 mismatch fixture (protocol review §2 item 6) still throws for
  a `kind='robot'` row.

**Testing plan** (scoped vitest run: `watchers/mdnsWatcher.test.ts` and
`store/index.test.ts`):
- Fake `_mbrelay._tcp` advertisement named `torture` → device row
  created with a negative synthetic id, `kind='relay'`.
- Fake `_mbrelay._tcp` advertisement with a five-letter name matching
  an already-identified USB relay → existing fast path taken, same id
  as the USB-identified device.
- Bridge-through test (reusing existing relay-bridge test harness)
  against the `torture` fixture succeeds.
- Aging test: `last_seen` past TTL → link marked `stale`, same as any
  other relay.
- `store/index.test.ts`: `upsertDevice({ id: -1, name: 'torture', kind:
  'relay', ... })` succeeds and is idempotent (second call with the same
  args is a no-op update, not a throw); `upsertDevice({ id: -1, name:
  'torture', kind: 'robot', ... })` still throws
  `DeviceNameMismatchError`; the existing 014-003 mismatch fixture
  (positive chip id, wrong name) still throws for both kinds.

**Documentation updates**: None in `docs/design/` — `sprint.md`'s own
Architecture section (Design Rationale, Step 3 Modules table, and the
2026-09-12 Revision note) already carries the narrowed-invariant
decision; no consolidated `architecture.md` update is in this ticket's
scope (that happens at consolidation, not per-ticket). Add the one code
comment on the narrowed check itself (see Approach).
