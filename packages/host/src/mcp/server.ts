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
 * ## Session continuity (sprint 019 ticket 005 revisits this)
 *
 * Ticket 004 originally gave every POST a fresh {@link McpServer} +
 * `StreamableHTTPServerTransport` pair with no session id issued at all
 * ("stateless mode") — the right shape for an inspect-only tool surface
 * with no server-initiated stream and no cross-request state to resume.
 * That module doc comment named exactly the condition under which this
 * would need revisiting: "ticket 005's connect/command tools are the
 * first to need any session concept ... revisit this choice if a later
 * ticket's own tools need MCP-level session continuity."
 *
 * They do, and not for a stream — for `mcp/tools/connect.ts`'s own
 * caller-identity read (`server.server.getClientVersion()`, populated by
 * the `initialize` request's `clientInfo`). Under full statelessness that
 * read is always `undefined` at `tools/call` time: a real
 * `StreamableHTTPClientTransport`/`Client` issues `initialize`,
 * `notifications/initialized`, and every subsequent `tools/call` as
 * *three separate POSTs* (confirmed empirically against the real SDK
 * before writing this), and with a fresh ephemeral server per POST, the
 * one that eventually handles `tools/call` never itself processed
 * `initialize`.
 *
 * `createTransport`'s default now passes a real `sessionIdGenerator`
 * (`randomUUID`), and `startMcpServer` keeps a `Map<sessionId,
 * {server, transport}>` for the lifetime of this process: a POST with no
 * `Mcp-Session-Id` header creates a fresh pair as before, but once that
 * pair issues a session id (i.e. the request was `initialize`), the pair
 * is kept and reused for every later request carrying that same id —
 * mirroring the SDK's own bundled stateful example
 * (`dist/esm/examples/server/simpleStreamableHttp.js`) rather than
 * inventing a new pattern. A POST that never negotiates a session at all
 * (no header, and the transport's own request turns out not to be
 * `initialize` — rejected by the transport itself per its own stateful-
 * mode contract) still closes immediately once the response finishes,
 * exactly like ticket 004's original one-shot behavior — so a test (or a
 * genuinely one-shot caller) that fakes `createTransport`/
 * `createMcpServer` with no real `sessionId` concept keeps working
 * unchanged. A POST carrying an `Mcp-Session-Id` this process does not
 * recognize (a foreign id, or a stale one from before a restart) is
 * rejected with a plain 400 rather than silently starting a fresh
 * session under a caller-chosen id it never issued.
 *
 * No eviction policy exists yet for a session that never explicitly
 * closes (GET/DELETE remain unconditional 405s below — see that
 * section) — a long-lived MCP client session holds its `McpServer`/
 * transport pair in memory for this host process's lifetime. Acceptable
 * for now: this is a local dev tool with a handful of agent connections
 * per run, not a multi-tenant server; revisit if that stops being true.
 *
 * ## Host-header allowlist, not disabling DNS-rebinding protection outright
 *
 * `server.ts`'s own `DEFAULT_HOST` widened to `0.0.0.0` (sprint 021
 * ticket 002 — see that constant's own doc comment for the accepted-risk
 * framing): this route now inherits a LAN-reachable socket, not a
 * localhost-only one. Binding wider alone is not sufficient to let a
 * legitimate LAN-originated MCP call through, though — the SDK's own
 * `localhostHostValidation()` (DNS-rebinding protection: rejects a
 * request whose `Host` header names anything other than
 * `localhost`/`127.0.0.1`/`[::1]`) would still 403 every such call, since
 * a LAN caller's `Host` header names this machine's own hostname or LAN
 * IP, never `localhost`. Per sprint.md's Design Rationale ("Host-header
 * allowlist, not disabling DNS-rebinding protection outright"): this
 * module widens the allowlist instead of dropping the check — the SDK's
 * `hostHeaderValidation(allowedHostnames)` (the general form
 * `localhostHostValidation()` itself is built on) is called with the
 * three original localhost forms plus this machine's own hostname,
 * `<hostname>.local`, and every non-internal IPv4 address
 * {@link nonInternalIPv4Addresses} reports — see {@link
 * buildMcpHostAllowlist}. The check itself, and the defense it provides
 * against a hostile *third-party* domain's `Host` header (DNS rebinding
 * proper), is unchanged; only the set of hostnames a legitimate caller
 * may already be using is widened to match the now-wider bind.
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
import os from "node:os";
import { randomUUID } from "node:crypto";
import type { Express, Request, Response } from "express";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { hostHeaderValidation } from "@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { registerInspectTools, type InspectStore } from "./tools/inspect.js";
import { registerConnectTools, type ConnectToolsReconciler, type ConnectToolsStore } from "./tools/connect.js";
import { registerDriveTools } from "./tools/drive.js";
import { registerFlashTools } from "./tools/flash.js";
import type { AgentActionLogStore } from "./agentActionLog.js";
import type { StartFlashFn } from "../server.js";
import type { DaplinkDeviceLister } from "../devices.js";

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

