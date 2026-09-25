---
id: '006'
title: 'Reconciler link preference + runtime assembly: mbregistry in, usbWatcher/mDNS
  branches disabled'
status: done
use-cases:
- SUC-002
- SUC-004
depends-on:
- '002'
- '004'
- '005'
github-issue: ''
issue: use-mbregistry-for-boards-locks-and-flashing.md
completes_issue: true
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Reconciler link preference + runtime assembly: mbregistry in, usbWatcher/mDNS branches disabled

## Description

Two related changes, kept in one ticket because they must land together
(the reconciler preferring `mbregistry` is meaningless until the old
paths stop competing for the same boards).

**Depends on ticket 005 (flash via mbregistry), not just 002/004**:
once `usbWatcher` stops running, any board only ever discoverable
through mbregistry has no `usb`-transport link for the existing
`server.ts#runFlashTask` dapjs path to find — flashing it would silently
break unless ticket 005's `mbregistry`-transport flash path has already
landed. This ticket must not disable `usbWatcher` before ticket 005 is
done; the dependency is declared in frontmatter, not left implicit.

1. **`connect/reconciler.ts`**: add `"mbregistry"` to
   `AUTO_CONNECT_TRANSPORTS`. Update the module doc comment's stated
   preference order — effective policy becomes `mbregistry > wifi >
   radio` once the disabled paths (below) stop producing `usb`/
   `mbserial`/`mbrelay` rows. Do not remove `usb`/`mbserial`/`mbrelay`
   from the `Transport` union or from `AUTO_CONNECT_TRANSPORTS` itself —
   only add the new member — since the old code paths still exist
   (disabled, not deleted) and Sprint 025 deletes them together with
   their transport values.
2. **`runtime.ts`**: construct `mbregistryClient` (ticket 001), start
   `mbregistryWatcher` (ticket 002) in place of `startUsbWatcher`, and
   start `mdnsWatcher` with a new option disabling its `_mbserial`/
   `_mbrelay`/`_mbflash` browses (additive constructor flag — e.g.
   `MdnsWatcherOptions.disabledTypes` — not a code deletion; WiFi
   `_robotlink.*` browsing is unaffected). Gate all of this behind
   mbregistryClient's successful resolution (ticket 001's SUC-001 error
   path): if resolution/spawn fails per that ticket's contract, startup
   fails the same way — do not silently fall back to starting
   `usbWatcher` instead (design doc §7: "no direct-USB fallback").

Also (design doc §6 item 7 / sprint.md Architecture, config.ts entry):
confirm the console's own port (`server.ts` `DEFAULT_PORT` /
`cli.ts --port`/`ROBOT_CONSOLE_PORT`) already supports two consoles
running on one machine — it does today per the existing `cli.ts`
implementation; add a short regression test if none currently exercises
"two `startRuntime` calls, two different ports, two independent stores"
end-to-end, since this is an explicit sprint success criterion
("Two robot-console instances can run on one machine on different
ports").

## Acceptance Criteria

- [x] `reconciler.test.ts`'s table-driven cases include an `mbregistry`
      link and assert it is chosen as preferred over `wifi`/`radio` in
      the scenarios that previously asserted `usb`'s priority.
- [x] `runtime.ts` starts `mbregistryWatcher`, not `startUsbWatcher`, when
      mbregistry resolution succeeds.
- [x] `mdnsWatcher` is started with `_mbserial`/`_mbrelay`/`_mbflash`
      browsing disabled; `_robotlink._tcp`/`_robotlink._udp` (WiFi) browsing
      is unchanged — a test asserts no `mbserial`/`mbrelay`/`services`
      rows appear for those three types while WiFi rows still do.
- [x] `usbWatcher`'s own module and tests are untouched (still present,
      still passing) — this ticket disables its runtime wiring only.
