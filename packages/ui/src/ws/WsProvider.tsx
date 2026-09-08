/**
 * WsProvider.tsx — the one WebSocket connection the UI holds open to
 * `packages/host`'s `server.ts`, per `wsMessages.ts`'s contract.
 *
 * Ticket 010's plan calls for a single shared connection/context that
 * both the Devices tab and the Console tab consume, rather than each
 * tab opening its own socket. This module is that shared piece: it
 * owns the socket lifecycle (connect, reconnect after an unexpected
 * close, teardown on unmount) exactly as before -- ticket 006 changes
 * how the socket's data is *exposed* to consumers, not how the socket
 * itself behaves.
 *
 * **Why a ref-backed store instead of `useState` (ticket 006):**
 * Before this ticket, every field (`devices`, `firmwareStatus`, ...)
 * lived in its own `useState` and was assembled into one context value
 * object literal on every render -- so *every* consumer of `useWs()`
 * re-rendered on *every* WebSocket message, including a `line` message
 * for a device nobody was looking at. Sprint 8 pushes telemetry at
 * 20Hz; that whole-context-value shape cannot survive it, and sprint 4
 * ticket 007's router unmounts/remounts components on navigation, which
 * would also destroy `ConsoleTab`'s in-component log state on every
 * device switch.
 *
 * So state now lives in a plain mutable `Store` object held in a ref
 * (never in React state), mutated only by this provider's socket event
 * handlers, and exposed to consumers via `useSyncExternalStore` through
 * the granular selector hooks below (`useEndpoint`, `useEndpointLog`,
 * ...) rather than one `useWs()` grab-bag. Each selector's `getSnapshot`
 * returns a **cached, referentially stable** value that only changes
 * when the specific slice it reads actually changes -- see `deepEqual`
 * and the structural-sharing logic in `applySnapshot` below, which
 * reuses the previous `EndpointListEntry` object for any endpoint whose
 * fields are unchanged between two `endpoints` snapshots (the snapshot
 * is a fresh `JSON.parse` every time, so naive reuse of `parsed.endpoints`
 * would hand out a new object per endpoint on every message even when
 * nothing about that endpoint changed -- exactly the `getSnapshot`
 * pitfall that makes React re-render, or in the worst case loop). A
 * component that only reads `useEndpoint("A")` therefore does not
 * re-render when endpoint B changes, or when a `line` message arrives
 * for a different endpoint.
 *
 * **The hoisted log buffer:** `ConsoleTab.tsx` used to own
 * `logsByDevice` in its own `useState`, which ticket 007's router would
 * destroy on every navigation away from the console. That buffer now
 * lives in this store (`logsByEndpoint`), subscribed once here
 * (independent of which endpoint is currently selected, preserving
 * today's "switching devices never drops a line" behavior) and exposed
 * per-endpoint via `useEndpointLog`, so a mounted console for endpoint
 * A does not re-render when a snapshot update or a line for endpoint B
 * changes only B's slice.
 *
 * **Buffer bounding:** `MAX_LINES_PER_DEVICE` bounds one endpoint's log
 * length, but endpoints x 500 lines is itself unbounded once sprint 7
 * adds network endpoints that can appear and disappear over a long
 * session. This store additionally keeps only the
 * `MAX_TRACKED_ENDPOINT_LOGS` (8) most recently *active* endpoints'
 * logs at all -- the least-recently-touched endpoint's entire log is
 * evicted once a 9th distinct endpoint logs a line. "Recently active"
 * (touched when a line is appended) was chosen over "recently viewed"
 * (touched when a component reads it) because the latter would require
 * mutating store state from inside a selector's `getSnapshot`, which
 * `useSyncExternalStore` requires to be a pure read -- write-side
 * touching keeps every mutation on the socket message handlers, which
 * is where every other slice of this store is already mutated.
 *
 * **Flash progress for both source kinds (ticket 005's flagged gap):**
 * `EndpointListEntry.flashStatus` is frozen as `{ firmware, phase }` --
 * it has no shape for a local-hex source (see `wsMessages.ts`'s
 * `FirmwareSourceRef`), so a local-hex flash leaves `flashStatus`
 * undefined in every `endpoints` snapshot. The server still emits
 * `flash-progress` events (carrying the full `source`, release or
 * local-hex) for every flash, so this store now handles that message
 * type -- previously ignored entirely -- and keeps the latest
 * `{ source, phase }` per endpoint in `flashProgressByEndpoint`,
 * cleared on the terminal `flash-result`. `useFlashProgress(endpointId)`
 * exposes this for both source kinds. This does not fix the frozen
 * wire type (out of scope, per the ticket): a client that reconnects
 * mid-local-hex-flash still has no snapshot field to self-heal
 * `flashStatus` from, and so will not see progress until the next
 * `flash-progress` event arrives -- release-kind flashes are unaffected
 * since `flashStatus` already self-heals those via the snapshot.
 *
 * **Host errors surfaced in the console log (ticket 012-003):** a host
 * `type: "error"` message (e.g. `deviceRegistry.ts` refusing a live
 * `"HELLO"` command, or "no open link") used to be dropped here as an
 * explicit no-op -- nothing ever subscribed to it, so it vanished with
 * no trace. `appendHostError` now appends it to the firing endpoint's
 * existing console log (`logsByEndpoint`, the same store `line`
 * messages populate) as a `LogEntry` with `origin: "host"`, which
 * `DeviceConsole` renders with the same "error" kind styling as a
 * device-sent `err`/`nack` line rather than a new fourth `direction`
 * value -- see `LogEntry`'s own doc comment. This is this sprint's only
 * consumer of `type: "error"`; an error with no `endpointId` (no
 * current caller produces one) is deliberately dropped rather than
 * shown as a global banner, since this store owns no UI surface outside
 * the per-endpoint log -- see `appendHostError`'s own doc comment.
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
  EndpointListEntry,
  ErrorMessage,
  FirmwareAvailability,
  FirmwareKind,
  FirmwareSourceRef,
  FlashLocalReadyMessage,
  FlashPhase,
  FlashResultMessage,
  LineMessage,
  RememberedRobotEntry,
  ServerMessage,
} from "@robot-console/host/src/wsMessages.js";
import type { WireField } from "@robot-console/protocol";

export type ConnectionStatus = "connecting" | "open" | "closed";

/** One line in an endpoint's console log, in the order it was
 * appended. Hoisted here (from `ConsoleTab.tsx`) as part of ticket
 * 006's store; `ConsoleTab` re-exports this type for its own call
 * sites rather than importing it twice under two names. */
