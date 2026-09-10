---
status: done
sprint: '011'
tickets:
- '006'
---

# Two-level UI and multi-transport device model

## Description

The console is one flat page with two tabs (`devices`, `console`) and a single
notion of "device" meaning "a micro:bit plugged into USB." The stakeholder wants
a different shape:

- **A front page** listing devices, and **per-device pages** whose content
  depends on the device's type.
- **Unknown device** → flash as RADIORELAY, or flash an arbitrary hex picked off
  the local disk. On a *successful* flash, return to the front page, where the
  device now shows its new type.
- **Robot** (on local USB) → drive/remote control, telemetry, console.
- **Relay** → a dropdown of known robot names; two states, connected to a robot
  or not. When connected it renders **the same content as a directly-connected
  robot**, with a header to switch robots. When nothing answers there is little
  to do beyond perhaps setting a manual channel/group.

The app must **remember robot names it has seen over USB**. That roster populates
the relay dropdown and gates which mDNS advertisements are shown — a classroom is
full of advertising robots, and only previously-seen ones should appear. A relay
defaults to the first robot it finds and tries the next if that one does not
answer.

Robots reached over mbdeploy (`_mbserial._tcp`), WiFi (`_robotlink._*`), and a
relay server on the network should all land on that same robot page.

**Stakeholder decisions already taken:**

1. **Three device types now** — `unknown | relay | robot`. Splitting robot into
   student-vs-calibration is blocked upstream; wait for the firmware change
   rather than infer. The union must be designed so a fourth member is additive.
2. **No calibration firmware slot.** The calibration hex does not exist
   (`specification.md` §9 Q1) and UC-002 forbids offering it until it does. The
   **local-hex picker** covers that case.
3. **Registry-first addressing** per §6 / UC-004.

## Cause

Not a defect — a structural gap. The current model conflates three domain
entities into one, which works for USB and breaks at the first relay:

| Concept | Identity | Owns |
|---|---|---|
| **Device** | USB serial (KL27 interface chip) | SWD naming, flashing, the physical port |
| **Endpoint** | namespaced id (`usb-<serial>`, `mbrelay-<host>-<port>`) | nothing physical; a listable, routable thing |
| **Session** | `sessionId` | one open `Link`, one `resourceKey`, one optional target robot |

`DeviceState` (`deviceRegistry.ts:141`) has exactly one `link` slot;
`LinkFactory` takes a bare port path; `KeyedMutex` is keyed on USB serial, which
no radio/TCP/relay peer has. One relay carrying three robots cannot be expressed.

There is also **no persistence anywhere in the project** — no database, no JSON
store, no `localStorage`. State dies with the process, and a replug resets a
device entirely. The roster requires introducing the first persistence layer.

### Findings verified while planning — these change the design

**1. `GET /names/<name>` mutates the shared mbrelay registry and always answers
200.** `httpapi.py:146` returns `registry.resolve(name)`; `registry.py`'s
`resolve()` falls through to `naming.name_to_radio(name)`, writes into
`_learned`, calls `save()`, and returns `source: DERIVED`. So "the HTTP call
succeeded" is not "the registry knew" — checking only for success presents a
locally-derivable guess as authoritative, the exact failure UC-004 exists to
prevent. And prefetching for a dropdown would inject an entry per robot per
student into shared classroom state. `registry.py` has a **non-mutating `get()`**
the HTTP route does not use. Resolution must be **lazy, at connect time, one
name**, with **three** outcomes, not two.

**2. Upstream replaced the `RUN:` carve-out on 2026-09-07.** Commit `d4d8e4e`
("FUNCS lists the RUN registry; RUN replaces the cleartext RUN: carve-out") plus
follow-up `0056a64`. `vendor/pxt-nezha-diffdrive` is pinned at `ce3445d`
(`v0.20260906.3-21`), so the repo cannot see it and fixtures sourced from that
submodule are stale. If confirmed, §9 Q3(a) and Q3(d) close and the calibration
wizards gain a much better foundation: `FUNCS` enumerates what a board can run,
and `RUN` becomes sequenced and acked.

