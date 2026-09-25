/**
 * mdnsWatcher.ts — keep `services`/`links(wifi|mbserial|mbrelay)` rows
 * current for whatever mDNS currently advertises (ticket 014-008 /
 * issue `rearch-03-mdns-watcher-rows-requery-aging-address-updates.md`;
 * `docs/design/architecture.md` §6.2). Wraps the existing
 * `discovery/mdnsDiscovery.ts` `MdnsBackend` seam directly — its parsers
 * are sound (per the issue), so this module's own job is the re-query
 * timer, per-type aging, and row-upsert glue that `MdnsDiscovery` itself
 * does not do. Deliberately does **not** go through the `MdnsDiscovery`
 * class: sprint 015 ticket 003 retires `deviceRegistry.ts` (that class's
 * only production caller before this sprint), but `server.ts` still
 * constructs and drives `MdnsDiscovery` directly until ticket 005's
 * composition root rewires it onto the reconciler (see
 * `discovery/mdnsDiscovery.ts`'s own doc comment) — this watcher's rows
 * are read-path-independent of it either way, so the two consumers just
 * happen to share one browse backend, browsed in two separate sessions
 * (an acceptable, called-out duplication until ticket 005 retires the
 * old path for good).
 *
 * ## Per-observation flow
 *
 * Browses all five service types from `specification.md` §4.4:
 * `_mbrelay._tcp`, `_mbserial._tcp`, `_mbflash._tcp`, `_robotlink._tcp`,
 * `_robotlink._udp`. Every `up` (first sight) or `onServiceChange`
 * (a SRV/TXT change on an already-known instance — see
 * `mdnsDiscovery.ts`'s `MdnsBrowser.onServiceChange` doc comment for why
 * this is a *separate* seam from `up`/`down`) upserts a `services` row,
 * then upserts the type's `links` row:
 *
 * - `_robotlink.*` → `links(wifi)`, keyed by TXT `name` (falling back to
 *   the instance name), address `{host, port}`. Both protocols collapse
 *   to the same link id, mirroring `mdnsDiscovery.ts`'s own
 *   `wifiRobotKey` rule.
 * - `_mbserial._tcp` → `links(mbserial)`; the instance name **is** the
 *   robot's name directly (`wsMessages.ts:572-575`).
 * - `_mbrelay._tcp` → `links(mbrelay)`, address including `registryPort`
 *   parsed from TXT `registry=<port>`.
 * - `_mbflash._tcp` → `services` only, no `links` row (per the issue:
 *   "not browsed" today, added here, but nothing yet connects to it).
 *
 * A `wifi`/`mbserial` link attaches to a `devices` row by name only when
 * **exactly one owned** device has that name; a `mbrelay` link attaches
 * to a `devices(kind='relay')` row by name only when exactly one such
 * row exists. Either way, more than one match (a real possibility — see
 * architecture.md §4's collision math) leaves the link unassigned
 * (`device_id = NULL`) rather than guessing, same principle as
 * `usbWatcher.ts`'s own device-linking discipline. Ticket 016-008:
 * a `wifi`/`mbserial` link that attaches to an owned device this way is
 * also promoted `discovered` → `connectable` (`promoteOwnedLinkIfDiscovered`,
 * below), mirroring `usbWatcher.ts`'s own naming->connectable promotion,
 * so the reconciler's auto-connect (which only ever considers
 * `connectable` links) actually fires for an owned WiFi/mbserial robot;
 * an unassigned link is left `discovered`.
 *
 * Unlike `wifi`/`mbserial`, a `mbrelay` link with **zero** matching
 * `kind='relay'` devices does not stay unassigned: ticket 016-005 mints
 * one with a synthetic, name-derived id (`nameToValue(name)`, the same
 * convention `store/importers/knownRobots.ts` already uses for a
 * chip-id-less device), or, when the mDNS instance name isn't a
 * well-formed five-letter micro:bit name (e.g. `torture` — ticket
 * 016-008's bench finding), a stable hash of `mbrelay:<instance>` into
 * the negative id range instead (ticket 017-005; see `handleMbrelay`'s
 * own doc comment and `store/index.ts`'s narrowed
 * `deviceIdToName(id) === name` check). This gives a remote mbrelay pool
 * this host has never identified over USB a device row of its own
 * (SUC-005), whatever its advertised name looks like, rather than
 * requiring it to already be a known local relay first. The ambiguous
 * multiple-match case above is unaffected — it still leaves the link
 * unassigned, never minting a third row to "resolve" it.
 *
 * ## Address changes without `down`/`up`
 *
 * A re-announce with a new SRV host/port (or changed TXT) does not, on
 * its own service instance (`fqdn`), fire a fresh `up` — this is exactly
 * the bug the issue calls out. `onServiceChange` is `mdnsWatcher.ts`'s
 * hook for it: each such event still upserts `services`/`links` (so the
 * address is never stale), and if the row's *previous* address differed
 * (compared via the store — no private per-link cache survives a
 * restart), any open `sessions` row for that link is marked
 * `unresponsive` so the (future, sprint 015) reconciler reconnects.
 *
 * ## Re-query and aging
 *
 * `browser.update()` (an optional `MdnsBrowser` capability — see that
 * interface's own doc comment) is called on every browsed type every
 * {@link DEFAULT_REQUERY_INTERVAL_MS}, so a boot announcement missed
 * before this watcher started is recovered within one interval rather
 * than waiting for the advertiser's own periodic announcement. The same
 * interval tick also runs the aging pass — `ageLinks(transport, ttl)`
 * for `wifi`/`mbserial`/`mbrelay`, `pruneServices(type, ttl)` for all
 * five raw `services` rows — and heartbeats a `tasks` row. TTLs live in
 * one constants block below, per the issue's own instruction, and are
 * bench-tunable, not final (`sprint.md`'s Open Questions, "TTL values
 * per mDNS/link type").
 *
 * Per `architecture.md` §6.2 ("no service-type keeps a private liveness
 * map"), a `down` event is deliberately **not** treated as
 * authoritative here — this module ages everything off `last_seen`/TTL
 * instead, so `down` is a no-op below.
 *
 * ## Presence refresh for a continuously-advertised, idle instance
 * (bench defect 1, 2026-09-12)
 *
 * A service that is still present but never changes and never goes
 * away (the common case — a robot sitting idle on the network) fires
 * neither a fresh `up` (bonjour-service only emits that for an instance
 * it has not seen before) nor `onServiceChange` (nothing changed). Left
 * alone, its `last_seen` would only ever have been set once, at first
 * sight, and every such link/service would age to `stale` after one TTL
 * regardless of how continuously it is actually still being answered on
 * the wire — exactly the bench failure this fix addresses (`torture`,
 * every idle `wifi-*` link). `backend.onAnnounce` (an existing seam —
 * `discovery/mdnsDiscovery.ts` already defined and uses it for its own,
 * now-superseded, WiFi-only liveness bookkeeping) reports every raw PTR
 * answer heard on the wire, keyed by fqdn — a periodic re-query
 * (`browser.update()`, above) reliably provokes one from anything still
 * actually present. This module remembers, per fqdn, a small closure
 * that replays the last `up`/`onServiceChange`'s own `services`/`links`
 * touch (`knownByFqdn`, in `startMdnsWatcher` below); `onAnnounce`
 * invokes it, refreshing `last_seen` without pretending anything
 * changed. A backend without `onAnnounce` (or a fqdn this watcher never
 * remembered) simply never touches anything this way — everything ages
 * off `up`/`onServiceChange` alone, exactly as before this fix.
 *
 * ## Injectable seams
 *
 * `deps.backend` is a required {@link MdnsBackend} (this ticket does not
 * construct a default real backend — ticket 009 is the first thing that
 * runs this watcher for real and supplies one, e.g. sharing
 * `mdnsDiscovery.ts`'s own real backend construction). `deps.now`
 * defaults to `Date.now`. Tests substitute a fully synthetic fake
 * backend/browser (mirroring `mdnsDiscovery.test.ts`'s own fixtures) and
 * drive the re-query/aging interval via vitest's fake timers — no real
 * multicast socket and no real wall-clock wait anywhere in this
 * module's own suite.
 */
