/**
 * mcp/server.ts — the MCP subsystem's transport + tool registry (sprint
 * 019 ticket 004; `sprint.md`'s own module table: "`mcp/server.ts` —
 * *purpose*: accept MCP client connections and expose the tool registry.
 * *Boundary*: inside — MCP transport wiring (mounted as a Streamable HTTP
 * route on the existing Express app from `server.ts`), tool registration,
 * request/response shape; outside — any actual device/store logic, which
 * every tool delegates to.").
 *
 * ## Streamable HTTP, mounted on the existing app, not stdio
 *
 * Per `sprint.md`'s Design Rationale ("MCP transport is Streamable HTTP
 * on the existing Express app, not stdio"): stdio spawns a *new child
 * process per client*, which would recreate the exact
 * two-processes-fighting-over-one-port/lease shape tickets 001-003 just
 * fixed, applied to the whole host, not just a relay port. `startMcpServer`
 * takes the same Express `app` instance `server.ts` already builds and
 * binds to `127.0.0.1` (`server.ts`'s own `DEFAULT_HOST`) — `cli.ts`
 * passes it in via `StartServerOptions.mountRoutes`, which runs *before*
 * `server.ts`'s own static-file/SPA catch-all route is registered, so
 * this route is never shadowed by it (`server.ts`'s own doc comment on
 * that hook).
 *
 * `@modelcontextprotocol/sdk` 1.30.0 (pinned exactly, per this ticket's
 * own acceptance criterion) confirms Express-mountability directly in its
 * own shipped example (`dist/esm/examples/server/
 * simpleStatelessStreamableHttp.js`): `app.post('/mcp', ...)` constructing
 * a fresh `StreamableHTTPServerTransport({sessionIdGenerator: undefined})`
 * per request and calling `transport.handleRequest(req, res, req.body)` —
 * exactly the shape this module follows. This was verified by reading
 * that shipped example, not merely assumed from the architecture doc's
 * "confirmed supported as of this writing" (which this ticket was asked
 * to re-verify rather than trust).
 *
 * ## Stateless mode
 *
 * Every POST gets a fresh {@link McpServer} + `StreamableHTTPServerTransport`
 * pair (`sessionIdGenerator: undefined` — the SDK's own "stateless mode":
 * no session id is issued or checked). This is the right shape for an
 * inspect-only tool surface with no server-initiated stream and no
 * cross-request state of its own to resume — ticket 005's connect/command
 * tools are the first to need any session concept, and that concept is
 * `sessions` rows in the store, not MCP transport session state. Revisit
 * this choice if a later ticket's own tools need MCP-level session
 * continuity (e.g. server-initiated notifications tied to one client) —
 * not assumed here.
 *
 * ## Localhost-only, belt and suspenders
 *
 * The route inherits `server.ts`'s own `127.0.0.1` binding (this module
 * adds no network exposure of its own — `sprint.md`'s Migration Concerns,
 * "Security"). On top of that, the SDK's own `localhostHostValidation()`
 * middleware (DNS-rebinding protection: rejects a request whose `Host`
 * header names anything other than `localhost`/`127.0.0.1`/`[::1]`) is
 * applied to every method on this route — a small, free defense the SDK
 * ships specifically for exactly this kind of unauthenticated localhost
 * server, directly in the spirit of this sprint's explicit scope
 * exclusion ("remote/non-localhost MCP access ... out of scope" — this
 * closes that door a little further, at no cost).
 *
 * ## Injectable seams
 *
 * Mirrors `server.ts`'s own `createWebSocketServer` convention:
 * {@link StartMcpServerOptions.createMcpServer}/`createTransport` default
 * to the real SDK classes; `mcp/server.test.ts` overrides both with fakes
 * so it never touches a real HTTP port (this ticket's own acceptance
 * criterion) — the real end-to-end protocol behavior (tool listing,
 * Zod validation, `tools/call`) is instead covered by
 * `mcp/tools/inspect.test.ts`'s `InMemoryTransport`-based tests (no
 * sockets, but the real SDK protocol machinery) and by this ticket's own
 * documented live smoke test against a real running host.
 */
import type { Express, Request, Response } from "express";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { localhostHostValidation } from "@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { registerInspectTools, type InspectStore } from "./tools/inspect.js";

/** Default mount path for the MCP Streamable HTTP endpoint. */
export const DEFAULT_MCP_PATH = "/mcp";

/** Client-visible `serverInfo.name`/`version` — cosmetic (shown by an MCP
 * client's own UI/logs, never parsed by this codebase). Not tied to
 * `packages/host/package.json`'s own version; bump by hand if it ever
 * matters enough to track. */
const SERVER_NAME = "robot-console";
const SERVER_VERSION = "0.1.0";

