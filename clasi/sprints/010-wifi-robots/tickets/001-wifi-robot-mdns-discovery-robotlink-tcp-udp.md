---
id: '001'
title: WiFi robot mDNS discovery (_robotlink._tcp/._udp)
status: open
use-cases: [SUC-001]
depends-on: []
github-issue: ''
issue: robot-console-two-level-ui-and-multi-transport-roadmap.md
completes_issue: true
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# WiFi robot mDNS discovery (_robotlink._tcp/._udp)

## Description

Extend `packages/host/src/discovery/mdnsDiscovery.ts` to browse
`_robotlink._tcp` and `_robotlink._udp` alongside the existing
`_mbrelay._tcp`/`_mbserial._tcp` browsing, per `docs/design/
specification.md` §4.4 (corrected) and this sprint's Architecture Step
5. Parse each service's TXT record (`name`, `role`, `link`, `port`)
into a new `WifiRobotService` type, added to `MdnsDiscoverySnapshot`
alongside the existing `relays`/`robots` lists. A robot advertising
under both service types simultaneously (the live-verified norm —
`gopiv`/`vevov` both do) must be deduplicated by `name` into exactly
one record.

This module stays policy-free, exactly like its existing
`_mbrelay._tcp`/`_mbserial._tcp` browsing — no roster check here (that
is ticket 002/003's job). Do not special-case `link=v6-udp`: the
earlier spec draft's wrong value is simply not what any TXT field is
matched against — the parser treats `link` as ordinary opaque TXT
data, same as `role`.

## Acceptance Criteria

- [ ] `MdnsDiscovery` browses both `_robotlink._tcp` and
      `_robotlink._udp` via the existing injectable `MdnsBackend` seam
      (no real multicast socket in tests).
- [ ] A `WifiRobotService` record carries `name`, `host`, `port`,
      `role`, `link` parsed from the TXT record.
- [ ] A fixture modeled on the live `gopiv` observation (`_robotlink.
      _tcp`, host `gopiv.local.`, port 7654, TXT `name=gopiv
      role=robot link=v6 port=7654`) parses to the exact expected
      record.
- [ ] The identical fixture advertised on `_robotlink._udp` instead
      parses identically.
- [ ] A robot advertising on both service types simultaneously yields
      exactly one `WifiRobotService` entry in the snapshot, not two.
- [ ] A `down` event on either service type removes the corresponding
      entry (mirrors the existing `relays`/`robots` removal
      discipline) — but see ticket 003/004 for how an open WiFi
      *session* behaves on a `down` event (this ticket only covers the
      discovery snapshot itself).
- [ ] `MdnsDiscoverySnapshot` gains `wifiRobots: readonly
      WifiRobotService[]`, defaulting to `[]`.

## Testing

- **Existing tests to run**: `packages/host/src/discovery/
  mdnsDiscovery.test.ts` (full file — must keep passing unmodified for
  the existing `_mbrelay._tcp`/`_mbserial._tcp` cases).
- **New tests to write**: fixture-based tests for `_robotlink._tcp`/
  `._udp` parsing (both service types, both independently and
  simultaneously advertised), TXT-field extraction, and `down`-event
  removal — extending `mdnsDiscovery.test.ts` with the same injected
  fake-backend technique already used there.
- **Verification command**: `npm test -w packages/host -- discovery/
  mdnsDiscovery.test.ts` and `npm run build`.
