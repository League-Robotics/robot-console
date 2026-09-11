# robot-console — preliminary review and rearchitecture proposal

> **Correction (same day, after reading the relay firmware source).** §4.5 below assumes a sweep must enter the data plane and reset the relay per robot. It does not: the relay's command plane already has the radio live — `> <text>` sends one line over the radio and `< <text>` receives, and `!CG` retunes without `!GO` (`microbit-radio-relay/docs/radio-relay-protocol.md` §2, §3.1). A probe is `!CG` + `> ID`, about 0.5 s, no reset. The remaining firmware concern is that `!CG` persists to flash on every change; see `clasi/issues/rearch-12-relay-firmware-non-persisting-tune.md`. The decisions in §7 were settled on 2026-09-11 and are recorded in `docs/design/architecture.md` §2.

Date: 2026-09-11. Branch: `claude/quirky-cori-psaqa7` (no code changed).
Six review passes were run (device model, transport, server/flash/releases, UI, protocol, build/history). Their full write-ups are attached; this document is the synthesis and the proposal. Every claim below has a `file:line` reference in the attached reviews.

Process note: the CLASI MCP server did not connect in this session (`clasi` not on PATH, no `.clasi/oop`). Nothing process-gated was done. Before the planning PR is produced, the MCP server needs to be reachable or the bypass enabled.

---

## 1. Headline

The unreliability is structural, not a set of bugs. Everything about a device lives in one 3,873-line class (`deviceRegistry.ts`) as an in-memory `Map` of a 25-field object, keyed four different ways, mutated from ~30 methods, with 31 hand-placed "broadcast now" calls. There is no representation of *connectable* at all, five different representations of *connected*, and no single place that decides what should be connected. Each transport (USB, relay-radio, mbrelay, mbserial, WiFi) was bolted into that class in successive sprints rather than added as a layer. The UI, by contrast, is already ~90% a passive renderer and is mostly keepable.

Three numbers that frame the rest:

| | |
|---|---|
| Lines in `deviceRegistry.ts` | 3,873 (54% comments, 42 out-of-process patch markers, 17 responsibilities) |
| Link implementations that are one class pasted four times | 85–90% of 2,007 lines |
| Fix commits that landed in `deviceRegistry.ts` | 7 of 16 total; 10 of 16 are connection lifecycle |

Build health is fine: zero type errors in all three packages; 1,314 tests pass. Two host tests fail on Linux only (they assert the macOS `tty.`→`cu.` path translation unconditionally), and 94 protocol tests silently don't run without the vendor submodules. `package-lock.json` is out of sync with `package.json`'s version and dirties the tree on every `npm install`.

---

## 2. Why "connectable" awareness is unreliable today

These are the concrete defects behind "I turn a machine on and the console doesn't notice." Ordered by impact.

**Discovery never re-evaluates**
1. A WiFi robot is shown only if its name is in the USB-seen roster, and the roster→WiFi gate runs only on an mDNS event. A robot never plugged into *this* machine is invisible on WiFi forever; a robot USB-identified *after* its WiFi advert arrived stays invisible until it re-announces.
2. mDNS is queried once at startup and never re-queried. A robot that boots after the host and whose single boot announcement is lost is invisible for up to 60 s. A robot that comes back with a new DHCP address is dialled at the old address every 10 s for up to 180 s because the mDNS library emits no event on an SRV change.
3. Relays and `_mbserial` servers discovered over mDNS are never aged out (only WiFi robots are). Remote `_mbrelay` servers are never turned into connectable endpoints at all; the `mbrelay` transport is dead end-to-end.