import { nameToValue } from "@robot-console/protocol";
import { Store, type Transport } from "../store/index.js";
import type { MdnsBackend, MdnsBrowser, MdnsFindOptions, MdnsService } from "../discovery/mdnsDiscovery.js";

/** How often every browsed type's `browser.update()` re-issues its PTR
 * query, so a missed boot announcement is recovered within one
 * interval (issue rearch-03; architecture.md §6.2). Also the tick that
 * drives the aging pass below. Bench-tunable, not final — see
 * `sprint.md`'s Open Questions ("TTL values per mDNS/link type"). */
export const DEFAULT_REQUERY_INTERVAL_MS = 30_000;

/** Per-type `links`/`services` TTLs — one constants block, per the
 * issue's own instruction ("TTLs per type in one constants block").
 * ~180s matches today's WiFi sweep default (`mdnsDiscovery.ts`'s
 * `DEFAULT_WIFI_STALE_AFTER_MS`, 150s) plus slack for the 30s re-query
 * interval above, per `sprint.md`'s Open Questions suggestion. Every
 * value here is bench-tunable, not a final answer — confirm with the
 * stakeholder after the bench pass. */
export const DEFAULT_WIFI_TTL_MS = 180_000;
export const DEFAULT_MBSERIAL_TTL_MS = 180_000;
export const DEFAULT_MBRELAY_TTL_MS = 180_000;
/** `_mbflash._tcp` writes only a `services` row (no `links` row, see
 * the module doc comment) — same TTL family, applied to the `services`
 * prune pass only. */
