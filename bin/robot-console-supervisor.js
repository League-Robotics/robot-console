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
  // A rejection from startSupervisor's own port bind (see supervisor.ts's
  // PORT_IN_USE_EXIT_CODE doc comment) carries a numeric .exitCode --
  // e.g. 3 for "the public port is already in use", which
  // robot-console.service's RestartPreventExitStatus=3 uses to stop
  // retrying instead of crash-looping. Any other failure keeps the
  // previous plain exit code 1.
  const exitCode = error && typeof error === "object" && "exitCode" in error && typeof error.exitCode === "number" ? error.exitCode : 1;
  process.exitCode = exitCode;
}
