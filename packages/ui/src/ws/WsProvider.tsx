/**
 * WsProvider.tsx — the one WebSocket connection the UI holds open to
 * `packages/host`'s `server.ts`, per `wsMessages.ts`'s contract.
 *
 * ## Sprint 015 ticket 007: one `snapshot` slice replaces five
 *
 * Tickets 004/005 replaced the old `endpoints`/`firmwareStatus`/
 * `rememberedRobots`/`discoveredServices`/`wifiCredentials`/
 * `wifiProvisionResultByEndpoint`/`flashProgressByEndpoint` grab-bag
 * with one `Snapshot` message (`type: "snapshot"`), sent in full on
 * every connect and again on every coalesced host-side change (never a
 * delta, so a client that missed a broadcast self-heals on the next
 * one). This module mirrors that: the store now holds a `devicesById`/
 * `devicesArray`/`unassigned`/`relays`/`firmware`/`wifiSetting`/`tasks`
 * set built from the latest `Snapshot`, in place of the five old
 * per-concept slices. `EndpointListEntry` (and the `endpointId` vocabulary
 * generally) is retired throughout — the addressable unit is now a
 * `linkId` (`links.id`, opaque, one physical/logical connection), owned
 * by a `SnapshotDevice` (`devices.id`, a stable chip identity) inside
 * `devices[]`, or listed bare in `unassigned[]` for a USB board not yet
 * identified to any device.
 *
 * **Why a ref-backed store instead of `useState`, and why
 * `useSyncExternalStore` selectors instead of one `useWs()` grab-bag:**
 * unchanged from ticket 006's reasoning — every field lived in its own
 * `useState` before that ticket, re-rendering every consumer on every
 * message; a plain mutable `Store` in a ref, mutated only by this
 * provider's socket handlers and read through granular selectors whose
 * `getSnapshot` returns a referentially stable value when its slice
 * didn't change, is what makes a 20Hz `telemetry` stream and a busy
 * `line` log survive without turning every mounted component into a
 * render storm. `deepEqual`/structural sharing below reuses the
 * previous `SnapshotDevice`/`SnapshotLink` object for any device/link
 * whose fields are unchanged between two snapshots — the snapshot is a
 * fresh `JSON.parse` every time, so naive reuse of `parsed.devices`
 * would hand out a new object per device on every message even when
 * nothing about that device changed, exactly the `getSnapshot` pitfall
 * that makes React re-render (or loop) needlessly.
 *
 * **Socket lifecycle split into `connect()`/`dispatch()`:** the old
 * 137-line `useEffect` folded socket setup and the whole message
 * `switch` into one closure. `dispatch(store, message)` below is now a
 * standalone function the `"message"` listener merely calls, so the
 * per-message-type handling can be read (and tested indirectly through
 * `FakeSocket`) independent of the connect/reconnect plumbing.
 *
 * **Snapshot staleness (rearch-07 / UC-020):** `store.stale` starts
 * `false`, flips to `true` the instant the socket closes (whether or
 * not a snapshot was ever held — harmless either way), and is cleared
 * only by the next `"snapshot"` message actually landing. Combined with
 * `status` via `useHostConnection()`, this is what feeds ticket 009's
 * disconnected banner: the UI never blanks the last-known device list
 * on a drop (matches the old behavior), but a consumer that cares can
 * now tell "this list is current" from "this list is what we had before
 * we lost the host".
 *
 * **The hoisted log buffer, the telemetry ring, flash progress, Wi-Fi
 * credentials/provision results:** all carried over from ticket 006
 * essentially unchanged, just re-keyed by `linkId` instead of
 * `endpointId` (`LineMessage`/`TelemetryMessage`/`FlashProgressMessage`/
 * `FlashResultMessage`/`WifiProvisionResultMessage` all rename that
 * field the same way). `useFlashProgress` still prefers a live
 * `flash-progress` event when one has arrived, but now falls back to
 * the snapshot's own `SnapshotLink.flash` (populated host-side,
 * `server.ts`, from the same in-memory flash state) rather than to
 * nothing — a client that reconnects mid-flash self-heals for every
 * source kind, closing the gap ticket 006's own doc comment flagged for
 * a local-hex source.
 *
 * **`type: "notice"` replaces `type: "error"`:** a notice carries an
 * optional `linkId` (scoped) and a `level` (`"info"|"warn"|"error"`). A
 * link-scoped notice is appended to that link's console log exactly as
 * a host error used to be (`origin: "host"`, forcing the same "error"
 * kind styling regardless of `level` — `DeviceConsole`'s own level-aware
 * styling is left for a later ticket). A connection-level notice (no
 * `linkId` — a malformed message, a task failure) is dropped rather
 * than shown anywhere, mirroring the old no-`endpointId` behavior: this
 * store still has no global banner surface of its own.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type {
  ClientMessage,
  FirmwareAvailability,
  FirmwareKind,
  FirmwareSourceRef,
  FlashLocalReadyMessage,
  FlashPhase,
  FlashResultMessage,
  LineMessage,
  ServerMessage,
  Snapshot,
  SnapshotDevice,
  SnapshotLink,
  SnapshotRelay,
  TelemetryMessage,
  WifiCredentialsMessage,
  WifiProvisionResultMessage,
} from "@robot-console/host/src/wsMessages.js";
import type { WireField } from "@robot-console/protocol";

export type ConnectionStatus = "connecting" | "open" | "closed";

/** Combined connection status + snapshot staleness -- see this module's
 * doc comment ("Snapshot staleness"). Feeds ticket 009's disconnected
 * banner (`useHostConnection`). */
export interface HostConnectionState {
  status: ConnectionStatus;
  /** `true` once the socket has closed since the last `snapshot`
   * arrived (or before any has ever arrived) -- the held device list
   * may no longer reflect reality. Cleared the instant a fresh
   * `snapshot` lands. */
  stale: boolean;
}

/** One line in a link's console log, in the order it was appended.
 * Unchanged from ticket 006's `LogEntry` except in name only (this
 * module now speaks `linkId`, not `endpointId`) -- see that ticket's own
 * doc comment for `origin`'s two values. */
export interface LogEntry {
  id: number;
  direction: "tx" | "rx";
  line: string;
  origin?: "host" | "poll";
}