export const DEFAULT_MBFLASH_TTL_MS = 180_000;

/** `tasks.name` this watcher heartbeats every browse cycle. */
const TASK_NAME = "mdnsWatcher";

const RELAY_FIND: MdnsFindOptions = { type: "mbrelay", protocol: "tcp" };
const SERIAL_FIND: MdnsFindOptions = { type: "mbserial", protocol: "tcp" };
const FLASH_FIND: MdnsFindOptions = { type: "mbflash", protocol: "tcp" };
const ROBOTLINK_TCP_FIND: MdnsFindOptions = { type: "robotlink", protocol: "tcp" };
const ROBOTLINK_UDP_FIND: MdnsFindOptions = { type: "robotlink", protocol: "udp" };

/** `services.type` column value for one browsed find -- unique per
 * type+protocol so `_robotlink._tcp`/`_robotlink._udp` (and any other
 * same-`type`-different-`protocol` pair) get distinct raw rows even
 * though `_robotlink.*` collapses to one `links(wifi)` row. */
function serviceRowType(find: MdnsFindOptions): string {
  return `${find.type}.${find.protocol}`;
}

/**
 * Parse a raw TXT `registry` field into a port number. Never throws —
 * mirrors `mdnsDiscovery.ts`'s own `parseRegistryPort` discipline
 * exactly (duplicated here, not imported, since that function is
 * private to that module and this one is a small, self-contained
 * parser rather than a shared dependency).
 */
function parseRegistryPort(raw: string | undefined): number | undefined {
  if (raw === undefined || !/^\d+$/.test(raw.trim())) {
    return undefined;
  }
  const parsed = Number.parseInt(raw, 10);
  return parsed > 0 && parsed <= 65535 ? parsed : undefined;
}

/** Injectable seams. See the module doc comment's "Injectable seams"
 * section. */
export interface MdnsWatcherDeps {
  /** The mDNS backend. No default — this ticket does not construct a
   * real one (ticket 009 is the first runner of this watcher and
   * supplies it). Tests inject a fully synthetic fake. */
  backend: MdnsBackend;
  /** Wall-clock reader for every store timestamp and TTL comparison.
   * Defaults to `Date.now`. */
  now?: () => number;
}

