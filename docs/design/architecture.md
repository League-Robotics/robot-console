# robot-console — Host Architecture (v2)

Status: accepted direction, 2026-09-11. Supersedes the host half of
`specification.md` §4 (`deviceRegistry.ts` and its device model). The
protocol package (§3) and the UI screens (§5) are unchanged in intent.
The code review that motivated this document is in
`docs/reviews/2026-09-11/`.

## 1. The problem this solves

The console's job is to know, at every moment, which machines are
reachable and over which links, and to make that state visible and
usable within seconds of it changing. Today that knowledge is an
in-memory map of one 25-field object per endpoint inside a single
3,873-line class, keyed four different ways and mutated from about
thirty methods. There is no representation of *connectable*, five
representations of *connected*, and no one place that decides what
should be connected. Each transport was bolted on in a later sprint.
The consequences are catalogued in
`docs/reviews/2026-09-11/PRELIMINARY-REPORT.md` §2.

The redesign moves all device and link state into a SQLite database on
the host, splits discovery from connection, and makes the UI a view over
that database.

## 2. Stakeholder decisions (2026-09-11)

These are settled and are not to be reopened by sprint planning.

| Decision | Choice |
|---|---|
| WiFi visibility | **Gated on a prior USB identification on this machine.** Plugging a robot in establishes ownership; students must not see or drive each other's robots over WiFi. The gate must re-run whenever the roster changes, not only on mDNS events. |
| SQLite binding | `node:sqlite` (`DatabaseSync`), WAL. `engines.node >= 22.13`. |
| Concurrency | Long-lived async tasks in one process, one DB connection. No `worker_threads`. |
| Remote `mbrelay` / `mbserial` | Made real: discovered by the mDNS watcher, stored as links, connectable through the one connector. |
| Wire contract | Clean break. New `snapshot` shape; the UI store adapts. `EndpointListEntry` is retired. |
| Old host tests | Tests pinned to `deviceRegistry.ts`, the coordinator, and the four link classes are deleted with the code, not ported. |
| Radio address overrides | Stored in the host DB per device, not in browser `localStorage`. |
| Relay firmware | Changes to `microbit-radio-relay` are allowed. The one request is a non-persisting tune for sweeps (§7.3). |

## 3. Components

```
watchers (observe, write rows, never open sessions)
  UsbWatcher        1 s DAPLink enumeration                  → devices, links(usb)
  MdnsWatcher       browse + periodic re-query, all 5 types  → links(wifi|mbrelay|mbserial), services
  RelaySweeper      idle relays probe remembered robots      → sightings(radio), links(radio)
  FirmwareWatcher   GitHub release availability, ETag        → firmware

store               node:sqlite, WAL, one connection; every write appends to `changes`
                    and emits on an in-process change feed

reconciler          the only component that decides what to connect; reads desired
                    policy + actual state + backoff; schedules connector jobs

connector           one connectAndIdentify(link) → Session, for every transport;
                    cancellable; per-board exclusivity via `board_owner`

linelink            one line-transport core + adapters (serial, tcp, relay-preamble);
                    surfaces close; bounded connect; abortable

harvester           per open session: status / funcs / id / thdr,t / wificred / ack-nack
                    → sessions row; telemetry to its own stream

projection          SELECT → snapshot JSON; broadcast on change feed

server              HTTP static + one WebSocket; snapshot on connect, snapshot on change,
                    line/telemetry/flash/wifi streams; command handler map
```

Rules:

1. Watchers only observe and write. A watcher never opens a session, never
   calls the connector, never touches another watcher's rows.
2. The reconciler is the only caller of the connector. All policy lives
   there: auto-connect, retry with backoff, user-close precedence, link
   preference, "never steal a relay a student is using."
3. Nothing outside `store/` issues SQL. The store exposes typed
   operations (`upsertUsbDevice`, `markLinkState`, `recordSighting`,
   `acquireRelayLease`, …) and the change feed.