**Connection has no recovery path**
4. USB `connect()` failure is terminal until the user clicks. On macOS, opening the port resets the board and HELLO is sent immediately into the 1–2 s boot window with a single 3 s timeout and no retry, so "connected, unresponsive" is common. Linux doesn't reset on open, so the same code behaves differently per platform.
5. All four link classes flip to `closed` on a clean socket/port close *without telling anyone*. The registry keeps `sessionOpen: true`; the 5 s STATUS poll then emits an error every 5 s forever. This is the single largest source of "lots of errors."
6. A dropped radio child has no reconnect; the relay's own session isn't reopened either. Both sit stuck until the user acts.
7. `identify()` can reject on a closed link despite being documented as never-throwing; `resyncSession` awaits it with no `try/finally`, leaving `identifying=true` permanently (suppressing all polls and retries for that endpoint) and propagating an unhandled rejection through `void registry.sendLine(...)`. There is no `unhandledRejection` handler, so this **terminates the host process**.

**The relay is never idle and failover is broken on Linux**
8. Every relay gets a console `UsbSerialLink` auto-opened at attach and re-opened after every bridge failure or close. There is no lease, no owner, no idle state, so nothing can ever sweep with it.
9. Reset happens once before the candidate loop. After candidate 1's `!GO` the relay is in its data plane; candidate 2's `?` sync goes over the radio and times out after 8 s, and so does every later candidate. It works on macOS only because opening the port DTR-resets the board. The test passes because the fake link has no relay state.
10. Every failover attempt does a write-on-read GET against the shared classroom registry for every remembered name, which the spec explicitly forbids.
11. After any relay child closes, the code sends a plain HELLO to a relay still in its data plane, gets null, and reclassifies the relay as `unknown`, so the next Connect is refused as "not a relay." Tests miss this because their fake link always returns a banner.

**Error storms**
12. A stale mDNS record plus the 10 s retry produces a `sessionError` and a full-snapshot broadcast every 10 s per offline robot. Auto-switch emits "failed" on every mDNS change when a user-closed WiFi endpoint coexists with a radio child. Every ack/nack rebroadcasts the entire endpoint list.

---

## 3. Layer-by-layer verdict

| Layer | Verdict | Notes |
|---|---|---|
| `packages/protocol` (2,071 lines) | **Keep.** No rewrites. | Zero I/O, tsc clean, spec traps implemented and tested. Fixes needed: `Session.connect()` doesn't reset the resend streak; `seq` after `connect()` (1) disagrees with `resyncTo(1)` (0); malformed ack/nack throws; `< ` prefix strip and relay `#`-reply regexes are pure grammar living in the host; `REPLY_VERBS` closed allowlist has caused four silent-drop regressions. Add a pure `receive(raw)` facade absorbing `LineRouter`'s ordering. |
| `host/link/*` (2,007 lines) | **Collapse** to one ~250-line `LineLink` core + four 20–40 line adapters. | Add `onClose`, connect timeouts, `destroy()` not `end()`, write-error surfacing, `AbortSignal` through the relay command plane. `LineRouter`, `lineStream`, `pacing` keep as-is. |
| `host/deviceRegistry.ts` (3,873) | **Rewrite.** | 14 salvageable pieces identified with line ranges (status parsing, reply harvesting, telemetry hookup, desync detection, wificred exchange, flash source branch, the reset→boot→candidates procedure). Nothing else survives. |
| `host/relay/RelayConnectionCoordinator.ts` | **Rewrite.** | Policy belongs in the reconciler; must reset between candidates; must not enrol names in the registry. Keep the trail/result types and the "send X, wait for Y" helper. |
| `host/discovery/mdnsDiscovery.ts` | **Keep-with-refactor** as the mDNS watcher. | Parsers and backend seam are good. Write rows instead of maps; handle SRV/TXT updates; age everything; periodic re-query; stop reaching into the library's private `server.mdns`. |
| `host/devices.ts` `DeviceWatcher` | **Keep** as the USB watcher. | Emit an update for a changed serial instead of remove+add (currently causes a double reset and identify on every attach). |
| `host/store/knownRobots.ts`, `wifi/wifiRobotGate.ts` | **Replace / delete.** | Become tables and a `WHERE` clause. Keep the state-dir path resolution and a one-time importer for existing `known-robots.json`. |
| `host/server.ts` | **Keep the shell, replace the middle.** | Keep listen/static/localhost. Replace six registry subscriptions with one DB change-feed subscription; replace the 12-case switch with a handler map. Add per-socket `error` handler (its absence can kill the host), `bufferedAmount` guard, `maxPayload`, SIGINT/SIGTERM. |
| `host/flash.ts`, `swdName.ts`, `localHexUpload.ts` | **Keep.** | Clean leaves. Add timeouts on every DAPLink/HID call; MSD fallback is macOS-only (`/Volumes` hardcoded). |
| `host/releases.ts` | **Keep-with-refactor.** | Pure fetch/verify is sound. Unauthenticated GitHub polling with no ETag or backoff: a classroom behind one NAT shares the 60 req/hr limit and will collectively 403. Availability cache becomes a watcher writing a table. |
| `host/wsMessages.ts` | **Rewrite the endpoint list; keep the rest.** | `EndpointListEntry` is a union-by-optional-fields; `endpointId` encodes structure the UI parses back; `sessionOpen: boolean` can't express connecting/retrying/closed-by-user/stale; relay "connected" is a UI-side join; `error` doubles as a notice channel. |
| `ui/ws/WsProvider.tsx` (1,280) | **Keep-with-refactor.** | Not the problem. It's a store with `useSyncExternalStore` selectors, a log ring and a telemetry ring; it infers nothing. About 150 lines of side-slices collapse once the host publishes one snapshot. |
| `ui/pages/RobotPage.tsx` + all panels | **Keep.** | Drive, telemetry, charts, trace, calibration wizards, functions, configuration are confirmed keepable. Only edits: remove redundant on-open probes (`STATUS`/`GET`/`FUNCS` sent by four components independently) and dedupe the held-drive engine. |
| `ui/pages/RelayPage.tsx` | **Keep-with-refactor.** | Rendering branches are correct. Extract the `RobotSelect` and localStorage helpers it exports to three other files. |
| `ui/pages/FrontPage.tsx` | **Thin rewrite.** | Card rendering reusable; the name-grouping/link-scoring logic duplicates host policy and disappears when the host groups links under a device. |
| `ui/components/RadioAddressDialog.tsx` | **Delete or move host-side.** | Radio overrides live in browser `localStorage` and bypass the host's address resolution on every connect. |