/**
 * Reads a transport's own negotiated session id, if any -- deliberately
 * *not* a declared member of {@link McpTransportLike} itself. `Transport`'s
 * own `sessionId?: string` (no explicit `| undefined`) and the real
 * `StreamableHTTPServerTransport`'s own getter (typed `string |
 * undefined`) cannot both satisfy one shared property declaration under
 * this project's `exactOptionalPropertyTypes` -- the same class of
 * conflict ticket 004's own comment already documented for `onclose`/
 * `onerror` (settable to `undefined`, also not assignable to
 * `Transport`'s stricter contract) and solved the same way: keep the
 * property off the shared interface and reach it through a narrow,
 * explicitly-commented cast instead. A test's fake transport can still
 * carry a plain `sessionId` field on its own object literal -- this
 * function reads it the same way regardless of whether the concrete
 * value is a real `StreamableHTTPServerTransport` or a fake.
 */
function sessionIdOf(transport: McpTransportLike): string | undefined {
  return (transport as unknown as { sessionId?: string }).sessionId;
}

/** The combined store/reconciler dependencies every registered tool
 * category needs — `registerInspectTools`'s own narrow {@link
 * InspectStore} plus `registerConnectTools`'s own {@link
 * ConnectToolsStore}/{@link ConnectToolsReconciler} (sprint 019 ticket
 * 005), plus `registerDriveTools`'s own {@link AgentActionLogStore} need
 * (sprint 019 ticket 007 — `registerDriveTools`'s own reconciler need,
 * `DriveToolsReconciler`, is already exactly `ConnectToolsReconciler`'s
 * `sessions` field, so no widening is needed on that side), plus
 * `registerFlashTools`'s own `startFlash`/`enumerateDaplinkDevices` need
 * (sprint 019 ticket 008 -- `server.ts`'s own extracted `startFlash`,
 * handed down through `mountRoutes`'s `MountRoutesExtra`, not
 * reconstructed here). Each tool module still only receives the narrow
 * slice its own type declares — this interface exists solely so
 * `startMcpServer`'s own caller (`cli.ts`) has one thing to construct
 * and pass down, not because any tool module itself needs the union. */
export interface McpDeps {
  readonly store: InspectStore & ConnectToolsStore & AgentActionLogStore;
  readonly reconciler: ConnectToolsReconciler;
  /** The exact `startFlash` `server.ts`'s own `flash-start` WS handler
   * calls -- see `server.ts`'s `MountRoutesExtra`/`StartFlashFn` doc
   * comments. */
  readonly startFlash: StartFlashFn;
  /** The exact USB enumerator `startFlash` itself was built with, so
   * `mcp/tools/flash.ts`'s own precondition check
   * ({@link resolveFlashLinkTarget}) sees the same result `startFlash`
   * would. */
  readonly enumerateDaplinkDevices: DaplinkDeviceLister;
}

