/**
 * supervisor.ts — an always-running front process that owns the public
 * port, serves the built UI itself, and runs the real host only while a
 * console window is actually connected.
 *
 * ## Why a supervisor at all
 *
 * The host holds USB relays, serial ports and WiFi robot slots for as
 * long as it runs. Installed as a service (Linux packaging), a host that
 * ran forever would keep those ports away from everything else on the
 * machine (MakeCode, another console) even with no window open. The
 * supervisor keeps the URL stable and the page instant, and turns the
 * host into an on-demand child:
 *
 *   - HTTP (the UI's static files, SPA fallback) is served here, so a
 *     window loads even while the host is stopped.
 *   - Every WebSocket upgrade is piped as raw bytes to the host's own
 *     port. The first one starts the host; the upgrade is held until the
 *     host's port accepts, or answered `503` after the start timeout.
 *   - When the last proxied socket closes, an idle timer starts; if no
 *     socket arrives before it fires the host is SIGTERMed. A page
 *     reload reconnects well within the grace, so it never restarts the
 *     host.
 *   - A host that dies while in use (clients connected, or disconnected
 *     within the idle grace -- the dying host's sockets may close before
 *     its exit is reported) is restarted with capped exponential
 *     backoff; the UI's own reconnect loop picks it back up. A host that
 *     dies while idle is only recorded.
 *
 * ## Why raw socket piping rather than a `ws` proxy
 *
 * The supervisor never needs to understand a frame. Writing the client's
 * upgrade request through to the host and piping both sockets keeps the
 * host's own `ws` server (its `maxPayload`, per-message handling, close
 * codes) the single authority on the protocol, and costs no re-framing.
 *
 * ## `GET /api/host-info` is answered here, not proxied (merge note)
 *
 * `server.ts`'s `/api/host-info` (sprint 021) is the one identity
 * contract other robot-console-aware tools rely on: `daemon/cli.ts`'s
 * `EADDRINUSE`-attach decision, and (as of this merge) `AppHeader`'s own
 * running-version display both probe it. Before this route existed here,
 * the supervisor's plain-HTTP fallback answered any unrecognized GET
 * (this one included) with the SPA's `index.html` -- so either of those
 * probes, pointed at a supervisor-fronted install, saw a 200 with an
 * unparseable body and concluded nothing was running. Proxying to the
 * host child would not fully fix that either: the whole point of the
 * host being stopped while idle is that there is no child to proxy to,
 * and "is a robot-console service listening here" is true of the
 * supervisor itself regardless of whether its child happens to be up
 * right now. So this answers directly, from what the supervisor already
 * knows (its own public port, {@link getHostVersion}) -- same shape
 * `server.ts` returns, independent of {@link HostState}.
 */

import { existsSync } from "node:fs";
import http, { type IncomingMessage, type Server } from "node:http";
import net, { type Socket } from "node:net";
import type { Duplex } from "node:stream";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { HostProcess, type HostExitInfo, type HostProcessOptions, type HostState } from "./hostProcess.js";
import { getHostVersion } from "../hostVersion.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** `packages/host/{src,dist}/supervisor/` -> `packages/ui/dist`. */
export function defaultUiDir(): string {
  return path.resolve(__dirname, "../../../ui/dist");
}

/** `packages/host/{src,dist}/supervisor/` -> `bin/robot-console.js`. */
export function defaultHostBin(): string {
  return path.resolve(__dirname, "../../../../bin/robot-console.js");
}

/** Path prefix the supervisor keeps for itself (never proxied, never
 * SPA-fallback). */
export const SUPERVISOR_PATH_PREFIX = "/__supervisor/";

export interface SupervisorStatus {
  hostState: HostState;
  hostPid: number | null;
  /** Open proxied WebSocket connections. */
  connections: number;
  /** Upgrades currently held waiting for the host to become ready. */
  pendingUpgrades: number;
  /** Time until an idle stop, or `null` when no idle timer is running. */
  idleMsRemaining: number | null;
  /** Unexpected-exit restarts performed since the supervisor started. */
  restarts: number;
  lastExit: { code: number | null; signal: string | null; at: number; expected: boolean } | null;
}

