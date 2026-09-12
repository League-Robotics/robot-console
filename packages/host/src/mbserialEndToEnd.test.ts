/**
 * mbserialEndToEnd.test.ts — sprint 016 ticket 006's own verification
 * half: does an mbserial-discovered owned robot actually connect, take a
 * `send-command`, and close, driven through the REAL `mdnsWatcher`/
 * `reconciler`/`connector`/`server` stack, rather than each module's own
 * unit-level fake?
 *
 * Ticket's own wording: "an integration-style test with a fake mDNS
 * backend advertising `_mbserial._tcp` for an owned robot + a loopback
 * `net.createServer` (port 0, closed in `afterEach`) speaking the v6 line
 * protocol enough for identify + one command round trip, driven through
 * the real reconciler/connector -- proving `session-open`/`send-command`/
 * `session-close` work end to end."
 *
 * Only two seams are fake here: the mDNS backend (no real multicast
 * socket -- mirrors every other watcher suite's own discipline) and the
 * WebSocket transport (`server.ts`'s own injectable seam, mirrors
 * `server.test.ts`'s own fakes). Everything else -- `Store`,
 * `connect/connector.ts`'s default real `tcpStream`, `connect/reconciler.ts`,
 * `watchers/mdnsWatcher.ts`, and `server.ts` itself -- is the real,
 * production-wired implementation. The "robot" on the other end of the
 * wire is a real `net.createServer` on loopback, port 0, closed in
 * `afterEach` (never a real remote port, never real serial/HID).
 *
 * The `send-command` round trip uses `STOP` (a sequenced, id-bearing verb
 * per protocol.md's 11-verb list) rather than an unsequenced probe like
 * `PING`: a well-formed reply is reply-direction wire traffic, dispatched
 * via `LineLink`'s `onLine`/`onAckNack` (which update the real
 * `@robot-console/protocol` `Session`'s own `seq`/`lastDone` bookkeeping),
 * not `onRawLine` -- `onRawLine` (what `server.ts`'s own console-echo
 * subscription forwards to the client as an `rx` line) only ever carries
 * foreign/unrouted/malformed lines, per `LineLink.handleRawLine`'s own
 * dispatch rules. Reading the session's own `lastDone` directly (via
 * `reconciler.sessions.get(linkId)!.link.session`) is therefore the
 * faithful way to observe a full round trip here, no harvester wiring
 * needed.
 *
 * This is what confirms (or corrects) sprint.md's Architecture Step 1
 * reading that mbserial "already works end to end as a side effect of
 * sprint 015's generic connector/reconciler" -- sprint 015's own bench
 * ticket never actually opened a session over an mbserial link, only
 * observed the discovered row (Step 7 Open Question 1). This ticket does
 * NOT do a live bench pass against real `gopiv`/`tigez` hardware --
 * ticket 008 owns the bench; this is the fake-mDNS-backed alternative
 * the ticket's own acceptance criterion explicitly allows ("Real-hardware
 * or fake-mDNS-backed test").
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer, type Server, type Socket } from "node:net";
import { openStoreDb } from "./store/db.js";
import { Store } from "./store/index.js";
import { createConnector } from "./connect/connector.js";
import { startReconciler, type Reconciler } from "./connect/reconciler.js";
import { startMdnsWatcher, type MdnsWatcherHandle } from "./watchers/mdnsWatcher.js";
import { realScheduler } from "./link/pacing.js";
import { startServer, type RunningServer, type StartServerOptions, type WebSocketLike, type WebSocketServerLike } from "./server.js";
import type { MdnsBackend, MdnsBrowser, MdnsFindOptions, MdnsService } from "./discovery/mdnsDiscovery.js";
import type { ServerMessage } from "./wsMessages.js";

// ---------------------------------------------------------------------
// Fakes -- mDNS backend and WebSocket transport only (module doc
// comment). Mirrors server.test.ts's own fakeWebSocket/fakeWebSocketServer
// and watchers/mdnsWatcher.test.ts's own fakeBrowser, kept self-contained
// here rather than imported so this file's own real-stack composition
// stays the only thing a reader needs to follow.
// ---------------------------------------------------------------------

type Listener = (...args: unknown[]) => void;

function fakeWebSocket(): WebSocketLike & { emit: (event: string, ...args: unknown[]) => void; sent: ServerMessage[] } {
  const listeners = new Map<string, Listener[]>();
  const sent: ServerMessage[] = [];
  const ws: WebSocketLike & { emit: (event: string, ...args: unknown[]) => void; sent: ServerMessage[] } = {
    readyState: 1, // OPEN
    bufferedAmount: 0,
    send(data: string): void {
      sent.push(JSON.parse(data) as ServerMessage);
    },
    terminate(): void {
      (ws as { readyState: number }).readyState = 3; // CLOSED
    },
    on(event: string, listener: Listener): void {
      const existing = listeners.get(event) ?? [];
      existing.push(listener);
      listeners.set(event, existing);
    },
    emit(event: string, ...args: unknown[]): void {
      for (const listener of listeners.get(event) ?? []) {
        listener(...args);
      }
    },
    sent,
  };
  return ws;
}

function fakeWebSocketServer(): WebSocketServerLike & { triggerConnection: (ws: WebSocketLike) => void } {
  const connectionListeners: Array<(ws: WebSocketLike) => void> = [];
  return {
    on(event: string, listener: (...args: unknown[]) => void): void {
      if (event === "connection") {
        connectionListeners.push(listener as (ws: WebSocketLike) => void);
      }
    },
    close(callback: (err?: Error) => void): void {
      callback();
    },
    triggerConnection(ws: WebSocketLike): void {
      for (const listener of connectionListeners) {
        listener(ws);
      }
    },
  };
}

function fakeMdnsBrowser(): MdnsBrowser & { emitUp: (service: MdnsService) => void } {
  const upListeners: Array<(service: MdnsService) => void> = [];
  return {
    on(event, listener) {
      if (event === "up") {
        upListeners.push(listener);
      }
    },
    stop() {
      // no-op -- nothing to tear down for a fully synthetic browser.
    },
    update() {
      // no-op -- this suite never exercises the re-query tick.
    },
    emitUp(service: MdnsService): void {
      for (const listener of upListeners) {
        listener(service);
      }
    },
  };
}

/** Routes only `_mbserial._tcp` to a distinguishable fake browser; every
 * other browsed type gets its own inert fake (never emits) so
 * `startMdnsWatcher`'s subscribe-to-all-five-types wiring has something
 * structurally valid to subscribe to. */
