---
id: '003'
title: Bump vendor/pxt-nezha-diffdrive past d4d8e4e and reconcile fixtures
status: done
use-cases:
- SUC-004
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

- [x] provable-without-hardware: `vendor/pxt-nezha-diffdrive`'s pinned
      commit is advanced past both `d4d8e4e` and `0056a64`.
- [x] provable-without-hardware: `packages/protocol/src/radioAddress.test.ts`
      passes against the bumped pin's
      `vendor/pxt-nezha-diffdrive/docs/radio-address-vectors.json`. If that
      file's content changed between the old and new pin, the test (never
      the addressing algorithm itself) is updated to match, and the exact
      diff is written into this ticket's completion notes for stakeholder
      visibility.
- [x] provable-without-hardware: the full `npm test` suite passes against
      the bumped pin. Any failure is triaged as either (a) stale-fixture
      drift — update the fixture — or (b) real behavioral drift worth
      flagging in the ticket notes, never silently papered over.
- [x] `npm run build` passes.
- [x] Note (not a checkbox): do not attempt to resolve `specification.md`
      §9 Q3(a)/(d) here — that belongs to ticket 004, and even there it is
      recorded as an open candidate pending stakeholder confirmation, not
      closed. (Confirmed: not touched.)

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

## Completion Notes

**Pin advanced:** `ce3445d` → `85489cb` (`origin/master`,
`v0.20260906.3-30-g85489cb`). Verified with
`git merge-base --is-ancestor d4d8e4e 85489cb` and the same for
`0056a64` — both succeed. `85489cb` also carries the two version-bump
commits (`c0a316a`, `1df5632`) named in the ticket, plus one additional
commit (`11a88b5`, a WiFi-transport diagnostic note unrelated to RUN/
FUNCS) and its own version-bump (`85489cb` itself is `chore: bump
version to 1.20260907.3`).

**Fixture diff — benign, in fact zero:**
`git -C vendor/pxt-nezha-diffdrive diff ce3445d..85489cb --
docs/radio-address-vectors.json` produced **no output** — the file is
byte-identical between the old and new pin. `radioAddress.test.ts`
required no changes. Confirmed via `git diff --stat ce3445d..85489cb`
across the whole submodule that `docs/radio-address-vectors.json` does
not appear in the changed-file list at all.

**Re-verified the fixture-surface grep post-bump** (ticket step 5): grep
of `packages/` for `pxt-nezha-diffdrive` confirms `DevicesTab.test.tsx`,
`config.test.ts`, `releases.ts`/`releases.test.ts`, and
`server.test.ts` reference only the repo name/URL in string literals —
none read submodule file content. Only
`packages/protocol/src/radioAddress.ts` and
`radioAddress.test.ts` reference actual submodule file content
(`docs/radio-address-vectors.json`, `docs/radio-addressing.md`).
Confirms the planning-time grep; no new fixture consumers found.

**Firmware behavior that changed (real, but does not require code
changes here):** `d4d8e4e` removed the cleartext `RUN:<name>[:<arg>...]`
prefix carve-out entirely — previously `Protocol::routeLine()` matched
a literal `"RUN:"` prefix and diverted the line to `handleRun()` before
it ever reached the v6 grammar stack, on every transport (serial,
radio, WiFi). After `d4d8e4e`/`0056a64`, there is **no carve-out**:
every inbound line goes through the v6 stack, and `RUN <name> [arg...]
#<id>` reaches the same by-name dispatch via
`WireAdapter::onRun() → protocolOfferRun() → handleRun()`, now under
the normal ack/nack sequencing layer like the other ten sequenced
verbs. `FUNCS` was added as a new verb that lists the RUN registry
(not implemented anywhere in this repo — confirmed via
`grep -rn FUNCS packages/`, zero hits, correctly out of scope per this
ticket).

Checked whether this repo's `packages/protocol/src/v6/` carries the
stale assumption the ticket warned about (an addressing/dispatch path
built around the old cleartext prefix): it does not.
`packages/protocol/src/v6/session.ts`'s `SEQUENCED_VERBS` already lists
`"RUN"` as one of the eleven id-bearing sequenced verbs, i.e. this
repo's protocol model was already built for the *post*-`d4d8e4e` wire
shape (ordinary sequenced verb, not a cleartext prefix carve-out). So
the vendored reference submodule was the stale side, not this repo's
code — bumping the pin brings the reference in line with what
`packages/protocol/src/v6/` already assumes. No real drift found
against this repo's code; nothing to flag as needing a follow-up fix
in `packages/protocol`.

One adjacent, out-of-scope observation for the record: the "RUN:
invocation by name" wire-vector section name in
`packages/protocol/src/v6/codec.test.ts` traces to
`vendor/radio-robot-lib/tests/protocol/golden_vectors.txt`'s section
header — a **different** submodule (`radio-robot-lib`, pinned to
`heads/main`, not a fixed commit) that this ticket does not touch. Its
label is a legacy name from before `d4d8e4e`; not addressed here since
`radio-robot-lib` is out of this ticket's scope.

**Test/typecheck results (bumped pin):**
- `npm test`: 16 files, 472 tests, all passed. No fixture updates were
  needed.
- `npx vitest run packages/protocol/src/radioAddress.test.ts`: 5/5
  passed, run in isolation to confirm directly.
- `npm run build`: all three workspaces (`host`, `protocol`, `ui`)
  typecheck clean.

**§9 Q3(a)/(d):** left untouched, as instructed. Not closed here.
