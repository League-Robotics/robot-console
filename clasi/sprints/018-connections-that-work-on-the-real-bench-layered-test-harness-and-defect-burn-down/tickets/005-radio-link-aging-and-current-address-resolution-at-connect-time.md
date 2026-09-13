---
id: '005'
title: Radio link aging and current-address resolution at connect time
status: open
use-cases:
- SUC-003
depends-on:
- '003'
github-issue: ''
issue: bench-stale-radio-links-and-duplicate-rows-persist.md
completes_issue: false
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Radio link aging and current-address resolution at connect time

## Description

First half of the radio-hygiene fix (SUC-003); ticket 006 does the
one-time duplicate-row repair. Evidenced live on the stakeholder's real
state dir: radio links created by the sweeper/bridger yesterday are
never aged or removed (`radio-gopiv-via-usb-…2e78…` `failed`, "cannot
open /dev/cu.usbmodem2121202", `last_seen` 849 min ago;
`radio-vevov-via-usb-…2e78…`/`radio-tovez-via-usb-…2e78…` `discovered`,
849 min) — the relay behind them (`vevav`) has since moved to
`/dev/cu.usbmodem2121402`, so the failure text names a USB path that no
longer belongs to that relay.

Two fixes, both in the radio-link lifecycle:

1. **Aging**: a radio link whose relay link is gone or `stale`, or that
   has had no successful sighting within a TTL, becomes `stale` and is
   hidden from cards — the same rule already applied to mDNS links per
   `docs/design/architecture.md` §6.2 ("Age every type with `WHERE
   last_seen < now - ttl`").
2. **Current-address resolution**: a radio link's address resolves the
   relay's *current* transport (not a cached one) at connect time, so a
   relay that has moved USB paths does not leave stale failure text
   behind; when the relay's address changes, previously stale failure
   text on its radio links is cleared.

## Acceptance Criteria

- [ ] A radio link whose relay link is gone or `stale`, or with no
      successful sighting within its TTL, transitions to `stale` and is
      excluded from the snapshot's card-visible links (same treatment
      as an aged mDNS link).
- [ ] A radio link's connect-time address lookup reads the relay's
      *current* link address, not a value cached when the radio link
      was created.
- [ ] When a relay's address changes, any radio link riding on it that
      previously carried stale failure text naming the old address has
      that text cleared (not left to read a path that no longer applies).
- [ ] Unit tests: aging past TTL with no sighting → `stale`; relay
      address change → radio link resolves the new address at next
      connect attempt and clears stale failure text.
- [ ] **Harness command and evidence**: `scripts/bench/run.sh --report
      /tmp/bench-report.md` run against a seeded state dir reproducing
      the stakeholder's real `radio-gopiv-via-usb-…` /
      `radio-vevov-via-usb-…` rows (849-minute-old failures naming a
      moved USB path); the report/Layer 2 card-truthfulness check shows
      those rows aged to `stale` and absent from the card, and a fresh
      radio link created after the relay's move resolves the relay's
      new address correctly.

## Implementation Plan

**Approach**: extend the store's link-aging sweep (already present for
mDNS links per architecture.md §6.2) to cover `radio`-transport links
using the same TTL mechanism; change the radio link's address-resolution
call site (wherever `links.address` for a `radio` link is read before
connecting) to look up the relay's current link row instead of using a
value baked in at radio-link creation time.

**Files to modify**:
- `packages/host/src/store/store.ts` (or wherever the link-aging sweep
  lives) — extend to `radio` transport
- `packages/host/src/connect/connector.ts` and/or
  `packages/host/src/connect/relayBridger.ts` — resolve the relay's
  current address at connect time rather than reading a cached value
- possibly `packages/host/src/watchers/relaySweeper.ts` if the sweeper
  is what creates/updates radio link rows

**Testing plan**: `vitest` unit tests for the aging sweep (radio TTL
case) and for current-address resolution (relay address change →
new radio connect uses new address, stale text cleared). Scoped run:
`npx vitest run packages/host/src/store packages/host/src/connect`.
Bench pass per the harness command above, run against a **copy** of the
stakeholder's real, already-affected database (never the live file).

**Documentation updates**: none beyond this ticket's completion notes;
architecture.md §6.2's aging rule already describes the intended
behavior for mDNS and this ticket extends it to radio, so no doc change
is needed unless the sprint-planner's architecture text (this sprint's
own sprint.md) needs a correction, which it does not.
