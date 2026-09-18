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
 * `gatav`). Narrowed 2026-09-12 (ticket 017-005): the check is skipped
 * only when `id < 0 && kind === 'relay'` — a negative id is never a real
 * chip id, so it is unambiguously a synthetic id (e.g. `mdnsWatcher.ts`'s
 * hash-derived fallback for a non-grammar mDNS relay name) rather than a
 * mis-radixed serial. Every other row shape still enforces the check
 * exactly as before.
 *
 * ## `kind` is never guessed (018-004)
 *
 * `upsertDevice`'s `kind` is optional; omitting it means "I don't know
 * yet" — the write never asserts or overwrites an existing row's `kind`
 * in that case (a brand-new row still gets the schema's own required-
 * column default, `"robot"`, since `devices.kind` is `NOT NULL`, but
 * that default is the *store's*, not the caller's assertion). Only a
 * caller that has just positively identified the device — a banner
 * reply (`connect/connector.ts`), mDNS relay discovery
 * (`watchers/mdnsWatcher.ts`), or a seeded `known-robots.json` entry
 * (`store/importers/knownRobots.ts`) — passes an explicit `kind`, which
 * still always overwrites. This closes the bench-evidenced bug where
 * `watchers/usbWatcher.ts`'s SWD-naming step (a chip id read, which
 * cannot itself distinguish a robot from a relay) unconditionally wrote
 * `kind: "robot"` on every successful read, silently downgrading an
 * already-known relay the moment it was next seen over USB. See
 * {@link UpsertDeviceInput.kind}'s and {@link Store.upsertDevice}'s own
 * doc comments for the exact mechanism.
 */
import type { DatabaseSync } from "node:sqlite";
import { EventEmitter } from "node:events";
import { deviceIdToName, nameToValue } from "@robot-console/protocol";
import { openStoreDb, type StoreDbOptions } from "./db.js";
import { clearDeadProcessState } from "./repair/clearDeadProcessState.js";
import { mergeDuplicateDeviceRows } from "./repair/mergeDuplicateDeviceRows.js";
import { removeLocalHostDeviceRows } from "./repair/removeLocalHostDeviceRows.js";
import { repairDeviceKindFromRole } from "./repair/repairDeviceKindFromRole.js";
import { repairRadioLinkDeviceAssociation } from "./repair/repairRadioLinkDeviceAssociation.js";

/**
 * Parses the robot name a `radio`/`mbrelay` "child" link's own id encodes
 * -- `connect/relayBridger.ts`'s `defaultFailoverChildLinkId` convention,
 * `<transport>-<name>-via-<relayLinkId>` (`watchers/relaySweeper.ts`'s
 * `radioChildLinkId` mints the identical shape). Returns `undefined` for
 * any link id not shaped this way (a relay's own connectivity link, a
 * usb/wifi/mbserial link, or anything else) -- including one whose
 * captured segment merely *looks* name-shaped but is not one of the
 * well-formed five-letter names {@link nameToValue} accepts (a relay's
 * own synthetic name, e.g. `mbrelay-torture`, never matches the `-via-`
 * shape at all, but this still guards against a coincidental false
 * match).
 *
 * Ticket 018-010 (bench defect: `radio-tigez-via-mbrelay-torture` carried
 * `gopiv`'s own `device_id` in the stakeholder's real store) -- this is
 * the one parsing rule both {@link Store.upsertLink}'s write-time guard
 * below and `repair/repairRadioLinkDeviceAssociation.ts`'s one-time
 * backfill apply; duplicated (not imported) in that repair module purely
 * to avoid a runtime import cycle between the two files -- see that
 * module's own doc comment for why, and keep both copies in sync by name
 * if this one ever changes. */
function radioChildLinkName(linkId: string): string | undefined {
  const match = /^(?:radio|mbrelay)-([a-z]+?)-via-.+$/.exec(linkId);
  if (!match) {
    return undefined;
  }
  const candidate = match[1] as string;
  try {
    nameToValue(candidate);
    return candidate;
  } catch {
    return undefined;
  }
}

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
  /** Omit to never assert a kind at all -- 018-004: `devices.kind` is
   * `NOT NULL` (the schema forces *some* value on a brand-new row), but
   * a caller that does not yet know whether this board is a robot or a
   * relay (`watchers/usbWatcher.ts`'s SWD-naming step, which reads a
   * chip id directly over the debug interface -- a signal that exists
   * identically on both) must never *guess*. Omitting `kind` here means:
   * on conflict (a row already exists), the existing `kind` is kept
   * unchanged, whatever it is; on a brand-new row, the schema's own
   * required-column default (`"robot"`) is used, exactly like every
   * other unset optional column, but that default is the *store's*, not
   * an assertion the caller made. Only a caller that has just positively
   * identified the device (`connect/connector.ts`'s banner-based
   * identify, `watchers/mdnsWatcher.ts`'s relay discovery,
   * `store/importers/knownRobots.ts`'s seeded roster) should ever pass
   * an explicit `kind` — see {@link Store.upsertDevice}'s own doc
   * comment for the exact conflict-resolution rule this drives. */
  kind?: DeviceKind;
  role?: string | null;
  /** Banner `commonName` (`packages/protocol/src/banner.ts`'s
   * `ParsedBanner.commonName`, e.g. `"robot"`/`"relay"`) -- written
   * alongside `role` by the same banner-identify call sites
   * (`connect/connector.ts`, `connect/relayBridger.ts`). Coalesced on
   * conflict exactly like `role`: an omitted/null value here never
   * clobbers an already-known common name (see {@link Store.upsertDevice}'s
   * own SQL). */
  commonName?: string | null;
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
  /** Sprint 018 ticket 010 (SUC-007): wall-clock time of the most
   * recent actual reply on this session's link -- distinct from
   * `lastDone` (only a *sequenced* command's own completion). See
   * `connect/harvester.ts`'s `syncSession` and this column's own
   * migration doc comment (`migrations/0002-session-answered-at.ts`). */
  answeredAt?: number | null;
}

