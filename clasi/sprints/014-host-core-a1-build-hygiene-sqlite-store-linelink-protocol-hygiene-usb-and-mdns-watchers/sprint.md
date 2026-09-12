---
id: '014'
title: 'Host core A1: build hygiene, SQLite store, LineLink, protocol hygiene, USB
  and mDNS watchers'
status: roadmap
branch: sprint/014-host-core-a1-build-hygiene-sqlite-store-linelink-protocol-hygiene-usb-and-mdns-watchers
use-cases: []
issues:
- rearch-17-build-hygiene-engines-lockfile-linux-tests-signals.md
- rearch-01-sqlite-store-schema-migrations-change-feed.md
- rearch-04-linelink-core-replaces-four-link-classes.md
- rearch-15-protocol-hygiene-receive-facade-relay-reply-grammar.md
- rearch-02-usb-watcher-writes-rows-one-identify-per-attach.md
- rearch-03-mdns-watcher-rows-requery-aging-address-updates.md
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Sprint 014: Host core A1: build hygiene, SQLite store, LineLink, protocol hygiene, USB and mDNS watchers

## Goals

Build the first half of the new host core: a Node/engines floor the
rearchitecture can build on, a single SQLite store that every later
issue writes into, one `LineLink` transport core, protocol-layer
hygiene fixes that the connector and sweeper will depend on, and the
first two watchers (USB, mDNS) writing rows into that store. This is
"Sprint A1" of the two-sprint split of Sprint A described in
`docs/design/rearchitecture-plan.md`.

## Problem

All device and link state today lives in-memory inside
`deviceRegistry.ts` (3,873 lines, seventeen state holders, four
identity keys), backed only by two ad hoc JSON files. Before any of
that class's responsibilities can be replaced (rearch-05, sprint 015),
the replacement needs somewhere to write to: a real store, a real
transport core, and watchers that populate it. Today's build also
can't safely host that work — the Node engines floor is wrong for
`node:sqlite`, the lockfile drifts on every install, and two host
tests are macOS-only, which would make CI red the moment SQLite-backed
tests land.

## Solution

Land the six issues in dependency order:

1. **rearch-17** — build hygiene first: raise `engines.node` to
   `>=22.13` everywhere (unblocks `node:sqlite`), fix the lockfile
   drift, make the two platform-coupled tests pass on Linux, and add
   the submodule/typecheck guards so CI is trustworthy before the
   rewrite starts.
2. **rearch-01** — the SQLite store: schema exactly as
   `architecture.md` §4 (`devices`, `links`, `services`, `sightings`,
   `sessions`, `board_owner`, `relay_leases`, `firmware`, `settings`,
   `tasks`, `changes`), typed operations only, one-time importers for
   `known-robots.json`/`wifi-credentials.json`, and an in-process
   change feed. Everything else in the arc depends on this.
3. **rearch-04** — one `LineLink` core (~250 lines) with adapters for
   serial, TCP, and the relay preamble, replacing the four
   near-duplicate link classes and fixing their shared defects (no
   `onClose`, no connect timeout, swallowed write failures, no abort
   signal through the relay command plane).
4. **rearch-15** — protocol package hygiene: a pure `receive()` facade
   encoding the decode→classify→drop→reply ordering, the relay `#`
   reply grammar moved out of the host and into protocol, several
   small session/codec bugs fixed, and vendor-fixture-independent
   tests so CI doesn't silently skip 94 of 162 protocol tests.
5. **rearch-02** — the USB watcher: treats a split serial/HID
   enumeration as one update instead of remove+add, writes
   `devices`/`links(usb)` rows, and moves the boot-window HELLO retry
   into the (still-to-come) connector rather than a single 3 s
   timeout.
6. **rearch-03** — the mDNS watcher: browses all five service types,
   re-queries periodically so a missed boot announcement is recovered
   within one interval, ages every link type (not just WiFi), and
   follows SRV/TXT address changes.

rearch-01 and rearch-04 and rearch-15 have no hard dependency on each
other and can proceed in parallel once rearch-17 lands; rearch-02 and
rearch-03 both need the store from rearch-01.

The old `deviceRegistry.ts`/coordinator path keeps running unchanged
through this sprint — nothing here cuts the UI over. That cutover is
sprint 015 (A2).

## Success Criteria

- The host has a working SQLite store with rows in it and one
  `LineLink` core; the old four link classes' behaviour is covered by
  the new core's tests.
- The USB and mDNS watchers write device/link/service rows that are
  visible in a debug dump (a direct store query, since there is no UI
  change yet).