export interface SupervisorOptions {
  /** Public port. `0` picks an ephemeral one (tests). */
  port: number;
  /** Public bind address. Defaults to `127.0.0.1`. */
  bindAddress?: string;
  /** Port the host child listens on. */
  hostPort: number;
  /** Host argv (`command[0]` is the executable). */
  hostCommand: readonly string[];
  /** Env for the host child, already stripped/overridden by the caller. */
  hostEnv: NodeJS.ProcessEnv;
  /** Directory of the built UI. */
  uiDir: string;
  /** Grace after the last disconnect before stopping the host. */
  idleMs: number;
  /** How long an upgrade is held waiting for the host. */
  startTimeoutMs: number;
  /** SIGTERM -> SIGKILL grace when stopping the host. */
  killTimeoutMs: number;
  /** First restart delay after an unexpected exit; doubles per crash. */
  restartBackoffInitialMs?: number;
  /** Cap on the restart delay. */
  restartBackoffMaxMs?: number;
  /** A host that ran this long before crashing resets the backoff. */
  restartBackoffResetMs?: number;
  /** A host exit this soon after the last disconnect still counts as
   * "in use" (its own sockets may close before its exit is reported).
   * Defaults to 2000 ms. */
  crashDisconnectWindowMs?: number;
  /** Readiness probe interval. */
  readyPollMs?: number;
  log?: (line: string) => void;
  /** Test seams forwarded to {@link HostProcess}. */
  spawn?: HostProcessOptions["spawn"];
}

export interface RunningSupervisor {
  readonly port: number;
  readonly url: string;
  status(): SupervisorStatus;
  /** Stop accepting, stop the host (waiting up to the kill timeout),
   * drop every remaining socket. Idempotent. */
  close(): Promise<void>;
}

function listen(server: Server, port: number, address: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      server.off("listening", onListening);
      reject(
        error.code === "EADDRINUSE"
          ? new Error(`port ${port} is already in use on ${address} -- is another robot-console already running?`)
          : error,
      );
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, address);
  });
}

/** Answer a held upgrade with a bare HTTP status and close it. */
function rejectUpgrade(socket: Duplex, status: number, reason: string): void {
  if (!socket.destroyed) {
    socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    setTimeout(() => socket.destroy(), 1000).unref();
  }
}

/** Re-serialize the upgrade request exactly as received. */
function serializeRequestHead(req: IncomingMessage): string {
  let head = `${req.method ?? "GET"} ${req.url ?? "/"} HTTP/${req.httpVersion}\r\n`;
  for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) {
    head += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
  }
  return `${head}\r\n`;
}

function buildApp(uiDir: string, status: () => SupervisorStatus, getPort: () => number): express.Express {
  const app = express();
  app.disable("x-powered-by");
  app.get(`${SUPERVISOR_PATH_PREFIX}status`, (_req, res) => {
    res.set("Cache-Control", "no-store").json(status());
  });
  app.use(SUPERVISOR_PATH_PREFIX, (_req, res) => {
    res.status(404).type("text/plain").send("not found\n");
  });
  // See this module's own doc comment, "`GET /api/host-info` is answered
  // here, not proxied" -- mounted unconditionally, ahead of the
  // static/SPA catch-all below, exactly like `server.ts`'s own route.
  app.get("/api/host-info", (_req, res) => {
    const version = getHostVersion();
    res.json({ ok: true, service: "robot-console", port: getPort(), ...(version !== undefined ? { version } : {}) });
  });
  // Same static + SPA-fallback shape as the host's own server.ts, so a
  // deep link (e.g. /robot/abc) loads identically through either.
  if (existsSync(uiDir)) {
    app.use(express.static(uiDir));
    app.get(/.*/, (_req, res) => {
      res.sendFile(path.join(uiDir, "index.html"));
    });
  } else {
    app.get(/.*/, (_req, res) => {
      res
        .status(200)
        .type("text/plain")
        .send(`robot-console supervisor is running, but the UI has not been built (no ${uiDir}).\n`);
    });
  }
  return app;
}

