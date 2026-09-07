# robot-console — Specification

## 1. Purpose

`robot-console` is a GUI for managing micro:bit robots built on the
Elecfreaks Nezha differential-drive board, for students and instructors in
an educational robotics setting who generally have no command-line or
firmware experience. One page lets a student:

- plug in micro:bits and see their five-letter names, roles, and ports
- install relay or calibration firmware on them
- drive the robot over USB or radio
- watch telemetry as charts and a path trace
- run guided calibration routines that end in a block of MakeCode the
  student pastes into their own program

Two devices are typically registered at once and referenced by name: the
user's RADIORELAY and the user's robot.

The fleet's existing tools (`mbdeploy`, `mbrelay`, `pxt-nezha-diffdrive`,
`radio-robot-lib`) are all command-line. A student wanting to flash a
relay, name a robot, drive it, and calibrate its wheel diameter has no GUI
at all today. `robot-console` is that GUI.

## 2. Shape

**Node host + browser UI.** `npx robot-console` starts a localhost server
and opens the browser. Not a pure static site, not Electron.

npm workspaces monorepo, TypeScript throughout, `vitest` for tests:

```
packages/protocol/   pure TS, zero I/O
packages/host/       Node: USB, SWD, mDNS, TCP, UDP, hex fetch
packages/ui/         Vite + React, talks to host over one WebSocket
```

UI tabs:

- **Devices** — list, names, roles, ports, flash buttons
- **Console** — raw line stream, send box, `#`/`DBG:`/`err` colorized
- **Telemetry** — wheel-speed bars, time-series charts
- **Trace** — path plot, clearable
- **Calibrate** — wizards

### 2.1 Why not a browser-only app

A static browser app cannot reach the existing fleet services. This was
investigated and ruled out on hard evidence:

| Need | Browser-only verdict |
| --- | --- |
| mbrelay relay pool | Raw TCP on :8760 — a browser cannot open a TCP socket |
| mbrelay name registry | HTTP on :8761, but `httpapi.py` sends **no CORS headers** (hand-rolled 5-route server) |
| mbdeploy remote boards | `_mbserial._tcp` / `_mbflash._tcp` — raw TCP again |
| Discovery | mDNS/UDP multicast — unreachable from a page |
| Robot WiFi link | UDP :7654 — unreachable from a page |
| Relay firmware download | GitHub **release assets send no `access-control-allow-origin`** (verified, including the 302 target); `api.github.com` and `raw.githubusercontent.com` do |

A browser page could only ever drive a board plugged into that same
machine. The Node host gets all six, so the console is Node host +
browser UI rather than a static site.

### 2.2 Why five-letter naming requires SWD, not the USB serial number

The five-letter name is a hash of the **target nRF chip's**
`FICR.DEVICEID[1]` at `0x10000064`. The USB serial number a host sees is
the **KL27 interface chip's UID** — a different chip on the same board.
`mbdeploy` bridges the two by attaching over SWD and reading that
register; `microbit-console` does not, and falls back to a serial
substring, so it cannot name a board whose firmware does not announce.
Reading over SWD also means a blank, never-flashed micro:bit still shows
its real name — this is a `robot-console` requirement, not an incidental
benefit, and Sprint 1's own done-criterion depends on it.

## 3. `packages/protocol` — no I/O, fully unit-testable

Everything in this package is pure TypeScript with zero I/O, so it is
fully covered by `vitest` unit tests independent of any hardware.

### 3.1 `naming.ts` — CODAL friendly name

Five base-5 digits over the codebook
`("zvgpt","uoiea","zvgpt","uoiea","zvgpt")`; digit *i* from the least
significant lands at position `4-i`. Port of
`mbdeploy/src/mbdeploy/devices.py:205-218`.

### 3.2 `radioAddress.ts` — name → `(channel, group)`

`n = base5(name)` with `name[0]` **most** significant.
`channel = 25 + 2*(n%25)`. `group = 1 + n/25`, bumped past 10. Port of
`microbit-radio-relay/server/src/mbrelay/naming.py`.