**3. `BOOT_RADIO_LINK = false` by default** (`test/test.ts:48`). A stock robot
build does not answer the radio at all. With `pxt-nezha-diffdrive` publishing
**zero releases**, there is no obtainable robot hex *and* no guarantee one would
have the radio link enabled. Not recorded in §9.

**4. WiFi service facts in §4.4 / §7 / UC-010 are wrong.** `src/DESIGN.md:1284`:
the robot advertises under **both** `_robotlink._tcp` and `_robotlink._udp`, and
`wifi_link.cpp:953` sets TXT `link=v6`, not `link=v6-udp`. A browse written to
the spec matches nothing.

**5. Post-flash type flicker already exists in shipped code.**
`deviceRegistry.ts:524-533` clears `flashStatus` and emits `flash-result ok`
**before** `await this.openLink(state)`. A UI navigating on `ok` shows the old
type for up to the 3s open timeout, then it changes under the user. `runFlash`
also lacks the `this.states.get(id) !== state` staleness guard that
`resolveNameAndOpen` and `openLink` both have — a board re-enumerating mid-flash
(the watcher reports a modified device as remove+add) writes to an orphaned state
object, and the client sees `flashStatus` vanish with no `flash-result`.

## Proposed fix

Ten sprints; **insert, do not renumber** (sprints 1–2 are merged history). §7's
Sprint 3–6 themes shift to positions 6–10, and §7's Sprint 3 **splits**.

| # | Sprint | Maps to §7 | Size |
|---|---|---|---|
| 3 | Hardware bring-up and flash verification | *(new)* | small |
| 4 | Device model, device types, two-level navigation | *(new)* | large |
| 5 | Persistence: the remembered-robot roster | *(new)* | small |
| 6 | Robot page: drive and control over USB | S3 (control half) | medium |
| 7 | Relay page, radio transport, network discovery | S3 (transport half) | large |
| 8 | Telemetry and trace | S4 | medium |
| 9 | WiFi robots | S6 | medium |
| 10 | Calibration wizards | S5 | gated |

```
S3 bring-up ──┐ (de-risks S4's flash reuse; produces the announcing board S6/S7 need)
S4 device model + navigation  ◄── keystone; S5–S10 all depend on it
   ├── S5 persistence ──┐
   ├── S6 robot control ┼── S7 relay + radio + discovery ── S9 WiFi
   │        └───────────┴── S8 telemetry (independent of S7)
   └── S10 calibration (needs S6; gated on §9 Q1)
```

### Sprint 3 — Hardware bring-up (first)

Turn the silent board into an announcing relay. **The only sprint whose value
decays**: every sprint built on an unverified flash path adds to the pile needing
rework if it is broken, and a third consecutive sprint closing with "hardware
deferred" is a process failure. One bench session unblocks four things — a
flashed relay is simultaneously the announcing board sprint 1 needed, the proof
sprint 2 needs, the first real colon-dialect banner, and the relay sprint 7 is
built on.

**In:** run the sprint-2 flash against real hardware and fix what breaks;
implement `defaultResolveVolumePath` for real (join `DETAILS.TXT`'s unique id
against the device serial); fix the tty/cu display path; bump the
`vendor/pxt-nezha-diffdrive` pin and re-run fixture tests. **Out:** any new
architecture — nothing here should be thrown away by sprint 4.

Needs two boards for the MSD ticket (the hard part is picking the *right* volume);
with one, defer again rather than fake it. If a robot board is present, run
`FUNCS` against it — ten minutes that de-risks sprint 10's largest unknown.
**Risk:** unbounded scope if SWD proves unworkable. Time-box it;
MSD-becomes-primary is a *finding*, not a failure.

### Sprint 4 — Device model + navigation (keystone)

The type union and the navigation restructure are **one change seen from two
ends**: a page that "differs by device type" renders a union that does not exist
yet, and a union is only worth adding if something consumes it.

**The model.** Three orthogonal axes: *type* (`unknown|relay|robot`), *transport*
(`usb|relay-radio|mbrelay|mbserial|wifi`), *presence*
(`attached|remembered|discovered|connected`). The invariant replacing today's
ad-hoc mutex discipline:

> **One resource → one key → one queue → one session.** Every `Link` declares one
> `resourceKey`; at most one session holds a given key; every operation touching
> it runs through `KeyedMutex.run(resourceKey, …)`.