function fakeMdnsBackend(): MdnsBackend & { mbserial: ReturnType<typeof fakeMdnsBrowser> } {
  const mbserial = fakeMdnsBrowser();
  return {
    find(options: MdnsFindOptions): MdnsBrowser {
      return options.type === "mbserial" ? mbserial : fakeMdnsBrowser();
    },
    destroy() {
      // no-op
    },
    mbserial,
  };
}

/** Waits for the server's coalesced change-feed flush (`setImmediate`)
 * plus any microtask chain it schedules -- same technique as
 * `server.test.ts`'s own `flush()`. */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(() => setImmediate(resolve)));
}

/** Polls `predicate` on a real (short) interval until it is true, or
 * throws once `timeoutMs` elapses. Needed throughout this file:
 * `flush()`'s two `setImmediate` hops drain microtasks/one macrotask,
 * which is enough for the in-memory Store's own change-feed but not for
 * a REAL TCP connect + write + read round trip against the loopback fake
 * robot below (`session-open`'s connect, and `send-command`'s reply). */
async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("waitFor: condition was not met within the timeout");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

// ---------------------------------------------------------------------
// The fake robot: a real loopback `net.createServer`, port 0, speaking
// just enough of the v6 line protocol for identify (HELLO -> banner) and
// one unsequenced command round trip (PING -> pong) -- mirrors
// `link/adapters/tcpStream.test.ts`'s own "real loopback socket" section
// and `connect/connector.test.ts`'s own `BannerByteStream` banner fixture,
// applied to a real socket instead of a fake ByteStream.
// ---------------------------------------------------------------------

/** `device NEZHA2 robot vevov 1198504156` -- `connect/connector.test.ts`'s
 * own space-form robot fixture; `deviceIdToName(1198504156) === "vevov"`. */
const ROBOT_NAME = "vevov";
const ROBOT_SERIAL = 1198504156;
const ROBOT_BANNER = "device NEZHA2 robot vevov 1198504156";

