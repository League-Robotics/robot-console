---
id: '005'
title: Thin server, runtime composition root, and process signal handling
status: open
use-cases:
- SUC-005
- SUC-006
- SUC-010
depends-on:
- '004'
github-issue: ''
issue: rearch-06-snapshot-wire-contract-and-thin-server.md
completes_issue: true
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Thin server, runtime composition root, and process signal handling

## Description

Rewrite `server.ts` as a thin broadcast-and-dispatch layer and add
`runtime.ts` as the one place that composes the whole host. This is the
ticket that finally removes `server.ts:235`'s inline
`new DeviceRegistry(...)` — the last reference to the deleted class from
ticket 003 — and makes production startup exercise the store and
watchers for the first time (today only `--watch-store` does).

- `packages/host/src/runtime.ts` (new): `startRuntime(options)` calls
  `openStoreWithImports`, `startUsbWatcher`, `startMdnsWatcher`,
  constructs the reconciler (ticket 002) against the store, and returns
  `{store, stop()}`. This is the seam `cli.ts`'s `main()` now calls
  instead of going straight to `startServer`.
- `server.ts`: `startServer({store, runtime})` — no longer constructs
  watchers or a registry. One change-feed subscription → coalesced
  `snapshot` broadcast (ticket 004's `buildSnapshot`). A
  `Map<type, handler>` for client commands: connection-affecting
  commands (`session-open`/`session-close`) forward to the reconciler's
  public job-submission API; everything else (`send-command`, `flash-*`,
  `wifi-*`) keeps today's direct-to-link behavior. Each handler is
  awaited with a `try/catch` that emits a `notice` on failure. Per-socket
  `error` handler (a socket that errors is dropped, not the process);
  `maxPayload` on the `WebSocketServer`; a `bufferedAmount` guard that
  drops `line`/`telemetry` (never `snapshot`) for a stalled client;
  request ids echoed on unicast replies. `close()` unsubscribes
  everything, including `unsubscribeTelemetry()` (missing today per
  `03-host-server-flash-releases.md` §1).
- `cli.ts`: `main()`'s production path calls `startRuntime` then
  `startServer({store: runtime.store, runtime})` instead of
  `startServer({port, firmwareConfig})` directly. Add `SIGINT`/`SIGTERM`
  handling: `server.close()` → `runtime.stop()` → exit 0. An in-flight
  flash must finish or abort cleanly and close the serial port before
  exit. Retire the `--watch-store` flag (superseded by real production
  startup exercising the same watchers) but keep `--dump-store` (still a
  useful, deliberately throwaway read-only affordance per sprint 014's
  own rationale).
- `index.ts`: keep exporting the wire types from one place for the UI's
  type import.

## Acceptance Criteria

- [ ] Golden test: a burst of ten store writes in one tick produces one
      `snapshot` broadcast, not ten.
- [ ] A socket that emits `error` does not terminate the host process
      (test with a fake socket that throws).
- [ ] A client whose `bufferedAmount` exceeds the threshold stops
      receiving `line`/`telemetry` but still receives the next
      `snapshot`.
- [ ] `kill -INT`/`SIGTERM` during a fake flash lets the flash finish or
      abort cleanly and closes the serial port before exit.
- [ ] Production startup (`main()`'s non-flag path) now calls
      `openStoreWithImports` and starts both watchers — verified by a
      `cli.test.ts` case asserting `startRuntime`'s dependencies are
      invoked, not by manually re-running `--watch-store`.
- [ ] `--watch-store` is removed from `cli.ts`; `--dump-store` remains.
- [ ] `grep -r "new DeviceRegistry" packages/host/src` returns nothing.
- [ ] `packages/host` compiles and its scoped test run is green — this
      is the first point since ticket 003 where `server.ts`/`cli.ts`
      compile again. Per `.claude/rules/source-code.md`, the *full*
      monorepo suite is a `close_sprint`-time gate, not a per-ticket
      one; ticket 011's bench/verification ticket is where that full run
      happens.

## Implementation Plan

**Approach**: `runtime.ts` first (pure composition, easily tested with
fakes for each dependency, mirroring `cli.ts`'s existing `CliDeps`
injectable-seam convention), then rewrite `server.ts` against it, then
wire `cli.ts`.

**Files to create**:
- `packages/host/src/runtime.ts`, `runtime.test.ts`

**Files to modify**:
- `packages/host/src/server.ts` (rewrite; remove `DeviceRegistry`
  construction, add per-socket guards and signal-safe `close()`)
- `packages/host/src/cli.ts` (wire to `runtime.ts`; add SIGINT/SIGTERM;
  remove `--watch-store`)
- `packages/host/src/index.ts` (re-export updated wire types)

**Testing plan**:
- Unit: `runtime.test.ts` with fake store/watcher/reconciler
  constructors.
- Integration: `server.test.ts` with a fake `WebSocketServer` — error
  handling, backpressure, signal-triggered shutdown mid-flash.
- Run: `npx vitest run packages/host/src` (scoped to the host package,
  per `.claude/rules/source-code.md` — not the full monorepo suite,
  which is a `close_sprint`-time gate).

**Documentation updates**: `packages/host/README.md` if it describes
the old startup sequence (`server.ts` constructing the registry
directly); update to describe `runtime.ts` as the composition root.
