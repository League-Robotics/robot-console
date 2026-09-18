---
id: '004'
title: MCP server scaffolding and inspect tools (Streamable HTTP, list_devices, get_device_status)
status: open
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

- [ ] `@modelcontextprotocol/sdk` (or equivalent) is added as a
      `packages/host` dependency, with the exact version pinned and
      recorded in this ticket's implementation notes.
- [ ] `packages/host/src/mcp/server.ts` mounts an MCP Streamable HTTP
      endpoint on the existing Express app (the same one `server.ts`
      constructs), started from `cli.ts`'s `main()` after
      `startRuntime()` resolves and before/alongside `startServer()` —
      no window exists where an MCP call could race store construction.
- [ ] The MCP server is injectable via `runtime.ts`/`cli.ts`'s existing
      "real defaults, fakes in tests" seam convention (mirrors
      `StartRuntimeOptions`) — `mcp/server.test.ts` never touches a real
      HTTP port.
- [ ] `list_devices` tool: returns a devices/links summary consistent
      with the same store rows `projection.ts`'s `Snapshot` reads (not
      necessarily the identical shape — an MCP-appropriate JSON shape is
      fine — but no field disagrees with the store).
- [ ] `get_device_status {name}` (or `{id}`) tool: single-device detail
      including current link states and, if a session is open, its
      `robotStatus`/`functions` — same source rows as the browser page.
- [ ] Neither tool writes to `links`, `sessions`, `board_owner`, or
      `relay_leases` under any input, including malformed input
      (asserted by a test, not just by code review).
- [ ] Tool input schemas are designed so every optional field has a
      well-defined absent representation that survives the harness's
      documented empty-argument bug (`.claude/rules/tool-call-empty-
      args.md`) — e.g., prefer required fields with sensible defaults
      applied server-side over optional fields with no value, and if an
      optional field is unavoidable, document that callers should omit
      the key entirely rather than send `""`/`null`. State in the
      implementation notes how each tool's schema addresses this.
- [ ] A live smoke test (can be manual, documented in this ticket's
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