/** Bench defect 010 addendum (2026-09-13), fix item 3: one link-scoped
 * host `notice` -- e.g. a refused or failed Connect's reason -- as
 * `useLinkNotices()` hands it to `FrontPage.tsx`. */
export interface LinkNotice {
  text: string;
  level: "info" | "warn" | "error";
  at: number;
}

/** Maximum lines retained per link in the in-memory log. Renamed from
 * `MAX_LINES_PER_DEVICE` (ticket 006) -- same constant, same value, the
 * link vocabulary this ticket completes. */
export const MAX_LINES_PER_LINK = 500;

/** How many distinct links' logs this store keeps at once. Renamed
 * from `MAX_TRACKED_ENDPOINT_LOGS` for the same reason as {@link
 * MAX_LINES_PER_LINK}. */
export const MAX_TRACKED_LINK_LOGS = 8;

/** Shared empty array returned by `useLinkLog` for a link with no log
 * yet, so repeated calls before any line arrives return the same
 * reference. */
const EMPTY_LOG: readonly LogEntry[] = [];

let nextLogEntryId = 0;

/** Maximum frames retained per link in the telemetry ring buffer.
 * Unchanged from ticket 006 (sprint 9 ticket 003) -- see that ticket's
 * own doc comment for the 600-frame/60s reasoning. */
export const TELEMETRY_RING_CAPACITY = 600;

/** One decoded telemetry frame, ready for chart/trace consumption.
 * Unchanged from ticket 006. */
export interface TelemetryFrame {
  t: number;
  values: Record<string, number>;
}

/** Which telemetry stream, if any, a robot should push -- unchanged
 * from ticket 006. */
export type TelemetryMode = "POSE" | "FULL" | "OFF" | "HDR";

/** The imperative, non-React-reactive interface to one link's
 * telemetry ring. Unchanged from ticket 006 except in name (`linkId`). */
export interface TelemetryHandle {
  readonly header: readonly string[] | undefined;
  readonly latest: TelemetryFrame | undefined;
  snapshot(): TelemetryFrame[];
  subscribe(cb: (frame: TelemetryFrame) => void): () => void;
  clear(): void;
}

/** Fixed-capacity ring buffer backing one link's telemetry slice.
 * Unchanged from ticket 006. */
class TelemetryRing {
  private readonly buffer: (TelemetryFrame | undefined)[];
  private start = 0;
  private count = 0;

  constructor(private readonly capacity: number) {
    this.buffer = new Array(capacity);
  }

  push(frame: TelemetryFrame): void {
    const index = (this.start + this.count) % this.capacity;
    this.buffer[index] = frame;
    if (this.count < this.capacity) {
      this.count += 1;
    } else {
      this.start = (this.start + 1) % this.capacity;
    }
  }

  snapshot(): TelemetryFrame[] {
    const out: TelemetryFrame[] = [];
    for (let i = 0; i < this.count; i++) {
      out.push(this.buffer[(this.start + i) % this.capacity]!);
    }
    return out;
  }

  latest(): TelemetryFrame | undefined {
    if (this.count === 0) {
      return undefined;
    }
    return this.buffer[(this.start + this.count - 1) % this.capacity];
  }

  clear(): void {
    this.buffer.fill(undefined);
    this.start = 0;
    this.count = 0;
  }
}

/** One link's telemetry state. Unchanged from ticket 006 except in
 * name (`linkId`-keyed). */
interface TelemetrySlice {
  header: readonly string[] | undefined;
  ring: TelemetryRing;
  frameListeners: Set<(frame: TelemetryFrame) => void>;
}

/** The latest known progress of an in-flight flash for one link, from a
 * live `flash-progress` event -- shape mirrors `SnapshotLink.flash`
 * exactly (both are `{ source, phase }`), so `useFlashProgress` can fall
 * back to the snapshot's own value with no conversion. */
export interface FlashProgressState {
  source: FirmwareSourceRef;
  phase: FlashPhase;
}

const DEFAULT_FIRMWARE_STATUS: Record<FirmwareKind, FirmwareAvailability> = {
  relay: { configured: false },
  robot: { configured: false },
};

const DEFAULT_WIFI_SETTING: Snapshot["wifi"] = { ssid: null, source: null };

/** Carried from ticket 006 (rearch-08 UI remainder): "Migration nicety:
 * on first load, if `localStorage` holds a radio override for a device
 * present in the snapshot, offer to push it via `set-radio-override`,
 * then clear the key; no prompt otherwise."
 *
 * Sprint 015 ticket 006 removed the reader/writer for this key
 * (`RelayPage.tsx`'s former `readStoredAddress`/`writeStoredAddress`)
 * entirely as part of moving radio overrides into the host DB, but a
 * student's browser from before that ticket may still hold one of these
 * keys -- this scan is the one-shot bridge from that old cache into the
 * new `set-radio-override` message, so a value nobody else can see any
 * more doesn't just silently stop applying. `robot-console:relay-
 * address:<name>` was the old per-name key; the value's shape and
 * validation mirror `readStoredAddress` exactly (an integer
 * `{channel, group}`, anything else treated as nothing stored). */
const RADIO_MIGRATION_KEY_PREFIX = "robot-console:relay-address:";

export interface PendingRadioMigration {
  deviceId: number;
  name: string;
  channel: number;
  group: number;
  /** The exact `localStorage` key this candidate came from -- needed to
   * clear it once the student has been offered the choice. */
  storageKey: string;
}

/** Scan `localStorage` once for every `robot-console:relay-address:<name>`
 * key whose `<name>` matches a device in the current snapshot -- see
 * this module's own doc comment. Best-effort: a disabled/quota-exceeded
 * `localStorage`, or malformed JSON left by an older build, is treated
 * as "nothing to offer", never thrown (mirrors the retired
 * `readStoredAddress`'s own failure handling). */
