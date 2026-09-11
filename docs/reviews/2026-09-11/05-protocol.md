# Review: `packages/protocol` (read-only)

Scope: `packages/protocol/src/**` (9 source files, 1,966 lines; 8 test files, 2,061 lines), checked against `docs/design/specification.md` §3 and §6. Paths below are relative to `/home/user/robot-console/`.

Environment facts that affect the findings:
- `tsc -p packages/protocol/tsconfig.json --noEmit` passes.
- `vitest run packages/protocol`: **5 files pass (68 tests), 3 files fail at module load** — `v6/codec.test.ts`, `v6/session.test.ts`, `radioAddress.test.ts` throw at import time because the `vendor/` submodules are not initialized here (`radioAddress.test.ts:24-44`, `codec.test.ts:35-48`, `session.test.ts:32-45`). That takes **94 tests (49+40+5) offline**, including the purely synthetic ones (the named nack-arithmetic test, the endianness test) that need no fixture at all. See §1 "Tests".

---

## 1. Module-by-module

### `src/index.ts` (15 lines)
Barrel; re-exports all eight modules. No issues.

### `src/naming.ts` (84 lines; 44 code / 40 comment)
- **Purpose**: CODAL five-letter name ↔ base-5 value. Port of mbdeploy `friendly_name()`.
- **API**: `NAME_CODEBOOK` (:21), `NAME_SPACE` (:32), `deviceIdToName(id)` (:45), `nameToValue(name)` (:73, throws on malformed).
- **Quality**: Correct; `>>> 0` truncation mirrors Python `& 0xFFFFFFFF`. `nameToValue` written independently of `deviceIdToName`, so round-trip test is real.
- **Tests** (`naming.test.ts`, 5 tests): worked example `2314287040 -> tovez`; CVCVC shape; malformed rejection; full round-trip 0..3124; 32-bit modulo. Adequate.
- **Leaks**: none.

### `src/radioAddress.ts` (80 lines)
- **Purpose**: name → default `(channel, group)` and inverse. Port of `mbrelay/naming.py`.
- **API**: `RadioAddress` (:38), `base5` (re-export of `nameToValue`, :44), `nameToRadioAddress(name)` (:53), `radioAddressToName(ch, grp)` (:70, throws outside derived space).
- **Quality**: Correct arithmetic (`25 + 2*(n%25)`, `1 + n/25`, bump past 10). Range constants (:30-36) are module-private; no non-throwing validator is exported — `relay/commands.ts:136-144` therefore cannot range-check `!CG` args without try/catch (see §4).
- **Tests** (`radioAddress.test.ts`, 5 tests): endianness trap `zuzuv = n=1, not vuzuz` (:65); round-trip via `base5`; vectors-file self-check; v1 sha (`full_space_sha256`) and v2 sha (`conformance_sha256`) over all 3125 names. Fixture is read live from `vendor/pxt-nezha-diffdrive/docs/radio-address-vectors.json` — good for conformance, bad for isolation (whole file, including the fixture-free endianness test, fails to load without the submodule).
- **Leaks**: none in src. Test imports `node:crypto`, `node:fs`, `node:path`, `node:url`.