export interface LogEntry {
  id: number;
  direction: "tx" | "rx";
  line: string;
  /** Present (`"host"`) only for an entry synthesized from a host
   * `type: "error"` message (ticket 012-003) -- absent for an ordinary
   * `line` message, device- or user-originated alike. `direction` is
   * still `"rx"` for a host error (it arrives at the client, same as a
   * device reply, and no fourth `direction` value is warranted just for
   * this), so `origin` is what `DeviceConsole` checks to force the
   * "error" kind styling regardless of the message text -- a host
   * error's wording (e.g. "no open link") does not necessarily start
   * with "err"/"nack", so relying on `classifyLine`'s text sniffing
   * alone would misclassify most of them as ordinary `data`. */
  origin?: "host";
}

/** Maximum lines retained per endpoint in the in-memory log. Oldest
 * lines are dropped once an endpoint's log exceeds this so a busy
 * board (telemetry lands in a later sprint at up to 20Hz) can't grow
 * the log without bound. Exported so tests can exercise the exact
 * boundary rather than duplicating the number -- unchanged from
 * `ConsoleTab.tsx`'s pre-ticket-006 constant of the same name and
 * value. */
export const MAX_LINES_PER_DEVICE = 500;

/** How many distinct endpoints' logs this store keeps at once -- see
 * this module's doc comment ("Buffer bounding") for why eviction is
 * driven by log-write recency rather than view recency. Exported so
 * tests can pin down the exact eviction boundary rather than
 * duplicating the number. */
export const MAX_TRACKED_ENDPOINT_LOGS = 8;

