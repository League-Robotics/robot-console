---
id: '002'
title: 'mbregistryWatcher: devices/links rows from list + watch'
status: open
use-cases: [SUC-002, SUC-003]
depends-on: ['001']
github-issue: ''
issue: use-mbregistry-for-boards-locks-and-flashing.md
completes_issue: true
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# mbregistryWatcher: devices/links rows from list + watch

## Description

Build `mbregistryWatcher` (new, `packages/host/src/watchers/mbregistryWatcher.ts`,
sibling to `usbWatcher.ts`/`mdnsWatcher.ts`, same `start.../stop()`
handle shape and `tasks` heartbeat convention — architecture.md §3 rule
5). Writes rows only, per architecture.md §3 rule 1 — never opens a lock
or a stream.

Flow (sprint.md Architecture, Step 3 and SUC-002/SUC-003):
1. On start, call `list` on the `mbregistryClient` (ticket 001); upsert a
   `devices` row and a `links` row (`transport: "mbregistry"`, `address:
   {endpoint, uid}`) per entry. `devices.id` comes from the registry's
   `serial_payload` (decoded chip id, matching how a banner identify
   derives it today); `devices.usb_serial` gets the registry `uid`; name
   from `device_name`.
2. Call `watch`; on `attach`/`detach`/`identity`/`lock_state`, update the
   matching rows (`detach` ages/marks the link the same way
   `usbWatcher.handleRemoved` does for a vanished board: `stale`, close
   any session, no owner to release since mbregistry owns exclusivity for
   this transport).
3. Call `mergeNamePlaceholderIfAny` (reuse `store/placeholderMerge.ts`
   directly, no fork) once a name is known, mirroring `usbWatcher.ts`'s
   own SWD-naming merge call — SUC-003.
4. Promote a newly-identified, owned link from `discovered` to
   `connectable` the same way `usbWatcher`/`mdnsWatcher` already do, so
   the reconciler's existing auto-connect logic (unchanged by this
   ticket) picks it up.

The "owned" rule (design doc §6 item 6): a device is owned by this
console if it was ever local to the mbregistry instance this console
uses (`host` is `NULL`/absent on that row from this instance's own
`list`), preserved even though `list` now returns the whole fleet.

## Acceptance Criteria

- [ ] `list` response rows become `devices`/`links(transport='mbregistry')`
      rows with the documented field mapping (uid→usb_serial,
      serial_payload→id, device_name→name).
- [ ] `watch` events (`attach`/`detach`/`identity`/`lock_state`) update
      the same rows without a full re-`list`.
- [ ] A board previously known by name (placeholder from
      `known-robots.json` or a different transport) merges into one row
      via `mergeNamePlaceholderIfAny` once mbregistry identifies it.
- [ ] The "owned" rule holds: only boards local to this console's own
      mbregistry instance are marked owned, even when `list` returns
      remote peers' boards too.
- [ ] A `detach` event ages/closes the link and any open session, exactly
      as `usbWatcher.handleRemoved` does today for USB.
- [ ] `tasks` row heartbeats every `list`/event cycle (a wedged watcher
      stays visible, per architecture.md §3 rule 5).
- [ ] No test in this ticket's suite requires a real mbregistry process —
      a fake JSON-lines server per sprint.md's Test Strategy.

## Implementation Plan

- **Approach**: mirror `usbWatcher.ts`'s injectable-deps shape
  (`MbregistryWatcherDeps` taking the client from ticket 001, `now`);
  reuse `store/placeholderMerge.ts` unmodified.
- **Files to create**: `packages/host/src/watchers/mbregistryWatcher.ts`,
  `packages/host/src/watchers/mbregistryWatcher.test.ts`.
- **Files to modify**: none outside the new files (wiring into
  `runtime.ts` is ticket 006, kept separate so this ticket's tests stay
  isolated to the watcher itself).
- **Testing plan**: fake `mbregistryClient` (from ticket 001's own test
  fixtures, or a hand-rolled fake matching its interface) driving
  `list`/`watch` scripted sequences; assert store rows, never events
  directly (matching every other watcher's own test convention per
  architecture.md §11).
- **Documentation updates**: none beyond code comments.
