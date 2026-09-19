/**
 * server.test.ts (mcp/) — sprint 019 ticket 004's own suite for
 * `startMcpServer`'s Express-mounting glue: route registration, the
 * generic 405 behavior for GET/DELETE, and error handling around a
 * connect/handleRequest failure. Deliberately does **not** exercise the
 * real `StreamableHTTPServerTransport`/real Node HTTP request-response
 * plumbing -- both `createMcpServer` and `createTransport` are faked, so
 * this file never touches a real HTTP port (this ticket's own acceptance
 * criterion). The real MCP protocol behavior (tool listing, Zod
 * validation, `tools/call`) is covered by `mcp/tools/inspect.test.ts`
 * (via the SDK's own `InMemoryTransport`, still no sockets) and by this
 * ticket's documented live smoke test against a real running host.
 */
import os from "node:os";
import { describe, expect, it, vi } from "vitest";
import type { Express, Request, Response } from "express";
import { localhostHostValidation } from "@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js";
import {
  startMcpServer,
  createDefaultMcpServer,
  buildMcpHostAllowlist,
  nonInternalIPv4Addresses,
  DEFAULT_MCP_PATH,
  type McpDeps,
  type McpTransportLike,
  type StartMcpServerOptions,
} from "./server.js";

// ---------------------------------------------------------------------
// A fake Express app -- records every route registration by method, so
// tests can assert what got mounted (and in what order) without ever
// building a real Express instance or binding a port.
// ---------------------------------------------------------------------

type RouteHandler = (req: Request, res: Response) => void | Promise<void>;
interface RecordedRoute {
  method: "post" | "get" | "delete";
  path: string;
  handlers: RouteHandler[];
}

function fakeExpressApp(): Express & { routes: RecordedRoute[] } {
  const routes: RecordedRoute[] = [];
  const record =
    (method: RecordedRoute["method"]) =>
    (path: string, ...handlers: RouteHandler[]) => {
      routes.push({ method, path, handlers });
      return app;
    };
  const app = {
    routes,
    post: record("post"),
    get: record("get"),
    delete: record("delete"),
  } as unknown as Express & { routes: RecordedRoute[] };
  return app;
}

function fakeResponse(): Response & { statusCode?: number; jsonBody?: unknown; headersSent: boolean } {
  const res = {
    headersSent: false,
    statusCode: undefined,
    jsonBody: undefined,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(body: unknown) {
      res.jsonBody = body;
      res.headersSent = true;
      return res;
    },
    on: vi.fn(),
  } as unknown as Response & { statusCode?: number; jsonBody?: unknown; headersSent: boolean };
  return res;
}

// Sprint 019 ticket 005: `McpDeps` widened `startMcpServer`'s second
// argument from a bare `InspectStore` to `{store, reconciler}` so the
// connect tools (`open_session`/`close_session`/`send_command`) can be
// registered alongside the inspect ones. Ticket 007 widened `store`
// again (`AgentActionLogStore`, for `request_drive`'s audit write).
// Ticket 008 adds `startFlash`/`enumerateDaplinkDevices` for
// `request_flash` -- this fake never has its methods called by any test
// in this file (they exercise Express wiring, not tool behavior; that is
// `mcp/tools/connect.test.ts`'s/`mcp/tools/drive.test.ts`'s/
// `mcp/tools/flash.test.ts`'s own job), so every field is just enough to
// satisfy the type.
const fakeDeps: McpDeps = {
  store: {
    projectionRows: vi.fn(),
    upsertLink: vi.fn(),
    setSessionIdentity: vi.fn(),
    reconcilerRows: vi.fn(() => ({ devices: [], links: [], sessions: [], relayLeases: [] })),
  } as unknown as McpDeps["store"],
  reconciler: {
    requestOpen: vi.fn(async () => ({})),
    requestClose: vi.fn(async () => undefined),
    sessions: { get: vi.fn() },
  } as unknown as McpDeps["reconciler"],
  startFlash: vi.fn(async () => ({ status: "ok" }) as const),
  enumerateDaplinkDevices: vi.fn(async () => []),
};

