# Host transport layer review (read-only)

Scope: `packages/host/src/link/*`, `relay/RelayConnectionCoordinator.ts`, `discovery/mdnsDiscovery.ts`, relay-related slices of `deviceRegistry.ts`, `packages/protocol/src/relay/commands.ts`. All paths below are relative to `/home/user/robot-console/`. Line numbers are from the working tree as read on 2026-09-11.

Process note: the CLASI MCP server (`clasi`) failed to connect in this sandbox (`ENOENT`). No files under the repo were modified; only this scratchpad report was written.

---

## 1. Link abstraction

### What `Link` promises (`packages/host/src/link/Link.ts`)

| Member | Contract | Ref |
|---|---|---|
| `session` | protocol `Session` (seq/pending state) | Link.ts:61 |
| `connect()` | transport-only open, no HELLO; throws only on transport failure; **single-shot** (all impls throw on 2nd call) | Link.ts:66, UsbSerialLink.ts:251-255 |
| `identify()` | send HELLO, resolve banner or `null` on timeout; **never throws**; re-callable | Link.ts:72 |
| `close()` | idempotent | Link.ts:75 |
| `sendLine/sendCommand/sendUnsequenced/checkLiveness` | paced writes; throw synchronously if state ≠ `connected` | Link.ts:79-93, UsbSerialLink.ts:371-377 |
| `onLine/onRawLine/onAckNack/onError` | Set-based listeners, return unsubscribe | Link.ts:97-111 |
| **No `onClose`/`onStateChange`** | a transport that closes cleanly (peer FIN, port `close` event) is **not observable** through the interface | Link.ts:51-112 |
| No `retarget()` (deliberate) | Link.ts:33-41 |

Contract violations worth noting:
- `identify()` "never throws" is false in practice: it is `async` and calls `assertConnected()` first, so on a link whose state has silently become `closed` it returns a **rejected promise** (UsbSerialLink.ts:283-284, RelayRadioLink.ts:300-301, MbrelayLink.ts:294-295, MbserialLink.ts:259-260). Callers relying on the doc (`deviceRegistry.ts:615-631 identifyWithTimeout`, `:3757-3760 resyncSession`) do not catch it — see §5.
- `close()` "idempotent" is true; "resolves" is not: `UsbSerialLink.close()`/`RelayRadioLink.close()` reject on a `port.close` error (UsbSerialLink.ts:309-318, RelayRadioLink.ts:321-330), which real `serialport` does when the port never finished opening (state `connecting`).

### Implementation matrix

| | UsbSerialLink | RelayRadioLink | MbrelayLink | MbserialLink (also WiFi) |
|---|---|---|---|---|
| Open sequence | `toCalloutPath` → `new SerialPort(115200)` → await `open` (`:258-270`) | same as USB (`:261-271`) then `runRelayCommandPlane` (`:273-291`) | `net.connect` → await `connect` (`:247-260`) → `setNoDelay(true)` (`:265`) → `runRelayCommandPlane` (`:267-285`) | `net.connect` → await `connect` (`:235-250`) |
| HELLO/banner | `identify()`: `Session.connect()` + `waitForBanner` 3000 ms (`:283-299`, `:455-467`) | identical (`:300-312`, `:439-451`) | identical (`:294-306`, `:429-441`) | identical (`:259-271`, `:386-398`) |
| Pre-data-plane raw lines | while identify waiting, **all non-banner lines dropped** (`:490-497`) — acks/status during identify are lost | command-plane lines go to handshake **and** `onRawLine` (`:456-466`) | command-plane lines go to handshake **only** — not surfaced (`:446-454`) — inconsistent with RelayRadioLink | as USB (`:407-421`) |
| Retry | none in link | none; retry = new instance (`:47-53`) | none | none |
| Timeouts | identify 3 s (`:86`); **no open timeout** — `serialport` open can hang | handshake per step 3 s (`:99`), sync `?` 16×500 ms = 8 s (RelayCommandPlane.ts:221-222); **no socket/port open timeout** | same; **no TCP connect timeout** (relies on OS SYN timeout, ~75-130 s) | **no TCP connect timeout** |
| Close/cleanup | `port.close(cb)`; rejects on err (`:303-319`) | same (`:315-331`); handshake failure → `closePortSilently` (`:518-522`) | `socket.end(cb)` — graceful FIN, never `destroy()` (`:309-321`) | `socket.end(cb)` (`:274-286`) |
| Error surfacing | `on('error')` → `onError` listeners (`:434-436`); `on('close')` → **state=closed, silent** (`:437-439`) | same (`:420-425`) | same (`:410-415`) | same (`:364-369`) |
| Pacing | `WritePacer` 10 ms, `port?.write(line)` no callback (`:379-383`) | same (`:367-371`) | same (`:357-361`) | same (`:322-326`) |
| TCP_NODELAY | n/a | n/a | **yes** (`:265`) | **deliberately no** (`:34-52`) — for WiFi at 10 ms cadence this is the wrong call; Nagle + delayed-ACK will add up to 40-200 ms on short lines |
| Event-emitter shape | 4 private `Set`s + 4 `dispatchX` loops (`:170-173`, `:506-528`) | 5 Sets (`:166-170`) | 5 Sets (`:150-154`) | 4 Sets (`:146-149`) |
| State machine | `idle→connecting→connected→closed` (`:147`) | same + `inCommandPlane` bool (`:177`) | same (`:125`, `:161`) | same (`:125`) |

