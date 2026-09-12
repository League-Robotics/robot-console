---
id: '002'
title: 'Firmware availability watcher: ETag, backoff, timeout, no-asset message'
status: in-progress
use-cases:
- SUC-002
depends-on:
- '001'
github-issue: ''
issue: rearch-13-firmware-availability-watcher-etag-backoff.md
completes_issue: true
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Firmware availability watcher: ETag, backoff, timeout, no-asset message

## Description

`releases.ts`'s pure fetch/verify functions are sound; the poller
around them is not. Unauthenticated polling with no `ETag`/backoff can
exhaust GitHub's 60 req/hr/IP limit for a classroom of hosts behind one
NAT within an hour, disabling every host's flash buttons. This ticket
replaces the ad hoc poller with `watchers/firmwareWatcher.ts`, a proper
task that reads firmware sources from `settings` (ticket 001), polls
with `If-None-Match`, honours `Retry-After` and backs off
exponentially on 403/429, bounds every fetch with a 10 s
`AbortSignal` timeout, and writes `firmware` rows only on change. It
deletes `FirmwareAvailabilityCache`, whose poller/config-reload/
projection-mixing responsibilities are no longer needed once the
projection reads `firmware` directly (already true since sprint 015).

## Acceptance Criteria

- [ ] `watchers/firmwareWatcher.ts` polls each firmware kind with
      `If-None-Match`, storing `etag` in the `firmware` row.
- [ ] A `304` response leaves the row untouched and parses no response
      body.
- [ ] A `403`/`429` response honours `Retry-After` when present and
      otherwise backs off exponentially, capped at 1 hour.
- [ ] Every fetch has a 10 s `AbortSignal` timeout; a hung fetch aborts
      without blocking any other task, and the row's `reason` becomes
      `'network'`.
- [ ] A `200` with a new tag updates the row exactly once per change.
- [ ] The `no-asset` message names the assets actually found (e.g.
      "release v… has `nezha-robot-template-v….hex`; expected
      `MICROBIT.hex` and `MICROBIT.hex.txt`").
- [ ] Optional `GITHUB_TOKEN` (env or `settings`) is sent as a bearer
      header when present, absent otherwise, and never appears in any
      `notice` or log line.
- [ ] `FirmwareAvailabilityCache` is deleted.
- [ ] `fetchAndVerifyHex` (used by the flash path) keeps the same
      abort/timeout behavior.
- [ ] The task has a `tasks` row with a heartbeat per architecture.md
      §3 rule 5.

## Implementation Plan

**Approach**: New watcher task modeled on the existing `usbWatcher.ts`/
`mdnsWatcher.ts` shape (`start()`/`stop()`, `tasks` heartbeat row).
Reuses `releases.ts`'s `resolveRelease`, `checkAvailability`,
`parseGithubReleaseBody`, `extractManifestSha256`, `fetchAndVerifyHex`
verbatim. Reads firmware sources via `getFirmwareConfig` (ticket 001,
now `settings`-backed).

**Files to create**:
- `packages/host/src/watchers/firmwareWatcher.ts`
- `packages/host/src/watchers/firmwareWatcher.test.ts`

**Files to modify**:
- `packages/host/src/releases.ts` — remove the poller/cache pieces
  being replaced; keep the pure functions.
- Delete `FirmwareAvailabilityCache` and its direct references
  (`server.ts` wiring, if any, points at the watcher/projection
  instead).

**Testing plan** (scoped vitest run: `watchers/firmwareWatcher.test.ts`,
existing `releases.test.ts`):
- Fake fetch: 304 → no row change, no body parse.
- Fake fetch: 403 + `Retry-After: 120` → next poll not before 120 s.
- Fake fetch: 200 with new tag → row updated once, one change-feed
  snapshot.
- Fake fetch that never resolves → aborted at timeout, row
  `reason='network'`, no other task blocked (assert via a concurrent
  fake task in the harness).
- `no-asset` fixture with one unexpected asset → message names it.
- Token present → `Authorization` header set; absent → not set; never
  logged (assert against a captured log/notice sink).

**Documentation updates**: `docs/design/architecture.md` §6.4 already
describes this; no doc change needed beyond confirming it matches.
