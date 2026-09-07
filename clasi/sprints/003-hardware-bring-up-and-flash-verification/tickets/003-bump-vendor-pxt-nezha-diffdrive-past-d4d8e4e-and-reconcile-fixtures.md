---
id: '003'
title: Bump vendor/pxt-nezha-diffdrive past d4d8e4e and reconcile fixtures
status: open
use-cases: [SUC-004]
depends-on: []
github-issue: ''
issue: robot-console-two-level-ui-and-multi-transport-roadmap.md
completes_issue: false
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Bump vendor/pxt-nezha-diffdrive past d4d8e4e and reconcile fixtures

## Description

`vendor/pxt-nezha-diffdrive` is pinned at `ce3445d`, predating upstream
`d4d8e4e` ("FUNCS lists the RUN registry; RUN replaces the cleartext RUN:
carve-out") and its follow-up `0056a64`. Fixtures sourced from that
submodule are stale. This ticket bumps the pin and reconciles whatever
breaks.

This ticket does **not** close the roadmap issue
(`robot-console-two-level-ui-and-multi-transport-roadmap.md`) —
`completes_issue: false` is deliberate; that issue spans all 8 remaining
arc positions and must survive this sprint's close.

## Acceptance Criteria

- [ ] provable-without-hardware: `vendor/pxt-nezha-diffdrive`'s pinned
      commit is advanced past both `d4d8e4e` and `0056a64`.
- [ ] provable-without-hardware: `packages/protocol/src/radioAddress.test.ts`
      passes against the bumped pin's
      `vendor/pxt-nezha-diffdrive/docs/radio-address-vectors.json`. If that
      file's content changed between the old and new pin, the test (never
      the addressing algorithm itself) is updated to match, and the exact
      diff is written into this ticket's completion notes for stakeholder
      visibility.
- [ ] provable-without-hardware: the full `npm test` suite passes against
      the bumped pin. Any failure is triaged as either (a) stale-fixture
      drift — update the fixture — or (b) real behavioral drift worth
      flagging in the ticket notes, never silently papered over.
- [ ] `npm run build` passes.
- [ ] Note (not a checkbox): do not attempt to resolve `specification.md`
      §9 Q3(a)/(d) here — that belongs to ticket 004, and even there it is
      recorded as an open candidate pending stakeholder confirmation, not
      closed.

## Implementation Plan

**Approach:**
1. `cd vendor/pxt-nezha-diffdrive && git fetch` and identify a commit that
   is a descendant of both `d4d8e4e` and `0056a64` (verify with `git
   merge-base --is-ancestor d4d8e4e HEAD` after checkout, or equivalent);
   check it out.
2. `cd ../.. && git add vendor/pxt-nezha-diffdrive` to record the new
   submodule pointer.
3. Before touching any test, diff the fixture explicitly:
   `git -C vendor/pxt-nezha-diffdrive diff ce3445d..<new-pin> --
   docs/radio-address-vectors.json` — read the actual diff before deciding
   whether/how a test needs to change.
4. Run `npm test` and `npm run build` from the repo root. For each
   failure, determine root cause before touching anything: is it reading
   stale fixture content (update it), or does it reveal a real protocol
   behavior change (e.g., something depending on the old cleartext `RUN:`
   carve-out) that needs code, not fixture, changes? The latter is a real
   finding — write it up rather than forcing tests green.
5. Grep the repo for any other reference to `vendor/pxt-nezha-diffdrive`
   file contents (not just repo-name string matches) beyond
   `radioAddress.test.ts` before concluding the fixture surface is fully
   covered — confirmed during planning that `config.test.ts`,
   `releases.ts`/`.test.ts`, and `server.test.ts` only reference the repo
   name/URL in strings, not actual submodule file content, but re-verify
   post-bump since this ticket's own investigation is the authoritative
   check, not the planning-time grep.

**Files to modify:**
- `vendor/pxt-nezha-diffdrive` (submodule pointer only)
- `packages/protocol/src/radioAddress.test.ts` (only if fixture content
  changed)
- Any other file found to read submodule content directly, if any

**Testing plan:** full `npm test` (this ticket changes a shared vendored
dependency touching multiple packages, so scope-to-affected-modules isn't
meaningful here — run the whole suite), then `npm run build`.

**Documentation updates:** none required by this ticket directly (spec
corrections are ticket 004's job), but if the bump reveals that §9
Q3(a)/(d) are more clearly answerable than expected, note that finding for
ticket 004 / the stakeholder rather than editing the spec here.
