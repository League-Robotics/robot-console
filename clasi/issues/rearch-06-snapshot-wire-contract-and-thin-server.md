---
status: pending
---

# New `snapshot` wire contract from a DB projection; server.ts becomes a thin broadcast and command layer

## Description

`EndpointListEntry` is a union-by-optional-fields with eight
"present only when…" rules (`wsMessages.ts:279-390`); `endpointId` encodes
structure (`usb-`, `wifi-`, `-via-`) that the UI parses back
(`RelayPage.tsx:10`, `FrontPage.tsx:95-109`); relay "connected" is a
UI-side join of the relay entry and a `-via-` child (`FrontPage.tsx:512-527`);
`sessionOpen: boolean` cannot express connecting, retrying, closed-by-user,
stale, or connected-but-silent; `error` doubles as a notice channel;
`endpoints`, `rememberedRobots`, and `discoveredServices` are three lists
describing one set of machines (`01-host-device-model.md` §5).

`server.ts` is the composition root for the whole host (`:249-275`),
subscribes to six registry events and re-sends a full snapshot on every
ack/nack, has no per-socket `ws.on("error")` (an unhandled `error` event
kills the process), no `bufferedAmount` guard, no `maxPayload`, and
`close()` omits `unsubscribeTelemetry()` (`03-host-server-flash-releases.md`
§1). There is no SIGINT/SIGTERM handler anywhere in `packages/host` or
`bin/`, so Ctrl-C cuts an in-flight flash mid-write (§4).

Stakeholder decision: clean break on the contract (architecture §2).

## Proposed resolution

- `wsMessages.ts`: replace `EndpointsMessage`/`EndpointListEntry` and the
  side channels with the `Snapshot` and `Notice` types in
  `architecture.md` §9. Link ids are opaque. Every server message gains
  `seq`. `session-open` takes `{linkId}` or `{relayLinkId, name}`;
  `radio: {}` is removed (rearch-08 adds `set-radio-override`).
  `forget-known-robot` → `forget-device {deviceId}`. Keep `line`,
  `telemetry`, `flash-*`, `flash-local-*`, `wifi-*`, `send-command` and
  `parseClientMessage`'s validator style.
- `packages/host/src/projection.ts`: `buildSnapshot(store): Snapshot`
  from `snapshotRows()`. Hides `wifi`/`mbserial` links of un-owned
  devices; lists un-named USB boards under `unassigned`; derives
  `capabilities` per link (`open`, `close`, `flash`, `provisionWifi`);
  fills `relays[].lease` and `bridging`; `lastChecked` from the newest
  `sightings` row.
- `server.ts`: `startServer({ store, runtime })` — no longer constructs
  watchers or the registry (a `packages/host/src/runtime.ts` composes
  them). One change-feed subscription → coalesced `snapshot` broadcast.
  `Map<type, handler>` for client commands, each awaited with a
  `try/catch` that emits a `notice`. Per-socket `error` handler,
  `maxPayload` on the `WebSocketServer`, `bufferedAmount` guard that
  drops `line`/`telemetry` (never `snapshot`) for a stalled client,
  request ids echoed on unicast replies. `close()` unsubscribes
  everything.
- `cli.ts`: SIGINT/SIGTERM → `server.close()` → runtime stop; exit code
  0. Pass the state dir / DB path through.
- `index.ts` keeps exporting the wire types from one place for the UI's
  type import.

## Acceptance

- Golden test: seeded rows → `buildSnapshot()` equals a checked-in JSON
  fixture; the fixture covers an owned robot with USB+WiFi+radio links,
  an un-owned WiFi robot (absent), an unnamed USB board (`unassigned`),
  and a relay under a sweep lease.
- A burst of ten store writes in one tick produces one `snapshot`
  broadcast.
- A socket that emits `error` does not terminate the host.
- A client with `bufferedAmount` above the threshold stops receiving
  `telemetry` but still receives the next `snapshot`.
- `kill -INT` during a fake flash lets the flash finish or abort cleanly
  and closes the serial port before exit.
- `grep -rn "EndpointListEntry\|rememberedRobots\|discoveredServices" packages/` → nothing.

## Depends on

rearch-01, rearch-05. rearch-07 (UI) lands against this contract.

## References

- `docs/design/architecture.md` §3 (projection, server), §9
- `docs/reviews/2026-09-11/01-host-device-model.md` §5
- `docs/reviews/2026-09-11/03-host-server-flash-releases.md` §1, §4
- `clasi/issues/no-disconnected-from-host-banner-in-the-ui.md` (the `seq` and snapshot-on-reconnect parts)
