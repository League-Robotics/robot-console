---
status: in-progress
sprint: 008
tickets:
- 007-001
- 007-002
- 007-003
- 007-004
- 008-001
- 008-002
- 008-003
- 008-004
- 008-005
- 008-006
- 008-007
---

# robot-console — architecture and roadmap

## Description

Build `robot-console`: a GUI for managing micro:bit robots built on the
Elecfreaks Nezha differential-drive board. One page where a student plugs
in micro:bits, sees their five-letter names, installs relay or calibration
firmware on them, drives the robot over USB or radio, watches telemetry as
charts and a path trace, and runs guided calibration routines that end in a
block of MakeCode they paste into their own program.

Two devices are typically registered at once and referenced by name: the
user's RADIORELAY and the user's robot.

### Shape

**Node host + browser UI.** `npx robot-console` starts a localhost server
and opens the browser. Not a pure static site, not Electron. npm workspaces
monorepo, TypeScript throughout, `vitest` for tests.

```
packages/protocol/   pure TS, zero I/O
packages/host/       Node: USB, SWD, mDNS, TCP, UDP, hex fetch
packages/ui/         Vite + React, talks to host over one WebSocket
```

UI tabs: **Devices** (list, names, roles, flash buttons) · **Console** (raw
line stream, send box, `#`/`DBG:`/`err` colorized) · **Telemetry**
(wheel-speed bars, time-series charts) · **Trace** (path, clearable) ·
**Calibrate** (wizards).

### `packages/protocol` — no I/O, fully unit-testable

- **`naming.ts`** — CODAL friendly name. Five base-5 digits over codebook
  `("zvgpt","uoiea","zvgpt","uoiea","zvgpt")`; digit *i* from the least
  significant lands at position `4-i`. Port of
  `mbdeploy/src/mbdeploy/devices.py:205-218`.
- **`radioAddress.ts`** — name → `(channel, group)`: `n = base5(name)`
  (name[0] **most** significant), `channel = 25 + 2*(n%25)`,
  `group = 1 + n/25`, bumped past 10. Port of
  `microbit-radio-relay/server/src/mbrelay/naming.py`.
- **`banner.ts`** — parse **both** dialects, because both are live:
  - `DEVICE:RADIOBRIDGE:relay:getez:1779042496` (relays; serial in **hex**
    for legacy `RADIORELAY`, **decimal** for `RADIOBRIDGE`)
  - `device NEZHA2 robot vevov 1198504156` (what robots emit today)

  `microbit-console`'s parser handles only the colon form and would fail to
  identify a robot — do not copy it.
- **`v6/codec.ts`** — line grammar `verb field* '#'id '\n'`, max **240
  bytes**, base-10 ASCII ints, `flags` lowercase hex with no `0x`. **Case is
  direction**: commands UPPERCASE, replies lowercase; a lowercase inbound
  verb that is not a known reply is another robot overheard on a shared
  channel — drop it silently.
- **`v6/session.ts`** — reliability layer mirroring the firmware's
  `expectedNext_`:
  - `ack N` → `seq = N`; `nack N` → `seq = N-1` (nack carries
    *next-expected*, not last-good — confusing these was a real logged bug)
  - a retransmit **must reuse its original id**; a fresh id reads as a gap
    and stalls the stream
  - only 11 verbs take an id: `GET SET TLM STOP RUN WHEELS_X WHEELS_V
    MOVE_X MOVE_V GO_TO_R GO_TO_W`
  - `HELLO` resets the sequence to 1 — **never use it as a health check** on
    a live session; use `PING` or `STATUS`
- **`v6/telemetry.ts`** — zip `thdr` against `t` positionally. Schemaless by
  design, so one decoder handles the robot's 12-column POSE and 20-column
  FULL *and* radio-robot-lib's 7/11 variants with no branching. `TLM HDR` is
  the recovery path for a missed header (not `TLM NOW`). Unit traps:
  `ox`/`oy` are already mm but `oh` is **centidegrees, do not divide**;
  `rotation`/`omega` are **milliradians** on the wire.