function scanPendingRadioMigrations(devices: readonly SnapshotDevice[]): PendingRadioMigration[] {
  const results: PendingRadioMigration[] = [];
  try {
    const deviceByName = new Map(devices.map((d) => [d.name, d] as const));
    for (let i = 0; i < window.localStorage.length; i++) {
      const storageKey = window.localStorage.key(i);
      if (!storageKey || !storageKey.startsWith(RADIO_MIGRATION_KEY_PREFIX)) {
        continue;
      }
      const name = storageKey.slice(RADIO_MIGRATION_KEY_PREFIX.length);
      const device = deviceByName.get(name);
      if (!device) {
        continue;
      }
      const raw = window.localStorage.getItem(storageKey);
      if (!raw) {
        continue;
      }
      try {
        const parsed: unknown = JSON.parse(raw);
        if (
          typeof parsed === "object" &&
          parsed !== null &&
          Number.isInteger((parsed as { channel: unknown }).channel) &&
          Number.isInteger((parsed as { group: unknown }).group)
        ) {
          const { channel, group } = parsed as { channel: number; group: number };
          results.push({ deviceId: device.id, name, channel, group, storageKey });
        }
      } catch {
        // Malformed JSON left by an older build -- nothing to offer for
        // this key, but keep scanning the rest.
      }
    }
  } catch {
    // localStorage disabled/unavailable entirely -- nothing to offer.
  }
  return results;
}

/** The slice of the browser `WebSocket` API this module actually uses.
 * Unchanged from ticket 006. */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string | ArrayBufferLike | ArrayBufferView): void;
  close(): void;
  addEventListener(type: string, listener: (event: unknown) => void): void;
  removeEventListener(type: string, listener: (event: unknown) => void): void;
}

const WEBSOCKET_OPEN = 1;

/** Structural (deep) equality over plain JSON-shaped values -- every
 * field on `SnapshotDevice`/`SnapshotLink`/`FirmwareAvailability` is a
 * primitive, plain object, or array of those, so a generic recursive
 * comparison is enough. Unchanged from ticket 006. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) {
    return false;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) {
        return false;
      }
    }
    return true;
  }
  const aRecord = a as Record<string, unknown>;
  const bRecord = b as Record<string, unknown>;
  const aKeys = Object.keys(aRecord);
  const bKeys = Object.keys(bRecord);
  if (aKeys.length !== bKeys.length) {
    return false;
  }
  for (const key of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(bRecord, key) || !deepEqual(aRecord[key], bRecord[key])) {
      return false;
    }
  }
  return true;
}

/** The ref-backed store: one instance per `WsProvider` mount, mutated
 * only by that provider's socket event handlers, and read by consumer
 * hooks via `useSyncExternalStore`. */
interface Store {
  status: ConnectionStatus;
  /** `false` until the first `snapshot` message is processed, `true`
   * forever after -- including across a reconnect (see {@link stale}
   * for the "is this still current" question `hasSnapshot` alone no
   * longer answers on its own). */
  hasSnapshot: boolean;
  /** See {@link HostConnectionState.stale}'s own doc comment. */
  stale: boolean;
  deviceIds: number[];
  devicesById: Map<number, SnapshotDevice>;
  /** Cached array form of `devicesById` in `deviceIds` (host) order, for
   * `useDevices()`. Only rebuilt when some device actually changed, was
   * added, removed, or reordered. */
  devicesArray: SnapshotDevice[];
  unassignedIds: string[];
  /** Cached array form for `useUnassigned()`, same rebuild discipline as
   * {@link devicesArray}. */
  unassignedArray: SnapshotLink[];
  /** Every link from `devices[].links` and `unassigned[]`, flattened and
   * keyed by `linkId`, with the same per-entry structural sharing as
   * {@link devicesById} -- backs `useLink`. */
  linksById: Map<string, SnapshotLink>;
  /** `linkId -> deviceId` for every link inside a `devices[]` entry
   * (never for an `unassigned` link, which has no owning device) --
   * backs `useDeviceForLink`. */
  linkOwnerById: Map<string, number>;
  relays: SnapshotRelay[];
  firmware: Record<FirmwareKind, FirmwareAvailability>;
  wifiSetting: Snapshot["wifi"];
  tasks: Snapshot["tasks"];
  logsByLink: Map<string, LogEntry[]>;
  /** LRU order for `logsByLink`, oldest-touched first. */
  logOrder: string[];
  /** Bench defect 010 addendum (2026-09-13, "dead transport leaves
   * session, blocks reconnect", fix item 3): the most recent link-scoped
   * `notice` for each `linkId`, so a front-page card row can show a
   * refused/failed Connect's reason even though nothing in `logsByLink`
   * (the device console, not shown on the front page) is ever visible
   * there. Populated by `appendNotice`; cleared once that link is next
   * reported `connected` in a snapshot (`applySnapshot` below) -- a
   * stale refusal must not outlive the problem it described. Always
   * replaced with a fresh `Map` on either write (never mutated in
   * place), so `useLinkNotices()`'s `useSyncExternalStore` snapshot
   * actually changes reference when it changes. */
  linkNotices: Map<string, LinkNotice>;
  /** Live `flash-progress` overlay -- see `useFlashProgress`'s own doc
   * comment for why this is consulted ahead of, not instead of, the
   * snapshot's own `SnapshotLink.flash`. */
  flashProgressByLink: Map<string, FlashProgressState>;
  flashResultHandlers: Set<(message: FlashResultMessage) => void>;
  flashLocalReadyHandlers: Set<(message: FlashLocalReadyMessage) => void>;
  wifiCredentials: WifiCredentialsMessage | undefined;
  wifiProvisionResultByLink: Map<string, WifiProvisionResultMessage>;
  telemetryByLink: Map<string, TelemetrySlice>;
  /** See `scanPendingRadioMigrations`'s own doc comment -- populated
   * once, the first time a snapshot arrives, never rescanned after. */
  pendingRadioMigrations: PendingRadioMigration[];
  radioMigrationScanned: boolean;
  listeners: Set<() => void>;
  subscribe: (cb: () => void) => () => void;
  actions: WsActions;
}

