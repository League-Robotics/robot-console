---
status: done
sprint: '014'
tickets:
- '002'
- '003'
---

# Host store: SQLite schema, typed operations, JSON importers, and the in-process change feed

## Description

All device and link state today is in-memory inside `deviceRegistry.ts`
(`states: Map<string, EndpointState>`, `deviceRegistry.ts:1306`), keyed
three ways (`usb-<serial>`, `wifi-<name>`, `<relay>-via-<name>`), with
the only persistence being two JSON files (`store/knownRobots.ts:226`,
`store/wifiCredentials.ts:409`). Seventeen distinct state holders and
four identity keys are inventoried in
`docs/reviews/2026-09-11/01-host-device-model.md` §1.

`docs/design/architecture.md` §4 defines the replacement: one SQLite
database in the existing state directory, keyed on the target chip id
(`FICR.DEVICEID[1]`), with `devices`, `links`, `services`, `sightings`,
`sessions`, `board_owner`, `relay_leases`, `firmware`, `settings`,
`tasks`, and `changes` tables. This issue builds that store and nothing
that uses it.

Stakeholder decisions (architecture §2): `node:sqlite` (`DatabaseSync`)
with `engines.node >= 22.13`; one connection in one process; the WiFi
gate is the `devices.owned` column set only by USB identification.

## Proposed resolution

- `packages/host/src/store/db.ts`: open/create `console.sqlite` under the
  state dir (reuse `resolveKnownRobotsFilePath`'s directory logic,
  `knownRobots.ts:208-228`), WAL, `busy_timeout`, `PRAGMA user_version`
  migrations, schema exactly as architecture §4.
- `packages/host/src/store/index.ts`: typed operations only; no SQL
  outside `store/`. Minimum set: `upsertDevice`, `setOwned`,
  `upsertLink`, `setLinkState`, `ageLinks(transport, ttl)`,
  `upsertService`, `recordSighting`, `openSession`/`updateSession`/`closeSession`,
  `acquireBoardOwner`/`releaseBoardOwner`, `acquireRelayLease`/`releaseRelayLease`,
  `setFirmware`, `getSetting`/`setSetting`, `heartbeat(task)`,
  `snapshotRows()` (the joins the projection needs).
- Every write appends a `changes` row inside the same transaction and
  emits `{seq, tbl, key}` on an in-process `EventEmitter`. Coalesce
  emits per macrotask so a burst of writes yields one event.
- One-time importers: `known-robots.json` → `devices` (`owned = 1`,
  `kind = 'robot'`, first/last seen, `usb_serial` from `lastUsbSerial`);
  `wifi-credentials.json` → `settings`. Files are left in place;
  import is idempotent.
- Name/serial consistency: `upsertDevice` asserts
  `deviceIdToName(id) === name` and refuses a mismatch with a typed error
  (protocol review §2 item 6 found a fixture where these disagree).
- Raise `engines.node` to `>=22.13` in root and `packages/host`
  `package.json`; add `@types/node` coverage for `node:sqlite` (root
  already pins `^26`).

## Acceptance

- `npm test` includes store tests: schema creation, migration from
  `user_version 0`, every typed operation, the change feed (one event
  per transaction burst), both importers against fixture JSON files,
  the name/serial assertion.
- A fresh host start with an existing `known-robots.json` yields
  `SELECT count(*) FROM devices WHERE owned = 1` equal to the file's
  entry count.
- No module outside `packages/host/src/store/` contains the string
  `prepare(` or `exec(`.

## Depends on

Nothing. Everything else in the rearchitecture depends on this.

## References

- `docs/design/architecture.md` §2, §4
- `docs/reviews/2026-09-11/01-host-device-model.md` §1, §4.4
- `docs/reviews/2026-09-11/03-host-server-flash-releases.md` §5 (binding choice, engines)
- `docs/reviews/2026-09-11/05-protocol.md` §5 (primary key rationale)
