/**
 * server.ts — transport to the UI (`docs/design/specification.md` §4.7).
 *
 * Express + `ws`: one WebSocket carries endpoint-list updates and line
 * traffic to and from the browser (telemetry frames join this same
 * channel in a later sprint). Express itself serves the built
 * `packages/ui` output as static files. This module merges the
 * `FirmwareAvailabilityCache`'s current status into every `endpoints`
 * broadcast, and wires flash-start/flash-progress/flash-result traffic,
 * all joining the same channel and the same "no logic of its own"
 * contract described below.
 *
 * This module contains **no naming, framing, or sequencing logic of its
 * own** -- it only composes `deviceRegistry.ts` (itself a composition of
 * `devices.ts` + `swdName.ts` + `classifyBanner` + `UsbSerialLink`) into
 * {@link ServerMessage}-shaped WebSocket traffic, per `wsMessages.ts`'s
 * shared contract. If a bug here looks like it needs new protocol
 * logic, that logic belongs in `@robot-console/protocol` or one of
 * `host`'s other modules instead -- see the ticket.
 *
 * Sprint 4 note: `flash-start`'s `source: FirmwareSourceRef` can name
 * either a configured release build (`kind: "release"`) or a
 * locally-uploaded hex (`kind: "local-hex"`) -- both are forwarded to
 * `registry.requestFlash(endpointId, source)` unchanged; `deviceRegistry
 * .ts#runFlash` is what branches on `source.kind` (see that module's own
 * doc comment), not this one, per this module's "no logic of its own"
 * contract. Ticket 005 also extends the `ws.on("message", ...)` handler
 * with an `isBinary` branch (`ws`'s message event carries `isBinary`
 * alongside the raw data): a binary frame is the local-hex upload's raw
 * bytes, routed straight to `localHexUpload.ts`'s `LocalHexUploadManager
 * #receiveFrame` with no further inspection; every other (text/JSON)
 * message continues through `JSON.parse`/`parseClientMessage` exactly as
 * before. Splitting the frame, verifying it, and holding the bytes is
 * `localHexUpload.ts`'s job -- this module only routes based on
 * `isBinary`, the same composition-only boundary as everything else
 * here. The one `LocalHexUploadManager` instance constructed per
 * {@link startServer} call is shared between that binary-frame handling
 * and the `DeviceRegistry`'s injected `consumeUpload` seam, so an
 * upload verified here is the very one `runFlash` consumes later.
 *
 * Sprint 6 ticket 003: `send-command` (a structured verb + optional
 * fields, alongside `line`'s raw text) forwards straight to
 * `registry.sendCommand` unchanged -- `deviceRegistry.ts` is what
 * decides sequenced-vs-unsequenced dispatch (`isSequencedVerb`) and
 * rejects `HELLO` outright, not this module, per its own "no logic of
 * its own" contract.
 *
 * **Localhost only.** This process can open serial ports, attach over
 * SWD, and (in later sprints) flash firmware and drive a physical
 * robot -- it must never be reachable from anything but the machine
 * it's running on. {@link startServer} binds to `127.0.0.1` by default
 * and does not accept a `0.0.0.0`-shaped override.
 */

import { createServer, type Server as HttpServer } from "node:http";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { WebSocket, WebSocketServer } from "ws";
import { DeviceRegistry } from "./deviceRegistry.js";
import { getFirmwareConfig, type FirmwareConfigMap } from "./config.js";
import { FirmwareAvailabilityCache } from "./releases.js";
import { LocalHexUploadManager } from "./localHexUpload.js";
import {
  parseClientMessage,
  type EndpointListEntry,
  type EndpointsMessage,
  type FlashResultMessage,
  type ServerMessage,
} from "./wsMessages.js";

/** Default port `npx robot-console` listens on. Override via
 * {@link StartServerOptions.port} (the `cli.ts` entry point also
 * accepts `--port`/`ROBOT_CONSOLE_PORT`). Chosen to be memorable and
 * unlikely to collide with common dev-server defaults (3000, 5173,
 * 8080, ...). */
export const DEFAULT_PORT = 4795;