export interface MdnsWatcherOptions {
  /** How often `browser.update()` is called on every browsed type, and
   * how often the aging pass runs. Defaults to
   * {@link DEFAULT_REQUERY_INTERVAL_MS}. */
  requeryIntervalMs?: number;
  /** `links(wifi)` / matching `_robotlink.*` `services` TTL. Defaults
   * to {@link DEFAULT_WIFI_TTL_MS}. */
  wifiTtlMs?: number;
  /** `links(mbserial)` / `_mbserial._tcp` `services` TTL. Defaults to
   * {@link DEFAULT_MBSERIAL_TTL_MS}. */
  mbserialTtlMs?: number;
  /** `links(mbrelay)` / `_mbrelay._tcp` `services` TTL. Defaults to
   * {@link DEFAULT_MBRELAY_TTL_MS}. */
  mbrelayTtlMs?: number;
  /** `_mbflash._tcp` `services`-only TTL. Defaults to
   * {@link DEFAULT_MBFLASH_TTL_MS}. */
  mbflashTtlMs?: number;
  /** Sprint 018 ticket 006: browsed types to skip entirely — no
   * `backend.find()` call is ever made for a listed type, so no PTR
   * query is issued and no `services`/`links` row for it is ever
   * written. An additive constructor flag, not a code deletion: this
   * module's own `_mbrelay`/`_mbserial`/`_mbflash` handling (and this
   * suite's own tests for each) stay intact for when a future sprint
   * re-enables them. `"robotlink"` (WiFi, `_robotlink._tcp`/
   * `_robotlink._udp`) is deliberately not a value this accepts —
   * disabling WiFi discovery is out of scope for whatever calls this.
   * Defaults to `[]` (every type browsed — today's behavior unchanged
   * for any caller that does not pass this). */
  disabledTypes?: readonly ("mbserial" | "mbrelay" | "mbflash")[];
}

export interface MdnsWatcherHandle {
  /** Stop every browse session and the re-query/aging timer. Idempotent.
   * Leaves no in-memory state behind — everything this watcher tracked
   * lived in local closures over one `startMdnsWatcher` call, not a
   * class field, so a fresh `startMdnsWatcher` call after `stop()` never
   * inherits anything from the stopped run (architecture.md §6.2: "no
   * service-type keeps a private liveness map"). */
  stop(): void;
}

/**
 * Start the mDNS watcher against `store`. See the module doc comment
 * for the per-observation flow. Returns a handle whose `stop()` tears
 * everything down — there is no other way to stop this task
 * (architecture.md §3 rule 5: every long-lived task has
 * `start()`/`stop()`).
 */