export interface WsActions {
  send: (message: ClientMessage) => void;
  /** Send one raw binary WebSocket frame -- the local-hex upload
   * handshake's binary half. Unchanged from ticket 006. */
  sendBinary: (data: Uint8Array) => void;
  /** Send one protocol verb, with optional fields, to a link's open
   * session -- forwards `{ type: "send-command", linkId, verb, fields
   * }`. Unchanged from ticket 006 except the field rename. */
  sendCommand: (linkId: string, verb: string, fields?: WireField[]) => void;
  onFlashResult: (handler: (message: FlashResultMessage) => void) => () => void;
  onFlashLocalReady: (handler: (message: FlashLocalReadyMessage) => void) => () => void;
  /** Empty one link's log buffer. Renamed from `clearEndpointLog`. */
  clearLinkLog: (linkId: string) => void;
  /** Empty one link's telemetry ring. Unchanged from ticket 006 except
   * the field rename. */
  clearTelemetry: (linkId: string) => void;
  /** Request the robot change (or re-announce) its telemetry stream.
   * Unchanged from ticket 006 except the field rename. */
  telemetrySubscribe: (linkId: string, mode: TelemetryMode) => void;
  /** Resolve one `useRadioMigrationOffers()` candidate: `apply: true`
   * sends `set-radio-override` with the candidate's stored
   * `channel`/`group` first; either way, the `localStorage` key is
   * cleared and the candidate removed from the pending list -- a
   * decline is still a resolution, not a re-prompt-next-time. */
  resolveRadioMigration: (deviceId: number, apply: boolean) => void;
}

function notify(store: Store): void {
  for (const listener of store.listeners) {
    listener();
  }
}

/** The `linkId` a `ClientMessage` is scoped to, if any -- either its own
 * `linkId` field, or (for `SessionOpenMessage`'s `{relayLinkId, name}`
 * shape) the relay's own connectivity link, which does have a console
 * log even though no session is open on it yet. Everything else
 * (`SetRadioOverrideMessage`, `ForgetDeviceMessage`,
 * `GetWifiCredentialsMessage`, `SetWifiCredentialsMessage`,
 * `FlashLocalBeginMessage`) has no link-scoped console to write a
 * dropped-send notice into. */
function messageLogLinkId(message: ClientMessage): string | undefined {
  if ("linkId" in message && typeof message.linkId === "string") {
    return message.linkId;
  }
  if ("relayLinkId" in message && typeof message.relayLinkId === "string") {
    return message.relayLinkId;
  }
  return undefined;
}

function touchLog(store: Store, linkId: string): void {
  const idx = store.logOrder.indexOf(linkId);
  if (idx !== -1) {
    store.logOrder.splice(idx, 1);
  }
  store.logOrder.push(linkId);
  while (store.logOrder.length > MAX_TRACKED_LINK_LOGS) {
    const evicted = store.logOrder.shift();
    if (evicted !== undefined) {
      store.logsByLink.delete(evicted);
    }
  }
}

/** Shared tail of `appendLine`/`appendNotice`: append one entry to
 * `linkId`'s log, enforce `MAX_LINES_PER_LINK`, and mark the link as
 * recently active for the LRU tracked set. */
function pushLogEntry(store: Store, linkId: string, entry: Omit<LogEntry, "id">): void {
  const existing = store.logsByLink.get(linkId) ?? [];
  const next = existing.concat({ id: nextLogEntryId++, ...entry });
  if (next.length > MAX_LINES_PER_LINK) {
    next.splice(0, next.length - MAX_LINES_PER_LINK);
  }
  store.logsByLink.set(linkId, next);
  touchLog(store, linkId);
}

function appendLine(store: Store, message: LineMessage): void {
  // `exactOptionalPropertyTypes` forbids `origin: undefined` -- the key
  // must be absent entirely when the incoming message carries none.
  pushLogEntry(
    store,
    message.linkId,
    message.origin !== undefined
      ? { direction: message.direction, line: message.line, origin: message.origin }
      : { direction: message.direction, line: message.line },
  );
}

/** Append a synthesized log entry for a link-scoped `type: "notice"`
 * message -- see this module's doc comment ("`type: "notice"` replaces
 * `type: "error"`"). Returns whether an entry was actually appended, so
 * the caller can skip an unnecessary `notify(store)` when nothing
 * changed. */
function appendNotice(store: Store, message: Extract<ServerMessage, { type: "notice" }>): boolean {
  if (message.linkId === undefined) {
    return false;
  }
  pushLogEntry(store, message.linkId, { direction: "rx", line: message.text, origin: "host" });
  // A fresh `Map` (copy-on-write), not a mutate-in-place `.set()`, so
  // `useLinkNotices()`'s `useSyncExternalStore` snapshot -- the whole map,
  // read once by the one hook-bearing page (`FrontPage.tsx`) and threaded
  // down as a plain prop from there, matching `sendable`/`onLinkConnect`
  // -- actually changes reference and re-renders; mutating the existing
  // `Map` object in place would leave `useSyncExternalStore`'s identity
  // check with nothing to notice.
  const next = new Map(store.linkNotices);
  next.set(message.linkId, { text: message.text, level: message.level, at: message.at });
  store.linkNotices = next;
  return true;
}

/** Empty `linkId`'s telemetry ring, if a slice exists for it yet -- a
 * no-op otherwise. Shared by `applySnapshot`'s session-close handling
 * and `WsActions.clearTelemetry`/`TelemetryHandle.clear`. Never touches
 * `header`. */
function clearTelemetrySlice(store: Store, linkId: string): void {
  store.telemetryByLink.get(linkId)?.ring.clear();
}

/** Return `linkId`'s telemetry slice, creating an empty one on first
 * reference. */
function getOrCreateTelemetrySlice(store: Store, linkId: string): TelemetrySlice {
  let slice = store.telemetryByLink.get(linkId);
  if (!slice) {
    slice = { header: undefined, ring: new TelemetryRing(TELEMETRY_RING_CAPACITY), frameListeners: new Set() };
    store.telemetryByLink.set(linkId, slice);
  }
  return slice;
}

/** Handle one `"telemetry"` message. Unchanged from ticket 006 except
 * the field rename -- see that ticket's own doc comment. */
