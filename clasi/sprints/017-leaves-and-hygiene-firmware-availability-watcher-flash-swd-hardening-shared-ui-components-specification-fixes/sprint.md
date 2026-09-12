---
id: '017'
title: 'Leaves and hygiene: firmware availability watcher, flash/SWD hardening, shared
  UI components, specification fixes'
status: roadmap
branch: sprint/017-leaves-and-hygiene-firmware-availability-watcher-flash-swd-hardening-shared-ui-components-specification-fixes
use-cases: []
issues:
- rearch-13-firmware-availability-watcher-etag-backoff.md
- rearch-14-flash-swd-timeouts-platform-msd-fallback.md
- rearch-16-ui-shared-components-dedupe.md
- rearch-18-specification-stale-statements.md
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Sprint 017: Leaves and hygiene: firmware availability watcher, flash/SWD hardening, shared UI components, specification fixes

## Goals

Close out the rearchitecture arc's remaining leaves: turn firmware
availability polling into a well-behaved watcher, harden flash/SWD
against wedged transports and non-macOS platforms, extract the UI
components that three pages currently copy, and correct the
specification's statements that the code review found stale. This is
Sprint C of `docs/design/rearchitecture-plan.md`.

## Problem

Four mostly-independent pieces of "silently wrong" behaviour remain
after sprints 014-016 land the host core, relay ownership, and the
sweep: firmware-release polling has no `ETag`/backoff and a classroom
behind one NAT can exhaust GitHub's rate limit in under an hour; every
DAPLink/HID call in the flash path has no timeout, and MSD fallback
only works on macOS; three UI pages have quietly grown their own
copies of the same connect-controls, held-drive, calibration-table,
and dialog-shell logic; and `specification.md` still describes verbs,
transports, and a host device model (`deviceRegistry.ts`) that no
longer exist after this arc. None of these four touch each other's
code, and none introduce a new subsystem — they are leaves, closing
gaps the code review catalogued rather than adding new composition.

## Solution

Land the four issues; ordering here is about dependency readiness, not
a tight coupling chain — 13 and 14 can start as soon as sprint 015's
connector exists, 16 waits on 07's UI work, and 18 is parked here but
could genuinely land any time:

1. **rearch-13** — the firmware availability watcher: `ETag`/
   `If-None-Match` polling, `Retry-After` and exponential backoff on
   403/429, an `AbortSignal` timeout on every fetch, and a `no-asset`
   message that names the assets actually found. Depends on sprint
   015's projection reading from the `firmware` table.
2. **rearch-14** — flash/SWD hardening: every dapjs call wrapped in a
   timeout with a typed failure class; MSD volume listing made
   platform-aware (Linux `/media`/`/run/media`, Windows drive letters,
   not just macOS `/Volumes`); exclusivity between naming, session,
   and flash moved onto `board_owner` now that `deviceRegistry.ts` is
   gone. Depends on sprint 014's store and USB watcher, and sprint
   015's connector.
3. **rearch-16** — UI shared components: the relay connect-controls,
   `RobotSelect`, held-drive hook, calibration table, WiFi form, modal
   shell, and status-copy helpers that today are copy-pasted across
   `FrontPage`, `RelayPage`, `ConfigurationPage`, and others get one
   definition each. Depends on sprint 015's rearch-07 UI rewrite (do
   after, so this sweep isn't duplicating work already done there).
4. **rearch-18** — specification corrections: fix the stale `TLM HDR`,
   "11 verbs", and `WifiUdpLink` statements, point §4's host
   description at `architecture.md` instead of `deviceRegistry.ts`,
   and note the relay command-plane `>`/`<` fact and the break-reset
   path. Doc-only; no code dependency, but best done once the rest of
   the arc's behavior is settled so the doc describes the finished
   system.

## Success Criteria

- No known "silently wrong" behaviour remains in the leaves catalogued
  by the 2026-09-11 code review.
- `specification.md` is true of the code: every claim naming a file,
  verb, or service type matches what actually ships after this arc.
- Firmware polling survives a classroom-sized burst of hosts behind one
  NAT without every host reporting `network` and disabling flash.
- Flash/SWD operations degrade to a typed timeout failure instead of
  hanging, on every platform's MSD fallback path.
- Every UI duplicate row catalogued in `docs/reviews/2026-09-11/04-ui.md`
  §4 resolves to one definition.

## Scope

### In Scope

- Firmware availability watcher with ETag/backoff (rearch-13).
- Flash/SWD timeout hardening and platform-aware MSD fallback
  (rearch-14).
- Shared UI components deduping the relay/robot-select/drive/
  calibration/WiFi-form/modal duplication (rearch-16).
- Specification corrections and the `overview.md` roadmap pointer
  update (rearch-18).

### Out of Scope

- Any new watcher, transport, or subsystem — this sprint touches only
  existing leaf modules and docs.
- Anything already covered by sprints 014-016 (store, connector,
  reconciler, relay leases, sweeper, network transports).
- The two remaining unchanged open issues noted in the plan
  (`wificred-provisioning-affordance...` and
  `wifi-drops-burst-lines-calibration-apply-lost.md`), which are not
  part of this arc.

## Test Strategy

Fake-fetch tests for the firmware watcher's 304/403/backoff/timeout
paths; fake-`fs`-per-platform tests for MSD volume listing; a fake
dapjs that never resolves, asserting the timeout failure and released
`board_owner`; existing FakeSocket UI tests updated to the shared
components with the duplicated assertions collapsed to one per
component. rearch-18 is verified by grep (`TLM HDR`, `11 verbs`,
`WifiUdpLink` absent) and a spot-check against the protocol review's
table — no new automated tests. No new hardware bench pass is required
beyond what sprints 014-016 already covered, since these are hardening
and hygiene changes to existing paths, not new behaviour.

## Dependencies and Rationale

This is Sprint C of `docs/design/rearchitecture-plan.md`. Per the
plan's dependency graph, rearch-13 and rearch-14 depend on sprint
015's connector; rearch-16 depends on rearch-07 (sprint 015); rearch-18
"could go any time but is parked here." Unlike sprints 014-016, this
sprint's four issues do not chain into each other — they are grouped
because they are the arc's remaining leaves, not because of a shared
dependency graph among themselves.

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
