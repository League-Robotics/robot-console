/**
 * server.ts — the thin broadcast-and-dispatch layer between the store/
 * connect subsystem and the browser UI (sprint 015 ticket 005; issue
 * `rearch-06-snapshot-wire-contract-and-thin-server.md`;
 * `docs/design/architecture.md` §6/§9; `sprint.md`'s own module table:
 * "Inside: WebSocket lifecycle, per-socket `error` handling,
 * `bufferedAmount`/`maxPayload` guards, a `Map<type, handler>` command
 * dispatch ... Outside: *constructing* watchers/reconciler/store (that
 * is `runtime`'s job — server only holds references it's handed),
 * deciding policy itself, building the JSON shape (projection).").
 *
 * This is a rewrite, not an incremental patch: the previous version
 * (through sprint 014) composed the now-retired registry class directly
 * and spoke the retired `EndpointsMessage`/`EndpointListEntry` wire
 * shape. Every reference to that class is gone as of this ticket (its
 * last call site was this file's own old inline construction) — see
 * `docs/reviews/2026-09-11/03-host-server-flash-releases.md` §1 for the
 * findings this rewrite fixes (missing `unsubscribeTelemetry`, no
 * per-socket `error` handler, no `maxPayload`/backpressure guard).
 *
 * ## What this module still does *not* do
 *
 * No naming, framing, sequencing, or connection-policy logic of its own.
 * `buildSnapshot` (`projection.ts`) turns store rows into the wire
 * shape; `connect/reconciler.ts` decides what should be connected and
 * exposes the one seam (`requestOpen`/`requestClose`/`sessions`) this
 * module forwards user commands and reaches an open session's link
 * through; `runtime.ts` constructs all of it. This module only moves
 * bytes between the store/connect subsystem and the socket, plus the
 * two things that were always server-local, ephemeral state with no
 * store table of their own (per `projection.ts`'s own doc comment):
 * in-flight flash progress (`SnapshotLink.flash`) and the local-hex
 * upload handshake.
 *
 * ## One shared `seq` counter
 *
 * `wsMessages.ts`'s own doc comment: "every server -> client message
 * gains `seq`, an incrementing counter `server.ts` stamps on every
 * broadcast." This module keeps exactly one counter, incremented for
 * every outgoing message regardless of type (`snapshot`, `notice`,
 * `line`, `telemetry`, `flash-progress`, `flash-result`, ...), so a
 * client can detect a gap in *any* message stream after a reconnect —
 * not one counter per message type.
 *
 * ## Flash orchestration has no `DeviceRegistry` to live in any more
 *
 * Through sprint 014, `deviceRegistry.ts#runFlash` owned resolving a
 * `DaplinkDevice` (via `devices.ts`'s enumerator), fetching/verifying a
 * release hex (`releases.ts`) or consuming an already-uploaded one
 * (`localHexUpload.ts`), and calling `flash.ts`'s `flash()`. That class
 * is retired (ticket 003); this ticket is the first thing to need that
 * orchestration again, so it lives here now, directly — this module is
 * "thin" in the sense of holding no *policy* of its own, not in the
 * sense of never doing anything beyond forwarding a call verbatim. A
 * fresh `enumerateDaplinkDevices()` call resolves the link's current
 * `DaplinkDevice` by USB serial (recovered from the `usb-<serial>` link
 * id convention `watchers/usbWatcher.ts`/`connect/connector.ts` both
 * already use) rather than caching one from either watcher, since
 * neither retains a live handle past one poll cycle.
 *
 * Once a **USB** flash succeeds, this module does **not** manually
 * orchestrate a post-flash reidentify (the old registry's own
 * `reidentifyAfterFlash`) — the freshly-rebooted board re-enumerates
 * over USB exactly like any other attach, so `watchers/usbWatcher.ts`
 * and `connect/reconciler.ts`'s existing automatic-connect pass pick it
 * back up on their own next poll/tick, with no special-casing here.
 * `flash-result`'s optional `role`/`name`/`reidentify` fields
 * (`wsMessages.ts`) are accordingly never populated by this
 * implementation — the next `snapshot` broadcast carries the same
 * information once the board reconnects.
 *
 * Ticket 018-014's **network** flash path (`runNetworkFlashTask`,
 * `connect/mbflashClient.ts`) is the one exception to the paragraph
 * above: a farm robot's TCP link never "re-enumerates" the way a USB
 * attach does, so this module closes the link's own session before
 * flashing and explicitly asks `runtime.reconciler.requestOpen` to
 * reopen it afterward (reported as the `reidentifying` `flash-progress`
 * phase) — best-effort, since the flash itself has already succeeded by
 * that point regardless of whether this particular reopen lands.
 *
 * Sprint 017 ticket 003: `board_owner = 'flash'` exclusivity and the
 * session-close-first handoff around the actual `flash.ts#flash()` call
 * now live in `connect/flasher.ts`, not here — `runFlashTask` below
 * still resolves the device and the hex bytes (this module's own job,
 * per the paragraph above) but calls `flasher.flash(...)` rather than
 * `flashFn(...)` directly, so a flash can never start while this link's
 * session is still open on the wire.
 */

import { createServer, type Server as HttpServer } from "node:http";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { WebSocket, WebSocketServer } from "ws";
import { WifiCredentialsStore } from "./store/wifiCredentials.js";
import { findCurrentMbflashService, type ProjectionDeviceRow, type ProjectionServiceRow, type Store } from "./store/index.js";
import type { Reconciler } from "./connect/reconciler.js";
import type { ConnectedSession } from "./connect/connector.js";
import type { HarvesterTelemetryEvent } from "./connect/harvester.js";
import { buildSnapshotFromRows } from "./projection.js";
import { isValidRadioOverride } from "./radioOverride.js";
import {
  openSession,
  closeSession,
  requireSession as requireOpenSession,
  sendCommand as sharedSendCommand,
  type OpenSessionParams,
} from "./connect/sessionOps.js";
import { getFirmwareConfig, type FirmwareConfigMap } from "./config.js";
import { resolveRelease as defaultResolveRelease, fetchAndVerifyHex as defaultFetchAndVerifyHex } from "./releases.js";
import { LocalHexUploadManager, MAX_UPLOAD_BYTE_LENGTH } from "./localHexUpload.js";
import { readLocalHex as defaultReadLocalHex } from "./localFirmware.js";
import { flash as defaultFlash, type FlashOutcome } from "./flash.js";
import { createFlasher } from "./connect/flasher.js";
import { flashOverMbflash as defaultFlashOverMbflash, type MbflashOutcome } from "./connect/mbflashClient.js";
import {
  enumerateDaplinkDevices as defaultEnumerateDaplinkDevices,
  type DaplinkDevice,
  type DaplinkDeviceLister,
} from "./devices.js";
import {
  parseClientMessage,
  UPLOAD_ID_BYTE_LENGTH,
  type ClientMessage,
  type FirmwareSourceRef,
  type FlashPhase,
  type Notice,
  type ServerMessage,
  type SessionOriginWire,
  type Snapshot,
  type SnapshotLink,
} from "./wsMessages.js";