- **`relay/commands.ts`** — relay command plane: `!CG <ch> <grp>`,
  `!MODE RAW250`, `!P 7`, `!ECHO OFF`, `!GO`, `?`, `HELLO`. `#` lines are
  comments; a `< ` prefix on received lines is **stripped unconditionally**
  (nothing the robot says starts with `< `).

### `packages/host` — the privileged half

- **`devices.ts`** — enumerate and join. `serialport` filtered to DAPLink
  `VID 0x0D28 / PID 0x0204`, keyed on `serial_number`; `node-hid` for the
  CMSIS-DAP interface. Same join key across all fleet tooling.
- **`swdName.ts`** — see Cause below. Read `FICR.DEVICEID[1] @ 0x10000064`
  with `dapjs` (`readMem32`) in attach mode — no halt, no reset, no
  cooperating firmware — then hash it with `naming.ts`.
- **`link/`** — every transport reduces to *a stream of newline-delimited v6
  lines*, so the session layer sits on all of them unchanged. This mirrors
  mbrelay's own stated design target ("a drop-in replacement for opening the
  serial port directly"):
  - `UsbSerialLink` — robot on local USB, 115200
  - `RelayRadioLink` — local USB relay: `!ECHO OFF`, `!MODE RAW250`,
    `!CG <ch> <grp>`, `!P 7`, then `!GO`
  - `MbrelayLink` — TCP to `_mbrelay._tcp` :8760, identical grammar, **set
    `TCP_NODELAY`**
  - `MbserialLink` — TCP to `_mbserial._tcp` (mbdeploy `serve`)
  - `WifiUdpLink` — UDP to robot :7654, bound locally to :7655
- **`mdns.ts`** — browse `_mbrelay._tcp`, `_mbserial._tcp`, `_mbflash._tcp`,
  and the robot's own `_robotlink._udp`.
- **`flash.ts`** — DAPjs over `node-hid`, with universal-hex v2 extraction
  (`BLOCK_ID_V2 = 0x9903`) ported from
  `microbit-console/client/src/lib/universal-hex.ts`. MSD volume copy as
  fallback (`radio_relay/scripts/flash-local.js` is the template).
- **`releases.ts`** — fetch relay hex server-side from
  `.../releases/download/v<TAG>/MICROBIT.hex`, plus the companion
  `MICROBIT.hex.txt` build manifest (commit / built / sha256) so the UI can
  show which build is installed and verify the download.
- **`server.ts`** — Express + `ws`. One WebSocket carries device-list
  updates, line traffic, and telemetry frames.

## Cause

Two facts drive the whole design and are easy to get wrong.

**1. The five-letter name is not derivable from the USB serial number.**
The name is a hash of the *target nRF chip's* `FICR.DEVICEID[1]` at
`0x10000064`. The USB serial number a host sees is the *KL27 interface
chip's* UID — a different chip on the same board. `mbdeploy` bridges the two
by attaching over SWD and reading that register; `microbit-console` does not
and falls back to a serial substring, so it cannot name a board whose
firmware does not announce. Reading over SWD also means a blank,
never-flashed micro:bit still shows its real name.

**2. A static browser app cannot reach the existing fleet services.**
Investigated and ruled out on hard evidence:

| Need | Browser-only verdict |
| --- | --- |
| mbrelay relay pool | Raw TCP on :8760 — a browser cannot open a TCP socket |
| mbrelay name registry | HTTP on :8761, but `httpapi.py` sends **no CORS headers** (hand-rolled 5-route server) |
| mbdeploy remote boards | `_mbserial._tcp` / `_mbflash._tcp` — raw TCP again |
| Discovery | mDNS/UDP multicast — unreachable from a page |
| Robot WiFi link | UDP :7654 — unreachable from a page |
| Relay firmware download | GitHub **release assets send no `access-control-allow-origin`** (verified, including the 302 target); `api.github.com` and `raw.githubusercontent.com` do |

