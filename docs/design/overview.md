# robot-console — Overview

## What it is

`robot-console` is a GUI for managing micro:bit robots built on the
Elecfreaks Nezha differential-drive board. A student plugs in micro:bits,
sees their five-letter friendly names, installs relay or calibration
firmware on them, drives the robot over USB or radio, watches telemetry as
charts and a path trace, and runs guided calibration routines that end in a
block of MakeCode they paste into their own program.

Two devices are typically registered at once and referenced by name: the
user's RADIORELAY and the user's robot.

## Who it's for

Students and instructors in an educational robotics setting. The people
using this tool generally have no command-line or firmware experience —
the GUI must be approachable on its own, with no assumption of prior
familiarity with serial ports, mDNS, or the underlying wire protocol.

## Shape

**Node host + browser UI.** Run `npx robot-console`: it starts a localhost
server and opens the browser. This is deliberately **not** a static
site and **not** Electron — a browser page cannot reach the fleet's
existing infrastructure (mbrelay's raw-TCP relay pool and CORS-less name
registry, mbdeploy's raw-TCP remote services, mDNS/UDP discovery, the
robot's UDP WiFi link, or GitHub release assets with no CORS headers). The
Node host can reach all of it; see `specification.md` for the full
evidence table.

npm workspaces monorepo, TypeScript throughout, `vitest` for tests:

```
packages/protocol/   pure TS, zero I/O — fully unit-testable
packages/host/       Node: USB, SWD, mDNS, TCP, UDP, hex fetch
packages/ui/         Vite + React, talks to host over one WebSocket
```

The UI has five tabs: **Devices** (list, names, roles, flash buttons),
**Console** (raw line stream with a send box), **Telemetry** (wheel-speed
bars and time-series charts), **Trace** (path plot, clearable), and
**Calibrate** (guided wizards).

## Roadmap

Six sprints. Sprint 1 is the foundation and is detail-planned first.

1. **Connect, identify, console** — monorepo skeleton; the protocol
   package's naming/banner/codec/session logic; USB device enumeration and
   SWD-based naming; a working serial console.
2. **Flashing** — fetch and verify relay firmware from GitHub Releases,
   flash it over SWD with progress, with an MSD-copy fallback. (Calibration
   firmware is not yet available — see open questions.)
3. **Radio + control** — radio and mbrelay links, mDNS discovery, and
   robot drive/stop/estop/status control with sequence state visible in
   the UI.
4. **Telemetry** — decode telemetry headers/frames into wheel-speed bars,
   time-series charts, and a clearable path trace.
5. **Calibration wizards** — guided distance and rotation calibration
   routines that end by emitting a MakeCode snippet.
6. **WiFi** — discover and auto-switch an already-provisioned robot from
   radio to WiFi.

See `specification.md` for the full technical detail and `usecases.md` for
the user-facing flows.
