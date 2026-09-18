---
id: '001'
title: 'Invert EADDRINUSE: attach to an already-running default-port host instead
  of failing'
status: done
use-cases:
- SUC-002
depends-on: []
github-issue: ''
issue: shared-console-host-daemon-cli-and-discovery.md
completes_issue: true
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Invert EADDRINUSE: attach to an already-running default-port host instead of failing

## Description

Today `server.ts`'s `listen()` rejects `EADDRINUSE` with a message
telling the caller to pick a different port. For a shared singleton
this is backwards — it is the exact mechanism that let an "isolated"
second host (its own port, its own state dir) grab the real robot
`vevov` over WiFi within a minute during sprint 019 ticket 006. This
ticket inverts that semantic for the one case where it is actually a
singleton conflict — no explicit `--port`/`ROBOT_CONSOLE_PORT` was
given — while preserving today's exact hard-fail behavior for an
explicit port request (which the bench harness's own
`scripts/bench/layer2`/`layer3` rely on for their own run-isolated
ports; see sprint.md's Design Rationale, "Attach applies to the default
port only").

This ticket is foundational: it must land before ticket 002 (LAN
binding widens exposure, which should happen only once double-start is
already prevented) and ticket 003 (the daemon CLI's idempotent `start`
depends on this inversion's own signal).

Work:

1. In `server.ts`, add `export class PortInUseError extends Error {
   readonly host: string; readonly port: number; }` and have `listen()`
   reject with it (carrying `host`/`port`) instead of a plain `Error` on
   `EADDRINUSE`. `server.ts` makes no policy decision about what this
   means — it only reports the condition (see the module's own "no
   naming, framing, sequencing, or connection-policy logic of its own"
   boundary).
2. In `server.ts`'s `buildApp`, add `GET /api/host-info` (mounted
   unconditionally, alongside the existing static/SPA and `mountRoutes`
   routes — before the SPA catch-all, same ordering rule as
   `mountRoutes`) returning `{ok: true, service: "robot-console", port}`
   as JSON. This is the one small, additive identity contract the
   attach decision (and later, the daemon CLI's `status`/`start`) needs;
   it does not change behavior of any existing route.
3. In `cli.ts`'s `main()`, when `startServerFn` rejects with
   `PortInUseError`:
   - If an explicit `--port`/`ROBOT_CONSOLE_PORT` was given (`port !==
     undefined` from today's existing `parsePortFlag`/`parsePortEnv`),
     rethrow with today's exact existing message text (no behavior
     change for an explicit-port conflict).
   - Otherwise (the default-port case), `GET` the occupant's
     `http://127.0.0.1:<port>/api/host-info` (bounded timeout, a few
     seconds). If it answers `{ok: true, service: "robot-console", ...}`,
     log `robot-console: a host is already running at
     http://127.0.0.1:<port> -- attaching instead of starting a second
     one.`, optionally open a browser to it (respecting `--no-open`
     exactly as today), and return successfully (no throw, no
     `runtime`/`store`/watcher/reconciler of any kind constructed for
     this invocation).
   - If the probe times out, errors, or answers with anything else,
     rethrow the original-style "pass a different port" failure — the
     escape hatch for a genuine, non-robot-console conflict is
     preserved verbatim.
4. Make the probe function (`GET` + parse + bounded timeout) an
   injectable `CliDeps` field (mirroring every other `cli.ts`
   collaborator), defaulting to a real `fetch` call, so `cli.test.ts`
   never opens a real socket.

## Acceptance Criteria

- [x] `startServer` rejects `EADDRINUSE` with a `PortInUseError`
      carrying `{host, port}`, not a plain `Error` (unit test against
      the existing fake-listen seam in `server.test.ts`).
- [x] `GET /api/host-info` returns `{ok: true, service: "robot-console",
      port}` whether or not `packages/ui/dist` exists (the static-vs-
      fallback branch), and is registered before the SPA catch-all
      (a request to it never falls through to `index.html`).
- [x] `main()` with an explicit `--port` that hits `PortInUseError`
      rethrows byte-for-byte today's existing "pass a different port"
      message — no behavior change (regression test against
      `cli.test.ts`'s existing case for this).
- [x] `main()` with no `--port`, hitting `PortInUseError`, whose probe
      of the occupant's `/api/host-info` succeeds and identifies as
      `robot-console`, logs "already running... attaching", does not
      construct a `runtime`/call `startServer` a second time, and
      returns without throwing (verified via injected fake `startServer`
      that rejects once, and a fake probe that resolves positively).
- [x] Same scenario but the probe fails/times out or answers with
      something that does not identify as `robot-console`: `main()`
      rethrows a clear conflict error (not a false "already running").
- [x] No existing `cli.test.ts`/`server.test.ts` case regresses.

## Testing

- **Existing tests to run**: `npx vitest run packages/host/src/server.test.ts packages/host/src/cli.test.ts`
- **New tests to write**:
  - `server.test.ts`: `PortInUseError` shape/instanceof on `EADDRINUSE`;
    `GET /api/host-info` returns the expected JSON with and without a
    built `staticDir`, and is reachable ahead of the SPA catch-all.
  - `cli.test.ts`: explicit-`--port` conflict keeps today's message
    (regression); default-port conflict with a positive probe attaches
    and does not double-construct the runtime; default-port conflict
    with a negative/failed probe rethrows a clear conflict error.
- **Verification command**: `npx vitest run packages/host/src/server.test.ts packages/host/src/cli.test.ts`
