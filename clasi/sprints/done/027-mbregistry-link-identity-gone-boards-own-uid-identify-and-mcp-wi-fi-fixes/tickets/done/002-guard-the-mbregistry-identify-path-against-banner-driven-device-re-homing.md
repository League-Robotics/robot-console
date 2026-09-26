---
id: '002'
title: Guard the mbregistry identify path against banner-driven device re-homing
status: done
use-cases:
- SUC-002
depends-on:
- '001'
github-issue: ''
issue: gone-mbregistry-board-link-is-reattributed-to-the-next-board-on-its-port.md
completes_issue: false
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Guard the mbregistry identify path against banner-driven device re-homing

## Description

`packages/host/src/connect/connector.ts`'s `attempt()` already refuses
to let a fresh banner overwrite a **`usb`** link's previously-known
`deviceId` (~line 1280):

```ts
if (link.transport === "usb" && link.deviceId !== undefined && link.deviceId !== null && link.deviceId !== banner.serial) {
  void lineLink.close();
  const swdName = deviceIdToName(link.deviceId);
  const err = new Error(
    `banner identity ${banner.name} disagrees with SWD name ${swdName} -- serial data corrupted, check the USB cable`,
  );
  recordFailure(store, link.id, err.message, now(), backoffCapMs);
  throw err;
}
```

This check exists because a banner read over a flaky connection can be
corrupted and must never be trusted over a link's own already-known
identity. The exact same hazard applies to `mbregistry`, by a different
mechanism: `link.id` is stable and keyed by UID (`mbregistry-<uid>`),
but the bytes on that stream come from whatever board mbtools currently
has physically attached to that UID's last-known port. Live bug
(`gone-mbregistry-board-link-is-reattributed-...md`): zugit's UID link
stayed open after zugit was unplugged and tigez took the same port; the
stream's banner decoded as "tigez"; `attempt()` had no guard for
`mbregistry`, so it upserted tigez's `deviceId` onto zugit's own
UID-keyed link (`store.upsertLink`'s `device_id = COALESCE(excluded
.device_id, links.device_id)` happily overwrites since the incoming
value is non-null), and tigez's card showed two mbregistry icons — one
correctly its own, one wrongly zugit's link now claiming to be tigez.

### What to change

Widen the existing guard's condition (do not write a second, parallel
check) so it also covers `link.transport === "mbregistry"`:

```ts
if (
  (link.transport === "usb" || link.transport === "mbregistry") &&
  link.deviceId !== undefined && link.deviceId !== null && link.deviceId !== banner.serial
) { ... }
```

The error message should stay accurate for the mbregistry case — it is
not "check the USB cable" for this transport; word it around the link's
own UID vs. the banner's disagreeing identity (e.g. `banner identity
${banner.name} disagrees with this link's own known device ${deviceIdToName(link.deviceId)} -- registry UID/port mismatch, not this device`).
Keep `recordFailure` (writes `failed` + backoff) for this specific
failure — a genuine identity disagreement should still surface as a
link failure a human can see, distinct from ticket 003's `not_found`
handling (a different failure shape, handled before this guard is ever
reached).

Do not touch the *first-identify* case: a link with no prior `deviceId`
(`undefined`/`null`) must continue to identify normally — the guard's
existing condition already only fires once a link has a prior identity
to disagree with, which is exactly right here too.

### Depends on ticket 001

`toConnectorLinkRow` (`reconciler.ts`) already threads `link.deviceId`
into the `LinkRow` `attempt()` sees, for exactly this purpose — no
wiring changes needed there. This ticket is written and tested against
ticket 001's `markGone`/poll-driven `stale` behavior already being in
place, so a link that should legitimately re-identify from scratch
(because it genuinely went stale and came back) is not accidentally
caught by this guard — `mbregistryWatcher.ts`'s own `promote` predicate
(ticket 001) already limits *its* writes to idle-state links; this
guard is the connector's independent check on the *banner* path, and
the two do not conflict, but ticket 001 must land first so this
ticket's tests reflect the real `stale`-then-revive lifecycle.

## Acceptance Criteria

- [x] `connect/connector.ts`'s deviceId-mismatch guard (~line 1280)
      covers `mbregistry` as well as `usb`.
- [x] A banner arriving on an mbregistry link whose store-known
      `deviceId` disagrees with the banner's own serial does not call
      `store.upsertDevice`/`store.upsertLink` with the new identity, and
      does not set `owned`/`connected` — it throws and records a
      failure via `recordFailure`, exactly like the existing usb case.
- [x] A first-time identify (link has no prior `deviceId`) on an
      mbregistry link is unaffected — still identifies normally.
- [x] A `deviceDisplay.test.ts`/`FrontPage`-level regression: with the
      guard in place, a link that would previously have been re-homed
      (a `stale` sibling under the wrong device) is not present in
      `cardLinks()` for the wrong device — confirming the "two icons on
      one card" symptom does not recur now that the write never
      happens. (`cardLinks` itself needs no code change — see
      sprint.md's Architecture, item 3.)
- [x] No real hardware or real mbregistry daemon in any new test —
      fakes only (a fake `ByteStream`/`LineLink` producing a banner
      line, or a direct unit test of the guard condition).

## Testing

- **Existing tests to run**: `connector.test.ts` (full file, to confirm
  the widened condition does not regress the existing `usb` cable-
  corruption case or any other identify path), `reconciler.test.ts`
  (confirm `toConnectorLinkRow`'s `deviceId` threading is unaffected).
- **New tests to write**: a `connector.test.ts` case — an mbregistry
  link row with a known `deviceId`, a fake stream that yields a banner
  with a *different* serial, asserting the identify call rejects, no
  `upsertLink`/`upsertDevice` call with the new identity, and
  `store.setLinkState`'s `failed` write happened via `recordFailure`.
  A `deviceDisplay.test.ts` case per the acceptance criterion above.
- **Verification command**: run the workspace's vitest scripts scoped
  to `packages/host/src/connect/connector.test.ts`,
  `packages/host/src/connect/reconciler.test.ts`, and
  `packages/ui/src/deviceDisplay.test.ts` — do not run the full suite
  (see sprint.md's Test Strategy on the two known pre-existing
  failures).