function handleTelemetryMessage(store: Store, message: TelemetryMessage): void {
  const slice = getOrCreateTelemetrySlice(store, message.linkId);
  if (message.header !== undefined) {
    slice.header = message.header;
    slice.ring.clear();
    notify(store);
  }
  if (message.frame !== undefined) {
    if (slice.header === undefined) {
      return;
    }
    const values: Record<string, number> = {};
    for (const [key, raw] of Object.entries(message.frame)) {
      values[key] = Number(raw);
    }
    const frame: TelemetryFrame = { t: Date.now(), values };
    slice.ring.push(frame);
    for (const listener of slice.frameListeners) {
      listener(frame);
    }
  }
}

/** Rebuild an ordered array from a map of structurally-shared entries,
 * reusing the previous array reference whenever the ids and every
 * entry's identity are unchanged -- the same "only rebuild when
 * something actually changed" discipline `applySnapshot` used for
 * `endpointsArray` pre-ticket-007, generalized so `devicesArray` and
 * `unassignedArray` share one implementation. */
function rebuildArray<K, V>(
  previousIds: readonly K[],
  previousArray: readonly V[],
  nextIds: readonly K[],
  nextById: ReadonlyMap<K, V>,
): V[] {
  const idsChanged = nextIds.length !== previousIds.length || nextIds.some((id, i) => id !== previousIds[i]);
  const anyEntryChanged = idsChanged || nextIds.some((id, i) => nextById.get(id) !== previousArray[i]);
  if (!anyEntryChanged) {
    return previousArray as V[];
  }
  return nextIds.map((id) => nextById.get(id)!);
}

/** Apply one `Snapshot` to the store: structural-shares every device
 * and link that is byte-for-byte unchanged from the previous snapshot
 * (so an unrelated `useDevice`/`useLink` consumer's cached value keeps
 * its identity and does not re-render), replaces `relays`/`firmware`/
 * `wifiSetting`/`tasks` only when they actually differ, resets a link's
 * telemetry ring on a session-close transition, and clears the
 * `flash-progress` overlay for any link the snapshot no longer reports
 * mid-flash. */
function applySnapshot(store: Store, snapshot: Snapshot): void {
  const nextLinksById = new Map<string, SnapshotLink>();
  const nextLinkOwnerById = new Map<string, number>();

  function shareLink(link: SnapshotLink): SnapshotLink {
    const previous = store.linksById.get(link.id);
    const shared = previous && deepEqual(previous, link) ? previous : link;
    nextLinksById.set(link.id, shared);
    return shared;
  }

  const nextDeviceIds: number[] = [];
  const nextDevicesById = new Map<number, SnapshotDevice>();
  for (const device of snapshot.devices) {
    // Share every link first (regardless of whether the device object
    // itself is reused) so `useLink`/`useDeviceForLink` stay stable even
    // when a sibling link on the same device changed.
    for (const link of device.links) {
      shareLink(link);
      nextLinkOwnerById.set(link.id, device.id);
    }
    const previousDevice = store.devicesById.get(device.id);
    const deviceObj = previousDevice && deepEqual(previousDevice, device) ? previousDevice : device;
    nextDevicesById.set(device.id, deviceObj);
    nextDeviceIds.push(device.id);
  }

  const nextUnassignedIds: string[] = [];
  for (const link of snapshot.unassigned) {
    shareLink(link);
    nextUnassignedIds.push(link.id);
  }

  // Telemetry reset + flash-progress overlay cleanup, over every link in
  // the new snapshot (owned or unassigned) -- mirrors ticket 006's own
  // per-entry pass.
  // A refused/failed Connect's notice (fix item 3, bench defect 010
  // addendum) must not outlive the problem it described -- once a link is
  // reported `connected` again, whatever it said is moot. Copy-on-write,
  // same reasoning as `appendNotice`'s own doc comment: only replace
  // `linkNotices` (a new `Map`) when something in it actually changes.
  let nextLinkNotices: Store["linkNotices"] | undefined;
  for (const [linkId, link] of nextLinksById) {
    const previousLink = store.linksById.get(linkId);
    if (previousLink?.session !== undefined && link.session === undefined) {
      clearTelemetrySlice(store, linkId);
    }
    if (!link.flash) {
      store.flashProgressByLink.delete(linkId);
    }
    if (link.state === "connected" && store.linkNotices.has(linkId)) {
      nextLinkNotices ??= new Map(store.linkNotices);
      nextLinkNotices.delete(linkId);
    }
  }
  if (nextLinkNotices) {
    store.linkNotices = nextLinkNotices;
  }

  store.devicesArray = rebuildArray(store.deviceIds, store.devicesArray, nextDeviceIds, nextDevicesById);
  store.unassignedArray = rebuildArray(store.unassignedIds, store.unassignedArray, nextUnassignedIds, nextLinksById);
  store.deviceIds = nextDeviceIds;
  store.devicesById = nextDevicesById;
  store.unassignedIds = nextUnassignedIds;
  store.linksById = nextLinksById;
  store.linkOwnerById = nextLinkOwnerById;

  if (!deepEqual(store.relays, snapshot.relays)) {
    store.relays = snapshot.relays;
  }
  if (!deepEqual(store.firmware, snapshot.firmware)) {
    store.firmware = snapshot.firmware;
  }
  if (!deepEqual(store.wifiSetting, snapshot.wifi)) {
    store.wifiSetting = snapshot.wifi;
  }
  if (!deepEqual(store.tasks, snapshot.tasks)) {
    store.tasks = snapshot.tasks;
  }

  store.hasSnapshot = true;
  store.stale = false;

  // Migration nicety (carried from ticket 006): scan for a leftover
  // localStorage radio override exactly once, the first time a
  // snapshot's device roster is known -- see `scanPendingRadioMigrations`'s
  // own doc comment.
  if (!store.radioMigrationScanned) {
    store.pendingRadioMigrations = scanPendingRadioMigrations(store.devicesArray);
    store.radioMigrationScanned = true;
  }
}

