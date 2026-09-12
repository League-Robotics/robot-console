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
 *
 * **Poll-origin lines carried through (added out-of-process,
 * 2026-09-09):** `appendLine` now copies `LineMessage.origin` (`"poll"`
 * for a line the host sent/received on its own initiative -- its
 * periodic `STATUS` poll against an open robot session, per
 * `wsMessages.ts`) onto the `LogEntry` it appends, verbatim and only
 * when present. This store does no filtering of its own on `origin` --
 * every line the host forwards is still appended to the log and counted
 * against `MAX_LINES_PER_DEVICE` exactly as before; `DeviceConsole`
 * decides, at render time, whether a `"poll"`-origin entry is currently
 * shown.
 *
 * **Telemetry: a ref-backed ring buffer that never triggers a React
 * re-render on its own (sprint 9 ticket 003):** `TelemetryMessage`
 * (ticket 002) can arrive at up to tens of times a second per endpoint
 * -- an order of magnitude past what `logsByEndpoint`/`notify` were
 * ever designed for. Routing each frame through `notify(store)` would
 * re-render every `useSyncExternalStore` consumer of this store on
 * every frame, exactly the whole-context-value problem this module's
 * ref-backed redesign exists to avoid. So a frame is stored into a
 * per-endpoint `TelemetryRing` and fanned out to that endpoint's own
 * `frameListeners` directly -- a second, narrower pub/sub that never
 * touches `store.listeners`/`notify` at all. `useTelemetry` hands
 * consumers (chart/trace panels, tickets 004/005) a stable object with
 * live getters and a `subscribe`, so they can read the ring on their
 * own schedule (an animation frame) instead of on every incoming
 * frame. Only the header -- which changes far less often -- goes
 * through the normal `notify`/`useSyncExternalStore` path via
 * `useTelemetryHeader`, so a "waiting for header" banner can still be
 * ordinary reactive React state.
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
  DiscoveredServicesSnapshot,
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
  TelemetryMessage,
  WifiCredentialsMessage,
  WifiProvisionResultMessage,
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
  /** `"host"` for an entry synthesized from a host `type: "error"`
   * message (ticket 012-003); `"poll"` for an ordinary `line` message
   * the host itself marked `origin: "poll"` (added out-of-process,
   * 2026-09-09) -- the host's own periodic `STATUS` poll against an open
   * robot session, carried through verbatim from `LineMessage.origin`
   * (see `wsMessages.ts`'s own doc comment) rather than re-derived here.
   * Absent for an ordinary user-originated `line` message. `direction`
   * is still `"rx"` for both a host error and a poll reply (each arrives
   * at the client the same way a device reply does, and no extra
   * `direction` value is warranted just for this), so `origin` is what a
   * consumer checks instead: `DeviceConsole` forces the "error" kind
   * styling for `"host"` regardless of the message text (a host error's
   * wording, e.g. "no open link", does not necessarily start with
   * "err"/"nack", so `classifyLine`'s text sniffing alone would
   * misclassify most of them as ordinary `data`), and hides a `"poll"`
   * entry from the log by default (still retained in the store -- see
   * `DeviceConsole.tsx`'s own doc comment; filtering is presentation
   * only). */
  origin?: "host" | "poll";
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

/** Maximum frames retained per endpoint in the telemetry ring buffer
 * (sprint 9 ticket 003) -- deliberately independent of
 * {@link MAX_LINES_PER_DEVICE}, which bounds a completely different
 * kind of data at a completely different rate (a handful of console
 * lines a second, versus telemetry's up to tens of frames a second per
 * `sprint.md`'s Architecture). 600 frames is about 60 seconds of
 * history at a typical 10Hz telemetry rate -- enough for the chart/
 * trace panels (tickets 004/005) to show a meaningful recent window
 * without growing without bound over a long session. Exported so tests
 * can pin down the exact eviction boundary, mirroring
 * `MAX_LINES_PER_DEVICE`'s own reasoning. */
export const TELEMETRY_RING_CAPACITY = 600;