**Endianness trap**: `zuzuv` is n=1; a reversed encoder says `vuzuz` and
would pass a sampled table. This is why verification (§9) requires the
full 3125-name space checked against a published sha256, not a spot
check.

### 3.3 `banner.ts` — parse both dialects, because both are live

- Colon form: `DEVICE:RADIOBRIDGE:relay:getez:1779042496` (relays; serial
  in **hex** for legacy `RADIORELAY`, **decimal** for `RADIOBRIDGE`)
- Space form: `device NEZHA2 robot vevov 1198504156` (what robots emit
  today)

`microbit-console`'s parser handles only the colon form and would fail to
identify a robot — do not copy it. `robot-console` must parse both.

### 3.4 `v6/codec.ts` — line grammar

`verb field* '#'id '\n'`, max **240 bytes**, base-10 ASCII ints, `flags`
lowercase hex with no `0x` prefix.

**Case is direction**: commands are UPPERCASE, replies are lowercase. A
lowercase inbound verb that is not a known reply is another robot
overheard on a shared radio channel — drop it silently, not as an error.

### 3.5 `v6/session.ts` — reliability layer

Mirrors the firmware's `expectedNext_`:

- `ack N` → `seq = N`
- `nack N` → `seq = N-1` (nack carries **next-expected**, not last-good —
  confusing these two was a real logged bug, so the session layer must
  get this specific arithmetic right, not just "roughly retry")
- a retransmit **must reuse its original id**; a fresh id reads as a gap
  and stalls the stream
- only 11 verbs take an id: `GET SET TLM STOP RUN WHEELS_X WHEELS_V
  MOVE_X MOVE_V GO_TO_R GO_TO_W`
- `HELLO` resets the sequence to 1 — **never use it as a health check** on
  a live session; use `PING` or `STATUS` instead

### 3.6 `v6/telemetry.ts` — schemaless decoder

Zip `thdr` against `t` positionally. Schemaless by design, so one decoder
handles the robot's 12-column POSE and 20-column FULL variants *and*
radio-robot-lib's 7/11 variants with no branching.

`TLM HDR` is the recovery path for a missed header — **not** `TLM NOW`.

Unit traps that must be preserved exactly:
- `ox`/`oy` are already millimeters
- `oh` is **centidegrees — do not divide**
- `rotation`/`omega` are **milliradians** on the wire

Telemetry streams at 20 Hz; the header auto-refreshes every 20 frames so
a late listener recovers without an explicit request.

### 3.7 `relay/commands.ts` — relay command plane

`!CG <ch> <grp>`, `!MODE RAW250`, `!P 7`, `!ECHO OFF`, `!GO`, `?`, `HELLO`.
`#` lines are comments. A `< ` prefix on received lines is **stripped
unconditionally** — nothing the robot itself says starts with `< `.

## 4. `packages/host` — the privileged half

The host is where all six of the browser-unreachable capabilities from
§2.1 live: USB serial, SWD, mDNS, raw TCP, UDP, and server-side HTTP
fetch of release assets.

### 4.1 `devices.ts` — enumerate and join

`serialport` filtered to DAPLink `VID 0x0D28 / PID 0x0204`, keyed on
`serial_number` — the same join key used across the rest of the fleet
tooling. `node-hid` is used for the CMSIS-DAP interface.

### 4.2 `swdName.ts` — five-letter naming (see Cause, §2.2)

Read `FICR.DEVICEID[1] @ 0x10000064` with `dapjs` (`readMem32`) in attach
mode — no halt, no reset, no cooperating firmware required — then hash it
with `naming.ts`. This works on a blank, never-flashed micro:bit.

### 4.3 `link/` — transport implementations

Every transport reduces to *a stream of newline-delimited v6 lines*, so
the session layer (§3.5) sits on all of them unchanged. This mirrors
mbrelay's own stated design target: "a drop-in replacement for opening
the serial port directly."

- **`UsbSerialLink`** — robot on local USB, 115200 baud
- **`RelayRadioLink`** — local USB relay: send `!ECHO OFF`, `!MODE
  RAW250`, `!CG <ch> <grp>`, `!P 7`, then `!GO`