/** Shared empty array returned by `useEndpointLog` for an endpoint
 * with no log yet, so repeated calls before any line arrives return
 * the same reference rather than a fresh `[]` each time (which would
 * otherwise look like a change to `useSyncExternalStore`). */
const EMPTY_LOG: readonly LogEntry[] = [];

let nextLogEntryId = 0;

/** The latest known progress of an in-flight flash for one endpoint,
 * populated from live `flash-progress` events -- see this module's doc
 * comment ("Flash progress for both source kinds"). */
export interface FlashProgressState {
  source: FirmwareSourceRef;
  phase: FlashPhase;
}

/** Firmware availability before the first `devices` snapshot has ever
 * arrived (e.g. the instant after this provider mounts). Treated the
 * same as "not configured" -- disabled, no reason text -- rather than
 * inventing a fourth, provider-only state; the real snapshot (sent by
 * `server.ts` on every connection, per `wsMessages.ts`) replaces this
 * within one round trip. */
const DEFAULT_FIRMWARE_STATUS: Record<FirmwareKind, FirmwareAvailability> = {
  relay: { configured: false },
  robot: { configured: false },
};

/**
 * The slice of the browser `WebSocket` API this module actually uses.
 * Kept narrow and exported so tests can inject a fully synthetic fake
 * (no real network, no dependence on jsdom implementing `WebSocket`)
 * -- mirrors `deviceRegistry.ts`'s `UsbSerialLinkLike` seam on the host
 * side of this same contract.
 */
export interface WebSocketLike {
  readonly readyState: number;
  /** `string` for every JSON control message this module sends; a raw
   * binary payload only for the local-hex upload's one binary frame
   * (ticket 008's `sendBinary` action) -- never a `Blob`, since this
   * client always has the bytes in hand already (`File.arrayBuffer()`)
   * and has no reason to hand the browser a lazy-read wrapper around
   * them. */
  send(data: string | ArrayBufferLike | ArrayBufferView): void;
  close(): void;
  addEventListener(type: string, listener: (event: unknown) => void): void;
  removeEventListener(type: string, listener: (event: unknown) => void): void;
}

const WEBSOCKET_OPEN = 1;

/** Structural (deep) equality over plain JSON-shaped values -- every
 * field on `EndpointListEntry`/`FirmwareAvailability` is a primitive,
 * plain object, or array of those, so a generic recursive comparison
 * is enough; no `Map`/`Set`/`Date`/class instances ever appear here.
 * Used to decide whether a freshly-parsed value (every `endpoints`
 * message is a brand-new `JSON.parse`) actually differs from what the
 * store already has, so unchanged slices can keep their old object
 * reference -- see this module's doc comment on `getSnapshot`
 * stability. */
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
 * hooks via `useSyncExternalStore`. Never itself placed in React
 * state -- see this module's doc comment. */
