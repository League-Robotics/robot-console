/**
 * mbregistryWatcher.ts — keep `devices`/`links(transport='mbregistry')`
 * rows current from mbregistry's `list`/`watch` (sprint 018 ticket 002;
 * `docs/design/architecture.md` §3 rule 1, §6; sprint.md's Architecture
 * Step 3 and SUC-002/SUC-003). Sibling to `usbWatcher.ts`/`mdnsWatcher.ts`
 * — same `start.../stop()` handle shape and `tasks` heartbeat
 * convention. Writes rows only: it never calls `mbregistryClient.lock`
 * or `.stream` — that is the connector's job (later tickets in this
 * sprint), exactly as every other watcher never opens a session itself.
 *
 * ## Per-observation flow
 *
 * - **`client.list()` on start and then every `pollIntervalMs`** (default
 *   1s), reconciled against the store: each entry upserts a `devices`
 *   row and a `links(mbregistry)` row (`address: {endpoint, uid}`); an
 *   mbregistry link whose uid no longer appears in the list goes
 *   `stale`. `watch()` only carries this instance's *own* local probe
 *   events -- a board plugged into a peer host (another machine's
 *   mbregistry) reaches this console through `list` alone, so without
 *   the poll a peer board plugged in after startup would never appear.
 *   Unchanged entries are skipped (see `reconcile`), so a steady fleet
 *   costs no store writes. A `peer_up`/`peer_down` event triggers an
 *   immediate poll rather than waiting for the next tick.
 *   `devices.id` is decoded from the entry's `serial_payload` using the
 *   same per-role radix `banner.ts`'s `buildBanner` uses for a live
 *   banner identify (`role`-keyed table, duplicated here rather than
 *   imported — the table is two lines, private to that module, and this
 *   codebase's own convention for a small self-contained parser is to
 *   duplicate rather than add a shared export; see `mdnsWatcher.ts`'s
 *   own `parseRegistryPort` doc comment for the same call). `devices.
 *   usb_serial` gets the registry `uid`; `name` comes from `device_name`
 *   (`robot-console-integration.md` §2/§6 item 2).
 * - **Then `client.watch()`**, for the rest of this watcher's life:
 *   - `attach`: the link row exists (`discovered`, `deviceId: null` if
 *     not already known) — nothing more; `identity` carries the actual
 *     identification a moment later.
 *   - `identity`: same decode-and-upsert as one `list` entry, using the
 *     event's own fields. Every `identity` event is treated as
 *     unconditionally local/owned — `registry-api.md`'s `watch` section:
 *     the event bus fires only from the daemon's own local probe/attach
 *     hooks, never replayed from a peer's replicated device table (that
 *     is `list`'s job, via the per-device `host` field) — so, exactly
 *     like every USB board `usbWatcher.ts` ever identifies, a board this
 *     console's own mbregistry instance identifies over `watch()` is by
 *     definition physically local to it.
 *   - `detach`: ages the link `stale` and closes any open session, same
 *     as `usbWatcher.handleRemoved` — no owner to release, since
 *     mbregistry itself owns exclusivity for this transport (Description).
 *   - `lock_state`: no lock-state column exists yet on `links` for this
 *     transport (that lands with the connector's own mbregistry lock
 *     handling later in this sprint) — this just re-upserts the link row
 *     so `last_seen` stays fresh, the same "any observed activity
 *     refreshes last_seen" convention `mdnsWatcher.ts`'s `onAnnounce`
 *     hook already follows.
 *
 * `mergeNamePlaceholderIfAny` (`store/placeholderMerge.ts`, unmodified)
 * is called on every successful identification, mirroring
 * `usbWatcher.ts`'s own SWD-naming merge call, so a board previously
 * known only by name (a `known-robots.json` placeholder, or a different
 * transport) collapses into one row the instant mbregistry identifies it
 * (SUC-003).
 *
 * ## The "owned" rule
 *
 * Design doc §6 item 6: a device is owned by this console if it was
 * ever local to the mbregistry instance this console uses — `list`'s
 * per-device `host` field is `NULL`/absent on that row from this
 * instance's own `list` call, even though `list` now returns the whole
 * fleet. `store.setOwned` is only ever called with `true` here (never
 * `false`) — ownership, once granted, is preserved, matching
 * `store.mergeDevice`'s own OR-together `owned` semantics elsewhere in
 * this codebase.
 *
 * ## Promotion to `connectable`
 *
 * Unlike `mdnsWatcher.ts`'s `promoteOwnedLinkIfDiscovered` (guarded to
 * "still `discovered`" only, because that watcher keeps re-observing an
 * already-connected, continuously-advertised service on every re-query
 * and must never clobber a live session), mbregistry's `identity` event
 * fires once per successful probe, not on every "still here" tick —
 * there is no re-announcement-of-the-unchanged case to guard against.
 * So, mirroring `usbWatcher.ts`'s own `attach()` (which unconditionally
 * promotes to `connectable` once an attach identifies), a newly-owned,
 * newly-identified link here is promoted the same way regardless of the
 * link's prior state — including reviving one this watcher itself
 * earlier marked `stale` on `detach`, which is exactly how a
 * physically-replugged board becomes reconnectable again after
 * `usbWatcher.ts`'s analogous remove-then-add cycle.
 *
 * ## Injectable seams
 *
 * `deps.client` is the {@link MbregistryClient} built by ticket 001
 * (already connected — this watcher never calls `client.connect()`
 * itself; wiring that into `runtime.ts` is ticket 006, kept separate so
 * this ticket's own tests stay isolated to the watcher). `deps.now`
 * defaults to `Date.now`. Tests drive a hand-rolled fake client whose
 * `list()`/`watch()` are scripted directly — no real mbregistry process
 * or JSON-lines socket anywhere in this module's own suite, per
 * sprint.md's Test Strategy.
 */
