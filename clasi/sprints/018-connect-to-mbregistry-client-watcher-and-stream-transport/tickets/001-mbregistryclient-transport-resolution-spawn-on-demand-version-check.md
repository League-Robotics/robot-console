---
id: '001'
title: 'mbregistryClient: transport, resolution, spawn-on-demand, version check'
status: open
use-cases: [SUC-001]
depends-on: []
github-issue: ''
issue: use-mbregistry-for-boards-locks-and-flashing.md
completes_issue: true
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# mbregistryClient: transport, resolution, spawn-on-demand, version check

## Description

Build `mbregistryClient` (new, `packages/host/src/mbregistry/client.ts`):
a JSON-lines client over a Unix socket / named pipe / TCP connection,
plus the resolution/spawn fallback from `docs/design/
robot-console-integration.md` §4 (mbtools repo) and SUC-001. This is the
foundation every other ticket in this sprint builds on — no watcher or
stream adapter exists without it.

Resolution order (never mixed, first match wins):
1. `$ROBOT_CONSOLE_MBREGISTRY` (socket path, pipe name, or `host:port`) —
   if set, connect there and never spawn.
2. The standard client candidates — mirror mbtools
   `registry.paths.client_socket_candidates()`'s own order (this user's
   socket/pipe first, then the system one; Windows uses the fixed pipe
   name). Do not re-derive the platform paths independently — read them
   from mbtools's own documented locations
   (`docs/design/registry-api.md` transport section /
   `mbtools/src/mbtools/registry/paths.py`) since drift here would silently
   miss a running daemon.
3. A previously-spawned console-owned socket (this console's own prior
   spawn, e.g. `<console-state>/mbregistry/api.sock`).
4. Spawn `mbregistry run --instance <host>-console --socket <console-state>/mbregistry/api.sock
   --db <console-state>/mbregistry/devices.db --remote-port 0
   --peer-pub-port 0 --peer-snapshot-port 0 --pool-port 0 --names-port 0
   --no-peering --ready-json --exit-with-parent` (add `--peer-pub-port`/
   `--peer-snapshot-port`/`--pool-port`/`--names-port 0` only if the
   installed mbregistry's `--help` accepts them — verify against the real
   `mbtools/src/mbtools/registry/cli.py` flag list before wiring; do not
   assume flag names from the design doc alone). `mbregistry.shareBoards`
   (ticket 008) flips `--no-peering` off when true. Read the
   `{"ready":true,"instance":...,"socket":...,"ports":{...}}` line from
   stdout and connect using the ports/socket it reports.
5. If `mbregistry` isn't found via `$MBREGISTRY_BIN` then `PATH`, or its
   `--version`/equivalent is below `MIN_MBREGISTRY_VERSION` (a single
   declared constant in this module, commented as pending final pin from
   mbtools sprint 008 — see sprint.md Open Questions #1), fail startup
   with a message naming the required version. No direct-USB fallback.

Also: document the mbtools prerequisite in the project README (a short
paragraph: "requires mbtools >= X, install separately, not bundled").

## Acceptance Criteria

- [ ] `mbregistryClient` connects via each of the 4 resolution paths in
      isolation (unit tests with a fake socket/process, no real
      mbregistry).
- [ ] `$ROBOT_CONSOLE_MBREGISTRY` set → never spawns, even if unreachable
      (surfaces a clear connect error instead).
- [ ] No mbregistry running and nothing set → spawns one with
      `--exit-with-parent`; the client's own request/response calls
      (`list`, `lock`, `unlock`, `stream`, `watch`) work against the
      spawned instance's reported socket/ports.
- [ ] `mbregistry` missing from `$MBREGISTRY_BIN`/`PATH` → startup fails
      with a message naming `MIN_MBREGISTRY_VERSION`.
- [ ] Installed mbregistry below `MIN_MBREGISTRY_VERSION` → same clear
      failure, no spawn attempted.
- [ ] README documents mbtools as a separately-installed prerequisite.
- [ ] Every wire call (`list`/`find`/`lock`/`unlock`/`watch`/`stream`
      request lines) is typed against `docs/design/registry-api.md`'s
      documented shapes, not re-derived ad hoc.

## Implementation Plan

- **Approach**: one module exporting a `createMbregistryClient(deps?)`
  factory (injectable transport/spawn/env, mirroring this codebase's
  existing `ConnectorDeps`/`UsbWatcherDeps` convention) returning typed
  methods per op plus a `watch()` async iterator/event-emitter. Framing:
  newline-delimited JSON, one object per line — read via a small line
  reassembler (reuse `link/lineStream.ts`'s `LineReassembler` if its
  shape fits; otherwise a minimal local one, since this is JSON-lines,
  not the v6 protocol `LineReassembler` decodes).
- **Files to create**: `packages/host/src/mbregistry/client.ts`,
  `packages/host/src/mbregistry/client.test.ts`.
- **Files to modify**: `README.md` (prerequisite paragraph).
- **Testing plan**: fake JSON-lines server (a real `net.createServer`/
  `net.connect` loopback pair, or a Unix socket in a temp dir) for every
  resolution path and op; a fake `child_process.spawn` for the spawn
  path so no real mbregistry binary is required in CI (per sprint.md's
  Test Strategy constraint).
- **Documentation updates**: README prerequisite section.
