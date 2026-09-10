---
id: '005'
title: Correct UC-006/UC-007 in docs/design/usecases.md to match the shipped calx/cala
  firmware
status: open
use-cases: []
depends-on:
- '003'
- '004'
github-issue: ''
issue: robot-console-two-level-ui-and-multi-transport-roadmap.md
completes_issue: true
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Correct UC-006/UC-007 in docs/design/usecases.md to match the shipped calx/cala firmware

## Description

`docs/design/usecases.md`'s UC-006 ("Run a distance calibration") and
UC-007 ("Run a rotation calibration") were written before the
calibration hex existed, and both are now wrong in two independent
ways this sprint's own findings corrected (see `sprint.md`'s
Detail-planning findings):

1. **The "Error flows" sections say the wizard depends on "the
   cleartext `RUN:name:arg` path with no sequence id"** — stale, from
   when the v6 `RUN` verb was a stub (specification.md §9 Q3(a)/(d),
   now confirmed permanent per this sprint).
2. **UC-007's main flow describes a front-mounted beam pointer and
   on-screen nudge controls that walk the turn in.** The shipped
   `cala` routine has neither — it is a fully autonomous CW/CCW spin
   against a black-tape cross with a built-in re-verification pass.
   UC-006's flow is closer to correct but still says the wizard
   "reports drift" as if the student does something with that number
   mid-run, rather than the firmware directly emitting the corrected
   constant as a ready-to-paste line.

This ticket is sequenced after tickets 003/004 (not before) so it
documents what the wizards actually do, verified against the shipped
components, rather than describing an intended design that might still
drift during implementation.

This is prose-only, no source-code change, and is out of
sprint-planner's own write scope (`docs/design/` is not
`clasi/sprints/`) — hence a ticket rather than a sprint.md edit.

## Acceptance Criteria

- [ ] UC-006's main flow describes: `FUNCS`-gated availability, `RUN
      calx`, the robot creeping to a first line and driving a known
      90 cm gap autonomously, and the wizard rendering the firmware's
      own `CALX:apply ...` line verbatim as the snippet — no student
      action mid-run beyond the initial physical setup (laying two
      lines 90 cm apart) and pressing Go.
- [ ] UC-006's error flows drop the stale cleartext-`RUN:` dependency
      language and instead describe: a `FUNCS` response missing `calx`
      (wizard shows "unavailable", never starts), a `RUN` `err 1`
      (distinct from a `CALX:fail` report), and a `CALX:fail ...` report
      line (the firmware's own failure report, e.g. no line found).
- [ ] UC-007's main flow is rewritten to remove the beam pointer and
      nudge-control description entirely and instead describes:
      `FUNCS`-gated availability, `RUN cala`, the autonomous CW/CCW
      spin against a black-tape cross, the firmware's own automatic
      re-verification pass, and the wizard rendering the firmware's own
      `CALA:apply ...` line verbatim as the snippet.
- [ ] UC-007's error flows mirror UC-006's corrected shape (missing
      `cala`, `err 1`, `CALA:fail ...`) and drop the stale nudge-pacing
      error flow (there is no nudge control to pace).
- [ ] Neither use case is renumbered, and neither loses its existing
      `**Actor:**`/`**Preconditions:**` header structure — this is a
      content correction within the existing use-case format, not a
      restructuring.

## Implementation Plan

**Approach:** read tickets 003/004's actual shipped panel behavior (not
just this sprint's plan) before writing, since the acceptance criteria
above describe the intended shape and the shipped panel is the ground
truth if anything shifted during implementation.

**Files to modify:**
- `docs/design/usecases.md` — UC-006 and UC-007 only; no other use case
  in that file is touched.

**Testing plan:** none (prose-only change). Confirm no other document
cites the specific stale language being removed (`grep -rn "cleartext
RUN" docs/` and `grep -rn "beam pointer" docs/` before and after, to
confirm the correction is complete and doesn't need to touch
`specification.md` too — if it does, flag that as a separate follow-up
rather than expanding this ticket's scope).

**Documentation updates:** this ticket *is* the documentation update.
