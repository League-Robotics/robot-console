---
id: '004'
title: 'Protocol hygiene: receive() facade, relay reply grammar, session/codec fixes'
status: in-progress
use-cases:
- SUC-001
depends-on:
- '001'
github-issue: ''
issue: rearch-15-protocol-hygiene-receive-facade-relay-reply-grammar.md
completes_issue: true
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Protocol hygiene: receive() facade, relay reply grammar, session/codec fixes

## Description

`packages/protocol` needs no rewrite, only hygiene: fix
`Session.connect()` to reset `lastResendN`/`resendStreak` (not just
`nextId`/`pending`/`seq`); make `handleReply` return a
`{kind: "malformed"}` event instead of throwing; fix the RADIOBRIDGE
banner fixture; move the `<` receive-prefix strip and the relay `#`
reply grammar out of the host and into protocol; add a pure `receive()`
facade encoding the decode → classify → drop → `handleReply` → resend
ordering; make the 94 vendor-fixture-dependent tests run without
`vendor/`. Remove dead exports (`PING_LINE`/`STATUS_LINE`), move
`normalizeDeviceType` to the host/UI layer.

This lands before ticket 005 (LineLink core) so LineLink can consume
`receive()` and the relay grammar helpers directly rather than
duplicating decode/classify/reply-ordering logic that would need
refactoring later (see `sprint.md` Architecture, rearch-15's own
dependency note: "best landed before rearch-04... consume the new
helpers").

## Acceptance Criteria

- [ ] `Session.connect()` resets `lastResendN`/`resendStreak`, matching
      `resyncTo()`; `seq` after connect/resync is documented and
      consistent.
- [ ] `handleReply` returns `{kind: "malformed"}` for a malformed
      ack/nack instead of throwing.
- [ ] `banner.test.ts`'s RADIOBRIDGE fixture is internally consistent
      (`deviceIdToName` matches the fixture's name); a
      `bannerNameMatchesSerial(banner)` helper exists.
- [ ] `stripReceivePrefix()` is applied in `decodeLine`; a `"foreign"`
      observer hook exists for dropped lowercase verbs.
- [ ] `relay/commands.ts` exports `parseRelayStatusLine`,
      `classifyRelayReply`, `relayPreambleSteps(ch, grp)`,
      `buildTransientChannelGroupLine`, `buildRadioSendLine(text)`;
      `!CG` is range-checked via `validateRadioAddress`.
- [ ] A pure `receive()` facade exists encoding the
      decode→classify→drop→`handleReply`→resend ordering; its test
      reproduces the gap-stall-recover scenario currently only in
      `LineRouter.test.ts`.
- [ ] `vitest run packages/protocol` on a checkout **without**
      submodules runs ≥ 160 synthetic tests and skips only the
      golden-vector `it.each` blocks.
- [ ] `grep -rn "RelayCommandPlane\|deviceRegistry\|sprint" packages/protocol/src --include=*.ts` (non-test) → nothing.
- [ ] `PING_LINE`/`STATUS_LINE` are removed; `normalizeDeviceType` moves
      to `wsMessages.ts`.

## Testing

- **Existing tests to run**: full `packages/protocol` suite, with and
  without `vendor/` present, on both platforms.
- **New tests to write**: streak-reset-after-connect test; malformed-reply
  event test; prefix-strip test; relay reply parser tests; `receive()`
  facade ordering test (including the gap-stall-recover scenario).
- **Verification command**: `npm test -- packages/protocol` (run once
  with `vendor/` submodules present, once with them removed/renamed, to
  confirm the fixture-independence acceptance criterion).

## Implementation Plan

**Approach**: Fix the session/codec/banner bugs first (small, isolated,
each with its own test), then build the `receive()` facade as a
composition of the now-fixed pieces, then do the mechanical
extraction of the relay grammar and the vendor-fixture test rework.

**Files to create/modify**:
- `packages/protocol/src/v6/session.ts`, `verbs.ts` (new, split from
  `session.ts`), `codec.ts`, `banner.ts`.
- `packages/protocol/src/relay/commands.ts`.
- `packages/protocol/src/v6/receive.ts` (new): the facade.
- `packages/protocol/src/telemetry.ts`, `telemetryUnits.ts` (new).
- `packages/protocol/src/deviceType.ts` → move `normalizeDeviceType` to
  `packages/host/src/.../wsMessages.ts` (or protocol's `wsMessages.ts`
  if that's where it lives per the issue).
- Test files: move vendor-fixture loads inside
  `describe.skipIf(!present)` blocks.
- `packages/host/src/link/lineStream.ts`,
  `packages/host/src/link/RelayCommandPlane.ts`: remove the now-moved
  prefix-strip and inline `#`-reply regexes (this half of the change
  lands here since ticket 006 is the one that builds the new
  `RelayCommandPlane` under LineLink — coordinate so this ticket only
  removes what protocol now owns, without yet wiring the new adapters).

**Documentation updates**: trim `packages/protocol`'s narrative comments
per the issue; drop host/sprint references from source comments.
