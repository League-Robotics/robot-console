---
status: pending
---

# Protocol package hygiene: receive() facade, relay reply grammar, session fixes, fixture-independent tests

## Description

`packages/protocol` is a clean zero-I/O foundation and needs no rewrite
(`05-protocol.md`). The findings are small and all pure:

Bugs
- `Session.connect()` (`session.ts:434-439`) resets `nextId`, `pending`,
  `seq` but not `lastResendN`/`resendStreak`, unlike `resyncTo()`; a
  post-reconnect nack can trip give-up early. Untested.
- `seq` after `connect()` is 1 while `resyncTo(1)`/`nack 1` give 0 for the
  same robot state.
- `handleReply` throws `SessionError` on a malformed ack/nack — the only
  place wire input throws.
- `banner.test.ts:5-16` RADIOBRIDGE fixture is internally inconsistent:
  `deviceIdToName(1779042496) = "gatav"`, not `"getez"`. No name↔serial
  cross-check exists although spec §2.2 guarantees the relationship.

Grammar living in the host
- The `< ` receive-prefix strip is in `host/link/lineStream.ts:44`; spec
  §3.7 assigns it to protocol. `parseBanner`/`decodeLine` fail on a
  prefixed line.
- The relay's `#` replies (`# channel: 47 group: 60 …`, `# echo: OFF`,
  `# entering data plane`, `# error: …`) are five inline regexes in
  `host/link/RelayCommandPlane.ts:203-229`.
- The required decode → classify → drop → `handleReply` → send `resend[]`
  before dispatch ordering lives only in `host/link/LineRouter.ts:66-90`.
- `REPLY_VERBS` is a closed allowlist; four silent-drop regressions so far
  (`codec.ts:382-397`).

Tests
- 94 of 162 tests do not run without the `vendor/` submodules because
  three files load fixtures at module top level; the fixture-free trap
  tests (nack arithmetic, endianness) go down with them.

Misc: `PING_LINE`/`STATUS_LINE` are dead exports with a cross-layer codec
import (`commands.ts:82, 193, 201`); `normalizeDeviceType` is WS-compat
and belongs in the host/UI layer; 35 comment lines reference host
modules and sprint tickets; spec says 11 sequenced verbs, code has 13.

## Proposed resolution

- `session.ts`: `connect()` resets the streak fields; pick `seq = 0`
  consistently after connect/resync (document); `handleReply` returns a
  `{ kind: "malformed" }` event instead of throwing. Split
  `SEQUENCED_VERBS`/`isSequencedVerb` and `REPLY_VERBS`/`isReplyVerb` into
  `v6/verbs.ts`. Add a pure facade
  `receive(raw): { outbound: string[]; event?: AckNackEvent; line?: DecodedLine; dropped?: … }`
  that encodes the `LineRouter` ordering; the host's `LineRouter` becomes
  a thin wrapper or is deleted.
- `codec.ts`: `stripReceivePrefix()` applied in `decodeLine` next to the
  `\r` strip; a `"foreign"` observer hook so the host can log dropped
  lowercase verbs.
- `banner.ts`: `bannerNameMatchesSerial(banner)`; fix the RADIOBRIDGE
  fixture to a consistent pair.
- `radioAddress.ts`: export `validateRadioAddress(ch, grp)` (non-throwing)
  and `isWellFormedName(name)`.
- `relay/commands.ts`: remove `PING_LINE`/`STATUS_LINE` and the codec
  import; add `parseRelayStatusLine`, `classifyRelayReply`,
  `relayPreambleSteps(ch, grp)` (step table with confirm predicates),
  `buildTransientChannelGroupLine` (for rearch-12) and
  `buildRadioSendLine(text)` (the `> ` prefix, for the sweep); range-check
  `!CG` via `validateRadioAddress`.
- `telemetry.ts`: delete the `TLM HDR` comment; add `telemetryUnits.ts`
  (column → unit) so `PathTracePanel.tsx:262`'s `/100` has a source.
- `deviceType.ts`: move `normalizeDeviceType` to `wsMessages.ts`; add
  `toPersistedKind(DeviceType)`; dedupe the role allowlists with
  `banner.ts`.
- Tests: move vendor-fixture loads inside `describe.skipIf(!present)`
  blocks; add tests for the streak-reset bug, the malformed-reply event,
  the prefix strip, the relay reply parser, and the facade ordering.
- Trim narrative comments to the tables that matter; drop host/sprint
  references.

## Acceptance

- `vitest run packages/protocol` on a checkout **without** submodules
  runs every synthetic test (≥ 160) and skips only the golden-vector
  `it.each` blocks.
- `receive()` test reproduces the gap-stall-recover scenario currently
  only in `LineRouter.test.ts`.
- `grep -rn "RelayCommandPlane\|deviceRegistry\|sprint" packages/protocol/src --include=*.ts` (non-test) → nothing.
- Host's `RelayCommandPlane` uses `classifyRelayReply`/`relayPreambleSteps`
  and contains no `#`-reply regexes.

## Depends on

Nothing. Best landed before rearch-04/rearch-10 consume the new helpers,
but can be done in parallel with clear interfaces.

## References

- `docs/reviews/2026-09-11/05-protocol.md` §1–§6
- `docs/design/specification.md` §3.4–§3.7
