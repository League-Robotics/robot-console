---
id: '007'
title: MCP drive tool (request_drive), executing immediately through the motion-verb
  allowlist
status: open
use-cases:
- SUC-006
depends-on:
- '006'
github-issue: ''
issue: mcp-server-for-robot-connections.md
completes_issue: false
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# MCP drive tool (request_drive), executing immediately through the motion-verb allowlist

## Description

Third tool category. Motion was deliberately out of scope for all of
sprint 018 (no motors on the bench then); this ticket is the first time
this codebase exposes a motion-starting verb to an MCP-connected agent.

**Revision note**: this ticket originally made `request_drive` a
producer of `pending_actions` rows, gated on ticket 006's now-superseded
confirmation subsystem. Eric overrode the approval gate at the
stakeholder approval gate (see `sprint.md`'s Architecture Revision and
Design Rationale, "drive and flash execute immediately") — there is no
approval step anywhere in this sprint's design. `request_drive` keeps
its name (matching ticket 005's `send_command` rejection message, which
already points a caller at `request_drive` by that exact name) but now
executes the moment a valid call arrives: it depends on ticket 006 only
for the audit-log write, not for any gating.

**Allowlist** (from `vendor/pxt-nezha-diffdrive/src/comms/
wire_handler.cpp`'s `kCommandTable`, confirmed against the firmware
source, not assumed): `WHEELS_X`, `WHEELS_V`, `MOVE_X`, `MOVE_V`,
`GO_TO_R`, `GO_TO_W`, `RUN`. `STOP`/`ESTOP` are explicitly **not**
handled by this tool — they remain always-available through
`send_command` (ticket 005). This split is unaffected by the removal of
the approval gate: it is now purely a scope/allowlist decision
(`request_drive` validates per-verb field shapes that `STOP`/`ESTOP`
don't have), not a safety-vs-approval one — see `sprint.md`'s reworded
Design Rationale entry for `STOP`/`ESTOP`.

## Acceptance Criteria

- [ ] `request_drive {linkId, verb, fields}` validates `verb` against the
      seven-verb allowlist above; any other verb (including `STOP`/
      `ESTOP`) is rejected with a message pointing at `send_command`
      instead.
- [ ] `request_drive` validates `fields` against each verb's own field
      shape (per `wire_handler.cpp`'s per-verb decode functions —
      `decodeWheelsX`, `decodeMoveX`, etc.) before calling `sendCommand`,
      so a malformed request fails fast with a clear error rather than
      being sent to the firmware for it to reject.
- [ ] On valid input, `request_drive` calls the extracted `sendCommand`
      function (ticket 005) **immediately** — no intermediate row, no
      wait, no approval step of any kind — and returns the same reply
      `send_command` would return for that verb.
- [ ] `request_drive` requires an already-open session on the target link
      (a correctness precondition — `sendCommand` needs a link to send
      on) — if none exists, it fails with a message directing the caller
      to `open_session` first, rather than opening one implicitly.
- [ ] Every successful `request_drive` call writes exactly one row to
      ticket 006's `agent_actions` log via `agentActionLog.record()`,
      after the `sendCommand` call.
- [ ] The full path — `request_drive` call → `sendCommand` → robot
      receives the verb → `agent_actions` row written — is demonstrated
      end-to-end in at least one integration-style test against a fake
      session/store (real hardware verification happens in ticket 009,
      hardware-permitting).
- [ ] Tool schema follows the same empty-argument-safe design discipline
      as tickets 004/005.

## Implementation Plan

**Approach**: a thin tool that validates, then delegates directly to the
extracted `sendCommand` function and ticket 006's audit log — no
producer/consumer split, no queue.

**Files to create**:
- `packages/host/src/mcp/tools/drive.ts` — `request_drive`, the
  allowlist, and per-verb field validation (reuse
  `@robot-console/protocol`'s existing decode/validation logic if it
  already models these verbs' field shapes; otherwise write the
  narrowest validation needed and note that this may want to move into
  `packages/protocol` later if the UI ever needs the same validation
  client-side).

**Testing plan**:
- Scoped `vitest` run: new `mcp/tools/drive.test.ts` — not the full
  suite.
- New test: each of the seven allowlisted verbs, with valid fields,
  calls `sendCommand` with the exact verb/fields and writes exactly one
  `agent_actions` row.
- New test: `STOP`/`ESTOP` and any non-motion verb are rejected by this
  tool (directing to `send_command`), not silently accepted; no
  `agent_actions` row is written for a rejected call.
- New test: malformed fields for an allowlisted verb are rejected before
  `sendCommand` is called and before any `agent_actions` row is written.
- New test: calling `request_drive` on a link with no open session fails
  with a clear "open a session first" message, calls `sendCommand`
  never, and writes no `agent_actions` row.
- New test: there is no code path between validation passing and the
  `sendCommand` call — i.e., nothing an agent or any other caller can do
  delays or intercepts it.

## Documentation Updates

- None beyond this ticket's own record — architecture.md's consolidated
  MCP write-up is deferred to ticket 009.
