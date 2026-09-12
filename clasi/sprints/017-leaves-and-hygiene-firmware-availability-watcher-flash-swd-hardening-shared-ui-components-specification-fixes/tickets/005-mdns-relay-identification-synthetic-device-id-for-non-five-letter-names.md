---
id: '005'
title: 'mDNS relay identification: synthetic device id for non-five-letter names'
status: in-progress
use-cases:
- SUC-005
depends-on: []
github-issue: ''
issue: relay-names-outside-five-letter-grammar-get-no-device-row.md
completes_issue: true
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# mDNS relay identification: synthetic device id for non-five-letter names

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

## Acceptance Criteria

- [ ] A relay whose mDNS instance name matches an already-identified
      USB relay's name still takes the existing fast path.
- [ ] A relay whose mDNS instance name does not parse as a five-letter
      name gets a synthetic id via a stable hash of
      `mbrelay:<instance>` into the negative id range, instead of
      throwing.
- [ ] The projection lists such relays under `relays[]` with
      `transport: mbrelay`; the UI shows them as relay cards.
- [ ] A fake `_mbrelay._tcp` advertisement named `torture` produces a
      relay device + card.
- [ ] A bridge through the `torture` relay still works.
- [ ] Aging removes the `torture` relay's link like any other relay
      once `last_seen` ages out.
- [ ] A table test covers both the fast path (five-letter name) and
      the fallback path (non-grammar name) in one test file.

## Implementation Plan

**Approach**: Add the negative-range hash fallback inside
`createRelayDeviceIfAbsent`, gated behind a check for whether
`nameToValue` would throw (or a pre-validation of the name shape
before calling it) rather than relying on try/catch as the control
flow. Keep the function's existing fast-path behavior for grammar-
matching names unchanged.

**Files to modify**:
- `packages/host/src/watchers/mdnsWatcher.ts` —
  `createRelayDeviceIfAbsent`'s id-generation fallback.
- `packages/host/src/watchers/mdnsWatcher.test.ts` — table test for
  both paths; `torture`-named fixture.

**Testing plan** (scoped vitest run: `watchers/mdnsWatcher.test.ts`):
- Fake `_mbrelay._tcp` advertisement named `torture` → device row
  created with a negative synthetic id, `kind='relay'`.
- Fake `_mbrelay._tcp` advertisement with a five-letter name matching
  an already-identified USB relay → existing fast path taken, same id
  as the USB-identified device.
- Bridge-through test (reusing existing relay-bridge test harness)
  against the `torture` fixture succeeds.
- Aging test: `last_seen` past TTL → link marked `stale`, same as any
  other relay.

**Documentation updates**: None; `architecture.md` §4's data model
already allows any `INTEGER PRIMARY KEY` value for `devices.id` and
doesn't need updating for a same-shape id-generation change.
