---
id: '005'
title: 'Bench: flash a relay over SWD and verify role + console replies against real
  hardware'
status: open
use-cases:
- SUC-001
depends-on: []
github-issue: ''
issue:
- sprint-002-flash-path-unverified-against-hardware.md
- sprint-001-hardware-criteria-unverified-no-announcing-board.md
completes_issue:
  sprint-002-flash-path-unverified-against-hardware.md: false
  sprint-001-hardware-criteria-unverified-no-announcing-board.md: false
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Bench: flash a relay over SWD and verify role + console replies against real hardware

## Description

The headline bench session. Sprints 1 and 2 both closed with
hardware-dependent criteria explicitly deferred: sprint 1 never verified
`role` or got a reply to `HELLO`/`?`/`STATUS` (the only bench board was
silent on serial); sprint 2 built the entire SWD flash path but never ran
it against a physical board. This ticket runs both verifications in one
session, since a successfully flashed relay is simultaneously the
announcing board sprint 1 needed and the end-to-end proof sprint 2 needs.

**This ticket is explicitly time-boxed.** If SWD flashing cannot be made to
work on this platform within the session, the correct outcome is a
recorded **finding** (MSD becomes provisionally primary), not continued
debugging. Do not grind on this — see the last acceptance criterion.

Depends conceptually (not via `depends-on`, since there's no code
dependency) on tickets 001-004 having already landed, per sprint.md's
"desk work before bench work" sequencing — this is the first ticket in the
sprint's execution order that actually needs a board.

## Acceptance Criteria

- [ ] needs-a-board: on a board currently showing `linkError`/no role,
      click "Flash relay firmware" (the existing, unchanged UC-002 flow)
      and observe the SWD attach → erase → write → reset sequence run to
      completion.
- [ ] needs-a-board: the board reboots and re-announces with a
      `RADIORELAY` or `RADIOBRIDGE` role visible in the Devices tab.
      Record pass/fail — do not infer from sprint 2's tests.
- [ ] needs-a-board: the real progress-event timing (erasing/writing/
      resetting phases) observed is sane, not merely internally consistent
      with sprint 2's fake `DapLinkFactory` timeline. Record what was
      actually observed.
- [ ] needs-a-board: in the Console tab's send box, `HELLO`, `?`, and
      `STATUS` each return a sane, readable reply. Record pass/fail per
      command. (This closes sprint 001's console-reply gap.)
- [ ] needs-a-board, opportunistic per sprint.md's "RADIORELAY legacy path"
      note: if a board running the older `RADIORELAY` hex (hex serial
      encoding, distinct from `RADIOBRIDGE`'s decimal) is available, check
      its role also renders correctly. Not required if only one firmware
      variant is available to test.
- [ ] **Time-box / escalation trigger**: if attach/erase/write cannot be
      made to succeed against at least one real board after reasonable
      troubleshooting within the bench session, STOP iterating on SWD.
      Record a finding in this ticket's notes containing: the `dapjs`
      version in use, the specific `node-hid` behavior/errors observed,
      the macOS HID permission state (System Settings > Privacy &
      Security), and the exact error(s) `flashOverSwd` returned. State
      explicitly: "MSD is provisionally the primary flash path pending
      further investigation." **This is an acceptable, complete ticket
      outcome — not a failure requiring further attempts.**
- [ ] Any real bug the hardware sequence exposes in `flashOverSwd` /
      `swdName.ts` is fixed in place *and* covered by a new or updated unit
      test using the existing injected `DapLinkFactory` / `CortexMFactory`
      seams — a hardware-motivated fix without a regression test is
      incomplete. (If no bug is found, this criterion doesn't apply.)
- [ ] `npm test -- packages/host` and `npm run build` pass after any code
      changes made in response to what the bench session found.

## Implementation Plan

**Approach:**
1. Attach a board currently in the silent/unnamed-role state (per
   `sprint-001-hardware-criteria-unverified-no-announcing-board.md`'s
   finding).
2. Drive the existing UI flow (Devices tab → Flash relay firmware) exactly
   as a student would — this ticket verifies existing behavior, it does
   not build new UI.
3. Observe closely: does `daplink.connect()` succeed? Does `daplink.flash()`
   run to completion and emit progress events? Does the post-flash reset
   actually happen? Capture exact error messages for anything that fails.
4. If something fails in a way `classifyAttachError`'s permission/generic
   split doesn't already explain clearly, consider whether the
   `FlashFailure`/`SwdNameFailure` reason taxonomy needs a new bucket —
   but only if the real error demands it; don't speculatively add reasons
   nothing has actually returned.
5. Once flashed and re-announced, switch to the Console tab and send
   `HELLO`, `?`, `STATUS` via the send box; record each reply verbatim in
   the ticket notes.
6. If the time-box is hit first (use judgment — this is a bench session,
   not a fixed clock, but "reasonable troubleshooting" means don't spend
   the whole session on one error class): stop, write the finding, and
   close this ticket. The MSD path (ticket 002/006) becomes the sprint's
   carried hardware-flash proof instead.

**Files to modify (only if a real bug is found):**
- `packages/host/src/flash.ts`
- `packages/host/src/swdName.ts`
- Their respective `.test.ts` files

**Testing plan:** `npm test -- packages/host` (scoped, only if code
changed), `npm run build`.

**Documentation updates:** none required by this ticket directly; if the
finding is reached (SWD doesn't work, MSD provisionally primary), that is
significant enough to also mention briefly in sprint.md's own notes at
sprint close, for the stakeholder's visibility — the team-lead handles that
at close time, not this ticket.
