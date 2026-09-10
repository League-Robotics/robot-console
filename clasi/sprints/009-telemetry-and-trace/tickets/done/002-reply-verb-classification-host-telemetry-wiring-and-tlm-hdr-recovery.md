---
id: '002'
title: Reply-verb classification + host telemetry wiring and TLM HDR recovery
status: done
use-cases:
- SUC-001
- SUC-003
depends-on:
- '001'
github-issue: ''
issue: robot-console-two-level-ui-and-multi-transport-roadmap.md
completes_issue: false
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Reply-verb classification + host telemetry wiring and TLM HDR recovery

## Description

Two closely-related changes that together make `thdr`/`t` reach the
host as decoded telemetry instead of raw console noise:

**1. `packages/protocol/src/v6/codec.ts`** — add `"thdr"` and `"t"` to
`REPLY_VERBS`, exactly as `"funcs"` was added (see that entry's own
comment). This is the one-line change that makes `classifyLine` report
`"reply"` for these verbs, so `LineRouter.handleLine` routes them to
`onLine` instead of `onUnrouted`. No other codec change.

**2. `packages/host/src/deviceRegistry.ts`** — extend the existing
per-endpoint reply-dispatch chain (the `if (decoded.verb === ...)`
branches that already special-case `status`/`estop`/`funcs`, around
where `robotStatus`/`funcsBuffer` are populated) with `thdr`/`t`
handling:
- New `EndpointState` fields mirroring the existing
  `robotStatus`/`funcsBuffer`/`pollAwaitingStatus` pattern: something
  like `telemetryHeader?: readonly string[]`, and a guard flag so a
  `TLM HDR` recovery request is sent at most once per observed gap
  (not resent every subsequent header-less `t` frame).
- On `thdr` → store the new header via ticket 001's decoder, forward a
  header update over the new WS message (ticket 003 defines the exact
  message shape — coordinate field names with that ticket, or land
  this ticket's message shape first since it is upstream).
- On `t` with no header held → do not decode; if the one-shot guard is
  clear, send `TLM HDR` (never `TLM NOW` — a test must pin this) and
  set the guard; forward a "no header yet" signal (or simply omit a
  frame — verify against ticket 003's exact contract) so the UI can
  render "waiting for header".
- On `t` with a header held → zip via ticket 001's `telemetry.ts`,
  forward the resulting frame over the new WS message; clear the
  one-shot guard once a header is confirmed held (it must be able to
  fire again on a later, independent gap).
- Do **not** add a polling timer for this (unlike `pollStatus`'s
  `setInterval` for `STATUS`) — the wire already free-runs a 20-frame
  header auto-refresh (protocol.md §10.2); this is event-triggered
  recovery only.
- Telemetry frames/headers must not be appended to the per-device rx
  log (`emitLine`) or trigger a full `EndpointsMessage` snapshot
  broadcast — they ride the dedicated message type only.

Coordinate with ticket 003 on the exact WS message shape added to
`packages/host/src/wsMessages.ts` (a new discriminated type, e.g.
`TelemetryMessage` with `type: "telemetry"`, `endpointId`, and either a
`header` or `frame` payload) — this ticket is the natural place to add
it since it's the first producer.

## Acceptance Criteria

- [x] `thdr` and `t` are in `REPLY_VERBS`; `classifyLine("thdr")` and
      `classifyLine("t")` both return `"reply"`.
- [x] A `thdr`/`t` line no longer reaches `LineRouter`'s `onUnrouted`
      callback (a regression test on `LineRouter` or `deviceRegistry`
      confirms this).
- [x] A `t` frame with no header held for an endpoint triggers exactly
      one `TLM HDR` — not `TLM NOW` — and does not re-send it on
      subsequent header-less frames while still waiting.
- [x] Once a header is held, `t` frames decode via ticket 001's module
      and forward as telemetry WS messages.
- [x] No `setInterval`/polling timer is added for header recovery.
- [x] Telemetry traffic does not append to the per-device rx log buffer
      (`MAX_LINES_PER_DEVICE`) and does not trigger an `EndpointsMessage`
      snapshot broadcast.
- [x] The new WS message type is added to `wsMessages.ts` with a
      `type` discriminator distinct from `"line"`/`"endpoints"`, and
      `isServerMessage`'s type guard (or equivalent) recognizes it.

## Testing

- **Existing tests to run**: `npx vitest run packages/protocol
  packages/host` — confirm `LineRouter.test.ts`,
  `deviceRegistry.test.ts`, and `codec.test.ts` still pass unmodified
  in their pre-existing cases.
- **New tests to write**: a `codec.test.ts` case for `thdr`/`t`
  classification; a `deviceRegistry.test.ts` (or `LineRouter.test.ts`)
  case for the full header-recovery sequence — no header → one `TLM
  HDR` sent → `thdr` arrives → subsequent `t` decodes — plus a case
  proving a second header-less `t` frame does not send a second `TLM
  HDR` while the first is still outstanding.
- **Verification command**: `npx vitest run packages/protocol
  packages/host`