describe("startMcpServer: route registration", () => {
  it("mounts POST/GET/DELETE on the default path", () => {
    const app = fakeExpressApp();
    const handle = startMcpServer(app, fakeDeps);

    expect(handle.path).toBe(DEFAULT_MCP_PATH);
    const methods = app.routes.map((r) => `${r.method} ${r.path}`);
    expect(methods).toEqual([`post ${DEFAULT_MCP_PATH}`, `get ${DEFAULT_MCP_PATH}`, `delete ${DEFAULT_MCP_PATH}`]);
  });

  it("honors an overridden path", () => {
    const app = fakeExpressApp();
    const handle = startMcpServer(app, fakeDeps, { path: "/tools/mcp" });

    expect(handle.path).toBe("/tools/mcp");
    expect(app.routes.every((r) => r.path === "/tools/mcp")).toBe(true);
  });

  it("the POST route carries at least a body-parser and the request handler (more than one middleware)", () => {
    const app = fakeExpressApp();
    startMcpServer(app, fakeDeps);
    const post = app.routes.find((r) => r.method === "post");
    expect(post?.handlers.length).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------
// Host-header allowlist (sprint 021 ticket 002) -- server.ts's own
// DEFAULT_HOST widened to 0.0.0.0 means this route's socket is now
// LAN-reachable, so the SDK's own localhostHostValidation() (localhost/
// 127.0.0.1/[::1] only) would 403 every legitimate LAN-originated call.
// buildMcpHostAllowlist/nonInternalIPv4Addresses are unit-tested directly
// against fake os.hostname()/os.networkInterfaces() values; the
// middleware acceptance/rejection cases below drive the actual mounted
// POST route's own hostValidation handler (post.handlers[1] -- see
// route-registration's own "carries at least a body-parser and the
// request handler" test above for why index 1, not the last handler, is
// the validation middleware).
// ---------------------------------------------------------------------

describe("nonInternalIPv4Addresses", () => {
  it("keeps only non-internal IPv4 addresses, dropping loopback/internal entries and every IPv6 entry", () => {
    const fakeInterfaces = {
      lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true, mac: "", cidr: null, netmask: "255.0.0.0" } as os.NetworkInterfaceInfo],
      en0: [
        { address: "192.168.1.42", family: "IPv4", internal: false, mac: "", cidr: null, netmask: "255.255.248.0" } as os.NetworkInterfaceInfo,
        { address: "fe80::1", family: "IPv6", internal: false, mac: "", cidr: null, netmask: "ffff:ffff:ffff:ffff::", scopeid: 4 } as os.NetworkInterfaceInfo,
      ],
      en1: [{ address: "192.168.4.7", family: "IPv4", internal: false, mac: "", cidr: null, netmask: "255.255.248.0" } as os.NetworkInterfaceInfo],
    };

    expect(nonInternalIPv4Addresses(fakeInterfaces)).toEqual(["192.168.1.42", "192.168.4.7"]);
  });

  it("tolerates an interface entry that is undefined (os.networkInterfaces()'s own Dict typing allows this)", () => {
    expect(nonInternalIPv4Addresses({ missing: undefined })).toEqual([]);
  });

  it("defaults to a real os.networkInterfaces() call when no argument is given", () => {
    expect(() => nonInternalIPv4Addresses()).not.toThrow();
  });
});

describe("buildMcpHostAllowlist", () => {
  it("includes localhost/127.0.0.1/[::1], the given hostname, <hostname>.local, and every non-internal IPv4 address from the given interfaces", () => {
    const fakeInterfaces = {
      en0: [{ address: "192.168.1.42", family: "IPv4", internal: false, mac: "", cidr: null, netmask: "255.255.248.0" } as os.NetworkInterfaceInfo],
      en1: [{ address: "192.168.4.7", family: "IPv4", internal: false, mac: "", cidr: null, netmask: "255.255.248.0" } as os.NetworkInterfaceInfo],
    };

    expect(buildMcpHostAllowlist("tovez", fakeInterfaces)).toEqual([
      "localhost",
      "127.0.0.1",
      "[::1]",
      "tovez",
      "tovez.local",
      "192.168.1.42",
      "192.168.4.7",
    ]);
  });

  it("defaults to real os.hostname()/os.networkInterfaces() when no arguments are given", () => {
    const allowlist = buildMcpHostAllowlist();
    expect(allowlist).toContain("localhost");
    expect(allowlist).toContain(os.hostname());
    expect(allowlist).toContain(`${os.hostname()}.local`);
  });
});

describe("startMcpServer: Host-header allowlist middleware (sprint 021 ticket 002)", () => {
  function hostValidationHandler(app: ReturnType<typeof fakeExpressApp>): (req: Request, res: Response, next: () => void) => void {
    const post = app.routes.find((r) => r.method === "post")!;
    return post.handlers[1]! as unknown as (req: Request, res: Response, next: () => void) => void;
  }

  it("a request whose Host header names this machine's own hostname is accepted", () => {
    const app = fakeExpressApp();
    startMcpServer(app, fakeDeps);
    const req = { headers: { host: `${os.hostname()}:4795` } } as unknown as Request;
    const res = fakeResponse();
    const next = vi.fn();

    hostValidationHandler(app)(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBeUndefined();
  });

  it("a request whose Host header names <hostname>.local is accepted", () => {
    const app = fakeExpressApp();
    startMcpServer(app, fakeDeps);
    const req = { headers: { host: `${os.hostname()}.local:4795` } } as unknown as Request;
    const res = fakeResponse();
    const next = vi.fn();

    hostValidationHandler(app)(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBeUndefined();
  });

  it("a request whose Host header names an unrelated third-party domain is still rejected -- the DNS-rebinding defense still does something", () => {
    const app = fakeExpressApp();
    startMcpServer(app, fakeDeps);
    const req = { headers: { host: "evil.example.com:4795" } } as unknown as Request;
    const res = fakeResponse();
    const next = vi.fn();

    hostValidationHandler(app)(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
  });

  it("021-002 regression guard: the old localhostHostValidation() would have rejected this exact LAN-hostname request -- confirms the allowlist widening is load-bearing, not a no-op", () => {
    const oldMiddleware = localhostHostValidation();
    const req = { headers: { host: `${os.hostname()}:4795` } } as unknown as Request;
    const res = fakeResponse();
    const next = vi.fn();

    oldMiddleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
  });
});

describe("startMcpServer: GET/DELETE (stateless mode has no session/stream to act on)", () => {
  it("GET replies 405 Method Not Allowed", async () => {
    const app = fakeExpressApp();
    startMcpServer(app, fakeDeps);
    const get = app.routes.find((r) => r.method === "get")!;
    const res = fakeResponse();
    await get.handlers[get.handlers.length - 1]!({} as Request, res);
    expect(res.statusCode).toBe(405);
    expect(res.jsonBody).toMatchObject({ jsonrpc: "2.0", error: { code: -32000 } });
  });

  it("DELETE replies 405 Method Not Allowed", async () => {
    const app = fakeExpressApp();
    startMcpServer(app, fakeDeps);
    const del = app.routes.find((r) => r.method === "delete")!;
    const res = fakeResponse();
    await del.handlers[del.handlers.length - 1]!({} as Request, res);
    expect(res.statusCode).toBe(405);
    expect(res.jsonBody).toMatchObject({ jsonrpc: "2.0", error: { code: -32000 } });
  });
});

describe("startMcpServer: POST request handling (createMcpServer/createTransport both faked)", () => {
  function fakeTransport(overrides: Partial<McpTransportLike> = {}): McpTransportLike & { handleRequest: ReturnType<typeof vi.fn> } {
    return {
      start: vi.fn().mockResolvedValue(undefined),
      send: vi.fn().mockResolvedValue(undefined),
      handleRequest: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      ...overrides,
    } as McpTransportLike & { handleRequest: ReturnType<typeof vi.fn> };
  }

  function mountWithFakes(options: Partial<StartMcpServerOptions> = {}) {
    const app = fakeExpressApp();
    const connectMock = vi.fn().mockResolvedValue(undefined);
    const closeMock = vi.fn().mockResolvedValue(undefined);
    const fakeMcpServer = { connect: connectMock, close: closeMock };
    const transport = fakeTransport();
    const createMcpServer = vi.fn(() => fakeMcpServer as unknown as ReturnType<NonNullable<StartMcpServerOptions["createMcpServer"]>>);
    const createTransport = vi.fn(() => transport);

    startMcpServer(app, fakeDeps, { createMcpServer, createTransport, ...options });
    const post = app.routes.find((r) => r.method === "post")!;
    const requestHandler = post.handlers[post.handlers.length - 1]!;
    return { requestHandler, createMcpServer, createTransport, connectMock, closeMock, transport };
  }

  it("builds one MCP server and one transport per request, connects them, and forwards the request", async () => {
    const { requestHandler, createMcpServer, createTransport, connectMock, transport } = mountWithFakes();
    const req = { body: { jsonrpc: "2.0", method: "tools/list", id: 1 } } as unknown as Request;
    const res = fakeResponse();

    await requestHandler(req, res);

    expect(createMcpServer).toHaveBeenCalledTimes(1);
    expect(createTransport).toHaveBeenCalledTimes(1);
    expect(connectMock).toHaveBeenCalledWith(transport);
    expect(transport.handleRequest).toHaveBeenCalledWith(req, res, req.body);
  });

  it("closes both the transport and the MCP server once the HTTP response closes", async () => {
    const { requestHandler, closeMock, transport } = mountWithFakes();
    const listeners: Array<() => void> = [];
    const req = { body: {} } as unknown as Request;
    const res = fakeResponse();
    (res.on as ReturnType<typeof vi.fn>).mockImplementation((event: string, listener: () => void) => {
      if (event === "close") listeners.push(listener);
    });

    await requestHandler(req, res);
    for (const listener of listeners) listener();

    expect(transport.close).toHaveBeenCalledTimes(1);
    expect(closeMock).toHaveBeenCalledTimes(1);
  });

  it("a thrown connect() failure is reported as a 500 JSON-RPC error when headers were not already sent", async () => {
    const app = fakeExpressApp();
    const failingMcpServer = { connect: vi.fn().mockRejectedValue(new Error("boom")), close: vi.fn() };
    startMcpServer(app, fakeDeps, {
      createMcpServer: () => failingMcpServer as unknown as ReturnType<NonNullable<StartMcpServerOptions["createMcpServer"]>>,
      createTransport: () => ({ start: vi.fn(), send: vi.fn(), handleRequest: vi.fn(), close: vi.fn() }),
    });
    const post = app.routes.find((r) => r.method === "post")!;
    const requestHandler = post.handlers[post.handlers.length - 1]!;
    const req = { body: {} } as unknown as Request;
    const res = fakeResponse();

    await requestHandler(req, res);

    expect(res.statusCode).toBe(500);
    expect(res.jsonBody).toMatchObject({ jsonrpc: "2.0", error: { code: -32603 } });
  });

  it("does not attempt to send a second response once headers are already sent", async () => {
    const app = fakeExpressApp();
    const res = fakeResponse();
    const failingTransport = { handleRequest: vi.fn().mockImplementation(() => { res.headersSent = true; throw new Error("late failure"); }), close: vi.fn() };
    const fakeMcpServer = { connect: vi.fn().mockResolvedValue(undefined), close: vi.fn() };
    startMcpServer(app, fakeDeps, {
      createMcpServer: () => fakeMcpServer as unknown as ReturnType<NonNullable<StartMcpServerOptions["createMcpServer"]>>,
      createTransport: () => failingTransport as unknown as McpTransportLike,
    });
    const post = app.routes.find((r) => r.method === "post")!;
    const requestHandler = post.handlers[post.handlers.length - 1]!;

    await requestHandler({ body: {} } as unknown as Request, res);

    expect(res.statusCode).toBeUndefined();
    expect(res.jsonBody).toBeUndefined();
  });
});

describe("startMcpServer: session continuity (sprint 019 ticket 005)", () => {
  function fakeTransport(overrides: Partial<McpTransportLike> & { sessionId?: string } = {}): McpTransportLike & { handleRequest: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> } {
    return {
      start: vi.fn().mockResolvedValue(undefined),
      send: vi.fn().mockResolvedValue(undefined),
      handleRequest: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      ...overrides,
    } as unknown as McpTransportLike & { handleRequest: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> };
  }

  it("keeps a negotiated session's server/transport pair alive instead of closing it on response close", async () => {
    const app = fakeExpressApp();
    const transport = fakeTransport({ sessionId: "session-abc" });
    const closeMock = vi.fn().mockResolvedValue(undefined);
    const createMcpServer = vi.fn(() => ({ connect: vi.fn().mockResolvedValue(undefined), close: closeMock }) as unknown as ReturnType<NonNullable<StartMcpServerOptions["createMcpServer"]>>);
    startMcpServer(app, fakeDeps, { createMcpServer, createTransport: () => transport });
    const post = app.routes.find((r) => r.method === "post")!;
    const requestHandler = post.handlers[post.handlers.length - 1]!;
    const res = fakeResponse();
    const listeners: Array<() => void> = [];
    (res.on as ReturnType<typeof vi.fn>).mockImplementation((event: string, listener: () => void) => {
      if (event === "close") listeners.push(listener);
    });

    await requestHandler({ headers: {}, body: { method: "initialize" } } as unknown as Request, res);
    for (const listener of listeners) listener();

    // Unlike the fully-stateless case (no sessionId set on the fake
    // transport, covered above), a negotiated session's pair is never
    // closed just because this one response finished.
    expect(transport.close).not.toHaveBeenCalled();
    expect(closeMock).not.toHaveBeenCalled();
  });

  it("reuses the same server/transport pair for a later request carrying the negotiated Mcp-Session-Id header", async () => {
    const app = fakeExpressApp();
    const transport = fakeTransport({ sessionId: "session-abc" });
    const createMcpServer = vi.fn(() => ({ connect: vi.fn().mockResolvedValue(undefined), close: vi.fn() }) as unknown as ReturnType<NonNullable<StartMcpServerOptions["createMcpServer"]>>);
    const createTransport = vi.fn(() => transport);
    startMcpServer(app, fakeDeps, { createMcpServer, createTransport });
    const post = app.routes.find((r) => r.method === "post")!;
    const requestHandler = post.handlers[post.handlers.length - 1]!;

    await requestHandler({ headers: {}, body: { method: "initialize" } } as unknown as Request, fakeResponse());
    const secondReq = { headers: { "mcp-session-id": "session-abc" }, body: { method: "tools/call" } } as unknown as Request;
    const secondRes = fakeResponse();
    await requestHandler(secondReq, secondRes);

    // No second server/transport pair was built -- the second request
    // reused the first's, which is what lets `mcp/tools/connect.ts`'s
    // `getClientVersion()` read still see the first request's own
    // `initialize` handshake.
    expect(createMcpServer).toHaveBeenCalledTimes(1);
    expect(createTransport).toHaveBeenCalledTimes(1);
    expect(transport.handleRequest).toHaveBeenCalledTimes(2);
    expect(transport.handleRequest).toHaveBeenNthCalledWith(2, secondReq, secondRes, secondReq.body);
  });

  it("rejects an unrecognized Mcp-Session-Id with 404 so the client re-initializes", async () => {
    // 404, not 400. Streamable HTTP clients treat 404 as "this session
    // is gone, send `initialize` again"; a 400 reads as "your request
    // was malformed" and leaves them retrying the same dead id. A peer
    // session hit exactly that after a dev-server restart -- sessions
    // live only in this process's memory -- and could not use MCP at
    // all until it started over.
    const app = fakeExpressApp();
    startMcpServer(app, fakeDeps);
    const post = app.routes.find((r) => r.method === "post")!;
    const requestHandler = post.handlers[post.handlers.length - 1]!;
    const req = { headers: { "mcp-session-id": "unknown-session" }, body: {} } as unknown as Request;
    const res = fakeResponse();

    await requestHandler(req, res);

    expect(res.statusCode).toBe(404);
    expect(res.jsonBody).toMatchObject({ jsonrpc: "2.0", error: { code: -32001 } });
    // The message must tell a human reading a log what to do about it.
    expect(JSON.stringify(res.jsonBody)).toContain("initialize");
  });
});

describe("createDefaultMcpServer: the real default registers every tool category", () => {
  it("registers the inspect, connect, drive, AND flash tools against the given deps (verified via a real InMemoryTransport round trip, not the Express layer)", async () => {
    // Does not touch a real HTTP port -- proves the same factory
    // `startMcpServer` uses as its default `createMcpServer` actually
    // wires `registerInspectTools`/`registerConnectTools`/
    // `registerDriveTools`/`registerFlashTools` to the deps it was given.
    // Full protocol coverage (Zod validation, empty-argument
    // survivability, no-writes) lives in `mcp/tools/inspect.test.ts`,
    // `mcp/tools/connect.test.ts`, `mcp/tools/drive.test.ts`, and
    // `mcp/tools/flash.test.ts` respectively.
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");

    const server = createDefaultMcpServer(fakeDeps);
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "probe-client", version: "0.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const tools = await client.listTools();
      const names = tools.tools.map((t) => t.name).sort();
      expect(names).toEqual(["close_session", "get_device_status", "list_devices", "open_session", "request_drive", "request_flash", "send_command"]);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("startMcpServer's own POST handler lazily calls this same default per request when no createMcpServer override is given", () => {
    const app = fakeExpressApp();
    startMcpServer(app, fakeDeps);
    expect(app.routes.length).toBe(3);
  });
});
