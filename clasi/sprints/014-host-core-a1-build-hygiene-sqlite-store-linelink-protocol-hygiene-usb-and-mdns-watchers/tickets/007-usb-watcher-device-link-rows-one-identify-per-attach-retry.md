---
id: '007'
title: 'USB watcher: device/link rows, one identify per attach, retry'
status: open
use-cases: [SUC-001, SUC-002, SUC-005, SUC-006]
depends-on: ['003', '006']
github-issue: ''
issue: rearch-02-usb-watcher-writes-rows-one-identify-per-attach.md
completes_issue: true
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# USB watcher: device/link rows, one identify per attach, retry

## Description

Build `packages/host/src/watchers/usbWatcher.ts`. Change
`diffDaplinkDevices` to emit `{updated}` when a serial's persona set
changes across polls (instead of remove+add). On `added`: take
`board_owner = 'naming'`, read the SWD name with a timeout, upsert
`devices` and `links(usb, discovered)`, release the owner, then call
`LineLink` directly (stubbed connector invocation — the real reconciler
lands in sprint 015) to identify with the boot-window retry (HELLO at
0/750/1500/2500 ms, 4 s total budget). On `removed`: `setLinkState(stale)`
and release any owner. On `updated`: patch the address only. Heartbeat a
`tasks` row every poll.

Mark the stubbed connector call site clearly (e.g.
`// TODO(rearch-05): replace with reconciler-scheduled connect`) per
`sprint.md`'s Design Rationale, so it isn't mistaken for the final
design.

Delivers SUC-001 and SUC-002 directly; exercises SUC-005's imported rows
by attaching live watcher state to them; is the primary producer for
SUC-006's bench verification.

## Acceptance Criteria

- [ ] With a fake enumerator reporting serial then HID one poll apart,
      the store shows one `devices` row, one `links` row, and exactly
      one HELLO sequence (probe counter = 1).
- [ ] A fake port whose open rejects twice then succeeds ends
      `connected`/identified without user action, with `fail_count = 2`.
- [ ] A fake port that answers HELLO only after 1.2 s ends identified
      with the banner; the old single-shot 3 s path is gone.
- [ ] SWD naming failure + working banner → `devices.owned = 1` for a
      robot banner (keyed by the banner's own serial field).
- [ ] `removed` → link `stale` within one poll; `board_owner` row gone.
- [ ] **Bench**: both **Vevov** and **Vittut** appear as device+link
      rows in the debug dump after identification (requires ticket 009
      to run this check, but the watcher itself must produce correct
      rows for real hardware — verify manually against real ports ahead
      of ticket 009/010).

## Testing

- **Existing tests to run**: `packages/host/src/store` (ticket 003) and
  `packages/host/src/link` (tickets 005/006) suites must still pass —
  this ticket only consumes them.
- **New tests to write**: fake-enumerator update-not-remove-add test;
  fake-port retry/backoff tests; boot-window retry test; SWD-failure
  fallback test; removal/aging test; `tasks` heartbeat test.
- **Verification command**: `npm test -- packages/host/src/watchers/usbWatcher`

## Implementation Plan

**Approach**: Change `diffDaplinkDevices` first (small, isolated,
testable against the existing enumerator harness), then build the
watcher task around it, calling into the store (ticket 003) and
LineLink (ticket 006) through their typed/public interfaces only.

**Files to create/modify**:
- `packages/host/src/devices.ts`: `diffDaplinkDevices` gains `updated`.
- `packages/host/src/watchers/usbWatcher.ts` (new).
- `packages/host/src/watchers/usbWatcher.test.ts` (new).

**Documentation updates**: none beyond the `TODO(rearch-05)` comment at
the stubbed connector call site.