import { classifyBanner, type BannerDialect } from "@robot-console/protocol";
import { Store, type DeviceKind, type LinkState, type Transport } from "../store/index.js";
import { mergeNamePlaceholderIfAny } from "../store/placeholderMerge.js";
import type { MbregistryClient, RegistryDevice, WatchEvent } from "../mbregistry/client.js";

/** `transport` value every row this watcher writes uses. */
const MBREGISTRY_TRANSPORT: Transport = "mbregistry";

/** `tasks.name` this watcher heartbeats every `list`/event cycle
 * (architecture.md §3 rule 5). */
const TASK_NAME = "mbregistryWatcher";

/** Default period between `client.list()` polls. */
const DEFAULT_POLL_INTERVAL_MS = 1000;

/** Link states the list poll may move a link out of. Anything else
 * (`connecting`/`connected`/`unresponsive`/`failed`/`closed_by_user`)
 * belongs to the connector/reconciler and is never clobbered by a poll. */
const IDLE_LINK_STATES: ReadonlySet<LinkState> = new Set(["discovered", "stale"]);

/** Serial radix, keyed by role token — mirrors `@robot-console/protocol`
 * `banner.ts`'s own (private) `SERIAL_RADIX_BY_ROLE`/`DEFAULT_SERIAL_RADIX`
 * exactly (see this module's own doc comment for why this is duplicated,
 * not imported). Applies to mbregistry's `serial_payload`, the same
 * raw serial token a banner's own `serial` field decodes, per-role. */
const SERIAL_RADIX_BY_ROLE: Readonly<Record<string, 10 | 16>> = {
  RADIOBRIDGE: 10,
  RADIORELAY: 16,
  NEZHA2: 10,
};
const DEFAULT_SERIAL_RADIX: 10 | 16 = 10;
const SERIAL_TOKEN = /^[0-9A-Fa-f]+$/;

function radixForRole(role: string): 10 | 16 {
  return SERIAL_RADIX_BY_ROLE[role] ?? DEFAULT_SERIAL_RADIX;
}

/** Decodes one `serial_payload` string into `devices.id`, or `undefined`
 * if it is missing/not a valid serial token — mirrors `banner.ts`'s
 * `buildBanner` decode step. */