export interface StartMcpServerOptions {
  /** Path to mount the Streamable HTTP endpoint at. Defaults to
   * {@link DEFAULT_MCP_PATH}. */
  path?: string;
  /** Builds one {@link McpServer} per *session* (see the module doc
   * comment's "Session continuity" section — despite the name, this is
   * called once per negotiated session, not once per POST). Defaults to
   * a fresh `McpServer` with every tool category registered against
   * `deps`. */
  createMcpServer?: () => McpServer;
  /** Builds one transport per session-negotiation attempt. Defaults to a
   * real `new StreamableHTTPServerTransport({sessionIdGenerator: () =>
   * randomUUID()})`. Injectable so `mcp/server.test.ts` never has to
   * satisfy the real transport's Node HTTP expectations with a fake
   * `req`/`res`; a fake whose own `sessionId` field {@link sessionIdOf}
   * reads as absent exercises the same "close immediately, no session
   * kept" path as ticket 004's original tests. */
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
 * fresh {@link McpServer} with every tool category registered against
 * `deps`. Exported (not just inlined in {@link startMcpServer}) so
 * `server.test.ts` can exercise exactly this wiring directly over a real
 * `InMemoryTransport` pair without going through the Express layer at
 * all. */
export function createDefaultMcpServer(deps: McpDeps): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  registerInspectTools(server, deps.store);
  registerConnectTools(server, deps);
  registerDriveTools(server, deps);
  registerFlashTools(server, deps);
  return server;
}

/** One negotiated MCP session's own server/transport pair — see the
 * module doc comment's "Session continuity" section. */
