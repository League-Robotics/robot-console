---
id: '003'
title: 'Daemon CLI: start/stop/status/open verbs for the shared console host'
status: done
use-cases:
- SUC-002
- SUC-003
- SUC-004
depends-on:
- '001'
- '002'
github-issue: ''
issue: shared-console-host-daemon-cli-and-discovery.md
completes_issue: true
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Daemon CLI: start/stop/status/open verbs for the shared console host

## Description

The actual daemon-CLI ask: `robot-console start` / `stop` / `status`,
plus a browser-open verb, per the stakeholder's own words ("create a cli
to start and stop the host as a daemon, with additional function to
open a browser to the web interface"). Depends on ticket 001 (the
attach-vs-fail signal `start`'s idempotency reuses) and ticket 002 (LAN
bind + advertisement, so `open`'s printed URL and the daemon's own
reachability are real).

Work:

1. Add `store/stateDir.ts`: `resolveDaemonInfoFilePath`/
   `resolveDaemonLogFilePath`, following the exact pattern
   `resolveKnownRobotsFilePath` already establishes (an explicit
   `filePath` override, else `resolveStateDir(...)` joined with a fixed
   filename — `daemon.json` and `console.log` respectively). No new
   state-directory resolution rule.
2. Add `packages/host/src/daemon/daemonInfo.ts`:
   - `writeDaemonInfo({pid, host, port, startedAt}, options)`: writes
     the JSON file.
   - `readDaemonInfo(options)`: reads it, returning `undefined` if
     absent or unparseable.
   - `removeDaemonInfo(options)`: deletes it (no-op if absent).
   - `isProcessAlive(pid)`: `process.kill(pid, 0)` wrapped in
     try/catch, returning a boolean (mirrors sprint 018's
     `clearDeadProcessState` "is this PID still real" idiom referenced
     in the issue).
   - `probeHostInfo(url, timeoutMs)`: `GET <url>/api/host-info`
     (ticket 001's new route) with a bounded timeout, returning the
     parsed JSON or `undefined` on any failure/timeout/non-matching
     shape.
   All four are injectable-by-construction (plain functions taking
   `fs`/`fetch` overrides via an options bag, mirroring
   `store/wifiCredentials.ts`'s own `{filePath, env}` convention) so
   `daemon/cli.test.ts` never touches the real filesystem or network.
3. Wire the actual host process (`cli.ts`'s `main()`, the *plain*,
   no-subcommand path) to call `writeDaemonInfo` immediately after
   `startServer` resolves (using the actual bound `server.port`), and
   `removeDaemonInfo` inside `installShutdownHandlers`'s shutdown path —
   this makes daemon-info bookkeeping happen for *every* way the host is
   started (a bare terminal invocation, the bench harness's own direct
   spawn with its own scratch `ROBOT_CONSOLE_STATE_DIR`, or the new
   `start` verb below), not only when launched via `start`.
4. Add `packages/host/src/daemon/cli.ts` implementing, each as an
   injectable-deps function mirroring `cli.ts`'s own `CliDeps` seam
   (fake `spawn`, `readDaemonInfo`/`probeHostInfo`, `openBrowser`):
   - `runStart()`: read daemon-info; if present, check
     `isProcessAlive(pid)` — if dead, `removeDaemonInfo` (stale cleanup)
     and continue as "not running"; if alive, `probeHostInfo` its own
     `/api/host-info` to confirm identity — if confirmed, print
     "already running at `<url>`" and return (no spawn). If not running
     (absent, stale, or a non-identifying occupant that ticket 001's own
     `main()` would have already refused to start against), spawn
     `bin/robot-console.js` with `detached: true`, stdio redirected to
     `resolveDaemonLogFilePath()` (append mode), `.unref()`d, and wait
     (bounded, polling `readDaemonInfo`/`probeHostInfo`) for the child to
     report ready before returning its URL. Never passes `--port` (see
     sprint.md's Design Rationale, "daemon verbs manage exactly one
     instance, always the default port").
   - `runStop()`: read daemon-info; absent or `isProcessAlive` false →
     print "not running", clean up a stale file, exit 0 (not an error).
     Alive → `process.kill(pid, "SIGTERM")` (the same signal `cli.ts`'s
     existing handler already shuts down cleanly on — no new shutdown
     path needed), wait (bounded) for `isProcessAlive` to go false, then
     `removeDaemonInfo`.
   - `runStatus()`: read + validate daemon-info exactly like `runStart`'s
     first half; report running/not-running plus port/URL/uptime, or
     "not running" (cleaning up a stale file as a side effect, same as
     `runStart`).
   - `runOpen()`: read + validate daemon-info; if running, call
     `openBrowser` (reusing `cli.ts`'s existing `openInChrome`) at its
     local URL and print a LAN-shareable
     `http://<os.hostname()>.local:<port>` line; if not running, print
     "not running" pointing at `start` and do not open a browser.
5. Wire `bin/robot-console.js`'s own thin-shim caller (or `cli.ts`'s
   exported entry, whichever keeps the shim genuinely thin) to recognize
   `argv[0]` of `start`/`stop`/`status`/`open` and dispatch to
   `daemon/cli.ts` *before* any of today's flag parsing
   (`parsePortFlag`/`hasNoOpenFlag`/etc.) runs. Every other invocation
   (no subcommand, or any invocation starting with a `--flag`) is
   completely unchanged — this is additive dispatch, not a rewrite of
   `main()`'s existing argument handling.

## Acceptance Criteria

- [x] `start` against no running host spawns exactly one detached child,
      waits for it to report ready, and prints its URL; the parent
      `start` process itself exits promptly (does not block).
- [x] A second `start` call while the first is still running (same
      `ROBOT_CONSOLE_STATE_DIR`) reports "already running" and exits 0,
      and no second child process is ever spawned (asserted via the
      injected fake `spawn` never being called a second time).
- [x] `start` after the daemon process has been killed out from under it
      (simulated: write a daemon-info file with a PID that does not
      exist) detects the stale file, removes it, and starts fresh rather
      than falsely reporting "already running".
- [x] `stop` against a running daemon sends `SIGTERM`, waits for exit,
      and removes the daemon-info file; against no running daemon (or a
      stale one) it reports "not running" and exits 0.
- [x] `status` accurately reports running (with port/URL) or not
      running, cleaning up a stale daemon-info file as a side effect
      when found.
- [x] `open` against a running host opens a local browser at a working
      URL and prints a `<hostname>.local:<port>` line; against no
      running host it reports "not running" and does not call
      `openBrowser` at all.
- [x] None of `start`/`stop`/`status`/`open` accept or forward a
      `--port` flag; they always operate against the default-port daemon
      info.
- [x] The plain, no-subcommand invocation (today's existing behavior,
      including every flag `scripts/bench/layer2`/`layer3` already pass)
      is unaffected by this ticket, other than now also writing/removing
      a daemon-info file — verified against existing `cli.test.ts` cases
      plus a new one asserting daemon-info is written on start and
      removed on shutdown for the plain path too.
- [x] One real-process integration test (mirroring
      `scripts/bench/layer2`'s own pattern): spawn `bin/robot-console.js
      start` against a scratch `ROBOT_CONSOLE_STATE_DIR`, assert a second
      `start` against the same scratch dir attaches rather than
      double-spawning, then `stop` tears it down and the process is
      confirmed gone.

## Testing

- **Existing tests to run**: `npx vitest run packages/host/src/cli.test.ts packages/host/src/store`
- **New tests to write**:
  - `daemon/daemonInfo.test.ts`: read/write/remove round-trip,
    `isProcessAlive` for a real-vs-nonexistent PID, `probeHostInfo`
    against a fake fetch (success, timeout, malformed-response cases).
  - `daemon/cli.test.ts`: `runStart`/`runStop`/`runStatus`/`runOpen`
    against injected fakes for spawn/fs/fetch/openBrowser, covering every
    acceptance criterion above as a table-driven case.
  - One real-child-process integration test under
    `packages/host/src/daemon/` or alongside the existing bench harness
    (whichever this ticket's own programmer judges fits the existing
    layering better), scoped and self-cleaning like
    `scripts/bench/layer2`'s own real-process test.
- **Verification command**: `npx vitest run packages/host/src/cli.test.ts packages/host/src/daemon packages/host/src/store`
