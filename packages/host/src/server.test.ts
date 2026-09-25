/**
 * server.test.ts — sprint 015 ticket 005's own suite for the rewritten
 * thin server. Every test drives a real, temp-file-backed `Store`
 * (so `buildSnapshotFromRows`/the change feed behave exactly as
 * production does) against a fake `runtime` (reconciler + telemetry) and
 * a fake `WebSocketServer`/`WebSocket` pair (`WebSocketServerLike`/
 * `WebSocketLike`, this module's own injectable seam) so per-socket
 * `error`/`bufferedAmount` behavior — this ticket's own acceptance
 * criteria — can be driven deterministically with no real network
 * connection. The HTTP layer underneath is real (bound to loopback,
 * closed in `afterEach`), which is what the port-busy test needs.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { WebSocket as RealWebSocket } from "ws";
import {
  startServer,
  DEFAULT_BUFFERED_AMOUNT_THRESHOLD_BYTES,
  DEFAULT_MAX_PAYLOAD_BYTES,
  PortInUseError,
  type MountRoutesExtra,
  type RunningServer,
  type ServerRuntime,
  type StartServerOptions,
  type WebSocketLike,
  type WebSocketServerLike,
} from "./server.js";
import { deviceIdToName, nameToRadioAddress } from "@robot-console/protocol";
import { openStoreDb } from "./store/db.js";
import { MBFLASH_SERVICE_TYPE, Store } from "./store/index.js";
import { MAX_UPLOAD_BYTE_LENGTH } from "./localHexUpload.js";
import { UPLOAD_ID_BYTE_LENGTH } from "./wsMessages.js";
import type { ConnectedSession } from "./connect/connector.js";
import type { HarvesterTelemetryEvent } from "./connect/harvester.js";
import type { Snapshot, ServerMessage, FirmwareSourceRef } from "./wsMessages.js";
import type { FlashOutcome } from "./flash.js";
import type { MbflashOutcome } from "./connect/mbflashClient.js";
import type { DaplinkDevice } from "./devices.js";
import type { MbregistryClient, RegistryDevice } from "./mbregistry/client.js";
import type { LocalFlashTarget, RemoteFlashTarget } from "./mbregistry/remoteFlash.js";

// ---------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------

type Listener = (...args: unknown[]) => void;

function fakeWebSocket(): WebSocketLike & { listeners: Map<string, Listener[]>; emit: (event: string, ...args: unknown[]) => void; sent: ServerMessage[] } {
  const listeners = new Map<string, Listener[]>();
  const sent: ServerMessage[] = [];
  const ws = {
    readyState: 1, // OPEN
    bufferedAmount: 0,
    listeners,
    send: vi.fn((data: string) => {
      sent.push(JSON.parse(data) as ServerMessage);
    }),
    terminate: vi.fn(() => {
      ws.readyState = 3; // CLOSED
    }),
    on: vi.fn((event: string, listener: Listener) => {
      const existing = listeners.get(event) ?? [];
      existing.push(listener);
      listeners.set(event, existing);
    }),
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
    on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      if (event === "connection") {
        connectionListeners.push(listener as (ws: WebSocketLike) => void);
      }
    }) as WebSocketServerLike["on"],
    close: vi.fn((callback: (err?: Error) => void) => callback()),
    triggerConnection(ws: WebSocketLike): void {
      for (const listener of connectionListeners) {
        listener(ws);
      }
    },
  };
}

function fakeLink(overrides: Partial<Record<string, unknown>> = {}) {
  const lineListeners: Array<(decoded: { verb: string; fields: readonly string[] }) => void> = [];
  const rawLineListeners: Array<(line: string) => void> = [];
  // Item G (team-lead, 2026-09-13): server.ts's console-echo subscription
  // reads `onInboundLine` now, not `onRawLine` -- see that method's own
  // doc comment on `LineLink`. This fake needs its own listener list so
  // `ensureLineSubscriptions` has a real function to call.
  const inboundLineListeners: Array<(line: string) => void> = [];
  return {
    sendLine: vi.fn(),
    sendCommand: vi.fn((verb: string, fields: readonly unknown[] = []) => `${verb} ${fields.join(" ")}\n`),
    sendUnsequenced: vi.fn((verb: string, fields: readonly unknown[] = []) => `${verb} ${fields.join(" ")}\n`),
    // 018-010: a student's own unsequenced query goes through
    // `sendUnsequencedQuery` (one bounded resend), not plain `sendUnsequenced`.
    sendUnsequencedQuery: vi.fn((verb: string, fields: readonly unknown[] = []) => `${verb} ${fields.join(" ")}\n`),
    hasPendingUnsequencedQuery: vi.fn(() => false),
    onLine: vi.fn((listener: (decoded: { verb: string; fields: readonly string[] }) => void) => {
      lineListeners.push(listener);
      return () => {
        const i = lineListeners.indexOf(listener);
        if (i >= 0) lineListeners.splice(i, 1);
      };
    }),
    onRawLine: vi.fn((listener: (line: string) => void) => {
      rawLineListeners.push(listener);
      return () => {
        const i = rawLineListeners.indexOf(listener);
        if (i >= 0) rawLineListeners.splice(i, 1);
      };
    }),
    onInboundLine: vi.fn((listener: (line: string) => void) => {
      inboundLineListeners.push(listener);
      return () => {
        const i = inboundLineListeners.indexOf(listener);
        if (i >= 0) inboundLineListeners.splice(i, 1);
      };
    }),
    close: vi.fn().mockResolvedValue(undefined),
    _emitLine: (decoded: { verb: string; fields: readonly string[] }) => {
      for (const l of lineListeners) l(decoded);
    },
    _emitRawLine: (line: string) => {
      for (const l of rawLineListeners) l(line);
    },
    _emitInboundLine: (line: string) => {
      for (const l of inboundLineListeners) l(line);
    },
    ...overrides,
  };
}

function fakeSession(linkId: string, overrides: Partial<Record<string, unknown>> = {}): ConnectedSession {
  return {
    linkId,
    deviceId: 1,
    transport: "usb",
    link: fakeLink() as unknown as ConnectedSession["link"],
    classification: { type: "robot" } as unknown as ConnectedSession["classification"],
    ...overrides,
  } as ConnectedSession;
}

function fakeRuntime() {
  const sessionsByLink = new Map<string, ConnectedSession>();
  const telemetryListeners = new Set<(linkId: string, event: HarvesterTelemetryEvent) => void>();
  const noticeListeners = new Set<(linkId: string, message: string) => void>();
  // Bench defect 4: the real reconciler.requestOpen resolves to
  // `{ refusedReason?: string }`, never bare `undefined` -- server.ts's
  // own session-open handler destructures `refusedReason` off the
  // result, so this fake must match that shape or every existing
  // session-open test here would throw on the destructure.
  const requestOpen = vi.fn().mockResolvedValue({});
  const requestClose = vi.fn().mockResolvedValue(undefined);

  const runtime: ServerRuntime & {
    sessionsByLink: Map<string, ConnectedSession>;
    emitTelemetry: (linkId: string, event: HarvesterTelemetryEvent) => void;
    emitNotice: (linkId: string, message: string) => void;
    requestOpen: typeof requestOpen;
    requestClose: typeof requestClose;
  } = {
    reconciler: {
      requestOpen,
      requestClose,
      sessions: {
        get: (linkId: string) => sessionsByLink.get(linkId),
        values: () => sessionsByLink.values(),
      },
      stop: vi.fn(),
    },
    telemetry: {
      onTelemetry: (listener) => {
        telemetryListeners.add(listener);
        return () => telemetryListeners.delete(listener);
      },
      onNotice: (listener) => {
        noticeListeners.add(listener);
        return () => noticeListeners.delete(listener);
      },
    },
    sessionsByLink,
    emitTelemetry: (linkId, event) => {
      for (const l of telemetryListeners) l(linkId, event);
    },
    emitNotice: (linkId, message) => {
      for (const l of noticeListeners) l(linkId, message);
    },
    requestOpen,
    requestClose,
  };
  return runtime;
}

function freshStore(): { store: Store; dir: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "robot-console-server-test-"));
  const store = new Store(openStoreDb({ filePath: path.join(dir, "console.sqlite") }));
  return { store, dir };
}

/** Waits for the change feed's coalesced flush (`setImmediate`) to run,
 * and for any microtask chain the resulting broadcast schedules. */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(() => setImmediate(resolve)));
}

/** Polls `predicate` on a real (short) interval until it is true, or
 * throws once `timeoutMs` elapses. Needed wherever a dispatched handler's
 * own async work involves a REAL network round trip (sprint 016 ticket
 * 006's registry test, below, against a real loopback HTTP server) --
 * unlike every other test in this file, that work does not settle within
 * `flush()`'s own two `setImmediate` hops (those only drain microtasks/
 * one macrotask, not a real socket connect + response). */
async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("waitFor: condition was not met within the timeout");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

interface Harness {
  server: RunningServer;
  store: Store;
  runtime: ReturnType<typeof fakeRuntime>;
  wss: ReturnType<typeof fakeWebSocketServer>;
  dir: string;
}

async function startTestServer(overrides: Partial<StartServerOptions> = {}): Promise<Harness> {
  const { store, dir } = freshStore();
  const runtime = fakeRuntime();
  const wss = fakeWebSocketServer();
  const server = await startServer({
    store,
    runtime,
    port: 0,
    createWebSocketServer: () => wss,
    firmwareConfig: { relay: undefined, robot: undefined },
    ...overrides,
  });
  return { server, store, runtime, wss, dir };
}

async function cleanup(h: Harness): Promise<void> {
  await h.server.close();
  h.store.close();
  rmSync(h.dir, { recursive: true, force: true });
}

const harnesses: Harness[] = [];
afterEach(async () => {
  while (harnesses.length > 0) {
    const h = harnesses.pop();
    if (h) {
      await cleanup(h);
    }
  }
});

async function harness(overrides: Partial<StartServerOptions> = {}): Promise<Harness> {
  const h = await startTestServer(overrides);
  harnesses.push(h);
  return h;
}

// ---------------------------------------------------------------------
// Binding
// ---------------------------------------------------------------------