export async function startSupervisor(options: SupervisorOptions): Promise<RunningSupervisor> {
  const log = options.log ?? ((line: string) => console.log(`robot-console-supervisor: ${line}`));
  const bindAddress = options.bindAddress ?? "127.0.0.1";
  const backoffInitial = options.restartBackoffInitialMs ?? 1000;
  const backoffMax = options.restartBackoffMaxMs ?? 30_000;
  const backoffReset = options.restartBackoffResetMs ?? 60_000;

  let connections = 0;
  let pendingUpgrades = 0;
  let restarts = 0;
  let nextBackoff = backoffInitial;
  let idleTimer: NodeJS.Timeout | null = null;
  let idleDeadline = 0;
  let restartTimer: NodeJS.Timeout | null = null;
  let lastExit: SupervisorStatus["lastExit"] = null;
  let lastDisconnectAt = Number.NEGATIVE_INFINITY;
  const crashDisconnectWindowMs = options.crashDisconnectWindowMs ?? 2000;
  let closing: Promise<void> | null = null;
  const liveSockets = new Set<Duplex>();
  const pendingAborts = new Set<AbortController>();

  const clearIdle = () => {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  };
  const clearRestart = () => {
    if (restartTimer) {
      clearTimeout(restartTimer);
      restartTimer = null;
    }
  };

  const host = new HostProcess({
    command: options.hostCommand,
    env: options.hostEnv,
    port: options.hostPort,
    killTimeoutMs: options.killTimeoutMs,
    log,
    onExit: (info) => onHostExit(info),
    ...(options.readyPollMs !== undefined ? { readyPollMs: options.readyPollMs } : {}),
    ...(options.spawn ? { spawn: options.spawn } : {}),
  });

  /** The one place start/idle-stop decisions are made; called after
   * every change in demand or host state. */
  function reconcile(): void {
    if (closing) {
      return;
    }
    const demand = connections + pendingUpgrades;
    if (demand > 0) {
      clearIdle();
      // A scheduled crash restart owns the next start (backoff).
      if (host.state === "stopped" && !restartTimer) {
        host.start();
      }
      return;
    }
    if ((host.state !== "stopped" || restartTimer) && !idleTimer) {
      idleDeadline = Date.now() + options.idleMs;
      log(`no connections -- stopping host in ${options.idleMs} ms unless a window reconnects`);
      idleTimer = setTimeout(() => {
        idleTimer = null;
        if (closing || connections + pendingUpgrades > 0) {
          return;
        }
        clearRestart();
        void host.stop();
      }, options.idleMs);
    }
  }

  function onHostExit(info: HostExitInfo): void {
    lastExit = { code: info.code, signal: info.signal, at: info.at, expected: info.expected };
    if (closing) {
      return;
    }
    if (info.expected) {
      // Demand may have arrived while it was stopping.
      reconcile();
      return;
    }
    // A crashing host closes its sockets itself, and those closes can be
    // processed before the exit is -- so a disconnect just before the
    // exit still counts as "in use".
    const inUse = connections + pendingUpgrades > 0 || Date.now() - lastDisconnectAt <= crashDisconnectWindowMs;
    if (!inUse) {
      log("host exited while idle -- not restarting");
      clearIdle();
      return;
    }
    if (info.ranForMs !== null && info.ranForMs >= backoffReset) {
      nextBackoff = backoffInitial;
    }
    const delay = nextBackoff;
    nextBackoff = Math.min(nextBackoff * 2, backoffMax);
    log(`restarting host in ${delay} ms`);
    clearRestart();
    restartTimer = setTimeout(() => {
      restartTimer = null;
      if (closing || host.state !== "stopped") {
        return;
      }
      restarts += 1;
      host.start();
    }, delay);
  }

  const status = (): SupervisorStatus => ({
    hostState: host.state,
    hostPid: host.pid,
    connections,
    pendingUpgrades,
    idleMsRemaining: idleTimer ? Math.max(0, idleDeadline - Date.now()) : null,
    restarts,
    lastExit,
  });

  // `/api/host-info` must report the actual bound port, not the
  // requested one -- `options.port` can be `0` (an ephemeral port;
  // `supervisor.test.ts`'s own harness always requests one), whose real
  // value is only known once `listen()` resolves, below. This mirrors
  // `server.ts`'s own `getBoundPort` box for the identical reason.
  let boundPort = options.port;
  const getBoundPort = (): number => boundPort;
  const server = http.createServer(buildApp(options.uiDir, status, getBoundPort));

  server.on("upgrade", (req: IncomingMessage, client: Duplex, head: Buffer) => {
    void handleUpgrade(req, client, head);
  });

  async function handleUpgrade(req: IncomingMessage, client: Duplex, head: Buffer): Promise<void> {
    client.on("error", () => client.destroy());
    if (closing) {
      rejectUpgrade(client, 503, "Service Unavailable");
      return;
    }
    if ((req.url ?? "").startsWith(SUPERVISOR_PATH_PREFIX)) {
      rejectUpgrade(client, 404, "Not Found");
      return;
    }

    const abort = new AbortController();
    const onClientGone = () => abort.abort();
    client.once("close", onClientGone);
    pendingAborts.add(abort);
    pendingUpgrades += 1;
    reconcile();

    const ready = await host.waitUntilRunning(options.startTimeoutMs, abort.signal);
    pendingAborts.delete(abort);
    client.off("close", onClientGone);

    if (!ready || abort.signal.aborted || client.destroyed) {
      pendingUpgrades -= 1;
      if (!abort.signal.aborted && !client.destroyed) {
        log(`host not ready within ${options.startTimeoutMs} ms -- answering 503`);
      }
      rejectUpgrade(client, 503, "Service Unavailable");
      reconcile();
      return;
    }

    const upstream: Socket = net.connect({ port: options.hostPort, host: "127.0.0.1" });
    let settled = false;
    upstream.once("error", (error) => {
      if (!settled) {
        settled = true;
        pendingUpgrades -= 1;
        log(`could not reach host on port ${options.hostPort}: ${error.message}`);
        rejectUpgrade(client, 502, "Bad Gateway");
        reconcile();
      }
    });
    upstream.once("connect", () => {
      if (settled) {
        return;
      }
      settled = true;
      pendingUpgrades -= 1;
      if (client.destroyed || closing) {
        upstream.destroy();
        client.destroy();
        reconcile();
        return;
      }
      connections += 1;
      reconcile();

      upstream.setNoDelay(true);
      (client as Socket).setNoDelay?.(true);
      upstream.write(serializeRequestHead(req));
      if (head.length > 0) {
        upstream.write(head);
      }
      upstream.pipe(client);
      client.pipe(upstream);
      liveSockets.add(client);
      liveSockets.add(upstream);

      let counted = true;
      const teardown = () => {
        upstream.destroy();
        client.destroy();
        liveSockets.delete(client);
        liveSockets.delete(upstream);
        if (counted) {
          counted = false;
          connections -= 1;
          lastDisconnectAt = Date.now();
          reconcile();
        }
      };
      upstream.on("error", teardown);
      upstream.on("close", teardown);
      client.on("close", teardown);
    });
  }

  await listen(server, options.port, bindAddress);
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : options.port;
  boundPort = port;
  log(`listening on http://${bindAddress}:${port}/ (host port ${options.hostPort}, idle ${options.idleMs} ms)`);

  return {
    port,
    url: `http://${bindAddress}:${port}/`,
    status,
    close(): Promise<void> {
      if (closing) {
        return closing;
      }
      closing = (async () => {
        clearIdle();
        clearRestart();
        server.close();
        for (const abort of pendingAborts) {
          abort.abort();
        }
        await host.stop();
        for (const socket of liveSockets) {
          socket.destroy();
        }
        server.closeAllConnections();
        log("supervisor stopped");
      })();
      return closing;
    },
  };
}
