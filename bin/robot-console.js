#!/usr/bin/env node
// robot-console CLI entry point.
//
// This is a thin loader shim, not the real logic (that's
// packages/host/src/cli.ts). It imports the *compiled* output at
// packages/host/dist/cli.js -- produced by `npm run build` (ticket
// 009) -- rather than the TypeScript source directly. Plain Node
// cannot run packages/host/src/cli.ts (and everything it imports) as
// -is: this monorepo's sources use NodeNext-style ".js" import
// specifiers pointing at sibling ".ts" files plus constructor
// parameter properties (see e.g. UsbSerialLink.ts's WritePacer),
// neither of which plain Node's own built-in TypeScript support
// (type-stripping, with or without --experimental-transform-types)
// handles. `tsc` (the real build, `npm run build`) does handle both,
// emitting plain ".js" that plain `node` runs directly -- so this
// shim needs no loader hook, and `tsx` is not a runtime dependency of
// the published package.
//
// `npm run dev` is the development-time exception: it runs everything
// from source with no compile step, via `scripts/dev.mjs`'s own `tsx`
// registration -- see that file's comment.
const { main } = await import("../packages/host/dist/cli.js");

try {
  await main(process.argv.slice(2));
} catch (error) {
  console.error(`robot-console: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