4. `line`, `send-command`, and `telemetry` bypass the DB. They go
   directly between the socket and the owning link. Only *state* is
   written.
5. Every long-lived task has `start()`, `stop()`, and a `tasks` row with
   a heartbeat, so a wedged watcher is visible in the UI and to tests.

## 4. Data model

Identity: the target chip. `FICR.DEVICEID[1]` (the decoded uint32 that
appears as `serial` in every banner dialect and that SWD reads from a
blank board) is the primary key. The five-letter name is derived from it
and is the radio identity, but 3,125 names over a fleet of 100 robots
collide with ~79% probability, and colliding names also share a derived
radio address. Name is indexed, not unique.

```sql
CREATE TABLE devices (
  id            INTEGER PRIMARY KEY,   -- FICR.DEVICEID[1], decoded
  name          TEXT NOT NULL,         -- deviceIdToName(id); CHECK shape zvgpt/uoiea
  kind          TEXT NOT NULL,         -- 'robot' | 'relay'
  role          TEXT,                  -- banner role token (NEZHA2, RADIOBRIDGE, …)
  program       TEXT, version TEXT,    -- from the ID reply; 'calibration' is derived
  usb_serial    TEXT,                  -- KL27 interface-chip serial; display hint only
  radio_channel INTEGER, radio_group INTEGER,
  radio_source  TEXT,                  -- 'override' | 'registry' | NULL (derived default)
  owned         INTEGER NOT NULL DEFAULT 0, -- 1 once identified over USB on this host
  first_seen    INTEGER NOT NULL, last_seen INTEGER NOT NULL
);
CREATE INDEX devices_name ON devices(name);

CREATE TABLE links (
  id            TEXT PRIMARY KEY,      -- opaque; never parsed by the UI
  device_id     INTEGER REFERENCES devices(id),   -- NULL until identified
  transport     TEXT NOT NULL,         -- 'usb' | 'wifi' | 'radio' | 'mbrelay' | 'mbserial'
  address       TEXT NOT NULL,         -- JSON: {path,hidPath} | {host,port} | {relayLinkId,channel,group} | …
  state         TEXT NOT NULL,         -- see §5
  state_reason  TEXT,
  state_since   INTEGER NOT NULL,
  last_seen     INTEGER,               -- last time the watcher saw the underlying thing
  next_retry_at INTEGER, fail_count INTEGER NOT NULL DEFAULT 0,
  user_closed   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX links_device ON links(device_id);

CREATE TABLE services (                -- raw mDNS observations, one per instance+type
  instance      TEXT NOT NULL, type TEXT NOT NULL,
  host TEXT, port INTEGER, txt TEXT,   -- txt as JSON
  first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL,
  PRIMARY KEY (instance, type)
);

CREATE TABLE sightings (               -- every probe result, any transport
  id INTEGER PRIMARY KEY,
  device_id INTEGER, name TEXT,        -- name kept even when device_id unknown
  transport TEXT NOT NULL, via_link_id TEXT,
  at INTEGER NOT NULL, ok INTEGER NOT NULL, detail TEXT
);
CREATE INDEX sightings_device_at ON sightings(device_id, at);

CREATE TABLE sessions (                -- one per open link
  link_id TEXT PRIMARY KEY REFERENCES links(id),
  opened_at INTEGER NOT NULL,
  seq INTEGER, pending INTEGER, last_done INTEGER, last_done_reason TEXT,
  robot_status TEXT, functions TEXT    -- JSON
);

CREATE TABLE board_owner (             -- exclusivity for one physical USB board
  usb_serial TEXT PRIMARY KEY,
  owner TEXT NOT NULL,                 -- 'naming' | 'session:<linkId>' | 'flash' | 'sweep'
  since INTEGER NOT NULL
);

CREATE TABLE relay_leases (
  relay_link_id TEXT PRIMARY KEY REFERENCES links(id),
  owner TEXT NOT NULL,                 -- 'sweep' | 'session:<childLinkId>'
  since INTEGER NOT NULL
);

CREATE TABLE firmware (
  kind TEXT PRIMARY KEY,               -- 'relay' | 'robot'
  repo TEXT, tag TEXT, available INTEGER, reason TEXT, message TEXT,
  etag TEXT, checked_at INTEGER
);

CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);   -- firmware sources, wifi creds, state dir
CREATE TABLE tasks (name TEXT PRIMARY KEY, state TEXT, heartbeat_at INTEGER, detail TEXT);
CREATE TABLE changes (seq INTEGER PRIMARY KEY, tbl TEXT NOT NULL, key TEXT, at INTEGER NOT NULL);
```

