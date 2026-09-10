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
- New `EndpointState` field mirroring the existing
  `robotStatus`/`funcsBuffer` pattern: a lazily-created per-endpoint
  `TelemetryDecoder` (ticket 001), reset on session teardown and on
  HELLO/resync so a stale header from a prior session is never zipped
  against a new one's frames.
- On `thdr` → store the new header via ticket 001's decoder, forward a
  header update over the new WS message.
- On `t` with no header held, or a field-count mismatch against the
  held header → **drop the row silently**: do not decode, forward
  nothing (the client's own default state already reads as "waiting
  for header"), and send **no** recovery command.
- On `t` with a header held → zip via ticket 001's `telemetry.ts`,
  forward the resulting frame over the new WS message.
- **No `setInterval`/polling timer, and no `TLM HDR` (or any other)
  recovery request.** Header recovery is entirely passive — see the
  "Revision: passive recovery, no `TLM HDR`" note below.
- Telemetry frames/headers must not be appended to the per-device rx
  log (`emitLine`) or trigger a full `EndpointsMessage` snapshot
  broadcast — they ride the dedicated message type only.

The exact WS message shape is added to `packages/host/src/wsMessages.ts`
as `TelemetryMessage`, `type: "telemetry"`, `endpointId`, and either a
`header` or `frame` payload — this ticket is the natural place to add
it since it's the first producer.

### Revision (bench finding, ticket reopened): passive recovery, no `TLM HDR`

This ticket originally specified an event-triggered `TLM HDR` recovery
request, guarded like `pollAwaitingStatus`'s single-outstanding-request
pattern, on a `NoHeaderHeld`/field-count-mismatch gap. **Bench testing
against gopiv (firmware `v1.20260909.2`,
`vendor/pxt-nezha-diffdrive`)** showed this was wrong on two counts:

1. **The firmware has no `HDR` mode.**
   `WireHandler::parseTlmMode` (`vendor/pxt-nezha-diffdrive/src/comms/
   wire_handler.cpp:174-191`) recognizes only `OFF`/`POSE`/`FULL`/
   `NOW`/`AUTO`/`BUFFER` as `TLM` mode tokens. Sending `TLM HDR` against
   real firmware drew `err 2` plus a nack — the session's own
   nack-driven resync absorbed the fallout, but the send itself was a
   verb the firmware does not accept, not a working recovery path.
2. **No request is needed anyway.** `WireHandler::emitTelemetry`
   (`vendor/pxt-nezha-diffdrive/src/comms/wire_handler.cpp:1440-1453`)
   re-emits `thdr` on its own whenever the column set changes
   (`headerChanged(snapshot)`) **or** every `kHeaderRefreshFrames`
   frames (`framesSinceHeader_ >= kHeaderRefreshFrames`) — a host that
   missed (or never held) a header only has to wait for the firmware's
   next periodic re-emission, which arrives unprompted.

Recovery is therefore **passive**: a header-less or mismatched `t` row
is dropped silently (decoder state and any currently-held header are
left untouched — `zipTelemetryFrame`/`decodeFrame` never mutate on a
mismatch), no command is ever sent for it, and the very next `thdr`
(periodic or on-change) resyncs decoding with no host-side action. This
replaces every `TLM HDR`-sending behavior this ticket previously
specified; `TLM NOW` was never sent in either revision (protocol.md
§10.5's own point — `TLM NOW` was never the recovery path — still
holds, it just turns out there is no request-based recovery path at
all against this firmware).

## Acceptance Criteria

- [x] `thdr` and `t` are in `REPLY_VERBS`; `classifyLine("thdr")` and
      `classifyLine("t")` both return `"reply"`.
- [x] A `thdr`/`t` line no longer reaches `LineRouter`'s `onUnrouted`
      callback (a regression test on `LineRouter` or `deviceRegistry`
      confirms this).
- [x] A `t` frame with no header held for an endpoint, or one whose
      field count mismatches the held header, is dropped silently — no
      frame forwarded, no `TLM HDR` (or any other) command sent, ever
      (revised: the firmware has no `HDR` `TLM` mode —
      `wire_handler.cpp:174-191` — and re-emits `thdr` on its own —
      `wire_handler.cpp:1440-1453` — so recovery is passive).
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
  classification; `deviceRegistry.test.ts` cases for: a header-less `t`
  row dropped silently with no command sent; a field-count-mismatched
  `t` row (against an already-held header) dropped the same way; a
  later `thdr` passively resyncing a previously-dropped gap with frames
  resuming decoding and no command ever sent; and decoder reset on
  session teardown and on HELLO/resync (each followed by a fresh `thdr`
  resuming decoding).
- **Verification command**: `npx vitest run packages/protocol
  packages/host`