describe("server.ts: binding", () => {
  it("021-002: binds 0.0.0.0 (every interface), not localhost only -- see server.ts's own DEFAULT_HOST doc comment for the accepted-risk framing", async () => {
    const h = await harness();
    expect(h.server.host).toBe("0.0.0.0");
    expect(h.server.url).toBe(`http://0.0.0.0:${h.server.port}`);
  });

  it("021-002: a client reaches the server via a non-loopback-looking address (127.0.0.1) even though it requested an ephemeral port on 0.0.0.0 -- a real second network interface is not guaranteed in CI, so this is the unit-test-level proxy for LAN reachability; the bench-level cross-subnet check is a separate, hardware-dependent verification", async () => {
    const h = await harness();
    const response = await fetch(`http://127.0.0.1:${h.server.port}/api/host-info`);
    expect(response.status).toBe(200);
    // `version` (added for the header's own version display) resolves
    // from this checkout's real package.json -- asserted as "some
    // string", not a hardcoded value that would need editing on every
    // version bump.
    expect(await response.json()).toEqual({ ok: true, service: "robot-console", port: h.server.port, version: expect.any(String) });
  });

  it("fails clearly, rather than silently picking another port, when the port is already in use", async () => {
    const blocker = createServer();
    // 021-002: the blocker must itself bind 0.0.0.0, matching what a real
    // second robot-console instance does (server.ts's own DEFAULT_HOST) --
    // a blocker bound only to 127.0.0.1 no longer reliably conflicts with
    // a 0.0.0.0 bind on this platform (verified: Node's default socket
    // options let a 0.0.0.0 bind coexist with an already-bound 127.0.0.1
    // socket on the same port, via SO_REUSEADDR), so this test would
    // otherwise pass for the wrong reason (or not at all).
    await new Promise<void>((resolve) => blocker.listen(0, "0.0.0.0", resolve));
    const address = blocker.address();
    const busyPort = address && typeof address === "object" ? address.port : 0;

    try {
      await expect(startTestServer({ port: busyPort })).rejects.toThrow(/already in use/);
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });

  it("021-001: rejects EADDRINUSE with a PortInUseError carrying {host, port}, not a plain Error", async () => {
    const blocker = createServer();
    // See the previous test's own comment -- the blocker binds 0.0.0.0
    // for the same reason.
    await new Promise<void>((resolve) => blocker.listen(0, "0.0.0.0", resolve));
    const address = blocker.address();
    const busyPort = address && typeof address === "object" ? address.port : 0;

    try {
      let caught: unknown;
      try {
        await startTestServer({ port: busyPort });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(PortInUseError);
      const portInUseError = caught as PortInUseError;
      expect(portInUseError.host).toBe("0.0.0.0");
      expect(portInUseError.port).toBe(busyPort);
      // The message text itself is unchanged from before this ticket --
      // cli.ts rethrows it verbatim for an explicit --port conflict.
      expect(portInUseError.message).toMatch(/already in use/);
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });

  // Sprint 018 ticket 006 / sprint.md's own explicit success criterion:
  // "Two robot-console instances can run on one machine on different
  // ports". `cli.ts`'s `--port`/`ROBOT_CONSOLE_PORT` resolution already
  // existed before this sprint; this is the first end-to-end regression
  // test confirming two concurrently `startServer`-run instances, each
  // with its own store, neither collide on their port nor leak state
  // into each other.
  it("two startServer calls on two different ports, each with its own store, run independently with no shared state", async () => {
    const h1 = await harness();
    const h2 = await harness();

    expect(h1.server.port).not.toBe(h2.server.port);
    expect(h1.store).not.toBe(h2.store);

    const name1 = deviceIdToName(1);
    const name2 = deviceIdToName(2);
    h1.store.upsertDevice({ id: 1, name: name1, kind: "robot", usbSerial: "SN1", at: 1 });
    h2.store.upsertDevice({ id: 2, name: name2, kind: "robot", usbSerial: "SN2", at: 1 });

    const names1 = h1.store.projectionRows().devices.map((d) => d.name);
    const names2 = h2.store.projectionRows().devices.map((d) => d.name);
    expect(names1).toEqual([name1]);
    expect(names2).toEqual([name2]);

    // Closing one instance never touches the other's own listener/store.
    await h1.server.close();
    h1.store.close();
    harnesses.splice(harnesses.indexOf(h1), 1);

    expect(h2.store.projectionRows().devices.map((d) => d.name)).toEqual([name2]);
    const stillUp = await fetch(h2.server.url).catch(() => undefined);
    expect(stillUp).toBeDefined();
  });
});

// ---------------------------------------------------------------------
// GET /api/host-info (sprint 021 ticket 001) -- the one small, additive
// identity contract cli.ts's own EADDRINUSE attach-vs-hard-fail decision
// (and later, the daemon CLI's status/start) needs. Mounted
// unconditionally, before the static-file/SPA catch-all, so it answers
// the same way whether or not packages/ui/dist exists.
// ---------------------------------------------------------------------

describe("server.ts: GET /api/host-info", () => {
  it("returns {ok: true, service: 'robot-console', port, version} when no built UI exists (the static-fallback branch)", async () => {
    const missingDir = path.join(tmpdir(), `robot-console-host-info-missing-ui-${Date.now()}`);
    const h = await harness({ staticDir: missingDir });

    const response = await fetch(`${h.server.url}/api/host-info`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, service: "robot-console", port: h.server.port, version: expect.any(String) });
  });

  it("returns the same shape, ahead of the SPA catch-all, when a built UI is present", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "robot-console-server-host-info-test-"));
    writeFileSync(path.join(dir, "index.html"), "<html>SPA</html>");
    try {
      const h = await harness({ staticDir: dir });

      const response = await fetch(`${h.server.url}/api/host-info`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toMatch(/application\/json/);
      expect(await response.json()).toEqual({ ok: true, service: "robot-console", port: h.server.port, version: expect.any(String) });

      // host-info is additive -- anything else still falls through to
      // the SPA catch-all, unchanged.
      const spaResponse = await fetch(`${h.server.url}/some/spa/route`);
      expect(await spaResponse.text()).toBe("<html>SPA</html>");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------
// mountRoutes -- sprint 019 ticket 004's own generic extension point
// (this module has no MCP-specific knowledge; `cli.ts` is what actually
// passes `startMcpServer` wrapped in this hook -- see `mcp/server.ts`).
// ---------------------------------------------------------------------

describe("server.ts: mountRoutes", () => {
  it("is invoked exactly once with this server's own Express app instance", async () => {
    const mountRoutesMock = vi.fn();
    await harness({ mountRoutes: mountRoutesMock });

    expect(mountRoutesMock).toHaveBeenCalledTimes(1);
    const app = mountRoutesMock.mock.calls[0]?.[0] as { get: unknown; post: unknown };
    expect(typeof app.get).toBe("function");
    expect(typeof app.post).toBe("function");
  });

  it("a route it registers wins over the static-file/SPA catch-all, even when a built UI is present", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "robot-console-server-mount-test-"));
    writeFileSync(path.join(dir, "index.html"), "<html>SPA</html>");
    try {
      const h = await harness({
        staticDir: dir,
        mountRoutes: (app) => {
          app.get("/probe", (_req, res) => {
            res.status(200).type("text/plain").send("PROBE-OK");
          });
        },
      });

      const probeResponse = await fetch(`${h.server.url}/probe`);
      expect(await probeResponse.text()).toBe("PROBE-OK");

      // The catch-all is still there for everything mountRoutes didn't
      // claim -- this hook adds a route, it does not replace the SPA.
      const rootResponse = await fetch(`${h.server.url}/`);
      expect(await rootResponse.text()).toContain("SPA");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("omitting mountRoutes changes nothing about existing behavior", async () => {
    const h = await harness();
    const response = await fetch(`${h.server.url}/`);
    expect(response.status).toBe(200);
  });
});

// ---------------------------------------------------------------------
// Snapshot broadcast -- AC1 (golden coalescing test) plus connect
// ---------------------------------------------------------------------

describe("server.ts: snapshot broadcast", () => {
  it("sends a snapshot built from the store on connect", async () => {
    const h = await harness();
    h.store.upsertDevice({ id: 1198504156, name: "vevov", kind: "robot", at: 1 });
    h.store.setOwned(1198504156, true, 1);
    await flush();

    const ws = fakeWebSocket();
    h.wss.triggerConnection(ws);

    expect(ws.sent).toHaveLength(1);
    const snapshot = ws.sent[0] as Snapshot;
    expect(snapshot.type).toBe("snapshot");
    expect(snapshot.devices.map((d) => d.name)).toEqual(["vevov"]);
  });

  it("golden test: a burst of ten store writes in one tick produces one snapshot broadcast, not ten", async () => {
    const h = await harness();
    const ws = fakeWebSocket();
    h.wss.triggerConnection(ws);
    await flush(); // let the startup firmware-availability poll's own broadcast (if any) land first
    ws.sent.length = 0; // clear the initial on-connect snapshot

    for (let i = 0; i < 10; i++) {
      h.store.upsertDevice({ id: 1198504156, name: "vevov", kind: "robot", role: `r${i}`, at: i + 1 });
    }
    await flush();

    const snapshots = ws.sent.filter((m) => m.type === "snapshot");
    expect(snapshots).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------
// AC2: a socket that errors does not crash the process
// ---------------------------------------------------------------------

describe("server.ts: per-socket error handling", () => {
  it("a socket that emits error is dropped from broadcast, not the process", async () => {
    const h = await harness();
    const ws = fakeWebSocket();
    h.wss.triggerConnection(ws);

    expect(() => ws.emit("error", new Error("boom"))).not.toThrow();

    // Dropped: a later broadcast (a store change) never reaches it, even
    // though nothing in this process crashed.
    ws.sent.length = 0;
    h.store.upsertDevice({ id: 1198504156, name: "vevov", kind: "robot", at: 1 });
    await flush();
    expect(ws.sent).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------
// AC3: bufferedAmount backpressure
// ---------------------------------------------------------------------

describe("server.ts: bufferedAmount backpressure", () => {
  it("a stalled client (bufferedAmount over threshold) stops receiving line/telemetry but still receives the next snapshot", async () => {
    const h = await harness();
    const ws = fakeWebSocket();
    h.wss.triggerConnection(ws);
    await flush(); // let the startup firmware-availability poll's own broadcast (if any) land first
    ws.sent.length = 0;
    ws.bufferedAmount = DEFAULT_BUFFERED_AMOUNT_THRESHOLD_BYTES + 1;

    h.runtime.emitTelemetry("usb-1", { frame: { x: "1" } });
    h.runtime.emitNotice("usb-1", "some notice"); // notices are never throttled either, but not under test here

    h.store.upsertDevice({ id: 1198504156, name: "vevov", kind: "robot", at: 1 });
    await flush();

    const types = ws.sent.map((m) => m.type);
    expect(types).not.toContain("telemetry");
    expect(types).toContain("snapshot");
  });
});

// ---------------------------------------------------------------------
// session-open / session-close forward to the reconciler
// ---------------------------------------------------------------------

describe("server.ts: session-open/session-close dispatch", () => {
  it("forwards a {linkId} session-open to reconciler.requestOpen", async () => {
    const h = await harness();
    const ws = fakeWebSocket();
    h.wss.triggerConnection(ws);

    ws.emit("message", Buffer.from(JSON.stringify({ type: "session-open", linkId: "usb-1" })), false);
    await flush();

    expect(h.runtime.requestOpen).toHaveBeenCalledWith("usb-1");
  });

  it(
    "bench defect 4 (2026-09-12): broadcasts a link-scoped notice when the reconciler refuses a {linkId} session-open",
    async () => {
      const h = await harness();
      h.runtime.requestOpen.mockResolvedValueOnce({ refusedReason: "this device is not owned yet -- claim it first" });
      const ws = fakeWebSocket();
      h.wss.triggerConnection(ws);
      ws.sent.length = 0;

      ws.emit("message", Buffer.from(JSON.stringify({ type: "session-open", linkId: "wifi-1" })), false);
      await flush();

      const notice = ws.sent.find((m) => m.type === "notice");
      expect(notice).toMatchObject({ type: "notice", level: "warn", linkId: "wifi-1" });
      expect((notice as { text: string }).text).toMatch(/not owned/);
    },
  );

  it("broadcasts no notice at all when the reconciler actually opens the link (the default fake resolves to {})", async () => {
    const h = await harness();
    const ws = fakeWebSocket();
    h.wss.triggerConnection(ws);
    ws.sent.length = 0;

    ws.emit("message", Buffer.from(JSON.stringify({ type: "session-open", linkId: "usb-1" })), false);
    await flush();

    expect(ws.sent.some((m) => m.type === "notice")).toBe(false);
  });

  it("forwards session-close to reconciler.requestClose", async () => {
    const h = await harness();
    const ws = fakeWebSocket();
    h.wss.triggerConnection(ws);

    ws.emit("message", Buffer.from(JSON.stringify({ type: "session-close", linkId: "usb-1" })), false);
    await flush();

    expect(h.runtime.requestClose).toHaveBeenCalledWith("usb-1");
  });

  it("creates a radio link for the named robot (name-derived address) and forwards its id to reconciler.requestOpen, as one job -- never a separate close", async () => {
    const h = await harness();
    const ws = fakeWebSocket();
    h.wss.triggerConnection(ws);
    await flush();

    ws.emit("message", Buffer.from(JSON.stringify({ type: "session-open", relayLinkId: "usb-RELAY", name: "vevov" })), false);
    await flush();

    const derived = nameToRadioAddress("vevov");
    const childLinkId = "radio-vevov-via-usb-RELAY";
    expect(h.runtime.requestOpen).toHaveBeenCalledWith(childLinkId);
    expect(h.runtime.requestOpen).toHaveBeenCalledTimes(1);
    expect(h.runtime.requestClose).not.toHaveBeenCalled();

    const link = h.store.snapshotRows().links.find((l) => l.id === childLinkId);
    expect(link).toMatchObject({ transport: "radio" });
    expect(JSON.parse(link!.address as string)).toEqual({
      relayLinkId: "usb-RELAY",
      channel: derived.channel,
      group: derived.group,
    });
  });

  it(
    "bench defect 4: broadcasts a link-scoped notice, addressed to the new radio child, when the reconciler refuses a {relayLinkId, name} bridge",
    async () => {
      const h = await harness();
      h.runtime.requestOpen.mockResolvedValueOnce({ refusedReason: "already connecting" });
      const ws = fakeWebSocket();
      h.wss.triggerConnection(ws);
      await flush();
      ws.sent.length = 0;

      ws.emit("message", Buffer.from(JSON.stringify({ type: "session-open", relayLinkId: "usb-RELAY", name: "vevov" })), false);
      await flush();

      const childLinkId = "radio-vevov-via-usb-RELAY";
      const notice = ws.sent.find((m) => m.type === "notice");
      expect(notice).toMatchObject({ type: "notice", level: "warn", linkId: childLinkId });
      expect((notice as { text: string }).text).toMatch(/already connecting/);
    },
  );

  it("uses the device's own stored radio override, when one exists, instead of the name-derived default", async () => {
    const h = await harness();
    h.store.upsertDevice({ id: 1198504156, name: "vevov", kind: "robot", at: 1 });
    h.store.setRadioOverride(1198504156, 41, 3);
    await flush();

    const ws = fakeWebSocket();
    h.wss.triggerConnection(ws);
    await flush();

    ws.emit("message", Buffer.from(JSON.stringify({ type: "session-open", relayLinkId: "usb-RELAY", name: "vevov" })), false);
    await flush();

    const childLinkId = "radio-vevov-via-usb-RELAY";
    expect(h.runtime.requestOpen).toHaveBeenCalledWith(childLinkId);
    const link = h.store.snapshotRows().links.find((l) => l.id === childLinkId);
    expect(JSON.parse(link!.address as string)).toEqual({ relayLinkId: "usb-RELAY", channel: 41, group: 3 });
  });

  it("reuses the same radio link row on a repeat bridge to the same name over the same relay, rather than accumulating a new row per attempt", async () => {
    const h = await harness();
    const ws = fakeWebSocket();
    h.wss.triggerConnection(ws);
    await flush();

    ws.emit("message", Buffer.from(JSON.stringify({ type: "session-open", relayLinkId: "usb-RELAY", name: "vevov" })), false);
    await flush();
    ws.emit("message", Buffer.from(JSON.stringify({ type: "session-open", relayLinkId: "usb-RELAY", name: "vevov" })), false);
    await flush();

    const radioLinks = h.store.snapshotRows().links.filter((l) => l.transport === "radio");
    expect(radioLinks).toHaveLength(1);
    expect(h.runtime.requestOpen).toHaveBeenCalledTimes(2);
  });

  it("sprint 016 ticket 004 (SUC-004): reuses an already-sighted link's own channel/group, not a re-derived default -- a takeover must bridge to the address the sweep already confirmed reachable", async () => {
    const h = await harness();
    const childLinkId = "radio-vevov-via-usb-RELAY";
    // Simulate `watchers/relaySweeper.ts` having already sighted "vevov"
    // over this relay -- a `links(radio)` row with a resolved address
    // that is deliberately NOT the name-derived default, so this test
    // actually distinguishes "reused" from "coincidentally identical".
    const derived = nameToRadioAddress("vevov");
    const sightedChannel = derived.channel === 1 ? 2 : 1;
    const sightedGroup = derived.group === 1 ? 2 : 1;
    h.store.upsertLink({
      id: childLinkId,
      transport: "radio",
      address: { relayLinkId: "usb-RELAY", channel: sightedChannel, group: sightedGroup },
      at: 1,
    });
    await flush();

    const ws = fakeWebSocket();
    h.wss.triggerConnection(ws);
    await flush();

    ws.emit("message", Buffer.from(JSON.stringify({ type: "session-open", relayLinkId: "usb-RELAY", name: "vevov" })), false);
    await flush();

    expect(h.runtime.requestOpen).toHaveBeenCalledWith(childLinkId);
    const link = h.store.snapshotRows().links.find((l) => l.id === childLinkId);
    expect(JSON.parse(link!.address as string)).toEqual({
      relayLinkId: "usb-RELAY",
      channel: sightedChannel,
      group: sightedGroup,
    });
  });

  // -------------------------------------------------------------------
  // Sprint 016 ticket 006: registry-aware radio address resolution.
  // `resolveRegistryLocationForRelay` reads `relayLinkId`'s own discovered
  // mbrelay pool row (`links.address.{host,registryPort}`, written by
  // `watchers/mdnsWatcher.ts`'s `handleMbrelay`) and threads it into
  // `resolveDeviceRadio`'s `registry` option -- closing the gap
  // `radioOverride.ts`'s own doc comment used to describe ("not yet wired
  // into any production call site"). A real loopback HTTP server (port 0,
  // closed in `afterEach` via this file's own harness teardown) stands in
  // for mbrelay's name registry -- no fake `fetch`/`resolveRegistry`
  // injection needed since `mbrelayRegistry.ts`'s real `resolveRobotAddress`
  // already accepts any reachable host/port.
  // -------------------------------------------------------------------
  describe("sprint 016 ticket 006: registry-aware radio address resolution", () => {
    function startFakeRegistry(channel: number, group: number, source: "registry" | "derived" = "registry") {
      const registryServer = createServer((_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ channel, group, source }));
      });
      const portPromise = new Promise<number>((resolve) => {
        registryServer.listen(0, "127.0.0.1", () => {
          const address = registryServer.address();
          resolve(typeof address === "object" && address !== null ? address.port : 0);
        });
      });
      return { registryServer, portPromise };
    }

    // Each test below uses its own robot name, distinct from every other
    // test in this file (including this describe block's own siblings):
    // `mbrelayRegistry.ts`'s real `resolveRobotAddress` caches per-name in
    // a *module-level* `DEFAULT_CACHE` shared by every real caller (its
    // own doc comment, "Short TTL cache") -- server.ts's real
    // `resolveDeviceRadio` call site never overrides it with a fresh
    // `Map`, so two tests resolving the same name within the ~2s TTL
    // window would otherwise leak one test's resolution into another's.

    it("resolves through mbrelay's own name registry, via relayLinkId's discovered registryPort, when no override exists", async () => {
      const { registryServer, portPromise } = startFakeRegistry(61, 90, "registry");
      const registryPort = await portPromise;

      try {
        const h = await harness();
        // A discovered mbrelay pool's own link row -- registryPort comes
        // from its TXT record (watchers/mdnsWatcher.ts's handleMbrelay);
        // the physical port (9) here is never dialed by this test (this
        // handler only upserts the child link's row and forwards its id
        // to the fake runtime's requestOpen -- it never itself bridges).
        h.store.upsertLink({
          id: "usb-RELAY",
          transport: "mbrelay",
          address: { host: "127.0.0.1", port: 9, registryPort },
          at: 1,
        });
        const ws = fakeWebSocket();
        h.wss.triggerConnection(ws);
        await flush();

        ws.emit("message", Buffer.from(JSON.stringify({ type: "session-open", relayLinkId: "usb-RELAY", name: "gopiv" })), false);
        // A real HTTP round trip to the fake registry above -- flush()'s
        // two setImmediate hops are not enough to settle it (see waitFor's
        // own doc comment).
        await waitFor(() => h.runtime.requestOpen.mock.calls.length > 0);
        await flush();

        const childLinkId = "radio-gopiv-via-usb-RELAY";
        expect(h.runtime.requestOpen).toHaveBeenCalledWith(childLinkId);
        const link = h.store.snapshotRows().links.find((l) => l.id === childLinkId);
        expect(JSON.parse(link!.address as string)).toEqual({ relayLinkId: "usb-RELAY", channel: 61, group: 90 });
      } finally {
        await new Promise<void>((resolve) => registryServer.close(() => resolve()));
      }
    });

    it("a stored override still wins outright even when the relay's own registry is reachable and would answer differently", async () => {
      const { registryServer, portPromise } = startFakeRegistry(61, 90, "registry");
      const registryPort = await portPromise;

      try {
        const h = await harness();
        const overrideDeviceId = 777;
        const overrideDeviceName = deviceIdToName(overrideDeviceId);
        h.store.upsertDevice({ id: overrideDeviceId, name: overrideDeviceName, kind: "robot", at: 1 });
        h.store.setRadioOverride(overrideDeviceId, 41, 3);
        h.store.upsertLink({
          id: "usb-RELAY",
          transport: "mbrelay",
          address: { host: "127.0.0.1", port: 9, registryPort },
          at: 1,
        });
        const ws = fakeWebSocket();
        h.wss.triggerConnection(ws);
        await flush();

        ws.emit(
          "message",
          Buffer.from(JSON.stringify({ type: "session-open", relayLinkId: "usb-RELAY", name: overrideDeviceName })),
          false,
        );
        await flush();

        const childLinkId = `radio-${overrideDeviceName}-via-usb-RELAY`;
        const link = h.store.snapshotRows().links.find((l) => l.id === childLinkId);
        // The override (41, 3), not the registry's (61, 90).
        expect(JSON.parse(link!.address as string)).toEqual({ relayLinkId: "usb-RELAY", channel: 41, group: 3 });
      } finally {
        await new Promise<void>((resolve) => registryServer.close(() => resolve()));
      }
    });

    it("a local usb relay (no registryPort in its address) still resolves through override -> derived, unaffected by this ticket's registry wiring", async () => {
      const h = await harness();
      // usb-RELAY here carries a plain usb address (no registryPort at
      // all) -- resolveRegistryLocationForRelay must degrade to
      // `undefined` rather than throwing on the missing field.
      h.store.upsertLink({ id: "usb-RELAY", transport: "usb", address: { path: "/dev/cu.relay" }, at: 1 });
      const ws = fakeWebSocket();
      h.wss.triggerConnection(ws);
      await flush();

      ws.emit("message", Buffer.from(JSON.stringify({ type: "session-open", relayLinkId: "usb-RELAY", name: "tigez" })), false);
      await flush();

      const derived = nameToRadioAddress("tigez");
      const childLinkId = "radio-tigez-via-usb-RELAY";
      const link = h.store.snapshotRows().links.find((l) => l.id === childLinkId);
      expect(JSON.parse(link!.address as string)).toEqual({ relayLinkId: "usb-RELAY", channel: derived.channel, group: derived.group });
    });

    // Stakeholder bench defect (2026-09-14): vevov moved to the 73-channel
    // map (registry 20/82), but its old row through the USB bridge vitut
    // still carried the old map's 37/43 -- and that row used to win, with
    // the USB bridge never asking any registry at all.
    it("a USB bridge asks a discovered pool's registry, and a registry answer beats the address left on an old link row", async () => {
      const { registryServer, portPromise } = startFakeRegistry(20, 82, "derived");
      const registryPort = await portPromise;

      try {
        const h = await harness();
        h.store.upsertLink({ id: "mbrelay-POOL", transport: "mbrelay", address: { host: "127.0.0.1", port: 9, registryPort }, at: 1 });
        h.store.upsertLink({ id: "usb-RELAY", transport: "usb", address: { path: "/dev/cu.relay" }, at: 1 });
        const childLinkId = "radio-zeguz-via-usb-RELAY";
        h.store.upsertLink({ id: childLinkId, transport: "radio", address: { relayLinkId: "usb-RELAY", channel: 37, group: 43 }, at: 1 });
        const ws = fakeWebSocket();
        h.wss.triggerConnection(ws);
        await flush();

        ws.emit("message", Buffer.from(JSON.stringify({ type: "session-open", relayLinkId: "usb-RELAY", name: "zeguz" })), false);
        await waitFor(() => h.runtime.requestOpen.mock.calls.length > 0);
        await flush();

        expect(h.runtime.requestOpen).toHaveBeenCalledWith(childLinkId);
        const link = h.store.snapshotRows().links.find((l) => l.id === childLinkId);
        expect(JSON.parse(link!.address as string)).toEqual({ relayLinkId: "usb-RELAY", channel: 20, group: 82 });
      } finally {
        await new Promise<void>((resolve) => registryServer.close(() => resolve()));
      }
    });

    it("with no registry answering, the address already on the link row still wins over the name-derived default", async () => {
      // A port nothing listens on any more: the registry request is refused.
      const closedServer = createServer();
      const closedPort = await new Promise<number>((resolve) => {
        closedServer.listen(0, "127.0.0.1", () => {
          const address = closedServer.address();
          resolve(typeof address === "object" && address !== null ? address.port : 0);
        });
      });
      await new Promise<void>((resolve) => closedServer.close(() => resolve()));

      const h = await harness();
      h.store.upsertLink({ id: "mbrelay-POOL", transport: "mbrelay", address: { host: "127.0.0.1", port: 9, registryPort: closedPort }, at: 1 });
      h.store.upsertLink({ id: "usb-RELAY", transport: "usb", address: { path: "/dev/cu.relay" }, at: 1 });
      const childLinkId = "radio-zetuv-via-usb-RELAY";
      h.store.upsertLink({ id: childLinkId, transport: "radio", address: { relayLinkId: "usb-RELAY", channel: 37, group: 43 }, at: 1 });
      const ws = fakeWebSocket();
      h.wss.triggerConnection(ws);
      await flush();

      ws.emit("message", Buffer.from(JSON.stringify({ type: "session-open", relayLinkId: "usb-RELAY", name: "zetuv" })), false);
      await waitFor(() => h.runtime.requestOpen.mock.calls.length > 0);
      await flush();

      const link = h.store.snapshotRows().links.find((l) => l.id === childLinkId);
      expect(JSON.parse(link!.address as string)).toEqual({ relayLinkId: "usb-RELAY", channel: 37, group: 43 });
    });
  });
});

// ---------------------------------------------------------------------
// line / send-command reach the open session directly
// ---------------------------------------------------------------------

describe("server.ts: line/send-command via runtime.reconciler.sessions", () => {
  it("sends a raw line to the session's link and echoes it as a tx line", async () => {
    const h = await harness();
    const session = fakeSession("usb-1");
    h.runtime.sessionsByLink.set("usb-1", session);
    const ws = fakeWebSocket();
    h.wss.triggerConnection(ws);
    await flush(); // let the startup firmware-availability poll's own broadcast (if any) land first
    ws.sent.length = 0;

    ws.emit("message", Buffer.from(JSON.stringify({ type: "line", linkId: "usb-1", direction: "tx", line: "GET x" })), false);
    await flush();

    expect(session.link.sendLine).toHaveBeenCalledWith("GET x");
    const echoed = ws.sent.find((m) => m.type === "line");
    expect(echoed).toMatchObject({ type: "line", linkId: "usb-1", direction: "tx", line: "GET x" });
  });

  it("reports a notice for a line sent to a link with no open session, without crashing", async () => {
    const h = await harness();
    const ws = fakeWebSocket();
    h.wss.triggerConnection(ws);
    await flush(); // let the startup firmware-availability poll's own broadcast (if any) land first
    ws.sent.length = 0;

    ws.emit("message", Buffer.from(JSON.stringify({ type: "line", linkId: "no-such-link", direction: "tx", line: "GET x" })), false);
    await flush();

    const notice = ws.sent.find((m) => m.type === "notice");
    expect(notice).toMatchObject({ type: "notice", level: "error" });
  });

  it("routes send-command through sendCommand for a sequenced verb and sendUnsequencedQuery otherwise", async () => {
    const h = await harness();
    const session = fakeSession("usb-1");
    h.runtime.sessionsByLink.set("usb-1", session);
    const ws = fakeWebSocket();
    h.wss.triggerConnection(ws);

    ws.emit("message", Buffer.from(JSON.stringify({ type: "send-command", linkId: "usb-1", verb: "STOP" })), false);
    await flush();
    expect(session.link.sendCommand).toHaveBeenCalledWith("STOP", []);

    ws.emit("message", Buffer.from(JSON.stringify({ type: "send-command", linkId: "usb-1", verb: "STATUS" })), false);
    await flush();
    expect(session.link.sendUnsequencedQuery).toHaveBeenCalledWith("STATUS", []);
    expect(session.link.sendUnsequenced).not.toHaveBeenCalled();
  });

  it("rejects HELLO via send-command rather than forwarding it raw", async () => {
    const h = await harness();
    const session = fakeSession("usb-1");
    h.runtime.sessionsByLink.set("usb-1", session);
    const ws = fakeWebSocket();
    h.wss.triggerConnection(ws);

    ws.emit("message", Buffer.from(JSON.stringify({ type: "send-command", linkId: "usb-1", verb: "HELLO" })), false);
    await flush();

    expect(session.link.sendCommand).not.toHaveBeenCalled();
    expect(session.link.sendUnsequenced).not.toHaveBeenCalled();
    expect(session.link.sendUnsequencedQuery).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------
  // Item G (team-lead, 2026-09-13): a real, successfully-decoded reply
  // (id/status/ack/nack) never reached the student console because this
  // subscription used to read `onRawLine`, which only ever fires for a
  // line `receive()` could not route to a decoded shape. It now reads
  // `onInboundLine`, which fires for every inbound line -- see
  // `LineLink.onInboundLine`'s own doc comment.
  // -------------------------------------------------------------------
  it("broadcasts a decoded reply line (delivered via onInboundLine) as an rx line -- the bench defect this fixes", async () => {
    const h = await harness();
    const session = fakeSession("usb-1");
    h.runtime.sessionsByLink.set("usb-1", session);
    const ws = fakeWebSocket();
    h.wss.triggerConnection(ws);
    // `ensureLineSubscriptions` runs on `store.onChange` -- a store
    // mutation (mirroring the snapshot-broadcast test's own pattern) is
    // what actually registers this session's `onInboundLine` listener.
    h.store.upsertDevice({ id: 1198504156, name: "vevov", kind: "robot", at: 1 });
    await flush();
    ws.sent.length = 0;

    (session.link as unknown as { _emitInboundLine: (line: string) => void })._emitInboundLine(
      "id diffdrive calibration-0.20260913.1 1.20260912.8 gopiv",
    );
    await flush();

    const rx = ws.sent.find((m) => m.type === "line" && (m as { direction?: string }).direction === "rx");
    expect(rx).toMatchObject({ type: "line", linkId: "usb-1", direction: "rx", line: "id diffdrive calibration-0.20260913.1 1.20260912.8 gopiv" });
  });

  it("still broadcasts an unrouted/foreign line as an rx line via the same subscription (onRawLine's own former case is not lost)", async () => {
    const h = await harness();
    const session = fakeSession("usb-1");
    h.runtime.sessionsByLink.set("usb-1", session);
    const ws = fakeWebSocket();
    h.wss.triggerConnection(ws);
    h.store.upsertDevice({ id: 1198504156, name: "vevov", kind: "robot", at: 1 });
    await flush();
    ws.sent.length = 0;

    (session.link as unknown as { _emitInboundLine: (line: string) => void })._emitInboundLine("beep boop overheard");
    await flush();

    const rx = ws.sent.find((m) => m.type === "line" && (m as { direction?: string }).direction === "rx");
    expect(rx).toMatchObject({ type: "line", linkId: "usb-1", direction: "rx", line: "beep boop overheard" });
  });

  it("tags a status reply origin: \"poll\" unless a student asked for STATUS -- the console's Show status polls toggle keys on it", async () => {
    const h = await harness();
    const session = fakeSession("usb-1");
    h.runtime.sessionsByLink.set("usb-1", session);
    const ws = fakeWebSocket();
    h.wss.triggerConnection(ws);
    h.store.upsertDevice({ id: 1198504156, name: "vevov", kind: "robot", at: 1 });
    await flush();
    const emitInbound = (line: string) =>
      (session.link as unknown as { _emitInboundLine: (line: string) => void })._emitInboundLine(line);
    const lastRx = () => ws.sent.filter((m) => m.type === "line" && (m as { direction?: string }).direction === "rx").at(-1) as
      | { line: string; origin?: string }
      | undefined;

    // No student STATUS outstanding: the harvester's own poll answered.
    emitInbound("status ready=1 active=0 flags=1 tlm=off next=4");
    await flush();
    expect(lastRx()).toMatchObject({ line: "status ready=1 active=0 flags=1 tlm=off next=4", origin: "poll" });

    // Any other reply is never tagged.
    emitInbound("ack 3 2 stop");
    await flush();
    expect(lastRx()!.origin).toBeUndefined();

    // A student's own STATUS (send-command or a raw line): its one reply shows, the next poll reply is tagged again.
    ws.emit("message", Buffer.from(JSON.stringify({ type: "send-command", linkId: "usb-1", verb: "STATUS" })), false);
    await flush();
    emitInbound("status ready=1 active=0 flags=1 tlm=off next=5");
    await flush();
    expect(lastRx()!.origin).toBeUndefined();
    emitInbound("status ready=1 active=0 flags=1 tlm=off next=5");
    await flush();
    expect(lastRx()!.origin).toBe("poll");

    ws.emit("message", Buffer.from(JSON.stringify({ type: "line", linkId: "usb-1", direction: "tx", line: "status" })), false);
    await flush();
    emitInbound("status ready=1 active=0 flags=1 tlm=off next=5");
    await flush();
    expect(lastRx()!.origin).toBeUndefined();
  });
});

// ---------------------------------------------------------------------
// flash-start
// ---------------------------------------------------------------------

describe("server.ts: DEFAULT_MAX_PAYLOAD_BYTES ties WebSocketServer's own maxPayload to the local-hex upload cap", () => {
  // Sprint 017 ticket 003 / review finding F9
  // (`03-host-server-flash-releases.md`): the real enforcement boundary
  // for an oversized local-hex upload must be `WebSocketServer`'s own
  // `maxPayload`, not only `localHexUpload.ts`'s post-hoc declared-vs-
  // actual `byteLength` check -- so `maxPayload` must actually be tied
  // to that cap, not merely "comfortably above" it by some separately
  // chosen, coincidentally larger number.
  it("is at least MAX_UPLOAD_BYTE_LENGTH plus the uploadId prefix, and not wildly larger than that", () => {
    const floor = MAX_UPLOAD_BYTE_LENGTH + UPLOAD_ID_BYTE_LENGTH;
    expect(DEFAULT_MAX_PAYLOAD_BYTES).toBeGreaterThanOrEqual(floor);
    // "tied to the cap", not merely "large enough" -- the slack above
    // the floor is only for ordinary JSON control-message framing
    // overhead, not megabytes of headroom.
    expect(DEFAULT_MAX_PAYLOAD_BYTES - floor).toBeLessThan(64 * 1024);
  });
});

describe("server.ts: flash-start", () => {
  const FAKE_DEVICE: DaplinkDevice = { serialNumber: "SERIAL123", displaySerial: "IAL1" } as unknown as DaplinkDevice;

  it("resolves the device by usb-<serial>, broadcasts flash-progress, then a successful flash-result", async () => {
    const flashMock = vi.fn(async (_device, _hex, onProgress: (phase: string) => void) => {
      onProgress("erasing");
      onProgress("writing");
      return { status: "ok", method: "swd" } satisfies FlashOutcome;
    });
    const h = await harness({
      enumerateDaplinkDevices: async () => [FAKE_DEVICE],
      flash: flashMock as unknown as StartServerOptions["flash"],
    });
    h.store.upsertLink({ id: "usb-SERIAL123", transport: "usb", address: { path: "/dev/x" }, at: 1 });
    await flush();

    const ws = fakeWebSocket();
    h.wss.triggerConnection(ws);
    await flush(); // let the startup firmware-availability poll's own broadcast (if any) land first
    ws.sent.length = 0;

    const source: FirmwareSourceRef = { kind: "local-hex", uploadId: "11111111-1111-1111-1111-111111111111", fileName: "a.hex", sha256: "x" };
    // Stub localHexUpload.consumeUpload by going through the real
    // handshake: begin -> binary frame -> flash-start.
    const sha256 = createHash("sha256").update("hello").digest("hex");
    ws.emit(
      "message",
      Buffer.from(JSON.stringify({ type: "flash-local-begin", fileName: "a.hex", byteLength: 5, sha256 })),
      false,
    );
    await flush();
    const ready = ws.sent.find((m) => m.type === "flash-local-ready") as { uploadId: string } | undefined;
    expect(ready).toBeDefined();
    const uploadId = ready!.uploadId;
    const frame = Buffer.concat([Buffer.from(uploadId, "ascii"), Buffer.from("hello")]);
    ws.emit("message", frame, true);
    await flush();

    ws.emit("message", Buffer.from(JSON.stringify({ type: "flash-start", linkId: "usb-SERIAL123", source: { ...source, uploadId } })), false);
    await flush();
    await flush();

    expect(flashMock).toHaveBeenCalled();
    const progressMessages = ws.sent.filter((m) => m.type === "flash-progress");
    expect(progressMessages.length).toBeGreaterThan(0);
    const result = ws.sent.find((m) => m.type === "flash-result");
    expect(result).toMatchObject({ type: "flash-result", linkId: "usb-SERIAL123", status: "ok" });
  });

  it("reports a flash-result error, without throwing, when no USB device is currently enumerated", async () => {
    const h = await harness({ enumerateDaplinkDevices: async () => [] });
    h.store.upsertLink({ id: "usb-MISSING", transport: "usb", address: { path: "/dev/x" }, at: 1 });
    await flush();

    const ws = fakeWebSocket();
    h.wss.triggerConnection(ws);
    await flush(); // let the startup firmware-availability poll's own broadcast (if any) land first
    ws.sent.length = 0;

    const source: FirmwareSourceRef = { kind: "release", firmware: "robot" };
    ws.emit("message", Buffer.from(JSON.stringify({ type: "flash-start", linkId: "usb-MISSING", source })), false);
    await flush();

    const result = ws.sent.find((m) => m.type === "flash-result");
    expect(result).toMatchObject({ type: "flash-result", status: "error" });
  });

  // Sprint 017 ticket 003: flash-start now routes through
  // `connect/flasher.ts`, which closes an already-open session first
  // (via `runtime.reconciler.requestClose`) and acquires
  // `board_owner = 'flash'` for the duration of the flash -- "the owner
  // handoff visible in the store" this ticket's own AC describes.
  it("closes an already-open session first, holds board_owner='flash' only while flash() runs, and releases it afterward", async () => {
    let storeRef: Store | undefined;
    const flashMock = vi.fn(async (_device, _hex, onProgress: (phase: string) => void) => {
      // While flash() itself runs, board_owner must already be held by
      // 'flash' -- a different owner's acquire attempt must fail.
      expect(storeRef!.acquireBoardOwner("SERIAL123", "someone-else", Date.now())).toBe(false);
      onProgress("erasing");
      return { status: "ok", method: "swd" } satisfies FlashOutcome;
    });
    const h = await harness({
      enumerateDaplinkDevices: async () => [FAKE_DEVICE],
      flash: flashMock as unknown as StartServerOptions["flash"],
    });
    storeRef = h.store;
    h.store.upsertLink({ id: "usb-SERIAL123", transport: "usb", address: { path: "/dev/x" }, at: 1 });
    await flush();

    // Simulate a session already open on this link before the flash.
    h.runtime.sessionsByLink.set("usb-SERIAL123", fakeSession("usb-SERIAL123"));

    const ws = fakeWebSocket();
    h.wss.triggerConnection(ws);
    await flush();
    ws.sent.length = 0;

    const sha256 = createHash("sha256").update("hello").digest("hex");
    ws.emit(
      "message",
      Buffer.from(JSON.stringify({ type: "flash-local-begin", fileName: "a.hex", byteLength: 5, sha256 })),
      false,
    );
    await flush();
    const ready = ws.sent.find((m) => m.type === "flash-local-ready") as { uploadId: string } | undefined;
    const uploadId = ready!.uploadId;
    ws.emit("message", Buffer.concat([Buffer.from(uploadId, "ascii"), Buffer.from("hello")]), true);
    await flush();

    const source: FirmwareSourceRef = { kind: "local-hex", uploadId, fileName: "a.hex", sha256 };
    ws.emit("message", Buffer.from(JSON.stringify({ type: "flash-start", linkId: "usb-SERIAL123", source })), false);
    await flush();
    await flush();

    expect(h.runtime.requestClose).toHaveBeenCalledWith("usb-SERIAL123");
    expect(flashMock).toHaveBeenCalled();
    // board_owner released once the flash finished -- a fresh acquire by
    // a different owner now succeeds.
    expect(h.store.acquireBoardOwner("SERIAL123", "someone-else", Date.now())).toBe(true);
    const result = ws.sent.find((m) => m.type === "flash-result");
    expect(result).toMatchObject({ type: "flash-result", status: "ok" });
  });

  // Sprint 019 ticket 006 (SUC-007): the `Snapshot`'s `flash` overlay
  // gains `origin`/`caller`, wired here for the browser's own
  // `flash-start` path -- `origin: "ui"`, no `caller` at all (never
  // `caller: undefined`, which `toHaveProperty` below tells apart from a
  // genuinely absent key). Ticket 008's `mcp/tools/flash.ts` is the first
  // caller that will ever produce `origin: "mcp"`/a `caller` name here.
  it("attributes an in-flight browser flash as origin 'ui' with no caller on the snapshot's flash overlay, cleared once it settles", async () => {
    let ws!: ReturnType<typeof fakeWebSocket>;
    const flashMock = vi.fn(async (_device, _hex, onProgress: (phase: string) => void) => {
      onProgress("erasing");
      // `connect/flasher.ts` already acquired `board_owner = 'flash'`
      // (a store write) before calling this mock, and `setFlashPhase`
      // already ran at least once (at `runFlashTask`'s own first line,
      // before this mock is ever reached) -- so by now a `snapshot`
      // broadcast carrying the current flash overlay has already gone
      // out on `ws`.
      const latestSnapshot = [...ws.sent].reverse().find((m): m is Snapshot => m.type === "snapshot");
      const link = latestSnapshot?.unassigned.find((l) => l.id === "usb-SERIAL123");
      expect(link?.flash).toMatchObject({ origin: "ui" });
      expect(link?.flash).not.toHaveProperty("caller");
      return { status: "ok", method: "swd" } satisfies FlashOutcome;
    });
    const h = await harness({
      enumerateDaplinkDevices: async () => [FAKE_DEVICE],
      flash: flashMock as unknown as StartServerOptions["flash"],
    });
    h.store.upsertLink({ id: "usb-SERIAL123", transport: "usb", address: { path: "/dev/x" }, at: 1 });
    await flush();

    ws = fakeWebSocket();
    h.wss.triggerConnection(ws);
    await flush();
    ws.sent.length = 0;

    const sha256 = createHash("sha256").update("hello").digest("hex");
    ws.emit(
      "message",
      Buffer.from(JSON.stringify({ type: "flash-local-begin", fileName: "a.hex", byteLength: 5, sha256 })),
      false,
    );
    await flush();
    const ready = ws.sent.find((m) => m.type === "flash-local-ready") as { uploadId: string } | undefined;
    const uploadId = ready!.uploadId;
    ws.emit("message", Buffer.concat([Buffer.from(uploadId, "ascii"), Buffer.from("hello")]), true);
    await flush();

    const source: FirmwareSourceRef = { kind: "local-hex", uploadId, fileName: "a.hex", sha256 };
    ws.emit("message", Buffer.from(JSON.stringify({ type: "flash-start", linkId: "usb-SERIAL123", source })), false);
    await flush();
    await flush();

    expect(flashMock).toHaveBeenCalled();
    // The overlay is deleted the instant the flash settles -- the final
    // snapshot must carry no `flash` field at all for this link.
    const finalSnapshot = [...ws.sent].reverse().find((m): m is Snapshot => m.type === "snapshot");
    const finalLink = finalSnapshot?.unassigned.find((l) => l.id === "usb-SERIAL123");
    expect(finalLink?.flash).toBeUndefined();
  });

  // Sprint 019 ticket 008: the MCP-triggered counterpart to the "ui"
  // test just above. `mcp/tools/flash.ts`'s own `request_flash` calls
  // exactly the `startFlash` `mountRoutes`'s own `MountRoutesExtra`
  // hands out here (`cli.ts` wires the two together for real) -- this
  // test proves that *this file's own* `startFlash`, called with an
  // explicit `{origin: "mcp", caller}` identity the way `request_flash`
  // would, attributes the overlay accordingly and hands back the same
  // terminal outcome `finishFlash`/`failFlash` broadcast, without ever
  // going through a second, MCP-specific flash implementation.
  it("attributes an MCP-triggered flash as origin 'mcp' with the given caller on the snapshot's flash overlay, clears it once settled, and its own returned promise resolves to the terminal outcome", async () => {
    let ws!: ReturnType<typeof fakeWebSocket>;
    // `flash()` is held open (a deferred promise, not a real timer) so
    // the flash is still genuinely in flight when this test inspects the
    // snapshot overlay -- the store's own change-feed flush that carries
    // it into a `snapshot` broadcast is `setImmediate`-coalesced
    // (`store/index.ts`'s own `scheduleFlush`), so the overlay is only
    // observable from *outside* `flash()`'s own synchronous call chain,
    // after at least one real event-loop turn has had a chance to run
    // that flush -- never from an assertion placed inside the `flash()`
    // callback itself (a throw there would just be caught by
    // `runFlashTask`'s own try/catch and reported as an ordinary flash
    // failure, silently masking the assertion rather than failing the
    // test).
    let resolveFlash!: (outcome: FlashOutcome) => void;
    const flashDeferred = new Promise<FlashOutcome>((resolve) => {
      resolveFlash = resolve;
    });
    const flashMock = vi.fn(async (_device, _hex, onProgress: (phase: string) => void) => {
      onProgress("erasing");
      return flashDeferred;
    });
    let capturedStartFlash: MountRoutesExtra["startFlash"] | undefined;
    const h = await harness({
      enumerateDaplinkDevices: async () => [FAKE_DEVICE],
      flash: flashMock as unknown as StartServerOptions["flash"],
      mountRoutes: (_app, extra) => {
        capturedStartFlash = extra.startFlash;
      },
    });
    h.store.upsertLink({ id: "usb-SERIAL123", transport: "usb", address: { path: "/dev/x" }, at: 1 });
    await flush();

    ws = fakeWebSocket();
    h.wss.triggerConnection(ws);
    await flush();
    ws.sent.length = 0;

    expect(capturedStartFlash).toBeDefined();

    // Same local-hex upload handshake every other flash-start test in
    // this file uses -- `startFlash` still needs a real, previously
    // uploaded hex for a `local-hex` source regardless of who calls it.
    const sha256 = createHash("sha256").update("hello").digest("hex");
    ws.emit(
      "message",
      Buffer.from(JSON.stringify({ type: "flash-local-begin", fileName: "a.hex", byteLength: 5, sha256 })),
      false,
    );
    await flush();
    const ready = ws.sent.find((m) => m.type === "flash-local-ready") as { uploadId: string } | undefined;
    const uploadId = ready!.uploadId;
    ws.emit("message", Buffer.concat([Buffer.from(uploadId, "ascii"), Buffer.from("hello")]), true);
    await flush();
    ws.sent.length = 0;

    const source: FirmwareSourceRef = { kind: "local-hex", uploadId, fileName: "a.hex", sha256 };
    // Not a `flash-start` WS message -- calling `startFlash` the same
    // way `mcp/tools/flash.ts`'s `request_flash` would, directly.
    const outcomePromise = capturedStartFlash!("usb-SERIAL123", source, { origin: "mcp", caller: "agent-007" });

    // Give the store's own coalesced change-feed flush a real event-loop
    // turn to run while the flash is still genuinely in flight (held
    // open by `flashDeferred`, not yet resolved).
    await flush();
    await flush();
    expect(flashMock).toHaveBeenCalled();
    const midFlightSnapshot = [...ws.sent].reverse().find((m): m is Snapshot => m.type === "snapshot");
    const midFlightLink = midFlightSnapshot?.unassigned.find((l) => l.id === "usb-SERIAL123");
    expect(midFlightLink?.flash).toMatchObject({ origin: "mcp", caller: "agent-007" });

    resolveFlash({ status: "ok", method: "swd" });
    const outcome = await outcomePromise;

    // `startFlash`'s own resolved value is `flasher.flash`'s raw
    // `FlashOutcome` on success (`{status, method}`) -- `FlashResultLike`
    // is a structural subset, not a distinct runtime shape.
    expect(outcome).toMatchObject({ status: "ok" });
    // `finishFlash` deletes the overlay synchronously (in-memory), but a
    // `snapshot` broadcast reflecting that still needs a real event-loop
    // turn for the store's own coalesced flush -- the same reason the
    // mid-flight check above needed one (`releaseBoardOwner`'s own write,
    // in `flasher.flash`'s `finally`, schedules the flush that eventually
    // carries the now-cleared overlay).
    await flush();
    const finalSnapshot = [...ws.sent].reverse().find((m): m is Snapshot => m.type === "snapshot");
    const finalLink = finalSnapshot?.unassigned.find((l) => l.id === "usb-SERIAL123");
    expect(finalLink?.flash).toBeUndefined();
  });
});

// ---------------------------------------------------------------------
// flash-start: network flash over _mbflash._tcp (ticket 018-014)
// ---------------------------------------------------------------------

describe("server.ts: flash-start routes a mbserial/wifi link with a current _mbflash._tcp service to the network flasher", () => {
  /** Drives the same flash-local-begin -> binary-frame handshake every
   * USB flash-start test above already uses, returning the resulting
   * `uploadId`/`sha256` for a `flash-start` `source`. */
  async function uploadLocalHex(ws: ReturnType<typeof fakeWebSocket>, bytes: string): Promise<{ uploadId: string; sha256: string }> {
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    ws.emit(
      "message",
      Buffer.from(JSON.stringify({ type: "flash-local-begin", fileName: "a.hex", byteLength: bytes.length, sha256 })),
      false,
    );
    await flush();
    const ready = ws.sent.find((m) => m.type === "flash-local-ready") as { uploadId: string } | undefined;
    const uploadId = ready!.uploadId;
    ws.emit("message", Buffer.concat([Buffer.from(uploadId, "ascii"), Buffer.from(bytes)]), true);
    await flush();
    return { uploadId, sha256 };
  }

  it("closes the session, dials the service's host/port, reports writing/resetting/reidentifying, reopens on success", async () => {
    const flashOverMbflashMock = vi.fn(async (_target: unknown, _hexBytes: Buffer, onProgress: (line: string) => void) => {
      onProgress("LOG writing page 1");
      return { status: "ok" } satisfies MbflashOutcome;
    });
    const h = await harness({ flashOverMbflash: flashOverMbflashMock });

    const name = deviceIdToName(1198504156);
    h.store.upsertDevice({ id: 1198504156, name, kind: "robot", at: 1 });
    h.store.setOwned(1198504156, true, 1);
    h.store.upsertLink({ id: "mbserial-gopiv", transport: "mbserial", address: { host: "gopiv.local", port: 4000 }, deviceId: 1198504156, at: 1 });
    h.store.upsertService({ instance: name, type: MBFLASH_SERVICE_TYPE, host: "gopiv.local", port: 34567, txt: { role: "NEZHA2" }, at: 1 });
    await flush();

    const ws = fakeWebSocket();
    h.wss.triggerConnection(ws);
    await flush();
    ws.sent.length = 0;

    const { uploadId, sha256 } = await uploadLocalHex(ws, "hello");
    const source: FirmwareSourceRef = { kind: "local-hex", uploadId, fileName: "a.hex", sha256 };
    ws.emit("message", Buffer.from(JSON.stringify({ type: "flash-start", linkId: "mbserial-gopiv", source })), false);
    await flush();
    await flush();

    expect(h.runtime.requestClose).toHaveBeenCalledWith("mbserial-gopiv");
    expect(flashOverMbflashMock).toHaveBeenCalledTimes(1);
    const [target, hexBytes] = flashOverMbflashMock.mock.calls[0] as [{ host: string; port: number }, Buffer, unknown];
    // The service's own host/port (34567), never the mbserial link's own
    // session address (4000) -- the flash service is a distinct TCP
    // endpoint from the mbserial bridge port.
    expect(target).toEqual({ host: "gopiv.local", port: 34567 });
    expect(hexBytes.toString("utf-8")).toBe("hello");

    expect(h.runtime.requestOpen).toHaveBeenCalledWith("mbserial-gopiv");

    const phases = ws.sent.filter((m) => m.type === "flash-progress").map((m) => (m as { phase: string }).phase);
    expect(phases).toContain("writing");
    expect(phases).toContain("resetting");
    expect(phases).toContain("reidentifying");
    // reidentifying must be the last progress phase reported, before the
    // terminal flash-result.
    expect(phases[phases.length - 1]).toBe("reidentifying");

    const result = ws.sent.find((m) => m.type === "flash-result");
    expect(result).toMatchObject({ type: "flash-result", linkId: "mbserial-gopiv", status: "ok" });
  });

  it("a wifi link with a current _mbflash._tcp service routes the same way (not only mbserial)", async () => {
    const flashOverMbflashMock = vi.fn(async () => ({ status: "ok" }) satisfies MbflashOutcome);
    const h = await harness({ flashOverMbflash: flashOverMbflashMock });

    const name = deviceIdToName(1198504156);
    h.store.upsertDevice({ id: 1198504156, name, kind: "robot", at: 1 });
    h.store.setOwned(1198504156, true, 1);
    h.store.upsertLink({ id: "wifi-vevov", transport: "wifi", address: { host: "vevov.local", port: 81 }, deviceId: 1198504156, at: 1 });
    h.store.upsertService({ instance: name, type: MBFLASH_SERVICE_TYPE, host: "vevov.local", port: 9100, txt: null, at: 1 });
    await flush();

    const ws = fakeWebSocket();
    h.wss.triggerConnection(ws);
    await flush();
    ws.sent.length = 0;

    const { uploadId, sha256 } = await uploadLocalHex(ws, "hello");
    const source: FirmwareSourceRef = { kind: "local-hex", uploadId, fileName: "a.hex", sha256 };
    ws.emit("message", Buffer.from(JSON.stringify({ type: "flash-start", linkId: "wifi-vevov", source })), false);
    await flush();
    await flush();

    expect(flashOverMbflashMock).toHaveBeenCalledTimes(1);
    const result = ws.sent.find((m) => m.type === "flash-result");
    expect(result).toMatchObject({ type: "flash-result", status: "ok" });
  });

  it("reports a plain flash-result error, never calls flashOverMbflash, when the device has no current _mbflash._tcp service", async () => {
    const flashOverMbflashMock = vi.fn();
    const h = await harness({ flashOverMbflash: flashOverMbflashMock });

    const name = deviceIdToName(1198504156);
    h.store.upsertDevice({ id: 1198504156, name, kind: "robot", at: 1 });
    h.store.setOwned(1198504156, true, 1);
    h.store.upsertLink({ id: "mbserial-gopiv", transport: "mbserial", address: { host: "gopiv.local", port: 4000 }, deviceId: 1198504156, at: 1 });
    // Deliberately no upsertService call -- nothing currently advertises
    // _mbflash._tcp for this device.
    await flush();

    const ws = fakeWebSocket();
    h.wss.triggerConnection(ws);
    await flush();
    ws.sent.length = 0;

    const source: FirmwareSourceRef = { kind: "release", firmware: "robot" };
    ws.emit("message", Buffer.from(JSON.stringify({ type: "flash-start", linkId: "mbserial-gopiv", source })), false);
    await flush();

    expect(flashOverMbflashMock).not.toHaveBeenCalled();
    expect(h.runtime.requestClose).not.toHaveBeenCalled();
    const result = ws.sent.find((m) => m.type === "flash-result");
    expect(result).toMatchObject({ type: "flash-result", status: "error" });
    expect((result as { message: string }).message).toMatch(/_mbflash\._tcp/);
  });

  it("reports a plain flash-result error for an unsupported transport (radio/mbrelay), even with a service row present", async () => {
    const flashOverMbflashMock = vi.fn();
    const h = await harness({ flashOverMbflash: flashOverMbflashMock });

    const name = deviceIdToName(1198504156);
    h.store.upsertDevice({ id: 1198504156, name, kind: "robot", at: 1 });
    h.store.setOwned(1198504156, true, 1);
    h.store.upsertLink({ id: "radio-1", transport: "radio", address: { relayLinkId: "relay-1", channel: 1, group: 1 }, deviceId: 1198504156, at: 1 });
    h.store.upsertService({ instance: name, type: MBFLASH_SERVICE_TYPE, host: "gopiv.local", port: 34567, txt: null, at: 1 });
    await flush();

    const ws = fakeWebSocket();
    h.wss.triggerConnection(ws);
    await flush();
    ws.sent.length = 0;

    const source: FirmwareSourceRef = { kind: "release", firmware: "robot" };
    ws.emit("message", Buffer.from(JSON.stringify({ type: "flash-start", linkId: "radio-1", source })), false);
    await flush();

    expect(flashOverMbflashMock).not.toHaveBeenCalled();
    const result = ws.sent.find((m) => m.type === "flash-result");
    expect(result).toMatchObject({ type: "flash-result", status: "error" });
  });

  it("a network flash failure (e.g. ERR busy) is reported plainly and never triggers a reopen", async () => {
    const flashOverMbflashMock = vi.fn(
      async () => ({ status: "error", reason: "busy", error: "mbflash reported \"ERR busy\"" }) satisfies MbflashOutcome,
    );
    const h = await harness({ flashOverMbflash: flashOverMbflashMock });

    const name = deviceIdToName(1198504156);
    h.store.upsertDevice({ id: 1198504156, name, kind: "robot", at: 1 });
    h.store.setOwned(1198504156, true, 1);
    h.store.upsertLink({ id: "mbserial-gopiv", transport: "mbserial", address: { host: "gopiv.local", port: 4000 }, deviceId: 1198504156, at: 1 });
    h.store.upsertService({ instance: name, type: MBFLASH_SERVICE_TYPE, host: "gopiv.local", port: 34567, txt: null, at: 1 });
    await flush();

    const ws = fakeWebSocket();
    h.wss.triggerConnection(ws);
    await flush();
    ws.sent.length = 0;

    const { uploadId, sha256 } = await uploadLocalHex(ws, "hello");
    const source: FirmwareSourceRef = { kind: "local-hex", uploadId, fileName: "a.hex", sha256 };
    ws.emit("message", Buffer.from(JSON.stringify({ type: "flash-start", linkId: "mbserial-gopiv", source })), false);
    await flush();
    await flush();

    expect(h.runtime.requestClose).toHaveBeenCalledWith("mbserial-gopiv");
    expect(h.runtime.requestOpen).not.toHaveBeenCalled();
    const result = ws.sent.find((m) => m.type === "flash-result");
    expect(result).toMatchObject({ type: "flash-result", status: "error" });
    expect((result as { message: string }).message).toContain("ERR busy");
  });
});

// ---------------------------------------------------------------------
// flash-start (mbregistry transport) -- sprint 018 ticket 005
// ---------------------------------------------------------------------

function fakeRegistryDevice(overrides: Partial<RegistryDevice> = {}): RegistryDevice {
  return {
    uid: "uid-1",
    short_uid: "1",
    port: null,
    vid_pid: null,
    role: null,
    common_name: null,
    device_name: null,
    serial_payload: null,
    raw_announcement: null,
    state: "connected",
    error_note: null,
    flash_count: 0,
    chip_identity_name: null,
    chip_identity_serial: null,
    first_seen: 0,
    last_seen: 0,
    last_probe: null,
    lock_kind: null,
    lock_pid: null,
    lock_label: null,
    lock_since: null,
    host: null,
    endpoint: null,
    ...overrides,
  };
}

function fakeMbregistryClient(
  device: RegistryDevice,
  remotePort: number | undefined,
  resolvedEndpoint?: MbregistryClient["resolvedEndpoint"],
): MbregistryClient {
  return {
    connect: vi.fn(),
    close: vi.fn(),
    list: vi.fn(),
    find: vi.fn(async () => device),
    lock: vi.fn(),
    unlock: vi.fn(),
    watch: vi.fn(),
    stream: vi.fn(),
    resolvedEndpoint,
    remotePort,
  };
}

/** Drives the same `flash-local-begin` -> binary frame -> `flash-start`
 * handshake `describe("server.ts: flash-start")`'s own usb tests use,
 * against `linkId`, and returns the `flash-result` message once it
 * lands. */
async function driveLocalHexFlash(ws: ReturnType<typeof fakeWebSocket>, linkId: string): Promise<ServerMessage | undefined> {
  const sha256 = createHash("sha256").update("hello").digest("hex");
  ws.emit("message", Buffer.from(JSON.stringify({ type: "flash-local-begin", fileName: "a.hex", byteLength: 5, sha256 })), false);
  await flush();
  const ready = ws.sent.find((m) => m.type === "flash-local-ready") as { uploadId: string } | undefined;
  const uploadId = ready!.uploadId;
  ws.emit("message", Buffer.concat([Buffer.from(uploadId, "ascii"), Buffer.from("hello")]), true);
  await flush();

  const source: FirmwareSourceRef = { kind: "local-hex", uploadId, fileName: "a.hex", sha256 };
  ws.emit("message", Buffer.from(JSON.stringify({ type: "flash-start", linkId, source })), false);
  await flush();
  await flush();

  return ws.sent.find((m) => m.type === "flash-result");
}

describe("server.ts: flash-start (mbregistry transport)", () => {
  // Ticket 018-011 finding 2's own local-flash path: a local device whose
  // client connection is a local Unix socket/pipe goes through
  // `flashViaLocalSocket`, never touching `remotePort` at all -- see the
  // next test. This one covers the narrower fallback that still exists
  // for a client connected over TCP with no local socket of its own
  // (`resolvedEndpoint` left `undefined` here, mirroring a bare TCP
  // client -- `resolveFlashPlan`'s own doc comment).
  it("falls back to 127.0.0.1 on this client's own remote port when there is no local socket, and flashes via flashMbregistry", async () => {
    const device = fakeRegistryDevice({ uid: "uid-1", host: null, endpoint: null });
    const mbregistryClient = fakeMbregistryClient(device, 7440);
    const flashViaMbregistryMock = vi.fn(async (_target: RemoteFlashTarget, _uid: string, _label: string | undefined, _hex: string, onProgress: (phase: string) => void) => {
      onProgress("writing");
      return { status: "ok", method: "mbregistry" } satisfies FlashOutcome;
    });
    const h = await harness({
      mbregistryClient,
      mbregistryLabel: "console-label",
      flashViaMbregistry: flashViaMbregistryMock as unknown as StartServerOptions["flashViaMbregistry"],
    });
    h.store.upsertLink({ id: "mbregistry-uid-1", transport: "mbregistry", address: { endpoint: null, uid: "uid-1" }, at: 1 });
    await flush();

    const ws = fakeWebSocket();
    h.wss.triggerConnection(ws);
    await flush();
    ws.sent.length = 0;

    const result = await driveLocalHexFlash(ws, "mbregistry-uid-1");

    expect(mbregistryClient.find).toHaveBeenCalledWith("uid-1");
    expect(flashViaMbregistryMock).toHaveBeenCalledTimes(1);
    const call = flashViaMbregistryMock.mock.calls[0]!;
    expect(call[0]).toEqual({ host: "127.0.0.1", port: 7440 });
    expect(call[1]).toBe("uid-1");
    expect(call[2]).toBe("console-label");
    expect(h.runtime.requestClose).toHaveBeenCalledWith("mbregistry-uid-1");
    expect(result).toMatchObject({ type: "flash-result", status: "ok" });
  });

  // Ticket 018-011 finding 2: the common real-bench case -- this
  // console's own mbregistry connection IS a local Unix socket (it
  // resolved via the standard client-socket-candidates path, not a
  // TCP override), so a local device flashes through
  // `flashViaLocalSocket` against that same socket, with no dependency
  // on `remotePort` at all (left `undefined` here to prove it).
  it("flashes a local device via flashViaLocalSocket against this client's own local socket when no remote port is known (a pre-existing registry this console didn't spawn)", async () => {
    const device = fakeRegistryDevice({ uid: "uid-1a", host: null, endpoint: null });
    const mbregistryClient = fakeMbregistryClient(device, undefined, { kind: "unix", path: "/tmp/fake/api.sock" });
    const flashViaLocalSocketMock = vi.fn(
      async (_target: LocalFlashTarget, _uid: string, _label: string | undefined, _hex: string, onProgress: (phase: string) => void) => {
        onProgress("writing");
        return { status: "ok", method: "mbregistry" } satisfies FlashOutcome;
      },
    );
    const h = await harness({
      mbregistryClient,
      mbregistryLabel: "console-label",
      flashViaLocalSocket: flashViaLocalSocketMock as unknown as StartServerOptions["flashViaLocalSocket"],
    });
    h.store.upsertLink({ id: "mbregistry-uid-1a", transport: "mbregistry", address: { endpoint: null, uid: "uid-1a" }, at: 1 });
    await flush();

    const ws = fakeWebSocket();
    h.wss.triggerConnection(ws);
    await flush();
    ws.sent.length = 0;

    const result = await driveLocalHexFlash(ws, "mbregistry-uid-1a");

    expect(flashViaLocalSocketMock).toHaveBeenCalledTimes(1);
    const call = flashViaLocalSocketMock.mock.calls[0]!;
    expect(call[0]).toEqual({ kind: "unix", path: "/tmp/fake/api.sock" });
    expect(call[1]).toBe("uid-1a");
    expect(call[2]).toBe("console-label");
    expect(h.runtime.requestClose).toHaveBeenCalledWith("mbregistry-uid-1a");
    expect(result).toMatchObject({ type: "flash-result", status: "ok" });
  });

  it("resolves a remote target straight from the device's own endpoint -- no proxying through the local instance", async () => {
    const device = fakeRegistryDevice({ uid: "uid-2", host: "peer-host", endpoint: "10.0.0.9:7440" });
    const mbregistryClient = fakeMbregistryClient(device, 5555);
    const flashViaMbregistryMock = vi.fn(async () => ({ status: "ok", method: "mbregistry" }) satisfies FlashOutcome);
    const h = await harness({
      mbregistryClient,
      flashViaMbregistry: flashViaMbregistryMock as unknown as StartServerOptions["flashViaMbregistry"],
    });
    h.store.upsertLink({ id: "mbregistry-uid-2", transport: "mbregistry", address: { endpoint: null, uid: "uid-2" }, at: 1 });
    await flush();

    const ws = fakeWebSocket();
    h.wss.triggerConnection(ws);
    await flush();
    ws.sent.length = 0;

    const result = await driveLocalHexFlash(ws, "mbregistry-uid-2");

    const call = flashViaMbregistryMock.mock.calls[0]!;
    expect(call[0]).toEqual({ host: "10.0.0.9", port: 7440 });
    expect(result).toMatchObject({ type: "flash-result", status: "ok" });
  });

  it("reports a descriptive flash-result error, without throwing, when no mbregistry client is configured", async () => {
    const h = await harness({});
    h.store.upsertLink({ id: "mbregistry-uid-3", transport: "mbregistry", address: { endpoint: null, uid: "uid-3" }, at: 1 });
    await flush();

    const ws = fakeWebSocket();
    h.wss.triggerConnection(ws);
    await flush();
    ws.sent.length = 0;

    const result = await driveLocalHexFlash(ws, "mbregistry-uid-3");

    expect(result).toMatchObject({ type: "flash-result", status: "error" });
    expect((result as { message?: string }).message).toMatch(/mbregistry client/);
  });

  // Sprint 018 ticket 006 (closing a gap flagged by ticket 005's own
  // Description): once `mbregistryWatcher` persists a device's own
  // `host`/`endpoint` into the link row's address, routing comes
  // straight from that stored row -- no live `find()` round-trip.
  it("routes straight from the stored link address (host/endpoint persisted by mbregistryWatcher) -- no live find() call at all", async () => {
    const device = fakeRegistryDevice({ uid: "uid-4", host: "peer-host", endpoint: "10.0.0.9:7440" });
    const mbregistryClient = fakeMbregistryClient(device, 5555);
    const flashViaMbregistryMock = vi.fn(async () => ({ status: "ok", method: "mbregistry" }) satisfies FlashOutcome);
    const h = await harness({
      mbregistryClient,
      flashViaMbregistry: flashViaMbregistryMock as unknown as StartServerOptions["flashViaMbregistry"],
    });
    // The stored address already carries host/endpoint (as
    // mbregistryWatcher.ts now writes) -- unlike the tests above, which
    // simulate a pre-018-006 row with no "host" key at all.
    h.store.upsertLink({
      id: "mbregistry-uid-4",
      transport: "mbregistry",
      address: { endpoint: "10.0.0.9:7440", host: "peer-host", uid: "uid-4" },
      at: 1,
    });
    await flush();

    const ws = fakeWebSocket();
    h.wss.triggerConnection(ws);
    await flush();
    ws.sent.length = 0;

    const result = await driveLocalHexFlash(ws, "mbregistry-uid-4");

    expect(mbregistryClient.find).not.toHaveBeenCalled();
    const call = flashViaMbregistryMock.mock.calls[0]!;
    expect(call[0]).toEqual({ host: "10.0.0.9", port: 7440 });
    expect(result).toMatchObject({ type: "flash-result", status: "ok" });
  });

  // Ticket 018-014 (see `projection.ts`'s own doc comment): a `wifi`
  // link is a legitimate network-flash candidate on L, not an
  // unrecognized transport -- so a `wifi` link with no identified
  // device fails on that precondition, not on a "USB link required"
  // message left over from before that ticket.
  it("a wifi link with no identified device still fails descriptively (no fallback to USB wording)", async () => {
    const h = await harness({});
    h.store.upsertLink({ id: "wifi-1", transport: "wifi", address: { host: "x", port: 1 }, at: 1 });
    await flush();

    const ws = fakeWebSocket();
    h.wss.triggerConnection(ws);
    await flush();
    ws.sent.length = 0;

    const result = await driveLocalHexFlash(ws, "wifi-1");

    expect(result).toMatchObject({ type: "flash-result", status: "error" });
    expect((result as { message?: string }).message).toMatch(/has no identified device to flash/);
  });
});

// ---------------------------------------------------------------------
// AC4: signal-triggered shutdown mid-flash
// ---------------------------------------------------------------------

describe("server.ts: close() with the real ws.WebSocketServer (bench 015-011 deadlock regression)", () => {
  // Every other test in this file drives `fakeWebSocketServer()`, whose
  // `close(cb)` always calls `cb()` immediately -- nothing here
  // exercises the real `ws` library's own `WebSocketServer.close()`,
  // which (per its own source) does *not* invoke its callback until
  // `this.clients.size === 0` whenever a client is still connected at
  // close time. A real, unclosed browser tab hit exactly that: this
  // module's old `close()` awaited `wss.close()`'s callback *before* the
  // `client.terminate()` loop that would have brought `clients.size` to
  // 0 -- a deadlock invisible to the fake above, reproduced live on the
  // bench (SIGTERM never completed with a Chromium tab attached), and
  // fixed by making `wss.close()` fire-and-forget. This test uses the
  // real `ws.WebSocketServer` (via `startServer`'s own default
  // `createWebSocketServer`, not `startTestServer`'s override) and a
  // real, still-open `ws` client that never voluntarily closes, so a
  // regression here reproduces the exact hang rather than passing
  // vacuously against a mock.
  it("resolves close() within a bounded time with a real client still connected and never closing on its own", async () => {
    const { store, dir } = freshStore();
    const runtime = fakeRuntime();
    const server = await startServer({
      store,
      runtime,
      port: 0,
      firmwareConfig: { relay: undefined, robot: undefined },
    });

    const client = new RealWebSocket(server.url.replace(/^http/, "ws"));
    await new Promise<void>((resolve, reject) => {
      client.once("open", () => resolve());
      client.once("error", reject);
    });

    let outcome: "closed" | "timeout" = "timeout";
    await Promise.race([
      server.close().then(() => {
        outcome = "closed";
      }),
      new Promise<void>((resolve) => setTimeout(resolve, 2000)),
    ]);

    expect(outcome).toBe("closed");

    client.terminate();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("server.ts: close() waits for an in-flight flash", () => {
  it("does not resolve close() until the in-flight flash-start task has finished, and it does finish (never aborted mid-write)", async () => {
    let resolveFlash!: (outcome: FlashOutcome) => void;
    const flashMock = vi.fn(
      () =>
        new Promise<FlashOutcome>((resolve) => {
          resolveFlash = resolve;
        }),
    );
    const h = await startTestServer({
      enumerateDaplinkDevices: async () => [{ serialNumber: "SERIAL123" } as unknown as DaplinkDevice],
      flash: flashMock as unknown as StartServerOptions["flash"],
    });
    h.store.upsertLink({ id: "usb-SERIAL123", transport: "usb", address: { path: "/dev/x" }, at: 1 });
    await flush();

    const ws = fakeWebSocket();
    h.wss.triggerConnection(ws);
    await flush();

    const sha256 = createHash("sha256").update("hello").digest("hex");
    ws.emit("message", Buffer.from(JSON.stringify({ type: "flash-local-begin", fileName: "a.hex", byteLength: 5, sha256 })), false);
    await flush();
    const ready = ws.sent.find((m) => m.type === "flash-local-ready") as { uploadId: string } | undefined;
    expect(ready).toBeDefined();
    const uploadId = ready!.uploadId;
    ws.emit("message", Buffer.concat([Buffer.from(uploadId, "ascii"), Buffer.from("hello")]), true);
    await flush();

    const source: FirmwareSourceRef = { kind: "local-hex", uploadId, fileName: "a.hex", sha256 };
    ws.emit("message", Buffer.from(JSON.stringify({ type: "flash-start", linkId: "usb-SERIAL123", source })), false);
    await flush();
    expect(flashMock).toHaveBeenCalled();

    let closed = false;
    const closePromise = h.server.close().then(() => {
      closed = true;
    });

    // Give close() every chance to resolve early if it (wrongly) does
    // not wait for the in-flight flash.
    await flush();
    await flush();
    expect(closed).toBe(false);

    // The flash finishes cleanly (never force-aborted) -- only then does
    // close() resolve.
    resolveFlash({ status: "ok", method: "swd" });
    await closePromise;
    expect(closed).toBe(true);

    h.store.close();
    rmSync(h.dir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------
// forget-device / wifi credentials -- sanity coverage
// ---------------------------------------------------------------------

describe("server.ts: forget-device", () => {
  it("deletes the device via store.deleteDevice", async () => {
    const h = await harness();
    h.store.upsertDevice({ id: 1198504156, name: "vevov", kind: "robot", at: 1 });
    await flush();

    const ws = fakeWebSocket();
    h.wss.triggerConnection(ws);
    ws.emit("message", Buffer.from(JSON.stringify({ type: "forget-device", deviceId: 1198504156 })), false);
    await flush();

    expect(h.store.snapshotRows().devices).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------
// set-radio-override -- ticket 006's own acceptance criteria
// ---------------------------------------------------------------------

describe("server.ts: set-radio-override", () => {
  it("persists a valid override, and the next snapshot's devices[].radio shows it (AC1)", async () => {
    const h = await harness();
    h.store.upsertDevice({ id: 1198504156, name: "vevov", kind: "robot", at: 1 });
    h.store.setOwned(1198504156, true, 1);
    await flush();

    const ws = fakeWebSocket();
    h.wss.triggerConnection(ws);
    await flush();
    ws.sent.length = 0;

    ws.emit(
      "message",
      Buffer.from(JSON.stringify({ type: "set-radio-override", deviceId: 1198504156, channel: 41, group: 3 })),
      false,
    );
    await flush();

    expect(h.store.snapshotRows().devices[0]).toMatchObject({ radio_channel: 41, radio_group: 3, radio_source: "override" });
    const snapshot = ws.sent.find((m) => m.type === "snapshot") as Snapshot | undefined;
    const device = snapshot?.devices.find((d) => d.id === 1198504156);
    expect(device?.radio).toEqual({ channel: 41, group: 3, source: "override" });
  });

  it("clearing returns source to derived and the snapshot shows the derived pair (AC2)", async () => {
    const h = await harness();
    h.store.upsertDevice({ id: 1198504156, name: "vevov", kind: "robot", at: 1 });
    h.store.setOwned(1198504156, true, 1);
    h.store.setRadioOverride(1198504156, 41, 3);
    await flush();

    const ws = fakeWebSocket();
    h.wss.triggerConnection(ws);
    await flush();
    ws.sent.length = 0;

    ws.emit("message", Buffer.from(JSON.stringify({ type: "set-radio-override", deviceId: 1198504156, clear: true })), false);
    await flush();

    expect(h.store.snapshotRows().devices[0]).toMatchObject({ radio_channel: null, radio_group: null, radio_source: null });
    const snapshot = ws.sent.find((m) => m.type === "snapshot") as Snapshot | undefined;
    const device = snapshot?.devices.find((d) => d.id === 1198504156);
    expect(device?.radio.source).toBe("derived");
  });

  it("rejects an out-of-range channel with a notice, and writes nothing (AC4)", async () => {
    const h = await harness();
    h.store.upsertDevice({ id: 1198504156, name: "vevov", kind: "robot", at: 1 });
    await flush();

    const ws = fakeWebSocket();
    h.wss.triggerConnection(ws);
    await flush();
    ws.sent.length = 0;

    ws.emit(
      "message",
      Buffer.from(JSON.stringify({ type: "set-radio-override", deviceId: 1198504156, channel: 999, group: 3 })),
      false,
    );
    await flush();

    expect(h.store.snapshotRows().devices[0]).toMatchObject({ radio_channel: null, radio_group: null, radio_source: null });
    expect(ws.sent.some((m) => m.type === "notice" && m.level === "warn")).toBe(true);
  });

  it("rejects an out-of-range group with a notice, and writes nothing (AC4)", async () => {
    const h = await harness();
    h.store.upsertDevice({ id: 1198504156, name: "vevov", kind: "robot", at: 1 });
    await flush();

    const ws = fakeWebSocket();
    h.wss.triggerConnection(ws);
    await flush();
    ws.sent.length = 0;

    ws.emit(
      "message",
      Buffer.from(JSON.stringify({ type: "set-radio-override", deviceId: 1198504156, channel: 41, group: 999 })),
      false,
    );
    await flush();

    expect(h.store.snapshotRows().devices[0]).toMatchObject({ radio_channel: null, radio_group: null, radio_source: null });
    expect(ws.sent.some((m) => m.type === "notice" && m.level === "warn")).toBe(true);
  });

  it("rejects a non-integer channel with a notice, and writes nothing (AC4)", async () => {
    const h = await harness();
    h.store.upsertDevice({ id: 1198504156, name: "vevov", kind: "robot", at: 1 });
    await flush();

    const ws = fakeWebSocket();
    h.wss.triggerConnection(ws);
    await flush();
    ws.sent.length = 0;

    ws.emit(
      "message",
      Buffer.from(JSON.stringify({ type: "set-radio-override", deviceId: 1198504156, channel: 41.5, group: 3 })),
      false,
    );
    await flush();

    expect(h.store.snapshotRows().devices[0]).toMatchObject({ radio_channel: null, radio_group: null, radio_source: null });
    expect(ws.sent.some((m) => m.type === "notice" && m.level === "warn")).toBe(true);
  });
});

describe("server.ts: malformed/unrecognized messages", () => {
  it("replies directly to the sender (not a broadcast) for malformed JSON", async () => {
    const h = await harness();
    const sender = fakeWebSocket();
    const other = fakeWebSocket();
    h.wss.triggerConnection(sender);
    h.wss.triggerConnection(other);
    await flush(); // let the startup firmware-availability poll's own broadcast (if any) land first
    sender.sent.length = 0;
    other.sent.length = 0;

    sender.emit("message", Buffer.from("{not json"), false);
    await flush();

    expect(sender.sent.some((m) => m.type === "notice")).toBe(true);
    expect(other.sent).toHaveLength(0);
  });
});