Notes:

- `devices.owned` is the WiFi gate. It is set by the USB watcher's identify
  and never by any network observation. The projection hides any
  `wifi`/`mbserial` link whose device is not `owned`, and the reconciler
  never connects to one.
- `links.address` for a radio link names the relay link it rides on and
  the `(channel, group)` used. A radio link row exists only after a
  sweep sighting or a successful bridge.
- Migration imports `known-robots.json` (names, first/last seen, last USB
  serial → `devices` with `owned = 1`, `kind = 'robot'`) and
  `wifi-credentials.json` → `settings`, once, then leaves the files in
  place.
- The DB lives in the existing state directory
  (`resolveKnownRobotsFilePath`'s parent). One file, `console.sqlite`.

## 5. Link states

```
discovered  ── identified/owned ──▶ connectable ── reconciler ──▶ connecting ──▶ connected
    │                                    ▲                            │              │
    │ last_seen ages out                 │ backoff elapsed            │ fail         │ close / silence
    ▼                                    │                            ▼              ▼
  stale ◀──────────────────────────── failed ◀──────────────────── unresponsive
                                         ▲
                              closed_by_user (reconciler will not reopen until asked)
```

| State | Meaning | Who sets it |
|---|---|---|
| `discovered` | The watcher sees the thing; nothing has identified it or its device is not owned | watcher |
| `connectable` | Policy allows a session and none is open | reconciler |
| `connecting` | A connector job is in flight | reconciler |
| `connected` | Session open, banner or ID seen | connector |
| `unresponsive` | Session open but the link went silent or closed underneath | harvester / linelink `onClose` |
| `failed` | Last connect attempt failed; `next_retry_at` and `fail_count` set | connector |
| `closed_by_user` | Explicit close; no auto-reconnect | server command |
| `stale` | Watcher has not seen the underlying thing for longer than its TTL | watcher sweep |

Presence for the UI is derived from these plus `last_seen` and the most
recent `sightings` row, never inferred from console text.

## 6. Watchers

### 6.1 USB

`devices.ts`'s `DeviceWatcher` stays as the enumerator. Changes:

- A device whose serial-vs-HID persona arrives across two polls is an
  *update*, not remove+add. Today that causes two SWD reads, two port
  opens (two resets on macOS), and two HELLOs per attach.
- On add: take `board_owner = naming`, read the SWD name, write
  `devices` (`owned = 1` if the banner or ID later confirms a robot),
  write `links(usb, discovered)`, release the owner. The reconciler does
  the rest.
- On remove: mark the link `stale`, close any session, release owners.

### 6.2 mDNS

`mdnsDiscovery.ts`'s parsers and backend seam stay. Changes:

- Browse all five types (`_mbrelay._tcp`, `_mbserial._tcp`,
  `_mbflash._tcp`, `_robotlink._tcp`, `_robotlink._udp`) and re-query
  periodically (`browser.update()`), so a robot whose boot announcement
  was missed is found within one interval.
- Every observation upserts `services` with `last_seen`, and upserts a
  `links` row: `_robotlink.*` → `wifi` keyed by TXT `name`; `_mbserial`
  → `mbserial` (instance name is the robot name); `_mbrelay` → `mbrelay`
  (the relay pool itself, with `registry=<port>` from TXT).
- SRV/TXT changes update the row's address and fire a change. A link
  whose address changed while a session is open is marked
  `unresponsive` so the reconciler reconnects to the new address.
- Age every type with `WHERE last_seen < now - ttl`; no service-type
  keeps a private liveness map.

### 6.3 Relay sweeper

See §7.

### 6.4 Firmware

`releases.ts`'s pure fetch/verify functions stay. The poll loop becomes a
task writing `firmware` rows, with `If-None-Match`, an optional
`GITHUB_TOKEN`, and backoff on 403/429. Unauthenticated hosts behind one
classroom NAT share a 60 req/hr limit.

## 7. Relay ownership and sweep

### 7.1 Facts (verified against `microbit-radio-relay` docs and source)

- The command plane already has the radio live: `> <text>` sends one line
  over the radio, `< <text>` delivers received lines, and `!CG <ch> <grp>`
  retunes, all without `!GO`. A probe therefore needs **no data-plane
  entry and no reset**.
- There is no in-band escape from the data plane. Once `!GO` has been
  sent the only way back is a reset: DAPLink reset over HID (needs the
  HID interface), a serial break (works reliably on Linux; DTR does not),
  or a port reopen (macOS only).
- Every `!CG` is persisted to flash (`saveConfig()` skips only when the
  value is unchanged). A sweep that retunes every few seconds would write
  flash thousands of times a day. This is the one firmware request:
  a non-persisting tune (`!CGT <ch> <grp>` or `!CG <ch> <grp> NOSAVE`),
  or a one-shot probe (`!TX <ch> <grp> <line>` that tunes, sends, listens
  briefly, and restores). Until it lands, the sweeper must rate-limit
  itself (one retune per name per several minutes) and the issue says so.

### 7.2 Ownership

A relay's port is held by exactly one owner at a time, recorded in
`relay_leases`: `sweep`, or `session:<childLinkId>` while a student is
bridged through it. There is no auto-opened console session on a relay
any more; the relay's own console (the `RelayPage` console when no child
is connected) is served by whichever owner holds the port, or by a short
lease taken on demand when the user types. `KeyedMutex` remains as the
operation serializer underneath the lease.

