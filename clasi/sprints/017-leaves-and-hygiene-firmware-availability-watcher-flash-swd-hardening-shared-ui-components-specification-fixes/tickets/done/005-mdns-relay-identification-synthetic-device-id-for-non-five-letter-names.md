---
id: '005'
title: 'mDNS relay identification: synthetic device id for non-five-letter names'
status: done
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

- [x] A relay whose mDNS instance name matches an already-identified
      USB relay's name still takes the existing fast path.
- [x] A relay whose mDNS instance name does not parse as a five-letter
      name gets a synthetic id via a stable hash of
      `mbrelay:<instance>` into the negative id range, instead of
      throwing.
- [x] `Store.upsertDevice`'s `deviceIdToName(id) === name` check is
      skipped when, and only when, `id < 0 && kind === 'relay'`; every
      `kind='robot'` row and every grammar-named `kind='relay'` row
      (positive/`nameToValue`-range id) still enforces the check exactly
      as before (a regression test: a `kind='robot'` row with a
      mismatched name still throws `DeviceNameMismatchError`).
- [x] The projection lists such relays under `relays[]` with
      `transport: mbrelay`; the UI shows them as relay cards.
- [x] A fake `_mbrelay._tcp` advertisement named `torture` produces a
      relay device + card.
- [x] A bridge through the `torture` relay still works.
- [x] Aging removes the `torture` relay's link like any other relay
      once `last_seen` ages out.
- [x] A table test covers the mdnsWatcher fast path (five-letter name)
      and the fallback path (non-grammar name) in one test file.
- [x] A separate table test in `store/index.test.ts` covers
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

## Implementation notes

**`store/index.ts`** — `Store.upsertDevice` now computes
`skipNameCheck = input.id < 0 && input.kind === "relay"` and only runs
`deviceIdToName(input.id) === input.name` (throwing
`DeviceNameMismatchError` on mismatch) when that's `false`. A code
comment at the check and an addition to the module's own "Name/serial
consistency" doc comment both document the id-range convention
(negative ⇒ synthetic, never a real chip id) so a future reader doesn't
mistake the narrowing for a loosened invariant across the board.

**`watchers/mdnsWatcher.ts`** — `createRelayDeviceIfAbsent` now
pre-validates the name's shape with a local `FRIENDLY_NAME_PATTERN`
regex (mirroring `naming.ts`'s own private `NAME_PATTERN`, duplicated
rather than imported — same convention this file's `parseRegistryPort`
already uses for `mdnsDiscovery.ts`'s parser) *before* deciding which id
scheme to use, never via try/catch: a grammar-matching name still gets
`nameToValue(name)` (unchanged fast path), any other shape gets a new
`hashRelayNameToNegativeId(name)` — FNV-1a (32-bit) over
`mbrelay:<instance>`, mapped to `-unsigned-1` so it's always negative,
stable per name, and disjoint from both the chip-id space and
`nameToValue`'s `[0, 3124]` range.

**Audit for id→name derivation / accidental relay-merge risk**
(requested alongside the ticket's own scope) turned up one real bug
beyond the two files above: `projection.ts`'s `resolveRadio` called
`nameToRadioAddress(device.name)` unconditionally whenever a device had
no persisted radio fields — for a synthetic negative-id relay with a
non-grammar name (e.g. `torture`) this would throw immediately
(`nameToRadioAddress` calls `nameToValue` internally), crashing
`buildSnapshot` for the entire host, since `SnapshotDevice.radio` is a
required, always-concrete field on every device row. Fixed by guarding
on `device.id < 0` (the same synthetic-id convention `store/index.ts`
uses) and returning a fixed `{ channel: 0, group: 0, source: "derived"
}` placeholder instead of calling `nameToRadioAddress` — safe because
a relay's own device row is never radio-addressed in the UI
(`AppHeader.tsx` gates `RadioAddressDialog`/`WifiCredentialsDialog` on
`kind !== "relay"`). Added a projection-fixture regression test
(`projection.test.ts`) that would have caught this by asserting
`buildSnapshotFromRows` does not throw for a `torture`-named
negative-id relay row. Everything else audited (`deviceDisplay.ts`'s
`nameDisplay`, `connect/connector.ts` and `connect/relayBridger.ts`'s
own `deviceIdToName(deviceId)` calls, `swdName.ts`,
`mergeUsbPlaceholderIfAny`/`Store.mergeDevice`) either already reads
`devices.name` directly rather than deriving it from `id`, or only ever
operates on real (non-negative) chip ids from a banner/SWD read, so no
further changes were needed there; `deviceDisplay.ts` got a doc-comment
correction (no logic change) since it previously implied `devices.name`
and `deviceIdToName(id)` are always interchangeable, which is no longer
true for this new row shape.

**Tests**: `store/index.test.ts` — a new `it.each` table (negative id +
non-grammar name + `kind='relay'` → accepted; same with `kind='robot'`
→ throws; the existing 014-003 positive-id mismatch fixture, both
kinds, → throws) plus a standalone idempotency test. `mdnsWatcher.test.ts`
— the existing "tovez" (fast path) and "torture" (previously
"unassigned, without crashing") tests were merged into one `it.each`
table per the acceptance criterion; a new idempotency test (re-announce
via `onServiceChange` reattaches to the same negative id via the fast
path); the aging test now includes a `torture`-named relay alongside
the existing grammar-named one. `connect/relayBridger.test.ts` — a new
test bridges through an `mbrelay` link whose relay device row carries a
negative id (seeded the way `mdnsWatcher.ts` would write it), confirming
`createRelayBridger.bridge()` doesn't care about the relay's own id sign
(it never reads that row at all). `projection.test.ts` — a new fixture
alongside the existing grammar-named synthetic-relay one, for the
negative-id/non-grammar case, asserting no throw and the `radio`
placeholder value.

**Test commands run** (foreground, scoped per the ticket's repo rules):
`npx vitest run packages/host/src/store packages/host/src/watchers
packages/host/src/connect packages/host/src/projection.test.ts` — 21
test files, 297 tests, all passing. `npm run typecheck` — clean, no
errors. `npx vitest run packages/ui` (run because `deviceDisplay.ts` was
touched) — 29 test files, 465 tests, all passing.

No exception thrown this pass — the earlier exception (preserved above)
was resolved by the sprint's 2026-09-12 architecture revision, which
this ticket implements.