### `src/banner.ts` (151 lines; 77 code / 74 comment)
- **Purpose**: parse the HELLO/boot banner in both live dialects.
- **API**: `BannerDialect` (:53), `ParsedBanner` (:60-81: role, commonName, name, serial:number, dialect, raw), `parseBanner(line)` (:121, `null` on non-match).
- **Quality**: `SERIAL_RADIX_BY_ROLE` (:43-47: RADIOBRIDGE=10, RADIORELAY=16, NEZHA2=10, default 10) — explicit per-role radix, correct per spec §3.3. `COLON_FORM` (:87) / `SPACE_FORM` (:90) both anchored `^...$`, so a stray `\r`, trailing space, or `< ` prefix makes a real banner return `null`; the host strips those first (`packages/host/src/link/lineStream.ts:44`), so correctness currently depends on every transport remembering to (see §2 item 7).
- **Missing**: no `name`↔`serial` consistency check. Spec §2.2 says the name **is** a hash of `FICR.DEVICEID[1]`, and `serial` is that same register, so `deviceIdToName(serial) === name` must hold. This is a free, pure detector for a mis-radixed serial (a hex serial parsed as decimal yields a different name). Note the RADIOBRIDGE fixture in `banner.test.ts:5-16` (`getez`/`1779042496`) **fails this check** (`1779042496 -> gatav`); the NEZHA2 fixture (`vevov`/`1198504156`) passes. The relay fixture's serial appears to be invented, which the test suite cannot currently notice.
- **Tests** (`banner.test.ts`, 11 tests): colon/decimal, colon/hex (RADIORELAY), space/decimal, shape parity, unknown role → decimal, non-banner, empty, missing fields (both dialects), non-hex serial, uppercase space sentinel rejected. Good shape; no `\r`/`< `/whitespace-tolerance tests (by design — but see above).
- **Leaks**: doc refs to `UsbSerialLink`, `server.ts` (:58).

### `src/deviceType.ts` (282 lines; 115 code / 167 comment)
- **Purpose**: banner → `DeviceType`; `ID`-reply parse and calibration refinement; wire-string coercion.
- **API**: `DeviceType = "unknown"|"relay"|"robot"|"calibration"` (:74), `ClassificationEvidence` (:83), `DeviceClassification` (:90-116), `classifyBanner(banner|null)` (:132), `IdReply`/`parseIdReply(fields)` (:204/:218), `refineForCalibration(cls, idReply)` (:256), `normalizeDeviceType(str)` (:280).
- **Quality**: Precedence (commonName > role allowlist > unknown) is clean and tested. Four near-identical return-object literals in `classifyBanner` (:139-195) could be one builder. `RELAY_ROLES`/`ROBOT_ROLES` (:122/:126) duplicate the role knowledge already in `banner.ts:43-47` — two allowlists of firmware family tokens that must be kept in sync.
- **Host concern leaking**: `normalizeDeviceType` (:280) exists to coerce a **WS-message** string from a newer host in an older UI — that is host↔UI wire compatibility, not robot wire protocol. It belongs in `wsMessages.ts` or the UI. `DeviceClassification` is likewise shaped as a UI view model (carries `dialect` "for diagnostics", `program`/`version` "for display"). Doc comments name `wsMessages.ts` (:6), `deviceRegistry.ts` (:57, :240, :249), `sprint.md`.
- **Tests** (`deviceType.test.ts`, 22 tests): all four precedence branches, case-insensitive commonName, commonName beats role, unknown preserves verbatim, `normalizeDeviceType` ×6, `parseIdReply` ×3, `refineForCalibration` ×4 (prefix, non-match, near-miss `calib-test`, non-robot unchanged). Thorough.

### `src/v6/codec.ts` (440 lines; 231 code / 209 comment)
- **Purpose**: line framing (encode/decode), `flags` hex field, case-as-direction classification.
- **API**: `MAX_LINE_BYTES=240` (:44), `CodecError` (:50), `FlagsField`/`flagsField()` (:98/:106), `WireField` (:125), `encodeLine(verb, fields?, id?)` (:214), `DecodedLine`/`BlankLine`/`LineTooLong`/`DecodeResult` (:260-284), `decodeLine(raw)` (:302, never throws), `REPLY_VERBS` (:369), `isReplyVerb` (:403), `LineDirection`/`classifyLine(verb)` (:429/:431).
- **Quality**: Sound. Exponent expansion (:135-163) handles the `1e-08` trap. `decodeLine` strips `\n` then `\r` (:304-309), counts the cap terminator-inclusive (:314), splits on space runs (:325), extracts a trailing `#digits` id only if `Number.isSafeInteger` (:330-337). `new TextEncoder()` allocated per call (:78) — trivial, hoist if desired.
- **Fragility**: `REPLY_VERBS` (:369-398) is a hand allowlist where a miss means a legitimate robot reply is classified `"foreign"` and **silently dropped**. It has already needed four out-of-process additions (`funcs`, `wificred`, `thdr`, `t` — :382-397), each discovered as a silent-drop bug on hardware. The spec's rule (§3.4) is "drop unknown lowercase silently"; the code does that faithfully, but the vocabulary being closed makes every new firmware reply a silent failure by default. Recommend at minimum a `"foreign"` tap the host can log, or an open policy for lowercase verbs *not* seen on a shared radio (USB has no overhearing).
- **Tests** (`codec.test.ts`, 49 tests, fixture-gated): golden-vector round-trip over 6 fixture sections (:95-102); ack/nack leading number is `fields[0]` never `.id` (:196-233); space-run and leading-whitespace framing; HELLO/banner framing; id-extraction edge cases incl. `#+5`/`#-5`/`# 5`/`#0` (:320-344); id `undefined` vs number; blank variants incl. `\r\n` (:364-375); 239/240/241-byte boundary both directions (:377-436); flags hex; encode refusals (verb, whitespace, empty, non-finite, negative/non-integer id, exponent rendering); `classifyLine` command/reply/foreign/case-sensitive/`thdr`+`t`/colon-banner-is-command. Excellent coverage — when it runs.
- **Leaks**: none.