/** `sessions.origin` -- sprint 019 ticket 005 (SUC-005, MCP caller
 * identity): `'ui'` for a browser-opened session (the default, written
 * by every pre-existing caller unchanged), `'mcp'` for one an MCP
 * client opened via `connect/sessionOps.ts`'s `openSession`. See
 * `migrations/0004-session-origin-caller.ts`'s own doc comment. */
export type SessionOrigin = "ui" | "mcp";

/** Who opened a session, as {@link Store.setSessionIdentity} writes it
 * -- `caller` is the MCP client's own declared `clientInfo.name` when
 * `origin === "mcp"`, `null` for `origin === "ui"` (a browser session
 * has no such name to carry). */
export interface SessionIdentity {
  readonly origin: SessionOrigin;
  readonly caller: string | null;
}

/** The identity every `Store.openSession` call writes by default --
 * every existing call site (`connect/connector.ts`, `connect/
 * relayBridger.ts`) passes no identity of its own, so a plain re-open
 * always resets `origin`/`caller` back to this rather than leaving a
 * stale `'mcp'`/caller behind from whatever this link's *previous*
 * session happened to be (`Store.openSession`'s own doc comment). */
export const UI_SESSION_IDENTITY: SessionIdentity = { origin: "ui", caller: null };

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
  /** `devices.common_name` -- see {@link UpsertDeviceInput.commonName}'s
   * own doc comment. */
  readonly commonName: string | null;
  readonly program: string | null;
  readonly version: string | null;
  readonly radioChannel: number | null;
  readonly radioGroup: number | null;
  readonly radioSource: RadioSource;
  readonly owned: boolean;
  readonly lastSeen: number;
  /** `devices.usb_serial` -- the KL27 interface-chip serial, "display
   * hint only" per the schema's own column comment, reused (ticket
   * 018-014) as the other half of {@link findCurrentMbflashService}'s
   * match rule: a device's `_mbflash._tcp` service is trusted by
   * instance name alone unless TXT `uid` is present *and* this field is
   * present, in which case both must agree. Optional on this interface
   * (not just nullable) purely so the many existing
   * `projection.test.ts`/`store/index.test.ts` fixture literals that
   * predate this ticket need not all be updated to keep type-checking —
   * `Store.projectionRows()` itself always populates it concretely. */
  readonly usbSerial?: string | null;
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
  /** See {@link UpdateSessionInput.answeredAt}'s own doc comment. */
  readonly answeredAt: number | null;
  /** See {@link SessionIdentity}. Always populated by
   * {@link Store.projectionRows} (`'ui'` by default). */
  readonly origin: SessionOrigin;
  /** See {@link SessionIdentity}. */
  readonly caller: string | null;
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
  /** Ticket 018-017: `firmware.checked_at`, so the UI can show when a
   * release was last resolved -- carried through unchanged to {@link
   * FirmwareAvailability}'s own `checkedAt` field by
   * `projection.ts`'s `buildFirmwareAvailability`. */
  readonly checkedAt: number | null;
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

/** One `services` row, as {@link Store.projectionRows} needs it —
 * `txt` is left as `unknown` (parsed JSON; shape depends entirely on
 * whatever the advertiser put in its TXT record), matching every other
 * JSON column's convention in this file's read models
 * ({@link ProjectionLinkRow.address}, etc). Ticket 018-014: this is what
 * lets `projection.ts`'s `capabilities.flash` and `server.ts`'s
 * `runFlashTask` both find a device's current `_mbflash._tcp`
 * advertisement without either one running raw SQL of its own. */
export interface ProjectionServiceRow {
  readonly instance: string;
  readonly type: string;
  readonly host: string | null;
  readonly port: number | null;
  readonly txt: unknown;
}

/** `services.type` value for `_mbflash._tcp` rows — must equal
 * `watchers/mdnsWatcher.ts`'s own `serviceRowType({type: "mbflash",
 * protocol: "tcp"})` (`"mbflash.tcp"`). Duplicated here as a literal
 * rather than imported: `mdnsWatcher.ts` already depends on this module
 * (not the other way around) — same dependency-direction reasoning as
 * {@link ProjectionRows.wifiCredentials}'s own
 * `WIFI_CREDENTIALS_SETTING_KEY` doc comment. */
export const MBFLASH_SERVICE_TYPE = "mbflash.tcp";

/**
 * The `services` row for `device`'s current `_mbflash._tcp`
 * advertisement, or `undefined` if none is currently present (aged out
 * by {@link Store.pruneServices}, or never observed at all) — ticket
 * 018-014's own matching rule: instance name equal to `device.name`,
 * and (only when *both* sides have a value to compare) TXT `uid` equal
 * to `device.usbSerial`. A device with no stored `usbSerial`, or a
 * service whose TXT carries no `uid` at all, matches on the name alone
 * — this is deliberately not "both must be present", since plenty of
 * devices (e.g. a `known-robots.json` import never yet seen over USB on
 * this host) never get a `usbSerial` at all. Pure and store-free —
 * unit-testable directly against fixture rows.
 */
export function findCurrentMbflashService(
  services: readonly ProjectionServiceRow[],
  device: { readonly name: string; readonly usbSerial?: string | null },
): ProjectionServiceRow | undefined {
  return services.find((service) => {
    if (service.type !== MBFLASH_SERVICE_TYPE || service.instance !== device.name) {
      return false;
    }
    const txt = service.txt;
    const uid = txt !== null && typeof txt === "object" ? (txt as Record<string, unknown>).uid : undefined;
    if (device.usbSerial != null && typeof uid === "string" && uid !== device.usbSerial) {
      // Both sides carry a value and they disagree -- not this device's
      // service, even though the instance name happened to match.
      return false;
    }
    return true;
  });
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
  /** Every raw `services` row (ticket 018-014) — `projection.ts`'s
   * `capabilities.flash` and `server.ts`'s `runFlashTask` both filter
   * this down to `_mbflash._tcp` rows via {@link findCurrentMbflashService}
   * rather than this module exposing a narrower, type-specific list;
   * mirrors {@link StoreSnapshot.services}'s own "every row, callers
   * narrow" shape, just camelCased and `txt`-parsed for a typed reader. */
  readonly services: readonly ProjectionServiceRow[];
}

