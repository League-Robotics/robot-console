---
id: '006'
title: 'Agent action audit/visibility: agent_actions log, flash-overlay attribution,
  "Recent agent activity"'
status: done
use-cases:
- SUC-006
- SUC-007
depends-on:
- '005'
github-issue: ''
issue: mcp-server-for-robot-connections.md
completes_issue: false
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Agent action audit/visibility: agent_actions log, flash-overlay attribution, "Recent agent activity"

## Description

**Revision note**: this ticket originally built an authorization/
confirmation subsystem (`pending_actions`, human-only Approve/Deny,
a change-feed-driven executor) gating `request_drive`/`request_flash`
behind a human decision. At the stakeholder approval gate, Eric
overrode that design: "Let the agents do whatever they want. We can
always reflash a board that needs to be reflashed. It's not hard." He
was shown the unattended-harm framing twice (once when the tool surface
was chosen, once specifically on this gate) and declined a gate both
times — see `sprint.md`'s Architecture Revision and Design Rationale
("drive and flash execute immediately") for the full record. Tickets
007/008 now execute `drive`/`flash` immediately and unconditionally;
there is no approval step anywhere in this sprint's design, and this
ticket must not reintroduce one under another name.

**What this ticket is now**: the one piece of the original design that
was never part of the rejected gate — visibility. Eric's own original
framing of this whole feature was that an MCP connection "shows up in
the robot console." This ticket builds the minimum that delivers that
for drive/flash specifically:
- an append-only `agent_actions` audit table, written once by each
  executed `drive`/`flash` call (tickets 007/008), so a board's history
  of agent-initiated actions survives after the originating session
  closes or the flash overlay clears;
- `origin`/`caller` attribution on the `flash` snapshot overlay, live,
  for the duration of an MCP-triggered flash (drive needs no equivalent
  addition — the session's existing "Agent: `<caller>`" label from
  ticket 005 already stays visible for as long as the session that sent
  the command stays open);
- a small, read-only "Recent agent activity" list on the device/robot
  page, so Eric can see what touched a board and when without a
  database query.

None of this blocks, delays, or queues anything. It is built ahead of
tickets 007/008 because both need it, and because it changes for a
different reason (audit/visibility bookkeeping) than either tool's own
validate-and-execute shape does — the same cohesion reasoning that
originally separated this concern out, now serving a different purpose.

## Acceptance Criteria

- [x] `agent_actions` table exists per `sprint.md`'s ERD: `id` (PK),
      `kind` (`'drive'|'flash'`), `link_id` (nullable), `device_id`
      (nullable), `params` (JSON: verb+fields, or firmware ref),
      `caller`, `executed_at`, `result` (`'sent'|'failed'`),
      `result_reason` (nullable). Migration is additive; no backfill
      needed (starts empty). No `status`/lifecycle column — every row is
      already an executed (or attempted) action, never a pending one.
- [x] `mcp/agentActionLog.ts` exposes a `record(entry)` function (used by
      tickets 007/008, exercised here with a fake caller) that writes
      exactly one `agent_actions` row and makes no write to `links`,
      `sessions`, `board_owner`, or `relay_leases`.
- [x] `mcp/agentActionLog.ts` exposes a read for "the most recent N
      `agent_actions` rows for a given link/device," used by the UI's
      "Recent agent activity" list.
- [x] `Snapshot`'s existing `flash?: {source, phase}` field gains
      optional `origin`/`caller` sub-fields; `server.ts`'s flash-overlay
      write path (extracted `startFlash`, ticket 008) sets them from who
      initiated the flash (`'ui'`/no caller for a browser flash,
      `'mcp'`/`<name>` for an MCP one). This ticket wires the field and
      its plumbing; ticket 008 is the first caller that actually sets
      `origin: 'mcp'`.
- [x] The console UI shows the `flash` overlay's `origin`/`caller`
      alongside its existing progress text when present.
- [x] The device/robot page shows a small, read-only "Recent agent
      activity" list (kind, caller, summary, timestamp) sourced from
      `agent_actions`, reading the same change-feed/snapshot mechanism
      every other UI slice already uses. No interactive element (no
      Approve/Deny, no acknowledge, nothing clickable) — purely
      informational.
- [x] No code path anywhere in the tool surface can delay, queue, or
      require approval before `agent_actions` is written — this ticket
      adds no such path, and this criterion exists specifically so a
      later ticket cannot quietly add one without failing a review
      against it.

## Implementation Plan

**Approach**: build the audit table, its write/read functions, and the
two small UI surfaces (flash-overlay attribution, "Recent agent
activity") as one coherent unit, with tickets 007/008 as the only
callers of `agentActionLog.record()`.

**Files to create**:
- `packages/host/src/mcp/agentActionLog.ts` — `record(entry)` and
  `recentFor(linkId | deviceId, limit)`.

**Files to modify**:
- `packages/host/src/store/` — `agent_actions` table + migration +
  typed CRUD operations (per architecture.md §3's "nothing outside
  `store/` issues SQL" rule).
- `packages/host/src/wsMessages.ts` / `server.ts` — `flash` overlay type
  gains `origin`/`caller`; `Snapshot` (or `SnapshotDevice`) gains a
  `recentAgentActions` field.
- `packages/host/src/store/projection.ts` (or wherever `Snapshot` is
  built) — project `recentAgentActions` from `agent_actions`.
- UI: a new small, read-only "Recent agent activity" list component on
  the device/robot page; the existing flash-progress display gains the
  `origin`/`caller` text when present.

**Testing plan**:
- Scoped `vitest` run: new `mcp/agentActionLog.test.ts`, store migration
  test, `projection.test.ts` additions for `recentAgentActions` — not
  the full suite.
- New test: `record()` writes exactly one `agent_actions` row and
  nothing else (no write to `links`/`sessions`/`board_owner`/
  `relay_leases`).
- New test: `recentFor()` returns rows newest-first, bounded by `limit`.
- New test: a `flash` overlay with `origin: 'mcp'`/`caller` set projects
  into `Snapshot` correctly; one with neither set (a browser flash)
  projects with both fields absent.
- New test (structural): grep/assert there is no code path from
  `agentActionLog.ts` or the store's `agent_actions` operations back
  into anything resembling an approval/lifecycle transition — this is
  the negative-space test protecting the Design Rationale's "no gate
  under another name" constraint.

## Documentation Updates

- None beyond this ticket's own record — architecture.md's consolidated
  MCP write-up is deferred to ticket 009.
