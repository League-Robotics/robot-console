---
id: '004'
title: MCP server scaffolding and inspect tools (Streamable HTTP, list_devices, get_device_status)
status: done
use-cases:
- SUC-004
depends-on:
- '001'
- '002'
- '003'
github-issue: ''
issue: mcp-server-for-robot-connections.md
completes_issue: false
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# MCP server scaffolding and inspect tools (Streamable HTTP, list_devices, get_device_status)

## Description

First ticket of the MCP subsystem (`clasi/issues/mcp-server-for-robot-
connections.md`). Stands up the MCP server itself and the read-only
inspect category — deliverable and independently useful before any
connect/drive/flash tool exists, per this sprint's own sequencing
constraint (inspect-only usable before connect/command, before
drive/flash).

Per `sprint.md`'s Architecture: the MCP server is a new module inside
`packages/host` (`src/mcp/`), not a new sibling workspace package (see
Design Rationale — avoids a package cycle with `cli.ts`'s composition
root). Transport is Streamable HTTP mounted on the existing Express app
`server.ts` already runs, bound to the same `127.0.0.1` default
(`server.ts:138`, `DEFAULT_HOST`) — **not** stdio, because stdio spawns
a new child process per client, which recreates exactly the two-
processes-fighting-over-one-resource shape tickets 001-003 just fixed
for the relay/WiFi/harvester paths, applied to the whole host.

Depends on tickets 001-003: not because the code is coupled, but because
the MCP connect/command tools this subsystem builds toward sit on top of
the relay-lease and WiFi-discovery paths those tickets fix, and Eric's
own sequencing direction is foundation-fixes-first. This ticket itself
only needs read access to the store and could technically run standalone
— the dependency is sequencing discipline, stated explicitly per this
sprint's own instruction to do so rather than silently reordering.

`completes_issue: false` — this is the first of six tickets (004-009)
against the one `mcp-server-for-robot-connections.md` issue; only the
last (009) should trigger archival once every referencing ticket is
done (the tool's own default already requires that; this ticket's flag
is set for clarity, matching this sprint's evidence discipline rather
than relying silently on the default).

## Acceptance Criteria

- [x] `@modelcontextprotocol/sdk` (or equivalent) is added as a
      `packages/host` dependency, with the exact version pinned and
      recorded in this ticket's implementation notes.
- [x] `packages/host/src/mcp/server.ts` mounts an MCP Streamable HTTP
      endpoint on the existing Express app (the same one `server.ts`
      constructs), started from `cli.ts`'s `main()` after
      `startRuntime()` resolves and before/alongside `startServer()` —
      no window exists where an MCP call could race store construction.
- [x] The MCP server is injectable via `runtime.ts`/`cli.ts`'s existing
      "real defaults, fakes in tests" seam convention (mirrors
      `StartRuntimeOptions`) — `mcp/server.test.ts` never touches a real
      HTTP port.
- [x] `list_devices` tool: returns a devices/links summary consistent
      with the same store rows `projection.ts`'s `Snapshot` reads (not
      necessarily the identical shape — an MCP-appropriate JSON shape is
      fine — but no field disagrees with the store).
- [x] `get_device_status {name}` (or `{id}`) tool: single-device detail
      including current link states and, if a session is open, its
      `robotStatus`/`functions` — same source rows as the browser page.
- [x] Neither tool writes to `links`, `sessions`, `board_owner`, or
      `relay_leases` under any input, including malformed input
      (asserted by a test, not just by code review).
- [x] Tool input schemas are designed so every optional field has a
      well-defined absent representation that survives the harness's
      documented empty-argument bug (`.claude/rules/tool-call-empty-
      args.md`) — e.g., prefer required fields with sensible defaults
      applied server-side over optional fields with no value, and if an
      optional field is unavoidable, document that callers should omit
      the key entirely rather than send `""`/`null`. State in the
      implementation notes how each tool's schema addresses this.
