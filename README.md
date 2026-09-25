# robot-console

GUI for managing micro:bit robots built on the Elecfreaks Nezha
differential-drive board. `npx robot-console` starts a local Node host
and talks to it from a browser UI.

## Getting started

**Node.js `>=22.13` is required** (`engines.node` in every `package.json`,
enforced via `.npmrc`'s `engine-strict=true` — `npm install` fails loudly
on an older Node instead of installing something that later breaks).
`22.13` is the floor because `node:sqlite`, which the host package's
storage layer depends on, first shipped there. `.nvmrc`/`.node-version`
pin `22` for `nvm`/`fnm`/similar version managers.

**mbtools (`mbregistry`) is a separately installed prerequisite** as of
sprint 018 — robot-console talks to boards, locks, and flashing through
a local `mbregistry` daemon rather than opening USB/HID devices itself.
It is not bundled and robot-console does not install it: install
`mbtools` yourself (`League-Microbit/mbtools`), at least version
`0.20260924.7` (`packages/host/src/mbregistry/client.ts`'s
`MIN_MBREGISTRY_VERSION`). robot-console looks for the `mbregistry` executable on
`$MBREGISTRY_BIN`, then `$PATH`, and starts its own instance
automatically if none is already running (see that module's own doc
comment for the resolution order) — there is no direct-USB fallback, so
an outdated or missing `mbregistry` fails startup with a clear error
naming the required version.

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

`npm test`'s `pretest` script also runs `git submodule update --init`
automatically (tolerating failure when not in a git checkout at all, e.g.
an installed package), so an out-of-date checkout self-heals on the next
test run; a dedicated guard test
(`packages/protocol/src/vendorSubmodules.test.ts`) still fails loudly
and early if the submodules are missing outright.

`vendor/` is reference data only — nothing under `packages/` imports
source from it, and it is excluded from the TypeScript build.

Then install and run the workspace:

```sh
npm install
npm test
npm run build
```

### Type checking

```sh
npm run typecheck
```

Builds `packages/protocol/dist` and `packages/host/dist` first (`ui`
depends on both packages' emitted `.d.ts` files, not their source), then
runs `tsc --noEmit` against each package's own `tsconfig.json` in turn.
This is a separate step from `npm test` (which vitest/esbuild transpiles
without a full type-check) and from `npm run build` (which emits dist
output for `protocol`/`host`) — run it in CI, or locally before pushing,
to catch type errors none of the others do.

### Lockfile drift after a version bump

`package.json`'s root `version` field is bumped by tooling outside `npm`
(CLASI's `close_sprint`, via `dotconfig version bump`, which writes
`package.json` directly rather than invoking `npm version`) as well as,
occasionally, `npm version` itself. Either path leaves `package-lock.json`
out of sync with the new root version, which dirties the very next
`npm install` a contributor runs. Two things guard against that now:

- A root `"version"` script (`npm install --package-lock-only`) runs
  automatically for any `npm version <bump>` invocation.
- Because `dotconfig version bump` does **not** go through `npm version`
  (so the script above never fires for it), run
  `npm install --package-lock-only` by hand once after any bump made
  that way, before committing.

## Configuration

The two flashable firmware sources -- the relay's and the robot's --
are configured via `ROBOT_CONSOLE_RELAY_FIRMWARE` /
`ROBOT_CONSOLE_ROBOT_FIRMWARE`, each a `<github-repo-url>[:<tag>]`
string (`tag` defaults to `latest`). At every host startup, an importer
resolves these in the following order and writes the result into the
host's own SQLite store (`console.sqlite`'s `settings` table) --
**an explicit environment variable always wins over a stale stored
value**, on every restart:

1. `process.env` -- set directly, or via `dotconfig load` (see
   `config/AGENTS.md`) assembling `config/prod/public.env`'s
   `ROBOT_CONSOLE_RELAY_FIRMWARE`/`ROBOT_CONSOLE_ROBOT_FIRMWARE` into
   `.env` and that file being sourced into the shell before
   `npx robot-console` runs.
2. A `.env` file in the host's state directory (`$ROBOT_CONSOLE_STATE_DIR`,
   else `${XDG_STATE_HOME:-~/.local/state}/robot-console`) -- the same
   `KEY=value` shape `dotconfig load` assembles, dropped there directly
   for a packaged/registry install with no repo checkout to speak of.
3. `.env` at the repository root -- only when actually running from a
   robot-console checkout (detected by walking up from the installed
   package's own directory looking for the checkout's root
   `package.json`, not by assuming a fixed number of `..` segments,
   which breaks under a packaged/registry install where no such
   ancestor exists). This is what makes `npm run dev`/`dotconfig load`
   work out of a checkout with no state-dir `.env` of its own.

Neither source configuring a given firmware kind is not an error --
that flash button simply renders "not configured" until one does.
Editing `.env` (by hand or via `dotconfig load`/`dotconfig save`) takes
effect on the *next* host restart, not while the host is already
running -- the importer runs once per bootstrap, not on a poll.

See `packages/host/src/store/importers/firmwareConfig.ts` for the full
precedence logic and `packages/host/src/config.ts` for how a resolved
string becomes a typed firmware source.

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

## Debugging the store (sprint 014, throwaway)

One `robot-console` flag lets an engineer inspect the host's SQLite
store (`console.sqlite`) without the browser UI:

```sh
# Print devices/links/services/sessions/tasks as JSON and exit.
# Safe to run alongside an already-running host -- opens a short-lived,
# read-only connection (WAL mode allows a concurrent reader).
npx robot-console --dump-store
```

`--dump-store` is a **sprint-014-only debugging affordance** — the exit
criterion "watcher rows visible in a debug dump" without any UI change.
See `clasi/sprints/014-.../sprint.md`'s Design Rationale and
`packages/host/src/debug/dumpStore.ts`.

`--watch-store` (sprint 014's headless USB/mDNS-watcher runner, a
stand-in for production startup actually exercising the store and
watchers) is **removed as of sprint 015 ticket 005**: ordinary
`npx robot-console` startup now composes `openStoreWithImports` and
both watchers itself (`packages/host/src/runtime.ts`), so the stand-in
has nothing left to stand in for.

## Layout

```
packages/protocol/   pure TS, zero I/O
packages/host/       Node: USB, SWD, mDNS, TCP, UDP, hex fetch
packages/ui/         Vite + React, talks to host over one WebSocket
vendor/               reference-only git submodules (do not import)
```

See `docs/design/specification.md` for the full design.