A browser page could only ever drive a board plugged into that same machine.
The Node host gets all six.

Separately, the fleet's existing tools (`mbdeploy`, `mbrelay`,
`pxt-nezha-diffdrive`, `radio-robot-lib`) are all command-line, so a student
wanting to flash a relay, name a robot, drive it, and calibrate its wheel
diameter has no GUI at all today.

## Proposed fix

Six sprints. Sprint 1 is the foundation and should be detail-planned first.

### Sprint 1 — Connect, identify, console

- Monorepo skeleton; TS config; vitest; `npx`-able entry point.
- `protocol`: `naming.ts`, `radioAddress.ts` (**with the 3125-name sha256
  conformance test**), `banner.ts`, `v6/codec.ts`, `v6/session.ts`.
- `host`: `devices.ts`, `swdName.ts`, `UsbSerialLink`, `server.ts`.
- `ui`: device list showing five-letter name + role + port + UID; a working
  serial console with a send box.

### Sprint 2 — Flashing
Relay hex from GitHub Releases (host-side fetch + sha256 verify), DAPjs
flash with progress, universal-hex v2 extraction, MSD fallback.
Calibration-firmware hex is **TBD — the stakeholder has not supplied it.**

### Sprint 3 — Radio + control
`RelayRadioLink`, `MbrelayLink`, mDNS discovery. Robot control: drive, stop,
estop, `STATUS`, `GET`/`SET`. Sequence/ack state visible in the UI.

### Sprint 4 — Telemetry
`thdr`/`t` decoder, wheel-speed bars, time-series charts, path trace with
clear. 20 Hz from the robot; the header auto-refreshes every 20 frames so a
late listener recovers.

### Sprint 5 — Calibration wizards
Distance (robot inches up to a first black line, sets a counter, drives to a
second line 90 cm away; report how far it thought it drove) and rotation
(beam pointer on the front, robot attempts 360°, on-screen nudge buttons
walk it in until the wheelbase is dialled in). Both drive `RUN:` programs
and end by emitting a MakeCode snippet the student pastes into their own
program.

### Sprint 6 — WiFi
Discover `_robotlink._udp` (instance `<name> robot link`, host
`<name>.local`, port 7654, TXT `name= role=robot link=v6-udp port=`) and
auto-switch a named robot from radio to WiFi when it appears.

### Blocked on firmware — file as separate issues in `pxt-nezha-diffdrive`

The console feature-detects these and ships without them.

1. **List runnable programs.** `runNames[]` is a private module-level array
   at `src/blocks/run.ts:35` with no getter, no `//% shim=`, and no wire
   verb. `HELP` lists *protocol verbs* from `kCommandTable`, not run names.
   Cleanest fix is ~10 lines: export a `runNames` accessor + shim, or add a
   `RUN:list` handler that `emitLine()`s the names.
2. **Settable role in the banner.** Hard-coded as a bare format-string
   literal at `src/comms/wire_handler.cpp:1368-1375`
   (`"device NEZHA2 robot %s %s\n"`) — not a constant, not in `Identity`,
   not injectable. The console needs a distinct role for the calibration
   build so it can pick the right UI.
3. **Banner format convergence** (space vs colon). Already filed in
   `radio-robot-lib` as
   `hello-banner-emit-the-specified-colon-announcement-format.md`, status
   pending. Link, do not duplicate.
4. **The v6 `RUN` verb is a stub.** `wire_adapter.cpp:920-929` returns
   `kUnknown` for every name, so the working path is the cleartext
   `RUN:name:arg` form with **no sequence id**. Resolve whether that is
   permanent, since the calibration UI depends on it.

### Blocked on firmware — WiFi credentials have no runtime provisioning path

