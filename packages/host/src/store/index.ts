/**
 * store/index.ts — the typed operations every other module writes the
 * console's state through. `db.ts` opens the connection and applies
 * migrations (ticket 002); this module is the only thing that turns raw
 * SQL into calls anything else may reach for. See `./README.md` for the
 * "no SQL outside store/" rule this file exists to satisfy, and
 * `docs/design/architecture.md` §4 for the schema every statement below
 * assumes verbatim.
 *
 * ## The change feed
 *
 * Every write below appends a row to `changes` (`seq`, `tbl`, `key`) in
 * the same transaction as its own table write, then queues
 * `{seq, tbl, key}` for emission. Queued entries are flushed as one
 * `"change"` event (an array, in `seq` order) on the next macrotask
 * (`setImmediate`), so a burst of writes within one synchronous turn —
 * or one microtask chain — coalesces into a single event rather than
 * one per write. Callers that want per-write granularity can inspect the
 * array; callers that only want "something changed" can ignore its
 * contents.
 *
 * ## Foreign keys are enforced
 *
 * `node:sqlite`'s `DatabaseSync` defaults `PRAGMA foreign_keys` to `ON`
 * (unlike stock SQLite/better-sqlite3, which default it off) — so
 * `links.device_id`, `sessions.link_id`, and `relay_leases.relay_link_id`
 * are real, enforced foreign keys. Callers must upsert the referenced
 * row first: `upsertDevice` before an `upsertLink` call that supplies
 * `deviceId`, and `upsertLink` before `openSession`/`acquireRelayLease`
 * for that same link id.
 *
 * ## Transactions
 *
 * Every typed write runs inside `BEGIN IMMEDIATE` / `COMMIT`, matching
 * `db.ts`'s own migration transactions: on failure the transaction (and
 * this write's `changes` row) rolls back and the error rethrows, and the
 * pending-change queue is never touched for a write that never
 * committed.
 *
 * ## Name/serial consistency
 *
 * `upsertDevice` asserts `deviceIdToName(id) === name` and throws a
 * {@link DeviceNameMismatchError} rather than silently writing a
 * self-contradictory row — see `docs/reviews/2026-09-11/05-protocol.md`
 * §2 item 6, which found exactly this disagreement in the RADIOBRIDGE
 * banner fixture (`getez` / `1779042496`, which actually decodes to
 * `gatav`).
 */
import type { DatabaseSync } from "node:sqlite";
import { EventEmitter } from "node:events";
import { deviceIdToName } from "@robot-console/protocol";
import { openStoreDb, type StoreDbOptions } from "./db.js";

/** Thrown by {@link Store.upsertDevice} when `deviceIdToName(id)` does
 * not equal the supplied `name` — a mis-radixed serial or an invented
 * fixture, never a value this store should persist as if it were
 * consistent. */
export class DeviceNameMismatchError extends Error {
  readonly id: number;
  /** The five-letter name that was supplied and rejected. Named
   * `deviceName`, not `name`, to avoid colliding with `Error.prototype.name`
   * (the error's own class-name-for-display, set below). */
  readonly deviceName: string;
  readonly expectedName: string;

  constructor(id: number, deviceName: string) {
    const expectedName = deviceIdToName(id);
    super(
      `devices.id ${id} decodes to name "${expectedName}" via deviceIdToName, ` +
        `not the supplied name "${deviceName}"`,
    );
    this.name = "DeviceNameMismatchError";
    this.id = id;
    this.deviceName = deviceName;
    this.expectedName = expectedName;
  }
}

export type DeviceKind = "robot" | "relay";
export type RadioSource = "override" | "registry" | null;
export type Transport = "usb" | "wifi" | "radio" | "mbrelay" | "mbserial";
export type LinkState =
  | "discovered"
  | "connectable"
  | "connecting"
  | "connected"
  | "unresponsive"
  | "failed"
  | "closed_by_user"
  | "stale";

export interface UpsertDeviceInput {
  id: number;
  name: string;
  kind: DeviceKind;
  role?: string | null;
  program?: string | null;
  version?: string | null;
  usbSerial?: string | null;
  radioChannel?: number | null;
  radioGroup?: number | null;
  radioSource?: RadioSource;
  /** Used as both `first_seen` and `last_seen` when this is a new row;
   * used as `last_seen` on every subsequent call. `first_seen` is never
   * touched once set. */
  at: number;
}

export interface UpsertLinkInput {
  id: string;
  transport: Transport;
  /** Serialized to JSON — shape depends on `transport` (architecture.md
   * §4: `{path,hidPath}` | `{host,port}` | `{relayLinkId,channel,group}`
   * | …). */
  address: unknown;
  deviceId?: number | null;
  /** Used as `state_since`/`last_seen` on insert; refreshes `last_seen`
   * (never `state_since` — that belongs to {@link Store.setLinkState})
   * on every subsequent call. */
  at: number;
}

export interface SetLinkStateInput {
  id: string;
  state: LinkState;
  at: number;
  reason?: string | null;
  nextRetryAt?: number | null;
  failCount?: number;
  userClosed?: boolean;
}

export interface UpsertServiceInput {
  instance: string;
  type: string;
  host?: string | null;
  port?: number | null;
  /** Serialized to JSON. */
  txt?: unknown;
  at: number;
}

export interface RecordSightingInput {
  deviceId?: number | null;
  name?: string | null;
  transport: Transport;
  viaLinkId?: string | null;
  at: number;
  ok: boolean;
  detail?: string | null;
}

export interface UpdateSessionInput {
  seq?: number | null;
  pending?: number | null;
  lastDone?: number | null;
  lastDoneReason?: string | null;
  robotStatus?: string | null;
  /** Serialized to JSON when provided. */
  functions?: unknown;
}

export interface SetFirmwareInput {
  kind: "relay" | "robot";
  repo?: string | null;
  tag?: string | null;
  available?: boolean | null;
  reason?: string | null;
  message?: string | null;
  etag?: string | null;
  checkedAt?: number | null;
}

export interface ChangeEvent {
  seq: number;
  tbl: string;
  key: string | null;
}

export type ChangeListener = (changes: readonly ChangeEvent[]) => void;

