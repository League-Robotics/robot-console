---
id: '006'
title: 'Bench: verify MSD fallback with two boards, and stretch FUNCS run if a robot
  is present'
status: open
use-cases:
- SUC-002
- SUC-006
depends-on:
- '002'
github-issue: ''
issue:
- msd-fallback-volume-matching-heuristic-unimplemented.md
- robot-console-two-level-ui-and-multi-transport-roadmap.md
completes_issue:
  msd-fallback-volume-matching-heuristic-unimplemented.md: false
  robot-console-two-level-ui-and-multi-transport-roadmap.md: false
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Bench: verify MSD fallback with two boards, and stretch FUNCS run if a robot is present

## Description

Two independent, opportunistic bench checks bundled into one ticket because
both need whatever happens to be on the bench during the same session, and
neither is large enough to warrant its own ticket:

1. **MSD two-board verification** (`msd-fallback-volume-matching-heuristic-unimplemented.md`).
   Ticket 002 implements and fixture-tests the `DETAILS.TXT`-to-serial join
   logic desk-side. This ticket proves it against real, simultaneously
   mounted volumes — the part that is genuinely untestable with fewer than
   two boards. **Explicitly gated**: with only one board, defer again,
   don't fake it. `completes_issue: true` for the MSD issue reflects that
   *this* ticket is where the issue's own stated verification bar
   ("with two micro:bits attached...") actually gets met — but only if the
   gate is actually satisfied. **If this ticket's MSD criterion is
   deferred (one board only), the team-lead should leave
   `msd-fallback-volume-matching-heuristic-unimplemented.md` open rather
   than relying on this flag** — flagged explicitly in this sprint's report
   back to team-lead.

2. **Stretch `FUNCS` run** (opportunistic, not required): if a robot board
   (not just a relay) happens to be present, running `FUNCS` against it
   takes ten minutes and de-risks arc position 10's (calibration wizards)
   largest open unknown — whether the shipping robot build's run registry
   already contains calibration-suitable programs. This is why the ticket
   is also linked to the roadmap issue, with `completes_issue: false` for
   it (that issue spans all 8 remaining arc positions and is nowhere near
   closeable here).

## Acceptance Criteria

- [ ] needs-a-board, **gated on two boards being attached simultaneously**:
      with two micro:bits attached, force an SWD failure on one (see
      Implementation Plan for how) and confirm: the flash falls back to
      MSD, `defaultResolveVolumePath` (ticket 002's real implementation)
      resolves the *correct* volume for the *failed* device, the hex is
      written there, and the *other* attached board is left completely
      untouched (does not re-announce, does not change firmware). Record
      pass/fail.
- [ ] **If only one board is available on the bench day, this criterion is
      explicitly deferred, not marked done or faked.** Record "deferred:
      only one board available" in this ticket's notes, and note plainly
      that this is the **second consecutive sprint** this specific
      criterion has been deferred (sprint 2 deferred it originally) — this
      is informational for the stakeholder and the next sprint's planner,
      not a reason to fabricate a pass.
- [ ] Stretch, non-blocking, needs-a-board: if a robot board is present,
      send `FUNCS` over the Console tab's send box and record whether it
      returns a sane program list. Its absence (no robot board on the
      bench) does not affect this ticket's completion — skip it entirely
      and say so in the notes.
- [ ] If the two-board test surfaces a real bug in ticket 002's resolver
      (e.g., a `DETAILS.TXT` field assumption that doesn't hold on real
      hardware), fix it in `flash.ts` and add a fixture-based regression
      test — the same "fix + regression test, not a hardware-only patch"
      discipline as ticket 005.
- [ ] `npm test -- packages/host` and `npm run build` pass after any code
      changes.

## Implementation Plan

**Approach:**
1. Requires ticket 002 already merged (the real
   `defaultResolveVolumePath`/join-logic implementation).
2. Attach two boards, both mounted as MSD volumes.
3. Force an SWD failure on one of them for this verification — since there
   is no built-in "force failure" test hook exposed to a manual bench
   session, use whichever pragmatic method is least invasive: a board with
   a genuinely flaky/incompatible SWD connection if one exists on the
   bench, or a temporary local one-line code change (e.g., throwing inside
   `flashOverSwd` for a specific device) reverted immediately after the
   check — never a permanent hardware-only hook shipped to production.
4. Confirm the correct board (matched by `DETAILS.TXT` unique id ↔ device
   serial) receives the MSD write, and the untouched board's firmware is
   verifiably unchanged (re-check its name/role before and after).
5. If a robot board happens to be present, send `FUNCS` via the Console
   tab and record the response.
6. Write up both results (or explicit deferrals) in this ticket's notes
   before moving it to done.

**Files to modify (only if a real bug is found):**
- `packages/host/src/flash.ts`
- `packages/host/src/flash.test.ts`

**Testing plan:** `npm test -- packages/host` (scoped, only if code
changed), `npm run build`.

**Documentation updates:** none required by this ticket directly. If the
MSD criterion is deferred again, that fact should be visible in the
sprint's close-out notes (team-lead's responsibility at `close_sprint`,
not this ticket's).
