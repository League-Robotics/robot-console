---
status: pending
---

# Pair a joystick to a robot at flash time

## Stakeholder request (2026-09-25)

Flashing a joystick today writes the stock release hex, which is paired
to nobody. The stakeholder: "when you plug in a robot and you get the
option to flash it, you need to specify what name it is. What name are
you flashing the Joystick for? ... right below the name of the
Joystick, [the card] needs to indicate which robot the Joystick is
going to connect to."

## Firmware contract (from the Joystick firmware session, pxt-joystick-250)

- **Pairing is baked into the hex. The firmware has no serial "set" command.**
  - The firmware carries one literal, `@@ROBOT_NAME=-----@@`, stored verbatim in flash.
  - To pair: flatten the data-record payloads (record types `0x00` and `0x0D`), find `@@ROBOT_NAME=` + 5 bytes + `@@`, overwrite the 5 bytes with the robot name, then fix the checksum of each touched record.
  - The patch keeps the same length and CRLF endings, and moves no addresses. An already-paired hex can be re-paired.
  - `-----` means unpaired: the joystick shows `?` and never transmits.
- **Reference implementation:** `tools/pair-hex.mjs` in the joystick repo. It is dependency-free ESM.
  - Exports: `patchHexName(hexText, name)`, `readHexName(hexText)` (returns the name, `"-----"`, or `null` when there is no slot), `isValidName(name)` and `radioAddress(name)`.
  - Port it into the host; do not add a cross-repo dependency. There is also a C++ twin, `tools/pair_hex.cpp`.
  - Full hand-off: `docs/robot-console-integration.md` in that repo.
- **The key is the robot NAME only.** The joystick derives channel and group itself with the same math as `nameToRadioAddress`: channel = 11 + n%73, group = 15 + n%241.
  - Test vectors: getez 72/68, vutev 22/33, tovez 48/29.
  - A robot with a registry or override radio address will NOT hear the joystick. A second slot, `@@ROBOT_ADDR=ccc:ggg@@`, has been proposed but not built; that is the stakeholder's call.
- **Reading the pairing back:** send `?\n` over serial. The joystick answers with one line:
  `# joystick robot=getez paired=1 channel=72 group=68 ...`
  - The banner (`DEVICE:JOYSTICK:joystick:<own name>:<serial>`) does NOT carry the target robot. Adding it would be a small firmware change if we'd rather have it there.
- Pairing survives power cycles. Only a reflash changes it.

## Console-side work

1. **Flash dialog (joystick firmware only):** add a required "Which robot is this joystick for?" picker.
   - Choices: known robot devices, by name. Free-text entry is also allowed, validated with `isValidName`.
   - For a robot whose radio `source` is not `"derived"`, block the choice or warn that the joystick won't reach it.
2. **Wire:** extend `flash-start`'s release source with an optional `pairRobot` name for `firmware: "joystick"`. Add the same to the MCP `flash` tool.
3. **Host flash path:**
   - Fetch the release hex and verify its sha256 against the UNPAIRED file.
   - Then run `readHexName`. If it returns `null`, abort: the hex has no slot, and flashing it would leave an unpairable joystick.
   - Then run `patchHexName` and flash the patched hex.
   - The patched sha256 intentionally differs from the manifest.
4. **Reading the target:** on identify of a `kind: "joystick"` device, send `?` and parse `robot=`/`paired=`.
   - Persist it on the device.
   - Expose it on `SnapshotDevice`, e.g. `pairedRobot: string | null`.
5. **Display:** the front-page joystick card and `JoystickPage` show "→ drives <robot>" (or "Not paired") directly under the joystick's name.

## Risks / checks

- **Asset name:** the firmware session assumes `MICROBIT.hex`. We currently download `remote-joystick-student.hex` (`releases.ts`). Verify the downloaded asset actually contains the slot; step 3's `null` check guards this.
- **Erase failure:** after this firmware is flashed, the next *pyocd* flash fails with erase error `0x67` unless `pyocd erase --mass` runs first. We flash through DAPLink (`flash.ts`), not pyocd. Verify on hardware whether re-flashing a joystick hits this.