The stakeholder asked to program WiFi devices with network credentials.
Today `kWifiSsid` / `kWifiPassword` (`src/comms/protocol.cpp:76-86`) are
`constexpr` empty strings rewritten **in a deploy-time scratch copy** by
`tools/make_deploy.py::_inject_wifi_secrets()` from a gitignored
`config/wifi_secrets.json`. There is no `SET` field and no runtime path.
Patching a compiled hex is fragile and not worth doing. This needs its own
firmware issue (persist SSID/password via `SET` + `uBit.storage`) before
anything can provision a robot. **Sprint 6 as scoped only discovers and uses
an already-provisioned robot.**

## Verification

- `npm test` — protocol unit tests.
- **Strongest single gate:** test `radioAddress.ts` against
  `pxt-nezha-diffdrive/docs/radio-address-vectors.json`, asserting the full
  3125-name space against its published sha256. That file is an existing
  three-repo contract, so this is free correctness. It also catches the
  documented endianness trap — `zuzuv` is n=1, a reversed encoder says
  `vuzuz` and would pass a sampled table.
- Golden wire vectors: `radio-robot-lib/tests/protocol/golden_vectors.txt`.
- Hardware smoke test each sprint with a real relay and a real robot.
- **Sprint 1 done when:** a relay and a robot both show correct five-letter
  names and correct roles; `HELLO` / `?` / `STATUS` typed into the console
  return sane replies; and a blank micro:bit still shows its name, proving
  `swdName.ts` works.

## Related

Reference implementations to check behaviour against, not to port blindly:
`radio-robot-lib/src/host/robot_v6/{codec,transport,reliability}.py` and
`pxt-nezha-diffdrive/tools/link.py`.

Source repositories:
- `/Volumes/Proj/proj/RobotProjects/pxt-nezha-diffdrive` — robot firmware
- `/Volumes/Proj/proj/RobotProjects/radio-robot-lib` — v6 protocol spec
  (`docs/design/protocol.md`, 2393 lines, canonical)
- `/Volumes/Proj/proj/RobotProjects/microbit-radio-relay` — relay firmware +
  `mbrelay` server; `docs/radio-relay-protocol.md`, `docs/announce.md`,
  `docs/relay-server.md`
- `/Volumes/Proj/proj/RobotProjects/mbdeploy` — flashing, SWD naming, mDNS
  remote client
- `/Users/eric/proj/league-projects/microbit/microbit-console` — a similar
  browser app (DAPjs/WebUSB + WebSocket rendezvous)

**`docs/design/overview.md` in this repo is stale** — written before this
issue, it describes a much smaller Electron-only app (USB serial + MSD
flashing, no radio, no telemetry, no WiFi). Project initiation must rewrite
`overview.md`, `specification.md`, and `usecases.md` from this issue.

### Traps worth knowing before writing transport code

- **Opening the port resets the board on macOS; on Linux nothing does except
  a serial break** (measured against DAPLink v0257 — close/reopen, DTR
  pulse, 2 s DTR low, 1200-baud touch and RTS pulse all fail). The boot
  banner lands while the port is still opening, so always open → send
  `HELLO` → read the banner from the reply.
- **The relay data plane has no in-band escape.** After `!GO` the only way
  back is a reset. Over TCP a break cannot be sent at all — disconnect and
  reconnect instead.
- **The radio is fire-and-forget**, no retransmit. Keep every message in one
  frame: ≤16 bytes MAKECODE, ≤247 bytes RAW250.
- **A derived `(channel, group)` is a default, not an address.** 125 names
  share each channel. Ask mbrelay's registry (`GET /names/<name>` on :8761)
  where a robot actually is; fall back to the derived pair only if the
  registry is unreachable — and never silently.
- **Nothing is unsolicited** except the boot banner, telemetry while
  subscribed, and `DBG:` lines. An idle link is completely silent; do not
  wait for a beacon.
- **Writing flat out at 115200 overruns the board.** Pace writes (~10 ms
  between frames), on direct serial and over mbrelay alike.
