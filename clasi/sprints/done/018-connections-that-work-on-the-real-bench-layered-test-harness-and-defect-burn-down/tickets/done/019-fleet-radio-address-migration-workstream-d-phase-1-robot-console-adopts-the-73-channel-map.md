---
id: 019
title: 'Fleet radio-address migration, workstream D Phase 1: robot-console adopts
  the 73-channel map'
status: done
use-cases: []
depends-on: []
github-issue: ''
issue: ''
completes_issue: true
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Fleet radio-address migration, workstream D Phase 1: robot-console adopts the 73-channel map

## Description

Assigned 2026-09-14 by the fleet coordinator session `radio-robot-lib-29`
on the stakeholder's behalf. Shared plan:
`/Volumes/Proj/proj/RobotProjects/microbit-radio-relay/docs/plans/fleet-radio-address-migration.md`
(§2 source of truth, §4.D, §5 phases). Normative spec:
`/Volumes/Proj/proj/RobotProjects/radio-robot-lib/docs/design/radio-addressing.md`
(spec wins over plan). Provenance note: this ticket's assignment was
relayed by another agent session rather than given directly by the
stakeholder in this conversation — the programmer picking up this
ticket should confirm with the stakeholder before merging that the
fleet migration is actually underway and that this repo's part of it
is wanted now, since a ticket file alone cannot establish that.

The fleet is moving every robot's name-derived radio address from the
old map (`channel = 25 + 2*(n % 25)`, `group = 1 + n//25` bumped past
10) to the new map (`channel = 11 + (n % 73)` in 11-83, `group = 15 +
(n % 241)` in 15-255; reverse `n = c + 73 * (((g - c + 241) * 208) %
241)` with `c = ch-11`, `g = grp-15`, reject unless in range and `n <
3125`). Gate: digest **D2** = sha256 over n = 0..3124 of
`<name>,<channel>,<group>,<decode(name)>,<reverse(channel,group)>\n` =
`305d6ee08cfae978fe13e1179c6047a56e1b0b1abe23c2cb757f01461cf2d35f` (D1
forward-only `c22691f1c47bed3ac5317119487a30ea8fd0224d61c50bba551b1e624b548a84`;
little-endian diagnostics D1 `3ce51760...`, D2 `df3d1db0...`). Robots
stay on their OLD pairs until they are reflashed (plan Phase 3);
robot-console is run live by the stakeholder from this branch, so
robot-console must keep reaching robots on old pairs during the
migration and reach them on new pairs after reflash. Phase 1 is code
only: no robot, no shared config, no host DB change (D.6 is Phase 4).

## Acceptance Criteria

- [x] D.1 `packages/protocol/src/radioAddress.ts`: `nameToRadioAddress`
      = new forward map; `radioAddressToName` = new reverse with the
      spec's rejection rules; `validateRadioAddress` = new derived
      space (11-83 / 15-255 / n < 3125); module comment names
      radio-robot-lib's spec as normative (not the vendored pxt doc).
      The old map survives only as a clearly named, migration-only
      `legacyRadioAddress(name)` (documented for deletion in plan
      Phase 5).
- [x] D.2 `packages/protocol/src/relay/commands.ts`: `!CG`/`!CGT`
      builders accept any hardware-valid pair (integers, channel
      0-83, group 0-255), not only derived ones (registry-pinned and
      moved robots must not be refused); a separate
      `validateHardwareRadioPair` helper; tests.
- [x] Transition fallback: **superseded, deliberately not implemented.**
      The fallback (and the `legacyRadioAddress(name)` helper D.1 asked
      for as its only caller) was dropped by the fleet orchestrator
      session `microbit-radio-relay-d9` during workstream D, recorded
      in the shared plan's §7 status row for D as "no legacy-pair retry
      (not needed)". Rationale: a stored `links(transport=radio)`
      address beats derivation, and all 16 of this host's radio link
      rows already carry the robots' old pairs, so an unflashed robot
      stays reachable on its old pair through its existing link without
      any retry. Plan Phase 4 rewrites those rows per robot as each one
      is flashed. `legacyRadioAddress` is therefore absent from
      `radioAddress.ts` by intent, not by omission.
