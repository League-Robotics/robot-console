---
id: '004'
title: Make request_flash's outcome recoverable after a client timeout, and harden
  it against a dropped connection
status: done
use-cases:
- SUC-006
depends-on: []
github-issue: ''
issue: mcp-flash-outlives-client-timeout.md
completes_issue: true
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Make request_flash's outcome recoverable after a client timeout, and harden it against a dropped connection

## Description

`request_flash` awaits `startFlash`'s terminal promise so its MCP
response carries the real outcome — but a real flash can outlast a
client's default 60 s MCP timeout (confirmed live in 019-008: `tigez`
flashed successfully but the calling client never received the result).
A timeout then looks identical to a failure, risking a needless retry
of a flash that already succeeded.

This is independent of tickets 001-003 and can be worked in any order
relative to them.

**Important finding from planning**: the durable recovery path the
issue asks for mostly already exists. `mcp/agentActionLog.ts` (019-006)
durably records every executed flash regardless of whether the caller
is still listening, and `projection.ts`/`mcp/tools/inspect.ts` (also
019-006) already fold each device's 5 most recent `agent_actions` rows
— including `result`/`resultReason` — into `get_device_status`'s own
`recentAgentActions` field. This already **is** the issue's own "Option
3: both" design (inline outcome when the client is still listening;
a durable, always-written fallback otherwise). Do **not** add a handle,
a new column, or a new table — `agent_actions` stays append-only, and a
recovery read against it is not a pending lifecycle (sprint 019's own
Revision note; this sprint's own Out of Scope).

What is actually missing, and this ticket's real scope:

1. **Verify crash-safety of the existing path.** Confirm (with a test,
   not just reasoning) that when an MCP client's connection is aborted
   or its own request times out *before* `startFlash`'s promise
   resolves, `mcp/tools/flash.ts`'s own async handler still runs to
   completion (the flash finishes, `record()` still writes exactly one
   `agent_actions` row) and, critically, that attempting to write the
   now-undeliverable MCP response does **not** throw an uncaught
   exception that could crash the host process — this host serves other
   agents' sessions concurrently, so a crash here is a much bigger risk
   than the caller's own missed response. If the SDK's
   `StreamableHTTPServerTransport.handleRequest`/the underlying Express
   response object does throw on a write-after-close, wrap it (a narrow
   try/catch around the response path only, changing no other behavior)
   — this is the one place actual code may need to change; if
   verification shows it already degrades safely, no code change is
   needed there, only the test that proves it.
2. **Correct `request_flash`'s own tool description.** It currently
   says the `flash` snapshot overlay "remains available ... as a
   fallback if this call's own connection drops" — true only until the
   flash settles, since `finishFlash`/`failFlash` delete that overlay
   the instant it does (unchanged this sprint). Replace that claim with
   the actual durable fallback: call `get_device_status {deviceId}` and
   read `recentAgentActions[0]` for the outcome once the overlay is
   gone.
3. **No change to `request_flash`'s own execution/await behavior.**

## Acceptance Criteria

- [x] A test that starts a flash via `request_flash`'s handler with a
      fake `startFlash` whose promise does not resolve immediately,
      simulates the caller's own request context closing/aborting
      before that promise resolves, then resolves it — and asserts (a)
      the handler runs to completion, (b) exactly one `agent_actions`
      row is written with the real outcome, and (c) no exception
      escapes the handler (the host process would not crash).
- [x] A companion test calls `get_device_status` afterward (same fake
      store) and confirms `recentAgentActions[0]` surfaces that flash's
      `kind`/`caller`/`result`/`resultReason` correctly.
- [x] `request_flash`'s `registerTool` description no longer claims the
      `flash` overlay is available "as a fallback if this call's own
      connection drops" — it names `get_device_status`/
      `recentAgentActions` as the durable recovery path instead.
- [x] No schema change to `agent_actions` (`migrations/` directory
      unchanged); no new MCP tool added; no `status`/pending column
      anywhere.
- [x] No existing `mcp/tools/flash.test.ts`/`mcp/endToEnd.test.ts` case
      regresses.

## Testing

- **Existing tests to run**: `npx vitest run packages/host/src/mcp`
- **New tests to write**:
  - `mcp/tools/flash.test.ts`: the disconnect-mid-flash simulation
    described above (fake `startFlash` + a fake request context whose
    abort is triggered mid-await), asserting the audit row and no
    uncaught exception.
  - `mcp/endToEnd.test.ts` (or a new adjacent case): a full
    `request_flash` (settling late) → simulated client disconnect →
    fresh `get_device_status` call → `recentAgentActions` shows the
    correct outcome, through the same production wiring
    (`createDefaultMcpServer`) the existing end-to-end suite already
    uses.
  - A live bench verification once hardware is available again (per
    this sprint's "resolve by property, not by name" lesson): start a
    flash on whichever device is currently flashable, force the calling
    client to disconnect before it settles, confirm via
    `get_device_status` afterward — mirroring 019-008's own evidence
    trail.
- **Verification command**: `npx vitest run packages/host/src/mcp`
