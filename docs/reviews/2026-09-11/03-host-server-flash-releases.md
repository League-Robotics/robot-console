# Review: host server / flash / releases / SWD / startup / deps

Scope: `packages/host/src/{server,flash,localHexUpload,releases,swdName,config,cli,index}.ts`, `packages/host/package.json`, `bin/robot-console.js`, `scripts/dev.mjs`. Read-only. Lens: what survives a move to a SQLite-centred state model with watcher threads.

Repo facts that frame everything below:
- `deviceRegistry.ts` is 3873 lines and is the *only* thing `server.ts` talks to. Every piece under review is either a leaf `deviceRegistry` calls (flash/swdName/releases/config) or the shell around it (server/cli). The leaves are cleanly decoupled from the registry; the shell is not.
- All persisted state today is two JSON files under `~/.local/state/robot-console/` (`store/knownRobots.ts:226-227`, `store/wifiCredentials.ts:7`), plus a repo-root `.env` re-parsed every poll (`config.ts:115,209`).

---

## 1. `server.ts` (606 lines)

### Connection management
| Aspect | Where | Notes |
|---|---|---|
| Client set | `server.ts:281` `const clients = new Set<WebSocket>()`; add `:373`, delete `:531` | Flat set, no per-client identity/subscriptions. |
| Initial snapshot | `:374` `ws.send(buildEndpointsMessage(registry.snapshot()))` | One full `endpoints` message on connect. |
| Per-socket error handler | **absent** | No `ws.on("error")`. `ws` emits `error` on protocol violations / write failures; with no listener EventEmitter throws → **uncaught exception kills the host**. Only `wss.on("error")` (`:279`) is handled, and that is the server-level one. |
| Backpressure | `:283-290` `client.send(payload)` unconditionally | No `bufferedAmount` check. `line`/`telemetry` at robot rates to a stalled tab grows heap without bound. |
| Bind | `:75` `127.0.0.1` hardcoded | Correct for the threat model; keep. |
| Port-busy | `:201-227` `listen()` rejects EADDRINUSE with a clear message | Keep. |

### Snapshots vs deltas
- `endpoints` (`:296-312` `buildEndpointsMessage`) is **always a full snapshot** merging three sources: `registry.snapshot()`, `availabilityCache.current()`, `registry.rememberedRobots()`, `registry.discoveredServices()`. Re-sent on: device change, every ack/nack (`deviceRegistry.ts` `unsubscribeAckNack` → `emitDevices()`), availability poll change (`:365`), forget-robot (`:492`). No deltas, no sequence numbers, no versioning.
- Everything else is an event stream: `line` (`:306`), `error` (`:313`), `telemetry` (`:322`), `flash-progress` (`:334`), `flash-result` (`:337`). Unicast replies: `wifi-credentials` (`:424,445`), `wifi-provision-result` (`:453,466`), `flash-local-ready` (`:509`), parse errors. No request-id correlation; the client infers which request a reply answers.
- UI side (`packages/ui/src/ws/WsProvider.tsx:914-1035`) reconnects with a fixed delay and relies on the fresh snapshot-on-connect; there is no replay of missed `line`/`telemetry`.

### Request dispatch
- One `switch (message.type)` at `:399-527` (12 cases) after `parseClientMessage` (`wsMessages.ts:923`, hand-written validator), preceded by an `isBinary` branch (`:378-393`) for the hex-upload frame. Each case is a one-line forward to a `registry.*` method, fired with `void` (`:415-421, :427, :469, :476, :482`) — results are not awaited and rejections are not caught. The registry documents "never throws", so this holds only as long as that contract does.
- `provision-wifi` (`:448-467`) and the two WiFi-credentials cases are the exceptions: server.ts itself holds the `WifiCredentialsStore` and does logic (`reveal`, "no network stored" pre-check). That is a "no logic of its own" violation already present.

