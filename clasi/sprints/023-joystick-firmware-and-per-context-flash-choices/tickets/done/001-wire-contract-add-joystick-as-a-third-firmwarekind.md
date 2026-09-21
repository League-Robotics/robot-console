---
id: '001'
title: 'Wire contract: add joystick as a third FirmwareKind'
status: done
use-cases:
- SUC-001
depends-on: []
github-issue: ''
issue: ''
completes_issue: true
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Wire contract: add joystick as a third FirmwareKind

## Description

`FirmwareKind` (`packages/host/src/wsMessages.ts:103`) is currently the
closed union `"relay" | "robot"`. This ticket widens it to `"relay" |
"robot" | "joystick"` and updates every place in the wire-contract layer
that enumerates the union by hand, so the type system (not a runtime
default) is what forces every later ticket's call sites to account for
the third kind.

Read `wsMessages.ts`'s own module doc comment before editing — it
explains why `FirmwareSourceRef`/`FirmwareAvailability` are already
generic over `FirmwareKind` and need no shape change, only the union
itself does.

Do NOT touch `FlashControls.tsx`/`FlashDialog.tsx` or any UI call site
in this ticket — that's tickets 004-006. This ticket is wire-contract
and MCP-tool-surface only.

## Acceptance Criteria

- [x] `FirmwareKind` in `packages/host/src/wsMessages.ts` is `"relay" |
      "robot" | "joystick"`.
- [x] `isFirmwareKind` (`wsMessages.ts:815`) accepts `"joystick"`.
- [x] `packages/host/src/mcp/tools/flash.ts`'s own locally-declared
      `FIRMWARE_KINDS` constant (line ~150) and its `z.enum(...)`
      description string both include `"joystick"` — this is a
      deliberately separate constant from `wsMessages.ts`'s (per that
      file's own narrow-surface convention); do not try to import one
      from the other.
- [x] `npx tsc --noEmit` is clean for `packages/host` (this ticket will
      surface every other hardcoded `"relay" | "robot"` literal union as
      a type error — that's expected; do NOT fix those here, they belong
      to ticket 002/003. If a literal-union type error appears outside
      `mcp/tools/flash.ts`, leave it and note it in this ticket's
      completion notes so ticket 002/003 knows to expect it — but check
      first whether it's actually one of the four `store/index.ts` spots
      ticket 002 owns, not a surprise ticket 001 introduced.) — see
      Completion Notes: `mcp/tools/flash.ts` and the rest of
      `packages/host` outside the five known spots is clean; the five
      expected errors are documented below, none are surprises.
- [x] No change to `FirmwareSourceRef`, `FirmwareAvailability`, or any
      other wire message shape.

## Testing

- **Existing tests to run**: `npx vitest run packages/host/src/wsMessages.test.ts --no-coverage`
- **New tests to write**: extend `wsMessages.test.ts`'s
  `isFirmwareKind`/`isFirmwareSourceRef` test cases to cover
  `"joystick"` (both a bare `FirmwareKind` value and a
  `{ kind: "release", firmware: "joystick" }` `FirmwareSourceRef`).
- **Verification command**: `npx vitest run packages/host/src/wsMessages.test.ts packages/host/src/mcp/tools/flash.test.ts --no-coverage` (use the actual test file name if `flash.ts` has no co-located test — check first rather than inventing a path).

Use explicit file paths with `npx vitest run <path> --no-coverage` —
`npm test -- <pattern>` does NOT filter in this repo, it runs the whole
suite (a sprint-022 programmer was burned by this). Run tests in the
foreground, never `run_in_background: true`. The full suite runs once,
at `close_sprint`, not here.

## Completion Notes