### `src/v6/session.ts` (586 lines; 224 code / 362 comment — 62% comment)
- **Purpose**: host-side mirror of the firmware's `expectedNext_` cumulative ack/nack scheme; id assignment; pending/retransmit table; desync/give-up handling.
- **API**: `SessionError` (:126), `SEQUENCED_VERBS` (:139, 13 verbs), `isSequencedVerb` (:175, case-folded), `PendingCommand` (:185), `AckNackEvent` (:197: kind, n, seq, lastDone, lastDoneReason, resend[], desynced, gaveUp?), `MAX_RESENDS=3` (:257), `class Session` (:285): `seq`, `lastDone`, `lastDoneReason`, `pendingCount`, `nextSequenceId`, `resyncTo(n)` (:331), `pendingIds()` (:346), `send(verb, fields)` (:363), `sendUnsequenced(verb, fields)` (:398, refuses HELLO), `connect()` (:434, the only HELLO), `checkLiveness()` (:448, PING), `retransmit(id)` (:462), `handleReply(DecodedLine)` (:493).
- **Bugs / inconsistencies**:
  1. `connect()` (:434-439) resets `nextId`, `pending`, `seq` but **not** `lastResendN`/`resendStreak`; `resyncTo()` (:331-340) resets all five. A session that hit streak 3 on `#1`, reconnects, sends a new `#1` and gets one `nack 1` will trip `resendStreak > MAX_RESENDS` (:557) on the first resend and give up prematurely. Untested.
  2. `seq` semantics: `connect()` sets `seq = 1` (:437, documented as deliberate at :44-51) while `resyncTo(1)` sets `seq = 0` (:337) and `nack 1` sets `seq = 0` (:520). Same robot state (`expectedNext_ = 1`), two different host values. Pick one (0 is the consistent choice).
  3. `handleAck`/`handleNack` throw `SessionError` on a malformed ack/nack (:503-520 via `parseAckNackFields` :267-283) — the one place in the package where **wire input** throws instead of returning a value (codec never throws on decode). The host must wrap `handleReply` in try/catch or one bad reply kills the read loop.
- **Spec drift**: spec §3.5 says "only 11 verbs"; code has 13 (`FUNCS`, `WIFICRED` added OOP, :152-166). The number "11" is still hard-coded in prose in `session.ts` error strings (:370, :407) and doc comments, and in test names (`session.test.ts:198, 210`) while the same test asserts 13 (:184-186).
- **Tests** (`session.test.ts`, 40 tests, fixture-gated): golden ack/nack vectors drive `seq` (:108-138); named `nack 5 → seq 4` vs `ack 5 → seq 5` (:140-165); 13-verb allowlist both directions (:167-237); HELLO/connect resets id, seq, pending, not lastDone; PING touches nothing; `sendUnsequenced("HELLO")` refused (:239-309); cumulative ack (:311); lost-ack retransmit reuses original bytes, `retransmit(id)` idempotent, refuses unknown id (:330-360); gap-stall-recover scenario (:362); trailing nack after unsequenced reply (:404-441); desync detection, auto-resync, held-button convergence, repeated nack not re-flagged, `resyncTo` ignores nonsense, give-up after `MAX_RESENDS`, streak resets on progress, two non-regression cases, acks never desynced (:443-593); case folding ×5 (:595-626); malformed ack/nack throws (:628-643). Very thorough on the state machine. Gap: no test for bug 1 above; no test of `connect()` followed by a nack streak.
- **Leaks**: none at runtime. Doc refs to `UsbSerialLink`/ticket 008 (:14). ~360 lines of narrative (sprint/OOP dates, stakeholder quotes at :246-249) — maintenance weight, not I/O.