Handback: a user `session-open` on a relay revokes the sweep lease via an
`AbortController`. The sweeper finishes the current probe (≤ 1 s),
releases the port, and the user path proceeds. On child close the relay
returns to idle (no lease); the sweeper re-acquires after a quiet period.

### 7.3 Sweep

```
for each owned robot with no connected usb|wifi link, oldest sighting first:
  address = device override ?? registry (non-mutating, cached) ?? nameToRadioAddress(name)
  !CG ch grp            → wait "# channel: ch group: grp"  (≤ 500 ms)
  > ID                  → wait "< id …" whose name matches   (≤ 500 ms)
  record sightings(radio, ok|fail); on ok upsert links(radio, connectable)
  sleep ≥ inter-probe gap; check abort signal
```

- `ID`, not `HELLO`: HELLO resets the sequence state of any robot on that
  channel mid-session with another host. `PING` gives no identity, and 125
  names share a channel.
- A student's bridge (`!GO`) still uses the existing preamble and the
  reset-between-candidates fix; the sweep never enters the data plane.
- Back off names that fail several sweeps in a row; the front page shows
  `last checked` and `reachable over radio via <relay>` from `sightings`.

## 8. Connector and reconciler

The connector is one function: given a `links` row, acquire the board
owner (USB) or relay lease (radio), open the transport with a bounded
timeout, run the preamble if any, send HELLO, wait for the banner with a
retry that covers the macOS boot window, classify, write `devices` and
`sessions`, attach the harvester, and return. It is cancellable at every
await. It replaces `connectAndIdentifyOverLink`, `reidentifyAfterFlash`'s
copy of it, the coordinator's `attempt`, and `openRobotViaRelay` step (f).

