---
id: '001'
title: mDNS discovery of relays and remote robots (discovery/mdnsDiscovery.ts)
status: done
use-cases:
- SUC-001
depends-on: []
github-issue: ''
issue: robot-console-architecture-and-roadmap.md
completes_issue: false
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# mDNS discovery of relays and remote robots (discovery/mdnsDiscovery.ts)

## Description

Create `packages/host/src/discovery/mdnsDiscovery.ts`: browse
`_mbrelay._tcp` and `_mbserial._tcp` continuously and expose the
current set of discovered services as a typed, observable list
(mirroring `devices.ts`'s `DeviceWatcher.onChange`-style callback
shape, not a one-shot query). Add the mDNS dependency
(`bonjour-service`, per `sprint.md`'s Design Rationale — a pure-JS
backend, no native binding, consistent with why `config.ts` avoided
`dotenv` and sprint 005 avoided SQLite) to `packages/host/package.json`,
but keep the browse call behind an injectable seam so tests never
touch a real multicast socket.

Parse each discovered `_mbrelay._tcp` record into `{ instanceName,
host, port, registryPort }` — `registryPort` comes from the TXT
record's `registry=<port>` field (verified live per the roadmap plan:
instance `torture` at `torture.local.:8760`, TXT `registry=8761`).
Parse each `_mbserial._tcp` record into `{ instanceName, host, port }`
— the instance name **is** the target robot's five-letter name
directly (per specification.md §4.4), no further parsing needed.

Do not construct any `EndpointListEntry` from a discovered service —
per `sprint.md`'s Design Rationale, discovered services are a separate,
`rememberedRobots`-shaped snapshot list (ticket 003's/004's job to wire
into `wsMessages.ts`/`server.ts`/`WsProvider.tsx`; this ticket owns
only the browse+parse module itself, fully testable in isolation).

## Acceptance Criteria

- [x] `discovery/mdnsDiscovery.ts` browses both `_mbrelay._tcp` and
      `_mbserial._tcp` via an injectable backend (default: real
      `bonjour-service`; tests substitute a fully synthetic fake, no
      real multicast socket ever opened in a test).
- [x] A `_mbrelay._tcp` record with TXT `registry=8761` parses into a
      service record carrying `registryPort: 8761`.
- [x] A `_mbrelay._tcp` record with no `registry` TXT field (or an
      unparseable one) parses into a service record with
      `registryPort: undefined` — never a thrown error, never a guessed
      default port.
- [x] A `_mbserial._tcp` record parses into a service record whose
      `instanceName` is used directly as the target robot's name — no
      additional lookup or transformation.
- [x] A service that disappears from a subsequent fake browse result
      (`down`/`remove` event, per whatever the chosen library calls it)
      is removed from the exposed list on the next read.
- [x] `bonjour-service` (or the chosen equivalent) is added to
      `packages/host/package.json`'s `dependencies`, pinned per this
      project's existing version-pinning convention.
- [x] `npm test` and `npm run build` pass.

## Testing

- **Existing tests to run**: `npm test -- host` (packages/host), to
  confirm the new dependency doesn't break any existing build/test
  step.
- **New tests to write**: `mdnsDiscovery.test.ts` against an injected
  fake backend producing scripted up/down events for both service
  types, including the TXT-parsing edge cases above.
- **Verification command**: `npm test`, `npm run build`.

## Implementation Plan

### Approach

No dependency on any other ticket in this sprint or sprint 007 — this
is a standalone browse+parse module. Implement the injectable-backend
seam first (mirroring `DeviceWatcher`'s constructor-injection pattern
in `devices.ts`), then the two service-type parsers.

### Files to create/modify

- `packages/host/package.json` — add `bonjour-service` dependency.
- `packages/host/src/discovery/mdnsDiscovery.ts` — new.
- `packages/host/src/discovery/mdnsDiscovery.test.ts` — new.

### Testing plan

See Acceptance Criteria / Testing above.

### Documentation updates

Module doc comment on `mdnsDiscovery.ts`, matching `devices.ts`'s
documentation depth — state explicitly that browsing is passive (no
registry write, unlike `mbrelayRegistry.ts`'s resolution calls) so a
future reader doesn't conflate the two modules' very different
"is this safe to call speculatively" properties.
