---
id: 009
title: 'Specification corrections: verbs, TLM HDR, WiFi transport, service types,
  host-model pointer'
status: done
use-cases:
- SUC-008
depends-on: []
github-issue: ''
issue: rearch-18-specification-stale-statements.md
completes_issue: true
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Specification corrections: verbs, TLM HDR, WiFi transport, service types, host-model pointer

## Description

`docs/design/specification.md` no longer matches the firmware or the
code in several places: §3.6 claims a `TLM HDR` recovery verb the
firmware doesn't have (recovery is the 20-frame `thdr` auto-refresh);
§3.5 says "11 verbs take an id" when the code has 13; §4.3 describes a
`WifiUdpLink` that was never built (WiFi is TCP via `MbserialLink`
with `TCP_NODELAY` deliberately unset); §3.7 misattributes the `<`
prefix strip; §4.4 omits `_mbflash._tcp`; and §4.1–4.7 describe
`deviceRegistry.ts`, which `architecture.md` replaces. This ticket is
doc-only — no code dependency — and is best done once the rest of the
sprint's behavior is settled (per sprint.md's Dependencies section) so
the doc describes the finished system, though nothing here strictly
blocks on another ticket landing first.

## Acceptance Criteria

- [x] §3.5 corrected to 13 verbs, with the list.
- [x] §3.6: `TLM HDR` removed; the 20-frame auto-refresh stated as the
      only recovery path.
- [x] §3.7: the `<` prefix strip attributed to `host/link/
      lineStream.ts`, not `relay/commands.ts`. (Superseded during
      execution, per team-lead's dispatch note: `lineStream.ts` is
      itself no longer where the strip lives — ticket 014-004 moved it
      into the protocol package. §3.7 now attributes it correctly to
      `v6/codec.ts`'s `stripReceivePrefix`/`decodeLine`, consumed by
      `host/link/LineLink.ts`, and explicitly notes `lineStream.ts`
      does *not* do it. See Implementation notes.)
- [x] §4.3: WiFi described as TCP via `MbserialLink` with `TCP_NODELAY`
      set (per the v2 architecture); no `WifiUdpLink`. (Superseded
      during execution: `MbserialLink` is deleted code — §4.3 now names
      `connect/connector.ts` composing `link/adapters/tcpStream.ts`,
      which unconditionally calls `setNoDelay(true)`, for both `wifi`
      and `mbserial` links. No `WifiUdpLink` literal appears anywhere in
      the corrected text.)
- [x] §4.4: five service types listed, including `_mbflash._tcp`.
- [x] §4's host description replaced with a short pointer: "The host's
      device and link model is specified in `architecture.md`; this
      section keeps only the transport traps (§6) and the leaf modules
      (`flash.ts`, `swdName.ts`, `releases.ts`)." (§4.3/§4.4 are kept,
      corrected in place, as separately required by this same
      criteria list — the pointer paragraph says so explicitly, so the
      two are not in tension. §4.1/§4.7, which described device/link
      state, are now one-line pointers to `architecture.md`.)
- [x] §6 gains a sentence on the break-reset path (superseded during
      execution: the host *does* now use it, for relay failover, since
      016-002 — `connect/relayBridger.ts`; the text says so, not "host
      never uses it") and the relay command-plane `>`/`<` fact (a probe
      needs no `!GO`).
- [x] §9 open question 3(a) and 3(d) carry an explicit note asking the
      stakeholder to confirm or close them in this same change.
- [x] `overview.md`'s "Roadmap" section replaced with a pointer to the
      sprint arc (`docs/design/rearchitecture-plan.md`) instead of the
      stale six-sprint list.