/** Default port `npx robot-console` listens on. Override via
 * {@link StartServerOptions.port} (the `cli.ts` entry point also
 * accepts `--port`/`ROBOT_CONSOLE_PORT`). */
export const DEFAULT_PORT = 4795;

/** Bind address. Deliberately not overridable — see the module doc
 * comment's predecessor's own "Localhost only" note, still true here:
 * this process can open serial ports and drive a physical robot, so it
 * must never be reachable from anything but the machine it runs on. */
const DEFAULT_HOST = "127.0.0.1";

/** Bound on one incoming WebSocket frame (ticket 005 AC / review finding
 * `03-host-server-flash-releases.md` §1, F9). Sprint 017 ticket 003: tied
 * directly to `localHexUpload.ts`'s own {@link MAX_UPLOAD_BYTE_LENGTH}
 * cap (plus the `uploadId` prefix every binary upload frame carries and
 * a small slack for ordinary JSON control-message framing overhead) so
 * `WebSocketServer`'s own `maxPayload` is the *real* enforcement
 * boundary for an oversized upload -- not a separately-chosen,
 * coincidentally-larger magic number that happens to bound it (F9: "cap
 * checks declared `byteLength` only ... `ws` default `maxPayload` (100
 * MiB) is the real bound"). Every other incoming client message
 * (`flash-start`, `session-open`, ...) is a small JSON object, well
 * under this. */
export const DEFAULT_MAX_PAYLOAD_BYTES = MAX_UPLOAD_BYTE_LENGTH + UPLOAD_ID_BYTE_LENGTH + 4096;

/** `bufferedAmount` (bytes still queued in `ws`'s own send buffer, not
 * yet flushed to the OS socket) above which a stalled client stops
 * receiving `line`/`telemetry` broadcasts — never `snapshot` (ticket 005
 * AC / review finding `03-host-server-flash-releases.md` §1: nothing
 * bounded a slow client's queue before this ticket). 1 MiB is generous
 * for either message's normal size while still catching a genuinely
 * wedged socket well before Node's own send buffer grows unbounded. */
export const DEFAULT_BUFFERED_AMOUNT_THRESHOLD_BYTES = 1024 * 1024;

/** How long {@link handleProvisionWifi} waits for the robot's own
 * `wificred`/`err` reply before giving up — matches the retired
 * `deviceRegistry.ts`'s own `WIFICRED_REPLY_TIMEOUT_MS`. */
export const DEFAULT_WIFI_PROVISION_TIMEOUT_MS = 4000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** `packages/host/src/server.ts` -> `packages/ui/dist`, the Vite build
 * output. Resolved relative to this module's own location (not
 * `process.cwd()`) so it works regardless of where `robot-console` is
 * invoked from. */
function defaultStaticDir(): string {
  return path.resolve(__dirname, "../../ui/dist");
}

/** The narrow slice of {@link Runtime} (`runtime.ts`) this module
 * actually needs — declared locally rather than imported, so `server.ts`
 * never imports `runtime.ts` (which itself imports `server.ts` to
 * construct it — see `sprint.md`'s own dependency graph, "no cycle").
 * Structurally identical to `runtime.ts`'s own `Runtime`/`RuntimeTelemetry`,
 * so a real {@link Runtime} satisfies this with no adapter needed. */
export interface ServerTelemetry {
  onTelemetry(listener: (linkId: string, event: HarvesterTelemetryEvent) => void): () => void;
  onNotice(listener: (linkId: string, message: string) => void): () => void;
}

export interface ServerRuntime {
  readonly reconciler: Reconciler;
  readonly telemetry: ServerTelemetry;
}

export interface StartServerOptions {
  /** The store to read/broadcast a snapshot from on every change. */
  store: Store;
  /** The reconciler/telemetry seam — see {@link ServerRuntime}. */
  runtime: ServerRuntime;
  /** Port to listen on. Defaults to {@link DEFAULT_PORT}. */
  port?: number;
  /** Directory of the built UI to serve as static files. Defaults to
   * `packages/ui/dist`. If it does not exist, the server still starts —
   * it serves a plain status page instead of failing. */
  staticDir?: string;
  /** Injectable firmware-source configuration, used only to resolve a
   * `flash-start` whose source is `kind: "release"` (module doc
   * comment's "Flash orchestration" section). Defaults to a real call
   * to {@link getFirmwareConfig}. Sprint 017 ticket 002: this module no
   * longer polls firmware availability itself — that is
   * `watchers/firmwareWatcher.ts`'s job now (composed in `runtime.ts`),
   * writing `firmware` rows this server broadcasts through its existing
   * `store.onChange` subscription with no firmware-specific glue here. */
  firmwareConfig?: FirmwareConfigMap;
  /** OOP 2026-09-10: injectable WiFi credential store (tests). */
  wifiCredentials?: WifiCredentialsStore;
  /** Injectable {@link LocalHexUploadManager}; defaults to a fresh
   * instance per {@link startServer} call. */
  localHexUpload?: LocalHexUploadManager;
  /** `WebSocketServer`'s own `maxPayload`. Defaults to
   * {@link DEFAULT_MAX_PAYLOAD_BYTES}. */
  maxPayloadBytes?: number;
  /** See {@link DEFAULT_BUFFERED_AMOUNT_THRESHOLD_BYTES}. */
  bufferedAmountThresholdBytes?: number;
  /** See {@link DEFAULT_WIFI_PROVISION_TIMEOUT_MS}. */
  wifiProvisionTimeoutMs?: number;
  /** Injectable USB enumerator for flash-start's device resolution
   * (module doc comment's "Flash orchestration" section). Defaults to
   * the real {@link enumerateDaplinkDevices}. */
  enumerateDaplinkDevices?: DaplinkDeviceLister;
  /** Injectable release resolver for a `flash-start` whose source is
   * `kind: "release"`. Defaults to the real {@link resolveRelease}. */
  resolveRelease?: typeof defaultResolveRelease;
  /** Injectable hex fetch+verify for the same path. Defaults to the real
   * {@link fetchAndVerifyHex}. */
  fetchAndVerifyHex?: typeof defaultFetchAndVerifyHex;
  /** Reads a firmware kind configured as a local `.hex` path
   * (out-of-process, 2026-09-16). Defaults to the real
   * {@link readLocalHex}. */
  readLocalHex?: typeof defaultReadLocalHex;
  /** Injectable flash orchestration. Defaults to the real {@link flash}
   * (`flash.ts`) — tests substitute a fake that resolves/rejects on
   * demand, e.g. to exercise ticket 005's signal-handling acceptance
   * criterion without ever touching real SWD/HID hardware. */
  flash?: typeof defaultFlash;
  /** Injectable network-flash orchestration for a `mbserial`/`wifi`
   * link whose device has a current `_mbflash._tcp` service (ticket
   * 018-014). Defaults to the real {@link flashOverMbflash}
   * (`connect/mbflashClient.ts`) — tests substitute a fake, same
   * reasoning as {@link flash} above, without ever dialing a real farm
   * host. */
  flashOverMbflash?: typeof defaultFlashOverMbflash;
  /** Injectable `WebSocketServer` construction — defaults to a real
   * `new WebSocketServer({server: httpServer, maxPayload})`. See
   * {@link WebSocketServerLike}. */
  createWebSocketServer?: (httpServer: HttpServer, maxPayloadBytes: number) => WebSocketServerLike;
  /** Sprint 019 ticket 004: called once, synchronously, with this
   * server's own Express `app` instance, before the static-file/SPA
   * catch-all route is registered — the one extension point a caller
   * needs to mount an additional route (e.g. `cli.ts` mounting the MCP
   * Streamable HTTP endpoint via `mcp/server.ts`'s `startMcpServer`) that
   * must win against the catch-all rather than be shadowed by it. Purely
   * generic: this module has no knowledge of what, if anything, gets
   * mounted here. */
  mountRoutes?: (app: express.Express) => void;
}

