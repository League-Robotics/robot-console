---
status: done
sprint: '014'
tickets:
- 014-007
---

# USB watcher: write device and link rows; identify a board once per attach, with retry

## Description

`devices.ts`'s `DeviceWatcher` (1 s poll, `devices.ts:390`) is sound and
stays as the enumerator. What sits on top of it is not:

- The serial and HID personas of one board rarely enumerate in the same
  poll, and `diffDaplinkDevices` models a changed device as remove+add
  (`devices.ts:334-341, 356-358`). Result: two SWD reads, two port opens
  (two resets on macOS), two HELLOs, and a UI flap on every attach
  (`01-host-device-model.md` §2.1).
- `connect()` failure is terminal until the user clicks; there is no
  scheduled retry anywhere in the USB path (`deviceRegistry.ts:3249-3270`).
- On macOS the port open resets the board and HELLO is sent immediately
  into the 1–2 s boot window with one 3 s timeout, producing "connected,
  unresponsive" (`02-host-transport.md` §5 item 4).
- A SWD naming failure leaves `name: null`, so the board is never enrolled
  and never passes the WiFi gate (`01-host-device-model.md` §2.1 last item).

## Proposed resolution

- Change `diffDaplinkDevices` to emit `{ updated }` when a serial's
  persona set changes, alongside `added`/`removed`. Consumers treat
  `updated` as "refresh address, keep everything else".
- New `packages/host/src/watchers/usbWatcher.ts` task: on `added`, take
  `board_owner = 'naming'`, read the SWD name with a timeout, upsert
  `devices` (id from the SWD read; `owned` stays as-is until a robot
  banner/ID confirms `kind = 'robot'`, then `owned = 1`), upsert
  `links(usb, state = 'discovered', address = {path, hidPath})`,
  release the owner. On `removed`, `setLinkState(stale)` and release any
  owner. On `updated`, patch the address only.
- The watcher does **not** connect. The reconciler (issue 05) sees the
  `discovered` USB link and schedules the connector, which owns the
  boot-window retry: after open, HELLO at 0 ms, 750 ms, 1500 ms, 2500 ms
  until a banner or a 4 s total budget.
- A `usb` link whose connect fails goes `failed` with `next_retry_at`
  (backoff 1, 2, 4, … ≤ 30 s) while the board stays enumerated.
- If SWD naming fails, the link still connects; the banner's `serial`
  field supplies the device id and name (`banner.ts:60-81`), so a robot
  with a broken SWD path is still owned and gated correctly.
- Heartbeat a `tasks` row every poll.

## Acceptance

- With a fake enumerator that reports serial then HID one poll apart,
  the store shows one `devices` row, one `links` row, and one
  `sightings`/connect for that serial; a probe counter on the fake link
  shows exactly one HELLO sequence.
- A fake port whose open rejects twice then succeeds ends `connected`
  without user action, with `fail_count = 2`.
- A fake port that answers HELLO only after 1.2 s ends `connected` with
  the banner; the old single-shot 3 s path is gone.
- SWD failure + working banner → `devices.owned = 1` for a robot banner.
- `removed` → link `stale` within one poll; `board_owner` row gone.

## Depends on

rearch-01 (store). Connect behaviour lands with rearch-05; this issue may
stub the reconciler call with a direct connector invocation until then.

## References

- `docs/design/architecture.md` §6.1, §8
- `docs/reviews/2026-09-11/01-host-device-model.md` §2.1
- `docs/reviews/2026-09-11/02-host-transport.md` §5 items 4, 6