/** One decoded telemetry frame, ready for chart/trace consumption. `t`
 * is this client's own receipt time (`Date.now()`), not anything the
 * wire sends -- `TelemetryMessage.frame` carries no timestamp of its
 * own -- so panels can plot against a consistent wall-clock axis even
 * across a header change. `values` is `TelemetryMessage.frame`'s raw
 * wire strings parsed with `Number()`; a missing or non-numeric field
 * parses to `NaN` rather than being dropped, so a frame's keys always
 * match `header` 1:1 even when one column is briefly unparsable --
 * consumers of a numeric series already have to handle `NaN` (e.g. skip
 * drawing that point) rather than a hole in the object shape. */
export interface TelemetryFrame {
  t: number;
  values: Record<string, number>;
}

/** Which telemetry stream, if any, an endpoint's robot should push --
 * sent to the robot via `useWsActions().telemetrySubscribe`, which
 * forwards it as `TLM <mode>` (see that action's own doc comment).
 * `"HDR"` re-requests just the current column header without changing
 * which frames stream, mirroring `deviceRegistry.ts`'s own one-shot
 * `TLM HDR` gap-recovery request (`sprint.md`'s Architecture, Design
 * Rationale #3). */
export type TelemetryMode = "POSE" | "FULL" | "OFF" | "HDR";

/** The imperative, non-React-reactive interface to one endpoint's
 * telemetry ring, returned by `useTelemetry`. `header` and `latest` are
 * live getters -- each read goes straight to the store, not to cached
 * React state -- and `subscribe` fires its callback synchronously on
 * every incoming frame, entirely outside React's render cycle. This
 * lets a chart/trace consumer (tickets 004/005) pull `snapshot()` (or
 * accumulate frames via `subscribe`) on its own schedule, typically
 * once per animation frame, instead of re-rendering on every frame the
 * way a `useSyncExternalStore` selector would -- see this module's doc
 * comment ("Telemetry: a ref-backed ring buffer...") for why. */
export interface TelemetryHandle {
  readonly header: readonly string[] | undefined;
  readonly latest: TelemetryFrame | undefined;
  /** All frames currently retained, oldest first -- a fresh array each
   * call, safe to hold onto without it mutating underneath the
   * caller. */
  snapshot(): TelemetryFrame[];
  /** Register `cb` to be called, synchronously and outside React, with
   * each frame as it arrives for this endpoint. Returns the
   * unsubscribe function. */
  subscribe(cb: (frame: TelemetryFrame) => void): () => void;
  /** Empty this endpoint's ring (ticket 005's Clear button). Does not
   * touch the current header -- the column layout hasn't changed, only
   * the retained history has. Equivalent to
   * `useWsActions().clearTelemetry(endpointId)`. */
  clear(): void;
}

/** Fixed-capacity ring buffer backing one endpoint's telemetry slice --
 * the "ref-backed ring buffer" this ticket introduces. Writes
 * circularly into a single `capacity`-length array (no `splice`/`shift`
 * per push) so pushing at capacity is O(1) regardless of how full the
 * ring is, unlike `pushLogEntry`'s trim-from-the-front approach above
 * (fine at the console log's much lower rate, but an O(n) copy on every
 * incoming frame here would not be, at telemetry's 10-20Hz). Not
 * exported -- `TelemetryHandle`'s `snapshot`/`latest`/`subscribe`/
 * `clear` are the only surface consumers need. */
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

/** One endpoint's telemetry state: the current column header (or
 * `undefined` before any `thdr` has been recovered / after a session
 * close), its ring of decoded frames, and the frame-arrival
 * subscribers that bypass `notify`/`store.listeners` entirely -- see
 * this module's doc comment. Not part of `Store`'s React-visible
 * fields the way `endpointsById`/`logsByEndpoint` are read via
 * `useSyncExternalStore`; only `header` is ever exposed that way, via
 * `useTelemetryHeader`. */
interface TelemetrySlice {
  header: readonly string[] | undefined;
  ring: TelemetryRing;
  frameListeners: Set<(frame: TelemetryFrame) => void>;
}

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

/** {@link DiscoveredServicesSnapshot} before the first `endpoints`
 * snapshot has ever arrived (or for an old-shaped/test-fixture message
 * that omits the field entirely) -- both lists empty, mirroring
 * {@link DEFAULT_FIRMWARE_STATUS}'s own "not yet known" default. Sprint
 * 8 ticket 005's `useDiscoveredServices` selector. */
