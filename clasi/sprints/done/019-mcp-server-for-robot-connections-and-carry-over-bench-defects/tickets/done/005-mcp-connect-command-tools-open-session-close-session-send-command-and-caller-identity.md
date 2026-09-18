---
id: '005'
title: MCP connect/command tools (open_session, close_session, send_command) and caller
  identity
status: done
use-cases:
- SUC-005
depends-on:
- '004'
github-issue: ''
issue: mcp-server-for-robot-connections.md
completes_issue: false
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# MCP connect/command tools (open_session, close_session, send_command) and caller identity

## Description

Second tool category (per `sprint.md`'s Architecture): connect and
command, sequenced after inspect-only (ticket 004) and before drive/
flash (tickets 006-008), so the sprint delivers usable value in order.

This ticket also introduces MCP caller identity, since a session opened
by an agent needs to be visibly distinguishable from one opened by a
human at the browser — the console's own "who holds this board"
accounting (architecture.md §4, `board_owner`) must not go blind to who
actually opened a session.

**Prerequisite refactor** (stated in `sprint.md`'s Architecture "Impact
on Existing Components"): `server.ts`'s `session-open`/`session-close`/
`send-command` WS handler bodies are closures over `(_ws, message)`
today. Extract their core logic into standalone, WS-independent
functions (`openSession`, `closeSession`, `sendCommand`) that both the
existing WS handlers and this ticket's MCP tools call — this keeps
exactly one implementation of each operation rather than two that can
drift. This extraction is a refactor of existing code with no behavior
change for the browser path; cover it with the existing `server.test.ts`
suite passing unchanged before adding new MCP-specific tests.

**Gated-verb exclusion**: `send_command`'s `verb` must reject the seven
motion verbs this sprint's Architecture names as gated —
`WHEELS_X`, `WHEELS_V`, `MOVE_X`, `MOVE_V`, `GO_TO_R`, `GO_TO_W`, `RUN`
(`vendor/pxt-nezha-diffdrive/src/comms/wire_handler.cpp`'s
`kCommandTable`) — with a message pointing the caller at
`request_drive` (ticket 007). `STOP` and `ESTOP` remain always-allowed
here (Design Rationale: a safety-decreasing action must never wait on a
human clicking Approve).

## Acceptance Criteria

- [x] `server.ts`'s `session-open`, `session-close`, and `send-command`
      handlers are refactored into standalone functions the WS handlers
      call as thin wrappers; the existing WS-level test suite for these
      three commands passes unchanged (proves no behavior regression).
- [x] `sessions` gains `origin` (`'ui' | 'mcp'`, default `'ui'`) and
      `caller` (nullable text) columns via the store's existing
      migration mechanism; every existing/browser-opened session
      continues to write `origin: 'ui'`, `caller: NULL`.
- [x] `open_session {linkId}` / `{relayLinkId, name}` MCP tool: calls the
      extracted `openSession` function, writes `origin: 'mcp'`,
      `caller: <clientInfo.name>` (from the MCP `initialize` handshake)
      on the resulting `sessions` row.
- [x] `close_session {linkId}` MCP tool: calls the extracted
      `closeSession` function.
- [x] `send_command {linkId, verb, fields?}` MCP tool: calls the
      extracted `sendCommand` function for any verb except the seven
      gated motion verbs, which are rejected with a message naming
      `request_drive`, with no write performed.
- [x] The console UI's device card shows an MCP-opened session's origin/
      caller distinctly from a browser session (a small, additive UI
      change — e.g. an "Agent: `<caller>`" label alongside the existing
      "who holds this board" text).
- [x] A session opened by MCP can be closed from the browser (existing
      close affordance) and vice versa; both directions are visible to
      the other side via the existing change-feed/snapshot mechanism,
      with no new polling.
- [x] Tool schemas follow the same empty-argument-safe design discipline
      as ticket 004 (`.claude/rules/tool-call-empty-args.md`).

## Implementation Plan

**Approach**: extract first (prove no regression), then add the MCP
tool layer as a thin caller of the extracted functions plus the new
identity write.

**Files to modify**:
- `packages/host/src/server.ts` — extract `openSession`/`closeSession`/
  `sendCommand` from the three handler closures; handlers become thin
  wrappers.
- `packages/host/src/store/` — add `sessions.origin`/`sessions.caller`
  columns + migration; typed op(s) to write them.
- `packages/host/src/store/index.ts` (or wherever `sessions` writes are
  typed) — thread `origin`/`caller` through the existing session-open
  write path.

**Files to create**:
- `packages/host/src/mcp/tools/connect.ts` — `open_session`,
  `close_session`, `send_command`, calling the extracted functions.

**UI files to modify** (small, additive):
- The device-card component that already renders `board_owner`/session
  info — add the origin/caller label.

**Testing plan**:
- Scoped `vitest` run: `server.test.ts` (must still pass unchanged for
  the three extracted handlers), new `mcp/tools/connect.test.ts`,
  store migration test — not the full suite.
- New test: an MCP-opened session's `sessions` row has `origin: 'mcp'`
  and the declared `caller`; a browser-opened one still has `origin:
  'ui'`, `caller: NULL`.
- New test: `send_command` with each of the seven gated verbs is
  rejected with no write; `send_command STOP`/`ESTOP` succeeds
  unconditionally.
- New test: closing from one origin is visible to the other via the
  change feed (fake store, assert the emitted change).

## Documentation Updates

- None beyond this ticket's own record — architecture.md's consolidated
  MCP write-up is deferred to ticket 009.
