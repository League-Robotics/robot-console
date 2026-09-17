---
id: '014'
title: Flash a farm robot over the mbdeploy _mbflash._tcp service (not only USB)
status: done
use-cases: []
depends-on:
- '013'
github-issue: ''
issue: ''
completes_issue: true
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Flash a farm robot over the mbdeploy _mbflash._tcp service (not only USB)

## Description

Stakeholder 2026-09-13: "We still need flash. We don't have a way to
flash the calibration software." The robots on the farm (vevov on
hodr, gopiv on loki, tigez on magni) have no USB link from this Mac,
and `server.ts`'s `runFlashTask` refuses any non-`usb` link, so the
Flash calibration firmware button (ticket 013) can never work for
them.

Each farm host's mbdeploy daemon advertises, per board, `_mbserial._tcp`
(already used) and `_mbflash._tcp`; the host already records both in
the `services` table (`mdnsWatcher.ts` upserts `_mbflash._tcp` rows
keyed by instance = robot name, TXT `uid`, `role`, `port`).

The flash wire protocol (Busboombot/mbdeploy `src/mbdeploy/remote.py`
`deploy_over_network`, `server.py` `serve_flash`):
- TCP to the flash service host:port.
- Send `FLASH <nbytes> sha256=<hex>\n` (optionally a `force-relay`
  token).
- Expect `OK send`.
- Send the raw hex bytes.
- Read lines: `LOG <text>` progress lines until a terminal
  `OK flashed` or `ERR ...` (`ERR busy`, `ERR relay refused — send
  force-relay`, `ERR flash disabled`, `ERR sha256 mismatch`,
  `ERR short payload`, `ERR auth required`).
- `INFO\n` → `OK {json}` identifies the board.
- Per-line read timeout ~30–90 s.

Known risk (pxt-nezha-diffdrive
`docs/knowledge/2026-09-02-wifi-transport-tovez.md`): a probe timeout
mid-flash can leave the board with no firmware; an immediate retry has
always succeeded.

This ticket adds a network flash path alongside the existing USB path
so the Configuration tab's Flash calibration firmware button (ticket
013) works for farm robots reachable only via `_mbflash._tcp`.

## Acceptance Criteria

- [x] `runFlashTask` accepts a flash for a device that has a current
      `_mbflash._tcp` service row (matched by instance name = device
      name, and TXT `uid` = device `usb_serial` when both are
      present), using a new `connect/mbflashClient.ts` implementing
      the protocol above (hex fetched/verified exactly as the USB path
      does), with `flash-progress` phases mapped from `LOG` lines
      (`fetching` → `verifying` → `writing` while LOG lines arrive →
      `resetting` → `reidentifying`) and `flash-result` from
      `OK flashed`/`ERR ...` (plain-worded).
- [x] The device's open mbserial session (if any) is closed before the
      flash and the link re-identified after (`reidentifying`), so
      `device.program` is fresh; the single-client bridge is not
      fought over (close ours first; `ERR busy` reported plainly).
- [x] `SnapshotLink.capabilities.flash` (projection.ts) is true for a
      `usb` link OR for a `mbserial`/`wifi` link whose device
      currently has an `_mbflash._tcp` service; the UI's flash trigger
      (ticket 013's Calibration firmware block) uses it, so farm
      robots get the button.
- [x] One retry on a mid-flash timeout before reporting failure, with
      the known "board may be left without firmware" note in the
      failure text.
- [x] Unit tests: mbflash client against a fake TCP server for the
      success path (LOG lines → OK flashed), each ERR line, sha
      mismatch, timeout+retry; projection capability; server routing
      by transport.
- [x] Evidence: `npx vitest run packages/host packages/ui`,
      `npm run typecheck`, `npm run build`,
      `npm run vite:build -w @robot-console/ui` green. NO real board
      is flashed by the implementer; the stakeholder performs the
      first real flash.

## Testing

- **Existing tests to run**: `packages/host` flash-task tests (USB
  path), `packages/host` projection tests, `packages/ui`
  `ConfigurationPage.test.tsx` (013's flash block), plus the full
  `packages/host` and `packages/ui` scoped runs.
- **New tests to write**: `mbflashClient` against a fake TCP server —
  success path (`LOG` lines then `OK flashed`), each documented `ERR`
  line, sha256 mismatch, a read timeout followed by one retry that
  then succeeds and one that then fails; `runFlashTask` routing a
  `mbserial`/`wifi`-linked device with an `_mbflash._tcp` service row
  to the new client instead of rejecting it; `SnapshotLink.capabilities.flash`
  true/false cases (usb link, mbserial link with a current service row,
  mbserial link with no/stale service row); the open-session-close +
  reidentify sequencing around a flash.
- **Verification command**: `npx vitest run packages/host packages/ui`;
  also `npm run typecheck`, `npm run build`,
  `npm run vite:build -w @robot-console/ui`.

## Implementation Plan

**Approach**: add a network flash client that speaks the mbdeploy
`_mbflash._tcp` protocol, and route `runFlashTask` to it when the
target device has no USB link but does have a current `_mbflash._tcp`
service row. Reuse the existing hex-fetch/verify logic and the
existing `flash-progress`/`flash-result` event shapes so the UI needs
no changes beyond the capability flag ticket 013 already reads.

**Files to create/modify**:
- `packages/host/src/connect/mbflashClient.ts` (new) — TCP client
  implementing `FLASH <nbytes> sha256=<hex>` / `OK send` / raw bytes /
  `LOG`/`OK flashed`/`ERR ...` line protocol, with per-line read
  timeouts and one retry on a mid-flash timeout.
- `packages/host/src/connect/usbFlashClient.ts` (or wherever the
  existing USB flash implementation lives) — extract the shared
  hex-fetch/verify step so both clients call the same code, not a
  duplicate.
- `packages/host/src/server.ts` (`runFlashTask`) — look up the
  device's current `_mbflash._tcp` service row (instance = device
  name, TXT `uid` = device `usb_serial` when both present) when no
  `usb` link exists; route to `mbflashClient`; close any open mbserial
  session for the device first, re-identify after via the normal
  connect path, mapping its progress into the existing
  `flash-progress`/`flash-result` phases (`fetching`, `verifying`,
  `writing`, `resetting`, `reidentifying`).
- `packages/host/src/projection.ts` — `SnapshotLink.capabilities.flash`
  true for `usb`, or for `mbserial`/`wifi` when the device has a
  current `_mbflash._tcp` service row.
- Associated `*.test.ts` files: `mbflashClient.test.ts` (new, fake TCP
  server), `server.test.ts` (routing by transport), `projection.test.ts`
  (capability flag cases).

**Testing plan**: scoped `npx vitest run packages/host packages/ui`
after each change; full evidence run (`vitest`, `typecheck`, `build`,
`vite:build -w @robot-console/ui`) before marking this ticket done. No
real board is flashed during implementation — the stakeholder performs
the first real farm flash once this lands.

**Documentation updates**: none anticipated beyond this ticket's own
completion notes.