const DEFAULT_DISCOVERED_SERVICES: DiscoveredServicesSnapshot = { relays: [], robots: [] };

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
  /** Sprint 8 ticket 004/005: the current mDNS discovery snapshot
   * (relays + robots) from the most recent `endpoints` snapshot --
   * mirrors {@link rememberedRobots}'s own always-present-even-when-
   * empty discipline. `{ relays: [], robots: [] }` before the first
   * snapshot arrives. Feeds `RelayPage`'s dropdown (ticket 005) and the
   * disclosure chip's `registryWasConsidered` (ticket 006) -- never
   * populated by a registry lookup of its own; this is a passive
   * mirror of `server.ts`'s `discoveredServices` field. */
  discoveredServices: DiscoveredServicesSnapshot;
  logsByEndpoint: Map<string, LogEntry[]>;
  /** LRU order for `logsByEndpoint`, oldest-touched first. See
   * `touchLog`. */
  logOrder: string[];
  flashProgressByEndpoint: Map<string, FlashProgressState>;
  flashResultHandlers: Set<(message: FlashResultMessage) => void>;
  /** OOP 2026-09-10: the host's stored WiFi network (never the
   * password) -- `undefined` until asked for. */
  wifiCredentials: WifiCredentialsMessage | undefined;
  /** OOP 2026-09-10: the most recent provisioning outcome per endpoint. */
  wifiProvisionResultByEndpoint: Map<string, WifiProvisionResultMessage>;
  /** Subscribers to the local-hex upload handshake's `flash-local-ready`
   * reply (ticket 008) -- see `WsActions.onFlashLocalReady`'s own doc
   * comment. Not store-backed state (no `endpoints`/log-buffer slice
   * changes because of this message), so firing these handlers never
   * needs a matching `notify(store)` call the way `flash-result`'s
   * handling does. */
  flashLocalReadyHandlers: Set<(message: FlashLocalReadyMessage) => void>;
  /** Per-endpoint telemetry state (sprint 9 ticket 003) -- see
   * `TelemetrySlice`'s own doc comment. Created lazily, on first
   * reference (a `"telemetry"` message, or a `useTelemetry`/
   * `useTelemetryHeader` call), by `getOrCreateTelemetrySlice`. */
  telemetryByEndpoint: Map<string, TelemetrySlice>;
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
  /** Empty one endpoint's telemetry ring (ticket 005's Clear button) --
   * see `TelemetryHandle.clear`'s own doc comment. Equivalent to
   * calling `clear()` on the handle `useTelemetry(endpointId)` returns;
   * exposed here too so a component that only needs to clear (and
   * doesn't otherwise read telemetry) can use `useWsActions()` alone. */
  clearTelemetry: (endpointId: string) => void;
  /** Request the robot change (or re-announce) its telemetry stream --
   * forwards `{ type: "send-command", endpointId, verb: "TLM", fields:
   * [mode] }` through `sendCommand`'s existing readyState guard (see
   * that action's own doc comment). `RobotPage` (ticket 004) decides
   * when to call this (e.g. `"POSE"`/`"FULL"` on mount or tab-select,
   * `"OFF"` on unmount) -- this action only owns the wire shape, not
   * the policy of when to send it. */
  telemetrySubscribe: (endpointId: string, mode: TelemetryMode) => void;
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
  // `exactOptionalPropertyTypes` forbids `origin: undefined` -- the key
  // must be absent entirely (not present-with-undefined) when the
  // incoming message carries none, mirroring `sendCommand`'s own
  // present/absent handling of `fields` above.
  pushLogEntry(
    store,
    message.endpointId,
    message.origin !== undefined
      ? { direction: message.direction, line: message.line, origin: message.origin }
      : { direction: message.direction, line: message.line },
  );
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
  // Same shorthand again: `EndpointsMessage.discoveredServices` is
  // required on a real message, but typed as possibly `undefined` here
  // so an old-shaped message never clobbers a previously-good
  // `store.discoveredServices` with `undefined`.
  discoveredServices: DiscoveredServicesSnapshot | undefined,
): void {
  const nextIds: string[] = [];
  const nextMap = new Map<string, EndpointListEntry>();
  for (const entry of endpoints) {
    const previous = store.endpointsById.get(entry.endpointId);
    nextMap.set(entry.endpointId, previous && deepEqual(previous, entry) ? previous : entry);
    nextIds.push(entry.endpointId);
    // Sprint 9 ticket 003: a session that just closed leaves its
    // telemetry ring holding frames from a session that no longer
    // exists -- reset it (but keep the header; the column layout
    // itself hasn't changed, only the retained history has, mirroring
    // `clearTelemetrySlice`'s own scope).
    if (previous?.sessionOpen && !entry.sessionOpen) {
      clearTelemetrySlice(store, entry.endpointId);
    }
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

  if (discoveredServices !== undefined && !deepEqual(store.discoveredServices, discoveredServices)) {
    store.discoveredServices = discoveredServices;
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

/** Return `endpointId`'s telemetry slice, creating an empty one (no
 * header, empty ring) on first reference -- mirrors
 * `logsByEndpoint.get(id) ?? []`'s "doesn't exist yet" handling
 * elsewhere in this module, but as a real map entry rather than a
 * shared empty constant, since a slice's ring/listeners need to be a
 * live, mutable identity once frames start arriving for it. */
function getOrCreateTelemetrySlice(store: Store, endpointId: string): TelemetrySlice {
  let slice = store.telemetryByEndpoint.get(endpointId);
  if (!slice) {
    slice = { header: undefined, ring: new TelemetryRing(TELEMETRY_RING_CAPACITY), frameListeners: new Set() };
    store.telemetryByEndpoint.set(endpointId, slice);
  }
  return slice;
}

/** Empty `endpointId`'s telemetry ring, if a slice exists for it yet --
 * a no-op otherwise (nothing to clear). Shared by `applySnapshot`'s
 * session-close handling and `WsActions.clearTelemetry`/
 * `TelemetryHandle.clear`. Never touches `header` -- see both callers'
 * own doc comments for why. */
function clearTelemetrySlice(store: Store, endpointId: string): void {
  store.telemetryByEndpoint.get(endpointId)?.ring.clear();
}

/** Handle one `"telemetry"` message (ticket 002's `TelemetryMessage`):
 * a header update replaces the current header and resets the ring
 * (SUC-003's "header recovered" -- the previous frames' columns no
 * longer describe anything, per this ticket's acceptance criteria), and
 * is the one telemetry event that goes through `notify(store)`, since
 * `useTelemetryHeader` is an ordinary reactive selector. A frame update
 * with no header held yet is dropped rather than buffered or thrown on
 * (AC5) -- there is no column layout to attach it to, and the header
 * will be re-sent once `deviceRegistry.ts`'s gap-recovery `TLM HDR`
 * completes host-side. A frame update with a header held is parsed
 * (`Number()` per field, `NaN` for anything unparsable -- see
 * `TelemetryFrame`'s own doc comment), pushed into the ring, and fanned
 * out to `frameListeners` directly -- deliberately *not* through
 * `notify(store)`, per this module's doc comment. */
function handleTelemetryMessage(store: Store, message: TelemetryMessage): void {
  const slice = getOrCreateTelemetrySlice(store, message.endpointId);
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
    discoveredServices: DEFAULT_DISCOVERED_SERVICES,
    logsByEndpoint: new Map(),
    logOrder: [],
    flashProgressByEndpoint: new Map(),
    wifiCredentials: undefined,
    wifiProvisionResultByEndpoint: new Map(),
    flashResultHandlers: new Set(),
    flashLocalReadyHandlers: new Set(),
    telemetryByEndpoint: new Map(),
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
      clearTelemetry: (endpointId: string) => {
        clearTelemetrySlice(store, endpointId);
      },
      telemetrySubscribe: (endpointId: string, mode: TelemetryMode) => {
        store.actions.sendCommand(endpointId, "TLM", [mode]);
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
        switch (parsed.type) {
          case "endpoints":
            applySnapshot(
              store,
              parsed.endpoints,
              parsed.firmwareStatus,
              parsed.rememberedRobots,
              parsed.discoveredServices,
            );
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
          case "wifi-credentials":
            store.wifiCredentials = parsed;
            notify(store);
            break;
          case "wifi-provision-result":
            store.wifiProvisionResultByEndpoint.set(parsed.endpointId, parsed);
            notify(store);
            break;
          case "telemetry":
            // Sprint 9 ticket 003: deliberately does not call
            // `notify(store)` itself here -- `handleTelemetryMessage`
            // only does so for a header update; a frame update fans out
            // to that endpoint's own `frameListeners` instead, per this
            // module's doc comment.
            handleTelemetryMessage(store, parsed);
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

/** The current mDNS discovery snapshot (relays + robots) from the most
 * recent `endpoints` snapshot (sprint 8 ticket 004/005) -- mirrors
 * {@link useRememberedRobots} exactly. `{ relays: [], robots: [] }`
 * before the first snapshot arrives. Rendering or opening a dropdown
 * fed by this selector never triggers a registry lookup of its own --
 * this is a passive mirror of the host's already-live discovery
 * browse, per `sprint.md`'s Solution. */
export function useDiscoveredServices(): DiscoveredServicesSnapshot {
  const store = useStore();
  return useSyncExternalStore(store.subscribe, () => store.discoveredServices);
}

/** Live progress of an in-flight flash for one endpoint, populated
 * from `flash-progress` events -- works for both a release source and
 * a local-hex source (unlike `EndpointListEntry.flashStatus`, which is
 * frozen to `{ firmware, phase }` and cannot represent local-hex). See
 * this module's doc comment ("Flash progress for both source kinds")
 * for the reconnect-gap this does not close. */
/** OOP 2026-09-10: the host's stored WiFi network description (see
 * `wsMessages.ts`'s `WifiCredentialsMessage`), `undefined` until a
 * `get-wifi-credentials` has been answered. */
export function useWifiCredentials(): WifiCredentialsMessage | undefined {
  const store = useStore();
  return useSyncExternalStore(
    store.subscribe,
    useCallback(() => store.wifiCredentials, [store]),
  );
}

/** OOP 2026-09-10: the latest `wifi-provision-result` for one endpoint. */
export function useWifiProvisionResult(endpointId: string): WifiProvisionResultMessage | undefined {
  const store = useStore();
  return useSyncExternalStore(
    store.subscribe,
    useCallback(() => store.wifiProvisionResultByEndpoint.get(endpointId), [store, endpointId]),
  );
}

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

/** One endpoint's current telemetry column header, or `undefined`
 * before any `thdr` has been recovered for it (or after its session has
 * closed and no new header has arrived yet) -- an ordinary reactive
 * selector via `useSyncExternalStore`, unlike `useTelemetry` below,
 * since headers change rarely enough (per this ticket's design) that
 * React state is the right tool for a "waiting for header" banner.
 * Subscribes only to that one endpoint's header -- a component reading
 * `useTelemetryHeader("A")` does not re-render when endpoint B's header
 * changes, or on any frame arriving for either endpoint (frames never
 * call `notify(store)` -- see this module's doc comment). */
export function useTelemetryHeader(endpointId: string): readonly string[] | undefined {
  const store = useStore();
  return useSyncExternalStore(
    store.subscribe,
    useCallback(() => store.telemetryByEndpoint.get(endpointId)?.header, [store, endpointId]),
  );
}

/** The imperative, non-React-reactive handle to one endpoint's
 * telemetry ring -- see `TelemetryHandle`'s own doc comment for what it
 * exposes and why. Returns the *same* handle object for as long as
 * `endpointId` doesn't change (built once per endpoint via a plain
 * `useRef`, not `useSyncExternalStore`), so a consumer's
 * `useEffect(() => handle.subscribe(cb), [handle])` never re-runs on an
 * unrelated render the way it would if a fresh object were handed back
 * every time. `header`/`latest` on the returned handle are live
 * getters, so they can be read at any point after this hook returns
 * (e.g. inside a `requestAnimationFrame` callback) and always reflect
 * the current store, not a value frozen at the render that created the
 * handle. */
export function useTelemetry(endpointId: string): TelemetryHandle {
  const store = useStore();
  const ref = useRef<{ endpointId: string; handle: TelemetryHandle } | null>(null);
  if (ref.current === null || ref.current.endpointId !== endpointId) {
    const getSlice = () => getOrCreateTelemetrySlice(store, endpointId);
    ref.current = {
      endpointId,
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
          clearTelemetrySlice(store, endpointId);
        },
      },
    };
  }
  return ref.current.handle;
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
