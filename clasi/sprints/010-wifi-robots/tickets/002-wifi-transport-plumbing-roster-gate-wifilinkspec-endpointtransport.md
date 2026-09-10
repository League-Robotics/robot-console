---
id: '002'
title: 'WiFi transport plumbing: roster gate, WifiLinkSpec, EndpointTransport'
status: open
use-cases: [SUC-002]
depends-on: ["001"]
github-issue: ''
issue: robot-console-two-level-ui-and-multi-transport-roadmap.md
completes_issue: true
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# WiFi transport plumbing: roster gate, WifiLinkSpec, EndpointTransport

## Description

Three small, independent plumbing additions this sprint's Architecture
groups into one ticket because each is a few lines with its own tests,
none justifying a separate session:

1. **New `packages/host/src/wifi/wifiRobotGate.ts`**: a pure function
   `gateWifiRobots(discovered: readonly WifiRobotService[], roster:
   readonly KnownRobotRecord[]): WifiRobotService[]` returning only
   entries whose `name` matches a roster record. No I/O, no
   dependencies beyond its two parameter types. This is the sprint's
   classroom-privacy gate — see Design Rationale, "No wire-visible
   ungated WiFi list": nothing downstream of this function's output
   may ever see the raw discovery list.
2. **`link/Link.ts`**: add `WifiLinkSpec { transport: "wifi"; host:
   string; port: number }` to the `LinkSpec` union, mirroring
   `MbserialLinkSpec`'s own shape (host+port, no channel/group fields
   — per this sprint's Design Rationale, "TCP over UDP, reusing
   MbserialLink unchanged").
3. **`deviceRegistry.ts`'s `defaultLinkFactory`**: add `case "wifi":
   return new MbserialLink(spec.host, spec.port);` — no new `Link`
   implementation class, reusing `MbserialLink` verbatim (it already
   has no command plane and the exact `connect()`/`identify()` shape a
   direct-to-robot TCP socket needs).
4. **`wsMessages.ts`**: add `"wifi"` to the `EndpointTransport` union.

Ticket 003 is the first consumer of all three; this ticket's job is
making them constructible and testable in isolation first.

## Acceptance Criteria

- [ ] `gateWifiRobots` returns a discovered robot whose name is in the
      roster.
- [ ] **Negative case** (required — this is the sprint's core privacy
      guarantee): `gateWifiRobots` excludes a discovered robot whose
      name is *not* in the roster, asserted directly against the
      function with no registry/endpoint machinery involved.
- [ ] `gateWifiRobots` handles an empty roster (returns `[]`) and an
      empty discovery list (returns `[]`) without error.
- [ ] `LinkSpec` accepts a `WifiLinkSpec` value; TypeScript's
      exhaustiveness checking on `defaultLinkFactory`'s switch
      requires (and the ticket adds) the new `"wifi"` case.
- [ ] `defaultLinkFactory({ transport: "wifi", host, port })` returns
      an `MbserialLink` instance constructed with that exact
      host/port — asserted by checking the returned object's
      constructor or an equivalent narrow check, not by re-testing
      `MbserialLink`'s own behavior (already covered by its own test
      file).
- [ ] `EndpointTransport` includes `"wifi"`; no existing exhaustive
      switch/mapping over `EndpointTransport` elsewhere in the
      codebase is left un-handling the new value (grep for
      `EndpointTransport` usages and confirm each either handles
      `"wifi"` explicitly or has a safe default arm).

## Testing

- **Existing tests to run**: `packages/host/src/link/Link.test.ts` (if
  present) or wherever `LinkSpec`/`defaultLinkFactory` is currently
  tested; `packages/host/src/deviceRegistry.test.ts`'s existing
  `defaultLinkFactory` coverage for `"usb"`/`"relay-radio"`/
  `"mbrelay"`/`"mbserial"` must keep passing unmodified.
- **New tests to write**: `wifi/wifiRobotGate.test.ts` (positive,
  negative, empty-input cases); a `defaultLinkFactory` test case for
  `"wifi"`.
- **Verification command**: `npm test -w packages/host` and `npm run
  build` (the exhaustiveness check on `EndpointTransport` is a
  compile-time gate, not just a test).