The subtlety: for a robot reached through a relay the contended resource is **the
relay's serial port**, not the robot — three robots behind one relay share one
resource. A `RelayRadioLink`'s `resourceKey` *is* the relay's `usb-<serial>`,
making "flash the relay" and "drive through the relay" mutually exclusive with no
new mechanism. `udp-local-7655` keys on the **local bind port**, not the remote
host — only one socket can bind it.

**Device type union** — new `packages/protocol/src/deviceType.ts`,
`classifyBanner(banner) → { type, role, commonName, dialect, evidence }`.
Precedence: no banner → `unknown`; then **`commonName`** (`relay`/`robot`),
already parsed at `banner.ts:70` and currently *dropped* before reaching the UI;
then an allowlist on `role` (`RADIORELAY`/`RADIOBRIDGE` → relay, `NEZHA2` →
robot); else `unknown` with `role` preserved verbatim. `commonName` first because
`role` is the firmware *family* and already churns (`RADIOBRIDGE` superseded
`RADIORELAY`) while `commonName` is the class; misclassification lands on
`unknown`, whose page offers flashing — a benign failure. **Not** discriminators:
banner dialect (converging, §9 Q3c), serial radix, port path. An unrecognized
`type` **must be treated as `unknown`** by clients, and the UI dispatch carries a
`default → UnknownDevicePage` arm, so the fourth member is additive. Do **not**
add `isCalibration`/`variant` fields — nothing fills them, and an always-null
field attracts speculative branches.

**Link abstraction.** `UsbSerialLinkLike` (`deviceRegistry.ts:89-95`) is named
for USB, built from a port path, and `open()` returns a banner *or throws*. That
last point is the real problem: a relay whose target robot does not answer has a
**healthy transport and no banner** — the stakeholder's "connected but nothing
answers" state, today an exception. Split into `connect(): Promise<void>` (throws
only on transport failure) and `identify(): Promise<ParsedBanner|null>` (null on
timeout, never throws). `LinkSpec` is pure data per transport carrying
`resourceKey`; `LinkFactory` becomes `(spec) => Link`. **The client never sends a
`LinkSpec`** — it sends `{ type: "session-open", endpointId, robotName? }` and the
host mints the spec, preserving the localhost-authority model. **No `retarget()`
method**: the relay data plane has no in-band escape after `!GO` (§6, UC-004
step 5), so switching robots is close → new spec → open; an *absent* method is
what stops someone adding it later.

Extract the already transport-agnostic pieces from `UsbSerialLink.ts`:
`LineReassembler` → `link/lineStream.ts`, `WritePacer`+`Scheduler` →
`link/pacing.ts`, and the decode→classify→ack/nack→resend path (`:556-589`) →
`link/LineRouter.ts`. Four links must not each reimplement the nack arithmetic.
New `packages/protocol/src/relay/commands.ts` (§3.7, unbuilt) holds the
command-plane preamble shared verbatim by `RelayRadioLink` and `MbrelayLink`.

**Navigation.** Add a router — `server.ts:102` already does SPA fallback, so
`BrowserRouter` needs **zero server changes**. Routes: `/`, `/d/:endpointId`,
`/d/:endpointId/console|telemetry|trace|calibrate`. The relay page and the
relay-server page render the **same `RobotView`** once they hold a robot session;
`RobotView` must never know what transport it sits on. Deep-linking needs
`hasSnapshot: boolean` on the WS context — the provider cannot currently
distinguish "zero devices" from "no snapshot yet," so a direct URL would flash a
spurious not-found. If the open device is unplugged, render an inline
disconnected state; **do not auto-redirect** and yank the user mid-action.

**The `logsByDevice` problem.** `ConsoleTab.tsx:98` holds the console buffer in
component state; routing unmounts it on every navigation. Hoist it above the
router — but **not** into React context state: `WsProvider` recreates its value
object every render with no memoization, so every consumer re-renders on every
message, which is fatal at sprint 8's 20Hz telemetry. It must be **ref-backed
with an explicit subscribe API via `useSyncExternalStore`**, plus `useEndpoint(id)`
selectors. This is a prerequisite to telemetry, not a cleanup. Extract a shared
`packages/ui/src/testing/` harness — `FakeSocket` is duplicated verbatim in both
test files today.

