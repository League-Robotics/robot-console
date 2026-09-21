---
id: "002"
title: "Host settings and config plumbing for the joystick firmware source"
status: open
use-cases: ["SUC-001"]
depends-on: ["001"]
github-issue: ""
issue: ""
completes_issue: true
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Host settings and config plumbing for the joystick firmware source

## Description

Widen the firmware-source-configuration layer to know about a third
`FirmwareKind`, `"joystick"`, following the exact existing
relay/robot pattern. This ticket does **not** set a real `.env` value
for the joystick repo yet — leave `ROBOT_CONSOLE_JOYSTICK_FIRMWARE`
unset/unconfigured after this ticket, so `getFirmwareConfig` correctly
reports `undefined` for `joystick` (the same "not configured" state
`relay` has today when unset). Ticket 007 is deliberately the one that
points the env var at the real, live repo — see sprint.md's Design
Rationale, Decision 3, for why the real fetch is sequenced last.

Files to change:

- `packages/host/src/config.ts`: add a `joystick` entry to
  `SETTINGS_KEY_BY_FIRMWARE` (e.g. `"firmware.joystick.source"`,
  following the existing `"firmware.relay.source"`/
  `"firmware.robot.source"` naming).
- `packages/host/src/store/importers/firmwareConfig.ts`: add `joystick`
  to `ENV_VAR_BY_FIRMWARE` (env var name `ROBOT_CONSOLE_JOYSTICK_FIRMWARE`,
  following the existing `ROBOT_CONSOLE_RELAY_FIRMWARE`/
  `ROBOT_CONSOLE_ROBOT_FIRMWARE` naming) and to its own `FIRMWARE_KINDS`
  constant.
- `packages/host/src/store/index.ts`: four spots hardcode the literal
  union `"relay" | "robot"` instead of importing `FirmwareKind` from
  `wsMessages.ts` — `SetFirmwareInput.kind` (~line 331),
  `ProjectionFirmwareRow.kind` (~line 505), `getFirmwareEtag`'s
  parameter type (~line 1752), and the raw `firmwareRows` cast inside
  `projectionRows()` (~line 1972). Widen all four to include
  `"joystick"` (or better: import and use `FirmwareKind` directly at
  each site instead of restating the literal union a fifth place —
  your call, but if you leave them as literal unions, all four must
  agree with each other and with `wsMessages.ts`).
- `packages/host/src/store/migrations/0001-initial.ts`: the `firmware`
  table's `kind` column comment reads `-- 'relay' | 'robot'`
  (~line 79). Update it to `-- 'relay' | 'robot' | 'joystick'`. **Do
  NOT change the column definition itself** — `kind TEXT PRIMARY KEY`
  has no `CHECK` constraint, so no migration is needed, only the
  comment needs to stay truthful.

## Acceptance Criteria

- [ ] `getFirmwareConfig(store)` returns a map with a `joystick` key
      (`undefined` when unset, matching the existing convention).
- [ ] `SETTINGS_KEY_BY_FIRMWARE.joystick` and
      `ENV_VAR_BY_FIRMWARE.joystick`/`FIRMWARE_KINDS` (in
      `firmwareConfig.ts`) are both defined and consistent with each
      other.
- [ ] All four `store/index.ts` type-union spots accept `"joystick"`.
- [ ] The `firmware` table schema's DDL text is unchanged except for the
      updated comment.
- [ ] `ROBOT_CONSOLE_JOYSTICK_FIRMWARE` is deliberately **not** added to
      `.env` in this ticket.
- [ ] `npx tsc --noEmit` is clean for `packages/host`.

## Testing

- **Existing tests to run**: `npx vitest run packages/host/src/config.test.ts packages/host/src/store/importers/firmwareConfig.test.ts packages/host/src/store/index.test.ts --no-coverage` (confirm exact test file names first — `store/index.ts` may have its tests split across multiple files; grep for `describe.*getFirmwareEtag` or similar if `store/index.test.ts` doesn't exist as one file).
- **New tests to write**: a `firmwareConfig.test.ts` case asserting
  `importFirmwareConfig` resolves `ROBOT_CONSOLE_JOYSTICK_FIRMWARE` from
  `process.env` and from a `.env` file, exactly mirroring the existing
  relay/robot test cases. A `config.test.ts` case for
  `SETTINGS_KEY_BY_FIRMWARE.joystick` round-tripping through
  `getFirmwareConfig`.
- **Verification command**: run each file above individually with
  `npx vitest run <path> --no-coverage`, foreground, explicit paths only.
