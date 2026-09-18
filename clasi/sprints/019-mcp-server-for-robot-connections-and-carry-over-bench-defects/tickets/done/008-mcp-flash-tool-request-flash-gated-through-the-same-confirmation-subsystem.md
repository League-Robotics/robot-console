---
id: 008
title: MCP flash tool (request_flash), executing immediately via startFlash
status: done
use-cases:
- SUC-007
depends-on:
- '006'
github-issue: ''
issue: mcp-server-for-robot-connections.md
completes_issue: false
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# MCP flash tool (request_flash), executing immediately via startFlash

## Description

Fourth and last tool category. Flashing was entirely out of scope for
sprint 018. `connect/flasher.ts` already owns `board_owner = 'flash'`
exclusivity, session close-first handoff, and progress reporting for a
browser-initiated flash (`flash-start`); this ticket exposes the same
operation to MCP, executing it directly — never a second, independent
call into `flasher.ts`.

**Revision note**: this ticket originally made `request_flash` a
producer of `pending_actions` rows, gated like drive through ticket
006's now-superseded confirmation subsystem. Eric overrode the approval
gate at the stakeholder approval gate (see `sprint.md`'s Architecture
Revision and Design Rationale, "drive and flash execute immediately"):
"Let the agents do whatever they want. We can always reflash a board
that needs to be reflashed. It's not hard." `request_flash` keeps its
name but now calls `startFlash` the moment a valid call arrives — no
pending row, no approval, no wait. This is the highest-blast-radius tool
in the sprint's surface (a bad flash can brick a board) and the
stakeholder was shown that framing explicitly before declining a gate;
this ticket must not reintroduce one under another name (no confirmation
flag, no default-deny policy, no "dry run unless confirmed" mode). What
replaces the gate is visibility: ticket 006's `agent_actions` audit log
and the `flash` overlay's `origin`/`caller` attribution, both live and
durable.

**Follow-up refinement**: an agent that starts a flash and cannot tell
whether it finished would be in an awkward spot — flashing is the one
long-running, failure-prone operation in this sprint's surface, and the
`flash` overlay this ticket sets is deleted the instant the operation
settles (`finishFlash`/`failFlash`, `server.ts`), so a purely poll-based
design could poll a moment too late and see nothing at all. Fixed per
`sprint.md`'s Design Rationale ("`request_flash` awaits its own
completion"): `request_flash` **awaits** `startFlash`'s own promise
(the underlying `runFlashTask`/`runNetworkFlashTask` already resolve to
a terminal `{status: "ok"} | {status: "error", ...}` — the existing WS
handler simply never awaits it) and returns that outcome directly in
its MCP response. This is not a reintroduction of the approval gate:
nothing stands between the call arriving and `startFlash` being
invoked; only the *response* waits for work that is already
unconditionally under way, the same as any long-running RPC.
`get_device_status` (ticket 004) remains available for interim
phase progress or as a fallback for a client whose own call to
`request_flash` times out.

Depends only on ticket 006 (the audit/visibility subsystem), not on
ticket 007 — the two tools are independent, direct callers of their own
extracted execute function (`sendCommand`/`startFlash`) plus ticket
006's `agentActionLog.record()`. Listed after 007 here for the same
incremental-value sequencing reason as before (motion is more
immediately useful; flashing carries the higher blast radius, so it's
reasonable to prove the lighter-weight tool first) — this ordering
rationale is unaffected by the gate's removal, only its original
"prove the gate on the lower-risk tool" framing no longer applies since
there is no gate to prove.

## Acceptance Criteria

- [x] `request_flash {deviceId, firmwareRef}` validates that the target
      device is flashable in its current state (mirrors whatever
      precondition `connect/flasher.ts`'s existing `flash-start` handler
      already checks — do not invent a new precondition set); an invalid
      or mid-session target is rejected with that same reason, starting
      no flash.
- [x] On valid input, `request_flash` calls the extracted `startFlash`
      function (ticket 005/this ticket's own extraction, whichever lands
      first — see Implementation Plan) **immediately** — session
      close-first, `board_owner = 'flash'` acquire, `flash()`, release in
      `finally` — no intermediate row, no wait for permission, no
      approval step of any kind.