function toJson(value: unknown): string | null {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

function toInt(value: boolean | undefined): number | null {
  return value === undefined ? null : value ? 1 : 0;
}

/** Best-effort `address.relayLinkId` read off a raw (still-JSON-string)
 * `links.address` column value — used only by {@link
 * Store.ageRadioLinks}/{@link Store.clearRadioLinkStaleText} below, which
 * read `links` directly rather than through {@link Store.snapshotRows}
 * (that method's own parsed-JSON contract is for callers outside this
 * class; these two operate inside a single `withChangeBatch` transaction
 * over a raw `SELECT`, matching {@link Store.ageLinks}'s own style).
 * Never throws — a malformed/missing `relayLinkId` just means this row
 * cannot be resolved to a relay, mirroring `connect/connector.ts`'s own
 * `parseRelayAddress` "never throws on a bad row" discipline. */
function parseRelayLinkIdFromAddress(raw: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) {
      return undefined;
    }
    const relayLinkId = (parsed as Record<string, unknown>).relayLinkId;
    return typeof relayLinkId === "string" ? relayLinkId : undefined;
  } catch {
    return undefined;
  }
}

/** {@link Store.upsertDevice}'s fallback for a brand-new row when the
 * caller omitted `kind` -- `devices.kind` is `NOT NULL`, so *something*
 * must be written, but this is the schema's own required-column
 * default, never a classification the caller asserted (018-004; see
 * {@link UpsertDeviceInput.kind}'s own doc comment). */
