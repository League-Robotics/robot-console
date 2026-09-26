---
id: '006'
title: MCP send_command returns correlated robot reply lines
status: open
use-cases: [SUC-006]
depends-on: []
github-issue: ''
issue: mcp-send-command-does-not-return-robot-replies.md
completes_issue: true
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# MCP send_command returns correlated robot reply lines

## Description

`packages/host/src/mcp/tools/connect.ts`'s `send_command` handler
(~line 289) calls `sessionOps.ts`'s `sendCommand`, which only returns the
line it transmitted:

```ts
const sent = sendCommand(session, verb, fields as readonly WireField[]);
return jsonResult({ ok: true, sent: sent.replace(/\n$/, "") });
```

`packages/host/src/connect/sessionOps.ts`'s `sendCommand` (~line 285)
sends via `session.link.sendCommand`/`sendUnsequencedQuery` and returns
only the transmitted line text — no reply is captured anywhere on this
path. The robot's actual reply (and any unsolicited `DBG:` lines) never
reach the calling agent, forcing an agent to bypass the console and read
serial directly (per the issue).

`LineLink` already exposes exactly the two taps this needs, already
used elsewhere in this codebase for the same "show the robot's own
reply" purpose (`server.ts`'s student console broadcast, item G):

- `onAckNack(listener: AckNackListener)` — fires for a sequenced verb's
  correlated ack/nack (seq-matched already, by `LineLink`'s own
  `Session`).
- `onInboundLine(listener: RawLineListener)` — fires for every raw
  inbound line, decoded or not: an unsequenced query's own reply (`ID`,
  `STATUS`, ...), or an unsolicited `DBG:` line seen in the same window.

### What to change

In `mcp/tools/connect.ts`'s `send_command` handler (or a small
WS-independent helper in `sessionOps.ts`, mirroring how `sendCommand`
itself is shared with `server.ts`'s WS handler — do not duplicate this
logic in two places), around the `sendCommand` call:

1. Subscribe to `session.link.onAckNack` (for a sequenced verb) and
   `session.link.onInboundLine` (always) *before* sending.
2. Send via the existing `sendCommand`.
3. Collect whatever arrives within a short, fixed window (mirror this
   codebase's existing fixed-window conventions, e.g. the relay sweep's
   "wait ≤ 500 ms" or the boot-window identify's own schedule — pick one
   consistent with a query verb's expected round-trip, not a made-up
   number with no rationale documented).
4. Unsubscribe, and return `{ok: true, sent, reply: [...]}` — `reply` is
   the collected line(s), `[]` if nothing arrived (not an error: an
   unanswered query is not a `send_command` failure).

Update the tool's own `inputSchema`/description text (~line 262-288) to
document the new `reply` field in the return shape description — MCP
tool descriptions in this codebase are the primary docs an agent reads
before calling a tool, so this is not optional polish.

## Acceptance Criteria

- [ ] `send_command`'s result includes a `reply` field carrying the
      line(s) received within the collection window after sending.
- [ ] A sequenced verb's reply is correlated via the existing
      `onAckNack` seq-matching (already implemented in `LineLink`) — not
      a second, hand-rolled seq comparison.
- [ ] An unsequenced query's reply (and any unsolicited `DBG:` lines
      seen in the same window) come through `onInboundLine`.
- [ ] No reply within the window returns `reply: []` (or equivalent),
      still `ok: true` — never an error for an unanswered query.
- [ ] The subscription is torn down after the window closes in every
      case (success, no-reply, and an error thrown by `sendCommand`
      itself) — no listener leak across repeated `send_command` calls.
- [ ] The gated motion-verb rejection and the `HELLO`-is-rejected
      behavior (both already in this handler/`sendCommand`) are
      unchanged.
- [ ] The tool's own description text documents the new `reply` field.

## Testing

- **Existing tests to run**: `mcp/tools/connect.test.ts` (full
  `send_command` describe block, ~line 285 onward, to confirm the
  existing gated-verb and basic-send cases still pass with the new
  `reply` field added to the result shape).
- **New tests to write**: a fake `ConnectedSession`/`LineLink` test —
  send a query verb, have the fake link emit a reply line via
  `onInboundLine` shortly after, assert `reply` contains it; a case with
  no emitted reply asserts `reply: []` and `ok: true`; a sequenced-verb
  case asserts the ack/nack path is what populates `reply`.
- **Verification command**: run the workspace's vitest scripts scoped to
  `packages/host/src/mcp/tools/connect.test.ts`.