Behaviour inventory from tests (describe/it names): the four `*Link.test.ts` files (426+465+486+425 lines) test the same 20-odd behaviours per class (`connect` opens/refuses second call/rejects on error; `identify` HELLO paced/null on timeout/ignores noise; pacing; sequencing ack/nack/resend; foreign traffic dropped; guards before connect). Only USB tests "still routes traffic after identify() times out" (UsbSerialLink.test.ts:389). **Nothing tests: close during connect, socket `close` without `error`, write failure, second `identify()` concurrent with the first, connect timeout.**

---

## 2. Duplication across links

Measured: after normalising class/port/socket names and stripping comments, `MbserialLink` differs from `UsbSerialLink` in **27 of 307** code lines; `RelayRadioLink` in 59 of 358; `MbrelayLink` in 86 of 365. Total 2007 source lines across the four files; roughly **85-90 % is one class pasted four times**, acknowledged in-source ("no shared base class ... glue methods below are written per-class", RelayRadioLink.ts:22-26).

Copy-pasted blocks (identical line-for-line modulo names):

| Block | USB | RelayRadio | Mbrelay | Mbserial |
|---|---|---|---|---|
| Options interface + defaults (10 ms, 3000 ms) | :75-145 | :86-138 | :50-123 | :69-123 |
| `LinkState` type | :147 | :140 | :125 | :125 |
| Field block (reassembler/session/router/4 Sets) | :159-181 | :151-182 | :137-166 | :137-157 |
| `LineRouter` wiring in ctor | :191-196 | :196-201 | :181-186 | :168-173 |
| `banner/role/name/serial/isOpen/session` getters | :203-240 | :208-238 | :193-224 | :180-211 |
| `connect()` guard + state dance | :250-271 | :253-291 | :239-285 | :227-251 |
| `identify()` | :283-299 | :300-312 | :294-306 | :259-271 |
| `close()` | :303-319 | :315-331 | :309-321 | :274-286 |
| `sendLine/sendCommand/sendUnsequenced/checkLiveness/assertConnected/paceWrite` | :330-383 | :335-371 | :325-361 | :290-326 |
| `onLine/onRawLine/onAckNack/onError` | :393-426 | :375-401 | :365-391 | :330-356 |
| `attachXListeners` (data/error/close) | :428-440 | :414-426 | :404-416 | :358-370 |
| `waitForXOpen` (once open / once error) | :442-451 | :428-437 | :418-427 | :372-381 |
| `waitForBanner` | :455-467 | :439-451 | :429-441 | :386-398 |
| `handleLine` | :490-504 | :474-488 | :460-474 | :407-421 |
| `dispatchLine/RawLine/AckNack/Error` | :506-528 | :490-512 | :476-498 | :423-445 |
| `subscribeCommandPlaneLine` + `handleRawLine` + `closeXSilently` | — | :407-412, :456-468, :518-522 | :397-402, :446-454, :504-508 | — |
| `TcpSocketLike` interface (two copies, differ only by `setNoDelay`) | — | — | :75-91 | :90-102 |