### `src/v6/telemetry.ts` (171 lines; 67 code / 104 comment)
- **Purpose**: schemaless `thdr`/`t` positional zip.
- **API**: `TelemetryHeader` (:47), `parseTelemetryHeader` (:61, identity), `TelemetryFrame` (:70), `DecodedFrame`/`TelemetryFieldCountMismatch`/`NoHeaderHeld`/`TelemetryDecodeResult` (:73-99), `zipTelemetryFrame(header, fields)` (:110), `class TelemetryDecoder` (:140): `handleHeader`, `decodeFrame`, `currentHeader`.
- **Quality**: Correct; never throws; no column-count branch. Frame values are raw strings — no numeric parse, no units (deliberate, :26-32).
- **Stale**: `:91` suggests a caller "issue `TLM HDR` (protocol.md §10.5)". The host found on hardware that `TLM HDR` does not exist on this firmware (`packages/host/src/deviceRegistry.ts:3476-3500`; `wire_handler.cpp parseTlmMode` accepts only OFF/POSE/FULL/NOW/AUTO/BUFFER) and removed the request. Spec §3.6 still asserts `TLM HDR` is the recovery path — see §2 item 9.
- **Tests** (`telemetry.test.ts`, ~11 tests): all four real header shapes (7/11/12/20 cols) through `zipTelemetryFrame` and `TelemetryDecoder`; header identity; **unit-trap passthrough** for `ox`/`oy`, `oh`, `rotation`/`omega` (:137-175); short and long field-count mismatch, via both paths; no-header-held, then resolves after header. Adequate.
- **Leaks**: doc refs to `EndpointState`, `packages/host` (:36, :90, :136).

### `src/relay/commands.ts` (262 lines; 75 code / 187 comment — 71% comment)
- **Purpose**: relay command-plane line builders and radio frame-size validator.
- **API**: `buildEchoOffLine` (:95), `buildModeRaw250Line` (:101), `RelayCommandError` (:112), `buildSetChannelGroupLine(ch, grp)` (:136, integer check only), `buildSetPowerLine` (:149, hard-coded 7), `buildGoLine` (:163), `buildQueryLine` (:173), `PING_LINE`/`STATUS_LINE` (:193/:201), `RelayFrameMode` (:210), `FrameSizeOk`/`FrameSizeRefusal`/`FrameSizeResult` (:224-238), `validateFrameSize(mode, bytes)` (:253).
- **Quality**: Builders are trivially correct and tested byte-for-byte. Issues:
  - `PING_LINE`/`STATUS_LINE` are self-described as "for reference/documentation parity, not a second code path" (:181-201) — exported dead code that also pulls a **cross-layer import** of `v6/codec` into the relay module (:82). Remove.
  - No reply-side grammar at all. The relay's `#`-line replies (`# channel: 47 group: 60 mode: RAW250 power: 7`, `# echo: OFF`, `# mode: RAW250`, `# entering data plane`, `# error: ...`) are matched by **inline regexes in the host** (`packages/host/src/link/RelayCommandPlane.ts:203-214, 223-229`). That is pure wire grammar living outside the zero-I/O package, untestable without the host's scheduler plumbing. The module doc's "no reply parsing because no I/O" (:31-33) conflates the two — parsing a string is not I/O.
  - Host duplicates `buildQueryLine()` as its own `QUERY_LINE = "?\n"` constant (`RelayCommandPlane.ts:220`).
  - `buildSetChannelGroupLine` does not range-check (:128-134 says so) because `radioAddress.ts` exposes no validator.
