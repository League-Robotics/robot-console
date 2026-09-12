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