/** `readyState`'s `OPEN` value (the standard WebSocket constants:
 * `CONNECTING=0, OPEN=1, CLOSING=2, CLOSED=3`) — used instead of
 * `WebSocket.OPEN` so this module's own connection-handling logic works
 * unchanged against either a real `ws.WebSocket` or a test fake (see
 * {@link WebSocketLike}). */
const WS_OPEN = 1;

/** The narrow slice of `ws`'s own `WebSocket` this module actually uses
 * — a real instance always satisfies this; `server.test.ts` substitutes
 * a fake implementing just this shape so per-socket `error`/
 * `bufferedAmount` behavior (ticket 005's own acceptance criteria) can
 * be driven deterministically with no real network connection. */
export interface WebSocketLike {
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(data: string): void;
  terminate(): void;
  on(event: "message", listener: (data: WebSocket.RawData, isBinary: boolean) => void): void;
  on(event: "error", listener: (err: Error) => void): void;
  on(event: "close", listener: () => void): void;
}

/** The narrow slice of `ws`'s own `WebSocketServer` this module actually
 * uses. See {@link WebSocketLike}. */
export interface WebSocketServerLike {
  on(event: "connection", listener: (ws: WebSocketLike) => void): void;
  on(event: "error", listener: (err: Error) => void): void;
  close(callback: (err?: Error) => void): void;
}

export interface RunningServer {
  readonly port: number;
  readonly host: string;
  readonly url: string;
  /** Stop accepting connections, close every open WebSocket, and
   * unsubscribe from the store/telemetry/notice feeds and the
   * availability cache. Waits for any in-flight `flash-start` task to
   * finish (or fail) naturally before returning — see this module's own
   * `runFlashTask` doc comment for why a flash is never interrupted
   * mid-write. Does **not** stop the `runtime` it was given; `cli.ts`
   * calls `runtime.stop()` itself, after this resolves. */
  close(): Promise<void>;
}

function buildApp(staticDir: string, mountRoutes?: (app: express.Express) => void): express.Express {
  const app = express();
  // Sprint 019 ticket 004: a caller-supplied hook to register additional
  // routes *before* the static-file/SPA catch-all below -- Express
  // matches routes in registration order, so anything specific (e.g. the
  // MCP Streamable HTTP endpoint `cli.ts` mounts here) must be wired
  // before the `app.get(/.*/, ...)` catch-all exists, or it would never
  // be reached. This module has no MCP-specific knowledge of its own --
  // see {@link StartServerOptions.mountRoutes}'s own doc comment.
  mountRoutes?.(app);
  if (existsSync(staticDir)) {
    app.use(express.static(staticDir));
    app.get(/.*/, (_req, res) => {
      res.sendFile(path.join(staticDir, "index.html"));
    });
  } else {
    app.get("/", (_req, res) => {
      res
        .status(200)
        .type("text/plain")
        .send(
          "robot-console host is running, but packages/ui has not been " +
            "built yet (no packages/ui/dist found). Connect a WebSocket " +
            "client to this same host/port instead of using a browser.",
        );
    });
  }
  return app;
}

/** Normalize `ws`'s `RawData` into one contiguous `Buffer`, for
 * {@link LocalHexUploadManager#receiveFrame} to split. */
function toBuffer(data: WebSocket.RawData): Buffer {
  if (Buffer.isBuffer(data)) {
    return data;
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data);
  }
  return Buffer.from(data);
}