- **Tests** (`commands.test.ts`, 17 tests): each builder's exact bytes; non-integer `!CG` args; `PING_LINE`/`STATUS_LINE` equality; "exports no HELLO builder" (reflective, :58-82); frame caps at 16/17 and 247/248; never throws; well-under-cap. Fine for what exists.
- **Leaks**: doc refs to `RelayCommandPlane`, `host/link/...`, tickets (:26, :38, :42, :51, :160).

### Tests — structural note
`radioAddress.test.ts`, `codec.test.ts`, `session.test.ts` each call a `readVectorsFile()` at **module top level** and throw if the vendor submodule is absent. In a checkout without submodules (this one), vitest reports the three files as failed and none of their 94 tests run — including the fixture-independent named trap tests the spec calls out (`nack N → N-1`, `zuzuv`). Move the fixture load inside the fixture-driven `describe` blocks (or `describe.skipIf(!fixturePresent)`) so the synthetic tests always run.

### I/O / timers / Node-only imports in `src/` (non-test)
- Runtime I/O: **none**. Timers: **none**. `node:*` imports: **none**. Only platform API used is `TextEncoder` (`codec.ts:78`), available in Node ≥11 and browsers. `tsconfig.base.json` sets `types: ["node"]` but nothing Node-specific is referenced; the package would compile for a browser target as-is.
- Host concerns: `normalizeDeviceType` (WS compat); `REPLY_VERBS` as a closed allowlist encodes a shared-radio policy that is wrong for USB; 35 non-test comment lines reference host modules, sprints, tickets, or OOP dates.

---

## 2. Spec §3 / §6 trap checklist

| # | Trap (spec) | Implemented | Tested | Notes |
|---|---|---|---|---|
| 1 | `nack N → seq = N-1` (§3.5) | `session.ts:520` | `session.test.ts:140-165`, golden `:108-138` | Correct. Tests offline without submodule. |
| 2 | retransmit reuses original id (§3.5) | `session.ts:185-195` stores `line`; `:462-470` returns it; `:581-585` resend from pending; no API accepts a fresh id | `session.test.ts:330-360` | Correct. |
| 3 | HELLO resets sequence to 1 / never a health check (§3.5) | `session.ts:434-439`; `sendUnsequenced("HELLO")` refused `:415-419`; `checkLiveness()` = PING `:448` | `session.test.ts:239-309` | Correct. **Bug**: `connect()` does not reset `lastResendN`/`resendStreak` (§1). `seq=1` vs `resyncTo(1)→seq=0` inconsistency. |
| 4 | only listed verbs take ids (§3.5: 11) | `session.ts:139-167` (**13**) gates `send`/`sendUnsequenced` | `session.test.ts:167-237` | Implemented for 13. Spec says 11 — spec is stale vs FUNCS/WIFICRED, and "11" persists in code strings/test names. |
| 5 | lowercase unknown verb dropped silently (§3.4) | `codec.ts:431-440` returns `"foreign"`; the *drop* is the caller's | `codec.test.ts:537-547` | Classification correct. Allowlist fragility: four silent-drop regressions already (`codec.ts:382-397`). |
| 6 | banner both dialects; hex vs decimal serial (§3.3) | `banner.ts:43-47, 87-90, 121-151` | `banner.test.ts:5-44` | Correct. RADIOBRIDGE fixture serial is inconsistent with its name (`getez` ≠ `deviceIdToName(1779042496)`); no name/serial cross-check exists. |
| 7 | `< ` prefix stripped unconditionally (§3.7, assigned to `relay/commands.ts`) | **Not in protocol.** Lives in `packages/host/src/link/lineStream.ts:44` | `host/.../lineStream.test.ts:24-34` | `decodeLine("< device ...")` → verb `"<"` → `"foreign"` → dropped; `parseBanner` → `null`. Every new transport must re-implement the strip. Move a pure `stripReceivePrefix()` into `codec.ts` next to the `\r` strip (`:307-309`), or correct the spec. |
| 8 | telemetry units: `oh` centidegrees, `rotation`/`omega` milliradians, `ox`/`oy` mm (§3.6) | Protocol converts nothing (`telemetry.ts:26-32`) | Passthrough pinned `telemetry.test.ts:137-175` | Preserved by inaction. No shared unit vocabulary exists, so consumers hard-code: `packages/ui/src/components/PathTracePanel.tsx:262` (`heading/100`), `DriveControls.tsx:26-28, 168`. A DB persisting telemetry will re-derive again. Add a pure `telemetryUnits.ts` (column → unit) to protocol. |
| 9 | `TLM HDR` is the header-recovery path (§3.6) | **Not implemented; firmware lacks the verb** | — | `deviceRegistry.ts:3476-3500`: `TLM HDR` drew `err 2`+nack on fw `v1.20260909.2`; recovery is the firmware's 20-frame `thdr` auto-refresh (which §3.6 also states). Spec §3.6 line "TLM HDR is the recovery path" and `telemetry.ts:91` are wrong; fix both. |
| §6 | radio frame caps 16/247, no truncation | `commands.ts:217-262` | `commands.test.ts:84-123` | Correct. |
| §6 | open → HELLO → read banner; pacing 10 ms; no in-band escape after `!GO`; three-outcome registry; mDNS | host concerns | host | Correctly absent from protocol; `commands.ts:53-58` documents the no-escape fact. |