/** Bind address. Deliberately not overridable to `0.0.0.0` or similar
 * -- see the module doc comment's "Localhost only" note. */
const DEFAULT_HOST = "127.0.0.1";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** `packages/host/src/server.ts` -> `packages/ui/dist`, the Vite build
 * output. Resolved relative to this module's own location (not
 * `process.cwd()`) so it works regardless of where `robot-console` is
 * invoked from. */
function defaultStaticDir(): string {
  return path.resolve(__dirname, "../../ui/dist");
}

export interface StartServerOptions {
  /** Port to listen on. Defaults to {@link DEFAULT_PORT}. */
  port?: number;
  /** Directory of the built UI to serve as static files. Defaults to
   * `packages/ui/dist`. If it does not exist (e.g. `packages/ui` has
   * not been built yet), the server still starts -- it serves a plain
   * status page instead of failing, since the WebSocket contract this
   * module provides does not itself depend on the UI being built. */
  staticDir?: string;
  /** Injectable {@link DeviceRegistry}; defaults to a real one (real
   * USB/HID/serial I/O). Tests substitute one built from fakes. */
  registry?: DeviceRegistry;
  /** Injectable firmware-source configuration (ticket 002); defaults to
   * a real call to {@link getFirmwareConfig} (real environment/dotconfig
   * `.env` parsing). Used to construct the default
   * {@link FirmwareAvailabilityCache} below -- ignored if
   * {@link StartServerOptions.availabilityCache} is passed directly. */
  firmwareConfig?: FirmwareConfigMap;
  /** Injectable {@link FirmwareAvailabilityCache}; defaults to one
   * constructed from {@link StartServerOptions.firmwareConfig}. Tests
   * substitute one built with a fake `checkAvailability` (mirroring how
   * {@link StartServerOptions.registry} substitutes fakes for
   * `DeviceRegistry`), so `pollOnce()`/`onChange` can be driven
   * deterministically with no real GitHub call. */
  availabilityCache?: FirmwareAvailabilityCache;
  /** Injectable {@link LocalHexUploadManager} (ticket 005); defaults to a
   * fresh instance per {@link startServer} call. Handles the
   * `flash-local-begin`/binary-frame half of the local-hex upload
   * handshake here, and -- when {@link StartServerOptions.registry} is
   * *not* also supplied -- is wired into the default {@link DeviceRegistry}'s
   * `consumeUpload` seam so the same verified upload a client sent over
   * this socket is what `runFlash` later consumes. A caller that
   * supplies its own `registry` is responsible for wiring that
   * registry's own `consumeUpload` to this same manager instance itself
   * (see `server.test.ts`'s local-hex tests) -- mirroring how
   * {@link StartServerOptions.firmwareConfig} is only consulted for the
   * *default* {@link FirmwareAvailabilityCache}. */
  localHexUpload?: LocalHexUploadManager;
}

export interface RunningServer {
  readonly port: number;
  readonly host: string;
  readonly url: string;
  /** Stop accepting connections, close every open WebSocket, and tear
   * down the underlying {@link DeviceRegistry} (closing any open device
   * links). */
  close(): Promise<void>;
}