interface Store {
  status: ConnectionStatus;
  /** `false` until the first `endpoints` message is processed, `true`
   * forever after -- including across a reconnect, since the last
   * known snapshot is still meaningful (mirrors `devices` itself never
   * being cleared on close). */
  hasSnapshot: boolean;
  endpointIds: string[];
  endpointsById: Map<string, EndpointListEntry>;
  /** Cached array form of `endpointsById` in `endpointIds` order, for
   * `useEndpoints()`. Only rebuilt when some endpoint actually changed,
   * was added, removed, or reordered -- see `applySnapshot`. */
  endpointsArray: EndpointListEntry[];
  firmwareStatus: Record<FirmwareKind, FirmwareAvailability>;
  /** The full remembered-robot roster from the most recent `endpoints`
   * snapshot (sprint 5) -- see `wsMessages.ts`'s
   * `EndpointsMessage.rememberedRobots` doc comment. Starts at `[]`
   * before any snapshot arrives, and is only ever replaced (not
   * mutated in place) by `applySnapshot`, which also guards against an
   * old-shaped/test-fixture message that omits the field entirely --
   * see that function's own doc comment. */
  rememberedRobots: RememberedRobotEntry[];
  logsByEndpoint: Map<string, LogEntry[]>;
  /** LRU order for `logsByEndpoint`, oldest-touched first. See
   * `touchLog`. */
  logOrder: string[];
  flashProgressByEndpoint: Map<string, FlashProgressState>;
  flashResultHandlers: Set<(message: FlashResultMessage) => void>;
  /** Subscribers to the local-hex upload handshake's `flash-local-ready`
   * reply (ticket 008) -- see `WsActions.onFlashLocalReady`'s own doc
   * comment. Not store-backed state (no `endpoints`/log-buffer slice
   * changes because of this message), so firing these handlers never
   * needs a matching `notify(store)` call the way `flash-result`'s
   * handling does. */
  flashLocalReadyHandlers: Set<(message: FlashLocalReadyMessage) => void>;
  listeners: Set<() => void>;
  /** `useSyncExternalStore`'s subscribe half -- registers `cb` to be
   * called after any store mutation, returns the unsubscribe function.
   * A stable method (defined once, in `createStore`) so every selector
   * hook below can pass it straight to `useSyncExternalStore` with no
   * `useCallback` wrapper of its own. Every hook shares this one
   * "something changed" signal; the fine-grained re-render bail-out
   * comes from each hook's own `getSnapshot` returning a referentially
   * stable value when its particular slice didn't change (see
   * `applySnapshot`/`appendLine`'s structural-sharing logic), not from
   * subscribing more narrowly here. */
  subscribe: (cb: () => void) => () => void;
  /** Built once, in `WsProvider`, right after the store itself --
   * split out of `createStore` only because `send` needs to close over
   * the component's `socketRef`, which the store itself does not
   * hold. */
  actions: WsActions;
}

export interface WsActions {
  send: (message: ClientMessage) => void;
  /** Send one raw binary WebSocket frame -- the local-hex upload
   * handshake's binary half (ticket 005's convention, frozen in
   * `wsMessages.ts`'s module doc comment): `uploadId` (ASCII,
   * `UPLOAD_ID_BYTE_LENGTH` bytes) immediately followed by the file's
   * raw bytes, no JSON envelope, no length prefix. Building that exact
   * layout is the caller's job (`UnknownDevicePage`, ticket 008); this
   * action only forwards the finished frame to the socket, mirroring
   * `send`'s own readyState guard -- a frame sent while disconnected is
   * silently dropped rather than queued, same as every other outbound
   * message this module sends. */
  sendBinary: (data: Uint8Array) => void;
  /** Send one protocol verb, with optional fields, to an endpoint's open
   * session -- forwards `{ type: "send-command", endpointId, verb,
   * fields }` through `send`'s existing readyState guard (silently
   * dropped if the socket isn't open, same as every other action here;
   * no queuing). Deliberately does not classify `verb` as sequenced or
   * unsequenced: that decision belongs to `@robot-console/protocol`'s
   * `isSequencedVerb`, applied host-side by `deviceRegistry.ts` (ticket
   * 003) -- duplicating it here would be exactly the client/host drift
   * the architecture forbids. `fields` omitted is equivalent to an
   * empty array (`SendCommandMessage`'s own doc comment), so callers
   * with a bare verb like `STATUS` or `GET` can omit it entirely. */
  sendCommand: (endpointId: string, verb: string, fields?: WireField[]) => void;
  onFlashResult: (handler: (message: FlashResultMessage) => void) => () => void;
  /** Subscribe to the local-hex upload handshake's `flash-local-ready`
   * reply -- the server's go-ahead to send the binary frame, carrying
   * the `uploadId` the client must prefix that frame with and later
   * reference in `flash-start`'s `source`. Mirrors `onFlashResult`'s
   * pub/sub shape; `UnknownDevicePage` (ticket 008) is this sprint's
   * only subscriber. */
  onFlashLocalReady: (handler: (message: FlashLocalReadyMessage) => void) => () => void;
  /** Empty one endpoint's log buffer -- `ConsoleTab`'s "Clear log"
   * button used to do this directly via its own `setLogsByDevice`
   * before the buffer was hoisted into this store; now that the store
   * owns it, clearing has to go through an action instead of local
   * state. Does not evict the endpoint from the LRU tracked set (see
   * `touchLog`) -- an explicit clear is not the same signal as
   * inactivity. */
  clearEndpointLog: (endpointId: string) => void;
}