### Coupling to `deviceRegistry`
`startServer` is the composition root (`:249-275`): it constructs `DeviceRegistry`, `FirmwareAvailabilityCache`, `WifiCredentialsStore`, `LocalHexUploadManager`, wires `consumeUpload` into the registry, and calls `registry.start()`/`availabilityCache.start()`/`pollOnce()` (`:530-548`). It touches 17 registry members (6 `on*` subscriptions, `snapshot`, `rememberedRobots`, `discoveredServices`, `requestOpen/Close/Flash/ForgetKnownRobot`, `sendLine`, `sendCommand`, `provisionWifi`, `start`, `stop`). The fan-out from 6 registry event types → 5 wire types is 1:1 with hand-copied field lists (`:337-362`).

### Error handling / shutdown
- `close()` (`:585-604`) forgets `unsubscribeTelemetry()` (present in the bind-failure path `:568`, absent at `:586-591`). Harmless today because the registry is stopped right after, but it is a listener leak if a caller supplies its own `registry`.
- `close()` order: terminate clients → `wss.close` → `httpServer.close` → `registry.stop()`. Correct. `availabilityCache.stop()` before that. Correct.
- Bind failure path (`:563-575`) tears everything down. Correct.

### Would it survive as "subscribe to DB changes → broadcast"?
**Partially. Keep the shell, replace the middle.**
Keep as-is: `listen()` (`:201-227`), `buildApp()` (`:159-181`), `toBuffer()` (`:188-197`), localhost bind, `RunningServer` shape, the `wss.on("error")` note, the bind-failure cleanup pattern.
Must change:
1. Remove the composition root. `startServer` should receive `{ db, commands }` (or a `HostRuntime`), not build `DeviceRegistry`/cache/stores. Today it hard-couples the server to the registry's constructor and lifecycle.
2. Replace the 6 `registry.on*` subscriptions + `buildEndpointsMessage` with one subscription to a change feed. **SQLite has no cross-connection change notification** (`update_hook` fires only on the writing connection; nothing crosses `worker_threads`). The broadcast layer therefore needs either (a) writes funnelled through one main-thread connection that also owns an in-process emitter, or (b) a `changes(seq, table, key)` log table polled at ~50–100 ms / a `MessagePort` ping from each watcher thread after commit. Decide this before touching server.ts; it dictates whether the "thin layer" is truly thin.
3. Decide snapshot vs delta once, in one place. The current "full `endpoints` on every ack/nack" is fine for ≤10 endpoints but should become "snapshot on connect + row-level deltas" if telemetry/lines also move through the DB. Add a monotonic `seq` to every outbound message so the UI can detect gaps on reconnect.
4. Replace the `switch` with a `Map<type, handler>` of *command* handlers that write intents (open/close/flash/send) to the DB or a command queue; `line`/`send-command` are latency-sensitive and should probably bypass the DB and go straight to whichever thread owns the link.
5. Add `ws.on("error")` per socket and a `bufferedAmount` guard (drop `telemetry`/`line` for a client over N bytes, never drop `endpoints`).
6. Add request ids to unicast replies (`wifi-*`, `flash-local-ready`).
7. Move the WiFi-credentials logic out (it is the one place server.ts has business logic).

---

## 2. `flash.ts` (730) / `localHexUpload.ts` (209) / `swdName.ts` (171)