- [x] `request_flash` **awaits** `startFlash`'s own promise through to
      its terminal outcome (`{status: "ok"} | {status: "error", ...}`,
      the same shape `finishFlash`/`failFlash` already produce) and
      returns that outcome directly in its MCP response — the calling
      agent learns success or failure from the `request_flash` call
      itself, with no polling required.
- [x] The `flash` snapshot overlay (`Snapshot`'s `flash?: {source,
      phase}`, extended by ticket 006 with `origin`/`caller`) is set to
      `origin: 'mcp'`, `caller: <name>` for the duration of this
      operation; progress/result flow through the existing
      `flash-progress`/`flash-result` messages unchanged, with no
      MCP-specific duplicate of either — `request_flash`'s own response
      is a second way to learn the same terminal outcome, not a
      replacement for those messages.
- [x] Every `request_flash` call that proceeds past the precondition
      check writes exactly one row to ticket 006's `agent_actions` log
      via `agentActionLog.record()`, written once `startFlash`'s promise
      settles, carrying the real `result`/`result_reason` — not written
      speculatively before the outcome is known.
- [x] Re-identification after a successful MCP-triggered flash proceeds
      exactly as it does today (automatic, via the USB watcher's
      re-enumeration) — this ticket adds no MCP-specific re-identify
      path, matching `connect/flasher.ts`'s own documented boundary.
- [x] A rejected precondition check never touches `board_owner`, never
      calls `flash()`, and writes no `agent_actions` row.
- [x] Tool schema follows the same empty-argument-safe design discipline
      as tickets 004/005/007.

## Implementation Plan

**Approach**: identical shape to ticket 007 — a thin validating direct
caller of code `flash-start` already exercises, plus one call to ticket
006's audit log — with one difference from 007: `request_flash` awaits
`startFlash`'s promise through to its terminal outcome before responding
and before writing the `agent_actions` row (see Revision note above and
`sprint.md`'s Design Rationale, "`request_flash` awaits its own
completion"), since `startFlash`'s own result is not known synchronously
the way `sendCommand`'s is.

**Files to create**:
- `packages/host/src/mcp/tools/flash.ts` — `request_flash` and its
  precondition check.

**Files to modify** (if not already done as part of ticket 005/006's
extraction work):
- `packages/host/src/server.ts` — extract `flash-start`'s handler body
  into a standalone `startFlash` function, mirroring the
  `openSession`/`closeSession`/`sendCommand` extraction from ticket 005,
  and wire the `origin`/`caller` write onto the `flash` overlay (ticket
  006 adds the field; this ticket is the first caller that actually sets
  `origin: 'mcp'`), if not already covered there.

**Testing plan**:
- Scoped `vitest` run: new `mcp/tools/flash.test.ts`,
  `connect/flasher.test.ts` (unchanged behavior) — not the full suite.
- New test: `request_flash` on a valid target calls `startFlash`
  immediately — no intermediate row, no wait for permission.
- New test: on a fake `startFlash` that resolves `{status: "ok"}`,
  `request_flash`'s MCP response reports success and exactly one
  `agent_actions` row is written with a successful `result`.
- New test: on a fake `startFlash` that resolves `{status: "error",
  error}`, `request_flash`'s MCP response reports the failure (including
  the message) and exactly one `agent_actions` row is written with a
  failed `result`/`result_reason` — the tool call itself must not throw
  or hang on a failed flash.
- New test: `request_flash` does not resolve until the fake `startFlash`
  promise resolves (asserted with a controllable/deferred fake, not a
  real timer) — proves the await, not just the eventual write.
- New test: `request_flash` on an invalid/mid-session target is rejected
  with the same reason `flash-start`'s existing handler would give,
  calls `startFlash` never, and writes no `agent_actions` row.
- New test: the `flash` overlay carries `origin: 'mcp'`/`caller: <name>`
  for an MCP-triggered flash and neither field for a browser-triggered
  one; `flash-progress`/`flash-result` fire unchanged either way.
- New test: there is no code path between the precondition check passing
  and the `startFlash` call — nothing delays or intercepts the *start*;
  only the response awaits the already-under-way operation.

## Documentation Updates

- None beyond this ticket's own record — architecture.md's consolidated
  MCP write-up is deferred to ticket 009.