---

## 3. `session.ts` — one thing or several?

It does **three** things:
1. **Verb vocabulary** — `SEQUENCED_VERBS`/`isSequencedVerb` (:139-177). Static data; pairs with `codec.ts`'s `REPLY_VERBS`. Belongs in a `v6/verbs.ts` so both allowlists live together.
2. **Sequencing state machine** — id counter, pending table, cumulative retire, nack-driven resend, desync detection, give-up counter, `resyncTo` (:285-586 minus policy). This is the core and it is good.
3. **Policy guardrails** — HELLO refusal in `sendUnsequenced`, `connect()` as the only HELLO, `checkLiveness()` (:398-450). Thin, fine to keep with (2).

`parseAckNackFields` (:267-283) is per-verb field parsing — codec-level knowledge that codec deliberately refuses to own; it's fine here but it is the one place wire input throws (see §1 bug 3).

**Per-link session core in the new design?** Yes, with small fixes. It is already transport-neutral: input is `DecodedLine` (`handleReply`, :493), output is line text (`send`/`sendUnsequenced`/`connect`/`checkLiveness`/`retransmit` return `string`; `AckNackEvent.resend` is `string[]`). No callbacks, no promises, no clock.

**Line in / line out interface?** It has one **implicitly** but not as a named contract: the required call ordering — `decodeLine` → `classifyLine` → drop blank/tooLong/foreign → `handleReply` → send `resend[]` **before** dispatching the non-ack line → dispatch — is enforced by the host's `LineRouter` (`packages/host/src/link/LineRouter.ts:66-90`), which is itself pure (callbacks only). That ordering is one of the traps the spec cares about and it is currently tested only in the host. Recommend a pure facade in protocol:

```
receive(raw: string): { outbound: readonly string[]; event?: AckNackEvent; line?: DecodedLine; dropped?: "blank"|"tooLong"|"foreign"|"malformed" }
```

so every host transport gets decode+classify+ack/nack+resend ordering from one tested place. Also needed before reuse: fix `connect()` streak reset; unify `seq` semantics; return (not throw) on malformed ack/nack; trim ~300 lines of narrative comments to the two tables that matter (`:23-27`, `:71-92`).

---

## 4. `relay/commands.ts` — what a relay sweep needs

Sweep: for each remembered robot → `!CG <ch> <grp>` → `!GO` → `HELLO` → wait → banner or timeout.