/** Raw rows from the tables SUC-006's debug dump (and, later, the
 * projection) reads. Columns are exactly the schema's own column names
 * — no camelCase translation — since this is a low-level snapshot, not
 * a typed read API; callers that need parsed `address`/`txt`/`functions`
 * JSON do that themselves. */
export interface StoreSnapshot {
  devices: Record<string, unknown>[];
  links: Record<string, unknown>[];
  services: Record<string, unknown>[];
  sessions: Record<string, unknown>[];
  tasks: Record<string, unknown>[];
}

/** One `devices` row, as {@link Store.reconcilerRows} needs it — just
 * enough for `connect/reconciler.ts`'s `plan()` to apply the `owned`
 * gate (architecture.md §4: "the reconciler never connects to
 * [a wifi/mbserial link whose device is not owned]"). */
export interface ReconcilerDeviceRow {
  readonly id: number;
  readonly kind: DeviceKind;
  readonly owned: boolean;
}

/** One `links` row, as {@link Store.reconcilerRows} needs it — typed and
 * camelCased (unlike {@link StoreSnapshot}, a low-level passthrough),
 * since the reconciler's `plan()` reasons over these fields by name.
 * `address` is parsed JSON, matching `connect/connector.ts`'s own
 * `LinkRow.address` contract (either shape is accepted downstream). */
export interface ReconcilerLinkRow {
  readonly id: string;
  readonly deviceId: number | null;
  readonly transport: Transport;
  readonly address: unknown;
  readonly state: LinkState;
  readonly nextRetryAt: number | null;
  readonly failCount: number;
  readonly userClosed: boolean;
}

/** One open `sessions` row — just the link it belongs to. `sessions`
 * holds exactly one row per currently-open link (this module's own doc
 * comment), so membership in this list is the reconciler's "is a
 * session open for this link" signal — more durable than `links.state
 * === 'connected'` alone, since a session stays open (`unresponsive`)
 * even after its link goes silent. */
export interface ReconcilerSessionRow {
  readonly linkId: string;
}

/** One `relay_leases` row. Exclusivity here is held only for the
 * duration of a connect *attempt* (`connect/connector.ts`'s own doc
 * comment, "acquire-then-always-release, not held for the session"),
 * so `owner` of the shape `session:<linkId>` names the link currently
 * *attempting* (or, before that lease is released, freshly holding) the
 * physical relay port — the reconciler combines this with
 * {@link ReconcilerSessionRow} to find a relay's current child across
 * its whole lifecycle: connecting (lease held, no session row yet),
 * connected (session row; lease already released), or gone (neither). */
export interface ReconcilerRelayLeaseRow {
  readonly relayLinkId: string;
  readonly owner: string;
}

/** The read model `connect/reconciler.ts`'s `plan()`/`planUserOpen`/
 * `planUserClose` need — devices, links, open sessions, and relay
 * leases, camelCased and typed (unlike {@link StoreSnapshot}, which
 * exists for the debug dump, not policy decisions). See
 * {@link Store.reconcilerRows}. */
export interface ReconcilerRows {
  readonly devices: readonly ReconcilerDeviceRow[];
  readonly links: readonly ReconcilerLinkRow[];
  readonly sessions: readonly ReconcilerSessionRow[];
  readonly relayLeases: readonly ReconcilerRelayLeaseRow[];
}

/** One `devices` row, as {@link Store.projectionRows} needs it —
 * `packages/host/src/projection.ts`'s `buildSnapshot` (sprint 015
 * ticket 004) reasons over every field a device carries, unlike
 * {@link ReconcilerDeviceRow}'s narrow `id`/`kind`/`owned` slice. */
export interface ProjectionDeviceRow {
  readonly id: number;
  readonly name: string;
  readonly kind: DeviceKind;
  readonly role: string | null;
  readonly program: string | null;
  readonly version: string | null;
  readonly radioChannel: number | null;
  readonly radioGroup: number | null;
  readonly radioSource: RadioSource;
  readonly owned: boolean;
  readonly lastSeen: number;
}

/** One `links` row, as {@link Store.projectionRows} needs it — every
 * column the projection reads, camelCased and (for `address`) parsed,
 * unlike {@link ReconcilerLinkRow}'s narrower policy-only slice. */
export interface ProjectionLinkRow {
  readonly id: string;
  readonly deviceId: number | null;
  readonly transport: Transport;
  readonly address: unknown;
  readonly state: LinkState;
  readonly stateReason: string | null;
  readonly stateSince: number;
  readonly lastSeen: number | null;
  readonly nextRetryAt: number | null;
  readonly failCount: number;
  readonly userClosed: boolean;
}

/** One `sessions` row, as {@link Store.projectionRows} needs it —
 * `robot_status`/`functions` are parsed from their stored JSON text (or
 * `null` if never set) rather than left as raw strings, since the
 * projection reads them structurally. */
export interface ProjectionSessionRow {
  readonly linkId: string;
  readonly seq: number | null;
  readonly pending: number | null;
  readonly lastDone: number | null;
  readonly lastDoneReason: string | null;
  readonly robotStatus: unknown;
  readonly functions: unknown;
}

/** One `relay_leases` row, as {@link Store.projectionRows} needs it —
 * same shape as {@link ReconcilerRelayLeaseRow}, declared separately so
 * a caller of one read model never accidentally depends on the other's
 * continued existence. */
export interface ProjectionRelayLeaseRow {
  readonly relayLinkId: string;
  readonly owner: string;
}

/** One `firmware` row, as {@link Store.projectionRows} needs it. */
export interface ProjectionFirmwareRow {
  readonly kind: "relay" | "robot";
  readonly repo: string | null;
  readonly tag: string | null;
  readonly available: boolean | null;
  readonly reason: string | null;
  readonly message: string | null;
}

/** One `tasks` row, as {@link Store.projectionRows} needs it. */
export interface ProjectionTaskRow {
  readonly name: string;
  readonly state: string;
  readonly heartbeatAt: number;
}

/** The `at` of the newest `sightings` row for one device — pre-aggregated
 * in SQL (`MAX(at) ... GROUP BY device_id`) rather than handing the
 * projection every raw `sightings` row to reduce itself, since only the
 * maximum is ever needed (`SnapshotDevice.lastChecked`). */
