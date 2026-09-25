---
id: 025
title: 'Retire direct USB: flash and names via mbregistry'
status: roadmap
branch: sprint/025-retire-direct-usb-flash-and-names-via-mbregistry
use-cases: []
issues:
- retire-direct-usb-flash-and-names-via-mbregistry.md
- spawn-mbregistry-via-service-run.md
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Sprint 025: Retire direct USB: flash and names via mbregistry

## Goals

Finish the mbregistry migration: move radio names onto mbregistry, then
delete the direct-USB and legacy relay paths mbregistry replaces —
including the dapjs/MSD flashing path, whose mbregistry-based
replacement (`send_hex`/`flash`) was moved forward into Sprint 024,
ticket `024-005` (stakeholder decision, 2026-09-24), so this sprint's
job is to retire the now-superseded code, not to build the replacement.
Source issue:
`clasi/issues/retire-direct-usb-flash-and-names-via-mbregistry.md`.
Design: `mbtools` `docs/design/robot-console-integration.md` §3.3, §3.4,
§6 items 4-5. Depends on Sprint 024 (`mbregistryClient`, watcher, stream
adapter, and now also mbregistry-based flashing) landing first.

## Problem

After Sprint 024, robot-console can discover, lock, stream and flash
boards through mbregistry, but still resolves radio names through
`mbrelayRegistry.ts` (an HTTP `GET` that creates entries on read), and
the old direct-USB dapjs/MSD flashing path is still present as dead code
alongside its Sprint-024 replacement. The old direct-USB and
relay-registry code paths still exist, so the duplication and
port-contention risk the whole migration exists to remove isn't actually
gone until they're deleted.

## Solution

- Resolve and set names via `names_get`/`names_set` on the local socket
  (no create-on-read); replace `mbrelayRegistry.ts`.
- Delete `usbWatcher`, `swdName`, the serialport/node-hid/dapjs paths
  (including the now-superseded dapjs/MSD flashing path — its
  replacement, `024-005`, already ships in Sprint 024), `mbrelayRegistry.ts`,
  and the `_mbserial`/`_mbrelay`/`_mbflash` branches
  of `mdnsWatcher` (WiFi `_robotlink._tcp` is untouched).
- Shrink `board_owner`/`relay_leases` to arbitration inside one process
  (sweep vs. student session), or replace with the existing in-memory
  `keyedMutex` plus pre-emption.
- Update `docs/design/architecture.md` (§12 currently lists multi-host
  coordination as out of scope; it no longer is, since mbregistry now
  owns it).

## Success Criteria

- robot-console no longer opens any USB serial or HID device directly;
  `serialport`/`node-hid`/`dapjs` are gone from `package.json`.
- Flashing a local and a remote board continues to work through
  mbregistry (delivered by Sprint 024, `024-005`) with the dapjs/MSD
  path and its dependencies fully removed — no regression.
- Radio names are read without creating entries.
- Hardware acceptance on the bench: system mbregistry running and not
  running, two clients contending for one board.

## Scope

### In Scope

- Names via `names_get`/`names_set`, replacing `mbrelayRegistry.ts`.
- Deletion of `usbWatcher`, `swdName`, serialport/node-hid/dapjs
  (including the now-dead dapjs/MSD flashing path),
  `mbrelayRegistry.ts`, and the `_mbserial`/`_mbrelay`/`_mbflash` mDNS
  branches.
- `board_owner`/`relay_leases` shrink or replacement.
- `docs/design/architecture.md` §12 update.

### Out of Scope

- Anything already delivered by Sprint 024 (client, watcher, stream
  adapter, link preference order, configurable console port, and —
  moved forward by stakeholder decision, 2026-09-24 — flashing via
  `send_hex`/`flash`, ticket `024-005`). This sprint only deletes the
  dapjs/MSD code that flashing replaced; it does not build any new
  flashing path.
- WiFi robot links (`_robotlink._tcp`) — unaffected by this migration.
- SWD naming of silent boards — tracked as a separate pending mbtools
  issue, not this sprint's work.

## Dependencies

- Sprint 024 must be complete and merged first (the client, watcher,
  stream adapter, and mbregistry-based flashing this sprint builds names
  on top of and deletes the superseded dapjs/MSD code behind).
- mbtools's local-socket `names_get`/`names_set`/`names_clear`/
  `names_list` ops (already available per `docs/design/registry-api.md`).
- Same minimum-mbregistry-version pin as Sprint 024.

## Test Strategy

(Describe the overall testing approach for this sprint: what types of tests,
what areas need coverage, any integration or system-level testing needed.)

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