const DEFAULT_INSERT_KIND: DeviceKind = "robot";

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
    // Narrowed 2026-09-12 (ticket 017-005, thrown-and-resolved exception;
    // see sprint.md's Revision note and Design Rationale): this check is
    // skipped only when `input.id < 0 && input.kind === 'relay'`. A
    // negative id is never a real chip id (`FICR.DEVICEID[1]` is an
    // unsigned 32-bit value, so every genuine chip id is non-negative) --
    // it is unambiguously synthetic, minted by `mdnsWatcher.ts`'s
    // `createRelayDeviceIfAbsent` as a stable hash of `mbrelay:<instance>`
    // for a relay whose mDNS instance name doesn't parse as a five-letter
    // micro:bit name (e.g. `torture`), for which no id choice could ever
    // satisfy `deviceIdToName(id) === name` (that function always produces
    // a well-formed five-letter name for any integer). Every other row
    // shape -- every `kind='robot'` row, and every grammar-named
    // `kind='relay'` row (positive/`nameToValue`-range id) -- still
    // enforces the check exactly as before; this narrows, not removes,
    // the protection the 014-003 invariant put in place.
    const skipNameCheck = input.id < 0 && input.kind === "relay";
    if (!skipNameCheck) {
      const expectedName = deviceIdToName(input.id);
      if (expectedName !== input.name) {
        throw new DeviceNameMismatchError(input.id, input.name);
      }
    }
    this.withChange(
      "devices",
      () => String(input.id),
      () => {
        // 018-004: `devices.kind` is `NOT NULL`, so a brand-new row must
        // get *some* value even when `input.kind` was omitted --
        // `DEFAULT_INSERT_KIND`, the schema-forced fallback (never an
        // assertion the caller made; see {@link UpsertDeviceInput.kind}'s
        // own doc comment). On conflict (a row already exists), `kind` is
        // `COALESCE(?, devices.kind)` against the *raw*, possibly-`null`
        // `input.kind` -- never `excluded.kind` (which would already
        // have been coerced to `DEFAULT_INSERT_KIND` and so could never
        // tell "explicitly asked for robot" apart from "didn't say") --
        // so an omitted `kind` always keeps whatever the row already has
        // (a relay stays a relay), while every existing caller that
        // *does* pass an explicit `kind` (`connect/connector.ts`'s
        // banner-based identify, `watchers/mdnsWatcher.ts`'s relay
        // discovery, `store/importers/knownRobots.ts`'s seeded roster)
        // still overwrites it exactly as before -- this is the one and
        // only behavior change this ticket makes to this method.
        const insertKind = input.kind ?? DEFAULT_INSERT_KIND;
        const conflictKind = input.kind ?? null;
        this.db
          .prepare(
            `INSERT INTO devices
               (id, name, kind, role, common_name, program, version, usb_serial, radio_channel, radio_group, radio_source, owned, first_seen, last_seen)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
               name = excluded.name,
               kind = COALESCE(?, devices.kind),
               role = COALESCE(excluded.role, devices.role),
               common_name = COALESCE(excluded.common_name, devices.common_name),
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
            insertKind,
            input.role ?? null,
            input.commonName ?? null,
            input.program ?? null,
            input.version ?? null,
            input.usbSerial ?? null,
            input.radioChannel ?? null,
            input.radioGroup ?? null,
            input.radioSource ?? null,
            input.at,
            input.at,
            conflictKind,
          );
      },
    );
  }

  /** The stored `kind` for `id`, or `undefined` if no `devices` row
   * exists yet -- 018-004: `watchers/usbWatcher.ts`'s SWD-naming step
   * reads this *before* upserting, so it can skip the name-placeholder
   * merge for a device already known to be a relay (see that module's
   * own doc comment) without pulling a full {@link snapshotRows} dump
   * just to look up one column. A plain read, no transaction, same
   * "always re-derive" reasoning as {@link reconcilerRows}. */
  getDeviceKind(id: number): DeviceKind | undefined {
    const row = this.db.prepare("SELECT kind FROM devices WHERE id = ?").get(id) as { kind: DeviceKind } | undefined;
    return row?.kind;
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

  /** Sets `devices.kind` directly — the write primitive
   * `repair/repairDeviceKindFromRole.ts` (ticket 018-010) uses to
   * promote an already-persisted row whose `role` is a relay-only
   * firmware token (`RADIOBRIDGE`/`RADIORELAY`) but whose `kind` still
   * says `"robot"`. Deliberately distinct from {@link upsertDevice}'s
   * own `kind` handling (optional, and only ever asserted by a caller
   * that has just positively identified the device — see that method's
   * own doc comment, "kind is never guessed") — a one-time repair over
   * already-persisted, already-contradictory data is not "guessing", it
   * is correcting a row against a rule (`role` implies `kind`) the store
   * itself cannot otherwise enforce at write time (a device's `role` can
   * be written by the very same call that sets `kind` — `connect/
   * connector.ts`'s successful-identify path always does both together —
   * so the inconsistency this fixes is necessarily historical). A no-op
   * if `id` has no row yet. */
  setDeviceKind(id: number, kind: DeviceKind): void {
    this.withChange(
      "devices",
      () => String(id),
      () => {
        this.db.prepare("UPDATE devices SET kind = ? WHERE id = ?").run(kind, id);
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
   * `radio_channel`/`radio_group`/`radio_source` are filled from
   * `fromId` only where `intoId` does not already have them, and
   * `usb_serial` keeps `intoId`'s own value if it has one, else falls
   * back to `fromId`'s (bench defect 2, 2026-09-12: a known-robots
   * placeholder's `usb_serial` is "last seen via USB" telemetry worth
   * keeping if the real row has none of its own yet) — the real row's
   * own already-set values are never clobbered, for any of these
   * columns.
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
        usb_serial: string | null;
      };
      const fromRow = this.db
        .prepare("SELECT owned, first_seen, radio_channel, radio_group, radio_source, usb_serial FROM devices WHERE id = ?")
        .get(fromId) as MergeableDeviceRow | undefined;
      const intoRow = this.db
        .prepare("SELECT owned, first_seen, radio_channel, radio_group, radio_source, usb_serial FROM devices WHERE id = ?")
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
      const usbSerial = intoRow.usb_serial ?? fromRow.usb_serial;

      this.db
        .prepare(
          `UPDATE devices SET owned = ?, first_seen = ?, radio_channel = ?, radio_group = ?, radio_source = ?, usb_serial = ?, last_seen = ?
           WHERE id = ?`,
        )
        .run(owned, firstSeen, radioChannel, radioGroup, radioSource, usbSerial, at, intoId);

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
   * handled first: the device's own `links` rows (and their `sessions`/
   * `relay_leases`) are deleted with it, and `sightings` are re-pointed
   * to `NULL`. A no-op if `id` has no row.
   */
  deleteDevice(id: number): void {
    // Stakeholder (2026-09-13): forgetting zapig left its USB link row
    // behind, which then surfaced as an "Unidentified board" card and
    // was retried against a port that no longer exists. Forgetting a
    // device removes its links (and anything keyed on them) too.
    this.withChange(
      "devices",
      () => String(id),
      () => {
        this.db.prepare("DELETE FROM sessions WHERE link_id IN (SELECT id FROM links WHERE device_id = ?)").run(id);
        this.db.prepare("DELETE FROM relay_leases WHERE relay_link_id IN (SELECT id FROM links WHERE device_id = ?)").run(id);
        this.db.prepare("DELETE FROM links WHERE device_id = ?").run(id);
        this.db.prepare("UPDATE sightings SET device_id = NULL WHERE device_id = ?").run(id);
        this.db.prepare("DELETE FROM devices WHERE id = ?").run(id);
      },
    );
  }

  // ---- links -------------------------------------------------------

  /** Deletes `id`'s `links` row outright — unlike {@link deleteDevice}
   * (which only detaches links from a forgotten device, keeping the
   * link row itself as a still-observable physical/network endpoint),
   * this is for a link that should never have existed at all: ticket
   * 018-010's own local-host mDNS filter
   * (`repair/removeLocalHostDeviceRows.ts`, `watchers/mdnsWatcher.ts`'s
   * `isLocalMdnsService` guard) uses this to clean up a `mbrelay`/
   * `mbserial` link row that turned out to name this very machine, not
   * a real relay or robot. `sessions`/`relay_leases` both carry a
   * `REFERENCES links(id)` foreign key (`db.ts`'s schema) with no
   * `ON DELETE CASCADE`, so any row there for `id` is deleted first — in
   * ordinary use both are already empty by the time this runs (`ticket
   * 018-010`'s own `clearDeadProcessState` always runs first at
   * `openStore`), but this method does not assume that. `sightings.
   * via_link_id` is a plain `TEXT` column, not a foreign key (`db.ts`'s
   * schema has no `REFERENCES` on it), so a leftover sighting row naming
   * a since-deleted link is harmless and left alone, exactly like a
   * sighting naming a since-forgotten device already is. A no-op if `id`
   * has no row. */
  deleteLink(id: string): void {
    this.withChange(
      "links",
      () => id,
      () => {
        this.db.prepare("DELETE FROM sessions WHERE link_id = ?").run(id);
        this.db.prepare("DELETE FROM relay_leases WHERE relay_link_id = ?").run(id);
        this.db.prepare("DELETE FROM links WHERE id = ?").run(id);
      },
    );
  }

  /** Records a watcher's observation of a link. On first sight, creates
   * the row in the `discovered` state (see architecture.md §5 for the
   * state machine `setLinkState` drives from there); on every later
   * call, refreshes `device_id`/`address`/`last_seen` only — state is
   * exclusively {@link setLinkState}'s concern.
   *
   * **Ticket 018-010's own write-time guard**: when `input.id` is a
   * `radio`/`mbrelay` child link (see {@link radioChildLinkName}) and
   * `input.deviceId` is being written at all (an actual value, not the
   * "don't touch it" `null`/`undefined` this method already treats as a
   * no-op via `COALESCE`) and a `kind = 'robot'` device is already known
   * by the link id's own `<name>` segment, that device — never the
   * caller's own `input.deviceId` — is what actually gets written; see
   * {@link resolveRadioLinkDeviceId}'s own doc comment for why an
   * as-yet-unmatched name is left as the caller supplied it here, rather
   * than dropped to `null` (that stronger rule is exclusively the
   * one-time repair's own — see `repair/repairRadioLinkDeviceAssociation
   * .ts`). This is what keeps a `links.id` and its `device_id` from
   * ever *newly* disagreeing when the correct device is already on hand
   * — the bench-evidenced defect this ticket fixes had
   * `radio-tigez-via-mbrelay-torture` (a link id that names `tigez`, an
   * already-known robot) carrying `gopiv`'s own `device_id`, from a
   * relay-bridge identify that wrote the actually-answering device's id
   * under the *requested* candidate's link id rather than checking the
   * two agreed. */
  upsertLink(input: UpsertLinkInput): void {
    const addressJson = JSON.stringify(input.address);
    const deviceId = this.resolveRadioLinkDeviceId(input.id, input.deviceId);
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
          .run(input.id, deviceId ?? null, input.transport, addressJson, input.at, input.at);
      },
    );
  }

  /** {@link upsertLink}'s own write-time guard -- see that method's doc
   * comment. Returns `input.deviceId` unchanged whenever there is
   * nothing to correct: `deviceId` is `null`/`undefined` (this call
   * isn't writing `device_id` at all), `linkId` isn't a `radio`/
   * `mbrelay` child link id in the first place, or no `kind = 'robot'`
   * device is named by the link id's own `<name>` segment yet (deferring
   * to `input.deviceId` in that last case, rather than dropping it to
   * `null` outright, is deliberate -- see below). Otherwise returns that
   * named device's own id, regardless of what `deviceId` the caller
   * supplied.
   *
   * **Never `null`s out an unmatched name at write time** -- unlike
   * `repair/repairRadioLinkDeviceAssociation.ts`'s one-time backfill
   * (which does, once, for an already-corrupted row -- see that module's
   * own doc comment), this live guard only *re-points* a write to an
   * already-known conflicting device; it never *clears* one on the
   * strength of "no device named `<name>` exists yet" alone. A brand-new
   * radio/mbrelay sighting legitimately upserts a link before its
   * matching `devices` row exists in some call orders — dropping
   * `deviceId` to `null` here on every such ordinary first-sight write
   * would be actively wrong, not merely overcautious. */
  private resolveRadioLinkDeviceId(linkId: string, deviceId: number | null | undefined): number | null | undefined {
    if (deviceId === null || deviceId === undefined) {
      return deviceId;
    }
    const name = radioChildLinkName(linkId);
    if (name === undefined) {
      return deviceId;
    }
    const named = this.db.prepare(`SELECT id FROM devices WHERE kind = 'robot' AND name = ?`).get(name) as
      | { id: number }
      | undefined;
    return named?.id ?? deviceId;
  }

  /** Re-points (or clears) a single `links` row's `device_id` directly —
   * the write primitive `repair/repairRadioLinkDeviceAssociation.ts`
   * (ticket 018-010) uses to fix an already-persisted radio/mbrelay link
   * whose `device_id` names a different device than its own `links.id`
   * does. Deliberately distinct from {@link upsertLink} (whose
   * `device_id` write is otherwise `COALESCE`-merged, add-only per that
   * method's own doc comment) since a repair must be able to *clear* a
   * wrong `device_id` back to `NULL` when no correctly-named device
   * exists, not merely add one. `state`/`address`/etc. are left
   * untouched — only `device_id` moves. */
  setLinkDeviceId(linkId: string, deviceId: number | null): void {
    this.withChange(
      "links",
      () => linkId,
      () => {
        this.db.prepare(`UPDATE links SET device_id = ? WHERE id = ?`).run(deviceId, linkId);
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
   * {@link ChangeEvent}) per link aged, all in the same transaction.
   *
   * Never ages a link with an open `sessions` row, regardless of how
   * long ago its own mDNS `last_seen` last refreshed (ticket 016-008
   * bench finding, live on real hardware: `mdnsWatcher.ts`'s aging pass
   * runs off `links.last_seen` alone, which only advances on a fresh
   * mDNS `up`/`onServiceChange` observation of the *advertisement* —
   * not on session/telemetry activity over an already-open connection.
   * A real `gopiv` mbserial session sat open and actively receiving
   * telemetry (`sessions.robot_status` updating every poll) while its
   * `links` row aged past `DEFAULT_MBSERIAL_TTL_MS` purely because the
   * advertiser did not re-announce within that window — surfacing a
   * connected link as `stale` to the UI, which would read as "gone"
   * for a link that is very much alive. This gap was unreachable before
   * ticket 016-008's own carried fixup (promoting an owned wifi/mbserial
   * link to `connectable` so the reconciler's auto-connect actually
   * opens a session on it) gave any wifi/mbserial link a live session to
   * race against in the first place — usb links never call `ageLinks`
   * at all (`usbWatcher.ts` has its own poll-driven lifecycle instead),
   * so this is the first time an aged transport could ever have a
   * concurrently open session. */
  ageLinks(transport: Transport, ttlMs: number, now: number): number {
    const cutoff = now - ttlMs;
    return this.withChangeBatch("links", () => {
      const stale = this.db
        .prepare(
          `SELECT id FROM links
           WHERE transport = ? AND state != 'stale' AND (last_seen IS NULL OR last_seen < ?)
             AND id NOT IN (SELECT link_id FROM sessions)`,
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

  /** Radio-transport counterpart to {@link ageLinks} (architecture.md
   * §6.2's aging rule, extended to `radio` — ticket 018-005, issue
   * `bench-stale-radio-links-and-duplicate-rows-persist.md`). Marks a
   * `radio` link `stale` when either:
   *
   * - its relay link (named by its own `address.relayLinkId`) no longer
   *   exists among current `links` rows, or is itself `stale`; or
   * - it has had no *successful* sighting (`sightings.ok = 1`, matched
   *   by `via_link_id = <relayLinkId>` and the same `device_id`) within
   *   `ttlMs` **and** at least `ttlMs` has passed since the link's own
   *   `state_since` (018-006 grace period — see below).
   *
   * Never ages a link in the `connecting` state, and — 018-006,
   * bench-evidenced race — never ages a link on the "no successful
   * sighting yet" branch until `ttlMs` has passed since its own
   * `state_since`: a radio link that `connect/relayBridger.ts` or a
   * `server.ts` session-open just created, or that is actively
   * `connecting`, has no `sessions` row yet (that only appears once a
   * session actually opens) and no successful sighting yet either,
   * since the sweeper is deliberately off during a harness/bench run —
   * without this exemption, an aging tick landing in that window marked
   * the link `stale` mid-connect, before it ever got a chance to
   * succeed. This grace period applies only to the "no sighting yet"
   * reason: a link whose relay is provably gone or `stale` still ages
   * immediately regardless of how new the link itself is (018-005's own
   * already-covered case) — only "nothing has had a chance to prove
   * itself yet" waits out a full `ttlMs` from the link's last state
   * transition first.
   *
   * Deliberately not `last_seen`-based like {@link ageLinks}:
   * `watchers/relaySweeper.ts`'s own `recordCandidateOutcome` bumps a
   * radio link's `last_seen` via `upsertLink` on *every* sweep attempt,
   * success or failure — so a name that keeps being probed and keeps
   * failing every single pass would never age under a plain `last_seen
   * < now - ttl` rule. This is exactly the bench-evidenced bug this
   * ticket fixes: `radio-gopiv-via-usb-…`/`radio-vevov-via-usb-…` sat in
   * `failed`/`discovered` for 849 minutes because nothing else ever
   * re-touched them, and a `last_seen`-based TTL cannot tell "hasn't
   * been probed in a while" apart from "keeps being probed and keeps
   * failing." Never ages a link with an open `sessions` row, mirroring
   * {@link ageLinks}'s own safety net (a bridged radio session outlives
   * whatever its own `last_seen`/last-successful-sighting says).
   * Returns the number of links aged. */
  ageRadioLinks(ttlMs: number, now: number): number {
    const cutoff = now - ttlMs;
    return this.withChangeBatch("links", () => {
      const allLinks = this.db
        .prepare(`SELECT id, transport, address, state, state_since, device_id FROM links`)
        .all() as Array<{
        id: string;
        transport: string;
        address: string;
        state: string;
        state_since: number;
        device_id: number | null;
      }>;
      const linkById = new Map(allLinks.map((l) => [l.id, l] as const));
      const sessionLinkIds = new Set(
        (this.db.prepare(`SELECT link_id FROM sessions`).all() as Array<{ link_id: string }>).map((r) => r.link_id),
      );
      const lastOkStmt = this.db.prepare(
        `SELECT MAX(at) as maxAt FROM sightings WHERE transport = 'radio' AND via_link_id = ? AND ok = 1 AND device_id IS ?`,
      );
      const staleStmt = this.db.prepare(
        "UPDATE links SET state = 'stale', state_reason = 'ttl-expired', state_since = ? WHERE id = ?",
      );
      const keys: (string | null)[] = [];
      for (const link of allLinks) {
        if (
          link.transport !== "radio" ||
          link.state === "stale" ||
          link.state === "connecting" ||
          sessionLinkIds.has(link.id)
        ) {
          // 018-006: a link actively `connecting` is exempt outright,
          // regardless of relay/sighting state -- it has not yet had a
          // chance to reach a session or a sighting at all.
          continue;
        }
        const relayLinkId = parseRelayLinkIdFromAddress(link.address);
        const relay = relayLinkId !== undefined ? linkById.get(relayLinkId) : undefined;
        const relayGoneOrStale = relayLinkId === undefined || relay === undefined || relay.state === "stale";
        let shouldAge = relayGoneOrStale;
        if (!shouldAge) {
          const row = lastOkStmt.get(relayLinkId as string, link.device_id) as { maxAt: number | null } | undefined;
          const lastOk = row?.maxAt ?? null;
          if (lastOk === null) {
            // 018-006 grace period: nothing has had a chance to prove
            // itself yet -- only age once a full ttlMs has passed since
            // this link's own last state transition, not the instant it
            // (or its current state) was created.
            shouldAge = now - link.state_since >= ttlMs;
          } else {
            shouldAge = lastOk < cutoff;
          }
        }
        if (shouldAge) {
          staleStmt.run(now, link.id);
          keys.push(link.id);
        }
      }
      return keys;
    });
  }

  /** Clears `state_reason` on every `radio`-transport link riding
   * `relayLinkId` that currently carries failure text — called
   * (`watchers/usbWatcher.ts`'s `handleUpdated`) the moment a relay's
   * own physical USB address actually changes (ticket 018-005: a radio
   * link's stale failure text, e.g. `"cannot open
   * /dev/cu.usbmodem2121202"`, must not keep naming a USB path the relay
   * no longer dials once it has moved to a new one). Leaves
   * `state`/`state_since`/`fail_count` untouched — only the
   * human-readable reason text is what actually goes stale here; the
   * link's own state transitions (if any) are still exclusively {@link
   * setLinkState}'s concern. Returns the number of links cleared. */
  clearRadioLinkStaleText(relayLinkId: string): number {
    return this.withChangeBatch("links", () => {
      const rows = this.db
        .prepare(`SELECT id, address FROM links WHERE transport = 'radio' AND state_reason IS NOT NULL`)
        .all() as Array<{ id: string; address: string }>;
      const stmt = this.db.prepare(`UPDATE links SET state_reason = NULL WHERE id = ?`);
      const keys: (string | null)[] = [];
      for (const row of rows) {
        if (parseRelayLinkIdFromAddress(row.address) !== relayLinkId) {
          continue;
        }
        stmt.run(row.id);
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
        // `origin`/`caller` are explicitly reset to the `'ui'`/`NULL`
        // default on every open (sprint 019 ticket 005) -- both on a
        // fresh INSERT (where the column defaults would already give
        // this) and on the ON CONFLICT re-open branch (where, absent
        // this, a session that previously carried `Store
        // .setSessionIdentity`'s `'mcp'`/caller would otherwise keep
        // showing an agent's name for a session that agent no longer
        // holds). `connect/sessionOps.ts`'s `openSession` is the only
        // caller that ever moves a session away from this default,
        // immediately after this same open, via `setSessionIdentity`.
        this.db
          .prepare(
            `INSERT INTO sessions (link_id, opened_at, origin, caller)
             VALUES (?, ?, 'ui', NULL)
             ON CONFLICT(link_id) DO UPDATE SET
               opened_at = excluded.opened_at,
               seq = NULL, pending = NULL, last_done = NULL, last_done_reason = NULL,
               robot_status = NULL, functions = NULL, answered_at = NULL,
               origin = 'ui', caller = NULL`,
          )
          .run(linkId, at);
      },
    );
  }

  /** Sets `sessions.origin`/`sessions.caller` for an already-open session
   * -- sprint 019 ticket 005's own attribution write, called by
   * `connect/sessionOps.ts`'s `openSession` immediately after a session
   * it just (re)opened via {@link openSession} is confirmed live, with
   * the identity of whoever asked for it (`'ui'`/`null` for the WS path,
   * `'mcp'`/`clientInfo.name` for an MCP caller). A no-op -- recording no
   * change at all, matching {@link acquireBoardOwner}'s own
   * `withConditionalChange` discipline -- when either no session is open
   * for `linkId` (the open itself never succeeded) or the row already
   * carries this exact identity (the common case for the WS path's own
   * default `'ui'`/`null`, which `openSession` above already wrote), so
   * a browser's ordinary session-open never queues a spurious change-feed
   * event / snapshot broadcast on top of the one `openSession` itself
   * already queued. */
  setSessionIdentity(linkId: string, identity: SessionIdentity): void {
    this.withConditionalChange("sessions", linkId, () => {
      const current = this.db.prepare("SELECT origin, caller FROM sessions WHERE link_id = ?").get(linkId) as
        | { origin: SessionOrigin; caller: string | null }
        | undefined;
      if (current === undefined || (current.origin === identity.origin && current.caller === identity.caller)) {
        return { result: undefined, changed: false };
      }
      this.db.prepare("UPDATE sessions SET origin = ?, caller = ? WHERE link_id = ?").run(identity.origin, identity.caller, linkId);
      return { result: undefined, changed: true };
    });
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
               functions = COALESCE(?, functions),
               answered_at = COALESCE(?, answered_at)
             WHERE link_id = ?`,
          )
          .run(
            patch.seq ?? null,
            patch.pending ?? null,
            patch.lastDone ?? null,
            patch.lastDoneReason ?? null,
            patch.robotStatus ?? null,
            toJson(patch.functions),
            patch.answeredAt ?? null,
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

  /** The stored `etag` for one firmware `kind`'s most recent successful
   * poll, or `undefined` if no `firmware` row exists yet (never polled)
   * or the row has no `etag` recorded. Sprint 017 ticket 002:
   * `watchers/firmwareWatcher.ts` reads this before every poll to send
   * as `If-None-Match` -- deliberately not part of
   * {@link ProjectionFirmwareRow}/`projectionRows()` (an HTTP-caching
   * implementation detail the UI never needs), so this is its own
   * narrow typed read, per "nothing outside `store/` issues SQL"
   * (architecture.md §3 rule 3). */
  getFirmwareEtag(kind: "relay" | "robot"): string | undefined {
    const row = this.db.prepare("SELECT etag FROM firmware WHERE kind = ?").get(kind) as
      | { etag: string | null }
      | undefined;
    return row?.etag ?? undefined;
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

  /** Rows `repair/clearDeadProcessState.ts` (018-010) needs to find every
   * table entry whose validity depends on being written by the
   * currently-running process — see that module's own doc comment for
   * the bench evidence and exact rule. A dedicated grouped read (like
   * {@link reconcilerRows}'s own shape) rather than reusing
   * `reconcilerRows()` itself: that method is scoped to what
   * `connect/reconciler.ts`'s `plan()` needs (a different, unrelated
   * caller), and does not expose `board_owner` at all. `boardOwners`/
   * `relayLeases` keep their `owner` column (the repair releases each
   * row by its own current owner, whatever value that is — every value
   * either table can hold names an activity only the running process
   * performs, so there is no "is this one actually dead" check to make
   * beyond "the process that wrote it cannot possibly be this one,
   * since it just started"). `liveLinks` is only the two `links.state`
   * values `connect/reconciler.ts`'s own `deviceHasActiveLink`/
   * `isAutoConnectEligible` treat as "already has a connection" —
   * `connecting` (a connect attempt with no session yet) and `connected`
   * (a transport that reported success) — since a stale row in either
   * state left by a dead process permanently blocks that function from
   * ever reconnecting the device (it believes a connection already
   * exists), not merely a display bug. */
  deadProcessStateRows(): {
    readonly boardOwners: readonly { usbSerial: string; owner: string }[];
    readonly relayLeases: readonly { relayLinkId: string; owner: string }[];
    readonly openSessions: readonly { linkId: string }[];
    readonly liveLinks: readonly { id: string }[];
  } {
    const boardOwners = this.db.prepare("SELECT usb_serial, owner FROM board_owner").all() as Array<{
      usb_serial: string;
      owner: string;
    }>;
    const relayLeases = this.db.prepare("SELECT relay_link_id, owner FROM relay_leases").all() as Array<{
      relay_link_id: string;
      owner: string;
    }>;
    const openSessions = this.db.prepare("SELECT link_id FROM sessions").all() as Array<{ link_id: string }>;
    const liveLinks = this.db.prepare("SELECT id FROM links WHERE state IN ('connecting', 'connected')").all() as Array<{
      id: string;
    }>;
    return {
      boardOwners: boardOwners.map((r) => ({ usbSerial: r.usb_serial, owner: r.owner })),
      relayLeases: relayLeases.map((r) => ({ relayLinkId: r.relay_link_id, owner: r.owner })),
      openSessions: openSessions.map((r) => ({ linkId: r.link_id })),
      liveLinks: liveLinks.map((r) => ({ id: r.id })),
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
        "SELECT id, name, kind, role, common_name, program, version, usb_serial, radio_channel, radio_group, radio_source, owned, last_seen FROM devices",
      )
      .all() as Array<{
      id: number;
      name: string;
      kind: DeviceKind;
      role: string | null;
      common_name: string | null;
      program: string | null;
      version: string | null;
      usb_serial: string | null;
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
      .prepare("SELECT link_id, seq, pending, last_done, last_done_reason, robot_status, functions, answered_at, origin, caller FROM sessions")
      .all() as Array<{
      link_id: string;
      seq: number | null;
      pending: number | null;
      last_done: number | null;
      last_done_reason: string | null;
      robot_status: string | null;
      functions: string | null;
      answered_at: number | null;
      origin: SessionOrigin;
      caller: string | null;
    }>;

    const relayLeaseRows = this.db.prepare("SELECT relay_link_id, owner FROM relay_leases").all() as Array<{
      relay_link_id: string;
      owner: string;
    }>;

    const firmwareRows = this.db
      .prepare("SELECT kind, repo, tag, available, reason, message, checked_at FROM firmware")
      .all() as Array<{
      kind: "relay" | "robot";
      repo: string | null;
      tag: string | null;
      available: number | null;
      reason: string | null;
      message: string | null;
      checked_at: number | null;
    }>;

    const taskRows = this.db.prepare("SELECT name, state, heartbeat_at FROM tasks").all() as Array<{
      name: string;
      state: string;
      heartbeat_at: number;
    }>;

    const lastCheckedRows = this.db
      .prepare("SELECT device_id, MAX(at) AS at FROM sightings WHERE device_id IS NOT NULL GROUP BY device_id")
      .all() as Array<{ device_id: number; at: number }>;

    // Ticket 018-014: every raw `services` row -- see
    // `ProjectionRows.services`'s own doc comment for why this exposes
    // all types rather than pre-filtering to `_mbflash._tcp` here.
    const serviceRows = this.db.prepare("SELECT instance, type, host, port, txt FROM services").all() as Array<{
      instance: string;
      type: string;
      host: string | null;
      port: number | null;
      txt: string | null;
    }>;

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
        commonName: d.common_name,
        program: d.program,
        version: d.version,
        usbSerial: d.usb_serial,
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
        answeredAt: s.answered_at,
        origin: s.origin,
        caller: s.caller,
      })),
      relayLeases: relayLeaseRows.map((r) => ({ relayLinkId: r.relay_link_id, owner: r.owner })),
      firmware: firmwareRows.map((f) => ({
        kind: f.kind,
        repo: f.repo,
        tag: f.tag,
        available: f.available === null ? null : f.available !== 0,
        reason: f.reason,
        message: f.message,
        checkedAt: f.checked_at,
      })),
      tasks: taskRows.map((t) => ({ name: t.name, state: t.state, heartbeatAt: t.heartbeat_at })),
      lastChecked: lastCheckedRows.map((r) => ({ deviceId: r.device_id, at: r.at })),
      wifiCredentials,
      fastSweepByRelayLinkId,
      services: serviceRows.map((s) => ({
        instance: s.instance,
        type: s.type,
        host: s.host,
        port: s.port,
        txt: s.txt !== null ? (JSON.parse(s.txt) as unknown) : null,
      })),
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
 * store and wraps it as a {@link Store}. Runs five one-time-per-open
 * repairs, right here — after migrations have applied but before this
 * function returns to any caller that goes on to start
 * watchers/importers, so every production caller (`store/bootstrap.ts`'s
 * `openStoreWithImports`, this module's own tests) gets a repaired store
 * with no extra wiring: the dead-process-state reset (018-010, {@link
 * clearDeadProcessState} — run first, since a process-restart reset
 * logically precedes any data-correctness repair, though the two are
 * otherwise independent), the duplicate device-row repair (018-006,
 * {@link mergeDuplicateDeviceRows}), the device-kind-from-role repair
 * (018-010, {@link repairDeviceKindFromRole}), the radio/mbrelay link
 * device-association repair (018-010, {@link
 * repairRadioLinkDeviceAssociation}), and the local-host device-row
 * repair (018-010, {@link removeLocalHostDeviceRows} — removes a device
 * row this very machine minted for itself before `mdnsWatcher.ts`'s own
 * `isLocalMdnsService` guard existed). `debug/dumpStore.ts` deliberately
 * does not call `openStore` at all (it opens a read-only connection
 * directly) and so never runs any of them — a read-only inspector must
 * never write, and all five, on an already-affected database, always
 * do. */
export function openStore(options: StoreDbOptions = {}): Store {
  const store = new Store(openStoreDb(options));
  clearDeadProcessState(store, Date.now());
  mergeDuplicateDeviceRows(store, Date.now());
  repairDeviceKindFromRole(store);
  repairRadioLinkDeviceAssociation(store);
  removeLocalHostDeviceRows(store);
  return store;
}
