---
id: '016'
title: Relay ownership, radio sweep, and network transports
status: roadmap
branch: sprint/016-relay-ownership-radio-sweep-and-network-transports
use-cases: []
issues:
- rearch-09-relay-lease-idle-state-reset-between-candidates.md
- rearch-10-relay-sweeper-radio-sightings.md
- rearch-11-mbrelay-mbserial-real-transports.md
- rearch-12-relay-firmware-non-persisting-tune.md
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Sprint 016: Relay ownership, radio sweep, and network transports

## Goals

Give a relay a real idle state with proper ownership handoff, fix the
Linux failover bug that default failover has today, build the
background radio sweep the stakeholder asked for, and make the
mbrelay/mbserial network transports actually work end to end. This is
Sprint B of `docs/design/rearchitecture-plan.md`.

## Problem

Today a relay can never be idle: every DAPLink attach auto-opens a
console session on it, `KeyedMutex` serialises operations but is not
an ownership mechanism, and there is no way for a background task to
know a student is using the relay. Default failover between candidate
robots is structurally broken on Linux (the reset only runs once,
before the first candidate, so every candidate after the first sends
its sync into a relay stuck in the data plane — it only ever worked on
macOS because opening the port happens to reset the board). Separately,
the mbrelay and mbserial transports exist in code but are effectively
dead: `MbrelayLink`'s failover candidate builder never emits an mbrelay
candidate, and mbserial robots are only reachable as a tail candidate
of a local relay's default failover, never directly. None of this
matters for background sweeping until relay ownership has a real idle
state to sweep from.

## Solution

Land the four issues in dependency order:

1. **rearch-09** — `relay_leases` gives a relay an explicit owner
   (`sweep` or `session:<childLinkId>`); the auto-opened console goes
   away; `relayBridger.bridge()` resets **per candidate** (DAPLink over
   HID, else a serial break — reliable on Linux, unlike DTR — else a
   port reopen on macOS), fixing the failover bug at its root; address
   resolution uses rearch-08's override→registry→derived order with no
   write-on-read registry lookups during default failover.
2. **rearch-10** — the relay sweeper: for each idle USB relay, acquire
   the sweep lease and probe remembered robots over the radio using the
   command plane's `!CG`/`> ID` (no `!GO`, no reset, ~0.5 s per probe),
   recording `sightings` and upserting `connectable` radio links. Rate
   limited to one retune per relay per 30 s until rearch-12 lands (see
   below), then 2 s.
3. **rearch-11** — mbrelay and mbserial become real transports: mDNS's
   already-upserted `links(mbserial)`/`links(mbrelay)` rows get device
   linking (mbserial, by name, same one-owned-device rule as WiFi) and
   connector/bridger support (mbrelay, reusing `relayBridger` with a
   `tcpStream` adapter and disconnect+reconnect as its reset step,
   since a break cannot be sent over TCP).
4. **rearch-12** — a cross-repository firmware change to
   `microbit-radio-relay`: a non-persisting tune (or one-shot probe) so
   the sweeper does not wear the relay's flash. This is filed upstream
   and can start early or land any time; rearch-10 rate-limits itself
   until it ships, then drops to the fast interval once the relay's `?`
   reply advertises the capability.

rearch-10 depends on rearch-09 for the lease mechanism; rearch-11
depends on rearch-09 for the shared bridger. rearch-12 has no
robot-console-side dependency and is not blocking — it can proceed in
parallel with the rest of the sprint.

## Success Criteria

- UC-015 and UC-016 pass on real hardware.
- A student can connect through a relay while a background sweep is
  running and take it over within one probe (≤ 1.5 s handback).
- The Linux failover bug is fixed and covered by a test that fails
  without the per-candidate reset step.
- mbserial and mbrelay discoveries are directly connectable, not only
  reachable as a failover tail candidate.

## Scope

### In Scope

- Relay leases, idle state, no auto-opened console, per-candidate
  reset in default failover (rearch-09).
- Background radio sweep over idle relays, sightings, rate limiting
  (rearch-10).
- mbserial and mbrelay as real, directly connectable transports
  (rearch-11).
- Filing and tracking the relay firmware's non-persisting tune
  (rearch-12); the firmware PR itself lands in the
  `microbit-radio-relay` repo, not this one.

### Out of Scope

- Firmware availability watcher, flash/SWD hardening, UI component
  dedupe, specification corrections — sprint 017.
- Sweeping through an mbrelay pool (explicitly out of scope per
  rearch-11 — a shared classroom pool must not be commandeered by one
  host; the sweeper only uses `links(usb)` relays).
- Any change to robot firmware.

## Test Strategy

Fake-relay-with-plane-state tests for the per-candidate reset fix (one
fixture that fails without the reset step, guarding the Linux bug
specifically); fake relay answering `!CG`/`> ID` for sweeper sightings,
abort/handback timing, and rate limiting; fake mDNS backend plus fake
TCP stream for mbserial/mbrelay connectability and aging. Beyond
automated tests, this sprint needs the same bench-hardware pass as
sprint 015 — a real relay, a real robot on USB and WiFi, on both
macOS and Linux — since the failover and sweep behaviour is exactly
what the existing automated tests failed to catch before.

## Dependencies and Rationale

This is Sprint B of `docs/design/rearchitecture-plan.md`, depending on
sprint 015 (specifically rearch-05's connector/reconciler and
rearch-08's radio-override resolution order, which the sweeper and
bridger both read from). The plan's dependency graph shows
`05 → 09 → 10 ◀─ 12 (optional)` and `09 → 11`. rearch-12 is called out
in the plan explicitly as "cross-repo; start early, land whenever;
rearch-10 rate-limits until it does" — it is tracked in this sprint
but is not a gate for the other three issues.

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