**Local-hex flashing.** Browser file input → **one binary WebSocket frame**, not
base64 JSON (a universal hex is ~1.8MB ASCII). Handshake:
`flash-local-begin {fileName, byteLength, sha256}` → `flash-local-ready
{uploadId}` → binary frame `uploadId || payload` → verify → hold **in memory
only**, never a temp file. `server.ts:239` does `data.toString()` unconditionally
and needs an `isBinary` branch; reject >4MB before allocating. Split what
`FirmwareKind` conflates:

```
type FirmwareSourceRef =
  | { kind: "release";   firmware: FirmwareKind }   // existing config-sourced path
  | { kind: "local-hex"; uploadId; fileName; sha256 }
```

`runFlash` branches exactly once; `flash()`, phases, the mutex, universal-hex v2
extraction and the post-flash reopen are untouched. Flashing an arbitrary hex
**cannot permanently brick a micro:bit** — it is always re-flashable over
SWD/MSD — but a v1-only (nRF51) hex on a v2 board passes `isValidIntelHexText`
and flashes a non-booting image. **Warn, do not block**, and word the copy "if
the board stops responding, flash it again."

**Post-flash navigation** (fixes finding 5). Add `"reidentifying"` to
`FlashPhase` after `"resetting"`; `flashStatus` persists through
re-identification instead of clearing at write-success. `flash-result` is emitted
only once re-identify settles and carries the post-flash identity
`{ status: "ok", type, name, role }`, so the front page already has the new type
in the same snapshot — no flicker. A write that succeeded but never re-announced
reports `{ type: "unknown", reidentify: "timeout" }`, worded "waiting for the
board to come back," never "failed." Close the orphaned-state hole: every write
in `runFlash` needs the staleness guard. Use a distinct `reidentifyTimeoutMs`
(~8s vs the 3s open timeout) with one retry, and navigate only if the user is
still on that device's page.

Fold in `port-lock-contention-between-identify-and-user-open.md` — its fix *is*
the connection-model generalization — and
`no-build-pipeline-tsx-is-a-runtime-dependency.md`, the last cheap moment before
the codebase doubles. **Out:** any new transport, any persistence,
drive/telemetry, dropdown behavior. **Risk:** scope — freeze the wire contract in
the first ticket and build outward; a mid-sprint contract change invalidates both
sides at once.

### Sprint 5 — Persistence

`packages/host/src/store/knownRobots.ts`. One record per five-letter name:
`{ name, firstSeenAt, lastSeenAt, lastSeenVia, lastUsbSerial, lastRole, lastType }`.

**Keyed on the name, not the USB serial** — the name is the target identity (nRF
`FICR.DEVICEID[1]`) and is what the dropdown, `radioAddress.ts`, the mbrelay
registry and mDNS all use. `lastUsbSerial` is a **display hint only**, documented
non-authoritative: per §2.2 the two come from *different chips*, so the pair is
valid only until hardware is swapped.

Written **only** on a successful USB identify where `type === "robot"` with
`evidence: "banner"`. Explicitly **not** from mDNS sightings — otherwise the gate
is self-fulfilling, an advertisement enrolls the robot and then passes its own
filter — and not from robots answering over a relay, which would leak a whole
classroom in.

Location `${XDG_STATE_HOME:-~/.local/state}/robot-console/known-robots.json`,
overridable via `ROBOT_CONSOLE_STATE_DIR`. Not the repo root (`.env` is
dotconfig-assembled and an `npx` user has no repo); not `localStorage` (the gate
is enforced host-side). Plain JSON with a `version` field — no SQLite (native
dep; `npx` install is already fragile), no lowdb. Corrupt/missing/unknown-version
→ **start empty, warn, never throw**, following `config.ts`'s discipline. **File
version newer than the code → load empty and refuse to write**, so an older `npx`
invocation cannot destroy a newer install's data. Writes atomic (temp+rename) and
debounced; a write failure never fails the sighting. fs seam injected like
`flash.ts`'s `WriteFileFn`.

