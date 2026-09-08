---
id: '001'
title: Fix flash-controls gating for a silent, unflashed board
status: open
use-cases:
- SUC-001
depends-on: []
github-issue: ''
issue: flash-controls-unreachable-for-silent-boards-and-missing-from-every-device-page.md
completes_issue: false
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Fix flash-controls gating for a silent, unflashed board

## Description

The most common bench state — a completely unflashed micro:bit — is the
one state that currently gets **no** flash controls anywhere.
`UnknownDevicePage.tsx:230` gates every flash affordance on
`isFailedIdentify(endpoint)` (`deviceDisplay.ts:60-62`:
`role === null && sessionError !== undefined`). A silent board's
session opens fine and `identify()` resolves `null` without throwing
(`deviceRegistry.ts`'s `connectAndIdentify`), so `sessionError` stays
`undefined` and the predicate is always `false` for exactly this board.

Fix: introduce `canBeFlashed(device): boolean` in `deviceDisplay.ts`
returning `device.role === null` (ignoring `sessionError` entirely),
and use it in place of `isFailedIdentify` at `UnknownDevicePage.tsx:230`.
Delete `isFailedIdentify` — `grep -rn "isFailedIdentify"
packages/ui/src` confirms exactly one call site, so nothing else depends
on its narrower "actually failed, not merely unprobed" meaning. Do not
redefine `isFailedIdentify` in place: broadening its behavior without
renaming would leave a function named "is-failed-identify" returning
`true` for the common, unalarming "hasn't announced yet" case its own
doc comment currently excludes on purpose. Update that doc comment
(`deviceDisplay.ts:53-59`) to describe `canBeFlashed`'s actual rule
instead of carrying forward the now-incorrect "never an unprobed
device" claim.

`roleDisplay` (a separate function) already derives its own
"Unresponsive" label directly from `sessionError` and is unaffected by
this change — do not touch it.

This ticket is scoped to the gating logic only. It does **not** restore
the front-page flash affordance (ticket 002) or add a top-menu Flash
entry (ticket 004) — see `sprint.md`'s Solution for why the fix is
split this way (unblock the primary bench workflow first, without
waiting on the shared-component extraction).

## Acceptance Criteria

- [ ] `deviceDisplay.ts` exports `canBeFlashed(device: EndpointListEntry):
      boolean` returning `device.role === null`, independent of
      `sessionError`.
- [ ] `isFailedIdentify` is removed from `deviceDisplay.ts` (confirmed
      via grep: no remaining references anywhere in `packages/ui/src`).
- [ ] `UnknownDevicePage.tsx:230`'s `showFlashControls` uses
      `canBeFlashed` in place of `isFailedIdentify`.
- [ ] `deviceDisplay.ts`'s doc comment above the predicate is rewritten
      to describe the actual rule (role-based, not
      probed-vs-unprobed-based), removing the now-false "never an
      unprobed device" claim.
- [ ] A pinned regression test: an `EndpointListEntry` fixture with
      `role: null, sessionError: undefined` (the silent-board case)
      renders flash controls on `UnknownDevicePage`.
- [ ] Existing `isFailedIdentify`-gating tests in
      `UnknownDevicePage.test.tsx` (the failed-identify case, e.g.
      `role: null, sessionError: "..."`) still show flash controls —
      `canBeFlashed`'s `role === null` rule is a strict superset of the
      old gate, not a replacement with different coverage.
- [ ] An identified device (`role` set, e.g. `"RADIORELAY"` or
      `"NEZHA2"`) still shows no flash controls on `UnknownDevicePage`
      (not reachable in practice — `DevicePage` dispatches identified
      types elsewhere — but `canBeFlashed` itself is asserted false for
      this case directly).

## Testing

- **Existing tests to run**: `npm test -- UnknownDevicePage` (packages/ui).
- **New tests to write**: `deviceDisplay.test.ts` truth table for
  `canBeFlashed` across all four `(role, sessionError)` combinations;
  the pinned silent-board regression test in `UnknownDevicePage.test.tsx`.
- **Verification command**: `npm test`, `npm run build`.

## Implementation Plan

### Approach

Rename-with-redefinition at the single call site: add `canBeFlashed`,
switch `UnknownDevicePage.tsx` to it, delete `isFailedIdentify` and its
doc comment, write the new doc comment for `canBeFlashed`. No other
files are touched — this ticket is deliberately minimal so it can land
ahead of the shared-component extraction (ticket 002).

### Files to create/modify

- `packages/ui/src/deviceDisplay.ts` — add `canBeFlashed`, remove
  `isFailedIdentify`, rewrite doc comment.
- `packages/ui/src/pages/UnknownDevicePage.tsx` — swap the import and
  the `showFlashControls` assignment at line 230.
- `packages/ui/src/deviceDisplay.test.ts` (new, if it doesn't already
  exist as a separate file — check first; `roleDisplay`/`nameDisplay`
  may currently only be tested indirectly through page tests) or an
  existing `deviceDisplay.test.ts` — add the `canBeFlashed` truth table.
- `packages/ui/src/pages/UnknownDevicePage.test.tsx` — add/adjust the
  silent-board regression case.

### Testing plan

See Acceptance Criteria / Testing above.

### Documentation updates

`deviceDisplay.ts`'s module doc comment already explains why this file
is the shared home for flash-gating helpers — no change needed there,
only the per-function doc comment on the predicate itself.