function buildApp(staticDir: string): express.Express {
  const app = express();
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

/** Normalize `ws`'s `RawData` (a `Buffer`, an `ArrayBuffer`, or a
 * `Buffer[]` -- the last only when the client sent a fragmented message
 * and `ws` was configured not to reassemble it, which this server never
 * does) into one contiguous `Buffer`, for {@link LocalHexUploadManager
 * #receiveFrame} to split. */
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

/**
 * Start the Express/`ws` server: bind to localhost, serve the built UI
 * (if present), and bridge a {@link DeviceRegistry} to every connected
 * WebSocket client per `wsMessages.ts`'s contract.
 *
 * Rejects with a clear error (see {@link listen}) if the port is
 * already in use, rather than silently retrying on another port.
 */
export async function startServer(options: StartServerOptions = {}): Promise<RunningServer> {
  const host = DEFAULT_HOST;
  const port = options.port ?? DEFAULT_PORT;
  const staticDir = options.staticDir ?? defaultStaticDir();
  const localHexUpload = options.localHexUpload ?? new LocalHexUploadManager();
  // consumeUpload is wired only for the *default* registry, mirroring
  // firmwareConfig's own "only consulted for the default cache" pattern
  // just below -- a caller supplying its own `registry` must wire that
  // registry's `consumeUpload` to this same `localHexUpload` instance
  // itself (see StartServerOptions.localHexUpload's own doc comment).
  const registry =
    options.registry ??
    new DeviceRegistry({ consumeUpload: (uploadId) => localHexUpload.consumeUpload(uploadId) });
  const firmwareConfig = options.firmwareConfig ?? getFirmwareConfig();
  // `loadConfig` is passed only for the default (real) cache, and only
  // when the caller did not pin `firmwareConfig` itself: a host started
  // before `dotconfig load` wrote `.env` must still pick the file up,
  // within one poll interval, rather than reporting "not configured"
  // for the life of the process. A caller who supplied an explicit
  // config map meant that map, so it is left alone.
  const availabilityCache =
    options.availabilityCache ??
    new FirmwareAvailabilityCache(
      firmwareConfig,
      options.firmwareConfig === undefined ? { loadConfig: () => getFirmwareConfig() } : {},
    );

  const app = buildApp(staticDir);
  const httpServer = createServer(app);
  const wss = new WebSocketServer({ server: httpServer });
  // `ws`'s WebSocketServer re-emits the underlying http.Server's
  // "error" event (e.g. EADDRINUSE from the listen() call below) as
  // its own "error" event. Node's EventEmitter throws for an "error"
  // event with no listeners, so this must be handled even though the
  // actual rejection this function surfaces to its caller comes from
  // `listen()`'s own httpServer-level "error" listener, not from here.
  wss.on("error", () => {
    // Swallowed deliberately -- see comment above.
  });
  const clients = new Set<WebSocket>();

  function broadcast(message: ServerMessage): void {
    const payload = JSON.stringify(message);
    for (const client of clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    }
  }

  /** Merge an already-computed endpoint snapshot with the availability
   * cache's current status and the current remembered-robot roster into
   * one full-snapshot {@link EndpointsMessage} -- no new logic, per this
   * module's own "composition only" contract. `registry.rememberedRobots()`
   * (ticket 003) already excludes anything currently attached, so this
   * is a straight pass-through, same as `firmwareStatus` just above it.
   * Every call site below re-runs this function on every broadcast, so a
   * roster change from `requestForgetKnownRobot` (ticket 003's own
   * `emitDevices()` call) reaches every connected client on the very
   * next `onDevicesChanged` firing -- no separate event type needed. */
  function buildEndpointsMessage(endpoints: EndpointListEntry[]): EndpointsMessage {
    return {
      type: "endpoints",
      endpoints,
      firmwareStatus: availabilityCache.current(),
      rememberedRobots: registry.rememberedRobots(),
      // Sprint 8 ticket 004: registry.discoveredServices() is a straight
      // pass-through of MdnsDiscovery's own current() snapshot -- see
      // that method's own doc comment. registry.onDevicesChanged (which
      // every call site below is already subscribed to) re-fires on a
      // discovery change too (DeviceRegistry.start wires that), so this
      // reaches every connected client with no separate event type
      // needed, same as firmwareStatus/rememberedRobots just above.
      discoveredServices: registry.discoveredServices(),
    };
  }

  const unsubscribeDevices = registry.onDevicesChanged((endpoints) => {
    broadcast(buildEndpointsMessage(endpoints));
  });
  const unsubscribeLine = registry.onLine((endpointId, direction, line, origin) => {
    broadcast(
      origin
        ? { type: "line", endpointId, direction, line, origin }
        : { type: "line", endpointId, direction, line },
    );
  });
  const unsubscribeError = registry.onError((endpointId, message) => {
    broadcast(endpointId !== undefined ? { type: "error", endpointId, message } : { type: "error", message });
  });
  // deviceRegistry.ts (ticket 005) now carries the full FirmwareSourceRef
  // through requestFlash/runFlash itself -- every progress/result event
  // it emits already carries the exact `source` the client requested, so
  // this module just relays it straight through (no wrapping here
  // anymore, per this module's own "no logic of its own" contract).
  const unsubscribeFlashProgress = registry.onFlashProgress((endpointId, source, phase) => {
    broadcast({ type: "flash-progress", endpointId, source, phase });
  });
  const unsubscribeFlashResult = registry.onFlashResult(
    (endpointId, source, status, message, classification, name, reidentify) => {
      // classification/name/reidentify are only ever present on
      // registry.ts's own `status: "ok"` (ticket 004's reidentify
      // sequencing) -- omit each field rather than sending it
      // `undefined`, matching this module's existing `message` handling
      // just above.
      const result: FlashResultMessage = { type: "flash-result", endpointId, source, status };
      if (message !== undefined) {
        result.message = message;
      }
      if (classification !== undefined) {
        result.classification = classification;
      }
      if (name !== undefined) {
        result.name = name;
      }
      if (reidentify !== undefined) {
        result.reidentify = reidentify;
      }
      broadcast(result);
    },
  );
  // The availability cache's own poll can change `firmwareStatus`
  // independently of any device attach/detach -- re-broadcast the
  // current endpoint snapshot so the robot-firmware button can flip to
  // enabled with no user action, per the ticket's self-healing
  // requirement.
  const unsubscribeAvailability = availabilityCache.onChange(() => {
    broadcast(buildEndpointsMessage(registry.snapshot()));
  });

  wss.on("connection", (ws) => {
    clients.add(ws);
    ws.send(JSON.stringify(buildEndpointsMessage(registry.snapshot()) satisfies ServerMessage));

    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        // The local-hex upload handshake's binary half (see this
        // module's own doc comment and wsMessages.ts's convention):
        // uploadId (ASCII) || payload, with no JSON envelope at all --
        // splitting and verifying it is localHexUpload.ts's job, not
        // this module's.
        const result = localHexUpload.receiveFrame(toBuffer(data));
        if ("error" in result) {
          ws.send(JSON.stringify({ type: "error", message: result.error } satisfies ServerMessage));
        }
        // On success there is nothing to send back yet -- the client
        // already has the uploadId from flash-local-ready, and proceeds
        // straight to flash-start referencing it.
        return;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(data.toString());
      } catch {
        ws.send(
          JSON.stringify({ type: "error", message: "malformed JSON message" } satisfies ServerMessage),
        );
        return;
      }
      const message = parseClientMessage(parsed);
      if (!message) {
        ws.send(
          JSON.stringify({
            type: "error",
            message: "unrecognized message shape",
          } satisfies ServerMessage),
        );
        return;
      }
      switch (message.type) {
        case "session-open":
          // OOP 2026-09-09: `robotName` (reserved since sprint 4) is now
          // live -- forwarded to requestOpen as its `target` argument,
          // which routes through a relay endpoint's radio instead of a
          // plain USB open. `radio` only makes sense alongside
          // `robotName` (see wsMessages.ts's SessionOpenMessage doc
          // comment), so it rides along inside the same conditional
          // rather than being forwarded independently.
          //
          // Sprint 8 ticket 005: `autoRobot: true` (only ever sent
          // alongside no `robotName` -- RelayPage's Connect action with
          // the dropdown's placeholder selected) requests
          // `requestOpen`'s default-failover candidate list, reached by
          // passing an empty `target` object (`{}`) rather than a single
          // named one -- see `deviceRegistry.ts#requestOpen`'s own doc
          // comment for why `target` present-but-empty means "use the
          // default-failover list" instead of "open the endpoint's own
          // plain USB session" (the `else` branch below, taken only when
          // neither `robotName` nor `autoRobot` is set).
          if (message.robotName !== undefined) {
            void registry.requestOpen(message.endpointId, {
              robotName: message.robotName,
              ...(message.radio !== undefined ? { radio: message.radio } : {}),
            });
          } else if (message.autoRobot) {
            void registry.requestOpen(message.endpointId, {});
          } else {
            void registry.requestOpen(message.endpointId);
          }
          break;
        case "session-close":
          void registry.requestClose(message.endpointId);
          break;
        case "line":
          void registry.sendLine(message.endpointId, message.line);
          break;
        case "send-command":
          // Ticket 003: deviceRegistry.ts#sendCommand is what decides
          // sequenced-vs-unsequenced dispatch (via isSequencedVerb) and
          // rejects HELLO -- this module only routes, per its own "no
          // logic of its own" contract.
          void registry.sendCommand(message.endpointId, message.verb, message.fields ?? []);
          break;
        case "flash-start":
          // Both source kinds forward straight to requestFlash unchanged
          // -- deviceRegistry.ts#runFlash is what branches on
          // source.kind (see this module's own doc comment).
          void registry.requestFlash(message.endpointId, message.source);
          break;
        case "forget-known-robot":
          // Synchronous, and itself calls emitDevices() (ticket 003) --
          // the resulting broadcast picks up the updated
          // rememberedRobots roster via buildEndpointsMessage above, no
          // separate event type needed.
          registry.requestForgetKnownRobot(message.name);
          break;
        case "flash-local-begin": {
          const result = localHexUpload.beginUpload({
            fileName: message.fileName,
            byteLength: message.byteLength,
            sha256: message.sha256,
          });
          ws.send(
            JSON.stringify(
              "error" in result
                ? ({ type: "error", message: result.error } satisfies ServerMessage)
                : ({ type: "flash-local-ready", uploadId: result.uploadId } satisfies ServerMessage),
            ),
          );
          break;
        }
      }
    });

    ws.on("close", () => {
      clients.delete(ws);
    });
  });

  registry.start();
  availabilityCache.start();
  // `start()` only arms the `DEFAULT_AVAILABILITY_POLL_INTERVAL_MS`
  // interval timer -- without this, a freshly started host reports
  // every firmware kind as "not-yet-checked" (flash buttons disabled,
  // UI stuck on "Checking whether this firmware is available...") for
  // up to 5 minutes even when the firmware is actually available.
  // Mirrors `deviceRegistry.ts#start`'s `watcher.start(); void
  // watcher.pollOnce();` composition exactly: the interval owner starts
  // the timer, the caller composing it also fires one poll immediately.
  // The `onChange` subscription above (`unsubscribeAvailability`) is
  // already wired before this line, so this poll's result -- whether it
  // resolves before or after `listen()` below -- reaches every already
  // connected client via the normal broadcast path, not just future
  // connections. `void` is deliberate and matches the existing idiom
  // (this class's own interval callback, and `deviceRegistry.ts`'s
  // `pollOnce()` call, both fire-and-forget the same way): `pollOnce()`
  // never rejects in practice because `checkAvailability` (real or
  // test fake) reports network/API failures through its own `reason`
  // field rather than throwing, so there is no unhandled rejection to
  // guard against here.
  void availabilityCache.pollOnce();
  try {
    await listen(httpServer, port, host);
  } catch (error) {
    // Don't leak a running DeviceRegistry (device polling, and any link
    // it may have opened) or a live FirmwareAvailabilityCache poll timer
    // behind a server that failed to bind -- see the module doc
    // comment's port-busy requirement.
    unsubscribeDevices();
    unsubscribeLine();
    unsubscribeError();
    unsubscribeFlashProgress();
    unsubscribeFlashResult();
    unsubscribeAvailability();
    await registry.stop().catch(() => {});
    availabilityCache.stop();
    wss.close();
    throw error;
  }

  const address = httpServer.address();
  const actualPort = address && typeof address === "object" ? address.port : port;

  return {
    port: actualPort,
    host,
    url: `http://${host}:${actualPort}`,
    close: async () => {
      unsubscribeDevices();
      unsubscribeLine();
      unsubscribeError();
      unsubscribeFlashProgress();
      unsubscribeFlashResult();
      unsubscribeAvailability();
      availabilityCache.stop();
      for (const client of clients) {
        client.terminate();
      }
      clients.clear();
      await new Promise<void>((resolve, reject) => {
        wss.close((err) => (err ? reject(err) : resolve()));
      });
      await new Promise<void>((resolve, reject) => {
        httpServer.close((err) => (err ? reject(err) : resolve()));
      });
      await registry.stop();
    },
  };
}