Genuinely transport-specific content: USB ≈ 15 lines (`toCalloutPath`, `SerialPortLike`, `defaultCreatePort`), RelayRadio ≈ +20 (handshake call + plane switch), Mbrelay ≈ +25 (socket factory, `setNoDelay`, handshake call), Mbserial ≈ 10.

Collapse estimate: one `LineLink` core (~220-260 lines: state, pacer, reassembler, router, listener sets, identify/waitForBanner, close, optional `preamble` hook, **plus** the missing `onClose`) + four adapters of 20-40 lines each (`openByteStream(): Promise<{write, on(data|error|close), close}>`). The four test files collapse similarly into one core suite + per-adapter open tests. Also the `RelayConnectionCoordinator.probeOnce` (:391-414) and `RelayCommandPlane.waitForMatch` (:262-287) are the same "subscribe, race against scheduler.delay, unsubscribe" helper written twice; `identifyWithTimeout` (deviceRegistry.ts:615-631) is a third variant.

---

## 3. Relay handling

### Command plane vs data plane

- Grammar lives in `packages/protocol/src/relay/commands.ts` (pure builders `:95-175`; `HELLO` deliberately excluded `:67-79`; frame caps `:217-262`).
- `RelayCommandPlane.runRelayCommandPlane` (RelayCommandPlane.ts:165-215): sync with `?` up to 16×500 ms (`:190-200`), then five gated steps `!ECHO OFF`→`!MODE RAW250`→`!CG c g`→`!P 7`→`!GO`, each waiting for its specific `#` reply or a `# error` (`:202-214`, `step` `:236-257`). Resolves on `# entering data plane`.
- The link switches `inCommandPlane=false` only after the promise resolves (RelayRadioLink.ts:289; MbrelayLink.ts:283). Before that, raw lines go to the handshake subscriber; RelayRadioLink additionally echoes them to `onRawLine` (`:461-464`), MbrelayLink does not (`:446-454`).
- There is **no cancellation**: `runRelayCommandPlane` has no `AbortSignal`; a `close()` during the handshake leaves it writing `?` into a closed port for up to 8 s before `connect()` rejects (RelayRadioLink.ts:266-287).
- **No way back from data plane except reset** (commands.ts:153-165; spec §6 `docs/design/specification.md:242-244`). The reset is done **outside** the link layer: `deviceRegistry.ts:2243 resetOverSwdFn(relayDevice)` (DAP reset over HID, `flash.ts:439-469`) + fixed `relayBootDelayMs` 1500 ms (`deviceRegistry.ts:2250`, default `:634-639`).

### How a relay is claimed by a user session

- On USB attach every DAPLink device, relays included, gets a **console session opened automatically**: `handleChange` (deviceRegistry.ts:3078-3093) → `resolveNameAndOpen` (`:3101-3129`) → `connectAndIdentify` (`:3183-3192`) → `UsbSerialLink` to the relay's port. So a relay is **never idle** today: from attach onward its port is held by a `UsbSerialLink` (relay sitting in its command plane, HELLO answered with the `RADIORELAY` banner).
- Bridging: `requestOpen(relayId, {robotName?, radio?})` (`:1954-1962`) → `openRobotViaRelay` (`:2171-2373`) under `KeyedMutex.run(relayId)`:
  1. set `relayBridge={connecting}` and emit (`:2211-2216`)
  2. tear down any existing `-via-` child (`:2222-2229`)
  3. tear down the relay's own console session (`:2233-2235`)
  4. SWD reset, non-fatal on failure (`:2243-2250`), sleep 1500 ms
  5. build candidates: single named `relay-radio` (`:2035-2052`) or default failover = all remembered robots (most recent first) as `relay-radio` + discovered `_mbserial._tcp` as `mbserial` (`:2072-2110`)
  6. `RelayConnectionCoordinator.connect(candidates)` (`:2280`)
  7. failure → `relayBridge={failed}`, **reopen the relay console** via `connectAndIdentify(relayState)` (`:2276`, `:2298`)
  8. success → synthesize `<relayId>-via-<name>` state sharing the relay's `resourceKey` (`:2334-2349`), `attachSession(result.link)` (`:2351`), start STATUS polls (`:2372`)