function notify(store: Store): void {
  for (const listener of store.listeners) {
    listener();
  }
}

function touchLog(store: Store, endpointId: string): void {
  const idx = store.logOrder.indexOf(endpointId);
  if (idx !== -1) {
    store.logOrder.splice(idx, 1);
  }
  store.logOrder.push(endpointId);
  while (store.logOrder.length > MAX_TRACKED_ENDPOINT_LOGS) {
    const evicted = store.logOrder.shift();
    if (evicted !== undefined) {
      store.logsByEndpoint.delete(evicted);
    }
  }
}

/** Shared tail of `appendLine`/`appendHostError`: append one entry to
 * `endpointId`'s log, enforce `MAX_LINES_PER_DEVICE`, and mark the
 * endpoint as recently active for the LRU tracked set. `entry` omits
 * `id`, minted here so every appender gets a unique, ordered one
 * without duplicating that bookkeeping. */
function pushLogEntry(store: Store, endpointId: string, entry: Omit<LogEntry, "id">): void {
  const existing = store.logsByEndpoint.get(endpointId) ?? [];
  const next = existing.concat({ id: nextLogEntryId++, ...entry });
  if (next.length > MAX_LINES_PER_DEVICE) {
    next.splice(0, next.length - MAX_LINES_PER_DEVICE);
  }
  store.logsByEndpoint.set(endpointId, next);
  touchLog(store, endpointId);
}

function appendLine(store: Store, message: LineMessage): void {
  pushLogEntry(store, message.endpointId, { direction: message.direction, line: message.line });
}

/** Append a synthesized log entry for a host `type: "error"` message
 * to its firing endpoint's log -- see this module's doc comment ("Host
 * errors surfaced in the console log"). `deviceRegistry.ts`'s two
 * `emitError` call sites (`sendLine`/`sendCommand`'s "no open link"
 * cases, and `sendCommand`'s live-`"HELLO"` refusal) always carry an
 * `endpointId`; a hypothetical error with none is dropped rather than
 * shown as a global banner -- this store has no UI surface outside the
 * per-endpoint log, and inventing one for a case nothing currently
 * triggers would be speculative generality ahead of an actual caller.
 * Returns whether an entry was actually appended, so the caller can
 * skip an unnecessary `notify(store)` when nothing changed. */
function appendHostError(store: Store, message: ErrorMessage): boolean {
  if (!message.endpointId) {
    return false;
  }
  pushLogEntry(store, message.endpointId, { direction: "rx", line: message.message, origin: "host" });
  return true;
}