- [x] A live smoke test (can be manual, documented in this ticket's
      closing notes) connects an actual MCP client (e.g. `claude mcp
      add` against a running `npx robot-console`, or the SDK's own test
      client) and calls both tools successfully.

## Implementation Plan

**Approach**: build the thinnest possible transport + registry first
(`mcp/server.ts`), then the two inspect tools as the first real content,
proving the whole plumbing (SDK wiring, Express mounting, store access)
before any tool with side effects exists.

**Files to create**:
- `packages/host/src/mcp/server.ts` — Streamable HTTP mount, tool
  registry, `startMcpServer(app, store, ...)`-shaped factory mirroring
  `server.ts`'s own `startServer` seam.
- `packages/host/src/mcp/tools/inspect.ts` — `list_devices`,
  `get_device_status`.

**Files to modify**:
- `packages/host/package.json` — add the MCP SDK dependency.
- `packages/host/src/cli.ts` — call the new `startMcpServer` alongside
  `startServer`, injectable via `CliDeps` the same way every other
  collaborator already is.
- `packages/host/src/runtime.ts` — only if the MCP server needs anything
  from `Runtime` beyond `store` (e.g., a shutdown hook) — keep the
  addition minimal and additive.

**Testing plan**:
- Scoped `vitest` run: new `mcp/server.test.ts`, `mcp/tools/
  inspect.test.ts`, `cli.test.ts` — not the full suite.
- Fake store fixture (mirrors the existing "fake enumerator / fake
  bonjour backend → assert rows" convention from
  `docs/design/architecture.md` §11) — no real device/HID/serial I/O.
- Golden-comparison test: seed the same rows a `projection.test.ts`
  golden-snapshot test uses, assert `list_devices`/`get_device_status`
  agree with the browser's own `Snapshot` for that state.
- Live smoke test against a real running host, documented manually.

## Documentation Updates

- `docs/design/architecture.md` should eventually gain an MCP section
  once the whole subsystem (through ticket 008) is in — defer that
  single consolidated update to ticket 009 rather than editing the
  architecture doc once per ticket.

## Implementation Notes

**SDK version pinned**: `@modelcontextprotocol/sdk` `1.30.0` (exact, no
caret), plus `zod` `^4.6.5` (its own required peer dependency, `^3.25 ||
^4.0`). Express-mountability was verified by downloading the real
1.30.0 tarball (`npm pack`) and reading its own shipped example,
`dist/esm/examples/server/simpleStatelessStreamableHttp.js`: it mounts
`app.post('/mcp', ...)` on a plain Express app, constructing a fresh
`StreamableHTTPServerTransport({sessionIdGenerator: undefined})` per
request and calling `transport.handleRequest(req, res, req.body)` — the
exact shape this ticket's `mcp/server.ts` follows. This was read
directly from the installed package, not assumed from `sprint.md`'s own
"confirmed supported as of this writing" hedge.

**Module layout under `src/mcp/`** (for tickets 005-008 to follow):
- `mcp/server.ts` — `startMcpServer(app, store, options?)`: mounts
  POST/GET/DELETE on the Streamable HTTP path (stateless mode — a fresh
  `McpServer`+transport per request, since inspect has no session
  concept of its own); exports `createDefaultMcpServer(store)` separately
  so a later ticket's own server test can exercise real tool wiring over
  an `InMemoryTransport` without touching Express at all. Injectable
  `createMcpServer`/`createTransport` seams mirror `server.ts`'s own
  `createWebSocketServer` convention.
- `mcp/tools/inspect.ts` — `registerInspectTools(server, store)`, plus an
  exported `InspectStore = Pick<Store, "projectionRows">` narrowing type.
  Later tickets should add their own `mcp/tools/<category>.ts` with a
  `register<Category>Tools(server, deps)` function and their own narrow
  `Pick<Store, ...>` type for exactly the store operations that category
  needs (005's `ConnectStore` would pick `projectionRows` plus whatever
  `openSession`-equivalent it calls) — `cli.ts`/`mcp/server.ts` wire them
  in the same way this ticket wires inspect's.

