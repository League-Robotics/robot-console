# robot-console

GUI for managing micro:bit robots built on the Elecfreaks Nezha
differential-drive board. `npx robot-console` starts a local Node host
and talks to it from a browser UI.

## Getting started

This repository uses **git submodules** under `vendor/` for reference
fixtures (`pxt-nezha-diffdrive`, `radio-robot-lib`) that the protocol
test suite checks itself against. Clone with submodules included:

```sh
git clone --recurse-submodules <repo-url>
```

If you already cloned without that flag, initialize them afterwards:

```sh
git submodule update --init
```

`vendor/` is reference data only — nothing under `packages/` imports
source from it, and it is excluded from the TypeScript build.

Then install and run the workspace:

```sh
npm install
npm test
npm run build
```

## Development

One command, one terminal, hot reload:

```sh
npm run dev
```

That starts the Node host (`127.0.0.1:4795`) and the Vite dev server in
a single process, opens a browser to the Vite URL, and points the page's
WebSocket at the host. Ctrl-C stops both. Use `--host-port <n>` (or
`ROBOT_CONSOLE_PORT`) if 4795 is taken.

To run the app the way students will, against the built UI instead:

```sh
npm run --workspace @robot-console/ui vite:build
npx robot-console
```

## Layout

```
packages/protocol/   pure TS, zero I/O
packages/host/       Node: USB, SWD, mDNS, TCP, UDP, hex fetch
packages/ui/         Vite + React, talks to host over one WebSocket
vendor/               reference-only git submodules (do not import)
```

See `docs/design/specification.md` for the full design.