/** The narrow slice of the real `StreamableHTTPServerTransport` this
 * module actually uses — the full {@link Transport} contract `McpServer
 * .connect` requires (`start`/`send`/`close`), plus the one method that
 * is specific to the Node HTTP transport, `handleRequest`.
 * {@link StreamableHTTPServerTransport} satisfies this structurally;
 * `mcp/server.test.ts` substitutes a fake (trivial no-op `start`/`send`)
 * so no real Node HTTP request/response plumbing is ever exercised there
 * (this ticket's own "never touches a real HTTP port" acceptance
 * criterion). */
export interface McpTransportLike extends Pick<Transport, "start" | "send" | "close"> {
  handleRequest(req: Request, res: Response, parsedBody?: unknown): Promise<void>;
}

export interface StartMcpServerOptions {
  /** Path to mount the Streamable HTTP endpoint at. Defaults to
   * {@link DEFAULT_MCP_PATH}. */
  path?: string;
  /** Builds one {@link McpServer} per request (stateless mode — see the
   * module doc comment). Defaults to a fresh `McpServer` with
   * {@link registerInspectTools} already registered against `store`. */
  createMcpServer?: () => McpServer;
  /** Builds one transport per request. Defaults to a real
   * `new StreamableHTTPServerTransport({sessionIdGenerator: undefined})`.
   * Injectable so `mcp/server.test.ts` never has to satisfy the real
   * transport's Node HTTP expectations with a fake `req`/`res`. */
  createTransport?: () => McpTransportLike;
}

export interface StartedMcpServer {
  /** The path this instance mounted at (echoes {@link StartMcpServerOptions.path}
   * or the default) — exposed for tests/logging, not consulted by this
   * module itself once mounting is done. */
  readonly path: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function methodNotAllowed(_req: Request, res: Response): void {
  res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null });
}

/**
 * Mounts the MCP Streamable HTTP endpoint on `app` (see the module doc
 * comment). Synchronous — registering Express routes has no async step of
 * its own; a request is only ever handled once `app`'s owning
 * `httpServer` actually starts listening (`server.ts`'s `startServer`,
 * called after `startRuntime()` resolves — `sprint.md`'s Migration
 * Concerns, "Deployment sequencing": no window where an MCP call could
 * race store construction).
 */
/** The real default {@link StartMcpServerOptions.createMcpServer}: a
 * fresh {@link McpServer} with every inspect tool registered against
 * `store`. Exported (not just inlined in {@link startMcpServer}) so
 * `server.test.ts` can exercise exactly this wiring directly over a real
 * `InMemoryTransport` pair without going through the Express layer at
 * all. */
export function createDefaultMcpServer(store: InspectStore): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  registerInspectTools(server, store);
  return server;
}

export function startMcpServer(app: Express, store: InspectStore, options: StartMcpServerOptions = {}): StartedMcpServer {
  const path = options.path ?? DEFAULT_MCP_PATH;
  const createMcpServer = options.createMcpServer ?? (() => createDefaultMcpServer(store));
  // Stateless mode (module doc comment): the key is omitted entirely,
  // not set to `undefined` -- with `exactOptionalPropertyTypes` (this
  // project's tsconfig), the option's own type is `() => string` with no
  // `| undefined`, so an explicit `sessionIdGenerator: undefined` would
  // not typecheck even though the SDK itself treats "key absent" and "key
  // present with value undefined" identically at runtime
  // (`webStandardStreamableHttp.js`: `this.sessionIdGenerator =
  // options.sessionIdGenerator`, then every read checks `=== undefined`).
  // Typed explicitly as `() => McpTransportLike` (not left to be inferred
  // as a union with the concrete `StreamableHTTPServerTransport` return
  // type): under this project's `exactOptionalPropertyTypes`, the real
  // class's `onclose`/`onerror` accessors (settable to `undefined`) are
  // not assignable to `Transport`'s own stricter "optional, but never
  // literally `undefined` when present" contract -- narrowing to
  // `McpTransportLike` (which does not mention those properties at all)
  // sidesteps that mismatch entirely; `McpTransportLike -> Transport`
  // remains a clean assignment below since a genuinely absent optional
  // property is always fine.
  const createTransport: () => McpTransportLike = options.createTransport ?? (() => new StreamableHTTPServerTransport({}));

  const hostValidation = localhostHostValidation();

  app.post(path, express.json(), hostValidation, async (req: Request, res: Response) => {
    const mcpServer = createMcpServer();
    try {
      const transport = createTransport();
      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, req.body as unknown);
      res.on("close", () => {
        void transport.close();
        void mcpServer.close();
      });
    } catch (error) {
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: `internal error: ${errorMessage(error)}` },
          id: null,
        });
      }
    }
  });

  // Stateless mode issues no session id and holds no server-initiated
  // stream open across requests, so there is nothing for a GET (resume a
  // stream) or DELETE (terminate a session) to act on -- both reject
  // plainly, mirroring the SDK's own stateless example.
  app.get(path, hostValidation, methodNotAllowed);
  app.delete(path, hostValidation, methodNotAllowed);

  return { path };
}
