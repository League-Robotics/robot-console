---
status: in-progress
sprint: '003'
tickets:
- 003-005
---

# Sprint 001 hardware criteria unverified: no announcing board available

## Description

Two of sprint 001's five success criteria could not be verified, because
the only micro:bit available during execution is **silent** — it returns
zero bytes to `HELLO` and `?`, confirmed three independent ways.

Unverified:
- "A relay and a robot, connected over USB, both show their correct
  five-letter name **and correct role**." Names verified; **role is
  unverified**, since `role` is parsed from a boot banner no available
  board emits.
- "Typing `HELLO`, `?`, and `STATUS` into the Console tab's send box
  returns a sane, readable reply for each." No board replied to anything.

Verified instead, and arguably the stronger result: a board that emits
nothing on serial is still correctly named `zeguz` from its chip id over
SWD (`DEVICEID[1] = 0xfbfd96c9`), cross-checked against the published
worked-example table in the relay protocol spec (n=425, ch 25, grp 19).
That satisfies the blank-board criterion in substance.

## Cause

Not a code defect. `banner.ts` parses both dialects and is unit-tested
against canned strings from the specs; `UsbSerialLink` is tested against
an injected fake port. What is missing is real firmware that talks back.

## Proposed fix

Repeat the smoke test with (a) a relay running `RADIOBRIDGE` firmware,
which announces in the colon dialect, and (b) a robot running
pxt-nezha-diffdrive, which announces in the space dialect. Confirm role
renders for each and that `HELLO`/`?`/`STATUS` return readable replies.

This is also the natural moment to check the `RADIORELAY` legacy path,
whose hex serial encoding differs from `RADIOBRIDGE`'s decimal.

## Verification

Both dialects produce a correct role in the Devices tab, and the three
console commands return replies, against real hardware.
