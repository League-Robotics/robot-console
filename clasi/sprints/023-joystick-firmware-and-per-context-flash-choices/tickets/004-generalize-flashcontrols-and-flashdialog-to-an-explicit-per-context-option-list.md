---
id: "004"
title: "Generalize FlashControls and FlashDialog to an explicit per-context option list"
status: open
use-cases: ["SUC-001", "SUC-002", "SUC-003"]
depends-on: ["001"]
github-issue: ""
issue: ""
completes_issue: true
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Generalize FlashControls and FlashDialog to an explicit per-context option list

## Description

This is the core UI mechanism change. `FlashControls.tsx` currently
hardcodes two `<div className="device-flash-control">` blocks (relay,
robot — lines ~356-423) and unconditionally renders the "Flash a hex
file from disk" section (~425-465). Replace this with:

- A new required prop `allowedFirmware: readonly FirmwareKind[]` on
  `FlashControlsProps` — **no default value**. Render one
  `device-flash-control` block per entry in `allowedFirmware`, in the
  order given, via a small shared render function/component
  parameterized by `FirmwareKind` (reuse `FIRMWARE_LABEL[kind]`,
  `firmwareStatus[kind]`, `firmwareDisabledReason`,
  `firmwareDiagnosticDetail`, `firmwareSourceText` exactly as the
  existing two blocks already do — only the hardcoding goes away, not
  the logic).
- A new required prop `allowLocalHex: boolean` — **no default value**.
  Wrap the entire existing "Flash a hex file from disk" `<div
  className="device-flash-local">` section in `{allowLocalHex && ( ...
  )}`.

Both props are **required, with no default in the function signature**
— this is deliberate (sprint.md's Design Rationale, Decision 1): a call
site that forgets to pass them must get a TypeScript compile error, not
a silently-permissive fallback. Do not write `allowedFirmware =
["relay", "robot", "joystick"]` or similar as a default parameter value.

`FlashDialog.tsx` takes the same two props on `FlashDialogProps` and
forwards them straight through to its `<FlashControls>` (line ~313) with
no logic of its own — its own `canBeFlashed`/`forceShow` trigger-gating
is unrelated and untouched.

Also add a `joystick` entry to `FIRMWARE_LABEL` in
`packages/ui/src/deviceDisplay.ts` (line ~311), and add a new exported
constant there: `export const ALL_FLASHABLE_FIRMWARE: readonly
FirmwareKind[] = ["robot", "relay", "joystick"];` — this is the one
place the permissive option set is spelled out; tickets 005/006 import
it rather than each re-typing the array.

Do NOT touch any call site (`AppHeader.tsx`, `FrontPage.tsx`,
`UnknownDevicePage.tsx`) in this ticket — every existing call site will
now fail to compile because the two new props are required. That's
expected; tickets 005 and 006 fix the call sites. If you want this
ticket's own test suite to pass in isolation, update
`FlashControls.test.tsx`/`FlashDialog.test.tsx` to pass explicit props
in every test case (this is in scope for this ticket — the *component*
tests, not the call-site/page tests).

## Acceptance Criteria

- [ ] `FlashControlsProps` has required `allowedFirmware: readonly
      FirmwareKind[]` and `allowLocalHex: boolean` — verify by removing
      one from a test call site and confirming `tsc` fails, then adding
      it back.
- [ ] Passing `allowedFirmware={["robot"]}` renders exactly one
      `device-flash-control` block ("Flash robot firmware") and no
      others.
- [ ] Passing `allowedFirmware={["robot", "relay", "joystick"]}` renders
      all three, in that order.
- [ ] Passing `allowLocalHex={false}` renders no "Flash a hex file from
      disk" section at all (not merely disabled/hidden via CSS — absent
      from the DOM).
- [ ] `firmwareDisabledReason`/`firmwareDiagnosticDetail`/
      `firmwareSourceText` render identically to today for whichever
      kinds are present in `allowedFirmware` — no behavior change to the
      per-button logic itself, only which buttons exist.
- [ ] `FlashDialog.tsx` forwards both props unchanged to `FlashControls`.
- [ ] `deviceDisplay.ts` exports `ALL_FLASHABLE_FIRMWARE` and
      `FIRMWARE_LABEL.joystick`.
- [ ] `FlashControls.test.tsx`/`FlashDialog.test.tsx` pass explicit
      props in every test case; no test relies on an omitted prop.

## Testing

- **Existing tests to run**: `npx vitest run packages/ui/src/components/FlashControls.test.tsx packages/ui/src/components/FlashDialog.test.tsx --no-coverage`
- **New tests to write**: cases for `allowedFirmware` filtering (one
  kind, two kinds, all three, empty array renders no
  `device-flash-control` blocks), and `allowLocalHex` true/false.
- **Verification command**: `npx tsc --noEmit` inside `packages/ui`
  (confirm the actual invocation this repo uses, e.g. via its
  `package.json` script, rather than assuming a bare `tsc` works from
  the repo root) plus the two test files above, run individually,
  foreground.