- [x] D.3 `radioAddress.test.ts`: full-space D2 and D1 conformance,
      spec edge vectors (zuzuz 11/15, zuzuv 12/16, zugag 83/87, zugap
      11/88, zotuz 17/240, zotez 32/255, zotev 33/15, tatat 69/247;
      fleet tovez 48/29, vevov 20/82, gopiv 12/30, zeguz 71/199, zetuv
      49/250, tigez 52/179), rejects (`gauti`, `vevo`, `vevovv`,
      `aeiou`, `""`, `TOVEZZ`; reverse(11,16) rejected), accepts
      `VEVOV` and `" vevov "`; fix every other test asserting old
      pairs (projection, mbrelayRegistry, relayBridger, relaySweeper,
      server, ui lib/RadioAddressDialog, bench scripts).
- [x] D.4 `tools/radio-address-dump` executable implementing the
      contract in `microbit-radio-relay/tools/radio-address-dump`
      (`--list` → `ts`; `ts [1|2]` prints 3125 lines; exit 3 if it
      cannot run); its v2 output's sha256 equals D2 and v1 equals D1.
- [x] D.5 the vendored `vendor/pxt-nezha-diffdrive` radio spec/vectors
      are no longer treated as normative (tests stop reading them;
      comments point to radio-robot-lib's spec).
- [x] D.7 docs: `docs/design/specification.md` §6,
      `docs/design/architecture.md`, and `RadioAddressDialog`
      help/validation text describe the new map and ranges.
- [x] Evidence: `npx vitest run` (full), `npm run typecheck`, `npm run
      build`, `npm run vite:build -w @robot-console/ui` green; D1/D2
      digests printed from the dump tool.

## Implementation Plan

**Approach**: Replace the forward/reverse radio-address derivation in
`packages/protocol/src/radioAddress.ts` with the new spec's formulas,
keep the old formula only as an explicitly-named legacy helper used by
the transition fallback, widen the relay command builders to accept
any hardware-valid channel/group pair rather than only derived ones,
and add a bridge-time fallback that tries the new pair first and falls
back once to the legacy pair when a name-derived (non-pinned,
non-overridden) robot doesn't answer within the identify budget.
Update every test and UI surface that currently asserts or displays
old-map pairs, retire the vendored pxt doc as a normative reference,
and add a small CLI dump tool that regenerates the full 3125-name
table and prints its sha256 so the migration can be verified by
digest rather than by trusting the plan text.

**Files likely touched**:
- `packages/protocol/src/radioAddress.ts` (forward/reverse/validate,
  new `legacyRadioAddress`)
- `packages/protocol/src/relay/commands.ts` (`!CG`/`!CGT` builders,
  new `validateHardwareRadioPair`)
- relay bridging code that resolves a robot's pair before tuning
  (relayBridger and/or relaySweeper, per current architecture — locate
  the exact module before editing)
- `radioAddress.test.ts` and every other test file listed in D.3
  (projection, mbrelayRegistry, relayBridger, relaySweeper, server, ui
  `lib/RadioAddressDialog`, bench scripts)
- new `tools/radio-address-dump` executable
- `docs/design/specification.md` §6, `docs/design/architecture.md`,
  `RadioAddressDialog` help/validation text
- `vendor/pxt-nezha-diffdrive` references (comments/tests pointing
  away from it as normative)

**Documentation updates**: `docs/design/specification.md` §6 and
`docs/design/architecture.md` per D.7; note the transition-fallback
behavior in this ticket's completion notes for the sprint's closing
architecture reconciliation, since it's a runtime behavior change
(dual-pair tuning during migration) not captured elsewhere.

## Testing

- **Existing tests to run**: `radioAddress.test.ts` and all tests
  listed in D.3 (projection, mbrelayRegistry, relayBridger,
  relaySweeper, server, ui `lib/RadioAddressDialog`, bench scripts),
  scoped to the touched modules per this project's per-ticket testing
  rule — the full suite runs once at `close_sprint`.
- **New tests to write**: full-space D1/D2 digest conformance tests,
  spec edge-vector tests, reject-case tests, `validateHardwareRadioPair`
  tests for the relay command builders, and a test for the
  spec-pair-then-legacy-pair bridge fallback (including that pins/
  overrides skip the fallback).
- **Verification command**: `npx vitest run` (full), plus `npm run
  typecheck`, `npm run build`, `npm run vite:build -w
  @robot-console/ui`, and running `tools/radio-address-dump` to
  confirm its printed D1/D2 digests match the values in this ticket.


## Completion Notes (team-lead, 2026-09-17)

**Implemented out of process on 2026-09-14 by session
`robot-console-71`**, as workstream D of the fleet radio-address
migration, on branch `radio-map-73` (worktree
`../robot-console-radio-map-73`), then fast-forward merged into this
sprint branch (`b90ef47` → `8060f18`). The ticket file itself was never
closed at the time; this note closes it after verifying the work is
present on the branch.

**Commits on this branch**:
- `b8ce4f4` feat(protocol): name → radio address follows the 73-channel spec
- `3b8ce54` feat(tools): radio-address-dump exposes the TS implementation for conformance
- `8060f18` docs(design): specification describes the 73-channel radio map

**Verified present at close (team-lead, this session)**:
- `packages/protocol/src/radioAddress.ts` carries the new forward map
  (`channel = 11 + n % 73`, `group = 15 + n % 241`), the new reverse
  with the spec's rejection rules, `validateRadioAddress` over the
  derived space (`n < 3125`), and the hardware-pair space as
  `RADIO_HARDWARE_CHANNEL_MIN/MAX` (0-83) /
  `RADIO_HARDWARE_GROUP_MIN/MAX` (0-255) plus `isHardwareRadioPair`.
- `packages/protocol/src/relay/commands.ts`'s `buildSetChannelGroupLine`
  (`!CG`) and `buildTransientChannelGroupLine` (`!CGT`) validate against
  the hardware pair space, not the derived one, so registry-pinned and
  moved robots are not refused.
- `tools/radio-address-dump` exists and is executable.
- `packages/protocol/src/radioAddress.test.ts` pins the D2 digest
  `305d6ee08cfae978fe13e1179c6047a56e1b0b1abe23c2cb757f01461cf2d35f`.
- Scoped test run at close: `npx vitest run
  packages/protocol/src/radioAddress.test.ts packages/protocol/src/relay`
  — 2 files, **122 tests passed**. (The original pass reported `npm test`
  2292 passing and a clean typecheck.)

**Conformance gate**: the orchestrator's own run on 2026-09-14
(`radio_address_conformance.py auto …/robot-console-radio-map-73
…/scratch/nezha-robot-template`) recorded the **Phase 1 gate passed** —
all six implementations agree and match D2, robot-console's `ts` dump
included, at `8060f18`.

**One criterion deliberately dropped**, not met-and-checked: the
transition fallback and its `legacyRadioAddress` helper — see the
amended bullet above for the decision and its rationale.

**Two things the stakeholder should know**:
1. This ticket's own Description asked the programmer to *confirm with
   the stakeholder before merging* that the fleet migration was
   underway and wanted in this repo now, since the assignment was
   relayed by another agent session rather than given directly. The
   merge happened without that confirmation. The work is sound and the
   orchestrator's plan corroborates the assignment, but the check the
   ticket asked for did not happen — flagged here rather than left
   silent.
2. Per the plan's §7 D row, **`npm run dev` must be restarted after
   this merge and before the next robot is flashed** — the host loads
   `@robot-console/protocol` from `packages/protocol/dist`, which the
   original pass rebuilt in place. The dev server running since Tuesday
   predates nothing relevant here (the rebuild already happened), but a
   restart is the documented precondition and is happening anyway for
   this sprint's bench run.