function applySnapshot(
  store: Store,
  endpoints: EndpointListEntry[],
  // `server.ts` always populates this field on a real `endpoints`
  // message (`EndpointsMessage.firmwareStatus` is required); typed as
  // possibly `undefined` here only because nothing on this client-side
  // parse path (`isServerMessage`, per this module's own doc comment)
  // actually validates an incoming message's shape against the wire
  // contract the way `parseClientMessage` does for the other
  // direction. Guarded below so a message missing it (also a common
  // shorthand in tests that don't care about firmware gating) can
  // never clobber a previously-good `store.firmwareStatus` with
  // `undefined`.
  firmwareStatus: Record<FirmwareKind, FirmwareAvailability> | undefined,
  // Same shorthand as `firmwareStatus` above: `EndpointsMessage.rememberedRobots`
  // is required on a real message, but typed as possibly `undefined`
  // here so an old-shaped message (or a test fixture built before this
  // field existed) never clobbers a previously-good
  // `store.rememberedRobots` with `undefined` -- it just keeps whatever
  // the store already had.
  rememberedRobots: RememberedRobotEntry[] | undefined,
): void {
  const nextIds: string[] = [];
  const nextMap = new Map<string, EndpointListEntry>();
  for (const entry of endpoints) {
    const previous = store.endpointsById.get(entry.endpointId);
    nextMap.set(entry.endpointId, previous && deepEqual(previous, entry) ? previous : entry);
    nextIds.push(entry.endpointId);
  }

  const idsChanged =
    nextIds.length !== store.endpointIds.length ||
    nextIds.some((id, i) => id !== store.endpointIds[i]);
  const anyEntryChanged =
    idsChanged || nextIds.some((id) => nextMap.get(id) !== store.endpointsById.get(id));

  store.endpointIds = nextIds;
  store.endpointsById = nextMap;
  if (anyEntryChanged) {
    store.endpointsArray = nextIds.map((id) => nextMap.get(id)!);
  }

  if (firmwareStatus && !deepEqual(store.firmwareStatus, firmwareStatus)) {
    store.firmwareStatus = firmwareStatus;
  }

  if (rememberedRobots !== undefined && !deepEqual(store.rememberedRobots, rememberedRobots)) {
    store.rememberedRobots = rememberedRobots;
  }

  // A flash's terminal `flash-result` clears `flashStatus` from the
  // snapshot; mirror that into our own progress map for any endpoint
  // this client has been tracking, so a stale bar never lingers past
  // the snapshot that says the flash is over.
  for (const entry of endpoints) {
    if (!entry.flashStatus) {
      store.flashProgressByEndpoint.delete(entry.endpointId);
    }
  }

  store.hasSnapshot = true;
}