function createStore(): Store {
  const listeners = new Set<() => void>();
  const store: Store = {
    status: "connecting",
    hasSnapshot: false,
    stale: false,
    deviceIds: [],
    devicesById: new Map(),
    devicesArray: [],
    unassignedIds: [],
    unassignedArray: [],
    linksById: new Map(),
    linkOwnerById: new Map(),
    relays: [],
    firmware: DEFAULT_FIRMWARE_STATUS,
    wifiSetting: DEFAULT_WIFI_SETTING,
    tasks: [],
    logsByLink: new Map(),
    logOrder: [],
    linkNotices: new Map(),
    flashProgressByLink: new Map(),
    flashResultHandlers: new Set(),
    flashLocalReadyHandlers: new Set(),
    wifiCredentials: undefined,
    wifiProvisionResultByLink: new Map(),
    telemetryByLink: new Map(),
    pendingRadioMigrations: [],
    radioMigrationScanned: false,
    listeners,
    subscribe: (cb: () => void) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    actions: undefined as unknown as WsActions,
  };
  return store;
}

const StoreContext = createContext<Store | undefined>(undefined);

/** Fixed delay before retrying after an unexpected close. Unchanged
 * from ticket 006. */
const RECONNECT_DELAY_MS = 1500;

function defaultSocketUrl(): string {
  const configured = import.meta.env.VITE_WS_URL;
  if (typeof configured === "string" && configured !== "") {
    return configured;
  }
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  return `${protocol}://${window.location.host}/`;
}

function defaultSocketFactory(url: string): WebSocketLike {
  return new WebSocket(url) as unknown as WebSocketLike;
}

function isServerMessage(value: unknown): value is ServerMessage {
  return typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string";
}

/** Handle one already-JSON-parsed, already-shape-checked server
 * message: the per-`type` dispatch the old inline `switch` inside the
 * socket effect used to hold -- split out (this module's doc comment,
 * "Socket lifecycle split into connect()/dispatch()") so the connect/
 * reconnect plumbing around it stays small. */
function dispatch(store: Store, message: ServerMessage): void {
  switch (message.type) {
    case "snapshot":
      applySnapshot(store, message);
      notify(store);
      break;
    case "notice":
      if (appendNotice(store, message)) {
        notify(store);
      }
      break;
    case "line":
      appendLine(store, message);
      notify(store);
      break;
    case "flash-progress":
      store.flashProgressByLink.set(message.linkId, { source: message.source, phase: message.phase });
      notify(store);
      break;
    case "flash-result":
      store.flashProgressByLink.delete(message.linkId);
      for (const handler of store.flashResultHandlers) {
        handler(message);
      }
      notify(store);
      break;
    case "flash-local-ready":
      // Not store-backed state -- no `notify(store)` needed, mirroring
      // ticket 006's own `flashLocalReadyHandlers` doc comment.
      for (const handler of store.flashLocalReadyHandlers) {
        handler(message);
      }
      break;
    case "wifi-credentials":
      store.wifiCredentials = message;
      notify(store);
      break;
    case "wifi-provision-result":
      store.wifiProvisionResultByLink.set(message.linkId, message);
      notify(store);
      break;
    case "telemetry":
      // Deliberately does not call `notify(store)` itself here --
      // `handleTelemetryMessage` only does so for a header update; a
      // frame update fans out to that link's own `frameListeners`
      // instead, per this module's doc comment.
      handleTelemetryMessage(store, message);
      break;
  }
}

export interface WsProviderProps {
  children: ReactNode;
  /** Override the socket URL (tests only; production always connects
   * back to the host that served this page). */
  url?: string;
  /** Override how a socket is constructed (tests only; production uses
   * the real browser `WebSocket`). */
  socketFactory?: (url: string) => WebSocketLike;
}

export function WsProvider({ children, url, socketFactory }: WsProviderProps) {
  const storeRef = useRef<Store | null>(null);
  if (!storeRef.current) {
    storeRef.current = createStore();
  }
  const store = storeRef.current;
  const socketRef = useRef<WebSocketLike | null>(null);

  if (!store.actions) {
    store.actions = {
      send: (message: ClientMessage) => {
        const socket = socketRef.current;
        if (socket && socket.readyState === WEBSOCKET_OPEN) {
          socket.send(JSON.stringify(message));
          return;
        }
        // Ticket 009 / UC-020 ("no-disconnected-from-host-banner-in-the-
        // ui.md"): no silent drop -- if the message is scoped to a link,
        // say so in that link's own console log, styled exactly like a
        // host notice, so a send attempted while disconnected (e.g. a
        // control that raced the banner) is visibly explained rather
        // than silently swallowed.
        const linkId = messageLogLinkId(message);
        if (linkId !== undefined) {
          pushLogEntry(store, linkId, { direction: "tx", line: "Not sent -- no connection to the host.", origin: "host" });
          notify(store);
        }
      },
      sendBinary: (data: Uint8Array) => {
        const socket = socketRef.current;
        if (socket && socket.readyState === WEBSOCKET_OPEN) {
          socket.send(data);
        }
      },
      sendCommand: (linkId: string, verb: string, fields?: WireField[]) => {
        store.actions.send(
          fields !== undefined ? { type: "send-command", linkId, verb, fields } : { type: "send-command", linkId, verb },
        );
      },
      onFlashResult: (handler: (message: FlashResultMessage) => void) => {
        store.flashResultHandlers.add(handler);
        return () => {
          store.flashResultHandlers.delete(handler);
        };
      },
      onFlashLocalReady: (handler: (message: FlashLocalReadyMessage) => void) => {
        store.flashLocalReadyHandlers.add(handler);
        return () => {
          store.flashLocalReadyHandlers.delete(handler);
        };
      },
      clearLinkLog: (linkId: string) => {
        store.logsByLink.set(linkId, []);
        notify(store);
      },
      clearTelemetry: (linkId: string) => {
        clearTelemetrySlice(store, linkId);
      },
      telemetrySubscribe: (linkId: string, mode: TelemetryMode) => {
        store.actions.sendCommand(linkId, "TLM", [mode]);
      },
      resolveRadioMigration: (deviceId: number, apply: boolean) => {
        const candidate = store.pendingRadioMigrations.find((c) => c.deviceId === deviceId);
        if (!candidate) {
          return;
        }
        if (apply) {
          store.actions.send({ type: "set-radio-override", deviceId, channel: candidate.channel, group: candidate.group });
        }
        try {
          window.localStorage.removeItem(candidate.storageKey);
        } catch {
          // Best-effort only -- see scanPendingRadioMigrations's own
          // doc comment.
        }
        store.pendingRadioMigrations = store.pendingRadioMigrations.filter((c) => c.deviceId !== deviceId);
        notify(store);
      },
    };
  }

  useEffect(() => {
    let cancelled = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    const makeSocket = socketFactory ?? defaultSocketFactory;
    const resolvedUrl = url ?? defaultSocketUrl();

    function connect() {
      if (cancelled) {
        return;
      }
      store.status = "connecting";
      notify(store);
      const socket = makeSocket(resolvedUrl);
      socketRef.current = socket;

      socket.addEventListener("open", () => {
        if (cancelled) {
          return;
        }
        store.status = "open";
        notify(store);
      });

      socket.addEventListener("message", (event) => {
        if (cancelled) {
          return;
        }
        const raw = (event as { data?: unknown }).data;
        let parsed: unknown;
        try {
          parsed = JSON.parse(String(raw));
        } catch (error) {
          console.warn(
            `WsProvider: received a non-JSON WebSocket message -- dropping it (${
              error instanceof Error ? error.message : String(error)
            })`,
          );
          return;
        }
        if (!isServerMessage(parsed)) {
          return;
        }
        dispatch(store, parsed);
      });

      socket.addEventListener("error", () => {});

      socket.addEventListener("close", () => {
        if (cancelled) {
          return;
        }
        // Deliberately does not clear `devicesById`/`devicesArray`/
        // `unassignedArray`: a dropped connection should not blank out
        // the last-known list while reconnecting. `hasSnapshot` is
        // likewise never reset -- only `stale` flips, so a consumer
        // that cares can tell the list is no longer current.
        store.status = "closed";
        store.stale = true;
        notify(store);
        socketRef.current = null;
        reconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS);
      });
    }

    connect();

    return () => {
      cancelled = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
      }
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, [url, socketFactory, store]);

  return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>;
}