Staleness has no natural expiry — add an explicit **"forget this robot"** action
and show `lastSeenAt`, rather than auto-expiry, which in a weekly class would
delete exactly the robots you want.

**Distinction to preserve:** the dropdown and the mDNS gate are *different
mechanisms*. Radio robots advertise nothing — the radio is silent and
fire-and-forget — so the dropdown is purely roster-driven with no discovery to
gate. Gating applies **only** to network-discovered peers. Conflating them puts
the filter in the wrong layer.

**Out:** anything consuming the roster; persisting console scrollback, telemetry,
or UI preferences. This store will attract them.

### Sprint 6 — Robot control over USB

**§7's Sprint 3 boundary is wrong.** It bundles transports with the control
surface. Under the new IA these land on *different pages* with *different
dependencies* — the control surface needs only USB and the device model. Bundled,
it cannot ship until the transports work, which given hardware could be a long
time. Split, it is built once against USB where verification is cheap, and sprint
7 reuses it unchanged — which is the whole payoff of "the relay shows the same
content."

**In:** drive controls; e-stop as an always-reachable affordance;
`STATUS`/`GET`/`SET`; sequence/ack state surfaced (`session.ts` is unit-tested but
has never driven a UI); ~10ms pacing enforced host-side. **E-stop is a safety
claim and must not be marked verified on a fake link.** **Risk:** no robot hex
exists — resolve where one comes from before detail-planning.

### Sprint 7 — Relay, radio, discovery

Depends on 4 (resource key), 5 (roster), 6 (the page being reached).

**In:** `RelayRadioLink`, `MbrelayLink` (TCP :8760, **`TCP_NODELAY`**),
`MbserialLink`, mDNS browse for `_mbrelay._tcp`/`_mbserial._tcp`, the registry
client, connected/not-connected states, first-robot default with failover.

