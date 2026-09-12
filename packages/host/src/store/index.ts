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