- **`MbrelayLink`** — TCP to `_mbrelay._tcp` on :8760, identical grammar
  to the local relay. **Must set `TCP_NODELAY`.**
- **`MbserialLink`** — TCP to `_mbserial._tcp` (mbdeploy `serve`)
- **`WifiUdpLink`** — UDP to the robot on :7654, bound locally to :7655

### 4.4 `mdns.ts` — discovery

Browse `_mbrelay._tcp`, `_mbserial._tcp`, `_mbflash._tcp`, and the
robot's own WiFi service, advertised under **both** `_robotlink._tcp`
*and* `_robotlink._udp` — the robot serves the same v6 line grammar over
TCP on the same port, so a TCP link is a legitimate alternative to
`WifiUdpLink` (§4.3), not just UDP. **Verified against live mDNS
advertisements** from robots `vevov` and `gopiv` while planning sprint 3:
both service types resolve to host `<name>.local.`, port `7654`, TXT
`name=<name> role=robot link=v6 port=7654` — earlier drafts of this
section said `_robotlink._udp` only with `link=v6-udp`, which is wrong
and matches nothing a robot actually advertises. See §7 Sprint 9.

### 4.5 `flash.ts` — firmware flashing

DAPjs over `node-hid`, with universal-hex v2 extraction
(`BLOCK_ID_V2 = 0x9903`) ported from
`microbit-console/client/src/lib/universal-hex.ts`. MSD volume copy is
the fallback path (`radio_relay/scripts/flash-local.js` is the template).

### 4.6 `releases.ts` — firmware download

Fetch the relay hex server-side (Node host, not browser — see §2.1) from
`.../releases/download/v<TAG>/MICROBIT.hex`, plus the companion
`MICROBIT.hex.txt` build manifest (commit / built / sha256) so the UI can
show which build is installed and verify the download against the
manifest's sha256.

### 4.7 `server.ts` — transport to the UI

Express + `ws`. One WebSocket carries device-list updates, line traffic,
and telemetry frames.

## 5. `packages/ui`

Vite + React. Talks to the host exclusively over the one WebSocket from
`server.ts`. Five tabs, described in §2. Audience is students and
instructors with no assumed command-line or firmware background, so the
UI favors plain labels, visible device names/roles, and guided flows
(especially in Calibrate) over raw protocol exposure — though the Console
tab intentionally does expose the raw line stream for troubleshooting and
learning.

## 6. Transport traps

These are easy to get wrong and must be handled explicitly, not
discovered empirically per deployment:

- **Opening the port resets the board on macOS; on Linux nothing does
  except a serial break** (measured against DAPLink v0257 — close/reopen,
  DTR pulse, 2 s DTR low, 1200-baud touch, and RTS pulse all fail to reset
  it on Linux). The boot banner lands while the port is still opening, so
  the correct sequence is always: open → send `HELLO` → read the banner
  from the reply. Do not rely on catching an unsolicited boot banner.
- **The relay data plane has no in-band escape.** After `!GO` the only way
  back to the command plane is a reset. Over TCP a break cannot be sent at
  all — disconnect and reconnect instead.
- **The radio is fire-and-forget, with no retransmit.** Keep every message
  in one frame: ≤16 bytes for MAKECODE mode, ≤247 bytes for RAW250 mode.