**Registry client** — `packages/host/src/mbrelayRegistry.ts`,
`resolveRobotAddress(name, opts) → ResolvedAddress` (never throws), carrying
`source: "config" | "registry" | "derived" | "local-derived"`, `authoritative`,
`registryHost`. **Three outcomes, not two** (finding 1): authoritative; *registry
replied but only echoed our own derivation* (`derived` — surfaced as prominently
as a fallback, because the failure mode is identical); registry unreachable
(`local-derived`). Resolve **lazily at connect time, one name**; never prefetch.
Read-only — no `POST`/`DELETE` (the API has no auth). `AbortSignal` timeout ~1.5s
(mbrelay's own client uses 3s, too long to block a click). Injectable `FetchFn`
mirroring `releases.ts`. Short TTL cache so a re-click does not re-mutate.

**Disclosure without alarm fatigue:** for a local USB relay there is usually no
mbrelay daemon at all, so `local-derived` is the *normal* classroom path, not an
exception. A persistent inline chip — `Address: ch 37 / grp 3 · derived (no
registry)` — styled **neutrally** when no registry was ever configured, and as a
**warning** when one was configured and failed or answered `derived`.

Two more things to design rather than discover: the registry must be *found*
before it can be asked, so registry-first has an mDNS dependency and
"unreachable" includes "no server on the LAN"; and failover is a heuristic on a
link where **nothing is unsolicited** and one unanswered probe does not prove
absence — use `STATUS`/`PING` (never `HELLO`, which resets the sequence), with
retries, and make "gave up on X, trying Y" visible.

**Risk:** four failure modes — wrong channel, radio link disabled in the build
(finding 3), relay misconfigured, robot off — all present identically as silence.
Budget for diagnosability. **Check `BOOT_RADIO_LINK` before the sprint.**

### Sprint 8 — Telemetry and trace

Depends on 4 and 6 only, **not** 7 — telemetry over USB is sufficient. After
sprint 6 the roadmap has two independent tracks, so if 7 stalls on hardware, 8
proceeds. **In:** `v6/telemetry.ts` (the one §3 module sprint 1 did not build);
wheel-speed bars; charts; path trace; `TLM HDR` recovery per UC-009. Cover the
unit traps — `ox`/`oy` already mm, `oh` centidegrees **not divided**, rotation in
milliradians. **Risk:** rendering performance at 20Hz, which tests cannot answer.

### Sprint 9 — WiFi robots

Before calibration because its blocker is a *precondition* (provisioning happens
outside the console) rather than a missing artifact, and it reuses sprint 7's
mDNS while fresh. **Correct the spec first** (finding 4): browse **both**
`_robotlink._tcp` and `_robotlink._udp`, match TXT `link=v6`. Gate advertisements
against the roster — the classroom requirement, and the only place gating
applies. **Out:** provisioning (§9 Q2, unchanged).

### Sprint 10 — Calibration wizards

Last because it is the most gated, not least valuable — arguably the headline
feature, and putting it last is a real cost worth weighing. **Its premise changed**
(finding 2): if `d4d8e4e` is confirmed, `FUNCS` lets the wizard discover its own
availability instead of feature-detecting by trial, and `RUN` becomes sequenced
with `err 1` for an unknown name, so "wrong program name" stops being
indistinguishable from "dead robot." **Do not detail-plan until §9 Q1 is
answered**; the firmware moved underneath this once already.

### Spec corrections (fold into sprint 3's planning)

`docs/design/specification.md` will otherwise mislead every future planning
agent, as it did during this planning:

- **§7** — renumber per the table above.
- **§4.4 / §7 Sprint 6 / UC-010** — `_robotlink._tcp` *and* `._udp`; TXT is
  `link=v6`; the robot also serves TCP on 7654.
- **§9 Q3(a) and Q3(d)** — likely closable once the submodule pin is bumped;
  confirm with the stakeholder rather than closing unilaterally.
- **§6 / UC-004** — record that the registry GET *mutates*, and that
  `source: derived` is a fallback rather than a hit.
- **New open question** — where a radio-enabled robot hex comes from, given zero
  releases and `BOOT_RADIO_LINK = false`. Gates sprints 6, 7, 8 and 10 and is
  arguably the most consequential unrecorded item.

### Open questions for the stakeholder

1. **Confirm `d4d8e4e`** is the intended direction, so §9 Q3(a)/(d) can close.
2. **Where does a radio-enabled robot hex come from?**
3. **Router choice** — `react-router` (nested routes, matches the roadmap's
   growth) vs `wouter` (~2KB, ~90% of the value), in a package whose only deps
   are `react`/`react-dom`.
4. **Roster scope** — "seen over USB" taken as normative. Should robots seen over
   a relay also enroll? A one-line change that materially weakens the classroom
   filter motivating the feature.

## Verification

Split per sprint into test-provable and hardware-deferred, and never check off a
criterion that was not exercised — sprints 1 and 2 both closed with that gap.

**Test-provable:** the type union and classification precedence; the resource-key
mutex including two devices sharing one resource; presence transitions;
page-by-type routing; the local-hex read/verify path; post-flash navigation and
the orphaned-state guard; the roster store against a temp dir (round-trip,
migration, corrupt-file recovery, newer-version refusal); the registry client's
three outcomes against an injected `FetchFn`; the relay command-plane sequence
and frame-size refusal; the telemetry decoder's unit traps.

**Needs hardware:** that a flash programs a board and it re-announces; that
e-stop stops a robot; that radio reaches anything; sustained 20Hz; every
calibration wizard.

**End-to-end smoke:** `npm run dev`, plug a board, confirm the front page shows
its type, click into it, flash, confirm the return to the front page shows the
new type without a flicker.

Commands: `npm test` (456 passing at time of writing), `npm run build`
(tsc --noEmit across three workspaces), `npm run dev`.

## Related

- `sprint-002-flash-path-unverified-against-hardware.md` — sprint 3 closes it
- `sprint-001-hardware-criteria-unverified-no-announcing-board.md` — sprint 3
  closes it; a flashed relay is the announcing board it has been waiting for
- `msd-fallback-volume-matching-heuristic-unimplemented.md` — sprint 3
- `port-lock-contention-between-identify-and-user-open.md` — sprint 4; its fix is
  the connection-model generalization, not a separate bug fix
- `no-build-pipeline-tsx-is-a-runtime-dependency.md` — sprint 4
- `device-list-shows-tty-path-not-cu-path.md` — sprint 3
- `docs/design/specification.md` §2, §3.7, §4.3, §4.4, §5, §6, §7, §9
