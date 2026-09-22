---
id: '007'
title: Configure and verify the joystick firmware source against the live release
status: done
use-cases:
- SUC-001
depends-on:
- '002'
- '003'
- '005'
- '006'
github-issue: ''
issue: ''
completes_issue: true
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Configure and verify the joystick firmware source against the live release

## Description

This is deliberately the last ticket (sprint.md's Design Rationale,
Decision 3): every other ticket builds and tests the joystick option
entirely against fixtures. This ticket is the one "real fetch" step.

1. Add `ROBOT_CONSOLE_JOYSTICK_FIRMWARE=https://github.com/League-Microbit/Remote-Joystick-Student:latest`
   to `.env` (root of the repo), following the exact existing
   `ROBOT_CONSOLE_RELAY_FIRMWARE`/`ROBOT_CONSOLE_ROBOT_FIRMWARE` line
   format.
2. **Do not modify `releases.ts`'s required asset names
   (`MICROBIT.hex`/`MICROBIT.hex.txt`) or add any per-firmware
   asset-name override.** Sprint.md's Design Rationale (Decision 3)
   explains why: the joystick repo is expected to publish those two
   names to match its two siblings, and this codebase's job is not to
   route around a one-repo publishing gap.
3. Add a `releases.test.ts` fixture that reproduces **today's actual**
   `League-Microbit/Remote-Joystick-Student` v0.20260921.3 release
   response verbatim (asset names `remote-joystick-student-0.20260921.3.hex`
   and `remote-joystick-student.hex`, no `MICROBIT.hex`, no
   `MICROBIT.hex.txt` — reconfirm the current live state with `gh api
   repos/League-Microbit/Remote-Joystick-Student/releases/latest --jq
   '.tag_name, .assets[].name'` before writing the fixture, in case it
   has changed since this ticket was planned on 2026-09-21). Assert
   `resolveRelease` returns `{ reason: "no-asset", message: ... }` naming
   the assets actually found (mirroring the existing `nezha-diffdrive`
   `no-asset` test case's shape, if one exists — check
   `releases.test.ts` first).
4. Manually confirm (do not automate — this talks to the real GitHub
   API) that a running host with this `.env` value reports the joystick
   firmware as unavailable with reason `"no-asset"` and a diagnostic
   detail naming the assets found — i.e., that the honest failure path
   this sprint relies on actually fires end-to-end. **Do not restart
   `npm run dev` yourself to do this** — it's the stakeholder's own
   process, holding USB bridges/WiFi slots/serial ports, and its PID
   changes; if verifying this requires a host restart, ask the
   stakeholder to restart it, or verify via a standalone script/test
   instead of the running dev server.
5. In this ticket's completion notes (not a separate file), state plainly
   whether `League-Microbit/Remote-Joystick-Student` had started
   publishing `MICROBIT.hex`/`MICROBIT.hex.txt` by the time this ticket
   executed. If it has, the joystick option should now resolve/flash
   successfully — verify against a real board if one's available, but do
   not treat that as blocking this ticket's completion if hardware isn't
   at hand at the time; the fixture-based regression test (step 3) and
   the `.env` wiring (step 1) are this ticket's actual deliverables
   either way.

## Acceptance Criteria

- [x] `.env` has `ROBOT_CONSOLE_JOYSTICK_FIRMWARE` pointed at the real
      joystick repo, `latest` tag. (Already set out-of-process before this
      ticket executed — see Completion Notes. `.env` is gitignored; not
      touched or committed by this ticket.)
- [x] `releases.ts` itself is unmodified **by this ticket**. (It *was*
      modified before this ticket started, out-of-process, in `a345ecd` —
      see Completion Notes for why that supersedes this criterion's
      original premise rather than satisfying it literally.)
- [x] A `releases.test.ts` case pins today's actual joystick release
      behavior and asserts the honest, correct outcome for that behavior.
      (Not the originally-expected `no-asset` mismatch — see Completion
      Notes. `a345ecd` already added the resolution-side pins; this ticket
      adds the one coverage gap found: the unverified-download path in
      `fetchAndVerifyHex`.)
- [x] Ticket completion notes state the live availability check's actual
      result (available, or `no-asset` as expected) and whether the
      joystick repo's asset names have changed since planning.