interface McpSessionEntry {
  readonly server: McpServer;
  readonly transport: McpTransportLike;
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Every non-internal IPv4 address `os.networkInterfaces()` reports right
 * now — the "every non-internal IPv4 address" clause of {@link
 * buildMcpHostAllowlist}'s own allowlist (see the module doc comment's
 * "Host-header allowlist" section). Excludes loopback/internal
 * interfaces (`info.internal`) and every IPv6 address — a `Host` header
 * never carries a bare IPv6 literal without brackets, and this project's
 * bench LAN is IPv4 (`sprint.md`'s own "the bench spans subnets ...
 * 192.168.x.x" framing); an IPv6 LAN address would need bracket handling
 * this allowlist does not attempt.
 *
 * Takes `interfaces` as a parameter (defaulting to a fresh real
 * `os.networkInterfaces()` call) rather than reading the real function
 * directly, so `mcp/server.test.ts` can drive this against a fake
 * interface map without mocking the `"node:os"` module itself —
 * mirrors this codebase's "injectable seam, real default" convention
 * elsewhere (`server.ts`'s own `createWebSocketServer`,
 * `mdnsDiscovery.ts`'s `createBonjourBackend`).
 */
export function nonInternalIPv4Addresses(interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces()): string[] {
  const addresses: string[] = [];
  for (const infos of Object.values(interfaces)) {
    for (const info of infos ?? []) {
      if (info.family === "IPv4" && !info.internal) {
        addresses.push(info.address);
      }
    }
  }
  return addresses;
}

/**
 * The MCP Host-header allowlist — see the module doc comment's
 * "Host-header allowlist" section. `hostname`/`interfaces` default to
 * real `os.hostname()`/`os.networkInterfaces()` calls; {@link
 * startMcpServer} calls this exactly once, at startup (mounting the
 * route), not per request — a request cannot change which interfaces
 * this machine has mid-flight, so re-reading it on every POST would be
 * pure waste. Exported (with explicit parameters) so
 * `mcp/server.test.ts` can assert its exact contents against fake
 * `os.hostname()`/`os.networkInterfaces()` values.
 */
export function buildMcpHostAllowlist(
  hostname: string = os.hostname(),
  interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces(),
): string[] {
  return ["localhost", "127.0.0.1", "[::1]", hostname, `${hostname}.local`, ...nonInternalIPv4Addresses(interfaces)];
}

export function startMcpServer(app: Express, deps: McpDeps, options: StartMcpServerOptions = {}): StartedMcpServer {
  const path = options.path ?? DEFAULT_MCP_PATH;
  const createMcpServer = options.createMcpServer ?? (() => createDefaultMcpServer(deps));
  // A real session id generator, not the omitted-key stateless default
  // ticket 004 used -- see the module doc comment's "Session continuity"
  // section for why this ticket needs one. Typed explicitly as
  // `() => McpTransportLike` for the same `exactOptionalPropertyTypes`
  // reasons ticket 004's own version of this line documented (the real
  // class's `onclose`/`onerror` accessors are not assignable to
  // `Transport`'s stricter optional-property contract; narrowing to
  // `McpTransportLike`, which does not mention them, sidesteps that).
  const createTransport: () => McpTransportLike = options.createTransport ?? (() => new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() }));

  // Sprint 021 ticket 002: widens the allowlist itself rather than
  // dropping the check -- see the module doc comment's "Host-header
  // allowlist" section and buildMcpHostAllowlist's own doc comment.
  const hostValidation = hostHeaderValidation(buildMcpHostAllowlist());

  // Sprint 019 ticket 005: kept for the lifetime of this process -- see
  // the module doc comment's own "no eviction policy yet" note.
  const sessions = new Map<string, McpSessionEntry>();

  app.post(path, express.json(), hostValidation, async (req: Request, res: Response) => {
    const sessionId = firstHeaderValue(req.headers?.["mcp-session-id"]);
    const existing = sessionId !== undefined ? sessions.get(sessionId) : undefined;
    try {
      if (existing !== undefined) {
        // A request for an already-negotiated session -- reuse its own
        // server/transport pair (already connected) rather than building
        // a fresh one, so this is the *same* `Server` instance whose
        // `getClientVersion()` `mcp/tools/connect.ts` reads.
        await existing.transport.handleRequest(req, res, req.body as unknown);
        return;
      }
      if (sessionId !== undefined) {
        // A session id was given but this process holds no such session
        // (a foreign id, or -- far more commonly -- a stale one from
        // before a restart, since sessions live only in this process's
        // memory). Still refused: never silently adopt an id this
        // process never issued.
        //
        // **404, not 400.** The Streamable HTTP spec has clients treat
        // 404 as "this session is gone, start a new one by sending
        // `initialize` again", while a 400 reads as "your request was
        // malformed" and leaves a client retrying the same dead id
        // forever. A peer session hit exactly that after a dev-server
        // restart: every call came back "Bad Request: unknown MCP
        // session id", it could not diagnose through MCP at all, and
        // went around via the radio relay instead. The message now says
        // what to do, for a human reading a log.
        res.status(404).json({
          jsonrpc: "2.0",
          error: {
            code: -32001,
            message: "Unknown or expired MCP session id -- send `initialize` again to start a new session.",
          },
          id: null,
        });
        return;
      }
      const mcpServer = createMcpServer();
      const transport = createTransport();
      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, req.body as unknown);
      const negotiatedSessionId = sessionIdOf(transport);
      if (negotiatedSessionId !== undefined) {
        // This request negotiated a new session (i.e. it was
        // `initialize`) -- keep the pair alive for every later request
        // carrying this same id, instead of closing it once this
        // response finishes.
        sessions.set(negotiatedSessionId, { server: mcpServer, transport });
      } else {
        // No session negotiated: either a one-shot caller whose request
        // was not `initialize` (the transport's own stateful-mode
        // validation rejects it directly, matching ticket 004's original
        // behavior for this shape of call) or a test's fake transport
        // with no real session concept -- close immediately once the
        // response finishes, exactly as ticket 004 always did.
        res.on("close", () => {
          void transport.close();
          void mcpServer.close();
        });
      }
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

  // No tool this sprint needs a server-initiated SSE stream (GET) or an
  // explicit session-termination request (DELETE) -- both reject
  // plainly, same as ticket 004's original fully-stateless behavior
  // (the reason changes slightly now that sessions exist -- "nothing yet
  // *uses* a stream/explicit terminate" rather than "no session concept
  // exists at all" -- but the wire behavior is identical). A session
  // that never receives a graceful DELETE just outlives its own last
  // request, per this module's own "no eviction policy yet" note.
  app.get(path, hostValidation, methodNotAllowed);
  app.delete(path, hostValidation, methodNotAllowed);

  return { path };
}