export function startMdnsWatcher(
  store: Store,
  deps: MdnsWatcherDeps,
  opts: MdnsWatcherOptions = {},
): MdnsWatcherHandle {
  const backend = deps.backend;
  const now = deps.now ?? (() => Date.now());

  const requeryIntervalMs = opts.requeryIntervalMs ?? DEFAULT_REQUERY_INTERVAL_MS;
  const wifiTtlMs = opts.wifiTtlMs ?? DEFAULT_WIFI_TTL_MS;
  const mbserialTtlMs = opts.mbserialTtlMs ?? DEFAULT_MBSERIAL_TTL_MS;
  const mbrelayTtlMs = opts.mbrelayTtlMs ?? DEFAULT_MBRELAY_TTL_MS;
  const mbflashTtlMs = opts.mbflashTtlMs ?? DEFAULT_MBFLASH_TTL_MS;
  const disabledTypes = new Set(opts.disabledTypes ?? []);

  /** Bench defect 1 (2026-09-12): fqdn -> replay closure that redoes the
   * last-known `services`/`links` touch for that instance. Populated by
   * every `up`/`onServiceChange`; invoked by `backend.onAnnounce` below
   * so a bare PTR answer for an already-known, otherwise-unchanged
   * instance still counts as "seen" and refreshes `last_seen` -- this is
   * what keeps a continuously-advertised, idle link from aging to
   * `stale` (module doc comment's own aging section): `bonjour-service`
   * never fires a fresh `up` for an instance it already knows (same
   * principle the "Address changes without down/up" section already
   * describes, applied here to "no change at all"). Keyed by fqdn,
   * falling back to the service's own name for a backend/service that
   * never sets one -- mirrors `discovery/mdnsDiscovery.ts`'s own
   * `wifiLiveness` key convention exactly. `MdnsBackend.onAnnounce` is
   * not a new seam -- that module already defined and uses it for its
   * own (superseded, per this module's doc comment) WiFi-only aging;
   * this is simply the first time `mdnsWatcher.ts` itself subscribes to
   * it, for every browsed type, not only WiFi. */
  const knownByFqdn = new Map<string, () => void>();

  function upsertServiceRow(find: MdnsFindOptions, service: MdnsService): void {
    store.upsertService({
      instance: service.name,
      type: serviceRowType(find),
      host: service.host,
      port: service.port,
      txt: service.txt,
      at: now(),
    });
  }

  /** Marks `linkId` `unresponsive` iff a `sessions` row is currently
   * open for it -- read via {@link Store.snapshotRows} (no raw SQL
   * outside `store/`, per that module's own rule). */
  function markUnresponsiveIfSessionOpen(linkId: string, reason: string): void {
    const hasOpenSession = store.snapshotRows().sessions.some((row) => row.link_id === linkId);
    if (hasOpenSession) {
      store.setLinkState({ id: linkId, state: "unresponsive", at: now(), reason });
    }
  }

  /** The link row's currently-stored `address`, JSON-parsed, or
   * `undefined` if the link does not exist yet (or its address can't be
   * parsed) -- so a link's *first* observation is never treated as a
   * "change". Read via `snapshotRows()`, not a private cache, so a
   * restart never carries a stale comparison forward. */
  function storedAddress(linkId: string): unknown {
    const row = store.snapshotRows().links.find((link) => link.id === linkId);
    if (row === undefined || typeof row.address !== "string") {
      return undefined;
    }
    try {
      return JSON.parse(row.address) as unknown;
    } catch {
      return undefined;
    }
  }

  /** Upserts `linkId`'s row and, if its address actually changed since
   * the last-stored value, marks any open session on it `unresponsive`
   * (module doc comment, "Address changes without down/up"). */
  function upsertLinkAndDetectChange(
    linkId: string,
    transport: Transport,
    address: unknown,
    deviceId: number | null,
  ): void {
    const previous = storedAddress(linkId);
    store.upsertLink({ id: linkId, transport, address, deviceId, at: now() });
    if (previous !== undefined && JSON.stringify(previous) !== JSON.stringify(address)) {
      markUnresponsiveIfSessionOpen(linkId, "address changed");
    }
  }

  /** Exactly one `owned` device named `name`, or `null` — the
   * `wifi`/`mbserial` linking rule (module doc comment; architecture.md
   * §4's collision math is why this is "exactly one", not "any"). */
  function uniqueOwnedDeviceIdByName(name: string): number | null {
    const matches = store.snapshotRows().devices.filter((row) => row.name === name && Number(row.owned) === 1);
    return matches.length === 1 ? Number(matches[0]?.id) : null;
  }

  /** Exactly one `kind='relay'` device named `name`, or `null` — the
   * `mbrelay` linking rule ("a known relay", per the issue). */
  function uniqueRelayDeviceIdByName(name: string): number | null {
    const matches = store.snapshotRows().devices.filter((row) => row.name === name && row.kind === "relay");
    return matches.length === 1 ? Number(matches[0]?.id) : null;
  }

  /** Ticket 016-008's own carried fixup: promotes `linkId` from
   * `discovered` to `connectable` the instant it attaches to an owned
   * device, mirroring `usbWatcher.ts`'s own naming->connectable
   * promotion (`attach()`'s final `setLinkState` call) — without this,
   * a freshly mDNS-discovered `wifi`/`mbserial` link for an owned robot
   * sat in `discovered` forever, since nothing else in this module (or
   * the reconciler, whose auto-connect only ever considers
   * `connectable` links) ever promotes it. Reads the link's *current*
   * stored state — set by {@link upsertLinkAndDetectChange}'s own
   * `upsertLink` call just above, which only ever assigns `discovered`
   * to a brand-new row and never touches `state` on an existing one
   * (`Store.upsertLink`'s own doc comment) — so this only ever promotes
   * a link still sitting at that initial state. A link already further
   * along (`connectable`/`connecting`/`connected`/`closed_by_user`/...,
   * from a prior promotion or a live session) is left exactly as it is;
   * an unassigned link (`deviceId === null` — unowned, or still
   * ambiguous) is never touched either way. */
  function promoteOwnedLinkIfDiscovered(linkId: string, deviceId: number | null): void {
    if (deviceId === null) {
      return;
    }
    const row = store.snapshotRows().links.find((link) => link.id === linkId);
    if (row?.state === "discovered") {
      store.setLinkState({ id: linkId, state: "connectable", at: now(), reason: "mdns-owned-link" });
    }
  }

  function handleWifi(service: MdnsService): void {
    const name = service.txt?.name ?? service.name;
    const linkId = `wifi-${name}`;
    const deviceId = uniqueOwnedDeviceIdByName(name);
    upsertLinkAndDetectChange(linkId, "wifi", { host: service.host, port: service.port }, deviceId);
    promoteOwnedLinkIfDiscovered(linkId, deviceId);
  }

  function handleMbserial(service: MdnsService): void {
    const name = service.name;
    const linkId = `mbserial-${name}`;
    const deviceId = uniqueOwnedDeviceIdByName(name);
    upsertLinkAndDetectChange(linkId, "mbserial", { host: service.host, port: service.port }, deviceId);
    promoteOwnedLinkIfDiscovered(linkId, deviceId);
  }

  /** `^[zvgpt][uoiea][zvgpt][uoiea][zvgpt]$` -- mirrors
   * `@robot-console/protocol`'s own (private) `NAME_PATTERN` in
   * `naming.ts` exactly, duplicated here rather than imported for the
   * same reason `parseRegistryPort` above duplicates
   * `mdnsDiscovery.ts`'s parser: a small, self-contained shape check
   * rather than a shared dependency. Used to pre-validate a name's shape
   * *before* calling `nameToValue` (never as try/catch control flow --
   * ticket 016-008's bench finding, below). */
  const FRIENDLY_NAME_PATTERN = /^[zvgpt][uoiea][zvgpt][uoiea][zvgpt]$/;

  /** FNV-1a (32-bit) hash of `mbrelay:<instance>`, mapped into the
   * negative id range. `devices.id` stays the same `INTEGER PRIMARY KEY`
   * shape (no schema change; SQLite integers are 64-bit, so no overflow
   * risk) -- only the id-generation formula differs from the fast path's
   * `nameToValue`. Negative ids are never real chip ids
   * (`FICR.DEVICEID[1]` is unsigned 32-bit) and never collide with the
   * `nameToValue` fast path's `[0, 3124]` range either, so this is a
   * disjoint, stable, per-name id: the same `name` always hashes to the
   * same negative id, and `Store.upsertDevice` is idempotent for repeat
   * observations. See `store/index.ts`'s narrowed
   * `deviceIdToName(id) === name` check (ticket 017-005) for the other
   * half of why this only works for `kind: 'relay'` rows. */
  function hashRelayNameToNegativeId(name: string): number {
    const key = `mbrelay:${name}`;
    let hash = 0x811c9dc5; // FNV-1a 32-bit offset basis
    for (let i = 0; i < key.length; i++) {
      hash ^= key.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193); // FNV-1a 32-bit prime
    }
    const unsigned = hash >>> 0; // [0, 2^32 - 1]
    return -unsigned - 1; // [-2^32, -1] -- always negative, never zero
  }

  /** Ticket 016-005's device-creation fallback: when **zero** existing
   * `kind='relay'` devices share `name` (never the ambiguous
   * multiple-match case, which is `uniqueRelayDeviceIdByName`'s own
   * `null` too and stays unassigned exactly as before — module doc
   * comment), mint one. Two id schemes, chosen by the name's own shape:
   *
   * - A well-formed five-letter micro:bit name (`FRIENDLY_NAME_PATTERN`)
   *   gets `nameToValue(name)`, the unique value in `[0, 3124]` whose
   *   `deviceIdToName` is exactly `name`
   *   (`store/importers/knownRobots.ts`'s own convention for a
   *   chip-id-less device, reused rather than duplicated).
   * - Any other shape (ticket 016-008's bench finding: a real bench
   *   relay was observed advertising as `torture`, seven letters, not
   *   that shape at all) gets {@link hashRelayNameToNegativeId}'s stable
   *   hash instead (ticket 017-005; sprint.md's 2026-09-12 Revision and
   *   Design Rationale) -- `nameToValue` cannot accept it (no id choice
   *   can ever make `deviceIdToName(id) === name` true for a non-grammar
   *   name), so the shape is checked *before* calling it, never via
   *   try/catch as control flow.
   *
   * Per sprint.md's own Design Rationale ("an mbrelay pool's device row
   * uses a synthetic id, not a chip-id placeholder that never gets
   * 'merged' later"), this device has no future merge path — there is no
   * physical chip that could later plug into this host over USB and
   * reconcile against it, unlike a USB placeholder. `upsertDevice` is
   * itself idempotent, so a repeat observation of an already-created
   * pool is a no-op past its first. */
  function createRelayDeviceIfAbsent(name: string): number | null {
    const matches = store.snapshotRows().devices.filter((row) => row.name === name && row.kind === "relay");
    if (matches.length > 0) {
      // Either already handled by the fast-path match above (never
      // reaches here) or ambiguous (>1) -- leave unassigned rather than
      // minting a third row that would not resolve the ambiguity.
      return null;
    }
    const id = FRIENDLY_NAME_PATTERN.test(name) ? nameToValue(name) : hashRelayNameToNegativeId(name);
    store.upsertDevice({ id, name, kind: "relay", at: now() });
    return id;
  }

  function handleMbrelay(service: MdnsService): void {
    const name = service.name;
    // The existing name-match fast path stays first, unchanged
    // (regression guard); the fallback below is additive, not a
    // replacement -- see the module doc comment.
    const deviceId = uniqueRelayDeviceIdByName(name) ?? createRelayDeviceIfAbsent(name);
    upsertLinkAndDetectChange(
      `mbrelay-${name}`,
      "mbrelay",
      { host: service.host, port: service.port, registryPort: parseRegistryPort(service.txt?.registry) },
      deviceId,
    );
  }

  /** Wires one browsed type's `up`/`down`/`onServiceChange` into
   * `services` upserts plus `onObservation`'s `links` glue. `down` is
   * deliberately a no-op -- see the module doc comment. Returns the
   * browser so the caller can `update()`/`stop()` it later. */
  function subscribe(find: MdnsFindOptions, onObservation: (service: MdnsService) => void): MdnsBrowser {
    const browser = backend.find(find);
    /** Remembers `service` under its own fqdn (module doc comment,
     * `knownByFqdn`) so a later bare announce can replay the same touch
     * without waiting for a fresh `up`/`onServiceChange`. */
    function remember(service: MdnsService): void {
      const key = service.fqdn ?? service.name;
      knownByFqdn.set(key, () => {
        upsertServiceRow(find, service);
        onObservation(service);
      });
    }
    browser.on("up", (service) => {
      upsertServiceRow(find, service);
      onObservation(service);
      remember(service);
    });
    browser.on("down", () => {
      // Intentionally not authoritative -- architecture.md §6.2: aging
      // is `last_seen`/TTL-driven for every type, not event-driven, and
      // the issue's own complaint is that a re-announce with a new IP
      // fires neither `down` nor `up` anyway, so this watcher cannot
      // treat `down`'s mere presence as a reliable signal either.
    });
    browser.onServiceChange?.((service) => {
      upsertServiceRow(find, service);
      onObservation(service);
      remember(service);
    });
    return browser;
  }

  // Sprint 018 ticket 006: a disabled type's `subscribe()` is never
  // called at all -- no `backend.find()`, no PTR query, no `services`/
  // `links` row for it ever written. `_robotlink.*` (WiFi) is not a
  // value `disabledTypes` accepts, so it is always subscribed.
  const relayBrowser = disabledTypes.has("mbrelay") ? undefined : subscribe(RELAY_FIND, handleMbrelay);
  const serialBrowser = disabledTypes.has("mbserial") ? undefined : subscribe(SERIAL_FIND, handleMbserial);
  const flashBrowser = disabledTypes.has("mbflash")
    ? undefined
    : subscribe(FLASH_FIND, () => {
        // `_mbflash._tcp` writes `services` only -- `subscribe` already
        // upserted that row above; no `links` row for this type this
        // sprint (module doc comment).
      });
  const robotlinkTcpBrowser = subscribe(ROBOTLINK_TCP_FIND, handleWifi);
  const robotlinkUdpBrowser = subscribe(ROBOTLINK_UDP_FIND, handleWifi);

  const browsers: readonly MdnsBrowser[] = [
    relayBrowser,
    serialBrowser,
    flashBrowser,
    robotlinkTcpBrowser,
    robotlinkUdpBrowser,
  ].filter((browser): browser is MdnsBrowser => browser !== undefined);

  /** Bench defect 1: replay the remembered touch for whatever fqdn this
   * PTR answer named, refreshing `last_seen` without treating it as a
   * fresh `up` (module doc comment). A fqdn this watcher never
   * remembered (not one of the five browsed types, or announced before
   * this watcher's first `up` for it) is simply not in the map --
   * `Map.get` returns `undefined`, nothing happens, same as `onAnnounce`
   * being entirely absent. Optional on {@link MdnsBackend} (same
   * convention as `forget`/`update`/`onServiceChange`): a backend
   * without it just never calls this, and every browsed link ages off
   * `up`/`onServiceChange` alone, exactly as before this bench fix. */
  const unsubscribeAnnounce = backend.onAnnounce?.((fqdn) => {
    knownByFqdn.get(fqdn)?.();
  });

  function ageAndPruneOnce(): void {
    const at = now();
    store.ageLinks("wifi", wifiTtlMs, at);
    store.ageLinks("mbserial", mbserialTtlMs, at);
    store.ageLinks("mbrelay", mbrelayTtlMs, at);
    store.pruneServices(serviceRowType(RELAY_FIND), mbrelayTtlMs, at);
    store.pruneServices(serviceRowType(SERIAL_FIND), mbserialTtlMs, at);
    store.pruneServices(serviceRowType(FLASH_FIND), mbflashTtlMs, at);
    store.pruneServices(serviceRowType(ROBOTLINK_TCP_FIND), wifiTtlMs, at);
    store.pruneServices(serviceRowType(ROBOTLINK_UDP_FIND), wifiTtlMs, at);
  }

  function browseCycle(): void {
    for (const browser of browsers) {
      browser.update?.();
    }
    ageAndPruneOnce();
    store.heartbeat(TASK_NAME, now());
  }

  const timer: ReturnType<typeof setInterval> = setInterval(() => browseCycle(), requeryIntervalMs);
  timer.unref?.();

  let stopped = false;
  return {
    stop(): void {
      if (stopped) {
        return;
      }
      stopped = true;
      clearInterval(timer);
      for (const browser of browsers) {
        browser.stop();
      }
      unsubscribeAnnounce?.();
      knownByFqdn.clear();
    },
  };
}
