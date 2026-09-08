---
id: '005'
title: RobotPage two-column layout, unified console, and command strip
status: open
use-cases:
- SUC-006
depends-on:
- '003'
github-issue: ''
issue: robot-page-two-column-layout-with-unified-console-command-strip.md
completes_issue: false
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# RobotPage two-column layout, unified console, and command strip

## Description

`RobotPage.tsx` currently stacks `EstopControl`, `SequencingIndicator`,
`DriveControls`, `StatusPanel`, `GetSetPanel`, and `DeviceConsole` in
one `max-width: 46rem` column. Three panels render separate response
areas reading the same underlying rx log, producing the "two consoles"
effect the stakeholder reported — and one of them, `GetSetPanel.tsx:55`,
has a real bug: `watermarkId` starts at `-1`
(`GetSetPanel.tsx:52`), so before any GET/SET is ever sent, its filter
(`entry.id > watermarkId`) matches the endpoint's *entire* rx history.
Neither its reply area (`GetSetPanel.css:76`, `min-height: 2rem`, no
`max-height`/`overflow`) nor `StatusPanel`'s can scroll or cap their
height.

Relay out the page:

- **Left column**: `EstopControl` **stays a sibling of the two-column
  grid, mounted above both columns** — not inside either. Its CSS
  (`EstopControl.css`) pins it via `position: sticky; top: 0`, which
  depends on the *document* being its nearest scrolling ancestor (per
  its own doc comment); nesting it inside a column that scrolls
  independently would break that pinning silently. Below it: this
  column holds `DriveControls` (unchanged) and a stubbed, empty charts
  area (a labeled placeholder — no chart library, no telemetry
  subscription; charts are future work per the linked issue's own
  scoping note).
- **Right column**: one `DeviceConsole`, sized to fill the column's full
  height (not the current fixed `max-height: 32rem` — the column itself
  should scroll to fill available height, per the linked issue's own
  structural note), with a new `CommandStrip` beneath it.
- **`CommandStrip`** (new component) offers HELLO, ID, VER, STATUS, and
  a GET/SET pair (free-text name + value this ticket; auto-discovery is
  ticket 006). `HELLO`/`ID`/`VER`/`STATUS` are none of them in
  `SEQUENCED_VERBS` (`session.ts:120-132`), so they all dispatch through
  `sendCommand` exactly as `EstopControl`/`StatusPanel` already do,
  **except** `HELLO`: `deviceRegistry.ts:945-951` deliberately rejects
  a live `"HELLO"` command before it reaches `Session` (unchanged sprint
  006 safety rule). The strip must still send it via ordinary
  `sendCommand(endpointId, "HELLO")` — the resulting host-side rejection
  now surfaces in the console via ticket 003's fix, which this ticket
  depends on. `GET`/`SET` remain sequenced, dispatched exactly as
  `GetSetPanel` did.
- Every reply — from any strip button, including `HELLO`'s rejection —
  lands in the single `DeviceConsole` log. No panel renders its own
  reply area.
- **Retire** `StatusPanel.tsx`/`.css`/`.test.tsx` and
  `GetSetPanel.tsx`/`.css`/`.test.tsx` outright (confirmed via grep:
  their only importers outside their own files are `RobotPage.tsx`,
  `RobotPage.test.tsx`, and `RobotPage.transportBlind.test.ts` — safe to
  delete, not deprecate).
- Remove `RobotPage.css`'s `max-width: 46rem`; the page uses the full
  window width, split roughly in half.
- Update `RobotPage.transportBlind.test.ts`'s `FILES_UNDER_TEST` to drop
  the two deleted files and add `CommandStrip.tsx` — the scan must
  actually certify the new file, not just continue passing on a stale
  list.

## Acceptance Criteria

- [ ] `RobotPage` renders a two-column layout; `EstopControl` is
      mounted above both columns (asserted structurally: not a
      descendant of either column's scroll container), left column has
      `DriveControls` + a stubbed charts placeholder, right column has
      `DeviceConsole` + `CommandStrip`.
- [ ] `RobotPage.css`'s `max-width: 46rem` is removed.
- [ ] `DeviceConsole`'s log fills the right column's available height
      (no fixed `max-height` leaving dead space).
- [ ] `CommandStrip` sends HELLO/ID/VER/STATUS via `sendCommand`
      (unsequenced except HELLO's special host-side rejection) and
      GET/SET via `sendCommand` (sequenced), with a free-text name/value
      pair.
- [ ] Pressing Hello against an open session shows the host's rejection
      text in the console (depends on ticket 003).
- [ ] A regression test: a populated rx log with nothing sent produces
      no second echoed region anywhere on the page (the `GetSetPanel`
      bug's absence, asserted against the page as a whole).
- [ ] `StatusPanel.tsx`/`.css`/`.test.tsx` and
      `GetSetPanel.tsx`/`.css`/`.test.tsx` are deleted; `grep -rn
      "StatusPanel\|GetSetPanel" packages/ui/src` returns no remaining
      references.
- [ ] `RobotPage.transportBlind.test.ts`'s `FILES_UNDER_TEST` drops the
      two deleted files and adds `CommandStrip.tsx`; all three
      transport-blindness assertions (`UsbSerialLink`, quoted `"usb"`,
      `endpoint.transport`) pass against the new file.
- [ ] `RobotPage.test.tsx` updated for the new structure end to end.

## Testing

- **Existing tests to run**: `npm test -- RobotPage GetSetPanel
  StatusPanel` (packages/ui) before deletion, to confirm current
  coverage is understood and nothing is silently lost in the move.
- **New tests to write**: `CommandStrip.test.tsx` (new); `RobotPage.test.tsx`
  rewritten for the two-column structure, the single-log-region
  regression, and the `EstopControl` placement assertion;
  `RobotPage.transportBlind.test.ts` file-list update.
- **Verification command**: `npm test`, `npm run build`.

## Implementation Plan

### Approach

Build `CommandStrip` first (independently testable against a fake
link/socket), then relayout `RobotPage.tsx`/`RobotPage.css` around it,
then delete the retired panels and update the transport-blind scan last
so the deletion's completeness is checked by the same commit that
removes the files.

### Files to create/modify

- `packages/ui/src/components/CommandStrip.tsx`, `.css`, `.test.tsx` —
  new.
- `packages/ui/src/pages/RobotPage.tsx`, `.css` — relayout.
- `packages/ui/src/pages/RobotPage.test.tsx` — rewritten.
- `packages/ui/src/pages/RobotPage.transportBlind.test.ts` —
  `FILES_UNDER_TEST` updated.
- `packages/ui/src/components/StatusPanel.tsx`/`.css`/`.test.tsx`,
  `GetSetPanel.tsx`/`.css`/`.test.tsx` — deleted.

### Testing plan

See Acceptance Criteria / Testing above.

### Documentation updates

`RobotPage.tsx`'s module doc comment (currently describing the
single-column panel stack) needs a full rewrite describing the
two-column structure and, critically, re-stating the transport-blindness
constraint and why `EstopControl`'s placement above both columns matters
for its `position: sticky` CSS — carrying forward sprint 006's
"transport-blindness is load-bearing, not incidental" framing rather
than dropping it during the rewrite.
