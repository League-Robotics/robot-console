#!/usr/bin/env node
// robot-console CLI entry point.
//
// This is a thin loader shim, not the real logic (that's
// packages/host/src/cli.ts). Every package in this monorepo currently
// resolves via its package.json's `main`/`types` fields straight to its
// TypeScript source (no `dist` build output exists yet, ahead of a real
// per-package build/publish pipeline), and that source uses NodeNext-
// style ".js" import specifiers pointing at sibling ".ts" files plus
// constructor parameter properties (see e.g. UsbSerialLink.ts's
// WritePacer) -- neither of which plain Node's own built-in TypeScript
// support (type-stripping, with or without --experimental-transform-
// types) handles. `tsx` does handle both, so it is registered here as a
// loader hook before importing anything else, letting the rest of the
// host package run directly from source with no separate compile step.
// tsx's own `tsx/esm/api` `register()` (rather than the lower-level
// `node:module` `register("tsx/esm", ...)`, which hits tsx's legacy
// `--loader`-flag code path and throws under current Node) is the
// supported way to install this hook programmatically.
import { register } from "tsx/esm/api";

register();

const { main } = await import("../packages/host/src/cli.ts");

try {
  await main(process.argv.slice(2));
} catch (error) {
  console.error(`robot-console: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
