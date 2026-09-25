#!/usr/bin/env node
// robot-console-supervisor entry point.
//
// A thin loader shim, like bin/robot-console.js (see that file for why
// it imports compiled output rather than TypeScript source). The real
// logic is packages/host/src/supervisor/cli.ts: an always-running
// process that owns the public port, serves the UI, and starts the real
// host (which holds USB/serial ports) only while a console window is
// connected.
const { main } = await import("../packages/host/dist/supervisor/cli.js");

try {
  await main(process.argv.slice(2));
} catch (error) {
  console.error(`robot-console-supervisor: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
