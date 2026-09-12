---
id: 008
title: 'mDNS watcher: service/link rows, re-query, aging, address tracking'
status: done
use-cases:
- SUC-003
- SUC-004
- SUC-006
depends-on:
- '003'
github-issue: ''
issue: rearch-03-mdns-watcher-rows-requery-aging-address-updates.md
completes_issue: true
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# mDNS watcher: service/link rows, re-query, aging, address tracking

## Description

Build `packages/host/src/watchers/mdnsWatcher.ts` wrapping the existing
`MdnsBackend` seam and parsers. Browse all five service types
(`_mbrelay._tcp`, `_mbserial._tcp`, `_mbflash._tcp`, `_robotlink._tcp`,
`_robotlink._udp`). Every observation upserts `services` and the
appropriate `links` row. Call `browser.update()` on an interval (default
30 s, per `sprint.md`'s Open Questions — flagged as tunable) so a missed
boot announcement is recovered within one interval. Handle SRV/TXT
changes: update the address and mark an open session `unresponsive` if
one exists. Age every type via `ageLinks(transport, ttl)` and delete
expired `services` rows; TTLs in one constants block. Device linking: a
`wifi`/`mbserial` link attaches to a `devices` row by name only when
exactly one owned device has that name. Heartbeat a `tasks` row per
browse cycle.

Delivers SUC-003 and SUC-004 directly; contributes to SUC-006's bench
verification.

## Acceptance Criteria

- [x] Fake backend emits `up` for a robot once; a second robot answers
      only the re-query after the fake clock advances past the interval
      → both have `links(wifi)` rows.
- [x] Fake backend changes a robot's SRV host with no `down`/`up` → the
      row's address changes and an open session on it is marked
      `unresponsive`.
- [x] Fake clock advances past each TTL with no traffic → `links` for
      wifi, mbserial, and mbrelay all go `stale`; `services` rows are
      gone.
- [x] `stop()`/`start()` round-trip leaves no in-memory maps that
      survive the restart (state is in the DB, not `wifiLiveness` or
      similar private fields).
- [x] A `wifi` advertisement for a name that is not owned produces a
      `services` row and an unassigned link.

## Testing

- **Existing tests to run**: `packages/host/src/store` (ticket 003)
  suite must still pass.
- **New tests to write**: the five acceptance-criteria scenarios above,
  each as a fake-backend/fake-clock test; a TTL-constants-block
  sanity test.
- **Verification command**: `npm test -- packages/host/src/watchers/mdnsWatcher`

## Implementation Plan

**Approach**: Wrap the existing `MdnsBackend`/parser seam rather than
rewriting it (per the issue, the parsers are sound); the watcher's own
logic is the re-query timer, aging, and row-upsert glue. Remove the
`server.mdns` private-field hack in the same pass since it's what
currently causes the `stop()`/`start()` state-survival bug.

**Files to create/modify**:
- `packages/host/src/watchers/mdnsWatcher.ts` (new).
- `packages/host/src/watchers/mdnsWatcher.test.ts` (new).
- `packages/host/src/discovery/mdnsDiscovery.ts`: remove the
  `server.mdns` private-field liveness hack (superseded by DB-backed
  aging); keep the parsers and `MdnsBackend` seam.

**Documentation updates**: a comment documenting the chosen TTL defaults
and that they're bench-tunable, not final (per `sprint.md` Open
Questions).

## Implementation Notes (as built)

- **`wifiLiveness` retirement deferred, not done.** The plan's "remove
  the `server.mdns` private-field hack" was evaluated against the
  ticket's own fallback clause ("only do that if its existing tests
  still pass afterward. Otherwise leave it as is..."). `MdnsDiscovery`
  (and its `wifiLiveness` bookkeeping) is constructed and driven
  directly by `deviceRegistry.ts`/its coordinator, which this ticket may
  not modify and must keep working unchanged this sprint. Retiring
  `wifiLiveness` without also fixing `MdnsDiscovery.stop()`'s own
  "`relays`/`robots`/`wifiRobots` survive a restart, only `wifiLiveness`
  is cleared" gap (the actual cause of the issue's aging complaint on
  that path) would make `deviceRegistry.ts`'s WiFi aging silently worse,
  which is out of scope to fix here. Left as-is with a
  `// TODO(rearch-05)` comment above the class explaining the deferral
  and pointing at sprint 015 (`deviceRegistry.ts`'s own retirement) as
  where this gets resolved for real.
- **`mdnsWatcher.ts` does not go through `MdnsDiscovery`.** Per the
  ticket's own text ("wrapping the existing `MdnsBackend` seam and
  parsers"), the new watcher browses via `MdnsBackend`/`MdnsFindOptions`
  directly — a second, independent browse session alongside
  `MdnsDiscovery`'s — rather than layering on that class, so it can be
  built/tested without touching the old registry path at all.
- **Two small, additive extensions to `discovery/mdnsDiscovery.ts`**,
  both optional interface members (existing fakes/tests unaffected):
  `MdnsBrowser.update()` (re-issues a PTR query; wraps
  `bonjour-service`'s own public `Browser.update()`) and
  `MdnsBrowser.onServiceChange()` (coalesces `bonjour-service`'s
  `srv-update`/`txt-update` events into the one case `mdnsWatcher.ts`
  needs: "this instance's address/TXT changed under the same fqdn, no
  down/up event" — the exact gap the issue calls out).
- **New `Store.pruneServices(type, ttlMs, now)`** in
  `packages/host/src/store/index.ts`, mirroring `ageLinks`'s own
  batch-change shape — needed because the acceptance criteria require
  expired `services` rows to actually disappear (including
  `_mbflash._tcp`, which has no `links` row for `ageLinks` to age), and
  the "no SQL outside `store/`" rule means that had to live in `Store`,
  not the watcher.
- Device linking implemented via `Store.snapshotRows()` reads (no new
  device-lookup method needed): `wifi`/`mbserial` require exactly one
  *owned* device by name; `mbrelay` requires exactly one `kind='relay'`
  device by name (not owned-gated — `devices.owned` is documented as
  the WiFi/mbserial gate specifically, and `usbWatcher.ts` never sets it
  for a relay).
- TTL defaults chosen: `DEFAULT_WIFI_TTL_MS` / `DEFAULT_MBSERIAL_TTL_MS`
  / `DEFAULT_MBRELAY_TTL_MS` / `DEFAULT_MBFLASH_TTL_MS` = 180 000 ms
  (~180s, per `sprint.md`'s Open Questions suggestion, matching today's
  WiFi sweep plus slack); `DEFAULT_REQUERY_INTERVAL_MS` = 30 000 ms. All
  bench-tunable, not final — flagged as such in `mdnsWatcher.ts`'s own
  doc comment.