export interface ProjectionLastCheckedRow {
  readonly deviceId: number;
  readonly at: number;
}

/** The most recent successful *radio* sighting for one device —
 * `Store.radioSightings()`'s own row shape (ticket 016-002). Narrower
 * than {@link ProjectionLastCheckedRow} (which aggregates every
 * transport): `connect/relayBridger.ts`'s default-failover candidate
 * ordering ("robots with a recent radio sighting first" — sprint.md's
 * SUC-002) needs specifically a *radio* sighting, not the most recent
 * observation of any kind. */
export interface RadioSightingRow {
  readonly deviceId: number;
  readonly at: number;
}

/** The read model `projection.ts`'s `buildSnapshot` (sprint 015 ticket
 * 004) needs — devices, links, sessions, relay leases, firmware, tasks,
 * each device's most recent sighting time, and the stored WiFi
 * credentials, camelCased and typed (unlike {@link StoreSnapshot}, which
 * exists for the debug dump, and deliberately does not expose
 * `relay_leases`/`firmware`/`sightings` at all — see that interface's
 * own doc comment). A plain read, no transaction, mirroring {@link
 * Store.reconcilerRows}'s own "always re-derive, never cache" reasoning. */
export interface ProjectionRows {
  readonly devices: readonly ProjectionDeviceRow[];
  readonly links: readonly ProjectionLinkRow[];
  readonly sessions: readonly ProjectionSessionRow[];
  readonly relayLeases: readonly ProjectionRelayLeaseRow[];
  readonly firmware: readonly ProjectionFirmwareRow[];
  readonly tasks: readonly ProjectionTaskRow[];
  readonly lastChecked: readonly ProjectionLastCheckedRow[];
  /** Parsed `settings` row for the imported/stored WiFi network, or
   * `null` if none is stored. The `settings.key` this is stored under
   * (`"wifiCredentials"`) is duplicated here as a literal rather than
   * imported from `store/importers/wifiCredentials.ts`'s own
   * `WIFI_CREDENTIALS_SETTING_KEY` — importing it would point a
   * dependency from `store/index.ts` back at `store/importers/*`, which
   * itself depends on `store/index.ts` (a cycle). Mirrors
   * `wsMessages.ts`'s own `AddressSource` doc comment, which duplicates
   * a value across a module boundary for the same reason. */
  readonly wifiCredentials: { ssid: string; password: string } | null;
  /** `true`/`false` per relay link id that has ever completed a
   * lease-acquisition capability check (`watchers/relaySweeper.ts`'s own
   * `runOnePass`, ticket 016-007) -- `true` when that relay's most
   * recent `?`/status reply advertised rearch-12's non-persisting `!CGT`
   * tune (`caps: CGT`), `false` when it was checked and did not, and no
   * entry at all when no pass has completed against that link yet
   * (`projection.ts`'s `buildSnapshot` reports that third case as
   * `SnapshotRelay.sweep: null` -- "never yet detected" is a distinct,
   * honest answer from "detected off"). Read from `settings` rows keyed
   * `` `relaySweepFast:<relayLinkId>` `` -- that prefix is duplicated
   * here as a literal rather than imported from
   * `watchers/relaySweeper.ts`'s own `fastSweepSettingKey`, for the same
   * reason {@link wifiCredentials}'s own doc comment gives: importing it
   * would point a dependency from `store/index.ts` at a `watchers/*`
   * module, which itself depends on `store/index.ts` (a cycle). */
  readonly fastSweepByRelayLinkId: ReadonlyMap<string, boolean>;
}

