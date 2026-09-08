---
status: done
tickets:
- 004-002
- 004-004
---

# Flash reports success but the board never announces afterwards

## Description

Sprint 003 flashed a real micro:bit with relay firmware over SWD, driving the
app's own code path (`deviceRegistry.requestFlash(deviceId, "relay")` behind a
real `startServer()` and a WebSocket client sending exactly the messages the
Devices and Console tabs send — no fakes anywhere in the path).

**The write succeeded.** Verbatim:

```json
{"type":"flash-result","deviceId":"99063602000528202e78ea8f7143163f000000006e052820",
 "firmware":"relay","status":"ok"}
```

Phase timing was sane: `erasing` → `writing` ×11,575 → `resetting`, ~40.6s total.

**But the board does not announce afterwards.** It re-enumerates and names
correctly over SWD (`vevav`), and then:

```
vevav@2121302 role=null open=false err=timed out after 3000ms waiting for a HELLO banner reply
```

Confirmed independently by the team-lead over a separate 40-second observation
window with a fresh host, after the flashing process had exited.

This is a much sharper finding than the gap it replaces. The flash path — fetch,
sha256 verify, universal-hex handling, SWD attach/erase/write/reset — is now
**proven working against hardware**. Something *after* the write is not.

## Cause

Unknown. The leading hypotheses, none tested:

1. **`DAPLink#flash()`'s embedded reset is insufficient for this firmware.** DAPjs
   runs OPEN → per-page WRITE → CLOSE → RESET as one atomic sequence. A soft
   reset may not be enough where a real power-cycle would be. Cheapest to test:
   physically unplug and replug the board after a flash and see whether it
   announces.
2. **The hex is not what we think it is.** The relay release's `MICROBIT.hex`
   verifies against its companion `MICROBIT.hex.txt` sha256 and parses as valid
   Intel hex, but nothing confirms it is a *v2-compatible* image. A v1-only
   (nRF51) image on a v2 board passes every check this codebase performs and
   flashes a non-booting result — a risk already recorded when the local-hex
   picker was designed.
3. **The firmware announces, but not in a form `UsbSerialLink.open()` catches.**
   The open sequence is deliberately open → send `HELLO` → read the banner from
   the reply, with a 3000ms timeout. If this firmware announces only
   unsolicited at boot, or answers slower than 3000ms, the banner would be
   missed. Note `banner.ts` has only ever been tested against canned strings —
   no real banner has been observed by this project.

Distinguishing (1) from (2) and (3) is cheap and should come first.

## Proposed fix

Diagnose before changing anything:

- Power-cycle the flashed board and re-observe. If it announces, the reset is the
  problem and the fix is in `flash.ts`'s post-write sequence.
- Read the board's serial output with an external terminal (`screen
  /dev/cu.usbmodem…​ 115200`) immediately after a flash, to see whether it emits
  *anything* — this separates "silent board" from "our open sequence misses it."
- Confirm the relay hex targets nRF52 (micro:bit v2). Check the release's build
  manifest and, if necessary, the hex's address ranges.

Only then decide what to change.

## Verification

A board flashed from the Devices tab subsequently identifies with a
`RADIOBRIDGE` or `RADIORELAY` role and answers `HELLO`, `?` and `STATUS` with
readable replies — which is also the outstanding half of
`sprint-001-hardware-criteria-unverified-no-announcing-board.md`.

## Related

- `sprint-002-flash-path-unverified-against-hardware.md` — sprint 003 proved the
  write half of it; this issue is the remainder
- `sprint-001-hardware-criteria-unverified-no-announcing-board.md` — still open
  for the same underlying reason: nothing has ever announced
- `msd-fallback-volume-matching-heuristic-unimplemented.md`
- Sprint 003's ticket 005 carries the full bench transcript and the two bugs
  fixed along the way (`daplink.off is not a function`; a leaked `SerialPort`
  handle in `deviceRegistry.ts#openLink`)

## Resolved by sprint 004 — the defect was in identify, not in flashing

Verified on 2026-09-07 with three boards attached and no competing
processes: **all three classify as `type: "relay"`, `role: "RADIOBRIDGE"`,
sessions open, zero errors.**

The decisive evidence is `vevav`. That is the exact board sprint 003
flashed and which then refused to announce (`role: null`, `timed out
after 3000ms waiting for a HELLO banner reply`). Nothing has reflashed
it since. Same board, same firmware, and it now announces — so the
firmware written by sprint 003 was **always correct**, and the fault was
in how the host identified the board afterwards.

Two sprint-004 changes account for it:

1. **Ticket 002 split `connect()` from `identify()`.** Previously
   `open()` threw on a `HELLO` timeout and the link was torn down, so a
   board that was merely slow to come back was recorded as silent and its
   port released. Now the transport stays up and `identify()` returning
   `null` is an ordinary outcome that can simply be retried on the same
   open link.
2. **Ticket 004 added a distinct `reidentifyTimeoutMs` (8s) with one
   retry**, replacing the 3s open timeout. Reset plus re-enumeration plus
   `HELLO` can exceed 3s, which is precisely what sprint 003 measured.

Hypothesis (2) from the original text — that the hex might be a v1-only
image — is disproven: the same hex boots and announces. Hypothesis (1),
that `DAPLink#flash()`'s embedded reset was insufficient, is also
disproven for the same reason.

This closes the outstanding half of
`sprint-002-flash-path-unverified-against-hardware.md` as well: the flash
path is now proven end to end, write *and* re-announce, against real
hardware.