- [x] mbregistry resolution failure (ticket 001's error contract)
      surfaces as a startup failure, not a silent fallback to
      `usbWatcher`.
- [x] Two `startRuntime` calls with different ports run independently
      without colliding (existing behavior, confirmed with a test if none
      exists).

Extra acceptance criteria — closing three gaps flagged by earlier
tickets' own Implementation Notes, added here before work started so the
ticket record matches what was actually required:

- [x] **Runtime wiring of the real client** (flagged by 004's
      Implementation Notes and 005's Description): `runtime.ts` resolves/
      constructs the real `MbregistryClient` (ticket 001's
      `resolveMbregistryConnection`, via `createMbregistryClient`) and
      injects it into `ConnectorDeps` (`mbregistryClient`,
      `mbregistryLabel`, the default `createMbregistryStream`), into
      `startServer` options (`mbregistryClient`, `mbregistryLabel`,
      `flashViaMbregistry`), and into `mbregistryWatcher`. A sensible
      label is chosen (`<hostname> / robot-console`). A startup failure
      (mbregistry missing/too old) produces the clear error from ticket
      001, not a silent fallback.
- [x] **Pin the version**: `MIN_MBREGISTRY_VERSION = "0.20260924.7"` in
      `packages/host/src/mbregistry/client.ts` (mbtools sprint 008's own
      closing version, now on mbtools `main`). `checkMbregistryVersion`
      parses `mbregistry --version`'s exact `mbregistry 0.20260924.7\n`
      output; the spawn path also verifies the `--ready-json` line's own
      top-level `"version"` key against the same floor. Versions are
      compared numerically per dotted component, not lexicographically.
      Tests and the README prerequisite paragraph updated to name
      `0.20260924.7`.
- [x] **Watcher persists endpoint**: `mbregistryWatcher` writes the peer
      device's `endpoint` (and `host`) into the link address
      (`{endpoint, host, uid}`), sourced from `RegistryDevice.endpoint`/
      `.host` on a `list` entry, so connect/flash routing can use the
      stored row instead of a live `find()`; `server.ts`'s live `find()`
      is kept only as a fallback for a link row written before this
      ticket (no `host` key present at all).

## Implementation Notes (deviations from plan)

- **`startRuntime` is now `async`, returning `Promise<Runtime>`** —
  not stated in the plan, but unavoidable: resolving/spawning/connecting
  the mbregistry client (SUC-001's own contract) is genuinely
  asynchronous, and it must complete, successfully, before anything else
  in the composition (`startMbregistryWatcher`, `createConnector`) runs,
  with a rejection on failure rather than a caught-and-ignored error.
  `cli.ts#main()` now `await`s it; every `runtime.test.ts`/`cli.test.ts`
  call site was updated to match.
- **`Runtime` gained two new fields**, `mbregistryClient` and
  `mbregistryLabel` — needed so `cli.ts#main()` can forward the exact
  same already-connected client/label `startRuntime` resolved on to
  `startServer`'s own `mbregistryClient`/`mbregistryLabel` options,
  rather than `server.ts` re-resolving (or worse, never receiving) one.
- **`connect/connector.ts`'s default `createMbregistryStream` and
  `server.ts#runFlashTask`'s `mbregistry` branch now read `address.host`/
  `address.endpoint`** (this ticket's own "watcher persists endpoint"
  extra criterion) instead of only `address.uid` — closing the "wiring a
  real mbregistryClient in... is left for a later ticket" /
  "nothing... reads [endpoint] downstream today" gaps ticket 004's own
  Implementation Notes flagged. `MbregistryAddress` gained an optional
  `host` field; `host === undefined` (the key absent from the stored
  JSON entirely, not merely `null`) is `server.ts`'s own signal that a
  link row predates this ticket, and only then does it fall back to a
  live `mbregistryClient.find()`.
- **`StartRuntimeOptions.startUsbWatcher`/`usbWatcherDeps`/
  `usbWatcherOptions` are kept in the type, but production composition
  no longer calls them at all** — `usbWatcher.ts` and its own test suite
  are untouched, per the acceptance criterion; these three fields are
  simply dead in the composition body now (documented as such), left for
  Sprint 025 to remove outright alongside `usbWatcher.ts` itself, rather
  than churning `StartRuntimeOptions`'s public shape twice.
- **`mdnsWatcher.ts`'s new `disabledTypes` option is additive** (a
  `Set` gate before each of the three legacy types' own `subscribe()`
  call) — `_mbrelay`/`_mbserial`/`_mbflash` handling and their own
  existing tests are untouched; `runtime.ts` merges in the default-
  disabled set unless the caller's own `mdnsWatcherOptions.disabledTypes`
  overrides it.
- **`exactOptionalPropertyTypes: true`** (this project's own `tsconfig`)
  required building `MbregistryAddress`'s optional `host` field via
  conditional object spread (`...("host" in rec ? {host: ...} : {})`)
  rather than `host: cond ? value : undefined` — the latter fails to
  typecheck under that flag even though it fails only at `npm run
  typecheck`, not at `vitest run` (vitest/esbuild does not typecheck).
  Caught by running `npm run typecheck` after the scoped/full test runs,
  per this project's own `git-commits.md`/`source-code.md` rules
  expecting a clean build.
- **Two-port regression test** landed as two tests, not one: a focused
  `runtime.test.ts` case (`startRuntime -- two consoles on one machine`)
  confirming two `startRuntime` calls never share a store/reconciler/
  mbregistry client, plus a `server.test.ts` case
  (`server.ts: binding`) actually binding two real loopback HTTP servers
  on two different (`port: 0`-assigned) ports with two independent
  stores end-to-end — the sprint success criterion is about the server's
  own port binding, which `runtime.ts` itself does not own.

## Implementation Plan

- **Approach**: `runtime.ts`'s existing `StartRuntimeOptions` injectable-deps
  pattern already supports swapping `startUsbWatcher`/`startMdnsWatcher`
  factories — extend it with an `mbregistryClient`/`startMbregistryWatcher`
  pair and a boolean/derived flag controlling which watcher set actually
  starts, rather than a parallel code path that duplicates
  `startRuntime`'s own composition logic.
- **Files to modify**: `packages/host/src/runtime.ts`,
  `packages/host/src/runtime.test.ts`,
  `packages/host/src/connect/reconciler.ts`,
  `packages/host/src/connect/reconciler.test.ts`,
  `packages/host/src/watchers/mdnsWatcher.ts` (new `disabledTypes`
  option), `packages/host/src/watchers/mdnsWatcher.test.ts`.
- **Testing plan**: extend existing table-driven reconciler tests; extend
  `runtime.test.ts`'s existing fake-watcher-factory tests with an
  mbregistry-available and an mbregistry-unavailable case.
- **Documentation updates**: none beyond code comments; sprint.md already
  documents the "disable, don't delete" decision and its rationale.