- `requestClose(childId)` deletes the child and **reopens the relay console** (`:2405-2408`).
- The *only* claim mechanism is the `KeyedMutex` keyed by `resourceKey` (`:679-703`): it serialises *operations*, not *ownership*. There is no lease/owner object, no "who holds the relay now", no way for a background task to know if a user wants it, and no preemption. `relayBridge` (`:2211`) is UI state only.

### Idle notion

None. States a relay can be in: (a) console session open (the default, port held), (b) bridging (child open, port held by `RelayRadioLink`), (c) `sessionOpen:false` with `sessionError` after a failed console open. A sweep would have to close (a) first — and today (a) is re-established automatically after every bridge failure/close (`:2276`, `:2298`, `:2405-2408`).

### Reset/reopen

- Reset happens **once per `openRobotViaRelay`**, before the coordinator. The coordinator explicitly does *not* own reset (RelayConnectionCoordinator.ts:36-43).
- Consequence — **default failover is structurally broken on Linux**: candidate 1 handshake succeeds (`!GO` confirmed, relay now in data plane), probe gets no `pong`, `link.close()` (`:357-358`). Candidate 2 opens the same port and sends `?` — the relay is in the data plane and forwards `?` over radio; no `# channel:` reply ever comes; sync fails after 8 s (`RelayCommandPlane.ts:196-200`); every later `relay-radio` candidate fails the same way. On macOS it works *by accident* because opening the port toggles DTR and resets the relay (spec §6 :236-241). Test `RelayConnectionCoordinator.test.ts:181` ("first two candidates never answer... the third does") passes only because the fake link has no relay state.
- On macOS the relay is reset **twice** per open (SWD reset at `:2243`, then DTR on port open) — harmless but the 1500 ms delay is then wasted, and the `?`-sync loop is what actually absorbs boot.

### `RelayConnectionCoordinator` state machine (RelayConnectionCoordinator.ts)

```
connect(candidates)  :290-309
  └─ for each candidate → attempt()  :314-372
       ├─ mbserial: spec direct                                     :318-324
       ├─ relay-radio|mbrelay:
       │    address given? → "explicit"                             :328-333
       │    else resolveRobotAddress(name, registry)  [HTTP GET, 1.5 s timeout, 2 s TTL cache,
       │         WRITE-ON-READ enrols name]                          :335-338 (mbrelayRegistry.ts:5-21,182,187)
       ├─ link = factory(spec); await link.connect()
       │    ✗ → close().catch, trail "connect failed"               :348-354
       ├─ probeLiveness: 3 × (PING, wait 500 ms for `pong`)          :378-414
       │    ✗ → close().catch, trail "no liveness reply"            :356-363
       ├─ identify() once → classification (null banner = success)  :368-369
       └─ ✓ → {connected, link, classification, addressSource, trail}
  exhausted → {exhausted, trail}                                    :308
```

Races / stuck states / lost events:
- No overall deadline. Worst case per `relay-radio` candidate ≈ port open (unbounded) + 8 s sync + 5×3 s steps + 1.5 s probes + 3 s identify ≈ 27 s; default failover with N remembered robots ≈ N×(8 s + ...) on Linux (all fail at sync). The whole time the relay's `KeyedMutex` key is held, so `requestClose`/`requestFlash`/`sendLine` on the relay queue behind it (`:2113-2121` doc).
- The coordinator's `link` is connected but has **no listeners attached** until `attachSession` at `deviceRegistry.ts:2351`; any `onError` during probe/identify is dropped, and the relay's raw `#` lines during handshake are invisible to the console (acknowledged `deviceRegistry.ts:2127-2135`).
- Failover enrols every tried name into the shared mbrelay registry (write-on-read), violating the spec's "one name, at connect time" rule (spec §6 :258-262; mbrelayRegistry.ts:5-21).
- `resolveRobotAddress` rejection (fetch throwing outside its own handling) would propagate out of `attempt()` and reject `connect()` despite the "never throws" claim (`:335`; no try/catch).
- The result carries only `name`; the caller reverse-looks-up the winning candidate by name (`deviceRegistry.ts:2318-2323`).

---

