---
id: '002'
title: Bind the console host to the LAN, self-advertise over mDNS, and widen the MCP
  host-header allowlist
status: done
use-cases:
- SUC-001
- SUC-005
depends-on:
- '001'
github-issue: ''
issue: shared-console-host-daemon-cli-and-discovery.md
completes_issue: true
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Bind the console host to the LAN, self-advertise over mDNS, and widen the MCP host-header allowlist

## Description

With ticket 001's double-start protection in place, this ticket does
the actual LAN-reachability work: bind beyond `127.0.0.1`, advertise the
host so it can be found, and fix the MCP transport's own Host-header
check so a LAN-originated MCP request is not silently rejected even
though the socket itself now accepts it.

Per sprint.md's Design Rationale ("Bind address: 0.0.0.0, not one chosen
interface"): the bench spans subnets (Mac 192.168.1.x, `naught`
192.168.4.x) and named fixtures move between them over time, so this
ticket does not attempt to pick "the" LAN interface — it binds every
interface and lets mDNS (which is already link-local-per-interface by
design) handle discovery from whichever subnet a client is actually on.

Work:

1. In `server.ts`, change `DEFAULT_HOST` from the hard-coded
   `"127.0.0.1"` constant to `"0.0.0.0"`. Update the constant's own doc
   comment (it currently states the opposite rationale — "this process
   can open serial ports and drive a physical robot, so it must never be
   reachable from anything but the machine it runs on" — replace with a
   pointer to sprint.md's Design Rationale and the stakeholder's own
   accepted-risk framing, not silently overwrite the reasoning).
2. Add `packages/host/src/discovery/consoleAdvertiser.ts`: a `start
   ConsoleAdvertiser({port, backend?}) -> {stop(): void}` that calls an
   injectable `Bonjour`-shaped backend's `publish({name: os.hostname(),
   type: "robotconsole", protocol: "tcp", port})` and returns a `stop()`
   that calls `unpublish()`/`destroy()`. Default backend: the real
   `bonjour-service` `Bonjour` (already a dependency — no new package),
   lazily constructed on first `start` call, mirroring
   `mdnsDiscovery.ts`'s own `createBonjourBackend` "import is free,
   construction is not" convention. Tests inject a fully synthetic fake
   (mirroring `MdnsBackend`'s own test fakes) — no real multicast socket
   in unit tests.
3. In `cli.ts`'s `main()`, after `startServer` resolves, call
   `startConsoleAdvertiser({port: server.port})` and stop it inside the
   existing `installShutdownHandlers` shutdown path (alongside
   `server.close()`/`runtime.stop()`), so a clean shutdown withdraws the
   advertisement (mDNS "goodbye") rather than leaving it to expire on
   its own TTL.
4. In `mcp/server.ts`, replace `localhostHostValidation()` with the
   SDK's own `hostHeaderValidation(allowedHostnames)`, called with
   `["localhost", "127.0.0.1", "[::1]", os.hostname(), \`${os.hostname()}.local\`,
   ...nonInternalIPv4Addresses()]`, where `nonInternalIPv4Addresses()` is
   a small new helper reading `os.networkInterfaces()` once at startup
   (not per-request) and returning every non-internal IPv4 address found
   — this is what actually makes a LAN-originated MCP request pass the
   SDK's DNS-rebinding check once the socket itself is reachable (bind
   alone is not sufficient — see sprint.md's Design Rationale, "Host-
   header allowlist, not disabling DNS-rebinding protection outright").
   Update the module's own "Localhost-only, belt and suspenders" doc
   comment section to describe the new allowlist rather than leaving it
   claiming a `127.0.0.1`-only bind that is no longer true.
5. Update `docs/design/architecture.md` §13.2 is **not** touched by this
   ticket (sprint.md's own Migration Concerns: consolidated at sprint
   close, not mid-sprint) — do not edit it here.

## Acceptance Criteria

- [x] `startServer` binds `0.0.0.0` by default; a client connecting via
      a non-loopback address on the same machine reaches the WS/HTTP
      server (unit/integration test using a real ephemeral port bound to
      `0.0.0.0` and connected to via `127.0.0.1`, since a real second
      network interface is not guaranteed in CI — the bench-level cross-
      subnet check is a separate, hardware-dependent verification, not a
      unit-test gate).
- [x] `consoleAdvertiser.ts`'s `start` calls the injected backend's
      `publish` with `{name, type: "robotconsole", protocol: "tcp",
      port}` matching the actual bound port (not the requested one, when
      they differ); `stop()` calls `unpublish`/`destroy` exactly once.
- [x] `cli.ts`'s shutdown path stops the advertiser before (or alongside)
      closing the server — verified by an injected fake advertiser
      recording call order in a `cli.test.ts` case.
- [x] `hostHeaderValidation` is called with an allowlist that includes
      `localhost`/`127.0.0.1`/`[::1]` plus this machine's own hostname,
      `<hostname>.local`, and every non-internal IPv4 address
      `os.networkInterfaces()` reports at the time of the call (unit
      test with a fake `os.networkInterfaces()`/`os.hostname()`).
  - [x] A request whose `Host` header names one of those LAN
      addresses/hostnames is accepted by the middleware (regression
      guard: fails against plain `localhostHostValidation()`, confirming
      the fix is load-bearing).
- [x] No existing `server.test.ts`/`mcp/server.test.ts` case regresses;
      no test opens a real multicast socket or binds a real `0.0.0.0`
      listener reachable from outside the test process.

## Testing

- **Existing tests to run**: `npx vitest run packages/host/src/server.test.ts packages/host/src/mcp/server.test.ts packages/host/src/cli.test.ts packages/host/src/discovery`
- **New tests to write**:
  - `discovery/consoleAdvertiser.test.ts`: publish/unpublish call shape
    against a fake backend, using the actual bound port.
  - `mcp/server.test.ts`: allowlist construction from fake
    `os.hostname()`/`os.networkInterfaces()`; a request with a LAN `Host`
    header is accepted, one with an arbitrary unrelated `Host` header is
    still rejected (the DNS-rebinding defense still does something).
  - `cli.test.ts`: advertiser start/stop wiring and shutdown ordering.
- **Verification command**: `npx vitest run packages/host/src/server.test.ts packages/host/src/mcp/server.test.ts packages/host/src/cli.test.ts packages/host/src/discovery`
