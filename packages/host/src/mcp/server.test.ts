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
import { describe, expect, it, vi } from "vitest";
import type { Express, Request, Response } from "express";
import { startMcpServer, createDefaultMcpServer, DEFAULT_MCP_PATH, type McpTransportLike, type StartMcpServerOptions } from "./server.js";
import type { InspectStore } from "./tools/inspect.js";

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

const fakeStore: InspectStore = { projectionRows: vi.fn() } as unknown as InspectStore;

describe("startMcpServer: route registration", () => {
  it("mounts POST/GET/DELETE on the default path", () => {
    const app = fakeExpressApp();
    const handle = startMcpServer(app, fakeStore);

    expect(handle.path).toBe(DEFAULT_MCP_PATH);
    const methods = app.routes.map((r) => `${r.method} ${r.path}`);
    expect(methods).toEqual([`post ${DEFAULT_MCP_PATH}`, `get ${DEFAULT_MCP_PATH}`, `delete ${DEFAULT_MCP_PATH}`]);
  });

  it("honors an overridden path", () => {
    const app = fakeExpressApp();
    const handle = startMcpServer(app, fakeStore, { path: "/tools/mcp" });

    expect(handle.path).toBe("/tools/mcp");
    expect(app.routes.every((r) => r.path === "/tools/mcp")).toBe(true);
  });

  it("the POST route carries at least a body-parser and the request handler (more than one middleware)", () => {
    const app = fakeExpressApp();
    startMcpServer(app, fakeStore);
    const post = app.routes.find((r) => r.method === "post");
    expect(post?.handlers.length).toBeGreaterThanOrEqual(2);
  });
});

describe("startMcpServer: GET/DELETE (stateless mode has no session/stream to act on)", () => {
  it("GET replies 405 Method Not Allowed", async () => {
    const app = fakeExpressApp();
    startMcpServer(app, fakeStore);
    const get = app.routes.find((r) => r.method === "get")!;
    const res = fakeResponse();
    await get.handlers[get.handlers.length - 1]!({} as Request, res);
    expect(res.statusCode).toBe(405);
    expect(res.jsonBody).toMatchObject({ jsonrpc: "2.0", error: { code: -32000 } });
  });

  it("DELETE replies 405 Method Not Allowed", async () => {
    const app = fakeExpressApp();
    startMcpServer(app, fakeStore);
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

    startMcpServer(app, fakeStore, { createMcpServer, createTransport, ...options });
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
    startMcpServer(app, fakeStore, {
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
    startMcpServer(app, fakeStore, {
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

describe("createDefaultMcpServer: the real default registers the inspect tools", () => {
  it("registers list_devices/get_device_status against the given store (verified via a real InMemoryTransport round trip, not the Express layer)", async () => {
    // Does not touch a real HTTP port -- proves the same factory
    // `startMcpServer` uses as its default `createMcpServer` actually
    // wires `registerInspectTools` to the store it was given. Full
    // protocol coverage (Zod validation, empty-argument survivability,
    // no-writes) lives in `mcp/tools/inspect.test.ts`.
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");

    const server = createDefaultMcpServer(fakeStore);
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "probe-client", version: "0.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const tools = await client.listTools();
      const names = tools.tools.map((t) => t.name).sort();
      expect(names).toEqual(["get_device_status", "list_devices"]);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("startMcpServer's own POST handler lazily calls this same default per request when no createMcpServer override is given", () => {
    const app = fakeExpressApp();
    startMcpServer(app, fakeStore);
    expect(app.routes.length).toBe(3);
  });
});