The reconciler runs on every change-feed event and on a slow tick:

1. For each device: preferred link order is `usb > wifi > mbserial >
   radio > mbrelay`. If the preferred link is `connectable` and nothing
   for that device is `connected`, schedule a connect.
2. Never connect a `wifi`/`mbserial` link whose device is not `owned`.
3. Never reopen a `closed_by_user` link until a user `session-open`.
4. `failed` links retry at `next_retry_at` with exponential backoff capped
   at 60 s, and a single notice per state change, not per attempt.
5. Radio bridging is user-initiated only (a sweep sighting makes the
   link `connectable`; the reconciler does not auto-bridge).
6. Switching a relay to another robot is one command
   (`session-open {relayLinkId, name}`); the reconciler closes the old
   child and opens the new one. The UI never sequences two operations.

## 9. Wire contract

One `snapshot` message replaces `endpoints`, `rememberedRobots`,
`discoveredServices`, `firmwareStatus`, and the per-endpoint flash and
WiFi side channels:

```ts
type Snapshot = {
  type: "snapshot"; seq: number; at: number;
  devices: Array<{
    id: number; name: string; kind: "robot" | "relay"; role: string | null;
    program: string | null; version: string | null; owned: boolean;
    radio: { channel: number; group: number; source: "override" | "registry" | "derived" };
    lastSeen: number; lastChecked: number | null;
    links: Array<{
      id: string; transport: Transport; label: string;        // "USB · /dev/cu.usbmodem… · ID 1a2b"
      state: LinkState; reason: string | null; since: number;
      lastSeen: number | null; nextRetryAt: number | null;
      via?: { relayLinkId: string; relayName: string; channel: number; group: number; addressSource: string };
      session?: { seq: number; pending: number; lastDone: number | null; lastDoneReason: string | null;
                  robotStatus: RobotStatus | null; functions: RobotFunction[] | null };
      flash?: { source: FirmwareSourceRef; phase: FlashPhase };
      capabilities: { open: boolean; close: boolean; flash: boolean; provisionWifi: boolean };
    }>;
  }>;
  unassigned: Array<Link>;            // USB boards not yet named/identified
  relays: Array<{ linkId: string; lease: "sweep" | "session" | null; bridging?: { state: "connecting" | "failed"; robotName?: string; error?: string } }>;
  firmware: Record<"relay" | "robot", FirmwareAvailability>;
  wifi: { ssid: string | null; source: string | null };
  tasks: Array<{ name: string; state: string; heartbeatAt: number }>;
};
type Notice = { type: "notice"; level: "info" | "warn" | "error"; linkId?: string; text: string; at: number };
```

Kept as they are: `line`, `telemetry`, `flash-progress`, `flash-result`,
`flash-local-begin/ready` and the binary frame, `wifi-provision-result`,
`send-command`, `flash-start`, `forget-known-robot` (now `forget-device`).
Changed: `session-open` takes `{linkId}` or `{relayLinkId, name}`; the
`radio: {}` override argument is removed in favour of
`set-radio-override {deviceId, channel, group} | {deviceId, clear: true}`.
`error` becomes `notice`. Every server message carries `seq`.

Link ids are opaque. The UI never parses them.

## 10. UI

The screens stay. `WsProvider` keeps its store, selectors, log ring, and
telemetry ring, and gains one `snapshot` slice in place of five side
slices. Removed from the UI: WiFi auto-open on the device page,
`localStorage` radio overrides, client-sequenced close-then-open when
switching robots, name-based card grouping and link scoring, and the
four independent on-open `STATUS`/`GET`/`FUNCS` probes (the host probes
on identify and polls `STATUS`). The feature inventory the rewrite must
satisfy is `docs/reviews/2026-09-11/review-ui.md` §1.

