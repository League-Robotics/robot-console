---
id: '002'
title: 'Firmware availability watcher: ETag, backoff, timeout, no-asset message'
status: done
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

- [x] `watchers/firmwareWatcher.ts` polls each firmware kind with
      `If-None-Match`, storing `etag` in the `firmware` row.
- [x] A `304` response leaves the row untouched and parses no response
      body.
- [x] A `403`/`429` response honours `Retry-After` when present and
      otherwise backs off exponentially, capped at 1 hour.
- [x] Every fetch has a 10 s `AbortSignal` timeout; a hung fetch aborts
      without blocking any other task, and the row's `reason` becomes
      `'network'`.
- [x] A `200` with a new tag updates the row exactly once per change.
- [x] The `no-asset` message names the assets actually found (e.g.
      "release v… has `nezha-robot-template-v….hex`; expected
      `MICROBIT.hex` and `MICROBIT.hex.txt`").
- [x] Optional `GITHUB_TOKEN` (env or `settings`) is sent as a bearer
      header when present, absent otherwise, and never appears in any
      `notice` or log line.
- [x] `FirmwareAvailabilityCache` is deleted.
- [x] `fetchAndVerifyHex` (used by the flash path) keeps the same
      abort/timeout behavior.
- [x] The task has a `tasks` row with a heartbeat per architecture.md
      §3 rule 5.

## Implementation notes

- **New module** `packages/host/src/watchers/firmwareWatcher.ts` +
  `firmwareWatcher.test.ts`: per-kind (`relay`/`robot`) independent
  self-rescheduling poll (`setTimeout`, not a shared `setInterval`, so a
  403/429 backoff on one kind never delays the other). Reuses
  `releases.ts`'s `resolveRelease` verbatim for the actual release
  resolution/parsing; this module's own job is entirely the
  conditional-GET/header/timeout wrapper *around* that call.
- **ETag/304**: `Store.getFirmwareEtag(kind)` (new, small typed read —
  `etag` is deliberately not part of `ProjectionFirmwareRow`/the wire
  contract) supplies `If-None-Match`. A `304` is detected via a small
  side-channel `CapturedResponse` object a custom fetch wrapper
  populates from the raw response's `status`/`etag`/`retry-after`
  headers — `releases.ts`'s own `ReleasesFetchResponse` stays
  unmodified/narrow; a local `FirmwareHttpResponse` (this module's own
  type) widens it with an optional `headers` reader. Because a non-ok,
  non-404 status (304 included) makes `resolveRelease` return its
  generic `{reason:"network"}` *without ever calling `.json()`*, "parses
  no response body" falls out for free — this watcher just skips the
  store write for that poll instead of surfacing that generic message.
- **403/429**: detected the same way; schedules the next poll from
  `Retry-After` (seconds or an HTTP-date) when present, otherwise
  doubles a per-kind backoff counter capped at
  `DEFAULT_MAX_BACKOFF_MS` (1h). Deliberately **never overwrites the
  firmware row** on a rate-limit response — the exact "every host in a
  classroom reports network and disables flash" failure mode this
  ticket exists to prevent.
- **Timeout**: `withTimeout` wraps every fetch in an `AbortController` +
  `setTimeout(DEFAULT_FETCH_TIMEOUT_MS)` (10s default, overridable);
  `resolveRelease`'s own existing catch turns the resulting abort into
  `{reason:"network"}` — no new throw path. Verified in
  `firmwareWatcher.test.ts` that a hung fetch aborts at the timeout
  without blocking an unrelated concurrent timer.
- **Write-only-on-change**: relies primarily on the ETag/304 mechanism
  itself, plus a small in-memory per-kind dedupe (`lastWritten`,
  excluding `etag`/`checkedAt`) as a second line of defense for the one
  case ETag can't cover — a repeated `404` (`no-releases`/
  `tag-not-found`), which carries no `ETag` to conditionally-GET
  against.
- **No-asset message**: `releases.ts`'s `resolveRelease` now lists the
  asset name(s) actually found (`release vX has "found.hex"; expected
  "MICROBIT.hex" and "MICROBIT.hex.txt"`), fixing the linked
  `host-rejects-robot-template-release-asset-naming.md` step 3 for both
  the watcher and the flash path (same function, same message).
- **`GITHUB_TOKEN`**: resolved once at watcher construction, env
  (`deps.env.GITHUB_TOKEN`) over `settings` key `github.token`
  (`GITHUB_TOKEN_SETTINGS_KEY`), sent only as the request's
  `Authorization: Bearer <token>` header — never placed in any written
  `firmware.message`/`reason`, notice, or log line. Verified with tests
  asserting the token never appears in any written row/task JSON.
- **`releases.ts`**: trimmed to the pure functions only —
  `FirmwareAvailabilityCache`, `FirmwareStatusMap`,
  `FirmwareAvailabilityChecker`/`Listener`,
  `DEFAULT_AVAILABILITY_POLL_INTERVAL_MS`, and the config-hot-reload
  path are all deleted, per `sprint.md`'s own "importer becomes the
  only way settings' firmware keys change short of a restart"
  simplification. `resolveRelease`/`fetchAndVerifyHex`/
  `checkAvailability`/`parseGithubReleaseBody`/`extractManifestSha256`
  are otherwise byte-for-byte unchanged (only the no-asset message
  text changed) — `fetchAndVerifyHex`'s abort/timeout behavior (none of
  its own; caller-injectable via `options.fetch`, unchanged) is
  therefore preserved automatically.
- **`runtime.ts`**: composes `startFirmwareWatcher` exactly like
  `startUsbWatcher`/`startMdnsWatcher` (construct, no explicit
  `start()` — it starts polling synchronously in its constructor same
  as the other two — and `stop()` in the reverse-order teardown).
- **`server.ts`**: no longer constructs, polls, or tears down any
  firmware cache — `firmwareConfig` is kept only for resolving a
  `flash-start` release source; the `firmware` rows the watcher writes
  reach the browser through the server's pre-existing
  `store.onChange` → `broadcastSnapshot()` subscription, with no
  firmware-specific glue left in this file. `StartServerOptions
  .availabilityCache` is removed.
- **`docs/design/architecture.md` §6.4**: already described this
  design; confirmed it matches, no doc edit needed.
- Not part of this ticket's scope (left untouched, per plan):
  `store/migrations/` — the `firmware` table already had `etag`/
  `checked_at` columns from migration 0001, so no new migration was
  needed.

### Test commands (foreground)

- `npx vitest run packages/host/src/watchers packages/host/src/releases.test.ts packages/host/src/server.test.ts packages/host/src/runtime.test.ts packages/host/src/store packages/host/src/projection.test.ts`
  → 16 files, 245 tests passed.
- `npm run typecheck` → exit 0 (protocol + host build, `tsc --noEmit`
  for protocol/host/ui).
- UI suite not run: `FirmwareAvailability`'s wire shape is unchanged
  (only its doc comment was updated to point at the new module).

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
