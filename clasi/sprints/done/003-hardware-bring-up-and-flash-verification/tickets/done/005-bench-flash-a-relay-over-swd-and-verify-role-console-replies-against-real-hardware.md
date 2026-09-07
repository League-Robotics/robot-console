---
id: '005'
title: 'Bench: flash a relay over SWD and verify role + console replies against real
  hardware'
status: done
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

- [x] needs-a-board: on a board currently showing `linkError`/no role,
      click "Flash relay firmware" (the existing, unchanged UC-002 flow)
      and observe the SWD attach → erase → write → reset sequence run to
      completion. **PASS.** Driven via `deviceRegistry.requestFlash` over
      the real `startServer()`/WebSocket contract (no fakes) against the
      board that was `linkError`/`role: null` in sprint 001. The sequence
      ran attach → erase → write → reset to completion with no error at
      any stage; see Bench Findings below for the verbatim result and
      timing.
- [ ] needs-a-board: the board reboots and re-announces with a
      `RADIORELAY` or `RADIOBRIDGE` role visible in the Devices tab.
      Record pass/fail — do not infer from sprint 2's tests. **FAIL.**
      The board did not re-announce. `role` stayed `null` after the
      flash; see Bench Findings for the exact `linkError` observed,
      independently confirmed twice (once from this ticket's own harness,
      once from the team-lead's separate fresh session).
- [x] needs-a-board: the real progress-event timing (erasing/writing/
      resetting phases) observed is sane, not merely internally consistent
      with sprint 2's fake `DapLinkFactory` timeline. Record what was
      actually observed. **RECORDED** — see Bench Findings for the exact
      per-phase timestamps (a real ~40.6s flash, dominated by ~11,575
      per-page `writing` progress events over CMSIS-DAP HID).
- [ ] needs-a-board: in the Console tab's send box, `HELLO`, `?`, and
      `STATUS` each return a sane, readable reply. Record pass/fail per
      command. (This closes sprint 001's console-reply gap.) **BLOCKED —
      not exercised.** No link to the board was ever open (see the
      preceding criterion's FAIL), so there was no live session to type
      these into. All three were attempted anyway against the closed
      link, each returning the registry's own `"device ... has no open
      link"` error, not a device reply — this is not a console-reply
      result and must not be read as one. Sprint 001's console-reply gap
      remains open.
- [ ] needs-a-board, opportunistic per sprint.md's "RADIORELAY legacy path"
      note: if a board running the older `RADIORELAY` hex (hex serial
      encoding, distinct from `RADIOBRIDGE`'s decimal) is available, check
      its role also renders correctly. Not required if only one firmware
      variant is available to test. **N/A — not attempted.** Only one
      firmware variant was configured/available this session
      (`ROBOT_CONSOLE_RELAY_FIRMWARE` points at the current `RADIOBRIDGE`
      -producing repo; no legacy `RADIORELAY` hex or board was on the
      bench). Explicitly not required by this criterion's own text.
- [ ] **Time-box / escalation trigger**: if attach/erase/write cannot be
      made to succeed against at least one real board after reasonable
      troubleshooting within the bench session, STOP iterating on SWD.
      Record a finding in this ticket's notes containing: the `dapjs`
      version in use, the specific `node-hid` behavior/errors observed,
      the macOS HID permission state (System Settings > Privacy &
      Security), and the exact error(s) `flashOverSwd` returned. State
      explicitly: "MSD is provisionally the primary flash path pending
      further investigation." **This is an acceptable, complete ticket
      outcome — not a failure requiring further attempts.** **Left
      unchecked deliberately — the literal trigger condition did not
      occur.** Attach/erase/write *did* succeed (see above); the actual
      stopping point was a different, more specific finding the
      time-box's spirit still covers — see Bench Findings. The
      team-lead directed stopping further SWD debugging once this was
      confirmed independently twice, which was followed. "MSD is
      provisionally the primary flash path" would **misstate** this
      outcome — SWD writing itself works — so that sentence is
      deliberately not asserted; see Bench Findings' conclusion instead.
- [x] Any real bug the hardware sequence exposes in `flashOverSwd` /
      `swdName.ts` is fixed in place *and* covered by a new or updated unit
      test using the existing injected `DapLinkFactory` / `CortexMFactory`
      seams — a hardware-motivated fix without a regression test is
      incomplete. (If no bug is found, this criterion doesn't apply.)
      **PASS — two real bugs found and fixed**, both only reachable
      against real hardware/real `dapjs`. See Bench Findings for detail;
      note one of the two lives in `deviceRegistry.ts`, not the two files
      this ticket's plan named, because it directly blocked verifying the
      criteria above and was discovered by this same hardware sequence —
      called out explicitly as a scope deviation from the plan.
- [x] `npm test -- packages/host` and `npm run build` pass after any code
      changes made in response to what the bench session found. **PASS**
      — `npm test -- packages/host`: 199 passed (9 files). `npm run
      build`: clean across `host`, `protocol`, `ui`.

## Bench Findings

**Bench setup:** one board present at session start — DAPLink serial
`99063602000528202e78ea8f7143163f000000006e052820`, SWD name `vevav`,
port `/dev/cu.usbmodem2121302`, MSD volume `/Volumes/MICROBIT` — this
is the board sprint 001 found silent (`role: null`, no reply to
`HELLO`) and the one flashed here. A second board (`zapig`,
`.../2121102`, `/Volumes/MICROBIT 1`) was attached mid-session by the
stakeholder for ticket 006; it was never flashed or written to, only
passively enumerated by the registry's normal (read-only, no-halt)
name resolution. `dapjs@2.3.0`, `node-hid@3.4.0` (from `npm ls`).
macOS HID permission state was not checked via System Settings
directly, but no permission-classified error was ever returned by
`node-hid`/`dapjs` across ~6 attach/enumerate/flash attempts this
session — enumeration, HID open, and SWD attach all succeeded every
time, so permissions are evidently not the limiting factor here.

**What was driven, and how:** `deviceRegistry.requestFlash(deviceId,
"relay")` via the real `startServer()` Express/`ws` server and a plain
WebSocket client sending exactly the `wsMessages.ts`-shaped
`flash-start`/`open`/`line` messages the Devices/Console tabs send —
no injected fakes anywhere in the path (real `DeviceRegistry`, real
`flash.ts`, real `dapjs`/`node-hid`). This is the same server process
`npx robot-console` starts, driven the same way the UI would drive it.

**1. The SWD write itself: SUCCESS, verbatim.** Final result:

```json
{
  "type": "flash-result",
  "deviceId": "99063602000528202e78ea8f7143163f000000006e052820",
  "firmware": "relay",
  "status": "ok"
}
```

Real phase timing observed (ms since flash-start): `fetching` 3067,
`verifying` 3376, `erasing` 3762, `writing` from 3766 through 40497
(11,575 `DAPLink.EVENT_PROGRESS` events — one per page of the 717,576
-byte hex over CMSIS-DAP HID), `resetting` 40563. Total wall-clock
~40.6s. This is sane for a large hex written page-by-page over HID —
far slower than sprint 2's synthetic `DapLinkFactory` timeline, as
expected of real hardware, but internally consistent (monotonic,
erase-then-many-writes-then-one-reset) with no gaps or stalls.

**2. The board still does not announce afterward.** Immediately after
the `ok` result, and again ~20s later, and again in a completely
independent fresh `startServer()`/WebSocket session started by the
team-lead ~a minute after this session's flash (a 40-second observation
window with nothing else touching the board): `role` stayed `null` and
the device carried `linkError: "timed out after 3000ms waiting for a
HELLO banner reply from /dev/cu.usbmodem2121302"`. Three independent
observations, same result. This is the single most important finding
of this ticket: **the write succeeded, but the flashed firmware does
not come up and answer `HELLO` afterward.** That is a materially
different (and more specific) problem than "SWD doesn't work" — the
flash path itself (attach, erase, write, reset) is now verified
end-to-end against real hardware for the first time, closing that part
of sprint 2's gap. What remains broken/unverified is what happens on
the target *after* `DAPLink#flash()`'s embedded reset: either the hex
itself, or that reset not being sufficient to bring the flashed
firmware up cleanly (e.g. it needs a full power-cycle, or it boots into
a state that never emits or listens for `HELLO`). This is a hypothesis
for a follow-up ticket, not tested further here per the time-box.

**3. Two real bugs were found and fixed, both undetectable without
real hardware/`dapjs`:**

- **`flashOverSwd`'s cleanup called a method that doesn't exist at
  runtime** (`packages/host/src/flash.ts`). `dapjs`'s `DAPLink` type
  declares it extends Node's `events.EventEmitter` (which has `.off`),
  but the actual bundled UMD runtime object only implements
  `on`/`removeListener`/`emit` — verified directly:
  `'off' in DapJs.DAPLink.prototype` is `false`,
  `'removeListener' in DapJs.DAPLink.prototype` is `true`. Calling
  `daplink.off(...)` in the `finally` block threw
  `"daplink.off is not a function"`, and a throw from `finally`
  replaces whatever the `try` block already returned — so the first
  bench attempt's *genuinely successful* SWD write came back as an
  uncaught rejection (`flash-result` `status: "error"`,
  `message: "daplink.off is not a function"`), which in turn meant
  `deviceRegistry.ts#runFlash` never reached its post-flash
  `openLink()` call at all. Fixed: use `removeListener` instead, each
  cleanup step wrapped in its own try/catch so neither can mask the
  already-determined result. The existing test fake
  (`createFakeDapLink` in `flash.test.ts`) had its own working `.off`
  implementation, which is exactly why no unit test had caught this —
  it modeled the type declaration, not the real runtime shape. It now
  models `removeListener` only (no `.off`), and two new tests assert a
  successful flash still resolves `{ status: "ok" }` against that
  real-shaped fake, including when `removeListener` itself throws.
- **`deviceRegistry.ts#openLink` leaked the OS-level serial port handle
  on a failed open.** `UsbSerialLink.open()` rejects (banner-reply
  timeout) only *after* its underlying `SerialPort` is already open at
  the OS level. `openLink`'s failure branch recorded `linkError` but
  never called `link.close()` on the link it had just created — so
  that OS-level handle stayed open for the rest of the process's
  lifetime. Verified directly on the bench: after the very first
  silent-board open attempt at server startup (before any flash), that
  leaked handle caused every later open attempt on the same port —
  including a second bench run's *post-flash* reopen — to fail with
  `"Error Resource temporarily unavailable Cannot lock port"`, even
  though nothing else was touching the device (confirmed via `lsof` and
  `ps`; the only holder was this project's own earlier, still-running
  process). Fixed: `openLink`'s catch branch now closes the link
  (best-effort, cannot mask the recorded `linkError`) before returning.
  A new `deviceRegistry.test.ts` test asserts the injected fake link's
  `close()` is called exactly once after a failed open. **Scope note:**
  this file is not one of the two the ticket's Implementation Plan
  named (`flash.ts`/`swdName.ts`); it was fixed anyway because it was a
  real bug this exact hardware sequence exposed and it was actively
  preventing the role/console criteria above from being verifiable at
  all (every retry failed on the leak, not on board behavior) — flagged
  here rather than silently expanding scope.

Both fixes are why the *third* bench attempt (after both fixes) shows a
clean `flash-result: "ok"` with no lock or cleanup error — the
remaining `role: null` / no-announce result in that same attempt, and
in the team-lead's independent check afterward, is the real,
hardware-level finding in point 2 above, not an artifact of either
fixed bug.

**Conclusion:** SWD attach/erase/write/reset is confirmed working
against real hardware — sprint 2's flash path is no longer unverified.
The board still does not announce afterward, so sprint 001's
"announcing board" and console-reply gaps remain open, now with a much
more specific, actionable finding than "no announcing board was
available": *flash succeeds, banner doesn't follow.* Recommended
follow-up: investigate whether `DAPLink#flash()`'s embedded reset is
sufficient for this firmware/board combination (a manual power-cycle
after flashing, tried by hand outside this ticket's harness, would
quickly distinguish a reset-timing issue from a hex/firmware issue) —
left as a hypothesis, not tested further here per the time-box.

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
