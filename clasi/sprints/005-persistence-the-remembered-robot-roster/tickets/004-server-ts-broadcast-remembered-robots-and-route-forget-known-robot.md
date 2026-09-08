---
id: '004'
title: 'server.ts: broadcast remembered robots and route forget-known-robot'
status: done
use-cases:
- SUC-002
- SUC-003
depends-on:
- '002'
- '003'
github-issue: ''
issue: ''
completes_issue: true
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# server.ts: broadcast remembered robots and route forget-known-robot

## Description

Thread `DeviceRegistry.rememberedRobots()` (ticket 003) and
`requestForgetKnownRobot` into `server.ts`'s existing composition points,
per `sprint.md`'s Architecture (Step 3, "server.ts additions") and this
module's own "no logic of its own" contract — this ticket adds routing,
never a new decision.

**Snapshot composition**: `buildEndpointsMessage` already merges
`availabilityCache.current()` into every `EndpointsMessage` it builds —
add `registry.rememberedRobots()` the same way:
```ts
function buildEndpointsMessage(endpoints: EndpointListEntry[]): EndpointsMessage {
  return {
    type: "endpoints",
    endpoints,
    firmwareStatus: availabilityCache.current(),
    rememberedRobots: registry.rememberedRobots(),
  };
}
```
No new listener/subscription is needed: every existing call site of
`buildEndpointsMessage` (the initial `connection` snapshot, every
`onDevicesChanged` broadcast, and the availability-cache-driven
re-broadcast) already re-runs this function, so a change made via
`requestForgetKnownRobot`'s own `emitDevices()` call (ticket 003) is
picked up on the very next `onDevicesChanged` firing — the same
self-healing snapshot property `sprint.md`'s Design Rationale already
relies on for `firmwareStatus`.

**Message routing**: add one more `case` to the `ws.on("message")`
switch, alongside `"session-open"`/`"session-close"`/etc.:
```ts
case "forget-known-robot":
  registry.requestForgetKnownRobot(message.name);
  break;
```

## Acceptance Criteria

All of the following are provable without hardware — `server.test.ts`
already drives a `DeviceRegistry` built entirely from fakes over a real
(loopback) WebSocket connection.

- [x] The `endpoints` message sent immediately on a new WebSocket
      connection includes a `rememberedRobots` field reflecting
      `registry.rememberedRobots()` at that moment (test with a registry
      pre-seeded with a known-robot record via a fake/real store).
- [x] Sending `{ type: "forget-known-robot", name: "<known>" }` results
      in the *next* broadcast `endpoints` message no longer listing that
      name in `rememberedRobots`.
- [x] Sending `{ type: "forget-known-robot", name: "<unknown>" }` (a name
      not in the roster) does not crash the server or produce an error
      response — silent no-op, per ticket 003's own contract.
- [x] Sending a malformed `forget-known-robot` (missing `name`) produces
      the existing generic `{ type: "error", message: "unrecognized
      message shape" }` response, exercised via `parseClientMessage`
      returning `undefined` — no new error-handling code needed in this
      module, per its "no logic of its own" contract.
- [x] Existing `server.test.ts` assertions that construct or compare a
      literal `EndpointsMessage` are updated for the new required
      `rememberedRobots` field (see ticket 002's fixture-update note) and
      still pass.

## Testing

- **Existing tests to run**: `npm test -w @robot-console/host`, full
  `server.test.ts` suite.
- **New tests to write**: extend `server.test.ts` with the cases above,
  following its existing pattern of a real WebSocket client against a
  `startServer` instance built with a fake `DeviceRegistry`/injected
  `KnownRobotsStore`.
- **Verification command**: `npm test -w @robot-console/host` and
  `npm run build`.
