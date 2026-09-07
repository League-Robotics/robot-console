---
id: '002'
title: 'protocol: naming.ts + radioAddress.ts with full-space conformance test'
status: pending
use-cases:
- SUC-001
depends-on:
- '001'
github-issue: ''
issue: robot-console-architecture-and-roadmap.md
completes_issue: false
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# protocol: naming.ts + radioAddress.ts with full-space conformance test

## Description

Build the two pure identity-math modules in `packages/protocol`, per
`sprint.md`'s Architecture: `naming.ts` (chip ID → five-letter name) and
`radioAddress.ts` (name → default `(channel, group)`), which consumes
`naming.ts`'s base-5 encoding directly. Both are zero-I/O and fully
unit-testable without hardware.

**`naming.ts`** — five base-5 digits over the codebook
`("zvgpt","uoiea","zvgpt","uoiea","zvgpt")`. Digit *i*, counting from the
least significant, lands at name position `4-i`. This is a direct port
of `mbdeploy/src/mbdeploy/devices.py:205-218` — read that file to get the
digit/position mapping exactly right rather than re-deriving it.

**`radioAddress.ts`** — `n = base5(name)` with `name[0]` as the **most**
significant digit. This is consistent with `naming.ts`'s own convention
above (least-significant digit *i* lands at position `4-i`, so the
*most*-significant digit, `i=4`, lands at position `4-4=0`, i.e.
`name[0]`) — it should not need a separate, independent decision, only a
correct re-derivation of the same mapping `naming.ts` already encodes.
Verify this with an explicit round-trip test (id → name via `naming.ts`
→ back to `n` via `radioAddress.ts`'s `base5(name)` → same id) rather
than trusting that two independently-written functions agree just
because each looks right in isolation. Then:
`channel = 25 + 2*(n % 25)`, `group = 1 + n/25` (integer division),
bumped past 10 (i.e. if the resulting group is 10 or greater, per
`microbit-radio-relay/server/src/mbrelay/naming.py` — read that file for
the exact bump rule rather than guessing; port it precisely, this is the
one place a plausible-looking guess is most likely to be wrong).

**Conformance test — the strongest single gate in this sprint.** Assert
`radioAddress.ts` against the **entire 3125-name space** (5^5 names)
against the published sha256 in
`vendor/pxt-nezha-diffdrive/docs/radio-address-vectors.json` (the
submodule added in ticket 001).
A sampled table is not acceptable — it would pass a reversed
(little-endian) encoder, and the full-space digest is the only check
that catches that. Known fixed point: `zuzuv` is `n=1`; a reversed
encoder produces `vuzuz` for the same input and would still pass a
sampled table, so include this exact case as a named unit test in
addition to the full-space hash assertion (a good sanity check to run
first if the full-space hash ever fails, to localize the bug quickly).

**Fixture sourcing — stakeholder decision, supersedes sprint.md Open
Question 1**: do **not** copy `radio-address-vectors.json` into this
repo. `pxt-nezha-diffdrive` is a **git submodule** at
`vendor/pxt-nezha-diffdrive` (added in ticket 001), and the conformance
test reads the vectors file from there:
`vendor/pxt-nezha-diffdrive/docs/radio-address-vectors.json`.

A copy would silently drift from upstream; the submodule pins an exact
commit and updates deliberately. The path is repo-relative, so the test
still runs on any checkout and in CI (CI must clone with
`--recurse-submodules`, or run `git submodule update --init` before
`npm test`).

The test must **fail loudly with an actionable message** if the vectors
file is missing — that means the submodule was not initialized, and the
error should say exactly that rather than surfacing as a confusing
file-not-found.

## Acceptance Criteria

- [ ] `naming.ts` exports a function producing the five-letter name for
      a given numeric chip ID, matching
      `mbdeploy/src/mbdeploy/devices.py:205-218`'s digit-to-position
      mapping.
- [ ] `naming.ts` also exports the inverse (name → numeric value), since
      `radioAddress.ts` needs it, and round-trips correctly (id → name →
      id).
- [ ] `radioAddress.ts` exports a function producing `(channel, group)`
      from a five-letter name, matching
      `microbit-radio-relay/server/src/mbrelay/naming.py`'s formula
      including the group-bump-past-10 rule.
- [ ] `zuzuv` → `n=1` is asserted as an explicit named test case (not
      only covered incidentally by the full-space test).
- [ ] The conformance test asserts the derived `(channel, group)` for
      **all 3125 names** against the published sha256 in the submodule
      copy of `radio-address-vectors.json`, and fails if the computed
      digest does not match.
- [ ] The conformance test records its canonical upstream source
      path/repo in a comment or adjacent note.
- [ ] All tests run under `npm test` with no hardware attached.

## Testing

- **Existing tests to run**: `npm test` (expect ticket 001's zero-test
  baseline plus this ticket's new suite passing).
- **New tests to write**: unit tests for `naming.ts` (spot-checked
  encode/decode pairs plus round-trip), the `zuzuv`/`n=1` named case,
  and the full-3125-name-space conformance test for `radioAddress.ts`
  against the submodule's sha256-verified vectors file.
- **Verification command**: `npm test -- packages/protocol` (or
  workspace-scoped equivalent).

## Implementation Plan

**Approach**:
1. Read `mbdeploy/src/mbdeploy/devices.py:205-218` and
   `microbit-radio-relay/server/src/mbrelay/naming.py` in full before
   writing either module — both are short, and the digit-position and
   group-bump rules are exactly the kind of detail worth transcribing
   precisely rather than re-deriving.
2. Implement `naming.ts`: numeric ID → five-letter name and its inverse.
3. Implement `radioAddress.ts`: five-letter name → `(channel, group)`,
   built on `naming.ts`'s inverse function.
4. Read the vectors file from the submodule at
   `vendor/pxt-nezha-diffdrive/docs/radio-address-vectors.json`,
   resolving the path relative to the repo root (never an absolute or
   machine-local path). Guard the read so a missing file reports
   "submodule not initialized — run `git submodule update --init`".
5. Write the conformance test: compute `(channel, group)` for all 3125
   names, hash the result in the same format the vectors file's
   published sha256 expects (read the vectors file's own structure/
   header to match its hashing convention exactly), and assert equality
   against the published digest.
6. Write the `zuzuv`/`n=1` named test and a handful of round-trip spot
   checks for `naming.ts`.

**Files to create**:
- `packages/protocol/src/naming.ts`
- `packages/protocol/src/naming.test.ts`
- `packages/protocol/src/radioAddress.ts`
- `packages/protocol/src/radioAddress.test.ts`

**Files to modify**: none. (The vectors file is read from the
`vendor/pxt-nezha-diffdrive` submodule; nothing is copied into this
repo.)

**Testing plan**: `npm test` from the repo root; the conformance test
must exercise all 3125 names, not a sample.

**Documentation updates**: none required beyond a brief comment in the
conformance test naming the submodule path as the canonical source.
