---
id: '006'
title: 'Reconciler link preference + runtime assembly: mbregistry in, usbWatcher/mDNS
  branches disabled'
status: open
use-cases: [SUC-002, SUC-004]
depends-on: ['002', '004', '005']
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
   (disabled, not deleted) and Sprint 019 deletes them together with
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

- [ ] `reconciler.test.ts`'s table-driven cases include an `mbregistry`
      link and assert it is chosen as preferred over `wifi`/`radio` in
      the scenarios that previously asserted `usb`'s priority.
- [ ] `runtime.ts` starts `mbregistryWatcher`, not `startUsbWatcher`, when
      mbregistry resolution succeeds.
- [ ] `mdnsWatcher` is started with `_mbserial`/`_mbrelay`/`_mbflash`
      browsing disabled; `_robotlink._tcp`/`_robotlink._udp` (WiFi) browsing
      is unchanged — a test asserts no `mbserial`/`mbrelay`/`services`
      rows appear for those three types while WiFi rows still do.
- [ ] `usbWatcher`'s own module and tests are untouched (still present,
      still passing) — this ticket disables its runtime wiring only.
- [ ] mbregistry resolution failure (ticket 001's error contract)
      surfaces as a startup failure, not a silent fallback to
      `usbWatcher`.
- [ ] Two `startRuntime` calls with different ports run independently
      without colliding (existing behavior, confirmed with a test if none
      exists).

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
