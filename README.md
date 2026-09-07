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

## Layout

```
packages/protocol/   pure TS, zero I/O
packages/host/       Node: USB, SWD, mDNS, TCP, UDP, hex fetch
packages/ui/         Vite + React, talks to host over one WebSocket
vendor/               reference-only git submodules (do not import)
```

See `docs/design/specification.md` for the full design.
