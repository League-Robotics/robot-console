/**
 * server.ts — transport to the UI (`docs/design/specification.md` §4.7).
 *
 * Express + `ws`: one WebSocket carries device-list updates and line
 * traffic to and from the browser (telemetry frames join this same
 * channel in sprint 4, not this one). Express itself serves the built
 * `packages/ui` output as static files. Sprint 2 (ticket 006) adds
 * flash-start/flash-progress/flash-result traffic and merges the
 * `FirmwareAvailabilityCache`'s current status into every `devices`
 * broadcast, joining the same channel and the same "no logic of its
 * own" contract described below.
 *
 * This module contains **no naming, framing, or sequencing logic of its
 * own** -- it only composes `deviceRegistry.ts` (itself a composition of
 * `devices.ts` + `swdName.ts` + `UsbSerialLink`) into
 * {@link ServerMessage}-shaped WebSocket traffic, per `wsMessages.ts`'s
 * shared contract. If a bug here looks like it needs new protocol
 * logic, that logic belongs in `@robot-console/protocol` or one of
 * `host`'s other modules instead -- see the ticket.
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
import { parseClientMessage, type DeviceListEntry, type DevicesMessage, type ServerMessage } from "./wsMessages.js";

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
  const registry = options.registry ?? new DeviceRegistry();
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

  /** Merge an already-computed device snapshot with the availability
   * cache's current status into one full-snapshot {@link DevicesMessage}
   * -- no new logic, per this module's own "composition only" contract. */
  function buildDevicesMessage(devices: DeviceListEntry[]): DevicesMessage {
    return { type: "devices", devices, firmwareStatus: availabilityCache.current() };
  }

  const unsubscribeDevices = registry.onDevicesChanged((devices) => {
    broadcast(buildDevicesMessage(devices));
  });
  const unsubscribeLine = registry.onLine((deviceId, direction, line) => {
    broadcast({ type: "line", deviceId, direction, line });
  });
  const unsubscribeError = registry.onError((deviceId, message) => {
    broadcast(deviceId !== undefined ? { type: "error", deviceId, message } : { type: "error", message });
  });
  const unsubscribeFlashProgress = registry.onFlashProgress((deviceId, firmware, phase) => {
    broadcast({ type: "flash-progress", deviceId, firmware, phase });
  });
  const unsubscribeFlashResult = registry.onFlashResult((deviceId, firmware, status, message) => {
    broadcast(
      message !== undefined
        ? { type: "flash-result", deviceId, firmware, status, message }
        : { type: "flash-result", deviceId, firmware, status },
    );
  });
  // The availability cache's own poll can change `firmwareStatus`
  // independently of any device attach/detach -- re-broadcast the
  // current device snapshot so the robot-firmware button can flip to
  // enabled with no user action, per the ticket's self-healing
  // requirement.
  const unsubscribeAvailability = availabilityCache.onChange(() => {
    broadcast(buildDevicesMessage(registry.snapshot()));
  });

  wss.on("connection", (ws) => {
    clients.add(ws);
    ws.send(JSON.stringify(buildDevicesMessage(registry.snapshot()) satisfies ServerMessage));

    ws.on("message", (data) => {
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
        case "open":
          void registry.requestOpen(message.deviceId);
          break;
        case "close":
          void registry.requestClose(message.deviceId);
          break;
        case "line":
          void registry.sendLine(message.deviceId, message.line);
          break;
        case "flash-start":
          void registry.requestFlash(message.deviceId, message.firmware);
          break;
      }
    });

    ws.on("close", () => {
      clients.delete(ws);
    });
  });

  registry.start();
  availabilityCache.start();
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
