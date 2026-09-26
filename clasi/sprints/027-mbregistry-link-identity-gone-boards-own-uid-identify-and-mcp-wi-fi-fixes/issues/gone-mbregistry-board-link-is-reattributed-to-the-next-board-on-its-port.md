---
status: in-progress
sprint: '027'
tickets:
- 027-001
- 027-002
- 027-003
- 027-004
---

# A gone mbregistry board's link stays live, gets filed under whichever robot now sits on its port, and is used for flashing

## What the stakeholder sees

Tigez's card shows **two** mbregistry icons although the board is plugged
into exactly one port, and the registry (`mbregistry list`) shows one row
for it. Flashing Tigez from the flash pop-up fails with
`pyocd flash failed (exit -9)`.

## What is actually happening (observed live, 2026-09-25)

Two different micro:bits have used hodr's `/dev/ttyACM1`:

| UID (short) | registry name | registry state |
|---|---|---|
| `0f0a31a9` | zugit | `gone` / `disconnected` |
| `3b43773c` | tigez | `free` / `connected` |

1. Zugit's board was unplugged; tigez's board took the same port.
2. The console kept (or reopened) its session on
   `mbregistry-99063602000528200f0a31a97da7074e000000006e052820` (zugit's
   UID). The registry showed the lock
   `session … on 192.168.1.240 (gala / robot-console)` against the *gone*
   row.
3. Bytes on that stream came from whatever is on `/dev/ttyACM1` now, which is
   tigez (see the mbtools-side counterpart below). The banner said `tigez`,
   so the console attached zugit's UID link to device `tigez` (id
   3527777815) and showed it as connected, reporting tigez's ch52/grp179.
4. The flash pop-up picked that link. The host asked hodr's registry to
   flash UID `0f0a31a9`; pyOCD waited for a probe that is not attached,
   printed nothing, and mbtools' 60 s no-progress watchdog SIGKILLed it:
   `exit -9`. hodr's journal shows three attempts (20:04, 20:05, 20:08),
   each followed by `0f0a31a9 never re-enumerated after flash within
   timeout; marking known-blank`.
5. Closing the session (`closed_by_user`) does not remove the link from
   tigez's card. Its `lastSeen` kept advancing afterwards, so it reopened
   and was re-identified as tigez again.

## What should happen

- A link whose UID the registry reports as gone/disconnected must not be
  opened or kept open, and must not be offered for flashing.
- A link's identity is its UID. A banner arriving on UID X that names a
  robot whose registry row is a *different* UID is a mismatch to surface
  (or drop), not a reason to re-home the link under that robot.
- A gone board's link should leave the device card (or at least render as
  gone, never as a second live-looking mbregistry icon).
- The flash path must flash the robot's *current* board UID, and refuse a
  link whose UID is not currently present in the registry, with a clear
  message rather than a 60 s hang ending in `exit -9`.

## Related

- Uncommitted work on `main` (at time of filing) in
  `packages/host/src/watchers/mbregistryWatcher.ts` adds a 1 s
  `client.list()` poll that marks a link `stale` when its UID *disappears*
  from the list. That does not cover this case, because the gone UID stays
  **listed** with `state: disconnected`. Check who owns that work before
  building on it.
  Owner (robot-console-e6, out-of-process fix for "vevov on loki never
  shows"): the poll re-runs `upsertFromListEntry`'s disconnected→stale
  branch whenever an entry changes, marks a missing UID stale, and closes
  its session (`markGone()`). It does **not** touch re-homing a link's
  `device_id` to whichever banner answers (connector/identify path;
  `store.upsertLink` COALESCEs `device_id`), and it does not gate flashing
  on link state.
- Pointers from the sprint 024 author (robot-console-cd): ticket 024-010
  made a `disconnected` list entry stale only in the initial
  `upsertFromListEntry`. Attach/identity events or re-identifying on the
  port can re-promote or re-home the link, and there is no UID guard.
  Flash routing uses the link address `{endpoint, host, uid}`
  (`resolveFlashLinkTarget` / `resolveFlashPlan` in `server.ts`,
  `link/adapters/mbregistryStream.ts`), so a stale UID link flashes the
  missing board.
- mbtools counterpart: **fixed in mbtools commit 95c70bd** (not yet deployed
  to the Pis at filing). `lock`/`stream`/`flash` on a disconnected UID now
  fail fast with code `not_found`, message `"<uid> is not attached (last
  seen on <port>)"`, on both the local socket and remote TCP 7440. An open
  stream re-checks once a second that its UID is still on the same port and
  otherwise closes (the console sees EOF). Console-side contract: on stream
  EOF, re-lock **by UID** (never by port); treat `not_found` as "board gone"
  (link stale, no retry storm, not flashable).
- `mbregistry-own-uid-link-never-identifies.md`: tigez's own UID link
  failing to identify, the other half of the two-icon symptom.