### Correctness
| # | File:line | Finding | Severity |
|---|---|---|---|
| F1 | `flash.ts:588` `readdir("/Volumes")` | MSD fallback is **macOS-only**. Linux (`/media/$USER`, `/run/media`) and Windows (drive letters + `DETAILS.TXT`) never find a volume → fallback silently skipped, SWD error returned as final. Students on Windows/Linux get no fallback. `devices.ts:175-177` already has a `platform` switch; flash.ts does not. | Med |
| F2 | `flash.ts:331-333,452` | No timeout on `daplink.connect()`, `daplink.flash()`, `processor.connect()`/`readMem32()` (`swdName.ts:367-368`). A wedged HID transport hangs the endpoint's `KeyedMutex` slot forever (`deviceRegistry.ts:2651-2662` acknowledges this and defers it). | Med |
| F3 | `flash.ts:697-712` | After a `program-failed` SWD attempt the MSD write starts immediately with no settle delay; the board may be mid-reset/remount. Success is reported as soon as `writeFile` returns (`:706`) — DAPLink is still programming; `"resetting"` is never reported on the MSD path. Caller (`reidentifyAfterFlash`) absorbs timing. | Low |
| F4 | `flash.ts:171-200` `extractV2Hex` | Universal-hex record types `0x0B` (block end), `0x0C` (padded data), `0x0D/0x0E` inside the v2 block are passed through unfiltered; only `0x0A` is stripped. `isValidIntelHexText` (`:216-244`) accepts any record type. Works iff DAPLink's parser ignores them (it does on ≥0241, which also natively handles universal hex — making extraction largely redundant but harmless). Bench-verified per comments; leave, but note. | Low |
| F5 | `flash.ts` naming | `flashOverSwd` does **not** flash over SWD. `DAPLink.flash()` (`:333`) uses DAPLink vendor HID commands (the interface chip's own programmer, same path as drag-and-drop), not `CortexM` register-level SWD. `resetOverSwd` (`:426`) likewise is `CmsisDAP#reset()`. Rename to `flashViaDapLink`/`resetViaDapLink` in the rewrite so the resource model (HID handle, interface-chip reset ⇒ no USB re-enumeration, `deviceRegistry.ts:398-420`) is legible. | Low (docs) |
| F6 | `flash.ts:381-400` | `.off` → `removeListener` workaround for dapjs's bundled emitter. Correct and tested (`flash.test.ts:388,408`). Symptom of dapjs being unmaintained (§5). | Info |
| F7 | `swdName.ts:326-330`, `flash.ts:301-305` | Each call opens a fresh `node-hid` handle by path and closes it in `finally`. Correct. Two concurrent opens of the same HID path (naming + flash) would conflict; nothing in these modules prevents it — see contention. | see below |
| F8 | `localHexUpload.ts:111-112` | Unbounded `pending`/`verified` maps, acknowledged (`:56-66`). A client that loops `flash-local-begin` without sending frames leaks 1 entry/req (tiny). Localhost-only, acceptable; add TTL when moving to DB. | Low |
| F9 | `localHexUpload.ts:127` | Cap checks declared `byteLength` only; `receiveFrame` (`:160`) never checks `frame.length` against the cap before hashing. `ws` default `maxPayload` (100 MiB) is the real bound. Set `maxPayload` on `WebSocketServer` (`server.ts:271`). | Low |

### Does flashing coordinate with whoever holds the port / SWD?
**Not in these modules — entirely delegated to `deviceRegistry.ts`'s `KeyedMutex`.**
- `flash.ts`/`swdName.ts` are pure "given a `DaplinkDevice`, do the I/O" leaves with no notion of a link, a lock, or another probe. This is a good boundary *if* the caller guarantees exclusivity.
- Caller guarantees today: `requestFlash` runs under `mutex.run(endpointId)` (`deviceRegistry.ts:2681`); `runFlash` tears down the serial link (`:2763`) and any synthesized relay child (`:2749-2759`) before fetching/flashing; name resolution also runs under the same key (`:3090-3092`). So **serial-open-during-flash and SWD-attach-during-naming are prevented, but only by the registry**, and the mutex is held across the network fetch (`:2637-2650`, deliberate).
- Resource-contention residuals:
  - SWD naming (`resolveNameAndOpen`) opens HID while **no** serial port is open; `connectAndIdentify` then opens serial. Fine. But nothing prevents a *second process* (pyOCD, MakeCode, another `robot-console`) from holding the HID/serial; failures surface as `attach-failed`/`permission` (`swdName.ts:309-317`) with no retry. Acceptable.
  - `DeviceWatcher.pollOnce()` (`devices.ts:436`) runs `SerialPort.list()` + `HID.devices()` concurrently with everything else — enumeration only, no handles opened. Fine.
  - Flash via DAPLink re-enumerates USB → the watcher reports remove+add → new `EndpointState` while `runFlash` still holds the old one (`deviceRegistry.ts:2811-2830` handles by re-fetching `liveState`). In a DB design this becomes: flash row keyed by `serialNumber`, not by in-memory object identity — simpler.
- **DB-design implication:** the exclusivity invariant ("one owner per physical board: naming | serial-link | flash | reset") must move to a DB-visible lock (`board_owner(serial, owner, since)`) or a single owning thread per board. If watcher threads open HID/serial directly, `flash.ts`/`swdName.ts` can be called from that thread unchanged; they carry no shared state.

### Behaviour inventory (tests)
- `flash.test.ts`: 47 cases — universal-hex sniff/extract, hex validation, `DETAILS.TXT` parse/join, volume resolution, `flashOverSwd` failure classes + `.off` regression, `resetOverSwd` ordering, MSD write, `flash()` orchestration/fallback ordering.
- `swdName.test.ts`: 8 cases — naming codec pass-through, no-hid-path, factory-throws, permission classification. Real SWD deliberately untested.
- `localHexUpload.test.ts`: 10 cases — cap, id minting, frame split/verify, single-use, unknown id.

### Reuse verdict
- `flash.ts`: **Keep-with-refactor.** Pure functions (`isUniversalHex`, `extractV2Hex`, `isValidIntelHexText`, `parseDetailsTxt`, `findMatchingVolume`) keep verbatim. `flashOverSwd`/`resetOverSwd`/`flash` keep; add timeouts (F2), platform-aware volume listing (F1), rename (F5). No dependency on registry or server.
- `swdName.ts`: **Keep.** Add a timeout wrapper. Nothing else.
- `localHexUpload.ts`: **Keep** (or fold into a DB `uploads` table with TTL if uploads must survive a host restart — they should not; in-memory is correct).

---

## 3. `releases.ts` (603)

| # | Line | Finding |
|---|---|---|
| R1 | `:72-73, :281-291` | Asset matching is exact `microbit.hex` / `microbit.hex.txt` (case-insensitive). Issue `clasi/issues/host-rejects-robot-template-release-asset-naming.md` resolved this template-side (both names now published); its **step 3 (list found assets in the `no-asset` message) is still not implemented** — `:288-290` names only the missing names. `releases.test.ts:206-234` asserts only `stringContaining("MICROBIT.hex")`, so it does not pin step 3 either. Step 5 (`config/prod/public.env` still → `pxt-nezha-diffdrive`) is outside this review's files. |
| R2 | `:96-101, :255, :328, :338` | No timeout / `AbortSignal` on any fetch. A hung GitHub connection blocks `pollOnce` (`:546`) and, via `runFlash`, the endpoint mutex. |
| R3 | `:462-466` + `server.ts:274,533` | Unauthenticated GitHub API, 2 requests / 5 min / host. A classroom of N hosts behind one NAT shares the **60 req/hr/IP** limit: 30 students ≈ 720 req/hr → HTTP 403 → every host reports `network` and all flash buttons disable. No `GITHUB_TOKEN` support, no `ETag`/`If-None-Match` (304s are free against the limit), no backoff on 403/429. **Highest-impact finding in this file.** |
| R4 | `:574` | Change detection via `JSON.stringify` equality. Fine at this size. |
| R5 | `:507-603` `FirmwareAvailabilityCache` | Mixes three concerns: interval poller, config hot-reload (`:551-553`), status projection. Mirrors `DeviceWatcher` deliberately. |
| R6 | `:320-373` | Downloads hex fully into memory (~1.8 MB) before verifying; fine. Manifest regex (`:307`) lenient by design. |
| R7 | `:160-180` | `parseGithubRepoUrl` accepts any host (not just github.com) and any extra path segments; harmless. |

Tests (`releases.test.ts`): 28 cases covering latest/pinned tag, 404 disambiguation, no-asset, network, malformed URL, sha256 verify/mismatch, cache states, config reload, unref'd timer.

### Reuse verdict
**Keep-with-refactor.** `resolveRelease`, `fetchAndVerifyHex`, `checkAvailability`, `parseGithubReleaseBody`, `extractManifestSha256` are pure, injectable, well-tested — keep verbatim, add `AbortSignal` + token header + ETag. Replace `FirmwareAvailabilityCache` with a watcher thread that writes a `firmware_availability(kind, configured, repo, tag, available, reason, message, checked_at, etag)` row; the poll loop, `onChange`, and `loadConfig` all disappear into "write row, DB change feed notifies". Implement R1 step 3 while there.

---

## 4. `config.ts` / `cli.ts` / `index.ts` / `bin/robot-console.js` / `scripts/dev.mjs`

### Startup sequence (production, `npx robot-console`)
```
bin/robot-console.js:22  import dist/cli.js → main(argv)
cli.ts:303  port = --port | ROBOT_CONSOLE_PORT
cli.ts:304  getFirmwareConfig()            (parses <repo>/.env, never throws)
cli.ts:305  startServer({port, firmwareConfig})
  server.ts:253  new LocalHexUploadManager
  server.ts:257  new DeviceRegistry({consumeUpload})   ← constructs KnownRobotsStore, MdnsDiscovery, DeviceWatcher…
  server.ts:262  new WifiCredentialsStore
  server.ts:268  new FirmwareAvailabilityCache(cfg, {loadConfig})
  server.ts:270-271  express app, http.createServer, WebSocketServer
  server.ts:303-367  6 registry subscriptions + 1 cache subscription
  server.ts:530  registry.start()          ← DeviceWatcher.start()+pollOnce(), MdnsDiscovery.start(), wifi retry setInterval  (deviceRegistry.ts:1360-1377)
  server.ts:531  availabilityCache.start(); :548 pollOnce()  (first GitHub calls, fire-and-forget)
  server.ts:550  listen(127.0.0.1:4795)
cli.ts:309  open(url)                      (browser; failure logged only)
```
Long-lived processes: all started inside `startServer`, i.e. **the HTTP server owns the hardware watchers**. In a DB design this inverts: hardware watchers own themselves (threads), the server is one consumer.

### Shutdown / cleanup
| Path | Behaviour | Leak risk |
|---|---|---|
| `bin/robot-console.js` + `cli.ts` | **No SIGINT/SIGTERM handler anywhere in `packages/host` or `bin`.** Ctrl-C kills the process; `RunningServer.close()` is never called. | OS reclaims serial/HID/sockets, so no cross-restart leak of *handles*. But: an in-flight `DAPLink.flash()` is cut mid-write (board left erased-but-unwritten — exactly the case `flash.ts:17-21` warns about); mDNS `goodbye` is never sent; JSON stores are only written on explicit mutations, so no corruption. |
| `dev.mjs:88-100` | Handles SIGINT/SIGTERM, `Promise.allSettled([vite.close(), host.close()])`, `process.exit(0)`. | Correct. `host.close()` → `registry.stop()` → `teardownLink` per state (`deviceRegistry.ts:1380-1399`) closes serial ports. |
| `server.ts` bind failure | Full teardown (`:563-575`). | None. |
| `server.ts close()` | Missing `unsubscribeTelemetry()` (`:586-591`). | Listener leak only if registry is externally supplied and reused. |
| Timers | `DeviceWatcher` (`devices.ts:458`), `FirmwareAvailabilityCache` (`releases.ts:593`), wifi retry (`deviceRegistry.ts:1375`) all `unref()`'d. | None. |

### config.ts
- `.env` path is `<module>/../../../.env` (`:115`) = repo root for both `src/` and `dist/`. Under a registry install (`npx robot-console` from npm) that is `node_modules/robot-console/.env` — not a place a student or `dotconfig` writes. Works only for a git checkout. In the DB design, firmware sources belong in a `settings` table (or XDG config dir), and `.env` becomes an import path, not the source of truth.
- Re-parse on every call (`:209`) is the "self-heal" design; becomes unnecessary once config lives in the DB.
- `parseFirmwareSource` (`:95-107`) last-colon split is correct for `https://…/repo:tag`; a URL with an explicit port and no tag falls through correctly (candidate contains `/`). `loadEnvFile` (`:170-179`) is exported but unused by the host itself.
- Tests: 20 cases in `config.test.ts`.

### cli.ts / index.ts / bin
- `cli.ts:249-275` hand-rolled `--port` parsing; fine. No `--help`, no `--no-open`, no `--state-dir`.
- `index.ts:9-13` re-exports `server`, `deviceRegistry`, `store/knownRobots` for the UI's type imports (`packages/ui/package.json` devDependency). Whatever replaces the registry must keep exporting the wire types from one place.
- `bin/robot-console.js:22` top-level `await import` of `dist/cli.js` — if `npm run build` was not run, error is a raw ERR_MODULE_NOT_FOUND. Acceptable for now; add a friendlier message.

### dev.mjs
- Registers `tsx` (`:29-31`), imports `server.ts` from source, starts host first, then Vite with `VITE_WS_URL` define (`:73-77`). Sound. Would need only the `startServer` signature change.

### Reuse verdict
- `config.ts`: **Keep-with-refactor** (pure parsers keep; `.env` becomes an importer into DB settings).
- `cli.ts`: **Keep-with-refactor** (add signal handlers → `server.close()`; pass DB path/state dir).
- `index.ts`, `bin/robot-console.js`, `scripts/dev.mjs`: **Keep.**

---

## 5. Dependencies (`packages/host/package.json`, lockfile versions)

| Package | Locked | Native? | `engines` | Maintained? | Risk |
|---|---|---|---|---|---|
| `serialport` | 13.0.0 (`@serialport/bindings-cpp` 13.0.0, `hasInstallScript`) | Yes (N-API, prebuilds via prebuild-install) | **`>=20.0.0`** | Yes | Prebuilds cover mac/win/linux x64+arm64. Already the biggest install-risk item; unavoidable. |
| `node-hid` | 3.4.0 (`hasInstallScript`) | Yes (N-API, prebuilds) | `>=10.16` | Yes | Same prebuild story. Linux needs udev rules for non-root HID. |
| `dapjs` | 2.3.0 | No | `>=8.14` | **Effectively unmaintained** (ARMmbed, last release years ago); UMD-only, typings disagree with runtime (`flash.ts:381-400`). | Medium. Small surface used (`HID`, `CortexM.connect/readMem32/disconnect`, `DAPLink.connect/flash/reset/disconnect`). Candidate to vendor or fork. |
| `bonjour-service` | 1.4.4 (`multicast-dns` 7.2.5) | No | `>=18` | Moderately | Low. |
| `express` | 5.2.1 | No | `>= 18` | Yes | Low. Used only for `static` + catch-all (`server.ts:159-181`); could be `node:http` + `serve-static`, not worth it. |
| `ws` | 8.21.3 | No | `>=10` | Yes | Low. Set `maxPayload`. |
| `open` | 11.0.2 | No | **`>=20`** | Yes | Low; ESM-only. |
| `@robot-console/protocol` | workspace | – | – | – | – |

**Engine mismatch:** root `package.json` declares `node >=18` but `serialport@13` and `open@11` require `>=20`. Node 18 is EOL (Apr 2025) and Node 20 is EOL (Apr 2026, i.e. already). Effective floor today is 20; declared floor should be raised regardless of the SQLite choice.

### SQLite binding recommendation
Constraints: run by students via `npx`, two native modules already present, "watcher threads" (Node `worker_threads` — each thread needs its own connection).

| Option | Install cost | Node floor | Threads | Verdict |
|---|---|---|---|---|
| **`node:sqlite`** (`DatabaseSync`) | None — built in | Unflagged since **22.13 / 23.4**; API "active development" but the used surface (`prepare/run/get/all`, WAL pragmas) has been stable since 22.5. `@types/node ≥22` has types (root already pins `@types/node ^26`). | One `DatabaseSync` per thread, WAL + `busy_timeout`. Sync API blocks the calling thread — fine for a small local DB, and the watchers are threads anyway. | **Recommended.** Set `engines.node >= 22.13`. Node 22 is LTS to Apr 2027; Node 24 LTS from Oct 2025. Zero new install failure modes for students. |
| `better-sqlite3` | Third native module; prebuilds lag each Node major; on a miss → node-gyp → needs Python + C++ toolchain → the classic student `npx` failure. | `>=14` (would let you keep `>=20`) | Yes, same pattern. | Only if Node 20 support is mandatory. It is not (20 is EOL). |
| `sql.js` (WASM) | None | any | **No** — in-memory per thread, manual export to disk, no shared file/WAL, no cross-connection consistency. | Rejected for a DB-as-shared-state design. |

Two caveats to design around regardless of binding:
1. No cross-connection change notifications in SQLite. `DatabaseSync` has no `update_hook` at all. Use a `changes` log table + `MessagePort` ping (or poll the log at 50–100 ms) to drive `server.ts` broadcasts.
2. `serialport`/`node-hid` in `worker_threads`: both are N-API/context-aware and load in workers, but a handle cannot be transferred between threads — the thread that opens a port owns it for life. Per-board owner thread, or one I/O thread with a command queue; not one thread per concern.

---

## 6. Reuse verdict per file

| File | Verdict | One line |
|---|---|---|
| `server.ts` | **Keep-with-refactor** | Keep `listen`/`buildApp`/`toBuffer`/localhost/RunningServer; remove composition root; replace 6 registry subscriptions + `switch` with one DB change-feed subscription + command-handler map; add per-socket `error`, `bufferedAmount`, `maxPayload`, request ids, `seq`. |
| `flash.ts` | **Keep-with-refactor** | Leaf is sound; add timeouts, platform-aware MSD volume listing, rename `*OverSwd`→`*ViaDapLink`. |
| `localHexUpload.ts` | **Keep** | In-memory is correct; optionally TTL. |
| `swdName.ts` | **Keep** | Add timeout wrapper only. |
| `releases.ts` | **Keep-with-refactor** | Keep pure fetch/verify; add `AbortSignal`, `GITHUB_TOKEN`, ETag, list-found-assets diagnostics; delete `FirmwareAvailabilityCache` in favour of a watcher writing a table. |
| `config.ts` | **Keep-with-refactor** | Parsers keep; `.env` becomes an importer into DB settings, not the live source. |
| `cli.ts` | **Keep-with-refactor** | Add SIGINT/SIGTERM → `server.close()`; thread DB path. |
| `index.ts` | **Keep** | Re-export surface must keep exporting wire types. |
| `bin/robot-console.js` | **Keep** | Friendlier "run `npm run build`" message optional. |
| `scripts/dev.mjs` | **Keep** | Only tracks `startServer`'s signature. |
| `packages/host/package.json` | **Keep-with-refactor** | Raise `engines` to `>=22.13`; add nothing for SQLite (`node:sqlite`); consider vendoring `dapjs`. |
| `deviceRegistry.ts` (out of scope, context only) | **Rewrite** | 3873 lines; the DB + owner-thread model replaces `KeyedMutex`/`EndpointState`/event fan-out wholesale. The leaves above are what it should call. |