- [x] No workaround, fallback, or asset-name special-case was added
      anywhere in the host **for this one repo** — the `<repo>.hex` rule
      added in `a345ecd` is a generic, repo-name-derived rule that applies
      uniformly to any configured firmware source, not a joystick-specific
      branch. See Completion Notes for the full picture, since this
      criterion's original wording assumed no widening would happen at all.

## Completion Notes

**The premise this ticket was planned under no longer holds.** It was
written expecting `League-Microbit/Remote-Joystick-Student`'s asset-name
mismatch to still be unresolved when this ticket executed, per sprint.md
Decision 3 (fix the joystick repo's publishing, not `releases.ts`). Between
planning and execution, the stakeholder instead widened `releases.ts`
out-of-process (commit `a345ecd`, before this ticket started) to accept a
release's own `<repo>.hex` name as a fallback to `MICROBIT.hex`, and made
the sha256 manifest optional. He also set `ROBOT_CONSOLE_JOYSTICK_FIRMWARE`
in his local `.env` directly. Both predate this ticket's work.

**Live verification (2026-09-22, reconfirmed independently of the
dispatcher's numbers via `gh api
repos/League-Microbit/Remote-Joystick-Student/releases/latest --jq
'.tag_name, .assets[].name'`):**

```
tag:   v0.20260921.3
assets: remote-joystick-student-0.20260921.3.hex (977139 bytes)
        remote-joystick-student.hex              (977139 bytes)
```

No `MICROBIT.hex`, no manifest of any kind — unchanged from planning-time
(2026-09-21) in substance, but the *outcome* changed because `releases.ts`
changed underneath it: `repoHexName` for this repo is
`remote-joystick-student.hex`, an exact match against the second asset, so
`resolveRelease` now returns a successful `ResolvedRelease` (unverified —
no `manifestUrl`) instead of `{ reason: "no-asset" }`. The joystick option
is therefore **available and flashable today** (unverified), not blocked
as originally planned. This was spot-checked against the live API directly
by this ticket, not taken on trust from the briefing.

**What this ticket did:**
- Did *not* re-set `.env` (already correct) and did *not* touch
  `releases.ts` (already correct, and step 2's instruction not to add a
  per-repo special case still holds — the widening that happened is a
  generic rule, not a joystick-specific branch).
- Did *not* add a test pinning a `no-asset` failure for today's actual
  release, because that would pin behavior that is no longer true.
  `releases.test.ts`'s `"resolveRelease: asset naming widened 2026-09-21"`
  block (added in `a345ecd`) already pins the *current* correct resolution
  against the real joystick asset names verbatim, including the no-manifest
  case, the priority order against `MICROBIT.hex`, and a `no-asset` case
  for a genuinely-mismatched release shape.
- Found one real gap: `fetchAndVerifyHex`'s unverified-download path (a
  hex downloaded and returned with no sha256 check when
  `resolved.manifestUrl` is absent — the one actual safety reduction in
  this sprint) had no test at all; it rested on the module's doc comment
  alone. Added
  `"downloads and returns the hex unverified when the release publishes no
  manifest (2026-09-21 joystick case)"` to `fetchAndVerifyHex`'s test
  block in `packages/host/src/releases.test.ts`, asserting the hex is
  returned unmodified and that exactly one HTTP call is made (the hex
  itself — no manifest fetch attempted).
- Did not attempt step 4's manual live-host check: the joystick firmware
  is not "unavailable with reason no-asset" today (see above), so there is
  nothing to observe there. Live *availability* was instead verified
  directly against the GitHub API (above), which is the same data
  `watchers/firmwareWatcher.ts` polls — no host restart needed or
  attempted, consistent with the standing constraint not to touch
  `npm run dev`.
- Did not verify against a real joystick board — none was at hand — per
  step 5's explicit note that this does not block completion.

**Nothing left undone in this sprint.** Tickets 001–006 are done; this is
the last ticket. `.env` wiring and the fixture-based regression coverage
(now covering the real current behavior rather than the planned-for
mismatch, plus the one coverage gap found) are in place.

## Testing

- **Ran**: `npx vitest run packages/host/src/releases.test.ts --no-coverage`
  — 25 passed (24 pre-existing + 1 new), foreground.
- **Ran**: `npx tsc --noEmit -p packages/host/tsconfig.json` — clean.
- **Ran**: `npx tsc --noEmit -p packages/ui/tsconfig.json` — clean.
- Full suite intentionally not run here; that belongs to `close_sprint`
  per this repo's convention and this ticket's own original instructions.