## 4. mDNS discovery (`packages/host/src/discovery/mdnsDiscovery.ts`)

| Aspect | What the code does | Ref |
|---|---|---|
| Services browsed | `_mbrelay._tcp`, `_mbserial._tcp`, `_robotlink._tcp`, `_robotlink._udp` (spec §4.4 also lists `_mbflash._tcp` — not browsed) | :467, :477, :499, :504; spec :190 |
| Backend | `bonjour-service` 1.4.4 `Bonjour.find()`; one `Bonjour` per `MdnsDiscovery` created lazily | :169-220 |
| Keying | relays/robots by mDNS instance name; WiFi robots by TXT `name` (fallback instance name) across both protocols | :469, :479, :343-345, :487-497 |
| TXT usage | relay `registry=<port>` → `registryPort` (strict digits, 1-65535) | :311-325 |
| WiFi TXT | `name`, `role`, `link` copied as opaque strings | :347-355 |
| Registry port lookup | `deviceRegistry.findRegistryLocationForRelay` matches the relay's **SWD name** against `relays[].instanceName`, uses `host` + `registryPort` | deviceRegistry.ts:2015-2026 |
| Aging | **WiFi only**: `lastSeen` refreshed from raw PTR answers via private `bonjour.server.mdns` (`:198-215`), swept every 30 s, stale after 150 s (`:302-303`, `:410-427`). Relays and `_mbserial` robots are **never aged** — only a goodbye packet removes them (`:472-475`, `:482-485`) | |
| Debounce | none; every `up`/`down` → `notify()` → `DeviceRegistry.syncWifiEndpoints()` → `emitDevices()` → full `endpoints` broadcast to every WS client | :470, :549-554; deviceRegistry.ts:1366-1368, :1524; server.ts:286-300 |
| Re-query | `find()` sends **one** PTR query at start (`browser.js:77,85-87`); no periodic re-query anywhere in the host | node_modules/bonjour-service/dist/lib/browser.js:43-87 |
| SRV/TXT change on re-announce | bonjour-service updates its internal record (`browser.js:66-70`) but emits **no event**; `mdnsDiscovery` only listens to `up`/`down`, so a robot that comes back with a **new IP is not seen** until it ages out (≤180 s) and re-`up`s | browser.js:64-71; mdnsDiscovery.ts:468-507 |
| How events reach the host | `onChange` → `DeviceRegistry.start` (`:1366`) → `syncWifiEndpoints` (`:1491-1549`) mints/refreshes `wifi-<name>` `EndpointState`s gated by the known-robots roster (`wifiRobotGate.ts:36-42`); `relays`/`robots` only reach clients as a pass-through snapshot in `discoveredServices()` (`:1444-1462`) and as failover candidates (`:2072-2110`) | |

Slow/flaky for "I turned on a robot and want to see it now":
1. Discovery is purely passive after the single start-up query. A robot booting after the host is seen only when *it* announces (boot + every 60 s per `:293-294`); a lost boot announcement = up to 60 s.
2. A robot whose DHCP lease changed is connected to at the **old** address for up to 180 s; the WiFi retry timer (`deviceRegistry.ts:1359-1364`, 10 s, `:1259`) keeps dialling the dead IP → a `sessionError` every 10 s.
3. WiFi endpoints are gated on the USB roster (`:1492`); a brand-new robot never plugged in over USB is invisible on WiFi by design.
4. Powered-off relays/mbserial servers stay listed forever → every relay open tries the stale registry host (1.5 s timeout, mbrelayRegistry.ts:182) before falling back to `local-derived`.
5. Every mDNS packet that changes anything triggers a full device broadcast — cheap now, but there is no coalescing.
6. The `server.mdns` private-field hack (`:198-215`) will break on a `bonjour-service` upgrade; the library already tracks `lastSeen`/`ttl` and exposes `expire()` (`browser.js:88-100`) which is never called.

---

## 5. Failure modes likely behind "lots of errors"

Ordered by estimated impact.