function useStore(): Store {
  const store = useContext(StoreContext);
  if (!store) {
    throw new Error("this hook must be called within a WsProvider");
  }
  return store;
}

/** Whether a `WsProvider` ancestor is mounted, without the hard throw
 * every other hook in this module uses via {@link useStore} -- ticket
 * 018-015's `FlashDialog` gate: `FrontPage.tsx`'s `DeviceCard` mounts
 * `FlashDialog` (which does call `useFlashProgress`/`useSendable`,
 * hence `useStore`, unconditionally) for any device with a current usb
 * link, and most `DeviceCard`-focused tests deliberately mount
 * `DevicesList` standalone with no `WsProvider` in the tree (this
 * file's own doc comment on `sendable`/`linkNotices`, "matching how
 * `onRelayConnect` etc. already reach them"). Gating the new
 * `FlashDialog` mount on this lets those tests go on doing that: no
 * usable Flash trigger without a real host connection would make sense
 * anyway, and the real app (`main.tsx`) always has a `WsProvider`
 * ancestor, so this is never false there. */
export function useHasWsStore(): boolean {
  return useContext(StoreContext) !== undefined;
}

export function useConnectionStatus(): ConnectionStatus {
  const store = useStore();
  return useSyncExternalStore(store.subscribe, () => store.status);
}

export function useHasSnapshot(): boolean {
  const store = useStore();
  return useSyncExternalStore(store.subscribe, () => store.hasSnapshot);
}

/** Combined connection status + snapshot staleness -- see this
 * module's doc comment ("Snapshot staleness"). The composed object is
 * cached in a ref and only replaced when `status`/`stale` actually
 * change, so it stays a stable `useSyncExternalStore` snapshot. */
export function useHostConnection(): HostConnectionState {
  const store = useStore();
  const cacheRef = useRef<HostConnectionState | null>(null);
  return useSyncExternalStore(store.subscribe, () => {
    const cached = cacheRef.current;
    if (cached && cached.status === store.status && cached.stale === store.stale) {
      return cached;
    }
    const next: HostConnectionState = { status: store.status, stale: store.stale };
    cacheRef.current = next;
    return next;
  });
}

/** Whether a send is currently meaningful: the socket is open and the
 * held snapshot is not stale (see {@link HostConnectionState.stale}'s
 * own doc comment). Ticket 009 / UC-020: a link's own `session` field
 * survives a reconnect in the last-known snapshot, so a component that
 * gates a send-capable control on `link.session !== undefined` alone
 * cannot tell "still connected" from "what we had before we lost the
 * host" -- every such control multiplies that by this hook too. */
export function useSendable(): boolean {
  const { status, stale } = useHostConnection();
  return status === "open" && !stale;
}

/** The full device list, host order, for the front page. */
export function useDevices(): SnapshotDevice[] {
  const store = useStore();
  return useSyncExternalStore(store.subscribe, () => store.devicesArray);
}

/** One device's slice of the latest snapshot, or `undefined` if no
 * device with this id exists. Subscribes only to that one device. */
export function useDevice(deviceId: number): SnapshotDevice | undefined {
  const store = useStore();
  return useSyncExternalStore(
    store.subscribe,
    useCallback(() => store.devicesById.get(deviceId), [store, deviceId]),
  );
}

/** The device that owns `linkId`, or `undefined` if no device in the
 * current snapshot has a link with this id (including every
 * `unassigned` link, which has no owning device by definition). */
export function useDeviceForLink(linkId: string | undefined): SnapshotDevice | undefined {
  const store = useStore();
  return useSyncExternalStore(
    store.subscribe,
    useCallback(() => {
      if (linkId === undefined) {
        return undefined;
      }
      const deviceId = store.linkOwnerById.get(linkId);
      return deviceId === undefined ? undefined : store.devicesById.get(deviceId);
    }, [store, linkId]),
  );
}

/** USB boards seen but not yet identified to a device -- host order. */
export function useUnassigned(): SnapshotLink[] {
  const store = useStore();
  return useSyncExternalStore(store.subscribe, () => store.unassignedArray);
}

/** One link's slice of the latest snapshot (owned or unassigned), or
 * `undefined` if no link with this id exists. Subscribes only to that
 * one link. */
export function useLink(linkId: string): SnapshotLink | undefined {
  const store = useStore();
  return useSyncExternalStore(
    store.subscribe,
    useCallback(() => store.linksById.get(linkId), [store, linkId]),
  );
}