Where the UI knows too much (all small, all should move host-side): `DevicePage` auto-opens WiFi sessions on mount; radio address overrides in `localStorage`; robot switching is a client-sequenced close-then-open; card grouping duplicates auto-switch preference; four components each probe on open.

Tests: 24 of 27 UI test files drive the real store through a fake socket and assert on emitted JSON, so they survive a host rewrite if the wire shapes are regenerated. On the host side, roughly 9,000 of 12,700 test lines are pinned to the code being replaced; `deviceRegistry.test.ts` alone is 4,906 lines and reaches into private state.

---

## 4. Proposed architecture

### 4.1 Shape

```
                 ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌────────────────┐
  watchers       │  UsbWatcher  │  │ MdnsWatcher  │  │ RelaySweeper │  │ FirmwareWatcher│
  (long-lived)   │ 1 s poll     │  │ browse+requery│ │ idle relays  │  │ GitHub, ETag   │
                 └──────┬───────┘  └──────┬───────┘  └──────┬───────┘  └───────┬────────┘
                        │ upsert          │ upsert          │ sightings         │ rows
                        ▼                 ▼                 ▼                   ▼
                 ┌──────────────────────────────────────────────────────────────────────┐
                 │                      SQLite  (node:sqlite, WAL)                      │
                 │  devices · links · sightings · sessions · relay_leases · settings    │
                 │  changes(seq, table, key)  ← every write appends; in-process emitter  │
                 └───────┬──────────────────────────────┬───────────────────────────────┘
                         │ reads desired vs actual      │ change feed
                         ▼                              ▼
                 ┌──────────────┐               ┌──────────────┐        ┌──────────────┐
                 │  Reconciler  │──open/close──▶│  Connector   │        │  Projection  │─▶ ws snapshot
                 │ backoff, prio│               │ one connect+ │        │ SELECT → JSON│   + deltas
                 └──────────────┘               │ identify     │        └──────────────┘
                                                └──────┬───────┘
                                                       ▼
                                                ┌──────────────┐
                                                │  LineLink    │ core + usb/tcp/relay adapters
                                                │  + Harvester │ status/funcs/id/telemetry → sessions row
                                                └──────────────┘
```

