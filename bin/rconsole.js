#!/usr/bin/env node
// rconsole CLI entry point.
//
// A thin loader shim, exactly like bin/robot-console.js next to it (see
// that file's comment for why this imports the *compiled* output rather
// than the TypeScript source). The real logic is
// packages/host/src/rconsole/cli.ts.
//
// rconsole is the short, installable front door; robot-console remains
// the full CLI. rconsole deliberately owns no logic of its own -- every
// verb delegates to the same daemon functions robot-console uses, so the
// two can never disagree about whether a host is running.
const { runRconsole } = await import("../packages/host/dist/rconsole/cli.js");

try {
  const result = await runRconsole(process.argv.slice(2));
  // A command that could not do what was asked exits non-zero so shell
  // callers and CI can branch on it; everything else exits 0.
  if (
    result.outcome === "unknown-command" ||
    result.outcome === "not-running" ||
    result.outcome === "stop-failed"
  ) {
    process.exitCode = 1;
  }
} catch (error) {
  console.error(`rconsole: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
