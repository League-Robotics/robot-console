---
id: '003'
title: Availability plumbing and fixtures for a third firmware kind
status: done
use-cases:
- SUC-001
depends-on:
- '002'
github-issue: ''
issue: ''
completes_issue: true
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Availability plumbing and fixtures for a third firmware kind

## Description

Widen the two remaining host-side places that iterate a fixed list of
firmware kinds, and update every fixture/test literal that constructs a
full `Record<FirmwareKind, FirmwareAvailability>` (or `Record<FirmwareKind,
...>` of any kind) by hand — these will now fail loudly with a missing
`joystick` key once `buildSnapshot`'s output actually has one, which is
the intended, expected failure the stakeholder flagged in advance. **Do
not loosen any `toEqual`/`toMatchObject` assertion to make a failure go
away — add the missing key instead.**

Files to change:

- `packages/host/src/projection.ts`: `FIRMWARE_KINDS` (line 99) gains
  `"joystick"`. `buildFirmwareAvailability` itself needs no change (it's
  already generic over one `ProjectionFirmwareRow`).
- `packages/host/src/watchers/firmwareWatcher.ts`: `FIRMWARE_KINDS`
  (line 94) gains `"joystick"` — this starts a third independent
  self-rescheduling poll timer alongside the existing relay/robot ones,
  with no other change to the polling/backoff algorithm.
- `packages/host/src/projection.fixtures/golden-snapshot.json`: add a
  `"joystick"` entry to the `"firmware"` object (line ~170). Use the
  same `{ "configured": false }` shape the fixture's own `"relay"` entry
  already uses (not-configured is the honest state for this fixture,
  which sets no `ROBOT_CONSOLE_JOYSTICK_FIRMWARE`).
- **Search broadly**: `grep -rn 'Record<FirmwareKind' packages/host/src packages/ui/src --include="*.test.ts" --include="*.test.tsx"` and `grep -rln '"relay":.*"robot":\|firmware: {' packages/host/src packages/ui/src --include="*.test.ts*"` to find every other hand-built firmware-status literal (fixtures in `projection.test.ts` itself beyond the golden JSON, `UnknownDevicePage.test.tsx`'s `firmwareStatusFixture()`, `DevicePage.test.tsx`/`RelayPage.test.tsx`'s inline `firmware: { relay: ..., robot: ... }` snapshot literals, and any others `grep` turns up). Add a `joystick` entry to each one — `{ configured: false }` unless that specific test is exercising firmware availability display, in which case match whatever shape its own relay/robot entries use.

## Acceptance Criteria

- [x] `buildSnapshotFromRows`'s output `firmware` object always has
      exactly three keys: `relay`, `robot`, `joystick`.
- [x] `firmwareWatcher`'s `startFirmwareWatcher` starts and independently
      schedules a third poll timer for `joystick`.
- [x] `golden-snapshot.json` has a `joystick` entry and
      `projection.test.ts`'s golden-fixture test passes unmodified in
      its assertion style (still a `toEqual` against the whole object,
      not narrowed to specific keys).
- [x] Every other hand-built `Record<FirmwareKind, ...>` literal found by
      the searches above has a `joystick` entry added.
- [x] No test's assertion was loosened (no `toEqual` -> `toMatchObject`,
      no field-by-field partial check introduced to dodge a missing key)
      to make a failure disappear.

## Testing

- **Existing tests to run**: `npx vitest run packages/host/src/projection.test.ts packages/host/src/watchers/firmwareWatcher.test.ts --no-coverage`, plus every file the grep searches above turn up (list them explicitly once found — do not use a glob pattern with `npm test`).
- **New tests to write**: a `firmwareWatcher.test.ts` case confirming a
  third `joystick` poll timer is scheduled independently of relay/robot
  (mirroring whatever existing test asserts the current two are
  independent).
- **Verification command**: run each affected file individually with
  `npx vitest run <path> --no-coverage`, foreground.