function createStore(): Store {
  const listeners = new Set<() => void>();
  const store: Store = {
    status: "connecting",
    hasSnapshot: false,
    endpointIds: [],
    endpointsById: new Map(),
    endpointsArray: [],
    firmwareStatus: DEFAULT_FIRMWARE_STATUS,
    rememberedRobots: [],
    logsByEndpoint: new Map(),
    logOrder: [],
    flashProgressByEndpoint: new Map(),
    flashResultHandlers: new Set(),
    flashLocalReadyHandlers: new Set(),
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

/** Fixed delay before retrying after an unexpected close. The host
 * process is local and either up or not -- there is no meaningful
 * backoff ladder to tune here, just "keep trying". */
const RECONNECT_DELAY_MS = 1500;

function defaultSocketUrl(): string {
  // Development only: `npm run dev` (scripts/dev.mjs) serves this page
  // from Vite on its own port while the host runs on another, so the
  // page cannot find the host by looking at its own origin. That script
  // `define`s this to the host's real address. A production `vite build`
  // never sets it, so the fallback below -- connect back to whoever
  // served the page, which under `npx robot-console` is the host itself
  // -- remains the only path that ships.
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
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { type?: unknown }).type === "string"
  );
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

  // Stable across the store's lifetime -- `send` closes over `socketRef`
  // (a plain React ref, not state) and `onFlashResult` over
  // `store.flashResultHandlers`, so this object never needs to change
  // and effects that depend on it never need to re-run.
  if (!store.actions) {
    store.actions = {
      send: (message: ClientMessage) => {
        const socket = socketRef.current;
        if (socket && socket.readyState === WEBSOCKET_OPEN) {
          socket.send(JSON.stringify(message));
        }
      },
      sendBinary: (data: Uint8Array) => {
        const socket = socketRef.current;
        if (socket && socket.readyState === WEBSOCKET_OPEN) {
          socket.send(data);
        }
      },
      sendCommand: (endpointId: string, verb: string, fields?: WireField[]) => {
        // `exactOptionalPropertyTypes` forbids `fields: undefined` --
        // the key must be absent entirely, not present-with-undefined,
        // to satisfy `SendCommandMessage.fields?: WireField[]`.
        store.actions.send(
          fields !== undefined
            ? { type: "send-command", endpointId, verb, fields }
            : { type: "send-command", endpointId, verb },
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
      clearEndpointLog: (endpointId: string) => {
        store.logsByEndpoint.set(endpointId, []);
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
        } catch {
          return;
        }
        if (!isServerMessage(parsed)) {
          return;
        }
        switch (parsed.type) {
          case "endpoints":
            applySnapshot(store, parsed.endpoints, parsed.firmwareStatus, parsed.rememberedRobots);
            notify(store);
            break;
          case "line":
            appendLine(store, parsed);
            notify(store);
            break;
          case "error":
            // Ticket 012-003: a host error now lands in the firing
            // endpoint's console log via `appendHostError`, rendered by
            // `DeviceConsole` with the same "error" kind styling as a
            // device-sent `err`/`nack` line (`LogEntry.origin: "host"`
            // forces that classification -- see `appendHostError`'s own
            // doc comment for the no-`endpointId` case).
            if (appendHostError(store, parsed)) {
              notify(store);
            }
            break;
          case "flash-progress":
            store.flashProgressByEndpoint.set(parsed.endpointId, {
              source: parsed.source,
              phase: parsed.phase,
            });
            notify(store);
            break;
          case "flash-result":
            store.flashProgressByEndpoint.delete(parsed.endpointId);
            for (const handler of store.flashResultHandlers) {
              handler(parsed);
            }
            notify(store);
            break;
          case "flash-local-ready":
            // Local-hex upload handshake (ticket 005's JSON half, wired
            // to the UI by ticket 008): fan out to whoever is waiting to
            // send the binary frame this unlocks (`UnknownDevicePage`).
            // Not store-backed state -- no `notify(store)` needed, per
            // `flashLocalReadyHandlers`'s own doc comment.
            for (const handler of store.flashLocalReadyHandlers) {
              handler(parsed);
            }
            break;
        }
      });

      // The subsequent "close" event (browsers always fire close after
      // error on a socket that never opened, or after a mid-session
      // drop) is what drives reconnection below -- nothing extra to do
      // on "error" itself.
      socket.addEventListener("error", () => {});

      socket.addEventListener("close", () => {
        if (cancelled) {
          return;
        }
        // Deliberately does not clear `endpointsById`/`endpointsArray`:
        // a dropped connection should not blank out the last-known list
        // while reconnecting. `hasSnapshot` is likewise never reset --
        // see this module's doc comment.
        store.status = "closed";
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

export function useConnectionStatus(): ConnectionStatus {
  const store = useStore();
  return useSyncExternalStore(store.subscribe, () => store.status);
}

export function useHasSnapshot(): boolean {
  const store = useStore();
  return useSyncExternalStore(store.subscribe, () => store.hasSnapshot);
}

/** The full endpoint list, for the front page -- still one
 * subscription, since the front page legitimately needs the whole
 * list. Not the render-storm case telemetry will be; per-endpoint
 * pages (ticket 008) should use `useEndpoint` instead. */
export function useEndpoints(): EndpointListEntry[] {
  const store = useStore();
  return useSyncExternalStore(store.subscribe, () => store.endpointsArray);
}

/** One endpoint's slice of the latest snapshot, or `undefined` if no
 * endpoint with this id exists. Subscribes only to that one endpoint --
 * a component reading `useEndpoint("A")` does not re-render when
 * endpoint B changes or when a `line`/`flash-progress` message arrives
 * for a different endpoint. */
export function useEndpoint(endpointId: string): EndpointListEntry | undefined {
  const store = useStore();
  return useSyncExternalStore(
    store.subscribe,
    useCallback(() => store.endpointsById.get(endpointId), [store, endpointId]),
  );
}

/** One endpoint's console log, hoisted out of `ConsoleTab`'s own
 * state. Subscribes only to that endpoint's log -- a mounted console
 * for endpoint A does not re-render on an `endpoints` snapshot update
 * that leaves A's log untouched, or on a line for a different
 * endpoint. Returns a shared stable empty array before any line has
 * arrived for this endpoint. */
export function useEndpointLog(endpointId: string): LogEntry[] {
  const store = useStore();
  return useSyncExternalStore(
    store.subscribe,
    useCallback(() => store.logsByEndpoint.get(endpointId) ?? (EMPTY_LOG as LogEntry[]), [store, endpointId]),
  );
}

/** Per-firmware availability from the most recent `endpoints` snapshot
 * (sprint 2) -- see `wsMessages.ts`'s `EndpointsMessage.firmwareStatus`
 * doc comment. Drives the robot/relay flash buttons' disabled state in
 * `DevicesTab`; never a hardcoded UI flag. */
export function useFirmwareStatus(): Record<FirmwareKind, FirmwareAvailability> {
  const store = useStore();
  return useSyncExternalStore(store.subscribe, () => store.firmwareStatus);
}

/** The full remembered-robot roster from the most recent `endpoints`
 * snapshot (sprint 5) -- robots this host has seen over USB before but
 * are not currently attached (the host already excludes currently-
 * attached names from this list, so a consumer never needs to filter
 * against `useEndpoints()` itself). `[]` before the first snapshot
 * arrives. No new action is needed to forget one -- send
 * `{ type: "forget-known-robot", name }` via `useWsActions().send`. */
export function useRememberedRobots(): RememberedRobotEntry[] {
  const store = useStore();
  return useSyncExternalStore(store.subscribe, () => store.rememberedRobots);
}

/** Live progress of an in-flight flash for one endpoint, populated
 * from `flash-progress` events -- works for both a release source and
 * a local-hex source (unlike `EndpointListEntry.flashStatus`, which is
 * frozen to `{ firmware, phase }` and cannot represent local-hex). See
 * this module's doc comment ("Flash progress for both source kinds")
 * for the reconnect-gap this does not close. */
export function useFlashProgress(endpointId: string): FlashProgressState | undefined {
  const store = useStore();
  return useSyncExternalStore(
    store.subscribe,
    useCallback(() => store.flashProgressByEndpoint.get(endpointId), [store, endpointId]),
  );
}

/** One endpoint's sequencing state from the most recent `endpoints`
 * snapshot (ticket 002's `EndpointListEntry.sequencing`, populated
 * host-side by ticket 003) -- `undefined` before any snapshot has
 * arrived, or whenever the endpoint has no session open (the field is
 * only present while `sessionOpen`, per `wsMessages.ts`). No new
 * store-mutation logic is needed: `sequencing` travels inside the
 * existing `endpoints` snapshot, already covered by `applySnapshot`'s
 * per-entry `deepEqual`/structural-sharing, so an unchanged `sequencing`
 * value keeps its object identity across snapshots exactly like every
 * other `EndpointListEntry` field. Subscribes only to that one
 * endpoint's slice of the store, mirroring `useFlashProgress` -- a
 * component reading `useSequencing("A")` does not re-render when
 * endpoint B's `sequencing` changes, or when an unrelated `line`/
 * `flash-progress` message arrives. This matters more than usual here:
 * `sequencing` updates on every ack/nack, so a naive whole-snapshot
 * subscription would re-render every consumer on every protocol
 * reply. */
export function useSequencing(endpointId: string): EndpointListEntry["sequencing"] {
  const store = useStore();
  return useSyncExternalStore(
    store.subscribe,
    useCallback(() => store.endpointsById.get(endpointId)?.sequencing, [store, endpointId]),
  );
}

/** The imperative surface: send a client message (`send`/`sendBinary`/
 * `sendCommand`), and subscribe to the terminal outcome of a flash
 * (`onFlashResult`) or
 * the local-hex upload handshake's go-ahead (`onFlashLocalReady`,
 * ticket 008). Per-phase progress does *not* need a matching
 * subscription here: `useFlashProgress` (ticket 006) and
 * `EndpointListEntry.flashStatus` already carry live progress; only the
 * terminal `flash-result`'s `message` (present on `status: "error"`)
 * and `flash-local-ready`'s `uploadId` are not represented anywhere in
 * the snapshot, so those two events keep their own subscriptions.
 * `onLine`/`onError` from the pre-ticket-006 context are gone: log
 * population is now internal store logic (`useEndpointLog`), and
 * nothing outside this module ever consumed `onError`. Returns a
 * stable object for this store's whole lifetime, so
 * `useEffect(() => onFlashResult(...), [onFlashResult])` never re-runs
 * on an unrelated render. */
export function useWsActions(): WsActions {
  const store = useStore();
  return store.actions;
}
