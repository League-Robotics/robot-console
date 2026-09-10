---
id: '001'
title: Classify calibration vs student robots from the ID verb
status: open
use-cases:
- SUC-001
depends-on: []
github-issue: ''
issue: id-verb-distinguishes-calibration-from-student-robots.md
completes_issue: true
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Classify calibration vs student robots from the ID verb

## Description

Today every robot answers the same `device NEZHA2 robot <name> <serial>`
banner regardless of whether it's running the calibration image
(`nezha-robot-template`) or a student build, so `classifyBanner` cannot
tell them apart. The separate `ID` verb already carries the
distinction (`id <product> <program> <version> <name>` — `program` is
`calibration-<version>` on the calibration build, the build's own name
otherwise), and `id` is already in `packages/protocol/src/v6/codec.ts`'s
`REPLY_VERBS`, so no codec change is needed — only reading and parsing
the reply.

This ticket adds a fourth `DeviceType` member (`"calibration"`) and, in
the one shared post-identify path `deviceRegistry.ts` already runs for
every transport (USB/relay/mbserial/WiFi alike — see the connect flow
around `classifyBanner(banner)`), sends unsequenced `ID` after a
successful `type: "robot"` identify and refines the classification from
the reply.

**Design caution (per the linked issue): match on the `calibration-`
prefix, not an exact version string, and keep the match in exactly one
place.** The vocabulary of program names is not controlled by this
project — treat an unrecognized program as "some robot program," never
as an error. A robot that never answers `ID` (older firmware, a
timeout, or a build without the verb) must stay `"robot"` — absence of
a reply is not evidence of a student build, and must not be classified
as `"calibration"` or degraded to `"unknown"`.

## Acceptance Criteria

- [ ] `DeviceType` (`packages/protocol/src/deviceType.ts`) gains
      `"calibration"` as a fourth member.
- [ ] `DeviceClassification` gains `program: string | null` and
      `version: string | null`, preserved verbatim from the `ID` reply
      (`null` only when no `ID` reply was ever received).
- [ ] After a successful identify classifying `type: "robot"` (any
      transport), `deviceRegistry.ts` sends unsequenced `ID` once and
      parses a reply of the shape `id <product> <program> <version>
      <name>`.
- [ ] A `program` value matching `/^calibration-/` refines
      `classification.type` to `"calibration"`.
- [ ] Any other `program` value (including one that merely resembles
      "calibration" without the prefix, e.g. `calib-test`) leaves
      `classification.type` at `"robot"`.
- [ ] No `ID` reply within the request's timeout leaves
      `classification.type` at whatever `classifyBanner` already
      produced (`"robot"`) — never `"unknown"`, never `"calibration"`.
- [ ] The `calibration-` match lives in exactly one function/module —
      no second copy of the prefix check anywhere else in this ticket's
      diff.
- [ ] `normalizeDeviceType` (used to coerce an unrecognized wire-level
      `classification.type` string) is updated so `"calibration"` round-
      trips correctly and anything still unrecognized coerces to
      `"unknown"`, unchanged.

## Implementation Plan

**Approach:** extend `classifyBanner`'s result shape and add one new,
narrowly-scoped step to the shared post-identify path in
`deviceRegistry.ts` (the same function that currently calls
`classifyBanner(banner)` for every transport — confirmed this sprint to
be one shared call site, not one per transport). The `ID` send reuses
whatever unsequenced-command path `STATUS`/`VER`/`HELLO` already use
(`isSequencedVerb` classification is unchanged; `ID` is not, and never
was, in `SEQUENCED_VERBS`).

**Files to modify:**
- `packages/protocol/src/deviceType.ts` — add `"calibration"` to
  `DeviceType`; add `program`/`version` to `DeviceClassification`; add a
  small, single-purpose helper (e.g. `refineForCalibration(classification,
  idReply)`) that applies the prefix match; keep `classifyBanner` itself
  banner-only and unchanged in signature, since the `ID` reply is a
  second, independent signal layered on afterward, not folded into
  banner classification.
- `packages/host/src/deviceRegistry.ts` — after a `type: "robot"`
  identify, send unsequenced `ID`, await its reply with a bounded
  timeout (mirroring how `STATUS` polling already bounds its own wait),
  and call the new helper to refine `classification` before it is
  written into `EndpointListEntry`/broadcast.
- `packages/host/src/wsMessages.ts` — no shape change expected
  (`EndpointListEntry.classification` already types as
  `DeviceClassification`, imported directly from `protocol`); update
  doc comments referencing the type union's member count if any exist.

**Testing plan:**
- `deviceType.test.ts` (or wherever `classifyBanner` is tested today):
  unit tests for the new helper covering every acceptance criterion
  above (prefix match, non-match, near-miss, absent reply).
- `deviceRegistry.test.ts`: against a fake link, assert `ID` is sent
  exactly once after a robot identify, and that a fixture `id ...` reply
  refines the endpoint's `classification` in the next snapshot; assert a
  fixture with no `ID` reply at all still snapshots `type: "robot"`.
- Scope this ticket's test run to `packages/protocol` and
  `packages/host` (per the source-code rule — a ticket-scoped run, not
  the full suite; the full suite runs once at `close_sprint`).

**Documentation updates:** update `deviceType.ts`'s own module doc
comment (it currently states the fourth type is "deliberately not
modeled here" pending a firmware change — that sentence is now false
and must be corrected in place, not left stale) to describe the `ID`-
verb signal instead of a hypothetical future firmware change.
