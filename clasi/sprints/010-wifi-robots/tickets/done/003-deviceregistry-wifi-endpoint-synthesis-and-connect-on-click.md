---
id: '003'
title: 'DeviceRegistry: WiFi endpoint synthesis and connect-on-click'
status: done
use-cases:
- SUC-003
depends-on:
- '002'
github-issue: ''
issue: robot-console-two-level-ui-and-multi-transport-roadmap.md
completes_issue: true
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# DeviceRegistry: WiFi endpoint synthesis and connect-on-click

## Description

Wire `deviceRegistry.ts` to turn a gated WiFi robot (ticket 002's
`gateWifiRobots`, applied to ticket 001's `mdnsDiscovery.current().
wifiRobots` and `knownRobotsStore.list()`) into a routable
`EndpointListEntry`, and connect it on an ordinary `session-open`.

Mint immediately on every gated match, mirroring the USB attach flow's
"list first, connect on request" shape:
`endpointId: "wifi-<name>"`, `resourceKey: "wifi-<name>"` (independent
— a WiFi TCP socket shares no physical resource with anything else,
mirroring `mbserialResourceKey`'s own rationale), `transport: "wifi"`,
`sessionOpen: false`. No new wire message: `session-open {
endpointId: "wifi-<name>" }` connects it via ticket 002's
`WifiLinkSpec`/`defaultLinkFactory` case, `connect()`/`identify()`
exactly as every other transport.

Per this sprint's Design Rationale ("An ad disappearing is not a
disconnect"): a `down` event on the underlying mDNS advertisement must
**not** tear down an already-open WiFi session — only the socket's own
`close`/`error` events do that, exactly like every other transport's
existing link-error handling. A `down` event before any session was
opened simply removes the not-yet-connected `EndpointListEntry` from
the snapshot (nothing to tear down).

Never read `mdnsDiscovery.current().wifiRobots` directly anywhere
except through the gate — this is the enforcement point for "no code
path can leak an unrecognized robot into a session" (Design
Rationale, "No wire-visible ungated WiFi list").

## Acceptance Criteria

- [x] A gated WiFi robot (fake mDNS + fake roster) appears in
      `deviceRegistry.snapshot()` as `transport: "wifi"`,
      `sessionOpen: false`, before any connect is requested.
- [x] `requestOpen("wifi-<name>")` (or the equivalent internal call
      `session-open` dispatches to) connects via the `WifiLinkSpec`
      built from the gated record's host/port, and on success
      `sessionOpen` flips to `true` with the identified
      `classification`/`name` populated.
- [x] **End-to-end negative** (restates ticket 002's gate test at the
      registry level): a raw discovery fixture containing a robot
      absent from an injected roster fixture never produces an
      `EndpointListEntry` for that name, under any circumstance —
      asserted against `deviceRegistry.snapshot()` directly, not just
      the gate function's own unit test.
- [x] A `down` event on a not-yet-connected WiFi robot's advertisement
      removes its `EndpointListEntry` from the next snapshot.
- [x] A `down` event on an already-**open** WiFi session's
      advertisement does **not** close the session or remove the
      endpoint — `sessionOpen` stays `true` (only a real socket
      close/error does that).
- [x] `requestOpen` on a `"wifi"`-transport endpoint runs under the
      same per-endpoint `KeyedMutex` discipline every other operation
      in this module already uses (no new synchronization mechanism).

## Testing

- **Existing tests to run**: `packages/host/src/deviceRegistry.test.ts`
  (full file — must keep passing unmodified for USB/relay/mbserial
  flows).
- **New tests to write**: fake-`mdnsDiscovery` + fake-`knownRobotsStore`
  + fake-`LinkFactory` tests in `deviceRegistry.test.ts` covering
  synthesis, connect-on-click, the end-to-end gate negative, and the
  `down`-event-does-not-disconnect-an-open-session behavior — same
  fake-link testing technique the file already established for USB and
  sprint 8's relay-target synthesis.
- **Verification command**: `npm test -w packages/host -- deviceRegistry.test.ts`
  and `npm run build`.