Available:
- `!CG`: `buildSetChannelGroupLine(ch, grp)` (:136). `!GO`: `buildGoLine()` (:163). `?` sync probe: `buildQueryLine()` (:173). Preamble lines `!ECHO OFF`/`!MODE RAW250`/`!P 7` (:95-151).
- `HELLO`: `Session.connect()` (`session.ts:434`) — correct place; do not add a relay-side HELLO builder.
- `(ch, grp)` per robot: `nameToRadioAddress(name)` (`radioAddress.ts:53`) or registry (host `mbrelayRegistry.ts:306` already falls back to it).
- Frame cap check: `validateFrameSize("raw250", bytes)` (:253) — HELLO is 6 bytes.
- Banner parse: `parseBanner` + `classifyBanner`.

Missing (pure, belongs in protocol):
1. **Relay reply grammar**: `parseRelayStatusLine("# channel: 47 group: 60 mode: RAW250 power: 7") → {channel, group, mode, power}`; `classifyRelayReply(line) → "status"|"echo"|"mode"|"enteringDataPlane"|"error"|"comment"|"other"`. Today these are five inline regexes in `RelayCommandPlane.ts:203-214, 223-229`. A sweep must confirm `!CG` landed on the *right* channel/group before `!GO` (host already does so via a per-call RegExp at `:209-211`); a typed parser makes that a value comparison.
2. **Preamble step table**: `relayPreambleSteps(ch, grp): ReadonlyArray<{ line: string; label: string; confirms: (reply) => boolean }>` — pure data, one step at a time (does not violate the module's "no bundling that skips reply inspection" stance at `:33-45`, since each step still carries its own confirmation predicate). Lets connect and sweep share one definition.
3. **Non-throwing address validator**: `isDerivedRadioAddress(ch, grp)` / `validateRadioAddress(ch, grp)` exported from `radioAddress.ts` (constants at `:30-36` are private), used by `buildSetChannelGroupLine` and by a sweep iterating DB rows.
4. Remove `PING_LINE`/`STATUS_LINE` (:193/:201) and the `v6/codec` import (:82).

Transport fact the sweep design must absorb (not a protocol gap): after `!GO` there is **no in-band return to the command plane** (spec §6; `commands.ts:53-58`). Retuning to the next robot means a relay reset/reconnect per robot, then the `?` sync loop (`RelayCommandPlane.ts:190-200`) to wait out boot text. A sweep across N robots is therefore N relay resets, not N `!CG` lines. If the relay firmware has since grown an escape, that belongs in `commands.ts` as a builder plus a spec §6 correction.

Timers/"wait briefly": host, via its `Scheduler` (`pacing.ts`). Correctly absent from protocol.

---

## 5. Shared vocabulary for a DB schema

What exists:
- `DeviceType = "unknown"|"relay"|"robot"|"calibration"` (`deviceType.ts:74`).
- `ParsedBanner.name` (5-letter), `.serial: number` (`FICR.DEVICEID[1]`, decoded), `.role`, `.commonName`, `.dialect` (`banner.ts:60-81`).
- `IdReply.program/.version/.product/.name` (`deviceType.ts:204`).
- `RadioAddress {channel, group}` (`radioAddress.ts:38`).
- Host roster today keys on `name` (`packages/host/src/store/knownRobots.ts:106-124`: `name`, `firstSeenAt`, `lastSeenAt`, `lastSeenVia`, `lastUsbSerial` "never authoritative", `lastRole`, `lastType: "robot"`).

Assessment:
- **`DeviceType` is not a DB enum.** `"unknown"` is a classification outcome, not a device; `"calibration"` is a firmware *build* of a robot (`ID` reply's `program` prefix, `deviceType.ts:234`), not a hardware kind — a robot flips between `robot` and `calibration` on reflash. Persist `kind ∈ {robot, relay}` plus `program`/`version`/`role` columns; derive "calibration" at read time with the existing `refineForCalibration`.
- **`name` is the wire identity but not a safe primary key.** Spec §2.2: name = hash of `DEVICEID[1]` into a 3,125-name space. Birthday odds of a within-fleet collision: 30 robots ≈ 13%, 60 ≈ 43%, 100 ≈ 79%. Two colliding robots also derive the **same** `(channel, group)`. The radio system (mbrelay registry, HELLO) is name-keyed regardless, so the DB needs name as a unique-ish index for radio purposes, but the row identity should be the chip.
- **`serial` (`FICR.DEVICEID[1]`, uint32) is the canonical device id**: same physical value in every banner dialect once radix-decoded (`banner.ts:43-47`), the value SWD reads from a blank board (spec §2.2), and `name = deviceIdToName(serial)` is recomputable. Store it as the decoded integer, never the printed string (radix varies by role). The USB/DAPLink serial is a different chip (KL27) and is "display hint only" (`knownRobots.ts:117-120`).
- **Channel/group**: the derived pair is a *default* (spec §6). Store only overrides: `radioChannel`, `radioGroup`, `radioSource ∈ {derived, registry, config, observed}` nullable; recompute the default from `name` via `nameToRadioAddress`.

Recommended keys:
- `device.id` = `target_device_id` (uint32 `DEVICEID[1]` = `ParsedBanner.serial`). Primary key.
- `device.name` (char(5), `^[zvgpt][uoiea][zvgpt][uoiea][zvgpt]$`, `naming.ts:35`) — derived, indexed, **not** unique-constrained (collisions are real); assert `name == deviceIdToName(id)` on insert.
- `device.kind` ∈ {`robot`, `relay`} (from `classifyBanner`, mapping `calibration→robot`, refusing `unknown`).
- `device.role` (banner token, e.g. `NEZHA2`/`RADIOBRIDGE`), `program`, `version` (ID reply), nullable.
- `device.radio_channel`, `radio_group`, `radio_source` nullable overrides.
- Protocol should export the tiny pure helpers this schema leans on: `isWellFormedName(name)`, `bannerNameMatchesSerial(banner)`, `toPersistedKind(DeviceType)`, `validateRadioAddress`.

---

## 6. Reuse verdict per file

| File | Verdict | One line |
|---|---|---|
| `src/index.ts` | **Keep** | Barrel; nothing to change. |
| `src/naming.ts` | **Keep** | Correct, tested, zero deps; add `isWellFormedName` export. |
| `src/radioAddress.ts` | **Keep** | Correct; export a non-throwing range validator for `!CG`/DB use. |
| `src/banner.ts` | **Keep-with-refactor** | Add `name`↔`serial` cross-check; either tolerate `< `/`\r` or move stripping into codec; fix inconsistent RADIOBRIDGE fixture; drop host refs. |
| `src/deviceType.ts` | **Keep-with-refactor** | Move `normalizeDeviceType` to the WS layer; separate persisted `kind` from UI classification; dedupe role allowlist with `banner.ts`; cut host/sprint refs. |
| `src/v6/codec.ts` | **Keep** | Add `stripReceivePrefix`; give `"foreign"` an observable tap or make the reply-verb policy transport-aware; otherwise solid. |
| `src/v6/session.ts` | **Keep-with-refactor** | Fix `connect()` streak reset and `seq` inconsistency; stop throwing on wire input; add pure `receive(raw)` facade absorbing `LineRouter`'s ordering; split verb table out; halve the comments. |
| `src/v6/telemetry.ts` | **Keep** | Delete the `TLM HDR` comment (:91); add sibling `telemetryUnits.ts`. |
| `src/relay/commands.ts` | **Keep-with-refactor** | Remove `PING_LINE`/`STATUS_LINE` + codec import; add relay reply parser/classifier and preamble step table; range-check `!CG`. |
| `src/**/*.test.ts` | **Keep** | Move vendor-fixture loads inside their `describe`s so 94 synthetic tests run without submodules. |

Nothing here needs a rewrite. The package is a clean zero-I/O foundation; the leaks are documentary (host/sprint references) and one misplaced WS-compat helper, and the real gaps are pure grammar that drifted into the host (`< ` strip, relay `#`-reply regexes, decode→ack/nack→resend ordering) plus two stale spec statements (`TLM HDR`, "11 verbs").
