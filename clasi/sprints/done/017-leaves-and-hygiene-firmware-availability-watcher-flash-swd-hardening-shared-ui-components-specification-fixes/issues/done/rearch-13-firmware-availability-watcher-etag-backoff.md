---
status: done
sprint: '017'
tickets:
- 017-002
---

# Firmware availability as a watcher task: ETag, optional token, backoff, and a useful no-asset message

## Description

`releases.ts`'s pure functions (`resolveRelease`, `fetchAndVerifyHex`,
`checkAvailability`, `parseGithubReleaseBody`, `extractManifestSha256`)
are sound and well tested. The poller around them is not
(`03-host-server-flash-releases.md` §3):

- Unauthenticated GitHub API polling, 2 requests / 5 min / host, no
  `ETag`/`If-None-Match`, no backoff on 403/429. A classroom of N hosts
  behind one NAT shares the **60 req/hr/IP** limit; 30 students ≈ 720
  req/hr → every host reports `network` and all flash buttons disable.
  Highest-impact finding in that file.
- No timeout or `AbortSignal` on any fetch; a hung connection blocks
  `pollOnce` and, via `runFlash`, the endpoint mutex.
- `FirmwareAvailabilityCache` mixes poller, config hot-reload, and status
  projection.
- Open issue `host-rejects-robot-template-release-asset-naming.md` step 3
  (list the assets that *were* found in the `no-asset` message) is still
  not implemented (`:288-290`).

## Proposed resolution

- `packages/host/src/watchers/firmwareWatcher.ts` task: per firmware
  kind, poll with `If-None-Match` (store `etag` in the `firmware` row;
  304 is free against the limit), honour `Retry-After`/back off
  exponentially on 403/429 up to 1 h, `AbortSignal` with a 10 s timeout
  on every fetch, write the `firmware` row on change only. Read firmware
  sources from `settings` (populated from `.env` by the importer;
  `config.ts` parsers stay).
- Optional `GITHUB_TOKEN` (env or `settings`) added as a bearer header
  when present; never logged.
- `no-asset` message lists the assets found: "release v… has
  `nezha-robot-template-v….hex`; expected `MICROBIT.hex` and
  `MICROBIT.hex.txt`".
- Delete `FirmwareAvailabilityCache`; the projection reads the `firmware`
  table.
- Keep `fetchAndVerifyHex` for the flash path, with the same abort/timeout.

## Acceptance

- Fake fetch returning 304 → no row change, no second request body
  parsed; returning 403 with `Retry-After: 120` → next poll not before
  120 s; returning 200 with new tag → row updated once, one snapshot.
- Fetch that never resolves → aborted at the timeout, row `reason =
  'network'`, no hang of any other task.
- `no-asset` fixture with one unexpected asset → message names it.
- Token present → `Authorization` header set; token absent → not set;
  token never appears in any `notice` or log line.

## Depends on

rearch-01 (store), rearch-06 (projection reads `firmware`).

## References

- `docs/design/architecture.md` §6.4
- `docs/reviews/2026-09-11/03-host-server-flash-releases.md` §3
- `clasi/issues/host-rejects-robot-template-release-asset-naming.md`
