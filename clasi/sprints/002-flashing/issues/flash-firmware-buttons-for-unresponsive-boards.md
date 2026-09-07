---
status: in-progress
sprint: '002'
tickets:
- 002-001
- 002-002
- 002-003
- 002-004
- 002-005
- 002-006
- 002-007
---

# Flash-firmware buttons for a board that fails to identify

## Description

When a connect attempt to a micro:bit gets no `HELLO` reply, the board is
running no firmware the console can recognize. Today the Devices tab
reports this as a `linkError` and stops — the student is told something
is wrong but given no way to fix it.

Add two buttons on the right side of a device's row in the Devices tab.
They appear **only** after a connect attempt has been made and failed to
produce a banner — not on an unprobed device, and not on one that
identified successfully.

1. **Flash relay firmware** — install RADIORELAY from
   `https://github.com/League-Robotics/microbit-radio-relay`.
2. **Flash robot firmware** — install the robot firmware from
   `https://github.com/League-Robotics/pxt-nezha-diffdrive`.

Both firmware sources are **configurable via `dotconfig`**, in the `prod`
deployment layer, one variable per firmware. Each value carries the
repository URL and the release tag separated by a colon, with the tag
defaulting to `latest`:

    <repo-url>:<tag>

e.g. `https://github.com/League-Robotics/microbit-radio-relay:latest`.
The stakeholder set this shape explicitly so a class can be pinned to a
known-good build rather than tracking whatever was released last.

## Cause

Not a defect — unimplemented capability. `specification.md` reserves
§4.5 `flash.ts` (DAPjs over `node-hid`, universal-hex v2 extraction with
`BLOCK_ID_V2 = 0x9903`, MSD volume copy as fallback) and §4.6
`releases.ts` (server-side fetch of `MICROBIT.hex` plus the companion
`MICROBIT.hex.txt` manifest, verified against the manifest's sha256).
Neither module exists yet; this is the roadmap's Sprint 2 — Flashing.

The UI half has no wiring either: `DeviceListEntry` (`wsMessages.ts`)
carries `linkError` and a null `role`, which together identify the
failed-identify state, but there are no flash commands or progress
messages in the WebSocket contract.

## Constraints and known gaps

- **The robot firmware repo publishes no GitHub releases.** Verified
  against the API: `League-Robotics/pxt-nezha-diffdrive` has zero
  releases, so there is no `MICROBIT.hex` asset to fetch. The relay repo
  does — `v0.20260831.1` carries `MICROBIT.hex` (717576 bytes) and
  `MICROBIT.hex.txt`. The robot button must therefore ship in a clearly
  disabled state, explaining that no release is published, rather than
  failing at click time with a 404. The configurable tag is what will let
  it start working the moment a release is cut, with no code change.
- **GitHub release assets send no `access-control-allow-origin`**
  (`specification.md` §2.1, verified). The fetch must stay server-side in
  the host; the browser cannot do it.
- `config/` already exists at the repo root as an **untracked, empty
  `dotconfig init` scaffold** (`config/dotconfig.yaml`, `config/sops.yaml`,
  `config/{dev,prod,local/eric}/public.env`), matching the layout used in
  `radio-robot-lib` and `pxt-nezha-diffdrive`. The same init also added an
  `.env.*` rule to `.gitignore`. This work populates and commits that
  scaffold rather than creating it.
- Flashing writes firmware to hardware over SWD. There is currently no
  board available that runs cooperating firmware (see
  `sprint-001-hardware-criteria-unverified-no-announcing-board.md`), so
  acceptance will again split into what unit tests can prove and what
  needs a physical board.

## Verification

- A micro:bit that fails to identify shows exactly two flash buttons; one
  that identifies successfully, or has not been probed, shows none.
- Clicking **Flash relay firmware** fetches the hex named by the
  configured `<repo-url>:<tag>`, verifies it against the manifest sha256,
  flashes it with visible progress, and the board then identifies with a
  `RADIOBRIDGE`/`RADIORELAY` role.
- Changing the configured tag from `latest` to a pinned release changes
  which build is fetched, with no code change.
- **Flash robot firmware** is present but disabled, and says why.