- The old `deviceRegistry.ts` and its coordinator are still running
  unchanged; the UI is unchanged and shows no regression.
- `npm test` is green on both Linux and macOS from a clean clone.
- Sprint 015 does not start until this sprint's watcher rows are
  confirmed visible in a debug dump (see Risk below).

## Scope

### In Scope

- Node/engines floor, lockfile hygiene, Linux-safe tests, submodule
  and typecheck guards (rearch-17).
- SQLite schema, typed store operations, change feed, JSON importers
  (rearch-01).
- `LineLink` core plus serial/TCP/relay-preamble adapters, replacing
  `UsbSerialLink`, `RelayRadioLink`, `MbrelayLink`, `MbserialLink`
  (rearch-04).
- Protocol `receive()` facade, relay reply grammar, session/codec bug
  fixes, fixture-independent protocol tests (rearch-15).
- USB watcher writing device/link rows with one identify per attach
  (rearch-02).
- mDNS watcher writing service/link rows, re-query, aging, address
  tracking (rearch-03).

### Out of Scope

- The connector, reconciler, and harvester that consume these rows,
  and retiring `deviceRegistry.ts`/`knownRobots.ts`/`wifiRobotGate.ts`
  (rearch-05) — sprint 015.
- The new `snapshot` wire contract and thin server (rearch-06) —
  sprint 015.
- Radio address overrides in the DB (rearch-08) and the UI rendering
  the snapshot (rearch-07) — sprint 015.
- Relay leases, the sweeper, network transports, and any relay
  firmware change (rearch-09..12) — sprint 016.
- Firmware availability watcher, flash/SWD hardening, UI component
  dedupe, and specification corrections (rearch-13, 14, 16, 18) —
  sprint 017.
- Any UI change. This sprint is testable entirely without touching
  `packages/ui`.

## Test Strategy

Each issue carries its own acceptance tests (see the issue files for
the full per-issue test list): store schema/migration/typed-op/change-
feed/importer tests; a shared fake `ByteStream` harness driving the
`LineLink` core and per-adapter tests; protocol tests runnable without
`vendor/` submodules; watcher tests against fake enumerator/mDNS
backends asserting rows, not events. `npm test` must be green on both
Linux and macOS from a clean clone (rearch-17's acceptance criterion),
which is also this sprint's own regression gate since it is the first
sprint to exercise the new Linux-safe test paths.

## Dependencies and Rationale

This is Sprint A1 of the `docs/design/rearchitecture-plan.md` arc's
Sprint A, split per the plan's suggestion ("A1 = 17, 01, 04, 15, 02,
03 — host has rows and a link core, old registry still running; A2 =
05, 06, 08, 07 — cut over"). The plan's dependency graph places 17 as
a prerequisite for 01 (needs the engines bump for `node:sqlite`), and
01/04/15 feeding 02/03 in parallel. This sprint is the keystone of the
whole arc — sprints 015, 016, and 017 all depend on it, directly or
transitively.

**Risk carried forward from the plan**: "Sprint A size — the A1/A2
split keeps each half independently testable; do not start A2 (sprint
015) until A1's watcher rows are visible in a debug dump." Confirm
that before detail-planning sprint 015.

## Architecture

(Architecture for this sprint's change, sized to the change — a
one-paragraph note for a trivial sprint, a fuller write-up with
component/data-model detail for a substantial one. May read "N/A —
trivial" when the change has no architectural impact.)

### Architecture Overview

(High-level structure and component relationships, if applicable.)

### Design Rationale

(Significant decisions with alternatives considered and reasoning, if
applicable.)

### Migration Concerns

(Data migration, backward compatibility, deployment sequencing — or
"None" if not applicable.)

## Use Cases

(Use cases sized to the change — may read "N/A — trivial" for small
sprints that don't warrant new or updated use cases.)

### SUC-001: (Title)
Parent: UC-XXX

- **Actor**: (Who)
- **Preconditions**: (What must be true before)
- **Main Flow**:
  1. (Step)
- **Postconditions**: (What is true after)
- **Acceptance Criteria**:
  - [ ] (Criterion)

## GitHub Issues

(GitHub issues linked to this sprint's tickets. Format: `owner/repo#N`.)

## Definition of Ready

Before tickets can be created, all of the following must be true:

- [ ] Sprint planning document is complete (sprint.md, including its
      Architecture and Use Cases sections)
- [ ] Architecture review passed (or skipped, for changes with no
      architectural impact)
- [ ] Stakeholder has approved the sprint plan

## Tickets

| # | Title | Depends On |
|---|-------|------------|

Tickets execute serially in the order listed.
