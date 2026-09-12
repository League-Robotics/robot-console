---
status: pending
sprint: '015'
---

# One connector, one reconciler, one harvester; retire deviceRegistry.ts, knownRobots.ts, wifiRobotGate.ts

## Description

`deviceRegistry.ts` (3,873 lines, 54% comments, 42 out-of-process patch
markers) mixes seventeen responsibilities (`01-host-device-model.md`
§4.1), holds four copies of the connect→attach→identify sequence
(§3, including a verbatim copy of `attachSession` at `:2982-3008`), and
decides connection policy in at least six places (`syncWifiEndpoints`,
`retryWifiAutoConnects`, `autoConnectWifiRobot`, `autoSwitchRadioToWifi`,
`requestOpen`'s no-op rules, `pollStatus`'s watchdog). Seven of the
repo's sixteen fix commits landed in it (`06-build-tests-history.md` §3).

Defects this issue removes by construction (§2, §7 of the device-model
review): the roster→WiFi gate never re-runs on roster change
(`:1366-1370`); a state is deleted mid-connect (`:1500` vs `:1582-1588`);
a user Connect after a link error leaks the old link's four subscriptions
(`:3183-3193` vs `:3785-3791`); `identifying` sticks `true` forever after a
rejected `identify()` (`:3757-3760`); `teardownLink`'s uncaught
`await link.close()` (`:3819`) reaches `void registry.requestOpen(...)` in
`server.ts:430` as an unhandled rejection that terminates the process;
`KeyedMutex.tails` is never pruned (`:674-677`); a dead-but-enumerated USB
session emits an error every 5 s (`:3638-3644`).

## Proposed resolution

Three modules replace the class, per `architecture.md` §3 and §8.

**Connector** (`packages/host/src/connect/connector.ts`): one
`connectAndIdentify(link: LinkRow, signal): Promise<Session>` for every
transport. Acquire `board_owner` (USB) or `relay_leases` (radio); build
the `LineLink` from the row's `address`; `connect({timeoutMs, signal})`;
run the preamble if radio/mbrelay; HELLO with the boot-window retry
schedule (rearch-02); `classifyBanner`; upsert `devices` (set `owned = 1`
for a robot reached over USB); write `sessions`; attach the harvester;
`setLinkState(connected)`. Any failure → `setLinkState(failed, reason)`
with backoff fields; the owner/lease is released in `finally`. Cancellable
at every await. Salvage from the registry: `parseStatusReply`
(`:1031-1053`), `identifyWithTimeout`'s intent, the reset→boot→candidates
procedure (`:2232-2258`, moves to rearch-09), `provisionWifi`'s wire
exchange (`:2536-2587`).

**Reconciler** (`packages/host/src/connect/reconciler.ts`): subscribes to
the change feed plus a 5 s tick. Pure decision function
`plan(rows, now): Job[]` plus a thin executor, so the policy is
table-testable. Rules (architecture §8): link preference
`usb > wifi > mbserial > radio > mbrelay`; never connect a `wifi`/`mbserial`
link whose device is not `owned`; never reopen `closed_by_user`; retry
`failed` at `next_retry_at` with exponential backoff capped at 60 s; one
`notice` per state change, not per attempt; radio bridging is
user-initiated (rearch-09); `session-open {relayLinkId, name}` is one job
that closes the old child and opens the new one.

**Harvester** (`packages/host/src/connect/harvester.ts`): per open
session, salvaged from `handleInboundLine` (`:3349-3408`),
`handleTelemetryLine` (`:3502-3520`), `adoptStatusNext` (`:3531-3543`),
`reportDesyncIfNeeded` (`:3705-3729`), `startRobotProbes`/`pollStatus`
(`:3579-3645`). Writes `sessions.robot_status/functions/seq/pending`;
forwards `thdr`/`t` to the telemetry stream; on `onClose` or three missed
`STATUS` polls (all transports, not WiFi only) → `setLinkState(unresponsive)`
and stop polling. Exactly one error path: `handleLinkError` → state
change; never an emit per poll.

**Retire**: delete `deviceRegistry.ts`, `deviceRegistry.test.ts`,
`store/knownRobots.ts` (+test; the importer in rearch-01 replaces it),
`wifi/wifiRobotGate.ts` (+test; the gate is `devices.owned` in the
reconciler), `relay/RelayConnectionCoordinator.ts` (+test; rearch-09
replaces it). Keep `KeyedMutex` as `connect/keyedMutex.ts` with pruning.
Add `process.on('unhandledRejection')` that logs and marks the offending
link `failed` rather than dying, as a backstop only.

## Acceptance

- Reconciler `plan()` tests, table-driven, cover: owned WiFi link →
  connect; un-owned WiFi link → no job; USB and WiFi both connectable →
  USB only; `closed_by_user` → no job; `failed` before `next_retry_at` →
  no job, after → job; relay child switch → one job with close+open.
- Connector tests on the fake `ByteStream`: success path writes
  `devices`, `sessions`, `links.state = connected`; connect failure
  writes `failed` with backoff and releases the owner; cancellation
  mid-HELLO releases the owner and leaves no listeners; a closed stream
  during identify yields `failed`, never a rejection.
- Harvester tests: `status`/`funcs`/`id`/`thdr`+`t` update the session
  row; stream close → `unresponsive` once; three missed polls →
  `unresponsive` once on a USB link.
- `grep -r "emitDevices\|EndpointState" packages/host/src` returns nothing.
- Full `npm test` green on Linux and macOS with the deleted files gone.

## Depends on

rearch-01, rearch-02, rearch-03, rearch-04. rearch-06 consumes the rows
this writes.

## References

- `docs/design/architecture.md` §3, §5, §8, §11
- `docs/reviews/2026-09-11/01-host-device-model.md` §2, §3, §4, §6, §7
- `docs/reviews/2026-09-11/02-host-transport.md` §5 items 1–3