function toJson(value: unknown): string | null {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

function toInt(value: boolean | undefined): number | null {
  return value === undefined ? null : value ? 1 : 0;
}

/**
 * The one object every watcher/reconciler/dump-CLI writes and reads the
 * console's SQLite state through. Owns the change-feed `EventEmitter`
 * and every prepared statement; construct via {@link openStore} (which
 * also opens/migrates the database) or directly with an already-open
 * `DatabaseSync` (tests, and `db.test.ts`-style fixtures).
 */
export class Store {
  private readonly db: DatabaseSync;
  private readonly emitter = new EventEmitter();
  private pendingChanges: ChangeEvent[] = [];
  private flushHandle: NodeJS.Immediate | null = null;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  // ---- devices ----------------------------------------------------

  upsertDevice(input: UpsertDeviceInput): void {
    const expectedName = deviceIdToName(input.id);
    if (expectedName !== input.name) {
      throw new DeviceNameMismatchError(input.id, input.name);
    }
    this.withChange(
      "devices",
      () => String(input.id),
      () => {
        this.db
          .prepare(
            `INSERT INTO devices
               (id, name, kind, role, program, version, usb_serial, radio_channel, radio_group, radio_source, owned, first_seen, last_seen)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
               name = excluded.name,
               kind = excluded.kind,
               role = COALESCE(excluded.role, devices.role),
               program = COALESCE(excluded.program, devices.program),
               version = COALESCE(excluded.version, devices.version),
               usb_serial = COALESCE(excluded.usb_serial, devices.usb_serial),
               radio_channel = COALESCE(excluded.radio_channel, devices.radio_channel),
               radio_group = COALESCE(excluded.radio_group, devices.radio_group),
               radio_source = COALESCE(excluded.radio_source, devices.radio_source),
               last_seen = excluded.last_seen`,
          )
          .run(
            input.id,
            input.name,
            input.kind,
            input.role ?? null,
            input.program ?? null,
            input.version ?? null,
            input.usbSerial ?? null,
            input.radioChannel ?? null,
            input.radioGroup ?? null,
            input.radioSource ?? null,
            input.at,
            input.at,
          );
      },
    );
  }

  /** Sets `devices.owned` — the WiFi gate (architecture.md §4). A no-op
   * if `id` has no row yet; callers upsert the device first. */
  setOwned(id: number, owned: boolean, at: number): void {
    this.withChange(
      "devices",
      () => String(id),
      () => {
        this.db.prepare("UPDATE devices SET owned = ?, last_seen = ? WHERE id = ?").run(owned ? 1 : 0, at, id);
      },
    );
  }

  /** Sets a device's radio address override — `radio_channel`,
   * `radio_group`, and `radio_source = 'override'` (sprint 015 ticket
   * 006). The one writer of an `"override"`-sourced radio address;
   * `projection.ts`'s `resolveRadio` reads these three columns back
   * verbatim once set. A no-op if `id` has no row yet — callers upsert
   * the device first (mirrors {@link setOwned}'s own contract). */
  setRadioOverride(id: number, channel: number, group: number): void {
    this.withChange(
      "devices",
      () => String(id),
      () => {
        this.db
          .prepare("UPDATE devices SET radio_channel = ?, radio_group = ?, radio_source = 'override' WHERE id = ?")
          .run(channel, group, id);
      },
    );
  }

  /** Clears a device's radio address override — `radio_channel`/
   * `radio_group`/`radio_source` all return to `NULL`, so the next read
   * falls back to the name-derived default (`projection.ts`'s
   * `resolveRadio`, `source: "derived"`). A no-op if `id` has no row. */
  clearRadioOverride(id: number): void {
    this.withChange(
      "devices",
      () => String(id),
      () => {
        this.db
          .prepare("UPDATE devices SET radio_channel = NULL, radio_group = NULL, radio_source = NULL WHERE id = ?")
          .run(id);
      },
    );
  }

  /**
   * Merges the placeholder `devices` row `fromId` into the real row
   * `intoId` and deletes `fromId` — sprint 015 ticket 003's known-robots
   * placeholder-device merge (SUC-003/SUC-004): `importKnownRobots`
   * (sprint 014) seeds a row keyed by a synthetic name-derived id, since
   * `known-robots.json` never stored the true chip id; once the real
   * device identifies (over USB, correlated by `usb_serial` — see
   * `connect/connector.ts`'s own caller), its rows must collapse into
   * one. `owned` is OR'd, `first_seen` takes the earlier of the two,
   * and `radio_channel`/`radio_group`/`radio_source` are filled from
   * `fromId` only where `intoId` does not already have them — the real
   * row's own already-set values are never clobbered.
   *
   * `node:sqlite` enforces `links.device_id REFERENCES devices(id)`
   * (this module's own doc comment, "Foreign keys are enforced"), so
   * every `links`/`sightings` row pointing at `fromId` is re-pointed to
   * `intoId` *before* `fromId` is deleted — never dropping either table's
   * rows, only their `device_id` (SUC-003/SUC-004: "no orphaned
   * links/sightings rows remain"). A no-op (rolls back, changes nothing)
   * if either id has no `devices` row, or if they are the same id.
   */
  mergeDevice(fromId: number, intoId: number, at: number): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (fromId === intoId) {
        this.db.exec("ROLLBACK");
        return;
      }
      type MergeableDeviceRow = {
        owned: number;
        first_seen: number;
        radio_channel: number | null;
        radio_group: number | null;
        radio_source: RadioSource;
      };
      const fromRow = this.db
        .prepare("SELECT owned, first_seen, radio_channel, radio_group, radio_source FROM devices WHERE id = ?")
        .get(fromId) as MergeableDeviceRow | undefined;
      const intoRow = this.db
        .prepare("SELECT owned, first_seen, radio_channel, radio_group, radio_source FROM devices WHERE id = ?")
        .get(intoId) as MergeableDeviceRow | undefined;
      if (!fromRow || !intoRow) {
        this.db.exec("ROLLBACK");
        return;
      }

      const owned = fromRow.owned !== 0 || intoRow.owned !== 0 ? 1 : 0;
      const firstSeen = Math.min(fromRow.first_seen, intoRow.first_seen);
      const radioChannel = intoRow.radio_channel ?? fromRow.radio_channel;
      const radioGroup = intoRow.radio_group ?? fromRow.radio_group;
      const radioSource = intoRow.radio_source ?? fromRow.radio_source;

      this.db
        .prepare(
          `UPDATE devices SET owned = ?, first_seen = ?, radio_channel = ?, radio_group = ?, radio_source = ?, last_seen = ?
           WHERE id = ?`,
        )
        .run(owned, firstSeen, radioChannel, radioGroup, radioSource, at, intoId);

      const linkRows = this.db.prepare("SELECT id FROM links WHERE device_id = ?").all(fromId) as Array<{ id: string }>;
      this.db.prepare("UPDATE links SET device_id = ? WHERE device_id = ?").run(intoId, fromId);

      const sightingRows = this.db.prepare("SELECT id FROM sightings WHERE device_id = ?").all(fromId) as Array<{
        id: number;
      }>;
      this.db.prepare("UPDATE sightings SET device_id = ? WHERE device_id = ?").run(intoId, fromId);

      this.db.prepare("DELETE FROM devices WHERE id = ?").run(fromId);

      const events: ChangeEvent[] = [
        { seq: this.insertChangeRow("devices", String(intoId)), tbl: "devices", key: String(intoId) },
        { seq: this.insertChangeRow("devices", String(fromId)), tbl: "devices", key: String(fromId) },
      ];
      for (const row of linkRows) {
        events.push({ seq: this.insertChangeRow("links", row.id), tbl: "links", key: row.id });
      }
      for (const row of sightingRows) {
        events.push({ seq: this.insertChangeRow("sightings", String(row.id)), tbl: "sightings", key: String(row.id) });
      }

      this.db.exec("COMMIT");
      this.pendingChanges.push(...events);
      this.scheduleFlush();
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * Deletes `id`'s `devices` row — sprint 015 ticket 005's `forget-device`
   * wire message (`wsMessages.ts`'s {@link ForgetDeviceMessage}, replacing
   * the retired `forget-known-robot`, which named its target by a
   * non-unique `name`). `links.device_id REFERENCES devices(id)` with no
   * `ON DELETE CASCADE` (this module's own doc comment, "Foreign keys are
   * enforced"), so every `links`/`sightings` row pointing at `id` is
   * re-pointed to `NULL` first — a link is a physical-port observation,
   * not owned by any one device identity, so forgetting the device
   * leaves the link row itself in place (an unnamed/un-owned link,
   * exactly like one that has never identified) rather than deleting it
   * too. A no-op if `id` has no row.
   */
  deleteDevice(id: number): void {
    this.withChange(
      "devices",
      () => String(id),
      () => {
        this.db.prepare("UPDATE links SET device_id = NULL WHERE device_id = ?").run(id);
        this.db.prepare("UPDATE sightings SET device_id = NULL WHERE device_id = ?").run(id);
        this.db.prepare("DELETE FROM devices WHERE id = ?").run(id);
      },
    );
  }

  // ---- links -------------------------------------------------------

  /** Records a watcher's observation of a link. On first sight, creates
   * the row in the `discovered` state (see architecture.md §5 for the
   * state machine `setLinkState` drives from there); on every later
   * call, refreshes `device_id`/`address`/`last_seen` only — state is
   * exclusively {@link setLinkState}'s concern. */
  upsertLink(input: UpsertLinkInput): void {
    const addressJson = JSON.stringify(input.address);
    this.withChange(
      "links",
      () => input.id,
      () => {
        this.db
          .prepare(
            `INSERT INTO links (id, device_id, transport, address, state, state_since, last_seen, fail_count, user_closed)
             VALUES (?, ?, ?, ?, 'discovered', ?, ?, 0, 0)
             ON CONFLICT(id) DO UPDATE SET
               device_id = COALESCE(excluded.device_id, links.device_id),
               address = excluded.address,
               last_seen = excluded.last_seen`,
          )
          .run(input.id, input.deviceId ?? null, input.transport, addressJson, input.at, input.at);
      },
    );
  }

  /** Transitions a link's state. The only writer of `links.state` —
   * `upsertLink` never touches it past a row's initial creation. */
  setLinkState(input: SetLinkStateInput): void {
    this.withChange(
      "links",
      () => input.id,
      () => {
        this.db
          .prepare(
            `UPDATE links SET
               state = ?,
               state_reason = ?,
               state_since = ?,
               next_retry_at = COALESCE(?, next_retry_at),
               fail_count = COALESCE(?, fail_count),
               user_closed = COALESCE(?, user_closed)
             WHERE id = ?`,
          )
          .run(
            input.state,
            input.reason ?? null,
            input.at,
            input.nextRetryAt ?? null,
            input.failCount ?? null,
            toInt(input.userClosed),
            input.id,
          );
      },
    );
  }

  /** Marks every link of `transport` whose `last_seen` is older than
   * `now - ttlMs` (and is not already `stale`) as `stale`. Returns the
   * number of links aged. One `changes` row (and one queued
   * {@link ChangeEvent}) per link aged, all in the same transaction. */
  ageLinks(transport: Transport, ttlMs: number, now: number): number {
    const cutoff = now - ttlMs;
    return this.withChangeBatch("links", () => {
      const stale = this.db
        .prepare(
          `SELECT id FROM links WHERE transport = ? AND state != 'stale' AND (last_seen IS NULL OR last_seen < ?)`,
        )
        .all(transport, cutoff) as Array<{ id: string }>;
      const stmt = this.db.prepare("UPDATE links SET state = 'stale', state_reason = 'ttl-expired', state_since = ? WHERE id = ?");
      const keys: (string | null)[] = [];
      for (const row of stale) {
        stmt.run(now, row.id);
        keys.push(row.id);
      }
      return keys;
    });
  }

  // ---- services ------------------------------------------------------

  upsertService(input: UpsertServiceInput): void {
    this.withChange(
      "services",
      () => `${input.instance}:${input.type}`,
      () => {
        this.db
          .prepare(
            `INSERT INTO services (instance, type, host, port, txt, first_seen, last_seen)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(instance, type) DO UPDATE SET
               host = excluded.host,
               port = excluded.port,
               txt = excluded.txt,
               last_seen = excluded.last_seen`,
          )
          .run(input.instance, input.type, input.host ?? null, input.port ?? null, toJson(input.txt), input.at, input.at);
      },
    );
  }

  /** Deletes every `services` row of `type` whose `last_seen` is older
   * than `now - ttlMs` (ticket 014-008: `mdnsWatcher.ts`'s aging pass,
   * `_mbflash._tcp`'s own TTL in particular, since that type writes only
   * a `services` row and has no `links` row for {@link ageLinks} to age).
   * Returns the number of rows deleted. One `changes` row (and one
   * queued {@link ChangeEvent}, keyed `instance:type` to match
   * {@link upsertService}'s own key shape) per row deleted, all in the
   * same transaction — mirrors {@link ageLinks}'s own batch-change
   * shape. */
  pruneServices(type: string, ttlMs: number, now: number): number {
    const cutoff = now - ttlMs;
    return this.withChangeBatch("services", () => {
      const stale = this.db
        .prepare(`SELECT instance FROM services WHERE type = ? AND (last_seen IS NULL OR last_seen < ?)`)
        .all(type, cutoff) as Array<{ instance: string }>;
      const stmt = this.db.prepare("DELETE FROM services WHERE instance = ? AND type = ?");
      const keys: (string | null)[] = [];
      for (const row of stale) {
        stmt.run(row.instance, type);
        keys.push(`${row.instance}:${type}`);
      }
      return keys;
    });
  }

  // ---- sightings -----------------------------------------------------

  /** Appends a probe result and returns its `sightings.id`. */
  recordSighting(input: RecordSightingInput): number {
    return this.withChange(
      "sightings",
      (id) => String(id),
      () => {
        const info = this.db
          .prepare(
            `INSERT INTO sightings (device_id, name, transport, via_link_id, at, ok, detail)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            input.deviceId ?? null,
            input.name ?? null,
            input.transport,
            input.viaLinkId ?? null,
            input.at,
            input.ok ? 1 : 0,
            input.detail ?? null,
          );
        return Number(info.lastInsertRowid);
      },
    );
  }

  /** Most recent successful (`ok = 1`) radio sighting per device — see
   * {@link RadioSightingRow}'s own doc comment for why this is narrower
   * than {@link ProjectionLastCheckedRow}. A plain read, no transaction,
   * same "always re-derive" reasoning as {@link reconcilerRows}. */
  radioSightings(): readonly RadioSightingRow[] {
    const rows = this.db
      .prepare(
        `SELECT device_id, MAX(at) AS at FROM sightings
         WHERE transport = 'radio' AND ok = 1 AND device_id IS NOT NULL
         GROUP BY device_id`,
      )
      .all() as Array<{ device_id: number; at: number }>;
    return rows.map((r) => ({ deviceId: r.device_id, at: r.at }));
  }

  // ---- sessions ------------------------------------------------------

  /** Opens (or re-opens) a session for `linkId`, clearing any prior
   * session's transient fields — a reopen is a fresh session, not a
   * continuation. */
  openSession(linkId: string, at: number): void {
    this.withChange(
      "sessions",
      () => linkId,
      () => {
        this.db
          .prepare(
            `INSERT INTO sessions (link_id, opened_at)
             VALUES (?, ?)
             ON CONFLICT(link_id) DO UPDATE SET
               opened_at = excluded.opened_at,
               seq = NULL, pending = NULL, last_done = NULL, last_done_reason = NULL,
               robot_status = NULL, functions = NULL`,
          )
          .run(linkId, at);
      },
    );
  }

  /** Merges the given fields into an open session; omitted fields are
   * left unchanged. A no-op if no session is open for `linkId`. */
  updateSession(linkId: string, patch: UpdateSessionInput): void {
    this.withChange(
      "sessions",
      () => linkId,
      () => {
        this.db
          .prepare(
            `UPDATE sessions SET
               seq = COALESCE(?, seq),
               pending = COALESCE(?, pending),
               last_done = COALESCE(?, last_done),
               last_done_reason = COALESCE(?, last_done_reason),
               robot_status = COALESCE(?, robot_status),
               functions = COALESCE(?, functions)
             WHERE link_id = ?`,
          )
          .run(
            patch.seq ?? null,
            patch.pending ?? null,
            patch.lastDone ?? null,
            patch.lastDoneReason ?? null,
            patch.robotStatus ?? null,
            toJson(patch.functions),
            linkId,
          );
      },
    );
  }

  /** Removes the session row for `linkId` — `sessions` holds one row
   * per *open* link (architecture.md §4), so closing means deleting it. */
  closeSession(linkId: string): void {
    this.withChange(
      "sessions",
      () => linkId,
      () => {
        this.db.prepare("DELETE FROM sessions WHERE link_id = ?").run(linkId);
      },
    );
  }

  // ---- board ownership / relay leases ---------------------------------

  /** Attempts to claim exclusive ownership of `usbSerial` for `owner`.
   * Idempotent when `owner` already holds it (refreshes `since`, and
   * queues one change); returns `false` — recording no change at all —
   * when another owner holds it. */
  acquireBoardOwner(usbSerial: string, owner: string, at: number): boolean {
    return this.withConditionalChange("board_owner", usbSerial, () => {
      this.db
        .prepare(
          `INSERT INTO board_owner (usb_serial, owner, since) VALUES (?, ?, ?)
           ON CONFLICT(usb_serial) DO UPDATE SET since = excluded.since WHERE board_owner.owner = excluded.owner`,
        )
        .run(usbSerial, owner, at);
      const row = this.db.prepare("SELECT owner FROM board_owner WHERE usb_serial = ?").get(usbSerial) as
        | { owner: string }
        | undefined;
      const acquired = row?.owner === owner;
      return { result: acquired, changed: acquired };
    });
  }

  /** Releases `usbSerial` if `owner` currently holds it. Returns whether
   * a row was actually deleted; records no change when it was not. */
  releaseBoardOwner(usbSerial: string, owner: string): boolean {
    return this.withConditionalChange("board_owner", usbSerial, () => {
      const info = this.db.prepare("DELETE FROM board_owner WHERE usb_serial = ? AND owner = ?").run(usbSerial, owner);
      const released = Number(info.changes) > 0;
      return { result: released, changed: released };
    });
  }

  /** Same acquire semantics as {@link acquireBoardOwner}, for a relay
   * link's lease. */
  acquireRelayLease(relayLinkId: string, owner: string, at: number): boolean {
    return this.withConditionalChange("relay_leases", relayLinkId, () => {
      this.db
        .prepare(
          `INSERT INTO relay_leases (relay_link_id, owner, since) VALUES (?, ?, ?)
           ON CONFLICT(relay_link_id) DO UPDATE SET since = excluded.since WHERE relay_leases.owner = excluded.owner`,
        )
        .run(relayLinkId, owner, at);
      const row = this.db.prepare("SELECT owner FROM relay_leases WHERE relay_link_id = ?").get(relayLinkId) as
        | { owner: string }
        | undefined;
      const acquired = row?.owner === owner;
      return { result: acquired, changed: acquired };
    });
  }

  /** Same release semantics as {@link releaseBoardOwner}, for a relay
   * link's lease. */
  releaseRelayLease(relayLinkId: string, owner: string): boolean {
    return this.withConditionalChange("relay_leases", relayLinkId, () => {
      const info = this.db
        .prepare("DELETE FROM relay_leases WHERE relay_link_id = ? AND owner = ?")
        .run(relayLinkId, owner);
      const released = Number(info.changes) > 0;
      return { result: released, changed: released };
    });
  }

  // ---- firmware / settings / tasks ------------------------------------

  setFirmware(input: SetFirmwareInput): void {
    this.withChange(
      "firmware",
      () => input.kind,
      () => {
        this.db
          .prepare(
            `INSERT INTO firmware (kind, repo, tag, available, reason, message, etag, checked_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(kind) DO UPDATE SET
               repo = excluded.repo, tag = excluded.tag, available = excluded.available,
               reason = excluded.reason, message = excluded.message, etag = excluded.etag,
               checked_at = excluded.checked_at`,
          )
          .run(
            input.kind,
            input.repo ?? null,
            input.tag ?? null,
            toInt(input.available ?? undefined),
            input.reason ?? null,
            input.message ?? null,
            input.etag ?? null,
            input.checkedAt ?? null,
          );
      },
    );
  }

  getSetting(key: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value;
  }

  setSetting(key: string, value: string): void {
    this.withChange(
      "settings",
      () => key,
      () => {
        this.db
          .prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
          .run(key, value);
      },
    );
  }

  /** Upserts a `tasks` row for `task` in state `"running"` with a fresh
   * heartbeat timestamp — the liveness signal a supervisor polls. */
  heartbeat(task: string, at: number, detail?: string | null): void {
    this.withChange(
      "tasks",
      () => task,
      () => {
        this.db
          .prepare(
            `INSERT INTO tasks (name, state, heartbeat_at, detail) VALUES (?, 'running', ?, ?)
             ON CONFLICT(name) DO UPDATE SET state = 'running', heartbeat_at = excluded.heartbeat_at, detail = excluded.detail`,
          )
          .run(task, at, detail ?? null);
      },
    );
  }

  // ---- snapshot / change feed -----------------------------------------

  /** Raw rows from every table the debug dump (SUC-006) and, later, the
   * projection read. See {@link StoreSnapshot}'s doc comment. */
  snapshotRows(): StoreSnapshot {
    const all = (table: string) => this.db.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[];
    return {
      devices: all("devices"),
      links: all("links"),
      services: all("services"),
      sessions: all("sessions"),
      tasks: all("tasks"),
    };
  }

  /** The typed, camelCased read model `connect/reconciler.ts`'s `plan()`
   * and its user-command counterparts need — see {@link ReconcilerRows}.
   * A plain read, no transaction: the reconciler always re-derives jobs
   * from a fresh read rather than caching, so a snapshot slightly
   * behind a just-queued (but not yet flushed) change event is fine —
   * the next change-feed tick reads again. */
  reconcilerRows(): ReconcilerRows {
    const devices = this.db.prepare("SELECT id, kind, owned FROM devices").all() as Array<{
      id: number;
      kind: DeviceKind;
      owned: number;
    }>;
    const links = this.db
      .prepare("SELECT id, device_id, transport, address, state, next_retry_at, fail_count, user_closed FROM links")
      .all() as Array<{
      id: string;
      device_id: number | null;
      transport: Transport;
      address: string;
      state: LinkState;
      next_retry_at: number | null;
      fail_count: number;
      user_closed: number;
    }>;
    const sessions = this.db.prepare("SELECT link_id FROM sessions").all() as Array<{ link_id: string }>;
    const relayLeases = this.db.prepare("SELECT relay_link_id, owner FROM relay_leases").all() as Array<{
      relay_link_id: string;
      owner: string;
    }>;
    return {
      devices: devices.map((d) => ({ id: d.id, kind: d.kind, owned: d.owned !== 0 })),
      links: links.map((l) => ({
        id: l.id,
        deviceId: l.device_id,
        transport: l.transport,
        address: JSON.parse(l.address) as unknown,
        state: l.state,
        nextRetryAt: l.next_retry_at,
        failCount: l.fail_count,
        userClosed: l.user_closed !== 0,
      })),
      sessions: sessions.map((s) => ({ linkId: s.link_id })),
      relayLeases: relayLeases.map((r) => ({ relayLinkId: r.relay_link_id, owner: r.owner })),
    };
  }

  /** The `settings.key` a stored WiFi network is imported/saved under —
   * see {@link ProjectionRows.wifiCredentials}'s own doc comment for why
   * this is a duplicated literal, not an import. */
  private static readonly WIFI_CREDENTIALS_SETTING_KEY = "wifiCredentials";

  /** The `settings.key` prefix `watchers/relaySweeper.ts`'s own
   * `fastSweepSettingKey(relayLinkId)` stores each relay's fast-sweep
   * capability flag under — see {@link ProjectionRows.fastSweepByRelayLinkId}'s
   * own doc comment for why this is a duplicated literal, not an import. */
  private static readonly FAST_SWEEP_SETTING_PREFIX = "relaySweepFast:";

  /** The typed, camelCased read model `projection.ts`'s `buildSnapshot`
   * needs — see {@link ProjectionRows}. */
  projectionRows(): ProjectionRows {
    const deviceRows = this.db
      .prepare(
        "SELECT id, name, kind, role, program, version, radio_channel, radio_group, radio_source, owned, last_seen FROM devices",
      )
      .all() as Array<{
      id: number;
      name: string;
      kind: DeviceKind;
      role: string | null;
      program: string | null;
      version: string | null;
      radio_channel: number | null;
      radio_group: number | null;
      radio_source: RadioSource;
      owned: number;
      last_seen: number;
    }>;

    const linkRows = this.db
      .prepare(
        `SELECT id, device_id, transport, address, state, state_reason, state_since, last_seen, next_retry_at, fail_count, user_closed
         FROM links`,
      )
      .all() as Array<{
      id: string;
      device_id: number | null;
      transport: Transport;
      address: string;
      state: LinkState;
      state_reason: string | null;
      state_since: number;
      last_seen: number | null;
      next_retry_at: number | null;
      fail_count: number;
      user_closed: number;
    }>;

    const sessionRows = this.db
      .prepare("SELECT link_id, seq, pending, last_done, last_done_reason, robot_status, functions FROM sessions")
      .all() as Array<{
      link_id: string;
      seq: number | null;
      pending: number | null;
      last_done: number | null;
      last_done_reason: string | null;
      robot_status: string | null;
      functions: string | null;
    }>;

    const relayLeaseRows = this.db.prepare("SELECT relay_link_id, owner FROM relay_leases").all() as Array<{
      relay_link_id: string;
      owner: string;
    }>;

    const firmwareRows = this.db
      .prepare("SELECT kind, repo, tag, available, reason, message FROM firmware")
      .all() as Array<{
      kind: "relay" | "robot";
      repo: string | null;
      tag: string | null;
      available: number | null;
      reason: string | null;
      message: string | null;
    }>;

    const taskRows = this.db.prepare("SELECT name, state, heartbeat_at FROM tasks").all() as Array<{
      name: string;
      state: string;
      heartbeat_at: number;
    }>;

    const lastCheckedRows = this.db
      .prepare("SELECT device_id, MAX(at) AS at FROM sightings WHERE device_id IS NOT NULL GROUP BY device_id")
      .all() as Array<{ device_id: number; at: number }>;

    const wifiSetting = this.getSetting(Store.WIFI_CREDENTIALS_SETTING_KEY);
    let wifiCredentials: { ssid: string; password: string } | null = null;
    if (wifiSetting !== undefined) {
      try {
        const parsed = JSON.parse(wifiSetting) as { ssid?: unknown; password?: unknown };
        if (typeof parsed.ssid === "string" && typeof parsed.password === "string") {
          wifiCredentials = { ssid: parsed.ssid, password: parsed.password };
        }
      } catch {
        wifiCredentials = null;
      }
    }

    const fastSweepSettingRows = this.db
      .prepare("SELECT key, value FROM settings WHERE key LIKE ?")
      .all(`${Store.FAST_SWEEP_SETTING_PREFIX}%`) as Array<{ key: string; value: string }>;
    const fastSweepByRelayLinkId = new Map<string, boolean>(
      fastSweepSettingRows.map((row) => [row.key.slice(Store.FAST_SWEEP_SETTING_PREFIX.length), row.value === "1"] as const),
    );

    return {
      devices: deviceRows.map((d) => ({
        id: d.id,
        name: d.name,
        kind: d.kind,
        role: d.role,
        program: d.program,
        version: d.version,
        radioChannel: d.radio_channel,
        radioGroup: d.radio_group,
        radioSource: d.radio_source,
        owned: d.owned !== 0,
        lastSeen: d.last_seen,
      })),
      links: linkRows.map((l) => ({
        id: l.id,
        deviceId: l.device_id,
        transport: l.transport,
        address: JSON.parse(l.address) as unknown,
        state: l.state,
        stateReason: l.state_reason,
        stateSince: l.state_since,
        lastSeen: l.last_seen,
        nextRetryAt: l.next_retry_at,
        failCount: l.fail_count,
        userClosed: l.user_closed !== 0,
      })),
      sessions: sessionRows.map((s) => ({
        linkId: s.link_id,
        seq: s.seq,
        pending: s.pending,
        lastDone: s.last_done,
        lastDoneReason: s.last_done_reason,
        robotStatus: s.robot_status !== null ? (JSON.parse(s.robot_status) as unknown) : null,
        functions: s.functions !== null ? (JSON.parse(s.functions) as unknown) : null,
      })),
      relayLeases: relayLeaseRows.map((r) => ({ relayLinkId: r.relay_link_id, owner: r.owner })),
      firmware: firmwareRows.map((f) => ({
        kind: f.kind,
        repo: f.repo,
        tag: f.tag,
        available: f.available === null ? null : f.available !== 0,
        reason: f.reason,
        message: f.message,
      })),
      tasks: taskRows.map((t) => ({ name: t.name, state: t.state, heartbeatAt: t.heartbeat_at })),
      lastChecked: lastCheckedRows.map((r) => ({ deviceId: r.device_id, at: r.at })),
      wifiCredentials,
      fastSweepByRelayLinkId,
    };
  }

  /** Subscribes to the coalesced change feed. Returns an unsubscribe
   * function. See this module's doc comment's "The change feed"
   * section. */
  onChange(listener: ChangeListener): () => void {
    this.emitter.on("change", listener);
    return () => {
      this.emitter.off("change", listener);
    };
  }

  /** Cancels any pending coalesced flush and closes the underlying
   * connection. Tests always call this so a run never leaves a WAL/SHM
   * file locked for the next one (mirrors `db.test.ts`'s own
   * discipline). */
  close(): void {
    if (this.flushHandle !== null) {
      clearImmediate(this.flushHandle);
      this.flushHandle = null;
    }
    this.pendingChanges = [];
    this.db.close();
  }

  // ---- internals -------------------------------------------------------

  /** Runs `fn` inside a transaction, appends one `changes` row for
   * `tbl`/the key `fn`'s result yields, queues the corresponding
   * {@link ChangeEvent}, and schedules the coalesced flush. Rolls back
   * (and never queues anything) if `fn` throws. */
  private withChange<T>(tbl: string, keyOf: (result: T) => string | null, fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      const key = keyOf(result);
      const seq = this.insertChangeRow(tbl, key);
      this.db.exec("COMMIT");
      this.pendingChanges.push({ seq, tbl, key });
      this.scheduleFlush();
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** Like {@link withChange}, but for an operation (e.g. {@link ageLinks})
   * that touches a variable number of rows in one call: `fn` returns the
   * list of keys it touched, and one `changes` row/{@link ChangeEvent}
   * is queued per key, all inside the same transaction. Returns the
   * number of keys. */
  private withChangeBatch(tbl: string, fn: () => (string | null)[]): number {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const keys = fn();
      const events: ChangeEvent[] = [];
      for (const key of keys) {
        events.push({ seq: this.insertChangeRow(tbl, key), tbl, key });
      }
      this.db.exec("COMMIT");
      this.pendingChanges.push(...events);
      this.scheduleFlush();
      return keys.length;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** Like {@link withChange}, but for an operation whose write may be a
   * no-op depending on data it reads mid-transaction (the
   * acquire/release board-owner and relay-lease pairs: a conflicting
   * owner means nothing actually changed). `fn` reports `changed`
   * itself; a `changes` row/{@link ChangeEvent} is queued only when it
   * is `true`. */
  private withConditionalChange<T>(
    tbl: string,
    key: string | null,
    fn: () => { result: T; changed: boolean },
  ): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const { result, changed } = fn();
      if (changed) {
        const seq = this.insertChangeRow(tbl, key);
        this.db.exec("COMMIT");
        this.pendingChanges.push({ seq, tbl, key });
        this.scheduleFlush();
      } else {
        this.db.exec("COMMIT");
      }
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private insertChangeRow(tbl: string, key: string | null): number {
    const info = this.db.prepare("INSERT INTO changes (tbl, key, at) VALUES (?, ?, ?)").run(tbl, key, Date.now());
    return Number(info.lastInsertRowid);
  }

  private scheduleFlush(): void {
    if (this.flushHandle !== null) {
      return;
    }
    this.flushHandle = setImmediate(() => {
      this.flushHandle = null;
      const batch = this.pendingChanges;
      this.pendingChanges = [];
      if (batch.length > 0) {
        this.emitter.emit("change", batch);
      }
    });
  }
}

/** Opens (creating/migrating as needed — see `db.ts`) the console's
 * store and wraps it as a {@link Store}. */
export function openStore(options: StoreDbOptions = {}): Store {
  return new Store(openStoreDb(options));
}