## 11. Testing

- Store: schema, migrations, importer, change feed, every typed operation.
- Watchers: fake enumerator / fake bonjour backend → assert rows, not
  events. The mDNS re-query, aging, and SRV-change paths each get a test.
- Connector: one fake byte-stream harness shared by all adapters; the
  reset-between-candidates and macOS-boot-window retries get tests that
  model relay plane state.
- Reconciler: table-driven; given rows, assert scheduled jobs. This is
  where the WiFi ownership gate, user-close precedence, backoff, and link
  preference are pinned.
- Sweeper: fake relay that answers `!CG` and `> ID`; assert `sightings`
  rows, lease handback within one probe, and rate limiting.
- Projection: golden snapshot JSON from seeded rows.
- UI: existing FakeSocket tests, fixtures regenerated to the new snapshot.
- Deleted: `deviceRegistry.test.ts`, `RelayConnectionCoordinator.test.ts`,
  three of four `link/*.test.ts`, `knownRobots.test.ts`,
  `wifiRobotGate.test.ts`, and the UI tests that pin removed client
  policy.

## 12. Out of scope for this arc

Telemetry or console-line persistence in the DB; multi-host coordination
beyond the existing mbrelay registry; authentication; any change to the
robot firmware.

## 13. MCP subsystem (sprint 019)

Consolidated from sprint 019's own `sprint.md` (tickets 004-008), per
this project's `consolidate-architecture` convention — this section
synthesizes the design those tickets settled on rather than restating
`sprint.md`'s own Architecture section verbatim.

### 13.1 Purpose and boundary

An MCP (Model Context Protocol) tool surface lets an external agent
(Claude Code or any other MCP client) inspect devices, open/close
sessions, send commands, and start motion/flashing — through the exact
same store, connector, and reconciler this document already describes,
never a parallel path. `mcp/server.ts` owns transport wiring and tool
registration only; every tool delegates the actual device/link/session
logic to the same collaborators §3/§8 already describe. This is a bolt-on
tool surface, not a second host.

### 13.2 Transport: Streamable HTTP, not stdio

