---
status: in-progress
sprint: 029
tickets:
- 029-004
- 029-005
---

# Verify the path for moving a robot to a new radio channel and group

## Stakeholder request (2026-10-23)

"Make sure that we've got a good path for changing the radio and group
of the robot. It looks like we do. That already exists, but we need to
make sure that that all functions."

## Why

The radio-loss diagnosis on gopiv (see
`connect-a-radio-bridge-to-a-raw-channel-and-group.md`) wants robots
moved off Wi-Fi-overlapping channels, e.g. to channel 76 (2476 MHz).
That needs a working end-to-end way to put a robot on a chosen
channel/group and have the console follow it.

## The path that exists today

The robot firmware has no wire verb to change its own address; the
channel and group are fixed at build time by
`diffDrive.setupRadio(channel, group)` in the program's `on start`
(pxt-nezha-diffdrive `Protocol::setupRadio`). The console side:

1. Robot page → Calibration tab → "Wi-Fi and radio" panel
   (`NetworkSettingsPanel.tsx`), or the header's "Set Radio" dialog
   (`RadioAddressDialog.tsx`), sends `set-radio-override`; the host
   validates (`radioOverride.ts`) and stores it on the device row
   (`store.setRadioOverride`).
2. "Code for your program" (`lib/programCode.ts`) emits
   `diffDrive.setupRadio(<channel>, <group>)` from the device's resolved
   radio address.
3. The student pastes that into MakeCode and flashes.
4. Bridged connections resolve the address override → registry →
   derived (`resolveDeviceRadio`), so the next bridge to that robot
   uses the new channel/group.

## What to do

Walk the path end to end on a real robot (gopiv via guvov on ferranti
is the motivating case) and fix whatever breaks:

- Setting the override in either UI persists and shows in the snapshot
  (`SnapshotDevice.radio`, source `override`); both UIs agree.
- The generated code block reflects the override immediately.
- After flashing that code, a named bridge to the robot connects on the
  new channel/group, and the raw channel/group bridge from the sibling
  issue reaches it too.
- Clearing/reverting an override returns to the derived address (check
  whether a clear path exists at all; add one if not).
- Note that `RadioAddressDialog.tsx`'s doc comment says no caller
  passes a real `radio`/`deviceId` yet; confirm whether that's still
  true and whether the header dialog works.
- Firmware note: changing the group mid-run is unverified
  (pxt-nezha-diffdrive `clasi/issues/low/changing-the-radio-group-mid-run-is-unverified.md`);
  the supported path is `on start` only, which is what the generated
  code does.