1. **Silent transport close → error storm.** All four links flip `state="closed"` on the port/socket `close` event without notifying anyone (UsbSerialLink.ts:437-439, RelayRadioLink.ts:423-425, MbrelayLink.ts:413-415, MbserialLink.ts:367-369). A TCP peer that closes cleanly (mbrelay/mbserial server restart, robot WiFi stack FIN) produces `close` with **no `error`**. `DeviceRegistry` keeps `sessionOpen:true`; every STATUS poll (5 s, `:1263`) then throws `... called while not connected (state: "closed")` from `assertConnected` and is surfaced via `emitError` (`:3646-3650`), as does every user send (`:2448-2453`). The WiFi watchdog (`:3620-3640`) only covers the no-FIN case. There is no `onClose` in `Link`.

2. **Process-killing unhandled rejections.** `identify()` rejects when the link is closed (see §1). `resyncSession` awaits it with no try/catch (`deviceRegistry.ts:3757-3760`); the rejection propagates through `sendLine`'s `mutex.run` to `void registry.sendLine(...)` in `server.ts:491` → `unhandledRejection`. No `process.on('unhandledRejection')` exists in `packages/host/src` (grep), so Node ≥15 terminates the host. Same path: `identifyWithTimeout`'s `void link.identify().then(...)` (`:624`) with no `.catch`. Also every `void registry.requestOpen/requestClose/sendCommand/requestFlash` in `server.ts:430-504` is unguarded; `requestClose` → `teardownLink` → `link.close()` (`:3820`, no catch) rejects for a USB port that errors on close.

3. **Stuck `identifying` flag.** `resyncSession` sets `state.identifying=true` and clears it only on the success path (`:3757-3760`, no `finally`). After the rejection in (2), `pollStatus` (`:3613`), `autoConnectWifiRobot` (`:1576`) and `retryWifiAutoConnects` (`:1605`) are all suppressed for that endpoint permanently — a WiFi robot that will "never come back" until the host restarts.

4. **macOS open-resets-board vs immediate HELLO.** `UsbSerialLink.connect()` resolves as soon as the port is open; `connectAndIdentifyOverLink` sends HELLO immediately (`:3288-3291`). On macOS the open just reset the micro:bit (spec §6 :236-241), which takes ~1-2 s to boot; the 3 s identify window (`UsbSerialLink.ts:86`) is frequently missed → "connected, unresponsive" with `classification unknown`. USB attach never retries `identify()` (only the post-flash path does, `:3017-3020`). On Linux there is no reset so it works — explains platform-dependent flakiness. The relay path is protected only because the `?`-sync loop retries for 8 s.

5. **Failover cannot work without a reset between candidates** (§3). Every default-failover open with ≥2 remembered robots burns 8 s per candidate on Linux and reports `connect failed: relay never answered ?`, then reopens the relay console.

6. **No connect timeouts.** `net.connect` to a stale IP (item §4.2) hangs until the OS SYN timeout; `serialport` open with a wedged CDC device hangs indefinitely. While hanging, the endpoint's `KeyedMutex` chain is blocked, so Close/Open clicks queue silently behind it (`:679-703`).

7. **`socket.end()` instead of `destroy()` on close** (MbrelayLink.ts:316, MbserialLink.ts:281). With unflushed writes to a dead peer, `finish` (and therefore `close()`) waits on kernel retransmit (minutes); `teardownLink` awaits it (`:3820`) inside the mutex → the endpoint is unusable for that whole time.

8. **Write failures are invisible.** `WritePacer.schedule` swallows exceptions (pacing.ts:457-459) and every `paceWrite` calls `write(line)` with no callback (UsbSerialLink.ts:381 etc.), so an `EIO`/`EPIPE` reported via callback is dropped.

9. **Lines lost during `identify()`.** While `resolveBannerWait` is set, every non-banner line is discarded before `LineRouter` (UsbSerialLink.ts:491-497 and clones) — acks for in-flight sequenced commands are lost, and `Session` pending state drifts; a user-typed HELLO mid-drive (`sendLine` → `resyncSession`) triggers exactly this. Two concurrent `identify()` calls clobber `resolveBannerWait` so the first can only ever resolve `null` (`:461-465`).

10. **Close during connect.** `close()` in state `connecting` calls `port.close()` on an unopened `serialport` → rejects (`Port is not open`); for a relay link the handshake keeps running against the closed port (no abort). Coordinator and `connectAndIdentifyOverLink` `.catch(() => {})` this (`RelayConnectionCoordinator.ts:351`, `deviceRegistry.ts:3268`); `teardownLink` does not.