Mounted at `POST/GET/DELETE /mcp` on the *existing* Express `app` (the
same one §9's wire contract server binds to), on `127.0.0.1` only —
never a second process, which would recreate the exact "two processes
fighting over one port/lease" shape §7 already fixed once, applied to
the whole host. `@modelcontextprotocol/sdk` 1.30.0 (pinned). A
`Mcp-Session-Id`-keyed map of `{server, transport}` pairs is kept for
the process's lifetime once a client's `initialize` negotiates one — no
eviction policy yet (a long-lived agent session, not a multi-tenant
server). The SDK's own `localhostHostValidation()` middleware rejects
any request whose `Host` header names anything but
`localhost`/`127.0.0.1`/`[::1]` — belt and suspenders on top of the
`127.0.0.1` bind. Remote/non-localhost MCP access is out of scope.

### 13.3 Tool categories

| Category | Tools | Module |
|---|---|---|
| Inspect | `list_devices`, `get_device_status` | `mcp/tools/inspect.ts` |
| Connect | `open_session`, `close_session`, `send_command` | `mcp/tools/connect.ts` |
| Drive | `request_drive` | `mcp/tools/drive.ts` |
| Flash | `request_flash` | `mcp/tools/flash.ts` |

Inspect tools read the same `buildSnapshot`-shaped projection §9
describes (`devices[]`/`unassigned`, now including each device's
`recentAgentActions` — §13.4). Connect tools call the same
reconciler `requestOpen`/`requestClose`/`sessions.get` the UI's own
WS handlers use (§8) — an MCP-opened session is indistinguishable, at
the connector/reconciler layer, from a browser-opened one. `send_command`
rejects the seven gated motion-starting verbs (`GATED_MOTION_VERBS`,
shared with `request_drive`'s own allowlist so the two sets can never
drift apart), directing the caller to `request_drive` instead; STOP/ESTOP
and every other verb always go through `send_command` unconditionally.

**No approval step, anywhere.** An early design (this sprint's own
planning phase) considered a `pending_actions` approve/deny/expire gate
for `request_drive`/`request_flash`. It was dropped before
implementation (`sprint.md`'s Architecture Revision, tickets 006-008):
both tools validate their request and execute it — immediately,
unconditionally, the instant validation passes. `request_drive` and
`request_flash` are simply the correct, validating entry points for
motion-starting verbs and firmware flashes, respectively; there is
nothing to wait on and nothing to poll.

### 13.4 Audit and visibility: `agent_actions`

Every executed `request_drive`/`request_flash` call — success or
failure — writes exactly one row to a new `agent_actions` table
(`mcp/agentActionLog.ts`): `kind` (`'drive' | 'flash'`), `linkId`/
`deviceId`, `caller`, `params`, `executedAt`, `result`
(`'sent' | 'failed'`), `resultReason`. A call rejected before reaching
`sendCommand`/`startFlash` (non-allowlisted verb, malformed fields, an
unflashable target) writes **no** row — the audit log records what
actually reached the wire/board, not every attempt. `caller` is read
from the MCP client's own `initialize` handshake
(`clientInfo.name` — `server.server.getClientVersion()`), falling back
to the literal string `"unknown"` (never `null`/`undefined`, since the
column is `NOT NULL`) for a server instance that never itself processed
`initialize` (a test harness invoking a tool's handler directly, mainly).

Three places surface this log, all reading real `agent_actions` rows,
never a parallel notion of "recent activity":

- **`sessions` table gains `origin`/`caller`** (`'ui' | 'mcp'`, plus the
  caller name): set when a session opens, read by the UI's own
  `FrontPage.tsx` (`DeviceConnectionRow`, inside each connection chip's
  hover/focus popover) to show `Agent: <caller>` on an MCP-opened
  session exactly where a browser-opened one already shows its own
  state — the stakeholder's original ask ("it shows up in the robot
  console"), not a gate.
- **`DiagnosticsPanel`'s "Recent agent activity"** (`data-testid=
  "recent-agent-activity"`, on each device's Diagnostics tab) lists a
  device's own `recentAgentActions` (bounded, most-recent-first), or an
  explicit empty state ("No agent activity recorded for this device
  yet.") for a device no agent has ever touched — never a stray box, never
  an unresolved spinner.
- **`FlashControls`'s flash-in-progress overlay** carries `origin`/
  `caller` for the operation's duration (`link.flash.origin === "mcp"`)
  — ephemeral, server-side-only state layered on top of the projection
  by `server.ts` (same "not a DB table" status §9 already documents for
  `SnapshotLink.flash`/`SnapshotRelay.bridging`), showing `Agent:
  <caller>` on the exact same control a browser-initiated flash uses.

### 13.5 Verification note (ticket 009, 2026-09-18)

`packages/host/src/mcp/endToEnd.test.ts` exercises the full
inspect → connect → drive → flash path against a fake reconciler/session
and a real `:memory:` store, through the exact production wiring
(`createDefaultMcpServer`) — not a hand-assembled subset of tools. A
live smoke test against a real running host and a real
`@modelcontextprotocol/sdk` client confirmed the same path end to end on
real hardware: `request_drive` reached a real robot's wire (`tigez`, via
its mbserial bridge) with a durably attributed `agent_actions` row, and
the UI's own `Agent: <caller>`/`Recent agent activity` surfaces were
confirmed live in a real browser. See that ticket's closing notes for
the full evidence trail and one still-open carry-forward defect (WiFi
on-demand link discovery, §6.2/issue
`bench-wifi-robot-discovery-waits-for-announcement.md` — unrelated to
this subsystem's own design, but discovered while verifying SUC-002
alongside it).