- `FirmwareKind` widened to `"relay" | "robot" | "joystick"` in
  `wsMessages.ts`, with a new doc-comment paragraph explaining what a
  joystick is on the wire (a bare micro:bit running
  `Remote-Joystick-Student`, no robot identity, never restricted to an
  "own device page" the way relay/robot are). `isFirmwareKind` widened
  to match. `mcp/tools/flash.ts`'s own `FIRMWARE_KINDS` tuple and its
  `z.enum(...)` description string both widened, with its doc comment
  updated from "two" to "three" members and explaining why joystick is
  unrestricted on the MCP surface (same reasoning as relay/robot today).
  `flash.test.ts`'s test title "outside the two-member enum" renamed to
  "three-member enum" to stay accurate (the test body itself needed no
  change — `"bogus"` is invalid either way). `wsMessages.test.ts` gained
  one new case: a well-formed `flash-start` with
  `source: { kind: "release", firmware: "joystick" }` round-trips
  through `parseClientMessage` (this repo tests `isFirmwareKind`/
  `isFirmwareSourceRef` only indirectly, through `parseClientMessage` on
  `flash-start` messages — neither function is exported or unit-tested
  directly; there was no pre-existing direct test to "extend" as the
  ticket's Testing section literally describes, so I added the
  equivalent accept-case at the message level instead. The existing
  "invalid firmware value" reject case (`firmwareRef: "relayx"`) already
  covers the reject side and needed no change).

- **The widening does NOT stand alone against the full repo build** —
  worth flagging since the sprint's ticket ordering (004 depends only on
  001, not on 003) assumes it might. `npx tsc --noEmit -p
  packages/host/tsconfig.json` surfaces exactly 5 errors, all expected
  and all outside `mcp/tools/flash.ts`:
  - `config.ts:125` and `config.ts:304` — `Record<FirmwareKind, string>`
    / `FirmwareConfigMap` missing `joystick` (ticket 002 territory per
    Step 3).
  - `store/importers/firmwareConfig.ts:71` — same shape, ticket 002.
  - `projection.ts:168` and `firmwareWatcher.ts:336,396` — `FIRMWARE_KINDS`
    typed `"relay" | "robot"` instead of derived from `FirmwareKind`
    (ticket 003 territory per Step 3).
  None of these are the four `store/index.ts` literal-union spots the
  ticket asked me to check for — those (`SetFirmwareInput.kind`,
  `ProjectionFirmwareRow.kind`, `getFirmwareEtag`'s parameter, the raw
  `firmwareRows` cast, at lines 331/505/1752/1972) produced **no**
  compile error at all: nothing yet calls them with a `FirmwareKind`
  -typed value, so the literal union there is inert until ticket 002
  wires it up. Confirmed by direct read, not just tsc's silence.

  Separately (not an AC of this ticket, but the dispatcher's own
  standing instruction was to check both packages), `npx tsc --noEmit -p
  packages/ui/tsconfig.json` also breaks: `deviceDisplay.ts:311` and
  `ws/WsProvider.tsx:246` (both build a `Record<FirmwareKind,
  FirmwareAvailability>`/`Record<FirmwareKind, string>` literal missing
  `joystick`), plus 9 test files that construct the same literal
  (`App.test.tsx`, `AppHeader.test.tsx`, `FlashControls.test.tsx` x3,
  `DevicePage.test.tsx`, `FrontPage.test.tsx`, `RelayPage.test.tsx`,
  `RobotPage.test.tsx`, `UnknownDevicePage.test.tsx`,
  `WsProvider.test.tsx` x2). This is exactly what the sprint's own Test
  Strategy anticipates ("any other `Record<FirmwareKind, …>` literal
  fixture found by grep across `packages/host` and `packages/ui` test
  files — updated, never loosened") and what ticket 003's title
  ("Availability plumbing and fixtures for a third firmware kind")
  already covers — but it means ticket 004 (FlashControls/FlashDialog,
  declared to depend only on 001) will land on top of a UI package that
  does not `tsc` clean until 003 also lands, even though 004 doesn't
  itself touch `Record<FirmwareKind, …>` construction. Flagging for the
  team-lead/sprint-planner rather than fixing here — none of these files
  are in this ticket's scope (wire-contract + MCP tool surface only),
  and fixing them would be doing 002's/003's job early per this ticket's
  own instructions.

- Nothing in the ticket was wrong; the one place its Testing section's
  literal instruction ("extend `wsMessages.test.ts`'s `isFirmwareKind`/
  `isFirmwareSourceRef` test cases") didn't match the file as it
  actually exists is noted above, and I judged the message-level
  equivalent to satisfy the same intent (round-trip coverage of the new
  union member through the real validation path).
