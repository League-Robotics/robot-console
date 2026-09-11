# Review: `packages/host` device-model layer

Read-only review. No repo files modified. All paths are under `/home/user/robot-console/packages/host/src/` unless prefixed. Line numbers are from the checkout as read on 2026-09-11.

Process note: the CLASI MCP server did not connect in this session (`clasi` not on PATH). This review is analysis only — no source, ticket, or sprint artifact was touched — so no CLASI gate applies; the team-lead should re-verify MCP before any follow-on implementation work.

---

## 1. Inventory of state

### 1.1 Every place device/endpoint/link state lives

| # | Location | Keyed on | Holds | Mutated by | Persisted |
|---|----------|----------|-------|------------|-----------|
| S1 | `DeviceRegistry.states: Map<string, EndpointState>` — `deviceRegistry.ts:1306` | endpointId string, **three minting schemes**: `usb-<usbSerial>` (:478), `wifi-<fiveLetterName>` (:490), `<relayEndpointId>-via-<robotName>` (:2315) | The whole device model (see S2) | 13 sites: `:1397,1501,1514,1614,1764,2226,2332,2401,2406,2740,3064,3071,3089` | No |
| S2 | `EndpointState` fields — `:724-934` | (per S1 row) | ~25 fields: `device`, `name`, `nameError`, `classification`, `session`, `sessionOpen`, `sessionError`, `desyncNotified`, `flashStatus`, `robotStatus`, `functions`, `telemetryDecoder`, `statusPollTimer`, `pollAwaitingStatus`, `pollMisses`, `wificredWaiter`, `identifying`, `relayBridge`, `synthesizedRelayTarget`, `wifiTarget`, `wifiAutoConnect`, `wifiConnecting` | Scattered across ~30 methods; `sessionOpen` assigned at 6 sites (`:2967,3009,3255,3288,3790,3817`) | No |
| S3 | `KeyedMutex.tails: Map<string, Promise>` — `:680` | `resourceKey` (== endpointId for USB/WiFi; relay's id for `-via-` children; `mbserial-<name>` :567) | Implicit "operation in flight" per resource | `run()` `:682`; **never pruned** (`:674-677`) | No |
| S4 | Per-registry timers: `wifiRetryTimer` `:1304` (10 s, :1259); per-state `statusPollTimer` `:825` (5 s, :1263); `wificredWaiter` timeout `:2541` (4 s); `identifyWithTimeout` `:618` (8 s, :605); `delay()` `:647` (1.5 s relay boot, :638) | — | — | — | No |
| S5 | Six listener `Set`s — `:1310-1315` | — | server.ts subscriptions | `on*()` `:1870-1921` | No |
| S6 | `Link.session` (protocol `Session`: `seq`, `pendingCount`, `nextSequenceId`) inside each `Link` object | per open link | Sequencing state; read live by `toEntry` `:995-1001`; mutated by `adoptStatusNext` `:3541` | Link impls | No |
| S7 | `DeviceWatcher.currentDevices: DaplinkDevice[]` — `devices.ts:410` | USB `serialNumber` | Last USB poll snapshot | `pollOnce` `devices.ts:439`, every 1000 ms (`:390,454`) | No |
| S8 | `MdnsDiscovery.relays` / `.robots` — `discovery/mdnsDiscovery.ts:387-388` | mDNS **instance name** | `_mbrelay._tcp` / `_mbserial._tcp` records | `up`/`down` handlers `:468-485` | No; **not cleared on `stop()`** (`:524-530`) |
| S9 | `MdnsDiscovery.wifiRobots` — `:393` | TXT `name` (= five-letter name), collapsing tcp+udp (`:343-345`) | `_robotlink._{tcp,udp}` | `:487-497`; sweep `:414-427` | No |
| S10 | `MdnsDiscovery.wifiLiveness` — `:398` | mDNS **fqdn** (one per service type) | `lastSeen` for stale sweep (150 s / 30 s, `:302-303`) | `:490,495,511-516`; cleared on `stop()` `:542` | No |
| S11 | `mbrelayRegistry.ts` `DEFAULT_CACHE` — `:154` (module-level singleton) | five-letter name | `{channel, group, outcome}` TTL 2 s (`:187`) | `resolveRobotAddress` `:308` | No |
| S12 | `KnownRobotsStore.records: Map` — `store/knownRobots.ts:286` | five-letter name | `KnownRobotRecord` (`:106-124`): `lastUsbSerial` is display-only | `recordSighting` `:388` (called only from `deviceRegistry.ts:1863` — USB identify + post-flash), `forget` `:413` | **Yes** — `known-robots.json`, path `:208-228`, debounced 300 ms atomic write `:442-483` |
| S13 | `KnownRobotsStore._isReadOnly` — `:289` | — | "newer file version seen" | `load()` `:355` | No |
| S14 | `wifi-credentials.json` — `store/wifiCredentials.ts:409` | — | SSID/password | `write()` `:471`; **no in-memory copy** — `read()` re-reads file + env + `.env` every call (`:444-458`) | **Yes** |
| S15 | `.env` firmware config — `config.ts:311-320` | — | repo/tag per firmware | Re-parsed on every call | Yes (external file) |
| S16 | `server.ts` `clients: Set<WebSocket>` (~:263), `LocalHexUploadManager` upload store (`:227`), `FirmwareAvailabilityCache` (`:246-250`) | — | — | — | No |
| S17 | `RelayConnectionCoordinator` — `relay/RelayConnectionCoordinator.ts:269-282` | — | stateless; `trail` is a local (`:291`) | — | No |

### 1.2 Identity keys in play (four, not one)

| Key | Where it is authoritative |
|-----|---------------------------|
| USB serial (KL27 interface chip) | `devices.ts` join (:235-296); endpointId `usb-<serial>` (:478); `EndpointState.device` |
| Five-letter name (nRF FICR hash via SWD) | `knownRobots.ts` (:14-23), `wifiRobots` map key (:343-345), `wifi-<name>` id (:490), mbrelay registry (:283), `-via-<name>` suffix (:2315) |
| mDNS instance name | `relays`/`robots` maps (:370-373); `_mbserial._tcp` instanceName **is** the robot name per `wsMessages.ts:572-575`; `_mbrelay._tcp` instance name is matched against the *local relay's SWD name* at `deviceRegistry.ts:2019-2021` |
| endpointId string | everything client-facing; structure is parsed back out by the UI (`ui/src/pages/RelayPage.tsx:10`, `FrontPage.tsx:95-109`) |

### 1.3 Sources of truth that disagree or duplicate

1. **One physical robot → up to three `EndpointState` rows** (`usb-…`, `wifi-<name>`, `<relay>-via-<name>`). Dedup is done by ad-hoc linear scans: `hasOpenUsbSessionForName` `:1649`, `findSynthesizedRelayChildForName` `:1633`, `findSynthesizedEndpointId` `:1994`, `rememberedRobots` subtract-what's-live `:1419-1426`. No table says "this robot".
2. **"Is connected" has five representations**: `state.sessionOpen` (flag), `state.session` (object; deliberately allowed to diverge from the flag, `:769-779`), the `Link`'s own internal state (`link/UsbSerialLink.ts:437-439` sets `state="closed"` on port close **without** firing `onError`, so the registry never learns), `relayBridge` on the relay + the child's `sessionOpen` (the UI joins these itself: `ui/src/pages/FrontPage.tsx:512-527`), and the transient flags `identifying`/`wifiConnecting` (`:841,933`).
3. **"Is connectable" has no representation at all.** USB: implied by `device.serialPort?.path` (`:3184`). WiFi: implied by `wifiTarget` + gate. Relay-radio: implied by `classification.type === "relay"` + `device.serialPort` (`:2180-2201`). mbrelay/mbserial remote: only in `discoveredServices` (`:1444-1459`), never an endpoint.
4. **`discoveredServices` vs `endpoints` vs `rememberedRobots`** are three wire lists (`wsMessages.ts:616-626`) describing the same set of machines from three angles; the UI re-joins them by name.
5. **Roster (S12) gates WiFi (S9) but nothing re-runs the gate when the roster changes.** `syncWifiEndpoints` is triggered only by mDNS change (`:1366-1368`) and `start()` (`:1370`). A USB identify that enrols a robot (`:1863`) does not re-sync; the robot's already-seen WiFi advertisement stays invisible until it re-announces or goes down/up. `retryWifiAutoConnects` (`:1602-1625`) iterates only *existing* `wifi-` states and never creates new ones.
6. **Gate computed in two places** with a fresh sorted copy of the roster each time: `:1492` and `:1788` (the latter called per WiFi endpoint per 10 s tick at `:1608`).
7. **`mbrelayRegistry` cache is a process-global singleton** (`:154`) shared by production and any test not injecting `cache`.
8. **`MdnsDiscovery` keeps `relays`/`robots`/`wifiRobots` across `stop()` but clears `wifiLiveness`** (`:531-547`) — after a restart, WiFi robots exist with no liveness record, so the sweep can never age them out.

---

## 2. Discovery → connectable → connected pipelines

### 2.1 USB attach

| Step | Code | Timer / retry |
|------|------|---------------|
| 1 | `DeviceWatcher.start` `setInterval` → `pollOnce` → `SerialPort.list()` + `node-hid.devices()` → join → diff by `JSON.stringify` (`devices.ts:436-447, 356`) | 1000 ms poll (`:390`) |
| 2 | `handleChange` (`deviceRegistry.ts:3041-3099`): removed → queue `teardownLink` under mutex (`:3057-3074`); added → new `EndpointState` (`:3079-3089`), queue `resolveNameAndOpen` (`:3090`); `emitDevices` (`:3098`) | — |
| 3 | `resolveNameAndOpen` (`:3101`): `readSwdName` over SWD (`:3111`) → `isLive` (`:3115`) → `name`/`nameError` → `connectAndIdentify` (`:3127`) | SWD read, no timeout visible here |
| 4 | `connectAndIdentify` (`:3183`): needs `device.serialPort.path` else `sessionError = "no serial port available…"` and **stops** (`:3185-3189`) | **No retry** |
| 5 | `connectAndIdentifyOverLink` (`:3242`): `link.connect()` → on throw: `sessionError`, close, **stop** (`:3249-3270`); on success `attachSession`, `sessionOpen=true` (`:3287-3291`); `identify()` (`:3301`, UsbSerialLink banner wait 3000 ms `link/UsbSerialLink.ts:86`) → `classifyBanner` → `maybeRecordKnownRobot` → `startRobotProbes` (`:3327`: `ID`, `FUNCS`, `STATUS` every 5 s) | 3 s identify; 5 s poll |

Loss / stuck / fight points:

- **Double identify on every attach.** Serial and HID personas rarely enumerate in the same 1 s poll; `diffDaplinkDevices` models a changed device as remove+add (`devices.ts:334-341, 356-358`). Result: teardown → second SWD read → second port open (DTR reset on macOS, `:38-40`) → second `HELLO`. The board is reset twice and the UI flaps.
- **`connect()` failure is terminal until the user clicks.** No scheduled retry anywhere in the USB path; `requestOpen` is the only re-entry (`:1923-1931`). The project's own port-lock issue (`:60-74`) says this failure is common right after enumeration.
- **Silent board is "connected".** `identify()` null → `sessionOpen: true`, `classification.type: "unknown"` (`:3315`). `requestOpen` is a no-op while `sessionOpen` (`:1970-1972`), so the user has no way to re-identify except typing `HELLO` in the console (`:2598-2601`).
- **Dead USB link stays "open".** `UsbSerialLink` port `close` without `error` (`link/UsbSerialLink.ts:437-439`) is not surfaced; the STATUS watchdog is WiFi-only (`:3628`, test `deviceRegistry.test.ts:3752` enshrines it); `pollStatus` then broadcasts an `emitError` on every failed write every 5 s (`:3638-3644`) for as long as the device stays enumerated.
- **User Connect after a link error leaks and re-breaks.** `handleLinkError` leaves `state.session` in place (`:3785-3791`). `connectAndIdentify` (USB) does **not** tear it down before `attachSession` (`:3183-3193`; contrast the WiFi path which does, `:3216-3221`). The old `Link` and its four subscriptions are orphaned but still wired: a later error on the old port calls `handleLinkError(state)` and flips the **new** session to `sessionOpen: false`.
- **One SWD failure cascades to WiFi invisibility.** `nameError` → `name: null` → never enrolled (`:1848`) → never passes `gateWifiRobots` → `wifi-<name>` never exists.

### 2.2 mDNS WiFi robot (`_robotlink._tcp/_udp`)

| Step | Code | Timer / retry |
|------|------|---------------|
| 1 | bonjour `up` → `wifiRobots.set` + `wifiLiveness.set` → `notify` (`mdnsDiscovery.ts:487-507`) | sweep 30 s, stale 150 s (`:302-303,414-427`) |
| 2 | `syncWifiEndpoints` (`deviceRegistry.ts:1491-1550`): gate against roster (`:1492`); delete ungated **non-open** states (`:1495-1503`); mint `wifi-<name>` with `wifiAutoConnect: true` (`:1514-1522`); `emitDevices`; fire-and-forget `autoConnectWifiRobot` per gated robot (`:1531-1535`); fire-and-forget `autoSwitchRadioToWifi` (`:1545-1549`) | — |
| 3 | `autoConnectWifiRobot` (`:1572-1591`): mutex(`wifi-<name>`) → guards (`:1576-1581`) → `connectAndIdentifyWifi` (`:3210`) → `MbserialLink` connect (3000 ms open timeout `link/MbserialLink.ts:80`) → `connectAndIdentifyOverLink` | — |
| 4 | `retryWifiAutoConnects` (`:1602-1625`) re-queues step 3 for every not-open WiFi state | 10 s (`:1259,1372`) |
| 5 | `pollStatus` watchdog: 3 unanswered polls → `handleLinkError` → `wifiAutoConnect = true` → step 4 reconnects (`:3626-3637, 3792-3797`) | 3 × 5 s = 15 s |

Loss / stuck / fight points:

- **Re-announce after reboot fires no `up`** (own comment `:1243-1250`). Detection depends on the 15 s watchdog + 10 s retry; worst case ≈ 25–30 s to notice a reboot, and up to 150 s + 30 s for a gone robot to vanish.
- **State deleted mid-connect.** `syncWifiEndpoints` deletes any ungated state with `!sessionOpen` (`:1500`) — including one with `wifiConnecting: true`. The in-flight `connectAndIdentifyOverLink` then hits `!isLive` (`:3272`) and closes the link, but the orphaned object keeps being mutated (`wifiConnecting=false` at `:1588`).
- **Error churn every 10 s per offline robot.** A stale advertisement (up to 180 s) + 10 s retry → `connect()` fails → `sessionError` set + `emitDevices` broadcast (`:3255-3268`) on every tick. This alone explains "lots of errors".
- **Auto-connect vs user close vs auto-switch.** `requestClose` sets `wifiAutoConnect=false` (`:2387`). `autoSwitchRadioToWifi` assumes auto-connect "already ran ahead" (`:1717-1724`) and, when the WiFi session is not open, emits `"Auto-switch of <name> to WiFi failed…"` via `emitError` (`:1734-1740`) — on **every** mDNS change while a user-closed WiFi endpoint and an open radio child coexist.
- **Auto-connect holds the mutex through a 3 s connect**; a user `session-open` queued behind it is then a no-op (`:1970`) or a duplicate attempt.
- **Gate coupling** (see §1.3 item 5): a robot never USB-identified on this machine can never be a WiFi endpoint; roster changes don't re-run the gate.

### 2.3 mDNS mbrelay (`_mbrelay._tcp`) and mbserial (`_mbserial._tcp`)

- Discovered into `relays`/`robots` maps (`mdnsDiscovery.ts:467-485`) → projected verbatim into `discoveredServices` (`deviceRegistry.ts:1444-1459`, `wsMessages.ts:565-591`). **No endpoint is ever synthesized for a remote mbrelay.** Its only use is `findRegistryLocationForRelay` (`:2015-2026`), which matches the mDNS instance name against a *locally attached USB relay's* SWD name to obtain a registry port.
- `MbrelayLink` exists (`defaultLinkFactory` `:535-536`) and `MbrelayCandidate` exists (`relay/RelayConnectionCoordinator.ts:146`), but neither `buildSingleCandidate` (`:2035-2052`) nor `buildDefaultFailoverCandidates` (`:2069-2110`) ever emits a `"mbrelay"` candidate. **The mbrelay transport is dead end-to-end.**
- `_mbserial._tcp` robots become connectable **only** as tail candidates of the relay default-failover list (`:2095-2107`), i.e. only when a user presses Connect on a *local USB relay* with no name picked (`server.ts:434-435`). There is no direct "connect to this discovered mbserial robot".

### 2.4 USB relay + radio

| Step | Code | Timer / retry |
|------|------|---------------|
| 1 | USB attach path classifies `relay` from banner | as §2.1 |
| 2 | `session-open {robotName|autoRobot}` → `requestOpen(id, target)` → mutex(relay id) → `openRobotViaRelay` (`server.ts:430-437`; `deviceRegistry.ts:1958-1962, 2171`) | — |
| 3 | Validations (`:2175-2201`, no `relayBridge` set) → `relayBridge: connecting` + emit (`:2210-2214`) | — |
| 4 | Tear down previous child (`:2220-2228`), tear down relay's own session (`:2232`), `resetOverSwd` (`:2243`, failure is non-fatal `:2244-2249`), `delay` (`:2250`) | 1500 ms boot |
| 5 | Candidates (`:2255-2258`) → `coordinator.connect` (`:2278`): per candidate `resolveRobotAddress` (1500 ms timeout, 2 s TTL; `mbrelayRegistry.ts:182,187`) → `RelayRadioLink.connect` (open 3000 + handshake 3000 ms, `link/RelayRadioLink.ts:99,105`; `?` sync retry 500 ms `link/RelayCommandPlane.ts:221`) → `probeLiveness` 3 × 500 ms (`RelayConnectionCoordinator.ts:229,233`) → `identify()` (3 s) | ≈12.5 s worst case **per candidate** |
| 6 | Success → synthesized state `sessionOpen: true` (`:2316-2332`) → `attachSession` → `relayBridge = undefined` → probes. Failure → `relayBridge: failed` + `emitError` + `connectAndIdentify(relay)` (`:2260-2297`) | — |

Loss / stuck / fight points:

- **Default failover holds the relay mutex for N × ~12.5 s** (N = roster size + discovered mbserial). Every `requestClose`/`requestFlash`/`sendCommand` on the relay queues behind it (`:2117-2121`). No cancel API exists; `relayBridge: connecting` can persist for minutes.
- **Radio child drop is a dead end.** `handleLinkError` on the `-via-` child sets `sessionOpen: false` and keeps it listed (`:3785-3791`; UI accounts for this at `FrontPage.tsx:513-527`). Nothing reopens the relay's own session (torn down at `:2232`) and nothing retries the radio link. Relay + child both stuck until the user acts.
- **Relay reclassified `unknown` after a child closes (likely).** `requestClose` on the child (`:2408-2411`), the exhausted/no-candidate paths (`:2271,2295`) and the auto-switch (`:1766-1769`) all call `connectAndIdentify(relayState)`. The relay is still in its radio data plane (exit is reset-only, `:254-262`), so the plain-USB `HELLO` is forwarded over radio, `identify()` returns null, and `connectAndIdentifyOverLink` overwrites `relayState.classification = classifyBanner(null)` (`:3315`). The next `requestOpen(target)` then fails validation `"is not classified as a relay"` (`:2180-2186`). Tests for these paths use a fake link that returns a banner, so they don't catch it.
- **`relayBridge` can stick at `connecting`.** Any rejection inside `openRobotViaRelay` after `:2210` (e.g. `teardownLink`'s uncaught `await link.close()` at `:3819`, or `resetOverSwdFn` throwing) leaves `relayBridge` set and propagates out of `requestOpen` to `server.ts:430` `void registry.requestOpen(...)` → **unhandled promise rejection** (see §7).
- **Post-flash reidentify races the watcher's re-add** — documented as a known open gap at `:2928-2942`.
- **Registry write-on-read** (`mbrelayRegistry.ts:5-45`) means every default-failover attempt enrols every remembered name into the shared classroom registry as a derived guess (only 2 s TTL-cached).

---

## 3. Duplication (concrete)

| Pattern | Occurrences | Locations |
|---------|-------------|-----------|
| connect → attach subscriptions → identify → classify sequence | 3 in registry + 1 in coordinator | `connectAndIdentifyOverLink` `:3242-3328`; `reidentifyAfterFlash` `:2944-3037` (contains a **verbatim copy of `attachSession`** at `:2982-3008` even though `attachSession` exists at `:3153-3181`); `RelayConnectionCoordinator.attempt` `:314-372`; `openRobotViaRelay` step (f) `:2316-2355` |
| Banner-wait `setTimeout` + open timeout + write pacer | 4 link impls | `link/UsbSerialLink.ts:82,86,457`; `RelayRadioLink.ts:92,105,441`; `MbrelayLink.ts:55,67,431`; `MbserialLink.ts:74,80,388` — four copies of `DEFAULT_WRITE_PACE_MS = 10` and `DEFAULT_OPEN_TIMEOUT_MS = 3000` |
| "reopen the relay's own session after its child is gone" | 4 | `:2271, :2295, :2410, :1768` |
| `error instanceof Error ? error.message : String(error)` | 10 in `deviceRegistry.ts` (+ `knownRobots.ts:189`, `RelayConnectionCoordinator.ts:352`, `cli.ts:101`, `server.ts`) | grep |
| `try { line = link.send…; emitLine(tx) } catch { emitError }` | 5 | `:2448-2453, :2606-2617, :3638-3644, :3666-3671, :3684-3689` |
| `.replace(/\n$/, "")` on tx echo | 8 | grep |
| `this.emitDevices()` (manual full-snapshot broadcast) | **31** | grep; correctness of the UI depends on every mutation remembering to call it |
| `this.isLive(state)` / `states.get(...) !== state` staleness checks after `await` | 11 + 1 | e.g. `:2855,2867,2890,2966,2976,3023,3115,3272,3302,3581,3613,3761` |
| `this.states.get(` re-fetch inside mutex | 25 | grep |
| Linear scans over `states` for a derived index | 6 | `:1419,1495,1604,1633,1649,1994` |
| Gate recompute (`gateWifiRobots(current().wifiRobots, store.list())`) | 2 | `:1492, :1788` |
| mDNS `up`/`down` handler pairs | 3 near-identical | `mdnsDiscovery.ts:468-485, 487-497` |
| `link.close().catch(() => {})` | 4 in registry + 2 in coordinator | grep |
| `classifyBanner(null)` as "unknown" initial state | 7 | grep |

Volume: `deviceRegistry.ts` is 3873 lines of which **2095 are comment lines (54%)**, 145 blank, ≈1630 code. 42 `OOP 20xx` markers (out-of-process patches) and 5 self-declared "known/accepted gap" notes.

---

## 4. God-object analysis of `deviceRegistry.ts`

### 4.1 Responsibilities mixed in one class (`DeviceRegistry`, `:1284-3873`)

1. USB attach/detach orchestration (`handleChange` `:3041`)
2. SWD naming (`resolveNameAndOpen` `:3101`)
3. Session lifecycle + per-resource mutex policy (`connectAndIdentify*`, `teardownLink`, `KeyedMutex`)
4. Wire projection (`toEntry` `:936-1022`, `snapshot` `:1401`)
5. Known-robot write gate + "remembered" projection (`maybeRecordKnownRobot` `:1847`, `rememberedRobots` `:1418`)
6. mDNS projection (`discoveredServices` `:1444`)
7. WiFi gating, endpoint synthesis, auto-connect, 10 s retry, liveness watchdog (`:1491-1625, 3612-3645`)
8. Radio-relay bridging: reset, boot delay, candidate building, synthesized child (`:1994-2356`)
9. Relay → WiFi auto-switch policy (`:1687-1778`)
10. Flash pipeline (release + local-hex) and post-flash reidentify (`:2680-3037`)
11. Command routing (sequenced/unsequenced/HELLO/FUNCS) (`:2591-2619, 2436-2455`)
12. Inbound reply harvesting: `status`, `estop`, `funcs`, `id`, `thdr`/`t`, `wificred` (`:3349-3520`)
13. Status polling, ID/FUNCS probes (`:3579-3690`)
14. WiFi credential provisioning wire exchange (`:2525-2589`)
15. Desync detection/notices and `status next=` adoption (`:3531-3543, 3705-3781`)
16. Console echo formatting (`echoBanner`, `reconstructLineText`)
17. Event bus (six listener sets + six `emit*`)

### 4.2 Public surface

- Constructor: **20 injectable options** (`DeviceRegistryOptions` `:1127-1252`).
- Methods: `start`, `stop`, `snapshot`, `rememberedRobots`, `discoveredServices`, `requestForgetKnownRobot`, `onDevicesChanged`, `onLine`, `onError`, `onTelemetry`, `onFlashProgress`, `onFlashResult`, `requestOpen(id, target?)` (three behaviours by argument shape, `:1954-1984`), `requestClose`, `sendLine`, `provisionWifi`, `sendCommand`, `requestFlash`.
- Module exports: `KeyedMutex`, `defaultLinkFactory`, `parseStatusReply`, `RelayConnector`, listener types, 4 constants.

### 4.3 Method lengths (body lines, excluding doc comment)

| Method | Lines | Body |
|--------|-------|------|
| `openRobotViaRelay` | `:2171-2356` | **186** (+59 doc) |
| `runFlash` | `:2696-2834` | **139** |
| `reidentifyAfterFlash` | `:2944-3039` | 96 |
| `autoSwitchRadioToWifi` | `:1687-1778` | 92 |
| `connectAndIdentifyOverLink` | `:3242-3328` | 87 |
| `provisionWifi` | `:2525-2589` | 65 (+68 doc) |
| `syncWifiEndpoints`, `handleInboundLine`, `handleChange` | | 60, 60, 59 |

Two methods exceed 100 lines; five exceed 85. 59 methods total.

### 4.4 How to split (DB-centred)

| New unit | Takes from today | Notes |
|----------|------------------|-------|
| **Store** (SQLite): `machines(name PK, usb_serial, last_role, first/last_seen)`, `usb_devices(serial PK, serial_path, hid_path, availability, seen_at)`, `discoveries(kind, key, host, port, txt, first_seen, last_seen)`, `endpoints(id PK, machine_name, transport, address, state ENUM, state_reason, state_since, next_retry_at, resource_key)`, `sessions(endpoint_id, seq, pending, robot_status_json, functions_json, …)` | S1, S2, S7–S12 | Replaces 13 `states.set/delete` sites and 6 linear scans with queries. `state ENUM` = `discovered \| connectable \| connecting \| connected \| unresponsive \| failed \| closed_by_user`. |
| **UsbWatcher** thread | `devices.ts` `DeviceWatcher` | Upsert `usb_devices`; emit *update* not remove+add. |
| **MdnsWatcher** thread | `mdnsDiscovery.ts` | Upsert `discoveries` with `last_seen`; staleness becomes a `WHERE last_seen < now - ttl` sweep. |
| **RelaySweeper** thread | new | Periodically enumerate radio reachability through attached relays (stakeholder ask); writes `discoveries(kind='radio')`. |
| **Reconciler** loop | policy scattered in `syncWifiEndpoints`, `retryWifiAutoConnects`, `autoConnectWifiRobot`, `autoSwitchRadioToWifi`, `requestOpen` no-op rules | Reads DB, decides desired state per endpoint, schedules `Connector` jobs with backoff (`next_retry_at`). One place for auto-connect vs user-close precedence. |
| **Connector** (one `connectAndIdentify(spec)` returning a `Session`) | `connectAndIdentifyOverLink`, `reidentifyAfterFlash`, `RelayConnectionCoordinator.attempt` | Single implementation, cancellable, with the per-resource mutex. |
| **RelayBridger** | `openRobotViaRelay` steps (a)–(f) | Owns reset/boot/candidates; writes `relayBridge`-equivalent to `endpoints.state`. |
| **ReplyHarvester** per session | `handleInboundLine`, `handleTelemetryLine`, `adoptStatusNext`, `reportDesyncIfNeeded`, `pollStatus`/probes | Writes `sessions` row; telemetry stays on its own channel. |
| **Flasher** | `runFlash`, `setFlashPhase/failFlash/succeedFlash` | Writes `endpoints.flash_*`. |
| **Projection** | `toEntry`, `rememberedRobots`, `discoveredServices`, `server.ts buildEndpointsMessage` | `SELECT … → EndpointsMessage`, broadcast on DB change (one place instead of 31 `emitDevices()`). |

---

## 5. `wsMessages.ts` contract

### 5.1 Message types

| Direction | Types (`wsMessages.ts`) |
|-----------|-------------------------|
| client → server (10) | `session-open` (`:631-666`, three modes via `robotName`/`autoRobot`/`radio`), `session-close` (`:671`), `line` (`:430`), `send-command` (`:495`), `flash-start` (`:681`), `flash-local-begin` (`:743`), `forget-known-robot` (`:779`), `get-wifi-credentials` (`:811`), `set-wifi-credentials` (`:822`), `provision-wifi` (`:831`) |
| server → client (9) | `endpoints` (`:616-626`, full snapshot of `endpoints[]` + `firmwareStatus` + `rememberedRobots[]` + `discoveredServices{relays,robots}`), `line` (`:430`, with `origin?: "poll"`), `error` (`:790`), `flash-progress` (`:691`), `flash-result` (`:714`), `flash-local-ready` (`:755`), `telemetry` (`:467`), `wifi-credentials` (`:839`), `wifi-provision-result` (`:849`) |

`parseClientMessage` (`:923-1022`) is a sound, dependency-free validator. Keep the style.

### 5.2 Assessment: view-over-a-DB or leaked state machine?

Good: `endpoints` is always a full snapshot (`:593-615`); telemetry/lines are separate streams. That is the right shape for a DB-rendered UI.

Leaks:

1. **`EndpointListEntry` is a union-by-optional-field.** `usb?`, `wifi?`, `viaRelay?`, `relayBridge?`, `addressSource?`, `failoverTrail?`, `sequencing?`, `flashStatus?`, `robotStatus?`, `functions?` — eight "present only when…" rules (`:279-390`). A reader must know the host's internal branching to interpret absence.
2. **`endpointId` encodes structure** (`usb-`, `wifi-`, `-via-`) and the UI parses it (`ui/src/pages/RelayPage.tsx:10`, `FrontPage.tsx:95-109`).
3. **Relay "connected" is a UI-side join**: relay entry + existence of a `-via-` child + `child.sessionOpen` (`FrontPage.tsx:512-527`). `relayBridge` covers only `connecting|failed` (`:374-390`) — a two-thirds state machine.
4. **`sessionOpen: boolean` + `sessionError?: string`** cannot express `connecting`, `retrying (next at T)`, `closed by user`, `dead link awaiting cleanup`, or `connected-but-silent` (the last is encoded by `sessionError` text at `deviceRegistry.ts:2343`). The UI reads `sessionOpen` 43 times and `sessionError` 22 times to reconstruct these.
5. **`error` doubles as a notice channel** (`deviceRegistry.ts:1774-1775` "Switched … to WiFi" sent via `emitError`; `:3725-3728` resync notice). No severity/code field (`:790-794`).
6. **Three lists for one thing.** `endpoints`, `rememberedRobots`, `discoveredServices` (`:616-626`) are joined by name in the UI (`rememberedRobots` read 25×, `discoveredServices` 16×).
7. `flashStatus` cannot represent a local-hex flash (`deviceRegistry.ts:126-141`).
8. Session-scoped data (`sequencing`, `robotStatus`, `functions`) rides in the identity snapshot, so every ack/nack and every `status` line re-broadcasts the whole list (`:3173, :3366, :3395`).

Recommended wire shape: one `machines[]` list (name-keyed, with `usbSerial`, roster timestamps) each carrying `endpoints[]` rows `{endpointId, transport, address, state: enum, reason?, since, nextRetryAt?, capabilities}`; `session` as its own optional sub-object; `notice` as a distinct message type with `level`. Keep `line`, `telemetry`, `flash-*`, `wifi-*` as they are.

---

## 6. Reuse verdict

| File | Verdict | Reasoning / what to salvage |
|------|---------|-----------------------------|
| `devices.ts` | **Keep** | Pure enumerate/join/diff (`:201-368`) is correct and tested; `DeviceWatcher` (`:405-468`) becomes the USB watcher thread. Change `diffDaplinkDevices` to emit an *update* for a changed serial (`:356-358`) instead of remove+add. |
| `mbrelayRegistry.ts` | **Keep-with-refactor** | Sound three-outcome resolver (`:283-310`). Make the cache injectable-by-default (drop module singleton `:154`) or back it by the DB. Note it is only reachable via a local USB relay whose SWD name matches an mDNS mbrelay instance (`deviceRegistry.ts:2015-2026`). |
| `store/knownRobots.ts` | **Rewrite → SQLite table** | Salvage `resolveKnownRobotsFilePath` (`:208-228`) for the state-dir location and the version/read-only discipline (`:350-357`) as a migration importer for existing `known-robots.json`. Debounce/atomic-write code is obsolete with SQLite. |
| `store/wifiCredentials.ts` | **Keep-with-refactor** | Small and correct; move to a `settings` table or keep the `0600` file. `read()` re-reading the file on every `describe()` (`:444-467`) is fine at this scale. |
| `wifi/wifiRobotGate.ts` | **Delete** | Becomes `WHERE name IN (SELECT name FROM machines WHERE last_seen_via_usb IS NOT NULL)`. Revisit the policy itself: it is why a robot never USB-identified on this machine is invisible over WiFi (§2.2). |
| `wsMessages.ts` | **Rewrite `EndpointListEntry`/`EndpointsMessage`**, keep the rest | Keep `parseClientMessage` style (`:923-1022`), `FlashLocal*`, `Telemetry`, `Line`, wifi-credential messages, `UPLOAD_ID_BYTE_LENGTH`. Replace the endpoint list per §5.2. |
| `deviceRegistry.ts` | **Rewrite** | Salvage as free functions/small modules: `KeyedMutex` (`:679-698`), `toEntry` mapping knowledge (`:936-1022`), `parseStatusReply` (`:1031-1053`), `reconstructLineText` (`:1062-1072`), `handleInboundLine` harvest rules (`:3349-3408`), `handleTelemetryLine` (`:3502-3520`), `adoptStatusNext` (`:3531-3543`), `reportDesyncIfNeeded` (`:3705-3729`), `provisionWifi` wire exchange (`:2536-2587`), `runFlash`'s source branch (`:2755-2798`), the relay reset→boot→candidates procedure (`:2232-2258`) as a documented sequence, `buildDefaultFailoverCandidates` ordering (`:2069-2110`), `defaultLinkFactory` (`:529-542`). Nothing else should survive as-is. |
| `index.ts` | **Keep** | Re-exports only. |
| `cli.ts` | **Keep** | Port/env parsing only. |
| `config.ts` | **Keep** | Correct, self-healing `.env` re-read (`:311-320`). |
| `discovery/mdnsDiscovery.ts` (reviewed as the mDNS watcher) | **Keep-with-refactor** | Backend abstraction and parsing (`:305-355`) are good. Becomes the mDNS watcher thread writing `discoveries` rows with `last_seen`; drop the parallel `wifiLiveness` map (`:398`) in favour of a column; clear maps on `stop()` or document why not. |
| `relay/RelayConnectionCoordinator.ts` (reviewed as dependency) | **Keep-with-refactor** | Stateless, tested, never throws (`:290-372`). Add cancellation and a per-candidate deadline; make it the Connector for `"relay-radio"`/`"mbrelay"`/`"mbserial"`. |
| `server.ts` (reviewed for wiring) | **Keep-with-refactor** | Dispatch (`:415-520`) is thin and fine. Fix `close()` missing `unsubscribeTelemetry()` (present only in the failure path at `:568`; `close()` at `:583-591` omits it). Broadcast should come from DB change events rather than six registry listeners. |
| `link/*.ts` (not reviewed in depth) | **Keep**, dedupe | Four copies of open-timeout/banner-wait/write-pacer (§3). Surface `port.on("close")` as an error (`UsbSerialLink.ts:437-439`). |

---

## 7. Other sources of "lots of errors"

### 7.1 Unhandled promise rejections (process-fatal on Node ≥15)

- `teardownLink` awaits `link.close()` with **no catch** (`deviceRegistry.ts:3819`). Callers without a catch: `openRobotViaRelay` (`:2224, :2232`), `requestClose` (`:2384`), `autoSwitchRadioToWifi` (`:1763`), `connectAndIdentifyWifi` via `requestOpen` (`:3220` ← `:1979`). These propagate through `mutex.run` to `server.ts:430-437, :441` where the result is discarded with `void` → **unhandledRejection**.
- `void this.watcher.pollOnce()` (`:1365`) and `DeviceWatcher.start`'s `void this.pollOnce()` (`devices.ts:455`, every 1 s): a `SerialPort.list()`/`node-hid` rejection, or **any listener throwing synchronously inside `handleChange`**, becomes an unhandled rejection.
- `MdnsDiscovery.notify` (`mdnsDiscovery.ts:549-554`) calls listeners inside a bonjour event handler with no try/catch; a throw in `syncWifiEndpoints` escapes into the mDNS library's emitter.
- `provisionWifi`'s `.then` in `server.ts:483-487` has no `.catch`.

### 7.2 Swallowed / misreported

- `link.close().catch(() => {})` ×6 hides transport close failures (`:2971,2978,3267,3274`; coordinator `:351,358`).
- `stop()` swallows all teardown failures (`:1391-1394`).
- `identifyWithTimeout` (`:615-632`) resolves null on timeout but the underlying `identify()` keeps running and later mutates `UsbSerialLink.parsedBanner` (`link/UsbSerialLink.ts:295-297`) unobserved.
- `resetOverSwd` failure is logged and the handshake proceeds anyway (`:2244-2249`); the eventual failure is reported as "no candidate robot answered" (`:2282-2284`) — wrong root cause, ~12 s later.
- `mbrelayRegistry` maps registry outage, timeout, and malformed body all to `"local-derived"` (`:235-266`) — by design, but it hides a down registry.
- `KnownRobotsStore.performWrite` failure → `console.warn` only (`:478-482`); UI never learns the roster didn't persist.
- `sessionError` is one free-text string for four different conditions: connect failure (`:3257`), connected-but-silent (`:2343`), link dropped (`:3791`), and reconnect-post-flash failure (`:2969`).

### 7.3 Leaks and missing cleanup

- Old `Link` + 4 subscriptions orphaned when `connectAndIdentify` (USB) runs after `handleLinkError` (`:3183-3193` vs `:3785-3791`) — see §2.1.
- `handleLinkError` keeps a dead `session` indefinitely for USB if the device stays enumerated (`:3785-3791`); for WiFi it is only disposed at the next auto-connect (`:3216-3221`).
- `KeyedMutex.tails` never pruned (`:674-677`); grows with every `wifi-<name>`, `-via-<name>`, `mbserial-<name>` key ever used.
- `server.ts close()` never calls `unsubscribeTelemetry()` (`:568` is the failure path; `:583-591` is `close()`).
- `syncWifiEndpoints` deletes a state that an in-flight `autoConnectWifiRobot` still mutates (`:1500` vs `:1582-1588`).
- `MdnsDiscovery.stop()` keeps `relays/robots/wifiRobots` but clears `wifiLiveness` (`:531-547`) → post-restart WiFi records can never age out.

### 7.4 Broadcast storms and periodic error emission

- `emitDevices()` on every ack/nack (`:3173`), every `status` line (`:3366`), every `funcs` line (`:3395`), every `id` line (`:3432`), every flash phase (`:2860`) — each rebuilds the full snapshot **and** `server.ts` recomputes `rememberedRobots()` (sorted copy of the roster) and `discoveredServices()` per broadcast (`server.ts:285-300`).
- `pollStatus` emits an `error` message every 5 s for any open-but-dead session whose write throws (`:3638-3644`).
- WiFi retry emits a `sessionError` + snapshot every 10 s per stale/offline WiFi record (§2.2).
- Auto-switch emits "Auto-switch … failed" on every mDNS change when a user-closed WiFi endpoint coexists with an open radio child (`:1723-1740`).

### 7.5 Design-level reasons "noticing connectable" is unreliable (summary)

1. Roster change never re-triggers WiFi gating (`:1366-1370`).
2. USB `connect()` failure has no retry (`:3249-3270`).
3. Remote mbrelay/mbserial discoveries never become connectable endpoints (§2.3).
4. WiFi reboot detection relies on 15 s watchdog + 10 s timer, not on discovery (`:1243-1250`).
5. Radio child drop has no recovery path (`:3785-3791`).
6. Silent boards are reported as connected and cannot be re-identified from the UI (`:1970-1972`).
7. Relay likely loses its `relay` classification after any child close (`:3315` via `:2410/:2271/:2295/:1768`).