function decodeChipId(serialPayload: string | null, role: string | null): number | undefined {
  if (serialPayload === null || !SERIAL_TOKEN.test(serialPayload)) {
    return undefined;
  }
  const parsed = Number.parseInt(serialPayload, radixForRole(role ?? ""));
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** The subset of identity fields both a `list` entry and an `identity`
 * event carry, used to decode a chip id and classify robot-vs-relay. */
interface IdentityFields {
  role: string | null;
  commonName: string | null;
  deviceName: string | null;
  serialPayload: string | null;
  rawAnnouncement: string | null;
}

/** Robot vs. relay, reusing `@robot-console/protocol`'s own
 * `classifyBanner` (the same classifier a live banner identify uses) —
 * built from a synthetic {@link ParsedBanner}-shaped object rather than a
 * raw banner line, since mbregistry has already parsed these same
 * logical fields out for us. `dialect`/`serial` are unused by
 * `classifyBanner` itself; `dialect: "colon"` is an arbitrary, harmless
 * placeholder (registry-api.md's own identify fields never carry which
 * dialect the original banner used).
 *
 * Bench fix 010: returns `null` when the banner is unrecognized
 * (`classification.type === "unknown"`, `evidence: "unrecognized"` —
 * e.g. the JOYSTICK-firmware device observed on the bench, which has no
 * `commonName`/`role` this classifier matches). `identify()` treats a
 * `null` result exactly like its existing "incomplete identification"
 * case (missing chip id/name): no `devices` row is upserted and the
 * link is left unpromoted, so the device still shows up — via
 * `Snapshot.unassigned`/`UnknownDevicePage`, the same place an
 * unidentified `usb` board already shows up, with its flash controls
 * intact — instead of being silently mislabeled `"robot"` and then
 * auto-connected-and-retried-forever as one. This mirrors
 * `usbWatcher.ts`'s own behavior for a board that never
 * identifies (no `devices` row, `unassigned` link, `UnknownDevicePage`)
 * rather than adding a third `DeviceKind` value: `DeviceKind` today
 * drives `DevicePage.tsx`'s exhaustive `switch (device.kind)` UI dispatch
 * (`"robot"` -> `RobotPage`, `"relay"` -> `RelayPage`), so a device with
 * no recognizable kind is represented the same way "no kind decided yet"
 * already is — no `devices` row at all — rather than teaching that
 * dispatch a third arm. See `projection.ts`'s `unassignedLinks` gate,
 * widened by this same ticket to include `mbregistry` alongside `usb`,
 * for the other half of this fix. */
function classifyDeviceKind(fields: IdentityFields): DeviceKind | null {
  const dialect: BannerDialect = "colon";
  const classification = classifyBanner({
    role: fields.role ?? "",
    commonName: fields.commonName ?? "",
    name: fields.deviceName ?? "",
    serial: 0,
    dialect,
    raw: fields.rawAnnouncement ?? "",
  });
  if (classification.type === "unknown") {
    return null;
  }
  return classification.type === "relay" ? "relay" : classification.type === "joystick" ? "joystick" : "robot";
}

function mbregistryLinkId(uid: string): string {
  return `mbregistry-${uid}`;
}

export interface MbregistryWatcherDeps {
  /** The mbregistry client from ticket 001 (`../mbregistry/client.js`),
   * already connected — this watcher only ever calls `list()`/`watch()`
   * and reads `resolvedEndpoint`. */
  client: MbregistryClient;
  /** Wall-clock reader for every store timestamp. Defaults to
   * `Date.now`. */
  now?: () => number;
  /** Period between `client.list()` polls (module doc comment).
   * Defaults to {@link DEFAULT_POLL_INTERVAL_MS}. */
  pollIntervalMs?: number;
}

export interface MbregistryWatcherHandle {
  /** Stop consuming `watch()` events. Idempotent. Does not close
   * `deps.client` — this watcher does not own the client's lifecycle
   * (a future ticket's connector may still be using it for locks/
   * streams). */
  stop(): void;
}

/**
 * Start the mbregistry watcher against `store`. See the module doc
 * comment for the per-observation flow. Returns a handle whose `stop()`
 * stops consuming events — there is no other way to stop this task
 * (architecture.md §3 rule 5: every long-lived task has
 * `start()`/`stop()`).
 */
export function startMbregistryWatcher(store: Store, deps: MbregistryWatcherDeps): MbregistryWatcherHandle {
  const client = deps.client;
  const now = deps.now ?? (() => Date.now());
  const pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  let stopped = false;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let polling = false;
  let pollAgain = false;
  /** Last-applied fingerprint per uid (see `fingerprint`), so an
   * unchanged list entry is not re-written every poll. */
  const applied = new Map<string, string>();

  /** Sprint 018 ticket 006: the link row's own `address` carries the
   * *peer device's* own routing info -- `RegistryDevice.endpoint`
   * (`"<host>:<port>"`, or `null` for a device local to this console's
   * own mbregistry instance) and `RegistryDevice.host` -- not this
   * client's own `resolvedEndpoint` (which every row previously, and
   * uselessly, carried identically regardless of which device the row
   * was for). This is what lets `connect/connector.ts`'s
   * `createMbregistryStream` default and `server.ts#runFlashTask` route
   * a connect/flash straight from the stored row instead of a live
   * `mbregistryClient.find()` round-trip. `host`/`endpoint` default to
   * `null` for a `watch()`-event-driven upsert (`attach`/`identity`/
   * `lock_state`): every such event is this instance's own local probe
   * result (module doc comment's "Per-observation flow"), so there is no
   * peer endpoint to record -- only a `list` entry for a peer-owned
   * device ever carries a non-null value here. */
  function linkAddress(uid: string, host: string | null, endpoint: string | null): { endpoint: string | null; host: string | null; uid: string } {
    return { endpoint, host, uid };
  }

  function upsertLinkRow(uid: string, deviceId: number | null, host: string | null = null, endpoint: string | null = null): void {
    store.upsertLink({
      id: mbregistryLinkId(uid),
      transport: MBREGISTRY_TRANSPORT,
      address: linkAddress(uid, host, endpoint),
      deviceId,
      at: now(),
    });
  }

  /**
   * Decodes+upserts `devices`/`links` for `uid` from `fields`, applies
   * the "owned" rule when `owned` is true, merges any known-robots/
   * other-transport placeholder, and (module doc comment's "Promotion")
   * unconditionally promotes the link to `connectable` once owned and
   * identified. Returns the resolved `devices.id`, or `undefined` if
   * `fields` does not yet carry a decodable serial/name pair (still
   * `attached_unprobed`, e.g.).
   */
  function identify(
    uid: string,
    fields: IdentityFields,
    owned: boolean,
    host: string | null = null,
    endpoint: string | null = null,
    promote: (state: LinkState | undefined) => boolean = () => true,
  ): number | undefined {
    const chipId = decodeChipId(fields.serialPayload, fields.role);
    if (chipId === undefined || fields.deviceName === null || fields.deviceName.length === 0) {
      upsertLinkRow(uid, null, host, endpoint);
      return undefined;
    }

    const kind = classifyDeviceKind(fields);
    if (kind === null) {
      // Unrecognized banner (bench fix 010) -- same treatment as an
      // incomplete identification above: see classifyDeviceKind's own
      // doc comment for why.
      upsertLinkRow(uid, null, host, endpoint);
      return undefined;
    }

    store.upsertDevice({
      id: chipId,
      name: fields.deviceName,
      kind,
      role: fields.role,
      commonName: fields.commonName,
      usbSerial: uid,
      at: now(),
    });
    if (owned) {
      store.setOwned(chipId, true, now());
    }
    mergeNamePlaceholderIfAny(store, fields.deviceName, chipId, now());

    const priorState = linkState(uid);
    upsertLinkRow(uid, chipId, host, endpoint);
    if (owned && promote(priorState)) {
      store.setLinkState({ id: mbregistryLinkId(uid), state: "connectable", at: now() });
    }
    return chipId;
  }

  /** Current state of every mbregistry link, keyed by uid. */
  function mbregistryLinkStates(): Map<string, LinkState> {
    const states = new Map<string, LinkState>();
    const prefix = mbregistryLinkId("");
    for (const link of store.reconcilerRows().links) {
      if (link.transport === MBREGISTRY_TRANSPORT && link.id.startsWith(prefix)) {
        states.set(link.id.slice(prefix.length), link.state);
      }
    }
    return states;
  }

  function linkState(uid: string): LinkState | undefined {
    return mbregistryLinkStates().get(uid);
  }

  function fieldsFromListEntry(device: RegistryDevice): IdentityFields {
    return {
      role: device.role,
      commonName: device.common_name,
      deviceName: device.device_name,
      serialPayload: device.serial_payload,
      rawAnnouncement: device.raw_announcement,
    };
  }

  function fieldsFromIdentityEvent(event: WatchEvent): IdentityFields {
    return {
      role: (event.role as string | null | undefined) ?? null,
      commonName: (event.common_name as string | null | undefined) ?? null,
      deviceName: (event.device_name as string | null | undefined) ?? null,
      serialPayload: (event.serial_payload as string | null | undefined) ?? null,
      rawAnnouncement: (event.raw_announcement as string | null | undefined) ?? null,
    };
  }

  /** mbtools' `disconnected` state — what mbregistry's own CLI renders
   * as `gone` (bench fix 010): a locally-known but currently-unplugged
   * device (the joystick observed on the bench). */
  const DISCONNECTED_STATE = "disconnected";

  function upsertFromListEntry(device: RegistryDevice): void {
    const host = device.host ?? null;
    const endpoint = device.endpoint ?? null;
    if (device.state === DISCONNECTED_STATE) {
      // Never owned/promoted for a gone device: `identify(..., false,
      // ...)` still decodes+upserts the devices/link rows as usual (so a
      // previously-seen device stays visible/named) but skips
      // `store.setOwned` and the connectable promotion, since `owned` is
      // `false`. Then explicitly mark the link `stale` -- the same call
      // `handleDetach` uses for a live `detach` event -- since
      // `identify`'s own `upsertLinkRow` never downgrades an existing
      // link's state on its own. It becomes `connectable` again the
      // normal way, via a later `attach`/`identity` event (both always
      // `owned: true`), when replugged.
      identify(device.uid, fieldsFromListEntry(device), false, host, endpoint);
      store.setLinkState({ id: mbregistryLinkId(device.uid), state: "stale", at: now() });
      return;
    }
    const owned = device.host === null || device.host === undefined;
    // A poll only ever moves a link that is idle (`IDLE_LINK_STATES`): an
    // owned one to `connectable`, a peer-owned one that had gone `stale`
    // (unplugged earlier, now back on some peer host) to `discovered`.
    identify(device.uid, fieldsFromListEntry(device), owned, host, endpoint, (state) =>
      state === undefined || IDLE_LINK_STATES.has(state),
    );
    if (!owned && linkState(device.uid) === "stale") {
      store.setLinkState({ id: mbregistryLinkId(device.uid), state: "discovered", at: now() });
    }
  }

  /** A list entry minus its per-probe timestamps -- equal fingerprints
   * mean nothing this watcher writes would change. */
  function fingerprint(device: RegistryDevice): string {
    const { last_seen: _lastSeen, last_probe: _lastProbe, first_seen: _firstSeen, ...rest } = device;
    return JSON.stringify(rest);
  }

  /** Applies one `list()` result: upserts every entry that changed (or
   * whose link was aged `stale` since, e.g. by a `detach`), and ages
   * `stale` every non-stale mbregistry link whose uid is gone from the
   * list. */
  function reconcile(devices: readonly RegistryDevice[]): void {
    const states = mbregistryLinkStates();
    const present = new Set<string>();
    for (const device of devices) {
      present.add(device.uid);
      const print = fingerprint(device);
      const state = states.get(device.uid);
      const revivable = state === "stale" && device.state !== DISCONNECTED_STATE;
      if (applied.get(device.uid) === print && state !== undefined && !revivable) {
        continue;
      }
      upsertFromListEntry(device);
      applied.set(device.uid, print);
    }
    for (const [uid, state] of states) {
      if (present.has(uid)) {
        continue;
      }
      applied.delete(uid);
      if (state !== "stale") {
        markGone(uid);
      }
    }
  }

  /** One `list()` + {@link reconcile}. Concurrent calls coalesce: a
   * request arriving mid-poll (a `peer_up` event, say) runs one more
   * poll right after, never two at once. */
  async function poll(): Promise<void> {
    if (polling) {
      pollAgain = true;
      return;
    }
    polling = true;
    try {
      do {
        pollAgain = false;
        const devices = await client.list();
        if (stopped) {
          return;
        }
        reconcile(devices);
        store.heartbeat(TASK_NAME, now());
      } while (pollAgain && !stopped);
    } finally {
      polling = false;
    }
  }

  function schedulePoll(): void {
    if (stopped) {
      return;
    }
    pollTimer = setTimeout(() => {
      poll()
        .catch(() => {
          // A failed poll (mbregistry restarting, say) just waits for the
          // next tick -- see `run`'s own doc comment.
        })
        .finally(schedulePoll);
    }, pollIntervalMs);
  }

  function handleAttach(event: WatchEvent): void {
    const uid = event.uid as string;
    upsertLinkRow(uid, null);
  }

  function handleDetach(event: WatchEvent): void {
    markGone(event.uid as string);
  }

  /** Ages `uid`'s link `stale` and closes any open session on it. */
  function markGone(uid: string): void {
    const linkId = mbregistryLinkId(uid);
    store.setLinkState({ id: linkId, state: "stale", at: now() });
    // mbregistry owns exclusivity for this transport (Description) —
    // no `board_owner`/`relay_leases` row to release here, unlike
    // `usbWatcher.handleRemoved`.
    store.closeSession(linkId);
  }

  function handleIdentity(event: WatchEvent): void {
    const uid = event.uid as string;
    // Every `identity` event is this instance's own local probe result
    // (see module doc comment's "Per-observation flow") — always owned.
    identify(uid, fieldsFromIdentityEvent(event), true);
  }

  function handleLockState(event: WatchEvent): void {
    const uid = event.uid as string;
    // No lock-state column exists yet for this transport (module doc
    // comment) — `deviceId: null` coalesces onto whatever the row
    // already has (`Store.upsertLink`'s own contract), so this only
    // ever refreshes `last_seen`.
    upsertLinkRow(uid, null);
  }

  function handleEvent(event: WatchEvent): void {
    switch (event.type) {
      case "attach":
        handleAttach(event);
        break;
      case "detach":
        handleDetach(event);
        break;
      case "identity":
        handleIdentity(event);
        break;
      case "lock_state":
        handleLockState(event);
        break;
      case "peer_up":
      case "peer_down":
        // A peer's boards arrive/leave via `list` only -- re-poll now
        // rather than waiting for the next tick.
        void poll().catch(() => {});
        break;
      default:
        // name_set/name_clear: not this watcher's concern (radio name
        // registry).
        break;
    }
  }

  async function run(): Promise<void> {
    // A `list`/`watch` failure (connection closed, transport error) must
    // not take down the caller -- mirrors `usbWatcher.ts`'s own "a failed
    // attach must not take down the poll loop" discipline. A failed first
    // poll still starts the periodic one, and a `watch` failure leaves it
    // running, so rows keep refreshing, just without the instant local
    // attach/detach events.
    try {
      await poll();
    } catch {
      // Retried on the next tick.
    }
    if (stopped) {
      return;
    }
    schedulePoll();
    try {
      for await (const event of client.watch()) {
        if (stopped) {
          return;
        }
        handleEvent(event);
        store.heartbeat(TASK_NAME, now());
      }
    } catch {
      // See above.
    }
  }

  void run();

  return {
    stop(): void {
      stopped = true;
      if (pollTimer !== undefined) {
        clearTimeout(pollTimer);
      }
    },
  };
}