function listen(server: HttpServer, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException) => {
      server.removeListener("listening", onListening);
      if (err.code === "EADDRINUSE") {
        reject(
          new Error(
            `port ${port} is already in use on ${host}. ` +
              `Pass a different port (e.g. \`--port <port>\` or ` +
              `ROBOT_CONSOLE_PORT=<port>) rather than relying on an ` +
              `automatically-chosen one.`,
          ),
        );
        return;
      }
      reject(err);
    };
    const onListening = () => {
      server.removeListener("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

/** `usbWatcher.ts`/`connect/connector.ts`'s own `usb-<serialNumber>` link
 * id convention, independently re-derived here (this module never
 * imports either — both are one-directional-dependency leaves; see the
 * dependency graph's "no cycle" note) so `flash-start` can resolve a
 * link back to the USB serial its `DaplinkDevice` enumerates under. */
function usbSerialFromLinkId(linkId: string): string | undefined {
  return linkId.startsWith("usb-") ? linkId.slice("usb-".length) : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Start the thin server: bind to localhost, serve the built UI (if
 * present), broadcast one coalesced `snapshot` per store change-feed
 * flush, and dispatch every client command through a `Map<type,
 * handler>` — session-affecting commands forward to `runtime.reconciler`;
 * everything else reaches the target link's open session directly via
 * `runtime.reconciler.sessions`. See the module doc comment.
 */
export async function startServer(options: StartServerOptions): Promise<RunningServer> {
  const host = DEFAULT_HOST;
  const port = options.port ?? DEFAULT_PORT;
  const staticDir = options.staticDir ?? defaultStaticDir();
  const store = options.store;
  const runtime = options.runtime;
  const maxPayloadBytes = options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
  const bufferedAmountThresholdBytes = options.bufferedAmountThresholdBytes ?? DEFAULT_BUFFERED_AMOUNT_THRESHOLD_BYTES;
  const wifiProvisionTimeoutMs = options.wifiProvisionTimeoutMs ?? DEFAULT_WIFI_PROVISION_TIMEOUT_MS;

  const localHexUpload = options.localHexUpload ?? new LocalHexUploadManager();
  const wifiCredentials = options.wifiCredentials ?? new WifiCredentialsStore();
  // Sprint 017 ticket 001: getFirmwareConfig reads `settings` via
  // `store`, not `env`/a `.env` file -- `store` is already in scope
  // above.
  const firmwareConfig = options.firmwareConfig ?? getFirmwareConfig(store);

  const enumerateDaplinkDevicesFn = options.enumerateDaplinkDevices ?? defaultEnumerateDaplinkDevices;
  const resolveReleaseFn = options.resolveRelease ?? defaultResolveRelease;
  const fetchAndVerifyHexFn = options.fetchAndVerifyHex ?? defaultFetchAndVerifyHex;
  const readLocalHexFn = options.readLocalHex ?? defaultReadLocalHex;
  const flashFn = options.flash ?? defaultFlash;
  // Sprint 017 ticket 003: flash orchestration's board_owner exclusivity
  // and session close-first handoff now live in `connect/flasher.ts`,
  // not inline here -- see that module's own doc comment. `flashFn`
  // (still the injectable seam `server.test.ts` uses) is what the
  // flasher actually calls once it has acquired the owner.
  const flasher = createFlasher(store, { reconciler: runtime.reconciler, flash: flashFn });
  // Ticket 018-014: the network-flash counterpart for a mbserial/wifi
  // link whose device has a current `_mbflash._tcp` service -- no
  // `board_owner`/`connect/flasher.ts` involved (that module's
  // exclusivity is specifically for local USB/HID contention; the
  // farm's own single-client bridge is what actually arbitrates a
  // network flash, reported back as `ERR busy` -- see `runNetworkFlashTask`).
  const flashOverMbflashFn = options.flashOverMbflash ?? defaultFlashOverMbflash;

  const app = buildApp(staticDir, options.mountRoutes);
  const httpServer = createServer(app);
  const createWebSocketServer =
    options.createWebSocketServer ?? ((server, maxPayload) => new WebSocketServer({ server, maxPayload }));
  const wss = createWebSocketServer(httpServer, maxPayloadBytes);
  // `ws`'s WebSocketServer re-emits the underlying http.Server's "error"
  // event (e.g. EADDRINUSE) as its own -- Node's EventEmitter throws for
  // an "error" event with no listener, so this must be handled even
  // though the rejection this function surfaces comes from `listen()`'s
  // own httpServer-level listener, not from here.
  wss.on("error", () => {
    // Swallowed deliberately -- see comment above.
  });

  const clients = new Set<WebSocketLike>();
  let seq = 0;
  function nextSeq(): number {
    seq += 1;
    return seq;
  }

  function broadcast(message: ServerMessage, sendOptions?: { throttle?: boolean }): void {
    const payload = JSON.stringify(message);
    const throttle = sendOptions?.throttle ?? false;
    for (const client of clients) {
      if (client.readyState !== WS_OPEN) {
        continue;
      }
      if (throttle && client.bufferedAmount > bufferedAmountThresholdBytes) {
        // Ticket 005 AC: a stalled client stops receiving line/telemetry
        // (throttled) but still receives the next snapshot (never
        // throttled) -- see this call's own call sites.
        continue;
      }
      client.send(payload);
    }
  }

  function sendNotice(linkId: string | undefined, level: Notice["level"], text: string): void {
    const notice: Notice = {
      type: "notice",
      level,
      text,
      at: Date.now(),
      seq: nextSeq(),
      ...(linkId !== undefined ? { linkId } : {}),
    };
    broadcast(notice);
  }

  // -----------------------------------------------------------------
  // Snapshot broadcast -- one per coalesced change-feed flush, plus a
  // server-side overlay of the two ephemeral fields buildSnapshot never
  // populates (projection.ts's own doc comment): SnapshotLink.flash.
  // -----------------------------------------------------------------

  // Sprint 019 ticket 006 (SUC-007): `origin`/`caller` ride alongside
  // `source`/`phase` in this same in-memory overlay -- `overlayLink`
  // below spreads this whole value onto `SnapshotLink.flash` verbatim, so
  // adding fields here is all "wiring the plumbing" (this ticket's own
  // scope) requires; no change to `overlayLink`/`overlaySnapshot`
  // themselves. Every call site in this file today is the browser's own
  // `flash-start` handler, which never passes an identity and so always
  // gets {@link UI_FLASH_IDENTITY} -- ticket 008's `mcp/tools/flash.ts`
  // is the first caller that will ever pass `{origin: "mcp", caller}`,
  // once `startFlash` is extracted for it to call directly (`sprint.md`'s
  // Impact/Design Rationale).
  const flashStateByLink = new Map<string, { source: FirmwareSourceRef; phase: FlashPhase; origin?: SessionOriginWire; caller?: string }>();

  /** Who started a flash -- see {@link flashStateByLink}'s own doc
   * comment. */
  interface FlashIdentity {
    readonly origin: SessionOriginWire;
    readonly caller?: string;
  }

  /** The identity every flash in this file is started with today (a
   * browser's own `flash-start` message carries no caller identity of
   * its own) -- see {@link flashStateByLink}'s own doc comment. */
  const UI_FLASH_IDENTITY: FlashIdentity = { origin: "ui" };

  function overlayLink(link: SnapshotLink): SnapshotLink {
    const flash = flashStateByLink.get(link.id);
    return flash ? { ...link, flash } : link;
  }

  function overlaySnapshot(snapshot: Snapshot): Snapshot {
    if (flashStateByLink.size === 0) {
      return snapshot;
    }
    return {
      ...snapshot,
      devices: snapshot.devices.map((device) => ({ ...device, links: device.links.map(overlayLink) })),
      unassigned: snapshot.unassigned.map(overlayLink),
    };
  }

  function buildCurrentSnapshot(): Snapshot {
    return overlaySnapshot(buildSnapshotFromRows(store.projectionRows(), nextSeq(), Date.now()));
  }

  function broadcastSnapshot(): void {
    broadcast(buildCurrentSnapshot());
  }

  // Every currently-open session gets an inbound-line subscription
  // exactly once, so the console log echoes inbound ("rx") device
  // chatter -- connect/harvester.ts's own onLine/onClose/onAckNack
  // subscriptions on the same LineLink are independent of this one
  // (LineLink's `onLine`/`onRawLine`/`onInboundLine` support any number
  // of listeners; see that module's own doc comment). A WeakSet, not a
  // Set, so a session this module has subscribed to can still be
  // garbage-collected once the reconciler itself drops it (a close, or a
  // fresh session replacing it).
  //
  // **Item G (team-lead, 2026-09-13)**: this used to read `onRawLine`,
  // which only fires for a line `receive()` could not route to a decoded
  // shape (unrouted or malformed) -- so a real, successfully-decoded
  // reply (`id`/`status`/`ack`/`nack`) never reached the student console
  // at all; only unsolicited `DBG:` lines (also unroutable) ever showed.
  // `onInboundLine` fires for every inbound line regardless of how
  // `receive()` classified it, so every reply is now broadcast exactly
  // once -- see `LineLink.onInboundLine`'s own doc comment.
  const subscribedSessions = new WeakSet<ConnectedSession>();

  // A `status` reply answers the harvester's own periodic STATUS poll
  // unless a student asked for STATUS themselves and has not had an
  // answer yet -- `connect/harvester.ts` never polls while a student's
  // unsequenced query is outstanding, so the next `status` line answers
  // whichever side asked. Tagging the poll's replies `origin: "poll"`
  // (`LineMessage.origin`) is what lets the console's "Show status polls"
  // toggle hide them; the sprint 015 harvester rewrite had stopped
  // setting it, so every poll reply showed regardless of the toggle.
  const STUDENT_STATUS_REPLY_WINDOW_MS = 5000;
  const studentStatusAskedAt = new WeakMap<ConnectedSession, number>();
  function noteStudentStatus(session: ConnectedSession, verb: string | undefined): void {
    if (verb !== undefined && verb.toUpperCase() === "STATUS") {
      studentStatusAskedAt.set(session, Date.now());
    }
  }
  function statusReplyOrigin(session: ConnectedSession, line: string): "poll" | undefined {
    if (line.trim().split(/\s+/)[0] !== "status") {
      return undefined;
    }
    const askedAt = studentStatusAskedAt.get(session);
    studentStatusAskedAt.delete(session);
    return askedAt !== undefined && Date.now() - askedAt <= STUDENT_STATUS_REPLY_WINDOW_MS ? undefined : "poll";
  }

  function ensureLineSubscriptions(): void {
    for (const session of runtime.reconciler.sessions.values()) {
      if (subscribedSessions.has(session)) {
        continue;
      }
      subscribedSessions.add(session);
      session.link.onInboundLine((line: string) => {
        const origin = statusReplyOrigin(session, line);
        broadcast(
          { type: "line", linkId: session.linkId, direction: "rx", line, seq: nextSeq(), ...(origin ? { origin } : {}) },
          { throttle: true },
        );
      });
    }
  }

  const unsubscribeStoreChange = store.onChange(() => {
    ensureLineSubscriptions();
    broadcastSnapshot();
  });

  const unsubscribeTelemetry = runtime.telemetry.onTelemetry((linkId, event) => {
    broadcast(
      {
        type: "telemetry",
        linkId,
        seq: nextSeq(),
        ...(event.header !== undefined ? { header: event.header } : {}),
        ...(event.frame !== undefined ? { frame: event.frame } : {}),
      },
      { throttle: true },
    );
  });
  const unsubscribeNotice = runtime.telemetry.onNotice((linkId, message) => {
    sendNotice(linkId, "info", message);
  });

  // -----------------------------------------------------------------
  // Flash orchestration (module doc comment's own section)
  // -----------------------------------------------------------------

  const inFlightFlashes = new Set<Promise<void>>();

  function setFlashPhase(linkId: string, source: FirmwareSourceRef, phase: FlashPhase, identity: FlashIdentity = UI_FLASH_IDENTITY): void {
    flashStateByLink.set(linkId, {
      source,
      phase,
      origin: identity.origin,
      ...(identity.caller !== undefined ? { caller: identity.caller } : {}),
    });
    // The `flash-progress` broadcast itself carries no identity -- see
    // `wsMessages.ts`'s `SnapshotLink.flash` doc comment: attribution
    // rides the `Snapshot` overlay (`overlayLink`, above), not this
    // per-stage push, which stays byte-for-byte the same message shape
    // it was before this ticket.
    broadcast({ type: "flash-progress", linkId, source, phase, seq: nextSeq() });
  }

  /** Structural subset of {@link FlashOutcome} (the USB path,
   * `flash.ts`) and {@link MbflashOutcome} (the network path,
   * `connect/mbflashClient.ts`) -- ticket 018-014: both now feed the
   * same `finishFlash` broadcast, and neither's own extra fields
   * (`method`, `reason`) are ever part of the wire contract anyway (see
   * this module's own doc comment, "Flash orchestration has no
   * `DeviceRegistry`..."), so `finishFlash`/`failFlash` only need this
   * narrower shape, which both outcome types already satisfy
   * structurally. */
  type FlashResultLike = { status: "ok" } | { status: "error"; error: string };

  function finishFlash(linkId: string, source: FirmwareSourceRef, outcome: FlashResultLike): void {
    flashStateByLink.delete(linkId);
    broadcast(
      outcome.status === "ok"
        ? { type: "flash-result", linkId, source, status: "ok", seq: nextSeq() }
        : { type: "flash-result", linkId, source, status: "error", message: outcome.error, seq: nextSeq() },
    );
  }

  function failFlash(linkId: string, source: FirmwareSourceRef, message: string): void {
    flashStateByLink.delete(linkId);
    broadcast({ type: "flash-result", linkId, source, status: "error", message, seq: nextSeq() });
  }

  /** Ticket 018-014: the network-flash counterpart to `flasher.flash`
   * (the USB path's own board_owner-guarded call). Closes any session
   * this host itself has open on `linkId` first -- the farm host's own
   * single-client mbserial bridge is what actually arbitrates
   * concurrent access (reported back as `ERR busy`, not fought over
   * here) -- runs the flash, and (only on success) walks the link
   * through `resetting`/`reidentifying` and asks the reconciler to
   * reopen it, best-effort: the flash itself already succeeded
   * regardless of whether this particular reopen attempt lands, and a
   * later mDNS/reconciler pass would pick the freshly-rebooted board
   * back up on its own either way. */
  async function runNetworkFlashTask(
    linkId: string,
    source: FirmwareSourceRef,
    device: ProjectionDeviceRow,
    service: ProjectionServiceRow,
    hexText: string,
    identity: FlashIdentity = UI_FLASH_IDENTITY,
  ): Promise<FlashResultLike> {
    await runtime.reconciler.requestClose(linkId);

    // `service.host`/`service.port` are `string | null`/`number | null`
    // on `ProjectionServiceRow` in general, but `runFlashTask` (this
    // function's only caller) already refused to call this function at
    // all when either was `null` -- see its own `findCurrentMbflashService`
    // check just above where `networkTarget` is assigned.
    const outcome = await flashOverMbflashFn(
      { host: service.host as string, port: service.port as number },
      Buffer.from(hexText, "utf-8"),
      () => setFlashPhase(linkId, source, "writing", identity),
    );
    if (outcome.status !== "ok") {
      return outcome;
    }

    setFlashPhase(linkId, source, "resetting", identity);
    setFlashPhase(linkId, source, "reidentifying", identity);
    try {
      await runtime.reconciler.requestOpen(linkId);
    } catch (error) {
      // Best-effort -- see this function's own doc comment. The flash
      // itself already succeeded; a failed reopen is not reported as a
      // flash failure, only surfaced as a notice so the stakeholder
      // knows to reconnect "${device.name}" by hand if it doesn't come
      // back on its own.
      sendNotice(linkId, "info", `flashed "${device.name}" successfully, but reopening its session afterward failed: ${errorMessage(error)}`);
    }
    return { status: "ok" };
  }

  /** The body of one `flash-start` task -- see the module doc comment's
   * "Flash orchestration" section. Never throws/rejects: every failure
   * is reported as a `flash-result` `status: "error"`, matching the
   * retired `deviceRegistry.ts#runFlash`'s own "failure is a value"
   * contract. `startServer.close()` awaits every such task (via
   * {@link inFlightFlashes}) before returning, so a flash in progress at
   * shutdown finishes (and closes its DAPLink/HID handle, or the
   * `mbflashClient.ts` TCP socket, via each path's own `finally`) before
   * the process exits.
   *
   * Ticket 018-014: routes by transport once the target link resolves.
   * A `usb` link keeps the exact pre-existing path (`flasher.flash`,
   * board_owner-guarded); a `mbserial`/`wifi` link whose device has a
   * current `_mbflash._tcp` service (`findCurrentMbflashService`) routes
   * to {@link runNetworkFlashTask} instead. Any other transport (or a
   * mbserial/wifi device with no current flash service) fails plainly,
   * same as the old USB-only check did. Either way, the hex
   * fetch/verify step below (release vs. local-hex) is shared verbatim
   * — this ticket adds a second *destination* for the same bytes, not a
   * second way to obtain them. */
  async function runFlashTask(linkId: string, source: FirmwareSourceRef, identity: FlashIdentity = UI_FLASH_IDENTITY): Promise<void> {
    setFlashPhase(linkId, source, source.kind === "release" ? "fetching" : "verifying", identity);
    try {
      const rows = store.projectionRows();
      const linkRow = rows.links.find((candidate) => candidate.id === linkId);
      if (!linkRow) {
        failFlash(linkId, source, `link "${linkId}" no longer exists`);
        return;
      }

      let usbTarget: { usbSerial: string; device: DaplinkDevice } | undefined;
      let networkTarget: { device: ProjectionDeviceRow; service: ProjectionServiceRow } | undefined;

      if (linkRow.transport === "usb") {
        const usbSerial = usbSerialFromLinkId(linkId);
        if (usbSerial === undefined) {
          failFlash(linkId, source, `link "${linkId}" does not follow the "usb-<serial>" id convention`);
          return;
        }
        const devices = await enumerateDaplinkDevicesFn();
        const device = devices.find((candidate) => candidate.serialNumber === usbSerial);
        if (!device) {
          failFlash(linkId, source, `no USB device is currently enumerated for link "${linkId}" -- is it still plugged in?`);
          return;
        }
        usbTarget = { usbSerial, device };
      } else if (linkRow.transport === "mbserial" || linkRow.transport === "wifi") {
        const deviceRow = linkRow.deviceId !== null ? rows.devices.find((candidate) => candidate.id === linkRow.deviceId) : undefined;
        if (!deviceRow) {
          failFlash(linkId, source, `link "${linkId}" has no identified device to flash`);
          return;
        }
        const service = findCurrentMbflashService(rows.services, deviceRow);
        if (!service || service.host === null || service.port === null) {
          failFlash(
            linkId,
            source,
            `no _mbflash._tcp service is currently advertised for "${deviceRow.name}" -- this robot cannot be flashed over the network right now`,
          );
          return;
        }
        networkTarget = { device: deviceRow, service };
      } else {
        failFlash(
          linkId,
          source,
          `flashing requires a directly attached USB link or a network-flashable mbserial/wifi link (link "${linkId}" is ${linkRow.transport})`,
        );
        return;
      }

      let hexText: string;
      if (source.kind === "release") {
        const firmwareSource = firmwareConfig[source.firmware];
        if (!firmwareSource) {
          failFlash(linkId, source, `no firmware source configured for "${source.firmware}"`);
          return;
        }
        if (firmwareSource.kind === "local-file") {
          // Configured as a path rather than a repo (out-of-process,
          // 2026-09-16): the build is already on this machine's disk,
          // so there is no release to resolve and nothing to download.
          // Straight to "verifying" -- `localFirmware.ts` explains why
          // that step is a structural hex check here rather than the
          // sha256-against-manifest comparison a release gets.
          setFlashPhase(linkId, source, "verifying", identity);
          const local = await readLocalHexFn(firmwareSource);
          if ("reason" in local) {
            failFlash(linkId, source, local.message);
            return;
          }
          hexText = local.hex.toString("utf-8");
        } else {
          const resolved = await resolveReleaseFn(firmwareSource);
          if ("reason" in resolved) {
            failFlash(linkId, source, resolved.message);
            return;
          }
          setFlashPhase(linkId, source, "verifying", identity);
          const fetched = await fetchAndVerifyHexFn(resolved);
          if ("error" in fetched) {
            failFlash(linkId, source, fetched.error);
            return;
          }
          hexText = fetched.hex.toString("utf-8");
        }
      } else {
        const uploaded = localHexUpload.consumeUpload(source.uploadId);
        if (uploaded === undefined) {
          failFlash(
            linkId,
            source,
            `no pending local-hex upload found for id ${source.uploadId} -- it may have expired, ` +
              `already been used, or never completed the upload handshake`,
          );
          return;
        }
        hexText = uploaded.toString("utf-8");
      }

      if (usbTarget) {
        const outcome = await flasher.flash(linkId, usbTarget.usbSerial, usbTarget.device, hexText, (phase) =>
          setFlashPhase(linkId, source, phase, identity),
        );
        finishFlash(linkId, source, outcome);
        return;
      }

      // `networkTarget` is always set here: the transport check above
      // returns early unless exactly one of `usbTarget`/`networkTarget`
      // was assigned.
      const outcome = await runNetworkFlashTask(linkId, source, networkTarget!.device, networkTarget!.service, hexText, identity);
      finishFlash(linkId, source, outcome);
    } catch (error) {
      failFlash(linkId, source, errorMessage(error));
    }
  }

  function handleFlashStart(linkId: string, source: FirmwareSourceRef, identity: FlashIdentity = UI_FLASH_IDENTITY): void {
    const task = runFlashTask(linkId, source, identity);
    inFlightFlashes.add(task);
    void task.finally(() => inFlightFlashes.delete(task));
  }

  // -----------------------------------------------------------------
  // WiFi provisioning -- WIFICRED SET <slot> <ssid> <password>, then a
  // query, waiting for the robot's own reply. Salvaged from the retired
  // deviceRegistry.ts#provisionWifi (same wire choreography), now
  // reached via runtime.reconciler.sessions instead of a registry.
  // -----------------------------------------------------------------

  function requireSession(linkId: string): ConnectedSession {
    return requireOpenSession(runtime.reconciler.sessions, linkId);
  }

  async function provisionWifiOverLink(
    session: ConnectedSession,
    slot: number,
    ssid: string,
    password: string,
  ): Promise<{ ok: boolean; message: string }> {
    const link = session.link;
    const replyPromise = new Promise<{ verb: string; fields: readonly string[] } | undefined>((resolve) => {
      const timer = setTimeout(() => {
        unsubscribe();
        resolve(undefined);
      }, wifiProvisionTimeoutMs);
      timer.unref?.();
      const unsubscribe = link.onLine((decoded) => {
        if (decoded.verb === "wificred" || decoded.verb === "err") {
          clearTimeout(timer);
          unsubscribe();
          resolve({ verb: decoded.verb, fields: decoded.fields });
        }
      });
    });

    try {
      const setLine = link.sendCommand("WIFICRED", ["SET", slot, ssid, password]);
      const redacted = setLine.replace(/\n$/, "").replace(password, "•".repeat(Math.min(8, password.length)));
      broadcast({ type: "line", linkId: session.linkId, direction: "tx", line: redacted, seq: nextSeq() }, { throttle: true });
      const queryLine = link.sendCommand("WIFICRED", []);
      broadcast({ type: "line", linkId: session.linkId, direction: "tx", line: queryLine.replace(/\n$/, ""), seq: nextSeq() }, { throttle: true });
    } catch (error) {
      return { ok: false, message: errorMessage(error) };
    }

    const answer = await replyPromise;
    if (!answer) {
      return { ok: false, message: "the robot did not confirm within a few seconds -- is it running a build with WiFi support?" };
    }
    if (answer.verb === "err") {
      return { ok: false, message: `the robot rejected the request (err ${answer.fields.join(" ")})` };
    }
    // Field order differs between extension builds -- accept either.
    const [replySlot, second, third] = answer.fields;
    const replySsid = second === ssid ? second : third;
    const hasPassword = second === ssid ? third : second;
    if (replySlot !== String(slot) || replySsid !== ssid) {
      return { ok: false, message: `the robot answered for a different slot or network (${answer.fields.join(" ")})` };
    }
    if (password.length > 0 && hasPassword !== "1") {
      return { ok: false, message: "the robot stored the network name but not the password" };
    }
    return { ok: true, message: `wrote ${ssid} to slot ${slot} -- power-cycle the robot and it will join` };
  }

  // -----------------------------------------------------------------
  // Client command dispatch -- a Map<type, handler>, each awaited with
  // its own try/catch (ticket 005's own Description).
  // -----------------------------------------------------------------

  type Handler = (ws: WebSocketLike, message: ClientMessage) => Promise<void>;

  const handlers = new Map<ClientMessage["type"], Handler>();

  handlers.set("session-open", async (_ws, message) => {
    if (message.type !== "session-open") {
      return;
    }
    // Sprint 019 ticket 005: the actual open (both the plain `{linkId}`
    // form and the `{relayLinkId, name}` relay-bridge form -- ticket 008;
    // SUC-009) is `connect/sessionOps.ts`'s own `openSession`, the same
    // WS-independent function `mcp/tools/connect.ts`'s `open_session`
    // tool calls -- see that module's own doc comment for the full
    // bridge-resolution rationale this handler used to carry inline.
    // This wrapper's only remaining job is the WS-specific "never
    // silent" notice (bench defect 4, 2026-09-12): a refused open must
    // surface on the console rather than nothing happening.
    const params: OpenSessionParams = "linkId" in message ? { linkId: message.linkId } : { relayLinkId: message.relayLinkId, name: message.name };
    const { linkId, refusedReason } = await openSession({ store, reconciler: runtime.reconciler }, params);
    if (refusedReason !== undefined) {
      sendNotice(linkId, "warn", `connect refused: ${refusedReason}`);
    }
  });

  handlers.set("session-close", async (_ws, message) => {
    if (message.type !== "session-close") {
      return;
    }
    await closeSession({ reconciler: runtime.reconciler }, message.linkId);
  });

  handlers.set("line", async (_ws, message) => {
    if (message.type !== "line") {
      return;
    }
    const session = requireSession(message.linkId);
    const verb = message.line.trim().split(/\s+/)[0];
    if (verb !== undefined && verb.toUpperCase() === "HELLO") {
      // HELLO's disciplined resync path (the retired registry's own
      // resyncSession) has no equivalent yet on connect/harvester.ts's
      // seam -- reject clearly rather than desyncing the session by
      // sending it as a raw line.
      throw new Error('"HELLO" cannot be sent as a raw line -- close and reopen the link instead');
    }
    noteStudentStatus(session, verb);
    session.link.sendLine(message.line);
    broadcast({ type: "line", linkId: message.linkId, direction: "tx", line: message.line, seq: nextSeq() }, { throttle: true });
  });

  handlers.set("send-command", async (_ws, message) => {
    if (message.type !== "send-command") {
      return;
    }
    const session = requireSession(message.linkId);
    // Sprint 019 ticket 005: the actual send is `connect/sessionOps.ts`'s
    // own WS-independent `sendCommand` -- the same function `mcp/tools/
    // connect.ts`'s `send_command` tool calls for any verb it allows
    // through its own gated-motion-verb check. This wrapper still owns
    // the two things that are specifically WS-console concerns:
    // `noteStudentStatus`'s "Show status polls" bookkeeping (018-009) and
    // broadcasting the sent line to the console's own transcript.
    noteStudentStatus(session, message.verb);
    const fields = message.fields ?? [];
    const sent = sharedSendCommand(session, message.verb, fields);
    broadcast({ type: "line", linkId: message.linkId, direction: "tx", line: sent.replace(/\n$/, ""), seq: nextSeq() }, { throttle: true });
  });

  handlers.set("flash-start", async (_ws, message) => {
    if (message.type !== "flash-start") {
      return;
    }
    handleFlashStart(message.linkId, message.source);
  });

  handlers.set("flash-local-begin", async (ws, message) => {
    if (message.type !== "flash-local-begin") {
      return;
    }
    const result = localHexUpload.beginUpload({
      fileName: message.fileName,
      byteLength: message.byteLength,
      sha256: message.sha256,
    });
    if (ws.readyState !== WS_OPEN) {
      return;
    }
    // Unicast to the requester alone -- an upload handshake is
    // inherently per-client, unlike a state-change notice everyone
    // should see.
    ws.send(
      JSON.stringify(
        "error" in result
          ? ({ type: "notice", level: "error", text: result.error, at: Date.now(), seq: nextSeq() } satisfies ServerMessage)
          : ({ type: "flash-local-ready", uploadId: result.uploadId, seq: nextSeq() } satisfies ServerMessage),
      ),
    );
  });

  handlers.set("forget-device", async (_ws, message) => {
    if (message.type !== "forget-device") {
      return;
    }
    store.deleteDevice(message.deviceId);
  });

  handlers.set("set-radio-override", async (_ws, message) => {
    if (message.type !== "set-radio-override") {
      return;
    }
    if ("clear" in message) {
      store.clearRadioOverride(message.deviceId);
      return;
    }
    // Range/integer validation lives once, host-side, in radioOverride.ts
    // (ticket 006's own acceptance criterion: invalid input is rejected
    // with a notice, never written) -- wsMessages.ts's parseClientMessage
    // only narrows the wire shape, per that type's own doc comment.
    if (!isValidRadioOverride(message.channel, message.group)) {
      sendNotice(
        undefined,
        "warn",
        `invalid radio override for device ${message.deviceId}: channel must be an integer 0-83 and group an integer 0-255 (got channel=${message.channel}, group=${message.group})`,
      );
      return;
    }
    store.setRadioOverride(message.deviceId, message.channel, message.group);
  });

  handlers.set("get-wifi-credentials", async (ws, message) => {
    if (message.type !== "get-wifi-credentials") {
      return;
    }
    const described = wifiCredentials.describe();
    const revealed = message.reveal ? wifiCredentials.read()?.password : undefined;
    if (ws.readyState === WS_OPEN) {
      ws.send(
        JSON.stringify({
          type: "wifi-credentials",
          ...described,
          ...(revealed !== undefined ? { password: revealed } : {}),
          seq: nextSeq(),
        } satisfies ServerMessage),
      );
    }
  });

  handlers.set("set-wifi-credentials", async (ws, message) => {
    if (message.type !== "set-wifi-credentials") {
      return;
    }
    wifiCredentials.write(message.ssid, message.password);
    if (ws.readyState === WS_OPEN) {
      ws.send(JSON.stringify({ type: "wifi-credentials", ...wifiCredentials.describe(), seq: nextSeq() } satisfies ServerMessage));
    }
  });

  handlers.set("provision-wifi", async (ws, message) => {
    if (message.type !== "provision-wifi") {
      return;
    }
    const linkId = message.linkId;
    const reply = (result: { ok: boolean; message: string }): void => {
      // Unicast to the requester -- mirrors the retired
      // deviceRegistry.ts-backed server.ts, which answered
      // provision-wifi to the one socket that asked, not every
      // connected console.
      if (ws.readyState === WS_OPEN) {
        ws.send(JSON.stringify({ type: "wifi-provision-result", linkId, ...result, seq: nextSeq() } satisfies ServerMessage));
      }
    };
    const credentials = wifiCredentials.read();
    if (!credentials) {
      reply({ ok: false, message: "no WiFi network is stored yet -- enter one first" });
      return;
    }
    if (/\s/.test(credentials.ssid) || /\s/.test(credentials.password)) {
      reply({ ok: false, message: "the network name and password cannot contain spaces (the wire splits on them)" });
      return;
    }
    const session = requireSession(linkId);
    const result = await provisionWifiOverLink(session, message.slot ?? 0, credentials.ssid, credentials.password);
    reply(result);
  });

  async function dispatch(ws: WebSocketLike, message: ClientMessage): Promise<void> {
    const handler = handlers.get(message.type);
    if (!handler) {
      return;
    }
    try {
      await handler(ws, message);
    } catch (error) {
      const linkId = "linkId" in message ? message.linkId : undefined;
      sendNotice(linkId, "error", errorMessage(error));
    }
  }

  // -----------------------------------------------------------------
  // WebSocket lifecycle
  // -----------------------------------------------------------------

  wss.on("connection", (ws) => {
    clients.add(ws);

    // Ticket 005 AC: a socket that emits "error" is dropped, not the
    // process -- registering a listener at all is what stops Node's
    // EventEmitter from throwing an unhandled "error" event.
    ws.on("error", () => {
      clients.delete(ws);
    });
    ws.on("close", () => {
      clients.delete(ws);
    });

    ws.send(JSON.stringify(buildCurrentSnapshot() satisfies ServerMessage));

    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        const result = localHexUpload.receiveFrame(toBuffer(data));
        if ("error" in result && ws.readyState === WS_OPEN) {
          ws.send(JSON.stringify({ type: "notice", level: "error", text: result.error, at: Date.now(), seq: nextSeq() } satisfies ServerMessage));
        }
        return;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(data.toString());
      } catch {
        // Unicast, not broadcast -- a malformed message is this one
        // client's own encoding mistake, not something every connected
        // console needs to see (mirrors the retired server.ts's own
        // direct `ws.send` for this same case).
        if (ws.readyState === WS_OPEN) {
          ws.send(JSON.stringify({ type: "notice", level: "error", text: "malformed JSON message", at: Date.now(), seq: nextSeq() } satisfies ServerMessage));
        }
        return;
      }
      const message = parseClientMessage(parsed);
      if (!message) {
        if (ws.readyState === WS_OPEN) {
          ws.send(
            JSON.stringify({ type: "notice", level: "error", text: "unrecognized message shape", at: Date.now(), seq: nextSeq() } satisfies ServerMessage),
          );
        }
        return;
      }
      void dispatch(ws, message);
    });
  });

  try {
    await listen(httpServer, port, host);
  } catch (error) {
    unsubscribeStoreChange();
    unsubscribeTelemetry();
    unsubscribeNotice();
    wss.close(() => {});
    throw error;
  }

  const address = httpServer.address();
  const actualPort = address && typeof address === "object" ? address.port : port;

  return {
    port: actualPort,
    host,
    url: `http://${host}:${actualPort}`,
    close: async () => {
      unsubscribeStoreChange();
      unsubscribeTelemetry();
      unsubscribeNotice();
      // Stop accepting new connections/commands immediately (bounding
      // how long the drain below can run for), but do not yet sever
      // already-open clients -- they can still observe a final
      // flash-progress/flash-result broadcast while any in-flight flash
      // finishes (or fails) naturally, closing its DAPLink/HID handle
      // via flash.ts's own `finally` -- ticket 005's own signal-handling
      // acceptance criterion: SIGINT/SIGTERM mid-flash must not
      // interrupt the write. `wss.close()` only stops new upgrade
      // requests when (as here) it wraps an externally-owned
      // `httpServer` -- that server is closed separately, below.
      //
      // Bench finding (015-011): this call is deliberately fire-and-
      // forget, not awaited. `ws`'s own `WebSocketServer.prototype.close`
      // (real `ws`, not this file's `fakeWebSocketServer` test double)
      // only fires its callback once `this.clients.size === 0` -- for an
      // externally-owned `httpServer` (this file's own case) it does
      // *not* forcibly drop existing clients itself, it just waits for
      // them to already be gone. Awaiting that callback here, before the
      // `client.terminate()` loop below ever runs, deadlocks forever the
      // moment any real client is still connected (a live browser tab,
      // never `fakeWebSocketServer`'s always-immediate mock -- which is
      // why every existing test missed this). The new-upgrade-listener
      // removal this call performs happens synchronously inside `close()`
      // itself, before it ever touches `clients.size`, so nothing
      // downstream actually depends on its callback firing.
      wss.close(() => {});
      await Promise.allSettled([...inFlightFlashes]);
      for (const client of clients) {
        client.terminate();
      }
      clients.clear();
      await new Promise<void>((resolve, reject) => {
        httpServer.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