11. **Listener/timer leaks (minor).** `waitForXOpen` leaves a `once('error')` handler attached for the link's lifetime (UsbSerialLink.ts:447; clones). `waitForBanner` timers are not cleared on `close()`. `RelayCommandPlane.waitForMatch` lets `scheduler.delay` run out after a match (`:278`). `KeyedMutex.tails` is never pruned (`:668-671`) — grows with every `wifi-<name>`/`mbserial-<name>` key. `emitDevices()` on every ack/nack (`:3170`) broadcasts the full snapshot per command.

12. **Relay console auto-open interferes with bridging.** Because the relay's own console session is auto-opened at attach and auto-reopened after every failure/close, the port is contended between "console" and "bridge" on every transition; each transition is a full teardown → SWD reset → 1.5 s → handshake cycle.

---

## 6. Reuse verdict per file

| File | Verdict | Reason / salvage |
|---|---|---|
| `link/Link.ts` | Keep-with-refactor | Interface shape is right; add `onClose`/state observer, make `identify()` actually non-throwing, add `connect({signal, timeoutMs})`. Split into `probe(endpoint) → banner|null` and `open(endpoint) → LineStream`. Keep `LinkSpec` variants as pure data. |
| `link/LineRouter.ts` | Keep | Correct, small, tested; the one place ack/nack ordering lives. |
| `link/lineStream.ts` | Keep | Add a max-buffer guard (`:387` grows unbounded without `\n`). |
| `link/pacing.ts` | Keep | Have `schedule()` accept an async write and report failures via a callback instead of swallowing (`:457-459`). |
| `link/UsbSerialLink.ts` | Rewrite (as ~40-line adapter) | Salvage: `SerialPortLike` seam (`:113-125`), `toCalloutPath` use (`:258`), the connect/identify doc rationale (`:16-57`). Everything else moves to a shared core. |
| `link/RelayRadioLink.ts` | Delete | = USB adapter + `preamble` hook. Salvage only the plane-switch idea (`:456-468`) into the core as "raw-phase listener". |
| `link/MbrelayLink.ts` | Delete | = TCP adapter (`setNoDelay`, `:265`) + `preamble` hook. Salvage `TcpSocketLike` (`:75-91`) once, shared. |
| `link/MbserialLink.ts` | Delete | = TCP adapter. Decide TCP vs the spec's `WifiUdpLink` (spec §4.3 :186, "UDP :7654 bound :7655") — currently WiFi is TCP via this class (`deviceRegistry.ts:539-540`, `Link.ts:213-217`). If TCP stays, set `TCP_NODELAY`. |
| `link/RelayCommandPlane.ts` | Keep-with-refactor | `step`/`waitForMatch` (`:236-287`) are the right primitives. Add `AbortSignal`; export the individual steps (`sync`, `setChannelGroup`, `go`) so a sweep can drive `?`/`!CG`/`!GO` piecemeal; keep the reply regexes (`:202-214`, `:224-230`) — they encode live-measured firmware behaviour. |
| `relay/RelayConnectionCoordinator.ts` | Rewrite | Its policy (resolve→connect→probe→failover) belongs in the watcher/sweep + DB. Fatal: no reset between candidates; enrols names into the registry per candidate. Salvage the result/trail types (`:181-214`) and `probeOnce` (`:391-414`) as the generic "send X, wait for verb Y" helper. |
| `discovery/mdnsDiscovery.ts` | Keep-with-refactor | Keep parsers (`:311-355`), `MdnsBackend` seam (`:137-150`), test fixtures. Replace the in-memory Maps with DB upserts (`last_seen`, `host`, `port`, `txt`); handle SRV/TXT updates; age **all** service types; add periodic re-query (`browser.update()`); drop or formalise the `server.mdns` hack. |
| `protocol/relay/commands.ts` | Keep | Pure, correct. Add nothing until firmware gains an escape/probe command. |
| `deviceRegistry.ts` (relay slices only) | Rewrite the relay/WiFi orchestration | `openRobotViaRelay` (`:2171-2373`) is the only place that knows the reset→boot→handshake dance; that knowledge belongs in a relay-owner component with an explicit lease. Keep `KeyedMutex` (`:679-703`) but add a lease/owner record on top. |
| `devices.ts` `DeviceWatcher` | Keep | Already a persistent poll (1 s, `:390`) with diff events — the USB watcher process exists; it just needs to write to the DB instead of driving connects. |