/** Every relay's lease/bridging status from the most recent snapshot. */
export function useRelays(): SnapshotRelay[] {
  const store = useStore();
  return useSyncExternalStore(store.subscribe, () => store.relays);
}

/** Per-firmware availability from the most recent snapshot. */
export function useFirmware(): Record<FirmwareKind, FirmwareAvailability> {
  const store = useStore();
  return useSyncExternalStore(store.subscribe, () => store.firmware);
}

/** Compatibility alias for `useFirmware` -- trivially removable once
 * `FlashDialog.tsx`/`FlashControls.tsx` (tickets 008/009) migrate off
 * the retired `useFirmwareStatus` name; kept only so those files fail
 * on the (unrelated, pre-existing) `EndpointListEntry` type gap they
 * still have, not on a missing export. */
export const useFirmwareStatus = useFirmware;

/** The network the host would provision robots onto, as currently
 * stored (never the password) -- from the most recent snapshot. */
export function useWifiSetting(): Snapshot["wifi"] {
  const store = useStore();
  return useSyncExternalStore(store.subscribe, () => store.wifiSetting);
}

/** Running background tasks from the most recent snapshot. */
export function useTasks(): Snapshot["tasks"] {
  const store = useStore();
  return useSyncExternalStore(store.subscribe, () => store.tasks);
}

/** One link's console log. Renamed from `useEndpointLog`. */
export function useLinkLog(linkId: string): LogEntry[] {
  const store = useStore();
  return useSyncExternalStore(
    store.subscribe,
    useCallback(() => store.logsByLink.get(linkId) ?? (EMPTY_LOG as LogEntry[]), [store, linkId]),
  );
}

/** Bench defect 010 addendum (2026-09-13), fix item 3: every link-scoped
 * host notice currently pending, keyed by `linkId` -- e.g. a refused or
 * failed Connect's reason -- cleared once that link is next reported
 * `connected` (see `linkNotices`'s own doc comment). Read once here, at
 * `FrontPage.tsx` (the hook-bearing page), and threaded down as a plain
 * prop the same way `sendable`/`onLinkConnect` already are -- `DevicesList`/
 * `DeviceCard` deliberately take no `WsProvider`-dependent hooks of their
 * own (this module's own doc comment; existing tests mount `DevicesList`
 * standalone, with no provider in the tree), so this is a single
 * whole-map read, not a per-row hook a variable-length `.map()` could
 * never call without violating the rules of hooks. */
export function useLinkNotices(): ReadonlyMap<string, LinkNotice> {
  const store = useStore();
  return useSyncExternalStore(store.subscribe, () => store.linkNotices);
}

/** OOP 2026-09-10 (carried through ticket 007): the host's stored WiFi
 * network description, `undefined` until a `get-wifi-credentials` has
 * been answered. */
export function useWifiCredentials(): WifiCredentialsMessage | undefined {
  const store = useStore();
  return useSyncExternalStore(
    store.subscribe,
    useCallback(() => store.wifiCredentials, [store]),
  );
}

/** OOP 2026-09-10 (carried through ticket 007): the latest
 * `wifi-provision-result` for one link. */
export function useWifiProvisionResult(linkId: string): WifiProvisionResultMessage | undefined {
  const store = useStore();
  return useSyncExternalStore(
    store.subscribe,
    useCallback(() => store.wifiProvisionResultByLink.get(linkId), [store, linkId]),
  );
}

/** Live progress of an in-flight flash for one link -- prefers a live
 * `flash-progress` event, falling back to the snapshot's own
 * `SnapshotLink.flash` (self-healing a reconnect mid-flash, for any
 * source kind) once the overlay has nothing. See this module's doc
 * comment. */
export function useFlashProgress(linkId: string): FlashProgressState | undefined {
  const store = useStore();
  return useSyncExternalStore(
    store.subscribe,
    useCallback(() => store.flashProgressByLink.get(linkId) ?? store.linksById.get(linkId)?.flash, [store, linkId]),
  );
}

/** One link's current telemetry column header, or `undefined` before
 * any `thdr` has been recovered for it. Unchanged from ticket 006
 * except the field rename. */
export function useTelemetryHeader(linkId: string): readonly string[] | undefined {
  const store = useStore();
  return useSyncExternalStore(
    store.subscribe,
    useCallback(() => store.telemetryByLink.get(linkId)?.header, [store, linkId]),
  );
}

/** The imperative, non-React-reactive handle to one link's telemetry
 * ring. Unchanged from ticket 006 except the field rename. */
export function useTelemetry(linkId: string): TelemetryHandle {
  const store = useStore();
  const ref = useRef<{ linkId: string; handle: TelemetryHandle } | null>(null);
  if (ref.current === null || ref.current.linkId !== linkId) {
    const getSlice = () => getOrCreateTelemetrySlice(store, linkId);
    ref.current = {
      linkId,
      handle: {
        get header() {
          return getSlice().header;
        },
        get latest() {
          return getSlice().ring.latest();
        },
        snapshot: () => getSlice().ring.snapshot(),
        subscribe: (cb: (frame: TelemetryFrame) => void) => {
          const slice = getSlice();
          slice.frameListeners.add(cb);
          return () => {
            slice.frameListeners.delete(cb);
          };
        },
        clear: () => {
          clearTelemetrySlice(store, linkId);
        },
      },
    };
  }
  return ref.current.handle;
}

/** Migration nicety (carried from ticket 006): every leftover
 * `localStorage` radio override found for a device in the current
 * snapshot, offered exactly once per session -- see
 * `scanPendingRadioMigrations`'s own doc comment. `FrontPage` renders
 * one dismissible offer per entry; resolving one (`useWsActions()
 * .resolveRadioMigration`) removes it from this list. */
export function useRadioMigrationOffers(): PendingRadioMigration[] {
  const store = useStore();
  return useSyncExternalStore(store.subscribe, () => store.pendingRadioMigrations);
}

/** The imperative surface: send a client message, and subscribe to the
 * terminal outcome of a flash or the local-hex upload handshake's
 * go-ahead. Unchanged from ticket 006 except the field renames. */
export function useWsActions(): WsActions {
  const store = useStore();
  return store.actions;
}