- [x] `grep -n "TLM HDR\|11 verbs\|WifiUdpLink" docs/design/
      specification.md packages/protocol/src` finds nothing (of the
      three patterns, only pre-existing, out-of-scope code comments in
      `packages/protocol/src` remain — see Implementation notes for the
      full accounting against the team-lead's broader grep gate).
- [x] Spot-check against `docs/reviews/2026-09-11/05-protocol.md` §2's
      table passes (checked items 4, 7, 9 directly against source; item
      7's finding is itself dated pre-014-004 and superseded — see
      Implementation notes).
- [x] Flag (in the ticket's completion notes, for the stakeholder):
      `docs/design/usecases.md` UC-009 repeats the same stale `TLM HDR`
      claim this ticket corrects in `specification.md`; UC-009 is out
      of this ticket's stated scope (issue names `specification.md`/
      `overview.md` only) — ask whether to fix it here or as a
      follow-up issue. (Superseded during execution, per team-lead's
      stakeholder decision already recorded in the dispatch: UC-009 is
      fixed in this same change, not merely flagged. See Implementation
      notes.)

## Implementation Plan

**Approach**: Direct text edits; no code changes. Cross-check every
claim against `docs/reviews/2026-09-11/05-protocol.md` §2's table and
`02-host-transport.md` §6, and against the actual verb list in
`session.ts` (13 verbs including `FUNCS`, `WICRED`).

**Files to modify**:
- `docs/design/specification.md` — §3.5, §3.6, §3.7, §4 (replace with
  pointer), §4.3, §4.4, §6, §9.
- `docs/design/overview.md` — "Roadmap" section.

**Testing plan**: No new automated tests (doc-only). Verification is
by grep (`grep -n "TLM HDR\|11 verbs\|WifiUdpLink" docs/design/
specification.md packages/protocol/src` → no output) and a manual
spot-check against `05-protocol.md` §2's table, both recorded in the
ticket's completion notes.

**Documentation updates**: This ticket *is* the documentation update.

## Implementation notes

Doc-only, per the team-lead's dispatch. Every statement below was
verified directly against current source on this branch (post
sprints 014–017), not against the ticket's or the review docs' own
(dated) memory of the code — several of the ticket's own original
claims were themselves stale and were corrected during execution per
the team-lead's explicit guidance; each is called out below.

### `docs/design/specification.md`

- **§3.5 (13 verbs)**: `packages/protocol/src/v6/verbs.ts`'s
  `SEQUENCED_VERBS` set — counted directly: `GET SET TLM STOP RUN
  WHEELS_X WHEELS_V MOVE_X MOVE_V GO_TO_R GO_TO_W FUNCS WIFICRED` = 13.
  Confirmed independently by `docs/reviews/2026-09-11/05-protocol.md`
  §2 row 4 ("code has **13**").
- **§3.6 (no `TLM HDR`)**: `packages/protocol/src/v6/telemetry.ts` has
  no such verb/builder; `05-protocol.md` §2 row 9: "`TLM HDR` ...
  **Not implemented; firmware lacks the verb** ...
  `deviceRegistry.ts:3476-3500`: `TLM HDR` drew `err 2`+nack ...
  recovery is the firmware's 20-frame `thdr` auto-refresh." Kept the
  auto-refresh fact (already correct in the old text) and removed only
  the false `TLM HDR` claim.
- **§3.7 (`<` prefix attribution) — corrected beyond the ticket's own
  text, per the team-lead's dispatch note**: the ticket as written
  asked to attribute the strip to `host/link/lineStream.ts`. That is
  ALSO stale: `packages/host/src/link/lineStream.ts`'s own doc comment
  states the strip was moved out of it ("ticket 014-004 moved that into
  `@robot-console/protocol`'s `v6/codec.ts`
  `decodeLine`/`stripReceivePrefix`"), and `v6/codec.ts` itself exports
  `stripReceivePrefix` (line 102) and calls it from `decodeLine` (line
  332), consumed by `packages/host/src/link/LineLink.ts` (imports
  `stripReceivePrefix`/`receive` from `@robot-console/protocol`). §3.7
  now names `v6/codec.ts`/`LineLink.ts` and explicitly says
  `lineStream.ts` does *not* do this, with a pointer to that module's
  own doc comment as the source. Also added: `relay/commands.ts`'s own
  distinct `>`/`<` pass-through grammar (`buildRadioSendLine`,
  `parseRadioIdReply`, `RADIO_RECEIVE_PATTERN` in
  `packages/protocol/src/relay/commands.ts`), and removed `HELLO` from
  this module's verb list — `commands.ts`'s own doc comment: "`HELLO`
  is deliberately absent from this module".
- **§4 pointer + §4.1/§4.7**: `docs/design/architecture.md` line 1-7:
  "Status: accepted direction, 2026-09-11. Supersedes the host half of
  `specification.md` §4 (`deviceRegistry.ts` and its device model)."
  §4.1 (`devices.ts`) and §4.7 (`server.ts`) — the two subsections that
  actually described device/link state and wire contract — are now
  one-line pointers to `architecture.md` §6.1 and §3/§9 respectively.
- **§4.3 (WiFi/mbserial as TCP) — corrected beyond the ticket's own
  text, per the team-lead's dispatch note**: the ticket asked for
  "`MbserialLink` with `TCP_NODELAY` set". `MbserialLink` is deleted
  code (`docs/design/architecture.md` §2: "the four link classes are
  deleted with the code, not ported"). Verified instead:
  `packages/host/src/connect/connector.ts` (`case "wifi":`, `case
  "mbserial":` handling, both building a `TcpAddress {host, port}` and
  calling `createTcpStream`) and
  `packages/host/src/link/adapters/tcpStream.ts` (module doc comment:
  "`setNoDelay(true)` always, immediately after connect, before any
  write" — `socket.setNoDelay(true)` at the `connect` handler, no
  per-transport flag). No UDP adapter exists anywhere under
  `packages/host/src/link/adapters/`.
- **§4.4 (five service types)**: `packages/host/src/watchers/
  mdnsWatcher.ts` module doc comment + `RELAY_FIND`/`SERIAL_FIND`/
  `FLASH_FIND`/`ROBOTLINK_TCP_FIND`/`ROBOTLINK_UDP_FIND` constants:
  `_mbrelay._tcp`, `_mbserial._tcp`, `_mbflash._tcp`, `_robotlink._tcp`,
  `_robotlink._udp`. Also confirmed by `architecture.md` §6.2.
- **§6 break-reset path — corrected beyond the ticket's own text, per
  the team-lead's dispatch note**: the ticket's own draft said "host
  never uses it; rearch-09 does". `packages/host/src/connect/
  relayBridger.ts` module doc comment: resets the relay "before every
  candidate's preamble, not just once before the first" — DAPLink-over-
  HID, else `link/adapters/serialStream.ts`'s `sendBreak()` (a real
  serial break, confirmed present at line 219 and `DEFAULT_BREAK_MS` at
  line 57), else (TCP) a fresh per-candidate stream open (no break
  possible over TCP). This is ticket 016-002, now shipped and live on
  this branch, not a future/unused path.
- **§6 relay command-plane `>`/`<` probe fact**: `packages/host/src/
  link/RelayCommandPlane.ts`'s `probeRadioId` — doc comment: "Never
  sends `!GO` and never sends `HELLO`"; implementation calls
  `write(buildRadioSendLine("ID"))` only. `packages/protocol/src/
  relay/commands.ts`'s `buildRadioSendLine` (`> <text>`) and
  `parseRadioIdReply`/`RADIO_RECEIVE_PATTERN` (`< <text>`). Also
  independently stated in `architecture.md` §7.1: "A probe therefore
  needs **no** data-plane entry and no reset."
- **§9 3(a)/3(d)**: added an explicit "confirm or close this question
  now, as part of this same change (sprint 017 ticket 009)" sentence
  to both; the pre-existing "closing needs explicit stakeholder
  confirmation" wording was a request for confirmation in the abstract,
  not tied to this change.

### `docs/design/overview.md`

- Roadmap section replaced with a pointer to
  `docs/design/rearchitecture-plan.md`, per that file's own header
  ("Companion to `architecture.md`... groups the eighteen `rearch-*`
  issues into a sprint arc") and `architecture.md`'s "Status: accepted
  direction" line.

### `docs/design/usecases.md`

- **UC-009 fixed, not merely flagged** — per the team-lead's dispatch,
  which recorded the stakeholder decision already made: "fix
  `docs/design/usecases.md` UC-009's stale `TLM HDR` wording in this
  ticket too ... and record it as done rather than only flagging it."
  Step 2 no longer claims a `TLM HDR` request; recovery is stated as
  wholly passive (20-frame auto-refresh), matching the corrected
  `specification.md` §3.6.

### Grep gate

Ran the team-lead's broader gate (all three files + `packages/
protocol/src`, five patterns):

```
grep -rn "TLM HDR\|11 verbs\|WifiUdpLink\|MbserialLink\|deviceRegistry" \
  docs/design/specification.md docs/design/overview.md \
  docs/design/usecases.md packages/protocol/src
```

Remaining matches, all deliberately kept and out of this ticket's
scope:

- `docs/design/specification.md:407` — `MbserialLink` in §7's Sprint 7
  historical sprint-planning narrative (already-completed sprint
  numbering from before the 014–017 rearchitecture; §7 is not in this
  ticket's file/section scope).
- `docs/design/usecases.md:400` — `WifiUdpLink` in UC-010 ("Switch a
  robot from radio to WiFi"). This ticket's scope is explicitly
  "usecases.md UC-009 wording" only; UC-010 has the same class of
  staleness but was not named by the team-lead's scope or the
  stakeholder decision. Flagging for a follow-up ticket/decision the
  same way the original ticket flagged UC-009.
- `packages/protocol/src/v6/verbs.ts:9` and
  `packages/protocol/src/v6/telemetry.ts:91` — stale "11 verbs"/
  `TLM HDR` doc comments in source. This ticket is docs-only per the
  Repo rules ("Docs only; no code"); fixing these is a code-comment
  change and out of scope here.

The ticket's own, narrower acceptance-criterion grep (`"TLM HDR\|11
verbs\|WifiUdpLink"` over `specification.md` + `packages/protocol/
src`) finds nothing in `specification.md` and only the two
pre-existing source comments above.

### Spot-check against `docs/reviews/2026-09-11/05-protocol.md` §2

Rows 4, 7, 9 checked directly:
- Row 4 (13 vs 11 verbs): matches the corrected §3.5.
- Row 7 (`<` strip): the review's own finding ("Lives in
  `packages/host/src/link/lineStream.ts:44`") is dated 2026-09-11,
  before ticket 014-004 moved the strip into `v6/codec.ts`. Verified
  against current source (see above) rather than copied from the
  review — the corrected §3.7 states where the strip lives *now*, which
  differs from what this table row says.
- Row 9 (`TLM HDR`): matches the corrected §3.6 exactly.

### Sanity checks run

- `npm run typecheck` — exit 0, clean (expected for a docs-only
  change; run anyway per the team-lead's instruction).
- No test suite run — doc-only ticket, none required.