Design target: each transport = `probe(endpoint): Promise<Banner|null>` (open, optional preamble, `ID`/HELLO, close; bounded) + `open(endpoint): Promise<LineStream>` (the shared core with `onClose`). Watchers (USB poll, mDNS, relay sweep) only call `probe` and write rows; user sessions call `open` against a row.

---

## 7. Radio-relay sweep: what the link layer would need

Per-robot step (relay already open in command plane):

```
!CG <ch> <grp>   → wait /^# channel: ch group: grp/  (RelayCommandPlane.step, :236-257)
!GO              → wait /^# entering data plane/
ID               → wait ≤ T (≈300-500 ms) for `id` reply (unsequenced, does NOT reset the robot's session —
                   unlike HELLO, Link.ts:46-56; parse as deviceRegistry.handleIdReply does, :3426)
record {name, role, ch, grp, relay, rssi?, seen_at}
RESET relay      → resetOverSwd(device) (flash.ts:439-469) + wait for boot; re-sync with `?` (RelayCommandPlane :190-200)
```

Constraints visible in code/spec:
- **No in-band escape from the data plane** (commands.ts:153-165; spec §6 :242-244). Every retune therefore costs a reset + boot (~1.5 s + up to 8 s sync today, realistically 2-3 s). A sweep over 20 remembered robots ≈ 1-2 min per pass on the relay. This is the dominant cost and is a **firmware limitation**: file a firmware request for either (a) a command-plane probe verb (`!TX <ch> <grp> <line>` returning replies for N ms without `!GO`), or (b) an escape sequence / idle-timeout back to the command plane. Nothing in `commands.ts` suggests either exists (`?` and `!HELP` are the only non-mutating verbs, `:167-175`).
- **Do not use `HELLO` for the sweep**: it resets the sequence state of any robot on that channel that may be mid-session with another host (`Link.ts:46-56`, `commands.ts:67-79`). Use unsequenced `ID` (name + role) — `PING`/`pong` gives no identity, and 125 names share a channel (spec §6 :247).
- **SWD reset needs the HID interface** (`flash.ts:443-449`); a relay enumerated `serial-only` (`devices.ts:96`) cannot be reset and can only be swept once per attach (or per port-open on macOS, spec §6 :236).
- **Keep the port open across the sweep**: on macOS each open/close resets the relay (2 s); on Linux the CDC port is exclusive. The relay's auto-opened console `UsbSerialLink` (`deviceRegistry.ts:3078-3192`) must go — either the sweep owns the port, or the console session *is* the sweep's handle (it already sits in the command plane; `sendLine`+`onRawLine` can drive `!CG`).
- **Handing back to a user**: introduce a lease on the relay's `resourceKey` `{owner: "sweep"|sessionId, abort: AbortController}`. `requestOpen(relay, target)` revokes the lease; the sweep checks the signal between robots (needs `AbortSignal` threaded through `RelayCommandPlane.waitForMatch` `:262-287` and `runRelayCommandPlane`), closes its link, and resolves; the user path then performs its existing reset+handshake (`openRobotViaRelay` steps c-e), which is already robust to whatever plane the relay was left in. On `requestClose` of the child, return the relay to `idle` (lease free) instead of reopening a console session (`:2405-2408`), and let the sweep re-acquire after a quiet period.
- **Pacing/timeouts for the sweep**: the 10 ms write pacer is fine; `?` sync should use a shorter retry (≤200 ms) after a *known* reset, since boot is ≈1 s; `ID` wait must be short (radio round trip is tens of ms) — 300-500 ms per robot, not the 3 s `identify()` default.
- Record per probe: relay id, `(ch,grp)` tried, `addressSource` (registry/derived/explicit — reuse `mbrelayRegistry.ts:109` outcomes), `id` reply or null, timestamp. Skip the registry `GET` during sweeps (write-on-read, mbrelayRegistry.ts:5-21) — use the DB's last-known address or `nameToRadioAddress` only.