Rules:
- **Watchers only observe and write.** They never open a session. USB watcher upserts `devices`/`links(transport=usb)`; mDNS watcher upserts `links(transport=wifi|mbrelay|mbserial)` with `last_seen`; the sweeper writes `sightings(transport=radio)`.
- **The reconciler is the only thing that decides what to connect.** It reads the DB (desired policy + actual link state + backoff), and schedules Connector jobs. All the policy currently scattered across `syncWifiEndpoints`, `retryWifiAutoConnects`, `autoConnectWifiRobot`, `autoSwitchRadioToWifi`, and `requestOpen`'s no-op rules lives here, once.
- **One Connector.** One `connectAndIdentify(linkRow) → Session` for every transport, cancellable, with per-board exclusivity from a `board_owner` row instead of an implicit mutex. Today there are four copies.
- **UI renders the DB.** The projection is a `SELECT` per client, broadcast when the change feed says a relevant row changed. Thirty-one manual `emitDevices()` calls become zero.
- **Latency-sensitive traffic bypasses the DB.** `line`, `send-command`, and `telemetry` go straight between the socket and the owning link. Only *state* goes through the DB.

### 4.2 Schema sketch

```sql
devices   (id INTEGER PK,            -- FICR.DEVICEID[1], decoded uint32; the target chip
           name CHAR(5),             -- derived, indexed, NOT unique (3,125-name space collides)
           kind TEXT,                -- 'robot' | 'relay'
           role, program, version,   -- from banner / ID reply, nullable
           usb_serial TEXT,          -- KL27 interface chip; display hint only
           radio_channel, radio_group, radio_source,  -- overrides only; default recomputed
           first_seen, last_seen, mine BOOLEAN)       -- 'mine' replaces the roster gate
links     (id TEXT PK, device_id, transport,          -- usb | wifi | radio | mbrelay | mbserial
           address JSON,             -- port path / host:port / relay+ch+grp
           state TEXT,               -- discovered | connectable | connecting | connected |
                                     --   unresponsive | failed | closed_by_user | stale
           state_reason, state_since, last_seen, next_retry_at, fail_count)
sightings (id, device_id, transport, via_link_id, at, ok BOOLEAN, detail)   -- every probe result
sessions  (link_id PK, opened_at, seq, pending, last_done, robot_status JSON, functions JSON)
relay_leases (relay_link_id PK, owner TEXT, since)    -- 'sweep' | session id | NULL
settings  (key PK, value)                             -- firmware sources, wifi creds, state dir
changes   (seq INTEGER PK, tbl, key, at)              -- change feed for the projection
```

Key on the target chip id, not the name: two robots in a 100-robot fleet share a name with ~79% probability and also share a radio address. The name stays as the indexed radio identity.

### 4.3 Threads or not

The stakeholder asked for persistent processes or threads. Recommendation: **long-lived async tasks in one Node process with one DB connection**, not `worker_threads`, for three reasons that came out of the review:

1. SQLite has no cross-connection change notification and `node:sqlite` has no `update_hook`. One connection on one thread gives an in-process change feed for free; threads force a polled `changes` table.
2. `serialport` and `node-hid` handles cannot be transferred between threads; the thread that opens a port owns it for life. A per-transport thread model would need a per-board owner thread anyway.
3. Nothing here is CPU-bound. The watchers are already `setInterval` loops; making them explicit long-lived tasks with their own lifecycle (start/stop/health row) gets the isolation the stakeholder wants without the IPC.

If a component later proves to need a thread (the DAPLink flash is the only candidate), it can move without changing the schema.

### 4.4 SQLite binding

`node:sqlite` (built in, no native install) with `engines.node >= 22.13`. The root `package.json` says `>= 18`, but `serialport@13` and `open@11` already require `>= 20`, and Node 20 is EOL, so the floor has to move regardless. `better-sqlite3` would add a third native module to a tool students run via `npx`; `sql.js` has no shared-file model. Details in the server/flash review §5.