- **A derived `(channel, group)` is a default, not an address, and there
  are three outcomes, not two.** 125 names share each channel, so ask
  mbrelay's registry (`GET /names/<name>` on :8761) where a robot
  actually is — but that call **mutates the shared registry and always
  answers 200**. `httpapi.py:146` returns `registry.resolve(name)`, and
  `resolve()` falls through to deriving the address locally
  (`radioAddress.ts`'s Python port), writes the guess into `_learned`,
  calls `save()`, and replies `source: derived`. So "the HTTP call
  succeeded" is **not** the same as "the registry knew" — checking only
  for success presents a locally-derivable guess as authoritative.
  `registry.py` has a separate, **non-mutating `get()`** that the HTTP
  route does not use. Distinguish three outcomes: **authoritative** (the
  registry actually knew), **derived** (the registry only echoed its own
  just-made guess — surface this as prominently as a fallback, because
  the failure mode is identical to not knowing), and **local-derived**
  (the registry was unreachable and the host derived the pair itself).
  Never use a derived value *silently*, whichever kind.
- **Looking a name up enrols it.** Because the GET mutates, resolution
  must be **lazy — one name, at connect time** — never prefetched (e.g.
  to populate a dropdown), which would inject an entry per robot into
  shared classroom state.
- **Registry discovery is mDNS, not a port convention.** An
  `_mbrelay._tcp` advertisement carries the registry's port in its own
  TXT record — verified live: instance `torture` at `torture.local.:8760`
  advertises TXT `txtvers=1 version=0.20260831.1 node=torture
  registry=8761`. Find the registry by browsing `_mbrelay._tcp` and
  reading `registry` from its TXT record, not by assuming :8761.
- **Nothing is unsolicited** except the boot banner, telemetry while
  subscribed, and `DBG:` lines. An idle link is completely silent — do
  not wait for a beacon as a liveness signal.
- **Writing flat out at 115200 overruns the board.** Pace writes at
  roughly 10 ms between frames, on direct serial and over mbrelay alike.

## 7. Sprints

Ten sprints. Sprints 1–2 are merged history. Sprint 3 begins the current
roadmap and **splits** what was originally scoped as a single "Radio +
control" sprint across new positions 6 and 7; the full rationale and
dependency graph live in
`clasi/issues/robot-console-two-level-ui-and-multi-transport-roadmap.md`'s
"Proposed fix" section. This section is renumbered from an earlier
six-sprint draft — do not trust cross-references to sprint numbers in
material written before sprint 3.

### Sprint 1 — Connect, identify, console

- Monorepo skeleton; TS config; vitest; `npx`-able entry point.
- `protocol`: `naming.ts`, `radioAddress.ts` (with the 3125-name sha256
  conformance test), `banner.ts`, `v6/codec.ts`, `v6/session.ts`.
- `host`: `devices.ts`, `swdName.ts`, `UsbSerialLink`, `server.ts`.
- `ui`: device list showing five-letter name + role + port + UID; a
  working serial console with a send box.

### Sprint 2 — Flashing

Relay hex from GitHub Releases (host-side fetch + sha256 verify), DAPjs
flash with progress, universal-hex v2 extraction, MSD fallback.
Calibration-firmware hex is **TBD — the stakeholder has not supplied
it** (see §9, open question 1).

### Sprint 3 — Hardware bring-up and flash verification

Turn the silent board into an announcing relay: run the sprint-2 flash
path against real hardware and fix what breaks, implement
`defaultResolveVolumePath` for real, fix the tty/cu device-list display
path, and bump the `vendor/pxt-nezha-diffdrive` pin and re-run fixture
tests. No new architecture — nothing here is meant to be thrown away by
sprint 4. Detail-planned in its own sprint; see
`clasi/sprints/003-hardware-bring-up-and-flash-verification/`.

### Sprint 4 — Device model, device types, two-level navigation

Keystone sprint — sprints 5 through 10 all depend on it. Introduces the
`unknown | relay | robot` device-type union and the orthogonal
type/transport/presence model; the `Link` abstraction split into
`connect()` (transport only, throws on transport failure) and
`identify()` (banner or null, never throws); the front-page-plus
per-device-page navigation restructure; and local-hex flashing (an
arbitrary hex picked off the local disk, for the case the calibration
hex does not yet fill). Not yet detail-planned.

### Sprint 5 — Persistence: the remembered-robot roster

Introduces the project's first persistence layer: a roster of robot
names seen over USB (keyed on name, not USB serial), used to populate the
relay dropdown and to gate which mDNS advertisements are shown — a
classroom is full of advertising robots, and only previously-seen ones
should appear. Not yet detail-planned.

### Sprint 6 — Robot page: drive and control over USB

The control half of the original "Radio + control" sprint, built against
USB only, where verification is cheap. Robot control: drive, stop, estop,
`STATUS`, `GET`/`SET`. Sequence/ack state visible in the UI. Sprint 7
reuses this page unchanged once a session is open over the relay.

### Sprint 7 — Relay page, radio transport, network discovery

The transport half of the original "Radio + control" sprint. Depends on
sprint 4 (the resource-key model), sprint 5 (the roster), and sprint 6
(the page it renders into). `RelayRadioLink`, `MbrelayLink`,
`MbserialLink`, mDNS discovery for `_mbrelay._tcp`/`_mbserial._tcp`, and
a registry client with three outcomes (see §6) rather than two.

### Sprint 8 — Telemetry and trace

`thdr`/`t` decoder, wheel-speed bars, time-series charts, path trace with
clear. 20 Hz from the robot; the header auto-refreshes every 20 frames so
a late listener recovers. Depends on sprint 4 and sprint 6 only, not
sprint 7 — telemetry over USB is sufficient.

### Sprint 9 — WiFi robots

Discover the robot's WiFi service, advertised under **both**
`_robotlink._tcp` and `_robotlink._udp` (instance `<name> robot link`,
host `<name>.local`, port 7654, TXT record `name=<name> role=robot
link=v6 port=7654`), and auto-switch a named robot from radio to WiFi
when it appears. **Verified against live mDNS advertisements** from
robots `vevov` and `gopiv` while planning sprint 3 — an earlier draft of
this section said `_robotlink._udp` only with `link=v6-udp`, which
matches nothing a robot actually advertises (see §4.4). Gate
advertisements against the sprint 5 roster — the classroom requirement,
and the only place gating applies.

### Sprint 10 — Calibration wizards

Distance calibration (robot inches up to a first black line, sets a
counter, drives to a second line 90 cm away; report how far it thought it
drove) and rotation calibration (beam pointer on the front, robot
attempts a full 360°, on-screen nudge buttons walk it in until the
wheelbase is dialled in). Both drive `RUN:` programs and end by emitting
a MakeCode snippet the student pastes into their own program. Depends on
sprint 6 and is gated on §9 open question 1 (the calibration firmware
hex does not exist).

### Blocked on firmware — file as separate issues in `pxt-nezha-diffdrive`

The console feature-detects these and ships without them.

1. **List runnable programs.** `runNames[]` is a private module-level
   array at `src/blocks/run.ts:35` with no getter, no `//% shim=`, and no
   wire verb. `HELP` lists *protocol verbs* from `kCommandTable`, not run
   names. Cleanest fix is ~10 lines: export a `runNames` accessor + shim,
   or add a `RUN:list` handler that `emitLine()`s the names.
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
   `RUN:name:arg` form with **no sequence id**. Whether that is permanent
   is unresolved (see §9, open question 3), and the calibration UI
   depends on the answer.

### Blocked on firmware — WiFi credentials have no runtime provisioning path

See §9, open question 2. Sprint 9 as scoped only discovers and uses an
already-provisioned robot.

## 8. Verification strategy

- `npm test` — protocol unit tests, run with `vitest`.
- **Strongest single gate:** test `radioAddress.ts` against
  `pxt-nezha-diffdrive/docs/radio-address-vectors.json`, asserting the
  full 3125-name space against its published sha256. That file is an
  existing three-repo contract, so this check is free correctness. It
  also catches the documented endianness trap (§3.2) — `zuzuv` is n=1; a
  reversed encoder says `vuzuz` and would pass a sampled table but fail
  the full-space hash.
- Golden wire vectors: `radio-robot-lib/tests/protocol/golden_vectors.txt`.
- Hardware smoke test each sprint with a real relay and a real robot.
- **Sprint 1 done when:** a relay and a robot both show correct
  five-letter names and correct roles; `HELLO` / `?` / `STATUS` typed
  into the console return sane replies; and a blank micro:bit still shows
  its name, proving `swdName.ts` works.

## 9. Open questions

These are unresolved in the source issue and must not be resolved by
project initiation or by any downstream sprint planning without
stakeholder input.

1. **The calibration firmware hex does not exist yet.** The stakeholder
   has not supplied it. Sprint 2 can flash the relay hex but currently
   has nothing to flash for calibration.
2. **WiFi credential provisioning has no runtime path.** `kWifiSsid` /
   `kWifiPassword` in `pxt-nezha-diffdrive/src/comms/protocol.cpp:76-86`
   are `constexpr` empty strings rewritten in a deploy-time scratch copy
   by `tools/make_deploy.py::_inject_wifi_secrets()` from a gitignored
   `config/wifi_secrets.json`. There is no `SET` field and no
   `uBit.storage` record. Patching a compiled hex is fragile and not
   worth doing. This needs a firmware change (persist SSID/password via
   `SET` + `uBit.storage`) before anything can provision a robot at
   runtime. Sprint 9 as scoped only discovers and uses an
   already-provisioned robot.
3. **Four firmware extensions are needed in `pxt-nezha-diffdrive`**,
   listed in §7's "Blocked on firmware" section:
   (a) list runnable programs — no getter, no shim, no wire verb exists
   today (**note:** upstream commit `d4d8e4e` — "FUNCS lists the RUN
   registry; RUN replaces the cleartext RUN: carve-out" — plus follow-up
   `0056a64`, appears to add exactly this. Sprint 3's submodule-bump
   ticket confirmed the `vendor/pxt-nezha-diffdrive` pin now includes
   `d4d8e4e`, and this repo's `session.ts` already lists `RUN` in
   `SEQUENCED_VERBS`, so this repo's model was already correct for the
   post-`d4d8e4e` wire shape. **Likely closable, but left open here** —
   closing needs explicit stakeholder confirmation that `d4d8e4e` is the
   intended upstream direction, not a unilateral close by planning);
   (b) settable role in the banner — currently a hard-coded literal;
   (c) banner format convergence (space vs colon) — already filed
   upstream in `radio-robot-lib` as
   `hello-banner-emit-the-specified-colon-announcement-format.md`,
   status pending; link rather than duplicate;
   (d) the v6 `RUN` verb is a stub, so the working path is the cleartext
   `RUN:name:arg` form with no sequence id — whether that is permanent is
   unresolved, and the calibration UI depends on the answer (**note:**
   the same `d4d8e4e`/`0056a64` evidence in (a) applies here — `RUN`
   appears to become sequenced and acked upstream — but this is left
   open for the same reason: pending explicit stakeholder confirmation).
   The console feature-detects all four and ships without them.
4. **Whether a label maker / physical naming scheme is used** alongside
   the five-letter names.
5. **No radio-enabled robot hex is currently obtainable.**
   `pxt-nezha-diffdrive` publishes **zero** GitHub releases, and
   `BOOT_RADIO_LINK = false` by default (`test/test.ts:48`), flipped only
   by a `--radio-link` build. A stock robot build does not answer the
   radio at all. This gates arc positions 6, 7, 8, and 10 (§7 Sprints
   6–8, 10) — there is currently no confirmed way to obtain a hex that
   would let any of that work be verified against real radio traffic.
   Note the nuance: `vevov` and `gopiv` answer over **WiFi** right now
   (§7 Sprint 9), which does not by itself prove radio is enabled on
   those builds — WiFi and radio are separate transports, and a robot
   can have one without the other.

## 10. Related

Reference implementations to check behavior against, not to port
blindly: `radio-robot-lib/src/host/robot_v6/{codec,transport,reliability}.py`
and `pxt-nezha-diffdrive/tools/link.py`.

Source repositories:

- `/Volumes/Proj/proj/RobotProjects/pxt-nezha-diffdrive` — robot firmware
- `/Volumes/Proj/proj/RobotProjects/radio-robot-lib` — v6 protocol spec
  (`docs/design/protocol.md`, 2393 lines, canonical)
- `/Volumes/Proj/proj/RobotProjects/microbit-radio-relay` — relay
  firmware + `mbrelay` server; `docs/radio-relay-protocol.md`,
  `docs/announce.md`, `docs/relay-server.md`
- `/Volumes/Proj/proj/RobotProjects/mbdeploy` — flashing, SWD naming,
  mDNS remote client
- `/Users/eric/proj/league-projects/microbit/microbit-console` — a
  similar browser app (DAPjs/WebUSB + WebSocket rendezvous); useful as a
  reference for what *not* to copy (colon-only banner parsing, USB
  serial-substring naming fallback)
