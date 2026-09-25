---
status: pending
---

# The daemon CLI "real process" test leaves a real host running when it fails

`packages/host/src/daemon/cli.test.ts`, test "start spawns a real detached
host, a second start attaches instead of double-spawning, and stop tears it
down for real", starts a detached `bin/robot-console.js --no-open --port 19572
--no-sweep`. When the test fails (seen 2026-09-25: the host did not answer
within 20 s because `node_modules` was stale), nothing stops that host. It
kept running for over an hour, connected to the real mbregistry, and held
the locks on the local robot and joystick, so every other client saw
"in use by gala / robot-console".

## Fix

- Stop the spawned host in an `afterEach`/`finally` whatever the outcome
  (kill the recorded pid, or run the daemon's `stop` against its state dir).
- Run the test host against an isolated state dir and with no registry
  access (for example `ROBOT_CONSOLE_MBREGISTRY` pointed at a dead socket),
  so it can never lock real boards.