**Schema design against the empty-argument bug**
(`.claude/rules/tool-call-empty-args.md`):
- `list_devices` takes **no arguments at all** (no `inputSchema` key). A
  `{}` call — the bug's own worst-case output — is this tool's only
  valid input, not a degraded one.
- `get_device_status` takes exactly **one required** field, `name: z
  .string().min(1)` — no optional companion `id` field. A call arriving
  as `{}` or `{name: ""}` fails Zod validation before the handler runs;
  the MCP SDK's own `validateToolInput` converts that into an ordinary
  `CallToolResult` with `isError: true` (never a thrown/rejected
  exception — verified directly by reading `dist/esm/server/mcp.js`'s
  `setToolRequestHandlers`/`createToolError`), so a caller gets a clean,
  actionable error rather than a crash or a wrong-device answer.
  Verified by both `mcp/tools/inspect.test.ts` (via a real
  `InMemoryTransport`+`Client` round trip) and the live smoke test below.

**No writes, asserted by test**: `mcp/tools/inspect.test.ts` spies on
the real `Store` class's own `upsertLink`/`setLinkState`/`deleteLink`
(links), `openSession`/`updateSession`/`closeSession` (sessions),
`acquireBoardOwner`/`releaseBoardOwner` (board_owner), and
`acquireRelayLease`/`releaseRelayLease` (relay_leases), across valid,
unknown-name, empty-string, and missing-key calls to both tools, and
asserts none are ever called.

**Deviation from the Files-to-modify list**: `packages/host/src/server.ts`
was also touched, which the Implementation Plan above did not list. This
turned out to be structurally necessary, not optional: Express matches
routes in registration order, and `server.ts`'s own SPA catch-all
(`app.get(/.*/, ...)`) is registered synchronously inside `startServer`,
before it returns anything a caller could mount a route onto — there is
no point after `startServer` resolves where a new route could still win
against that catch-all. The fix is a small, generic, MCP-agnostic
addition: `StartServerOptions.mountRoutes?: (app: Express) => void`,
invoked in `buildApp` before the static/catch-all registration.
`cli.ts` passes `startMcpServer` wrapped in this hook. Covered by three
new cases in `server.test.ts` (`describe("server.ts: mountRoutes")`).
`runtime.ts` needed no change — `Runtime.store` already exposes
`projectionRows()`, which is all `InspectStore` needs.

**Live smoke test** (manual, against a real running host): started
`node bin/robot-console.js --no-open --port 47955` with
`ROBOT_CONSOLE_STATE_DIR` pointed at a scratch temp directory (no real
`console.sqlite` touched), then ran a small Node script using the SDK's
own `Client`/`StreamableHTTPClientTransport` against
`http://127.0.0.1:47955/mcp`. Observed: `initialize` succeeded
(`serverInfo: {name: "robot-console", version: "0.1.0"}`);
`tools/list` returned exactly `["get_device_status", "list_devices"]`;
`list_devices` returned real live data (a `torture` relay this bench's
own mDNS discovered — read-only, no session opened, no lease taken);
`get_device_status` for an unknown name returned a clean `isError: true`
result naming the device; `get_device_status` called with `{}` returned
`isError: true` (the empty-argument-bug simulation); a plain `GET`/
`DELETE` to `/mcp` both returned `405`. The host process (PID owned by
this session) was stopped afterward; no other process was signaled.

**Scoped test results** (foreground, this ticket's own modules only —
not the full suite, per this project's own testing convention):
`mcp/server.test.ts` (11), `mcp/tools/inspect.test.ts` (8),
`cli.test.ts` (19), `server.test.ts` (48) — 86/86 passing. Also ran
`npm run typecheck` (passes) and `npm run build` (passes, since a new
dependency was added).
