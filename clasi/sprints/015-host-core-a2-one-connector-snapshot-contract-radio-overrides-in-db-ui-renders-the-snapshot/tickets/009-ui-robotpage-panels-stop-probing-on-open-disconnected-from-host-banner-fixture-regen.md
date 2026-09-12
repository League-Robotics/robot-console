---
id: 009
title: 'UI: RobotPage panels stop probing on open, disconnected-from-host banner,
  fixture regen'
status: in-progress
use-cases:
- SUC-004
- SUC-008
- SUC-010
depends-on:
- 008
github-issue: ''
issue: rearch-07-ui-renders-snapshot-drops-client-policy.md
completes_issue: true
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# UI: RobotPage panels stop probing on open, disconnected-from-host banner, fixture regen

## Description

Third and final UI ticket; completes rearch-07 and, with it, this
sprint's parity gate.

- `StatusPanel`, `CommandStrip`, `DistanceCalibrationWizard`,
  `RotationCalibrationWizard`: remove the on-open
  `STATUS`/`GET`/`FUNCS` probe each currently sends on closed→open,
  since the harvester (ticket 003) now probes on identify and polls
  `STATUS`. Read `session.functions`/`session.robotStatus` from the
  link in the snapshot rather than deriving them from local state built
  up by these probes. `RobotPage.tsx` and its other tabs (Drive,
  Calibration code/table, Functions & charts, Configuration minus the
  Radio panel already done in ticket 006) are otherwise unchanged —
  `RobotPage.transportBlind.test.ts` stays as-is.
- `AppHeader`/`App.tsx`: render the disconnected-from-host banner from
  `useConnectionStatus()` (ticket 007's `WsProvider` seq/staleness
  tracking); disable every send-capable control while the socket is not
  open or the held snapshot is stale; `send()` reports a host-style
  console line instead of dropping silently. This resolves
  `no-disconnected-from-host-banner-in-the-ui.md` (UC-020) as part of
  this ticket.
- Regenerate any remaining `FakeSocket` fixtures not already covered by
  ticket 007; delete the last of the pinned "sends X on closed→open"
  test cases (`StatusPanel`, `CommandStrip`, both wizards).
- Produce the `04-ui.md` §1 parity report: every row either has a
  passing test (cite it) or was confirmed present in the sprint 011
  bench pass — call out explicitly, in the PR description, any row this
  sprint could not preserve and why.

## Acceptance Criteria

- [ ] `StatusPanel`, `CommandStrip`, `DistanceCalibrationWizard`,
      `RotationCalibrationWizard` no longer send `STATUS`/`GET`/`FUNCS`
      on closed→open; the pinned tests for that behavior are deleted,
      not adapted.
- [ ] FakeSocket close → banner shown, every send-capable control
      disabled, a send attempt produces a console line (not a silent
      drop).
- [ ] FakeSocket open + fresh snapshot (higher `seq`) → banner gone,
      controls re-enable only for links the snapshot says are
      `connected`.
- [ ] `grep -rn "localStorage" packages/ui/src` shows only calibration
      state, function args, and console preferences — no radio
      addresses, no connection state (radio addresses already cleared by
      ticket 006; this ticket's grep confirms no new violations were
      introduced).
- [ ] The PR description includes the `04-ui.md` §1 parity report
      (row → test or "confirmed in bench pass ticket 011" or "dropped:
      <reason>").

## Implementation Plan

**Approach**: Panels first (mechanical deletions + read-from-snapshot),
then the app-shell banner (new logic), then the parity report as a
final pass across all three UI tickets' test coverage.

**Files to modify**:
- `packages/ui/src/components/StatusPanel.tsx`
- `packages/ui/src/components/CommandStrip.tsx`
- `packages/ui/src/components/DistanceCalibrationWizard.tsx`
- `packages/ui/src/components/RotationCalibrationWizard.tsx`
- `packages/ui/src/components/AppHeader.tsx`
- `packages/ui/src/App.tsx`

**Files to delete/trim**: the four panels' "sends X on closed→open"
pinned test cases.

**Testing plan**:
- FakeSocket: banner/disable/send-line behavior in `App.test.tsx`;
  panel tests asserting no probe send on open.
- Run: `npx vitest run packages/ui/src/components/StatusPanel.test.tsx packages/ui/src/components/CommandStrip.test.tsx packages/ui/src/components/DistanceCalibrationWizard.test.tsx packages/ui/src/components/RotationCalibrationWizard.test.tsx packages/ui/src/App.test.tsx`.

**Documentation updates**: none.
`no-disconnected-from-host-banner-in-the-ui.md` already lives at
`clasi/issues/done/` (verified during sprint planning) — its content is
folded into this ticket's scope per `rearchitecture-plan.md`'s
disposition table, and no separate `move_issue_to_done` call is needed;
it is not one of this sprint's four linked issues.