### 4.5 Radio relay sweep

Per remembered robot not currently reachable over USB or WiFi, on an idle relay:

```
!CG <ch> <grp>  → wait "# channel: ch group: grp"
!GO             → wait "# entering data plane"
ID              → wait ≤ 500 ms for `id` (unsequenced; NOT HELLO, which would reset any other host's session on that channel)
record sighting(ok|null)
RESET relay (DAPLink) → boot → `?` sync            ← no in-band escape from the data plane
```

The reset-per-robot is the dominant cost: 2–3 s per name, so 20 remembered robots is about a minute per pass. That is a **firmware limitation** of the relay (no escape from the data plane, spec §6). A firmware request for either a command-plane probe verb (`!TX <ch> <grp> <line>`) or an escape sequence would cut a pass to a few seconds. Also: a relay enumerated serial-only (no HID) cannot be reset and can only be swept once per attach.

Handback: `relay_leases.owner = 'sweep'` with an `AbortController`; a user `session-open` on that relay revokes the lease, the sweep finishes the current name and releases the port, the user path does its existing reset+handshake. On child close the relay returns to idle (lease NULL) rather than reopening a console session, and the sweep re-acquires after a quiet period. The relay console auto-open must go for any of this to work.

### 4.6 New wire shape (sketch)

One `snapshot` message: `devices[]`, each with `links[]` rows carrying `{id, transport, address, state, reason, since, nextRetryAt, lastSeen}`, an optional `session` sub-object, and `capabilities` (canOpen, canFlash, canProvisionWifi) so the UI stops deriving them. `notice` becomes its own message type with a level. `line`, `telemetry`, `flash-*`, `wifi-*` stay as they are. Add a monotonic `seq` so the UI can detect gaps on reconnect. Radio overrides become a `set-radio-override` client message; `radio:{}` on `session-open` goes away.

---

## 5. Spec and use cases

The existing `specification.md` is a good record of protocol traps but is stale in places (says `TLM HDR` is the recovery path — firmware lacks the verb; says 11 sequenced verbs — code has 13; lists `WifiUdpLink` — never built, WiFi is TCP without `TCP_NODELAY`). `usecases.md` has ten flows, none of which describe presence or awareness, which is exactly the part that's broken.

Draft use cases the new spec needs (to be written properly in the planning PR):

| UC | Flow | Acceptance |
|---|---|---|
| P1 | Plug a micro:bit into USB | Card appears with name within 2 s; role within 5 s; one reset, one identify |
| P2 | Power on a WiFi-provisioned robot | Card shows `reachable over WiFi` within 10 s of its first announcement, whether or not it has ever been on USB |
| P3 | Robot changes IP / reboots | New address dialled within one re-query interval; no stale-address error spam |
| P4 | Robot goes away | Link marked `stale` with last-seen time within one age-out interval; card stays with "last seen" |
| P5 | Relay attached, idle | Sweep runs; remembered robots that answer show `reachable over radio via <relay>` with a last-checked time |
| P6 | User opens a robot | Host picks the best available link (USB > WiFi > radio) unless told otherwise; UI does not sequence transports |
| P7 | User connects through a relay while a sweep is running | Sweep yields within one probe (~3 s); user handshake proceeds; sweep resumes after close |
| P8 | Link drops (clean close or silence) | State flips to `unresponsive` within one poll; reconnect with backoff; one notice, not one per poll |
| P9 | Host restarts | Remembered devices and last-seen times render immediately from the DB; live links re-probed |
| P10 | Browser tab loses the host | Banner shown; controls disabled; fresh snapshot on reconnect (existing open issue) |

---

## 6. Preliminary sprint shape

Three sprints plus a spec pass. Sizes are relative; details go in the planning PR after direction.

**Sprint 0 (spec, small)** — Rewrite `specification.md` §4 (host) and add the presence use cases above; correct the stale protocol statements; define the schema and wire shape as the contract every later ticket builds against.