function startFakeMbserialRobot(): { server: Server; port: Promise<number>; sockets: Set<Socket> } {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let buffer = "";
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf-8");
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (line.startsWith("HELLO")) {
          socket.write(`${ROBOT_BANNER}\n`);
        } else {
          // A sequenced command carries a bare `#<id>` suffix
          // (protocol.md S2.2); this fixture answers the one command this
          // suite ever sends (`STOP`, no fields) with a matching `ack`.
          const stopMatch = /^STOP #(\d+)$/.exec(line);
          if (stopMatch) {
            // lastDone=7 is a deliberately distinctive, nonzero value --
            // `Session.lastDone` is `0` "until the first ack/nack ever
            // arrives" (session.ts's own doc comment), so this is what
            // the test below actually observes changing, unlike `seq`
            // (already `1` immediately after `connect()`'s own `HELLO`,
            // before any command is ever sent).
            socket.write(`ack ${stopMatch[1]} 7 none\n`);
          }
        }
        newlineIndex = buffer.indexOf("\n");
      }
    });
  });
  const port = new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address !== null ? address.port : 0);
    });
  });
  return { server, port, sockets };
}

// ---------------------------------------------------------------------
// Harness -- real Store/connector/reconciler/mdnsWatcher/server, torn
// down in afterEach.
// ---------------------------------------------------------------------

interface Harness {
  dir: string;
  store: Store;
  reconciler: Reconciler;
  mdnsWatcher: MdnsWatcherHandle;
  backend: ReturnType<typeof fakeMdnsBackend>;
  wss: ReturnType<typeof fakeWebSocketServer>;
  server: RunningServer;
  robot: ReturnType<typeof startFakeMbserialRobot>;
  robotPort: number;
}

async function harness(): Promise<Harness> {
  const dir = mkdtempSync(path.join(tmpdir(), "robot-console-mbserial-e2e-"));
  const store = new Store(openStoreDb({ filePath: path.join(dir, "console.sqlite") }));

  const robot = startFakeMbserialRobot();
  const robotPort = await robot.port;

  // Real connector -- no createTcpStream override, so this exercises the
  // production default (`link/adapters/tcpStream.ts`'s real `net.connect`)
  // against the loopback fake robot above, not a fake ByteStream.
  const connector = createConnector(store, { scheduler: realScheduler, now: () => Date.now() });
  const reconciler = startReconciler(store, { connector, now: () => Date.now(), tickIntervalMs: 1_000_000 });

  const backend = fakeMdnsBackend();
  const mdnsWatcher = startMdnsWatcher(store, { backend, now: () => Date.now() }, { requeryIntervalMs: 1_000_000 });

  const wss = fakeWebSocketServer();
  const server = await startServer({
    store,
    runtime: {
      reconciler,
      telemetry: {
        onTelemetry: () => () => {},
        onNotice: () => () => {},
      },
    },
    port: 0,
    createWebSocketServer: () => wss,
    firmwareConfig: { relay: undefined, robot: undefined },
    availabilityCache: {
      current: () => ({ relay: { configured: false }, robot: { configured: false } }),
      onChange: () => () => {},
      start: () => {},
      stop: () => {},
      pollOnce: async () => ({ relay: { configured: false }, robot: { configured: false } }),
    } as unknown as StartServerOptions["availabilityCache"],
  });

  return { dir, store, reconciler, mdnsWatcher, backend, wss, server, robot, robotPort };
}

const harnesses: Harness[] = [];

afterEach(async () => {
  while (harnesses.length > 0) {
    const h = harnesses.pop();
    if (!h) {
      continue;
    }
    await h.server.close();
    h.mdnsWatcher.stop();
    h.reconciler.stop();
    for (const socket of h.robot.sockets) {
      socket.destroy();
    }
    await new Promise<void>((resolve) => h.robot.server.close(() => resolve()));
    h.store.close();
    rmSync(h.dir, { recursive: true, force: true });
  }
});

