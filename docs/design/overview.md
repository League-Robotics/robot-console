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

The original six-sprint roadmap (connect/identify/console, flashing,
radio + control, telemetry, calibration wizards, WiFi) shipped and was
then superseded: sprints 014–017 rearchitected the host around a SQLite
store, a set of watchers, one connector/reconciler, and a single
transport-agnostic link core, per `docs/design/architecture.md`. The
current and future sprint arc — grouped `rearch-*` issues, dependency
order, and exit criteria per sprint — lives in
`docs/design/rearchitecture-plan.md`; that is the roadmap to read now,
not this section.

See `specification.md` for the full technical detail and `usecases.md` for
the user-facing flows.
