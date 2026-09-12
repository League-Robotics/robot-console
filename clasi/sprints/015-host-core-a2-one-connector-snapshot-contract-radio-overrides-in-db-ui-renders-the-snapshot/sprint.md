---
id: '015'
title: 'Host core A2: one connector, snapshot contract, radio overrides in DB, UI
  renders the snapshot'
status: roadmap
branch: sprint/015-host-core-a2-one-connector-snapshot-contract-radio-overrides-in-db-ui-renders-the-snapshot
use-cases: []
issues:
- rearch-05-connector-reconciler-harvester-retire-deviceregistry.md
- rearch-06-snapshot-wire-contract-and-thin-server.md
- rearch-08-radio-address-overrides-in-host-db.md
- rearch-07-ui-renders-snapshot-drops-client-policy.md
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Sprint 015: Host core A2: one connector, snapshot contract, radio overrides in DB, UI renders the snapshot

## Goals

Cut the host over to the new core built in sprint 014: one connector,
reconciler, and harvester replacing `deviceRegistry.ts`; a new
`snapshot` wire contract with a thin server; radio address overrides
moved into the host DB; and the UI updated to render the snapshot with
every existing feature preserved. This is Sprint A2 of the
`docs/design/rearchitecture-plan.md` arc's Sprint A split, and it does
not start until sprint 014's watcher rows are confirmed visible in a
debug dump.

## Problem

Sprint 014 gave the host a store, a link core, and two watchers, but
the old in-memory `deviceRegistry.ts` (3,873 lines, seventeen
responsibilities, six separate places that decide connection policy)
is still the thing actually running the UI. Until it is retired, none
of the new rows matter to a student, radio overrides still live in
browser `localStorage` (per-profile, invisible to background tasks),
and the wire contract's `EndpointListEntry` still can't express half
the states the new link-state machine needs. This sprint is the
parity gate: the point where the rewrite must match everything the
old UI does today, not just architecturally supersede it.

## Solution

Land the four issues in dependency order:

1. **rearch-05** — the connector (`connectAndIdentify`, cancellable,
   works for every transport), the reconciler (pure `plan(rows, now)`
   decision function plus a thin executor: link preference
   `usb > wifi > mbserial > radio > mbrelay`, WiFi/mbserial ownership
   gate, backoff, user-close precedence), and the harvester (per-session
   status/funcs/telemetry). Retires `deviceRegistry.ts`,
   `knownRobots.ts`, and `wifiRobotGate.ts`.
2. **rearch-06** — the `Snapshot`/`Notice` wire contract from
   `architecture.md` §9, a `buildSnapshot()` projection over the store,
   and a thin `server.ts` that only broadcasts and dispatches commands
   (no longer the composition root). Adds SIGINT/SIGTERM handling and
   per-socket error/backpressure guards missing today.
3. **rearch-08** — radio channel/group overrides move from
   `localStorage` to `devices.radio_channel/radio_group/radio_source`
   in the host DB, with a single resolution order (override → registry
   → derived) that background tasks (the sweeper, in sprint 016) can
   also read.
4. **rearch-07** — the UI becomes a pure renderer of the snapshot:
   `WsProvider` gains one `snapshot` slice, every client-side connect
   decision (WiFi auto-open, client-sequenced relay switch, endpoint
   grouping/scoring, on-open probes) is deleted, and the
   disconnected-from-host banner is added.

rearch-06 depends on rearch-05's rows; rearch-08 rides on rearch-06's
snapshot shape; rearch-07 is the parity gate and depends on both.

## Success Criteria

- Feature parity with today's UI, checked against the full inventory
  in `docs/reviews/2026-09-11/04-ui.md` §1 — every row either has a
  passing test or is confirmed present in a manual hardware pass; any
  dropped row is called out explicitly.
- `deviceRegistry.ts`, `knownRobots.ts`, and `wifiRobotGate.ts` are
  deleted, not ported.
- The disconnected-from-host banner is present and disables
  send-capable controls while the socket is down.
- A bench pass on real hardware succeeds: a relay and a robot on both
  USB and WiFi, exercised on both macOS and Linux.

## Scope

### In Scope

- Connector, reconciler, harvester; retiring `deviceRegistry.ts` and
  its two satellite modules (rearch-05).
- `Snapshot`/`Notice` wire contract, DB projection, thin server,
  process signal handling (rearch-06).
- Radio overrides stored per-device in the host DB with one resolution
  order (rearch-08).
- UI rendering the snapshot, disconnected banner, deletion of every
  client-side connection policy (rearch-07).

- Carried from sprint 014 ticket 006: after the four old link classes are
  deleted, measure `packages/host/src/link/` (incl. tests) against the
  rearch-04 target of ~900 lines and trim `LineLink.ts` (591 lines vs a
  ~250-line estimate) if it does not fit.

- Carried from sprint 014 ticket 010: `importKnownRobots` seeds `devices`
  rows keyed by a synthetic name-derived id because `known-robots.json`
  never stored the chip id. After real USB identification the same robot
  exists twice (placeholder row + real chip-id row, e.g. vevov/vitut in
  the 2026-09-11 bench dump). The rearch-05 reconciler must merge the
  placeholder into the real row by name on first identification and
  carry `owned = 1` across.

### Out of Scope

- Relay leases, the idle state, and the sweeper — sprint 016
  (rearch-09, rearch-10); the sweeper is a consumer of this sprint's
  radio-override resolution order but is not built here.
- Real mbrelay/mbserial network transports — sprint 016 (rearch-11).
- Firmware availability watcher, flash/SWD hardening, UI component
  dedupe, specification corrections — sprint 017.
- Any change to robot or relay firmware.

## Test Strategy

Golden-snapshot tests for `buildSnapshot()` against seeded store rows;
table-driven reconciler `plan()` tests; connector tests against the
shared fake `ByteStream` harness from sprint 014; FakeSocket UI tests
regenerated to the new snapshot shape. Beyond automated tests, this
sprint requires a bench pass on real hardware (a real relay, a real
robot on USB and WiFi) on both macOS and Linux before it can be
considered done — the Linux failover bug and the macOS boot-window bug
were both invisible to the existing automated tests.

## Dependencies and Rationale

This is Sprint A2 of `docs/design/rearchitecture-plan.md`'s Sprint A
split: "A2 = 05, 06, 08, 07 (cut over)." It depends entirely on sprint
014 (A1) — the store, link core, and watchers rearch-05 consumes. Per
the plan's stated risk, sprint 014's watcher rows must be visible in a
debug dump before this sprint starts. The plan's dependency graph also
lists this sprint's hardware-verification risk: "Sprints A and B each
need a bench pass with a real relay, a real robot on USB and WiFi, on
both macOS and Linux."

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