**Sprint A — Store, watchers, one connector (large)**
- `node:sqlite` store module, schema, migration/importer for `known-robots.json` and `wifi-credentials.json`, in-process change feed.
- USB watcher and mDNS watcher writing rows (update-not-remove-add; re-query; age all service types; SRV changes).
- `LineLink` core + usb/tcp/relay adapters with `onClose`, timeouts, abort.
- Single Connector; Reconciler with backoff and user-close precedence; ReplyHarvester writing `sessions`.
- Projection → new snapshot; `server.ts` thinned; per-socket error handling; signal handlers.
- UI: store adapter to the new snapshot, delete UI-side open policy and localStorage radio, host-grouped cards. Feature parity is the exit criterion, checked against the UI review's §1 inventory.
- Delete `deviceRegistry.ts`, `knownRobots.ts`, `wifiRobotGate.ts`, three of four link classes and their tests.

**Sprint B — Relay ownership and sweep (medium)**
- `relay_leases`; remove relay console auto-open; RelayBridger with reset between candidates; no registry write-on-read during failover.
- RelaySweeper with `ID` probe, `sightings`, backoff per name, handback via abort.
- Front page renders `reachable over radio via <relay>` and last-checked times.
- Firmware request filed for a command-plane probe or data-plane escape.

**Sprint C — Leaves and hygiene (medium)**
- Firmware availability as a watcher writing a table; ETag + token + backoff; list found assets in the no-asset message.
- Flash/SWD timeouts; platform-aware MSD fallback.
- Protocol: `receive()` facade, relay `#`-reply parser, `< ` strip, `connect()` streak reset, `seq` consistency, non-throwing ack/nack, fixture loads inside `describe`s.
- UI dedupe: shared `RelayConnectControls`, one held-drive hook, one calibration table, one dialog shell.
- Engines bump, lockfile sync, Linux-safe path tests.

---

## 7. Decisions needed before the planning PR

1. **WiFi visibility policy.** Today a robot is hidden unless it has been seen over USB on this machine. Proposal: show every discovered device, with the roster as a `mine` flag that sorts and highlights rather than filters. This is what "know as soon as possible" implies, but a classroom will show other students' robots.
2. **Node floor to 22.13** for `node:sqlite`, or `better-sqlite3` to hold at 20 (EOL). Recommend 22.13.
3. **In-process tasks vs `worker_threads`.** Recommend in-process (§4.3). Say so if you want real threads regardless.
4. **Relay firmware change.** Is a command-plane probe verb or a data-plane escape on the table for the relay firmware? It changes the sweep from ~3 s/robot to ~0.3 s/robot and decides how ambitious Sprint B can be.
5. **Remote `mbrelay` / `mbserial` transports.** Both are dead or nearly dead end-to-end today. Make them real (they fit the `links` table cleanly) or drop them from scope?
6. **Wire contract: adapter or clean break.** Recommend a clean new snapshot with a short-lived UI adapter during Sprint A; the alternative is preserving `EndpointListEntry` and its eight optional-field rules.
7. **Test policy.** ~9,000 lines of host tests are pinned to the code being deleted. Confirm they go rather than get ported.
8. **Radio address overrides** move from browser `localStorage` to the host DB (per-host, not per-browser). Confirm.

---

## 8. Attachments

- `01-host-device-model.md` — state inventory, pipelines, duplication, god-object split, wire contract, salvage list with line ranges
- `02-host-transport.md` — link matrix, duplication measurement, relay state machine, mDNS behaviour, failure modes ranked, sweep requirements
- `03-host-server-flash-releases.md` — server, flash, releases, startup/shutdown, dependency and SQLite analysis
- `04-ui.md` — full feature inventory to preserve (§1), where the UI knows too much, duplication, per-file verdicts
- `05-protocol.md` — spec §3/§6 trap checklist, session.ts bugs, relay sweep needs, DB key recommendation
- `06-build-tests-history.md` — build/test results, test suite shape, fix-commit mining, sprint evolution, swallowed catches
