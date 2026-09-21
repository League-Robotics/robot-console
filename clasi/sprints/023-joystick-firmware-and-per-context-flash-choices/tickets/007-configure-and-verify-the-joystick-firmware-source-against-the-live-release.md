---
id: "007"
title: "Configure and verify the joystick firmware source against the live release"
status: open
use-cases: ["SUC-001"]
depends-on: ["002", "003", "005", "006"]
github-issue: ""
issue: ""
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

- [ ] `.env` has `ROBOT_CONSOLE_JOYSTICK_FIRMWARE` pointed at the real
      joystick repo, `latest` tag.
- [ ] `releases.ts` itself is unmodified (no new asset-name logic).
- [ ] A new `releases.test.ts` case pins today's actual joystick release
      asset-name mismatch and asserts the honest `no-asset` failure.
- [ ] Ticket completion notes state the live availability check's actual
      result (available, or `no-asset` as expected) and whether the
      joystick repo's asset names have changed since planning.
- [ ] No workaround, fallback, or asset-name special-case was added
      anywhere in the host for this one repo.

## Testing

- **Existing tests to run**: `npx vitest run packages/host/src/releases.test.ts --no-coverage`
- **New tests to write**: the pinned-mismatch regression case described
  in step 3 above.
- **Verification command**: `npx vitest run packages/host/src/releases.test.ts --no-coverage`, foreground. Then run the **full** suite once, since this is the last ticket before sprint close and `close_sprint` will run it anyway — but per the repo's own convention, that full run belongs to `close_sprint` itself, not this ticket; don't run it here unless the team-lead asks for an early check.