describe("mbserial end to end (sprint 016 ticket 006): fake mDNS + real loopback TCP, real reconciler/connector/server", () => {
  it("an owned robot discovered over _mbserial._tcp connects via session-open, exchanges a send-command round trip, and closes cleanly via session-close", async () => {
    const h = await harness();
    harnesses.push(h);

    // Seed the owned device BEFORE the mDNS observation, so mdnsWatcher's
    // uniqueOwnedDeviceIdByName (module doc comment: "exactly one owned
    // device") finds it and links the fresh mbserial link to it
    // immediately, exactly as it would for a robot the console already
    // knows about.
    h.store.upsertDevice({ id: ROBOT_SERIAL, name: ROBOT_NAME, kind: "robot", at: 1 });
    h.store.setOwned(ROBOT_SERIAL, true, 1);

    h.backend.mbserial.emitUp({ name: ROBOT_NAME, host: "127.0.0.1", port: h.robotPort });

    const linkId = `mbserial-${ROBOT_NAME}`;
    const linkedRow = h.store.snapshotRows().links.find((l) => l.id === linkId);
    expect(linkedRow?.device_id).toBe(ROBOT_SERIAL); // sanity: mdnsWatcher's own linking rule fired

    const ws = fakeWebSocket();
    h.wss.triggerConnection(ws);
    await flush();

    // session-open {linkId} -- server.ts forwards this verbatim to
    // runtime.reconciler.requestOpen, which (planUserOpen) issues a
    // "connect" job regardless of the link's 'discovered' state (an
    // explicit ask is not gated on 'connectable' the way plan()'s
    // automatic pass is -- reconciler.ts's own planUserOpen doc comment).
    ws.emit("message", Buffer.from(JSON.stringify({ type: "session-open", linkId })), false);
    // A real TCP connect + HELLO/banner round trip against the loopback
    // fake robot -- flush()'s two setImmediate hops are not enough to
    // settle it (see waitFor's own doc comment).
    await waitFor(() => h.store.snapshotRows().links.find((l) => l.id === linkId)?.state === "connected");
    await flush();

    const linkAfterOpen = h.store.snapshotRows().links.find((l) => l.id === linkId);
    expect(linkAfterOpen?.state).toBe("connected");
    expect(h.store.snapshotRows().sessions.find((s) => s.link_id === linkId)).toBeDefined();
    expect(h.reconciler.sessions.get(linkId)?.deviceId).toBe(ROBOT_SERIAL);

    // send-command -- a sequenced verb (STOP, one of protocol.md's 11
    // id-bearing verbs) so the fake robot's `ack` reply exercises the
    // real wire-protocol Session's own seq bookkeeping
    // (`@robot-console/protocol`'s `Session.handleReply`), not just an
    // echoed line -- the strongest available proof, short of the console
    // wire itself, that a real command round trip happened. (`onRawLine`,
    // which server.ts's own console echo forwards to the client, only
    // ever carries foreign/unrouted/malformed lines -- a well-formed
    // `ack` is reply-direction and dispatched via `onLine`/`onAckNack`
    // instead, which server.ts does not forward for a generic
    // `send-command`; this suite reads the session's own `seq` directly.)
    const session = h.reconciler.sessions.get(linkId);
    expect(session?.link.session.lastDone).toBe(0);

    ws.emit(
      "message",
      Buffer.from(JSON.stringify({ type: "send-command", linkId, verb: "STOP", fields: [] })),
      false,
    );
    // A real round trip (write "STOP #1", read the fake robot's "ack 1 7
    // none" reply) -- poll for the Session's own lastDone update rather
    // than assuming flush() alone settles it.
    await waitFor(() => session?.link.session.lastDone === 7);
    await flush();

    expect(session?.link.session.lastDone).toBe(7);
    const lineMessages = ws.sent.filter((m): m is Extract<ServerMessage, { type: "line" }> => m.type === "line");
    expect(lineMessages.some((m) => m.direction === "tx" && m.line.startsWith("STOP"))).toBe(true);

    // session-close
    ws.emit("message", Buffer.from(JSON.stringify({ type: "session-close", linkId })), false);
    await waitFor(() => h.reconciler.sessions.get(linkId) === undefined);
    await flush();

    expect(h.reconciler.sessions.get(linkId)).toBeUndefined();
    const linkAfterClose = h.store.snapshotRows().links.find((l) => l.id === linkId);
    expect(linkAfterClose?.state).toBe("closed_by_user");
  });
});
