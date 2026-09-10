/**
 * deviceRegistry.ts — composes `devices.ts` (live enumeration),
 * `swdName.ts` (five-letter naming), `@robot-console/protocol`'s
 * `classifyBanner` (device-type classification), and `UsbSerialLink`
 * (per-device I/O) into one live-updated set of {@link EndpointListEntry}
 * snapshots and per-endpoint line/error events, for `server.ts` to push
 * over the WebSocket. This module owns *orchestration* only -- which
 * device operation runs when, and that two operations never race on the
 * same physical board -- never naming, banner-parsing, classification,
 * framing, or sequencing logic, all of which stays in the composed
 * modules.
 *
 * ## Sprint 4: endpoint/session/resource-key model
 *
 * `EndpointListEntry` replaced `DeviceListEntry` in sprint 4's wire
 * contract reshape (see `wsMessages.ts`'s own module doc comment).
 * Ticket 001 remapped `toEntry`'s *output* shape and minted the
 * URL-safe `usb-<serialNumber>` endpoint id ({@link usbEndpointId}) used
 * as this module's own internal key (the `states` map, the
 * {@link KeyedMutex} key, and every public method's `endpointId`
 * parameter). Ticket 003 (this shape) restructures the *internal* state
 * to match: {@link EndpointState} carries its own `resourceKey`
 * (`=== endpointId` for every endpoint this sprint -- see that field's
 * own doc comment for why it exists as a distinct field anyway) and a
 * single optional `session` object (the open {@link Link} plus its line/
 * error subscriptions) in place of the old flat `link` field. **One
 * resource -> one key -> one queue -> one session**: every operation
 * that touches a resource runs through {@link KeyedMutex.run} keyed by
 * that resource's `resourceKey` -- today that key happens to equal the
 * endpoint id one to one, but the routing is already through
 * `resourceKey`, so sprint 7's relay (many endpoints, one shared
 * resource key: the relay's own USB port) changes data, not control
 * flow.
 *
 * ## The race this module exists to prevent
 *
 * `swdName.ts#readSwdName` attaches to a board over SWD; `UsbSerialLink
 * #open()` resets the same board on macOS (opening the port toggles
 * DTR). Reading a name while a link is opening, or opening two links to
 * one board, must never happen concurrently -- either can corrupt or
 * disrupt the other's in-flight operation. {@link KeyedMutex} below
 * serializes every operation this module performs against a given
 * endpoint (name resolution, link open, link close, a line send) so at
 * most one is ever in flight per endpoint at a time, while different
 * endpoints proceed fully in parallel.
 *
 * ## Attach flow
 *
 * On each `DeviceWatcher` diff, a newly-added device is registered as
 * an endpoint immediately (so it is visible, named `null`, right away
 * -- the endpoint list must never block on SWD/serial I/O) and its
 * name/role resolution is kicked off asynchronously, serialized per
 * resource key (per endpoint this sprint) as above: resolve the
 * five-letter name over SWD first (fast, no reset), then
 * {@link connectAndIdentify} opens a session for it -- `Link.connect()`
 * opens the port, then `Link.identify()` learns its role from the boot
 * banner and classifies it via `classifyBanner`. `connect()`/
 * `identify()` fail differently, and this module treats them
 * differently (sprint 4 ticket 002, folding in
 * `port-lock-contention-between-identify-and-user-open.md`):
 *
 * - `connect()` throws only on a genuine transport failure (the port
 *   itself failing to open). That is still today's error state --
 *   `sessionOpen: false`, `sessionError` set, no {@link EndpointState.session}
 *   -- and the link is closed.
 * - `identify()` never throws. A device that never replies to `HELLO`
 *   (a silently running board) resolves `null` and still ends up
 *   listed, named, with `role: null`, `classification.type: "unknown"`,
 *   `sessionOpen: true`, and **no** `sessionError` -- "connected,
 *   unresponsive" is a normal, representable state (the state a relay
 *   whose target robot never answers is in), not an error. The session
 *   stays open: it is never closed and reopened just because identify
 *   found nothing, which is what used to race the OS over the port
 *   handle (see the linked issue).
 *
 * ## Detach flow
 *
 * A removed device's endpoint session (if open) is closed best-effort
 * and its endpoint state discarded. A link-level error arriving after
 * a session is open (e.g. the board is unplugged) is caught and turned
 * into a state update plus an {@link ErrorMessage}-shaped event --
 * never an uncaught exception that
 * would take the whole server down over one board.
 *
 * ## Flash flow (sprint 2, reidentify sequencing added sprint 4 ticket
 * 004, local-hex source added sprint 4 ticket 005)
 *
 * {@link DeviceRegistry.requestFlash} is one more operation run through
 * the same per-endpoint {@link KeyedMutex} as name resolution/link open/
 * close/send -- not a new synchronization mechanism. It takes a full
 * {@link FirmwareSourceRef} (not a bare {@link FirmwareKind}) and
 * {@link DeviceRegistry.runFlash} branches on `source.kind` exactly
 * once, to obtain the hex bytes to write:
 *
 *   - `"release"` composes `config.ts` (which firmware source) ->
 *     `releases.ts` (fetch+verify the hex), reporting `"fetching"` then
 *     `"verifying"` progress -- unchanged from before this ticket.
 *   - `"local-hex"` calls the injected `consumeUpload(source.uploadId)`
 *     seam (`localHexUpload.ts`'s `LocalHexUploadManager`, shared with
 *     `server.ts`'s own binary-frame handling -- see
 *     {@link DeviceRegistryOptions.consumeUpload}'s own doc comment)
 *     instead of any network call, reporting `"verifying"` alone (no
 *     `"fetching"` -- there is nothing to fetch, the bytes already
 *     arrived over the socket and were sha256-verified at upload time).
 *     An upload not found (unknown, expired, or already consumed by an
 *     earlier `flash-start`) is a `flash-result` error, never a thrown
 *     exception -- mirroring every other failure mode this method
 *     already handles as a value.
 *
 * From that point on -- write it via `flash.ts` (reporting
 * `"erasing"`/`"writing"`/`"resetting"` progress), and on success
 * connect and identify a link exactly the way the attach flow above
 * already does, so the newly-flashed firmware's banner is picked up
 * with no separate manual Connect click -- the pipeline is identical
 * for both `source.kind`s and untouched by this ticket. Tear down any
 * open link first (so `flash.ts`'s DAPjs session never contends with an
 * open serial port over the same physical board), same for both kinds.
 * See {@link DeviceRegistry.requestFlash}'s own doc comment for why this
 * task holds the endpoint's mutex slot across the network fetch (or, for
 * `"local-hex"`, across nothing slower than a map lookup) rather than
 * releasing and re-acquiring it. A failure at any stage clears
 * `flashStatus` and reports a `flash-result` error -- it never leaves
 * `flashStatus` stuck or the registry believing a link is open when
 * {@link teardownLink} already closed it.
 *
 * ### `flashStatus` gap for `"local-hex"` (known, accepted this ticket)
 *
 * `wsMessages.ts`'s `EndpointListEntry.flashStatus` is frozen (ticket
 * 001) as `{ firmware: FirmwareKind; phase: FlashPhase }` -- there is no
 * shape in that field for a local-hex source (no `FirmwareKind` names
 * it). Rather than force a `FirmwareKind` value onto a local-hex flash
 * or change the frozen wire contract, `state.flashStatus` is left
 * `undefined` for the whole duration of a `"local-hex"` `runFlash`
 * task -- {@link FlashProgressMessage}/{@link FlashResultMessage} (which
 * both carry the full `source: FirmwareSourceRef`) still fire normally
 * over the WebSocket, so a client connected for the duration of the
 * flash sees every event; only a client that *reconnects* mid-flash
 * would fail to see it reflected in the next `endpoints` snapshot. This
 * is an accepted gap for this host-side ticket (UI is ticket 008's
 * scope) rather than a silent bug -- flagged here for whoever revisits
 * `EndpointListEntry.flashStatus`'s shape next.
 *
 * ## Post-flash reidentify sequencing (ticket 004, fix for roadmap
 * issue "finding 5")
 *
 * A write success does **not** mean the client should be told yet.
 * `flash-result` is the message a client navigates on (ticket 008), so
 * emitting it -- and clearing `flashStatus` -- *before* the board has
 * had a chance to re-announce itself would show the device's stale
 * pre-flash type for up to the reidentify window, then flip it
 * underneath the client. Instead, once {@link flash} reports success:
 * `flashStatus` **stays set**, phase advances to `"reidentifying"`
 * (one more {@link FlashProgressMessage}), and
 * {@link DeviceRegistry.reidentifyAfterFlash} connects and identifies a
 * fresh link exactly like {@link connectAndIdentify}, except with a
 * distinct, longer `reidentifyTimeoutMs` (reset + re-enumeration + the
 * `HELLO` round trip can exceed the plain attach flow's identify
 * timeout) and one retry on a `null` identify. Only once that settles
 * is `flash-result` emitted -- `status: "ok"` either way, since the
 * write itself already succeeded -- carrying the post-flash
 * `classification`/`name` in the same snapshot (no flicker), or
 * `reidentify: "timeout"` alongside an `unknown` classification if the
 * board never re-announced. `flashStatus` is cleared exactly once, at
 * this final emission.
 *
 * Sprint 3's real bench run hit exactly this timeout path (flash
 * succeeded, board never re-announced -- tracked in
 * `flash-succeeds-but-board-never-announces.md`), so this is the
 * common outcome on real hardware today, not an edge case.
 *
 * ## Orphaned state during a flash (ticket 004, fix for roadmap issue
 * "finding 5")
 *
 * A board can reset and re-enumerate mid-flash (the MSD write-mode
 * fallback re-enumerates as mass storage and back; a plain nRF flash
 * over SWD does not, since the KL27 interface chip that owns the USB
 * serial port is untouched by it -- either way the endpoint id stays
 * stable, because it is minted from the KL27's own serial number, not
 * the target chip's). {@link handleChange} reports a "modified" device
 * as remove+add, and the *added* half replaces this endpoint's
 * `EndpointState` object in {@link states} synchronously, with no
 * regard for whether a {@link runFlash} task is still holding this
 * endpoint's mutex slot. Every state mutation `runFlash` makes --
 * {@link setFlashPhase}, {@link failFlash}, {@link succeedFlash} --
 * checks {@link isLive} first and silently drops the write if the
 * object it holds is no longer the live one, exactly like
 * {@link resolveNameAndOpen}/{@link connectAndIdentify} already do.
 * Re-enumeration *after* a successful write is the expected outcome
 * here, not a failure, so {@link runFlash} re-acquires whatever object
 * is live under the endpoint id right after the write completes,
 * rather than continuing to write through a reference that guard would
 * only ever reject from that point on. (Re-enumeration racing an
 * already-queued {@link resolveNameAndOpen} for the freshly re-added
 * object against this method's own reidentify is a known, narrower
 * follow-on gap this ticket does not close -- see
 * {@link reidentifyAfterFlash}'s own doc comment.)
 *
 * ## Command routing and sequencing-state projection (sprint 6 ticket 003)
 *
 * {@link DeviceRegistry.sendCommand} is the second, structured
 * client -> server verb-sending path alongside {@link
 * DeviceRegistry.sendLine}'s raw text (see `wsMessages.ts`'s own
 * "Sprint 6 addition" doc comment). It runs through the same
 * per-endpoint {@link KeyedMutex} as every other operation this module
 * serializes -- no new synchronization primitive -- and dispatches on
 * `@robot-console/protocol`'s `isSequencedVerb`, the single owner of
 * sequenced-vs-unsequenced classification, never re-derived here: a
 * sequenced verb reaches `Link.sendCommand`, everything else
 * (`STATUS` included -- protocol.md's verb table is the authority, not
 * this sprint's looser roadmap phrasing) reaches `Link.sendUnsequenced`.
 * `HELLO` (matched case-insensitively) is routed to
 * {@link DeviceRegistry.resyncSession} instead of either of those --
 * see that method's and {@link DeviceRegistry.sendCommand}'s own doc
 * comments for why an outright refusal (this module's original sprint 6
 * rule) was actively wrong: `HELLO` is the supported recovery for a
 * desynced session (see {@link DeviceRegistry.reportDesyncIfNeeded}),
 * and refusing it left the user with no in-band way to do that recovery
 * at all. {@link DeviceRegistry.sendLine}'s raw text path gets the same
 * HELLO interception, since it bypasses `Session` (and therefore this
 * classification) entirely otherwise -- see its own doc comment.
 *
 * {@link toEntry} projects the open session's live `Session` state
 * (`seq`/`pendingCount`/`lastDone`/`lastDoneReason`, read straight off
 * `Link.session`) into {@link EndpointListEntry.sequencing} on every
 * {@link DeviceRegistry.snapshot} call -- present only while a session
 * is open, `undefined` otherwise. Both {@link connectAndIdentify} and
 * {@link reidentifyAfterFlash} subscribe `Link.onAckNack` alongside
 * their existing `onLine`/`onError` subscriptions, calling
 * {@link DeviceRegistry.emitDevices} on every ack/nack event so a
 * corrected `seq` (or a growing `pendingCount`) reaches connected
 * clients promptly. Deliberately *not* wired to fire on every
 * `sendCommand` call too -- see that method's own doc comment for why a
 * burst of sends (a held drive control) must not storm every client
 * with one broadcast per send on top of the pacing already governing
 * the writes themselves.
 *
 * ## Robot-via-relay endpoints (OOP 2026-09-09, superseded in part by
 * sprint 8 ticket 004 -- see that section below)
 *
 * A relay classified `classification.type === "relay"` on plain USB can
 * be asked, via `requestOpen(relayEndpointId, { robotName, radio? })`,
 * to bridge to one named robot over its radio -- `wsMessages.ts`'s
 * `SessionOpenMessage.robotName`/`radio` fields, reserved since sprint
 * 4, become live for the first time here. The result is a **new**,
 * synthesized {@link EndpointState}/{@link EndpointListEntry} --
 * `<relayEndpointId>-via-<robotName>` -- never a mutation of the
 * relay's own endpoint: both are present in {@link DeviceRegistry.snapshot}
 * simultaneously, and the synthesized one shares the relay's own
 * `resourceKey` (never an independent one) for `"relay-radio"`/
 * `"mbrelay"`, so flashing the relay and driving through it are
 * mutually exclusive through the existing {@link KeyedMutex} -- no new
 * locking mechanism.
 *
 * `link/RelayRadioLink.ts`'s own doc comment explains why a reset is
 * needed before the handshake at all: the relay's data plane has no
 * in-band escape once `!GO` confirms (exit is reset-only), so a relay
 * already bridging one robot cannot simply be told `!CG`/`!GO` again
 * for a different one. {@link DeviceRegistry.requestOpen}'s relay
 * branch (the private `openRobotViaRelay`) therefore: tears down any
 * existing synthesized child for this relay first -- switching robots
 * is always close -> reset -> reopen, never an in-place retarget
 * (`Link` has no `retarget()` method at all; see `link/Link.ts`'s own
 * doc comment for why) -- tears down the relay's own plain USB console
 * session (the radio link needs the same physical port), resets the
 * relay over SWD via `flash.ts`'s {@link resetOverSwd} (a target reset
 * through the DAPLink interface chip does not re-enumerate USB, unlike
 * a flash -- see that function's own doc comment), waits
 * {@link DeviceRegistryOptions.relayBootDelayMs} for the relay's own
 * firmware to come back up, then hands off to the coordinator (see
 * below) to resolve/connect/identify/fail over. A candidate exhaustion,
 * or a malformed `robotName` no candidate could use, reopens the
 * relay's own plain USB session rather than leaving it stranded with no
 * session at all; {@link DeviceRegistry.requestClose} on the synthesized
 * endpoint does the same on a deliberate close.
 *
 * The whole operation, start to finish, runs under the relay's own
 * `resourceKey` in {@link KeyedMutex.run} -- never a new key -- so it
 * correctly queues behind (or blocks) a concurrent flash/open/close on
 * the same physical relay; {@link DeviceRegistry.requestFlash} on a
 * relay with an open synthesized child tears that child down first, for
 * the same shared-port reason (documented at that call site).
 * {@link maybeRecordKnownRobot} is deliberately never called for a
 * via-relay identify -- the durable roster stays USB-sighting-only, per
 * this ticket's own scope.
 *
 * ## Relay-target endpoint synthesis and switching (sprint 8 ticket 004)
 *
 * This ticket injects `relay/RelayConnectionCoordinator.ts` as one more
 * seam on this class (mirroring `resolveName`/`createLink`/`flash`/
 * `knownRobotsStore` -- see {@link DeviceRegistryOptions.relayConnectionCoordinator}),
 * plus `discovery/mdnsDiscovery.ts`'s {@link MdnsDiscovery} (started/
 * stopped alongside the device watcher). **Resolution, connect,
 * liveness probing, `identify()`, and candidate failover now all belong
 * to the coordinator** -- see that module's own doc comment for the
 * full policy (never re-explained here, per this class's own
 * "orchestration only" boundary). This class still owns everything it
 * always owned: the relay's own plain-session teardown, the DAP reset
 * and boot delay, the {@link KeyedMutex} scope, the synthesized
 * {@link EndpointState}, {@link attachSession}, the robot status/
 * functions probes, and reopening the relay's own session on failure.
 *
 * `{@link DeviceRegistry.requestOpen}`'s relay branch builds one of two
 * candidate lists (see {@link buildSingleCandidate}/
 * {@link buildDefaultFailoverCandidates}) and hands it to the
 * coordinator:
 *
 *   - **`target.robotName` given**: a single `"relay-radio"` candidate
 *     through this relay's own port. An explicit `target.radio`
 *     override becomes the candidate's explicit `address` (reported by
 *     the coordinator as `addressSource: "explicit"`); otherwise, when a
 *     discovered `_mbrelay._tcp` service's instance name matches this
 *     relay's own SWD-resolved name, its registry location is passed
 *     along so the coordinator can try the registry (see
 *     {@link findRegistryLocationForRelay}) -- with neither, the
 *     coordinator's own `"local-derived"` outcome applies.
 *   - **`target.robotName` omitted** (`target` itself still present,
 *     e.g. `{}`): the default-failover list -- every
 *     {@link KnownRobotsStore.list} entry (most recently seen first),
 *     then every discovered `_mbserial._tcp` instance name not already
 *     among those, deduplicated by name. A remembered-robot candidate
 *     tries this same physical relay (`"relay-radio"`); a discovered-
 *     `_mbserial._tcp` candidate bypasses it entirely (`"mbserial"`,
 *     its own independent `resourceKey` -- see
 *     {@link mbserialResourceKey}'s own doc comment). Not yet reachable
 *     over the wire (`server.ts`'s `session-open` dispatch is
 *     unchanged this ticket) -- see `wsMessages.ts`'s
 *     `SessionOpenMessage.robotName` doc comment.
 *
 * A `"connected"` result is turned into a new {@link EndpointState}
 * whose `resourceKey` matches the relay's own for `"relay-radio"`/
 * `"mbrelay"` (never independent -- same rationale as the OOP section
 * above) or its own independent {@link mbserialResourceKey} for
 * `"mbserial"`; `synthesizedRelayTarget` carries the winning candidate's
 * transport, a best-effort display address (see
 * {@link bestEffortRadioAddress}'s own doc comment for why it is
 * best-effort), the coordinator's `addressSource`, and its
 * `failoverTrail` verbatim -- {@link toEntry} is what gates wire
 * visibility of `viaRelay`/`addressSource`/`failoverTrail` to a
 * non-`"mbserial"`, session-open entry (`wsMessages.ts`'s own doc
 * comment). An `"exhausted"` result reopens the relay's own plain
 * session, exactly like the OOP version's connect-failure path.
 *
 * **Observable behavior changes from the OOP version**, both accepted
 * consequences of moving connect/identify ownership into the
 * coordinator, not oversights: the relay's own console no longer echoes
 * `!CG`/`!GO` handshake replies live during an attempt (each candidate's
 * link is opened/closed inside the coordinator, with no hook back to
 * this module until one succeeds), and the coordinator's own internal
 * `identify()` call is not echoed to any console either (this module
 * only ever sees the resulting `classification`, never the raw banner).
 * The OOP version's "one retry on a missed post-reset `HELLO`" workaround
 * is also gone -- the coordinator's liveness probe (retried, timed out,
 * per its own doc comment) already establishes liveness before
 * `identify()` is ever called once, which supersedes the need for it.
 *
 * ## Auto-switch radio -> WiFi (sprint 10 ticket 004)
 *
 * {@link DeviceRegistry.syncWifiEndpoints} (ticket 003, called on every
 * {@link mdnsDiscovery} change) is also this ticket's one trigger point:
 * after it recomputes the gated WiFi set, it looks for any currently-
 * open `"relay-radio"`/`"mbrelay"` synthesized child (never `"mbserial"`
 * -- that transport has no local relay to reopen a session on) whose
 * `robotName` now has a gated WiFi record, and kicks off
 * {@link DeviceRegistry.autoSwitchRadioToWifi} for it (fire-and-forget --
 * `syncWifiEndpoints` itself must stay synchronous). Disabled entirely
 * via {@link DeviceRegistryOptions.autoSwitchToWifi} (`false`; default
 * `true`), for a test that wants ticket 003's plain endpoint synthesis
 * without the switch also firing.
 *
 * The switch itself never retargets the existing endpoint in place --
 * per this sprint's Design Rationale ("Auto-switch closes the old radio
 * endpoint and opens a new, independently-identified WiFi endpoint --
 * never an in-place retarget"): it opens `wifi-<name>` through {@link
 * DeviceRegistry.connectAndIdentifyWifi} -- ticket 003's own click path,
 * unchanged -- and only then tears down and deletes the `-via-<name>`
 * child, reopening the relay's own plain USB session exactly like a
 * deliberate {@link DeviceRegistry.requestClose} on it.
 *
 * Per `sprint.md`'s own SUC-004 Main Flow, the WiFi connect is attempted
 * *first*, under the WiFi endpoint's own `resourceKey` in {@link
 * KeyedMutex.run}. A socket-level connect failure, or a link error
 * arriving before `identify()` returns, is reported (via {@link
 * emitError} on the WiFi endpoint only) and the radio session is left
 * completely untouched -- a transient loss of the WiFi candidate must
 * never regress an already-working radio session; stranding a student
 * with no session at all on a failed WiFi attempt would be strictly
 * worse than a harmless transient overlap (see below). Only once the
 * WiFi link is actually open does this method acquire the relay's own
 * `resourceKey` -- a second, nested {@link KeyedMutex.run} call, always
 * in this order (WiFi key first, then relay key; never the reverse) --
 * to tear down the `-via-<name>` child and reopen the relay's own plain
 * USB session, correctly queuing around a concurrent flash/open/close on
 * the relay itself, exactly like {@link openRobotViaRelay}'s own
 * single-`resourceKey` discipline. On success, one informational notice
 * ("Switched `<name>` from relay `<relay>` to WiFi at
 * `<host>`:`<port>`") is emitted via {@link emitError} on *both* the
 * relay's own endpoint and the new `wifi-<name>` endpoint -- `emitError`
 * is this class's one existing channel for a host-originated notice, not
 * only failures.
 *
 * This ordering means the robot can briefly hold two live command
 * channels at once -- the still-open radio session and the newly
 * connected WiFi one -- between the WiFi identify succeeding and the
 * radio child's teardown completing a moment later. This is an accepted,
 * deliberate tradeoff, not an oversight: the robot's own TCP server
 * accepts multiple simultaneous clients, and `Session`'s own
 * nack-triggered resync already recovers from the `HELLO` sent over the
 * new WiFi link desyncing the about-to-close radio session, so the
 * transient overlap is harmless, while a failed WiFi attempt stranding
 * the student with neither session open would not be.
 *
 * Never fires against a name that is currently open over plain USB
 * ({@link DeviceRegistry.hasOpenUsbSessionForName}) -- a direct USB
 * session is strictly better than WiFi, so this ticket only ever
 * switches `"relay-radio"`/`"mbrelay"` sessions, never a USB one. An
 * mDNS `down` for an already-switched WiFi session never tears it down
 * either (ticket 003's own "An ad disappearing is not a disconnect"
 * rule, unchanged by this ticket) -- there is no switch-back path from
 * WiFi to radio at all.
 */

import type { AckNackEvent, DecodedLine, DeviceClassification, ParsedBanner, WireField } from "@robot-console/protocol";
import {
  classifyBanner,
  encodeLine,
  isSequencedVerb,
  nameToRadioAddress,
  parseIdReply,
  refineForCalibration,
  TelemetryDecoder,
} from "@robot-console/protocol";
import {
  DeviceWatcher,
  type DaplinkDevice,
  type DeviceChangeEvent,
} from "./devices.js";
import { readSwdName, type SwdNameResult } from "./swdName.js";
import { UsbSerialLink } from "./link/UsbSerialLink.js";
import { RelayRadioLink } from "./link/RelayRadioLink.js";
import { MbrelayLink } from "./link/MbrelayLink.js";
import { MbserialLink } from "./link/MbserialLink.js";
import type { Link, LinkFactory, LinkSpec } from "./link/Link.js";
import { getFirmwareConfig, type FirmwareConfigMap } from "./config.js";
import { resolveRelease, fetchAndVerifyHex } from "./releases.js";
import { flash, resetOverSwd } from "./flash.js";
import type {
  AddressSource,
  DiscoveredServicesSnapshot,
  EndpointListEntry,
  FailoverTrailEntry,
  LineDirection,
  LineOrigin,
  FirmwareKind,
  FirmwareSourceRef,
  FlashPhase,
  RememberedRobotEntry,
  RobotFunction,
  RobotStatus,
} from "./wsMessages.js";
import { KnownRobotsStore } from "./store/knownRobots.js";
import {
  RelayConnectionCoordinator,
  type ConnectionCandidate,
  type RelayConnectionResult,
} from "./relay/RelayConnectionCoordinator.js";
import { MdnsDiscovery, type WifiRobotService } from "./discovery/mdnsDiscovery.js";
import type { RegistryLocation } from "./mbrelayRegistry.js";
import { gateWifiRobots } from "./wifi/wifiRobotGate.js";

/** Mint a URL-safe, stable endpoint id for a USB device from its serial
 * number -- see `wsMessages.ts`'s `EndpointListEntry.endpointId` doc
 * comment for why this must be URL-safe from the start (sprint 4's
 * router puts it directly in a path segment). This is the one place
 * that mapping happens; every other USB-facing id in this module (the
 * `states` map key, the per-endpoint mutex key, every public method's
 * `endpointId` parameter) uses this same value, so a caller never needs
 * to convert between a raw serial number and an endpoint id. */
function usbEndpointId(serialNumber: string): string {
  return `usb-${serialNumber}`;
}

/** Mint the endpoint id for a gated WiFi robot (sprint 10 ticket 003) --
 * mirrors {@link usbEndpointId}'s own URL-safety rationale, and the
 * `<relayEndpointId>-via-<robotName>` sibling naming precedent below.
 * Independent of any relay/USB id: a WiFi robot has no local physical
 * device, and its `resourceKey` equals this same value (a WiFi TCP
 * socket shares no physical resource with anything else -- see
 * `mbserialResourceKey`'s own doc comment for the identical rationale
 * on the sibling `_mbserial._tcp` transport). */
function wifiEndpointId(name: string): string {
  return `wifi-${name}`;
}

/** Sibling naming scheme (OOP 2026-09-09, sprint 8 ticket 004): a
 * synthesized robot-via-relay endpoint's id is
 * `` `${relayEndpointId}-via-${robotName}` `` -- concrete and URL-safe
 * for the same router-path-segment reason {@link usbEndpointId} is,
 * derived from the *relay's own* endpoint id (itself already
 * URL-safe) rather than any physical identity of its own, since the
 * synthesized endpoint has no physical device to derive one from. This
 * naming is stable across which transport
 * `relay/RelayConnectionCoordinator.ts` actually connected through
 * (`"relay-radio"`/`"mbrelay"`/`"mbserial"` all use it identically) --
 * see {@link DeviceRegistry.openRobotViaRelay}'s own doc comment for
 * where it is constructed. Not extracted into its own function (unlike
 * {@link usbEndpointId}) since it is built at exactly one call site. */

// ---------------------------------------------------------------------
// Injectable seams (real implementations by default; fakes in tests)
// ---------------------------------------------------------------------

export type NameResolver = (device: DaplinkDevice) => Promise<SwdNameResult>;

/** Real `Link` factory: builds a {@link UsbSerialLink}, {@link
 * RelayRadioLink}, {@link MbrelayLink}, or {@link MbserialLink} from a
 * {@link LinkSpec}, dispatching on `spec.transport` (sprint 7 ticket 002
 * adds the `"relay-radio"` branch, ticket 003 adds `"mbrelay"`, ticket
 * 004 adds `"mbserial"`; sprint 10 ticket 002 adds `"wifi"`, reusing
 * {@link MbserialLink} verbatim -- see this sprint's Design Rationale,
 * "TCP over UDP, reusing `MbserialLink` unchanged", and `link/Link.ts`'s
 * own doc comment). Tests substitute a fake {@link LinkFactory} returning
 * a fully synthetic {@link Link}, without any real `serialport`/`net`
 * I/O -- the ticket's own testing note asks for exactly this. Exported
 * (sprint 10 ticket 002) so `"wifi"`'s dispatch can be asserted directly
 * against the real function, without constructing a whole
 * {@link DeviceRegistry} -- no prior transport's dispatch had its own
 * direct test, but this ticket's acceptance criteria specifically ask
 * for one here. */
export function defaultLinkFactory(spec: LinkSpec): Link {
  switch (spec.transport) {
    case "usb":
      return new UsbSerialLink(spec.portPath);
    case "relay-radio":
      return new RelayRadioLink(spec.portPath, spec.channel, spec.group);
    case "mbrelay":
      return new MbrelayLink(spec.host, spec.port, spec.channel, spec.group);
    case "mbserial":
      return new MbserialLink(spec.host, spec.port);
    case "wifi":
      return new MbserialLink(spec.host, spec.port);
  }
}

/** Sprint 8 ticket 004: the subset of `RelayConnectionCoordinator.ts`
 * this module calls -- resolve a candidate list to a connected `Link`,
 * or report exhaustion. Injectable so tests substitute a fully
 * synthetic fake with zero real resolution/connect/liveness-probe
 * timing (never a real {@link RelayConnectionCoordinator} instance in a
 * test, per this ticket's own testing note); the real
 * {@link RelayConnectionCoordinator} satisfies this interface as-is. */
export interface RelayConnector {
  connect(candidates: readonly ConnectionCandidate[]): Promise<RelayConnectionResult>;
}

/** Sprint 8 ticket 004: `resourceKey` for a synthesized robot-via-relay
 * endpoint reached over `"mbserial"` -- deliberately **not** the
 * triggering relay's own `resourceKey` (unlike `"relay-radio"`/
 * `"mbrelay"`, see {@link EndpointState.resourceKey}'s own doc comment):
 * an `_mbserial._tcp` connection is an independent TCP socket to the
 * robot's own serial bridge, sharing no physical resource with whatever
 * local USB relay's dropdown happened to trigger the default-failover
 * attempt that found it. Keyed on the discovered instance name alone
 * (not on which relay triggered the attempt) so two relays' default-
 * failover attempts that both land on the same physical mbserial robot
 * are still serialized against each other by {@link KeyedMutex}. */
function mbserialResourceKey(name: string): string {
  return `mbserial-${name}`;
}

/** Sprint 8 ticket 004: best-effort `{ channel, group }` for display on
 * {@link EndpointListEntry.viaRelay}, for a `"relay-radio"`/`"mbrelay"`
 * candidate only. `RelayConnectionCoordinator.ts#connect`'s result
 * deliberately carries no address (it owns resolution internally, see
 * that module's own doc comment), so this module cannot know the exact
 * value a registry-backed resolution actually used -- an explicit
 * override is authoritative and used verbatim; otherwise this falls
 * back to `nameToRadioAddress(name)`'s own local derivation purely for
 * display, which may not match a registry-resolved address exactly.
 * Known, accepted gap (mirrors this module's other documented "known
 * gap" sections) rather than a silent inaccuracy: flagged here for
 * whoever wires ticket 006's disclosure chip against real registry
 * data. Returns `undefined` (never throws) if `name` is not a valid
 * `nameToRadioAddress` input and no explicit override was given --
 * `viaRelay` is simply omitted for that entry in that rare case. */
function bestEffortRadioAddress(
  name: string,
  explicit: { channel: number; group: number } | undefined,
): { channel: number; group: number } | undefined {
  if (explicit) {
    return explicit;
  }
  try {
    return nameToRadioAddress(name);
  } catch {
    return undefined;
  }
}

/** Default budget for a single post-flash reidentify attempt (ticket
 * 004) -- deliberately longer than `UsbSerialLink`'s own ~3s
 * open-flow identify timeout, since a reset + re-enumeration + `HELLO`
 * round trip after a flash can exceed that. Overridable via
 * {@link DeviceRegistryOptions.reidentifyTimeoutMs} (tests use a tiny
 * value so a hung `identify()` fake doesn't cost real wall-clock time). */
const DEFAULT_REIDENTIFY_TIMEOUT_MS = 8000;

/** Bound `link.identify()` to `timeoutMs`, resolving `null` if it has
 * not settled by then. `Link.identify()` already documents its own
 * "never throws, `null` on timeout" contract, so this is a second,
 * outer safety net rather than the only timeout mechanism -- it exists
 * so `DeviceRegistry`'s reidentify SLA does not depend on every current
 * and future {@link Link} implementation choosing a timeout at least as
 * generous as `reidentifyTimeoutMs` on its own. Never rejects, same as
 * the `identify()` it wraps. */
function identifyWithTimeout(link: Link, timeoutMs: number): Promise<ParsedBanner | null> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(null);
      }
    }, timeoutMs);
    void link.identify().then((banner) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(banner);
      }
    });
  });
}

/** Default wait, after {@link resetOverSwd} resets a relay, before
 * attempting a fresh `!CG`/`!GO` command-plane handshake against it --
 * see {@link DeviceRegistryOptions.relayBootDelayMs}. Tests pass `0` so
 * no real wall-clock time is spent. */
const DEFAULT_RELAY_BOOT_DELAY_MS = 1500;

/** Resolve after `ms` milliseconds -- the one place
 * `openRobotViaRelay` waits for a just-reset relay's firmware to come
 * back up before talking to it again. Not made a further injectable
 * seam of its own (unlike {@link identifyWithTimeout}'s wrapped
 * `Link.identify()`): {@link DeviceRegistryOptions.relayBootDelayMs}
 * already gives tests full control over how long this actually waits
 * (`0` in every test that exercises this path). */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------
// KeyedMutex -- serialize operations per resource key, not globally
// ---------------------------------------------------------------------

/**
 * Runs async tasks registered under the same `resourceKey` strictly one
 * at a time, in the order {@link run} was called, while tasks under
 * different resource keys run fully concurrently. A task that throws/
 * rejects does not wedge later tasks queued under the same key -- the
 * chain always advances regardless of the previous task's outcome; only
 * the caller of that specific {@link run} call observes its rejection.
 *
 * Named for the physical resource it serializes access to (a USB port,
 * a relay's shared port in sprint 7), not for whatever logical caller
 * happens to invoke it -- two different endpoints (e.g. two robots
 * behind one relay, sprint 7) can share one `resourceKey` and will
 * still be serialized against each other by this same mechanism, with
 * no per-caller bookkeeping. This sprint every USB endpoint's
 * `resourceKey` happens to equal its `endpointId` one to one (see
 * {@link EndpointState.resourceKey}'s own doc comment), so that
 * many-endpoints-one-key case isn't exercised by real callers yet --
 * only by a direct test of this class.
 *
 * Note: `tails` is never pruned -- one entry persists per resource key
 * for the process's lifetime. Fine at today's scale (a handful of USB
 * ports); worth revisiting if the resource-key space ever grows
 * unbounded (e.g. one entry per ephemeral remote session).
 */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<void>>();

  run<T>(resourceKey: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(resourceKey) ?? Promise.resolve();
    const result = previous.then(task);
    // Store a variant that always resolves as the new chain tail, so a
    // rejection from this task never poisons the next queued task under
    // the same key -- only `result` (returned to this call's caller)
    // carries the rejection onward.
    this.tails.set(
      resourceKey,
      result.then(
        () => undefined,
        () => undefined,
      ),
    );
    return result;
  }
}

// ---------------------------------------------------------------------
// Per-endpoint state
// ---------------------------------------------------------------------

/** The live state of one open {@link Link} against one `resourceKey` --
 * everything a session needs in order to be torn down cleanly
 * ({@link DeviceRegistry.teardownLink}) or read from
 * ({@link DeviceRegistry.sendLine}/{@link DeviceRegistry.sendCommand}).
 * Absent whenever there is no open session for the endpoint (never
 * connected, a `connect()` failure, or after teardown) -- see
 * {@link EndpointState.sessionOpen}'s own doc comment for why "open" is
 * tracked as its own field rather than derived from this object's
 * presence. `unsubscribeAckNack` (sprint 6 ticket 003) feeds
 * {@link toEntry}'s `sequencing` projection -- see the module doc
 * comment's own "Command routing and sequencing-state projection"
 * section. */
interface EndpointSession {
  link: Link;
  unsubscribeLine: () => void;
  unsubscribeRawLine: () => void;
  unsubscribeAckNack: () => void;
  unsubscribeError: () => void;
}

interface EndpointState {
  /** The physical USB device backing this endpoint -- present for a
   * plain USB endpoint and for a robot-via-relay synthesized endpoint
   * (which reuses the *relay's* own device, see
   * {@link EndpointState.synthesizedRelayTarget}'s own doc comment).
   * **Absent** (sprint 10 ticket 003) for a synthesized WiFi-robot
   * endpoint ({@link EndpointState.wifiTarget} set instead) -- a WiFi
   * robot has no local physical device at all, only a TCP host/port.
   * Every call site that reads this field only ever runs against a
   * state where it is known to be set by construction (USB attach,
   * post-flash reidentify, or a relay's own state); guarded with an
   * early return or `?.` rather than a non-null assertion wherever a
   * type-level check is needed, matching this module's existing
   * "failure is a value, never a crash" discipline. */
  device?: DaplinkDevice | undefined;
  /** This endpoint's stable, URL-safe id -- `usbEndpointId(device.serialNumber)`,
   * computed once when the state is created. Stored rather than
   * re-derived everywhere so a rename of the minting scheme only touches
   * one call site. */
  endpointId: string;
  /** The physical resource this endpoint contends for exclusive access
   * to -- the {@link KeyedMutex} key for every operation this module
   * runs against it. Equals {@link endpointId} for every USB endpoint
   * this sprint (one board, one port, one endpoint) -- this equality is
   * intentional and documented, not dead code: sprint 7's relay makes
   * them diverge (a relay's shared USB port is one `resourceKey` shared
   * by several endpoints, one per robot behind it), and carrying the
   * field now, unused-but-equal, means that sprint extends this model
   * instead of redesigning `KeyedMutex`'s keying and every call site
   * that reads it. See `sprint.md`'s Design Rationale. */
  resourceKey: string;
  name: string | null;
  nameError?: { reason: string; message: string } | undefined;
  /** This endpoint's device-type classification, derived from the most
   * recently seen banner via `classifyBanner`. Starts at
   * `classifyBanner(null)` (`type: "unknown"`, `evidence: "none"`)
   * before any session has ever connected, and stays there if
   * `identify()` ever resolves `null` (connected, unresponsive -- see
   * this module's own doc comment). `EndpointListEntry.role` is derived
   * from `classification.role` directly by {@link toEntry} -- there is
   * no separate `role` field on this state to keep in sync. */
  classification: DeviceClassification;
  /** The open session (link + its subscriptions), if any -- see
   * {@link EndpointSession}'s own doc comment. */
  session?: EndpointSession | undefined;
  /** Whether `server.ts` currently considers a session open for this
   * endpoint -- renamed from `linkOpen`, mirroring
   * {@link EndpointListEntry.sessionOpen} one to one. Tracked as its own
   * field rather than derived from {@link session}'s presence because a
   * link-level error after open ({@link DeviceRegistry.handleLinkError})
   * flips this to `false` immediately while deliberately leaving
   * `session` itself in place -- the still-referenced {@link Link} is
   * what a later {@link DeviceRegistry.teardownLink} call (from
   * `requestClose` or a detach) closes and unsubscribes from; nothing
   * else ever does. */
  sessionOpen: boolean;
  /** Present only when the most recent session-open attempt failed, or
   * a post-open link error occurred -- renamed from `linkError`,
   * mirroring {@link EndpointListEntry.sessionError} one to one. */
  sessionError?: string | undefined;
  /** Set once a desynced `nack` (`@robot-console/protocol`'s
   * `AckNackEvent.desynced`) has already been reported via
   * {@link DeviceRegistry.emitError} for the CURRENT session, so a
   * held-button burst of sends against an already-desynced session
   * reports the "press HELLO to resync" prompt once, not once per send.
   * Reset to `false` whenever a session (re)opens and whenever
   * {@link DeviceRegistry.resyncSession} completes -- both are points
   * where the underlying condition genuinely might have changed. */
  desyncNotified?: boolean;
  /** Present only while a flash is in flight for this device (sprint
   * 2) -- set at the start of {@link DeviceRegistry.requestFlash}'s
   * task and cleared (success or error) at its end. Reflected into
   * {@link EndpointListEntry.flashStatus} by {@link toEntry}. */
  flashStatus?: { firmware: FirmwareKind; phase: FlashPhase } | undefined;
  /** OOP 2026-09-09: the most recent parsed `status` reply on the
   * current session (see {@link parseStatusReply}); also flipped to
   * `estopped: true` by a bare `estop` reply. Cleared on teardown. */
  robotStatus?: RobotStatus | undefined;
  /** OOP 2026-09-09: `funcs` reply lines accumulated since the most
   * recent `FUNCS` send (which resets this to `[]`). Cleared on
   * teardown. */
  functions?: RobotFunction[] | undefined;
  /** Sprint 009 ticket 002: the stateful half of
   * `@robot-console/protocol`'s `v6/telemetry.ts` for this endpoint's
   * current session -- remembers the most recently held `thdr` and zips
   * each `t` line against it. Created lazily, on the first `thdr`/`t`
   * line seen for a session (see {@link DeviceRegistry.getTelemetryDecoder}),
   * and discarded on teardown/resync (see {@link DeviceRegistry.teardownLink}/
   * {@link DeviceRegistry.resyncSession}) so a stale header from a prior
   * session is never zipped against a new one's frames.
   *
   * Header recovery is deliberately passive -- see
   * {@link handleTelemetryLine}'s own doc comment for why there is no
   * recovery-request guard field here (an earlier revision of this
   * ticket had one; removed once bench testing showed the firmware has
   * no mode to request). */
  telemetryDecoder?: TelemetryDecoder | undefined;
  /** OOP 2026-09-09: the periodic `STATUS` poll behind
   * {@link EndpointListEntry.robotStatus} -- see
   * {@link DeviceRegistry.startRobotProbes}. Only ever set for a
   * robot-classified endpoint with an open session. */
  statusPollTimer?: ReturnType<typeof setInterval> | undefined;
  /** True between the poll writing `STATUS` and the next `status`
   * reply arriving, so that reply can be tagged `origin: "poll"` and
   * hidden by a console; a user-initiated `STATUS` reply arriving in
   * that window is tagged the same way, which is harmless. */
  pollAwaitingStatus?: boolean;
  /** True while a `HELLO` round trip ({@link DeviceRegistry.resyncSession})
   * is in flight, so the status poll stays quiet -- a `status` reply
   * arriving mid-banner-wait would be swallowed by the link's banner
   * wait anyway. */
  identifying?: boolean;
  /** OOP 2026-09-09, restructured sprint 8 ticket 004: present only on
   * an endpoint state synthesized by {@link DeviceRegistry.requestOpen}'s
   * relay branch for a robot reached THROUGH a local USB relay -- see
   * the module doc comment's "Robot-via-relay endpoints" section.
   * {@link toEntry} reads this field to decide `transport` (and whether
   * to project `viaRelay`/`addressSource`/`failoverTrail`, and omit
   * `usb`) for this entry, instead of `transport: "usb"` plus a `usb`
   * block. `device` on a via-relay state is always the *relay's* own
   * `DaplinkDevice` (there is no separate physical device for the
   * synthesized endpoint) -- read only for the relay's own
   * `serialPort`/`hid` fields via {@link EndpointState.resourceKey}'s
   * shared identity, not for anything robot-specific.
   *
   * Renamed from the OOP-era `viaRelay` (which only ever carried
   * `channel`/`group` for a `"relay-radio"` result, the only transport
   * that existed before this ticket) because a
   * {@link RelayConnectionResult} can now also be `"mbserial"` (no
   * channel/group at all -- see `RelayConnectionCoordinator.ts`'s own
   * doc comment) or, in principle, `"mbrelay"`. `wsMessages.ts`'s own
   * `EndpointListEntry.viaRelay` wire field is unchanged in shape --
   * {@link toEntry} projects it from `address` below only when one
   * exists. */
  synthesizedRelayTarget?:
    | {
        relayEndpointId: string;
        robotName: string;
        transport: "relay-radio" | "mbrelay" | "mbserial";
        /** `{ channel, group }` for display -- see
         * {@link bestEffortRadioAddress}'s own doc comment for why this
         * is best-effort rather than the exact value
         * `RelayConnectionCoordinator.ts` resolved internally. Absent
         * for `"mbserial"` (no channel/group exists for that
         * transport) or if `nameToRadioAddress` rejected the name and
         * no explicit override was given. */
        address?: { channel: number; group: number };
        /** `RelayConnectionCoordinator.ts`'s own `addressSource` for
         * this result -- absent for `"mbserial"` (that module never
         * reports one for that transport; see its own doc comment). */
        addressSource?: AddressSource;
        /** Every candidate abandoned before this one -- always present
         * (possibly empty) on a synthesized state, regardless of
         * transport; {@link toEntry} is what gates wire visibility to
         * non-`"mbserial"` only. */
        failoverTrail: readonly FailoverTrailEntry[];
      }
    | undefined;
  /** Sprint 10 ticket 003: present only on an endpoint synthesized for a
   * gated WiFi robot (`wifi-<name>`) -- the discovery record's
   * `host`/`port`, used to build the `WifiLinkSpec`
   * {@link DeviceRegistry.connectAndIdentifyWifi} connects with. Mutually
   * exclusive with {@link synthesizedRelayTarget} (a WiFi endpoint is
   * never also a via-relay one) and with {@link device} (no physical
   * device backs it -- see that field's own doc comment). `toEntry`
   * reads this field, not `device`, to decide `transport: "wifi"` and
   * project {@link EndpointListEntry.wifi} instead of a `usb` block.
   * Refreshed in place by {@link DeviceRegistry.syncWifiEndpoints} while
   * not yet connected (a re-advertisement may report a changed
   * host/port); left untouched once a session is open, since an open
   * `Link` already has its own connection and nothing here reconnects it
   * mid-session. */
  wifiTarget?: { host: string; port: number } | undefined;
  /** OOP 2026-09-10: whether the host should connect+identify this WiFi
   * endpoint on its own at the next {@link DeviceRegistry.syncWifiEndpoints}
   * pass (see {@link DeviceRegistry.autoConnectWifiRobot}). `true` from
   * synthesis, and again after a dropped link ({@link
   * DeviceRegistry.handleLinkError}) so the robot is re-identified when
   * it re-announces; `false` after a deliberate {@link
   * DeviceRegistry.requestClose}, so a user who closed the link is not
   * silently reconnected a minute later. Only meaningful alongside
   * {@link wifiTarget}. */
  wifiAutoConnect?: boolean;
  /** OOP 2026-09-10: an auto-connect attempt is in flight for this WiFi
   * endpoint -- the retry timer skips it rather than queuing a second
   * attempt behind the first. */
  wifiConnecting?: boolean;
}

function toEntry(state: EndpointState): EndpointListEntry {
  const synth = state.synthesizedRelayTarget;
  const wifi = state.wifiTarget;
  const entry: EndpointListEntry = {
    endpointId: state.endpointId,
    // OOP 2026-09-09, extended sprint 8 ticket 004, extended sprint 10
    // ticket 003: a via-relay or WiFi synthesized endpoint has no USB
    // identity of its own -- the triggering relay (or, for "mbserial"/
    // "wifi", nothing local at all) owns the physical connection -- so
    // it projects the coordinator's own transport (or "wifi") and a
    // viaRelay/wifi block instead of transport: "usb" plus a usb block.
    // See the module doc comment's "Robot-via-relay endpoints" section.
    transport: synth ? synth.transport : wifi ? "wifi" : "usb",
    resourceKey: state.resourceKey,
    classification: state.classification,
    name: state.name,
    role: state.classification.role,
    sessionOpen: state.sessionOpen,
  };
  if (synth) {
    if (synth.address) {
      entry.viaRelay = {
        relayEndpointId: synth.relayEndpointId,
        robotName: synth.robotName,
        channel: synth.address.channel,
        group: synth.address.group,
      };
    }
  } else if (wifi) {
    entry.wifi = { host: wifi.host, port: wifi.port };
  } else if (state.device) {
    entry.usb = {
      serialNumber: state.device.serialNumber,
      displaySerial: state.device.displaySerial,
      port: state.device.serialPort?.path ?? null,
    };
  }
  if (state.nameError) {
    entry.nameError = state.nameError;
  }
  if (state.sessionError) {
    entry.sessionError = state.sessionError;
  }
  // Sprint 6 ticket 003: project the open session's live `Session`
  // state -- read fresh off `Link.session` on every call, never cached
  // -- so a client reading any snapshot (the very next one after a
  // send, or the first one after reconnecting) sees current
  // seq/pendingCount with no separate resync event needed. Present
  // only while a session is open, mirroring `sessionError`'s own
  // present-only-when-relevant shape.
  if (state.sessionOpen && state.session) {
    const session = state.session.link.session;
    entry.sequencing = {
      seq: session.seq,
      pendingCount: session.pendingCount,
      lastDone: session.lastDone,
      lastDoneReason: session.lastDoneReason,
    };
    // Sprint 8 ticket 004: addressSource/failoverTrail are present only
    // for a relay-mediated, non-"mbserial" endpoint with an open
    // session -- see wsMessages.ts's own doc comment for these fields.
    if (synth && synth.transport !== "mbserial") {
      if (synth.addressSource !== undefined) {
        entry.addressSource = synth.addressSource;
      }
      entry.failoverTrail = [...synth.failoverTrail];
    }
  }
  if (state.flashStatus) {
    entry.flashStatus = state.flashStatus;
  }
  if (state.robotStatus) {
    entry.robotStatus = state.robotStatus;
  }
  if (state.functions) {
    entry.functions = state.functions;
  }
  return entry;
}

/** Parse a `status k=v ...` reply's fields (robot firmware
 * `wire_handler.cpp` `execStatus`) into a {@link RobotStatus}. The
 * named booleans come from the `flags=<hex>` bitfield per
 * `wire_adapter.h` (bit0 ready, bit1 estopped, bit2 stall-halted, bit3
 * lease-expired); `active` is the firmware's own `active=` key. A field
 * with no `=` is kept under its own text with an empty value rather
 * than dropped, so nothing the robot said is lost. */
export function parseStatusReply(fields: readonly string[], now: number = Date.now()): RobotStatus {
  const map: Record<string, string> = {};
  for (const field of fields) {
    const eq = field.indexOf("=");
    if (eq === -1) {
      map[field] = "";
    } else {
      map[field.slice(0, eq)] = field.slice(eq + 1);
    }
  }
  const flagsText = map["flags"];
  const flags = flagsText !== undefined ? Number.parseInt(flagsText, 16) : Number.NaN;
  const bit = (n: number): boolean => Number.isFinite(flags) && (flags & (1 << n)) !== 0;
  return {
    receivedAt: now,
    fields: map,
    ready: Number.isFinite(flags) ? bit(0) : map["ready"] === "1",
    active: map["active"] === "1",
    estopped: bit(1),
    stallHalted: bit(2),
    leaseExpired: bit(3),
  };
}

/** Reconstruct a received line's raw wire text from its decoded form,
 * via `v6/codec.ts`'s own `encodeLine` -- composing the protocol
 * package's framing rather than reimplementing it here (see this
 * module's own boundary doc comment). Falls back to a plain space-join
 * only if re-encoding itself throws, which should not happen for a
 * `decodeLine`-produced value; a received line must never be dropped
 * silently just because display formatting failed. */
function reconstructLineText(decoded: DecodedLine): string {
  try {
    return encodeLine(decoded.verb, decoded.fields, decoded.id).replace(/\n$/, "");
  } catch {
    const parts = [decoded.verb, ...decoded.fields];
    if (decoded.id !== undefined) {
      parts.push(`#${decoded.id}`);
    }
    return parts.join(" ");
  }
}

// ---------------------------------------------------------------------
// DeviceRegistry
// ---------------------------------------------------------------------

export type DevicesListener = (endpoints: EndpointListEntry[]) => void;
export type LineListener = (
  endpointId: string,
  direction: LineDirection,
  line: string,
  origin?: LineOrigin,
) => void;
export type RegistryErrorListener = (endpointId: string | undefined, message: string) => void;
/** Sprint 009 ticket 002: one decoded telemetry event for an endpoint --
 * either a header update (`thdr`) or a decoded frame (`t`), never both
 * at once. `server.ts` is what turns this into a {@link TelemetryMessage}-
 * shaped broadcast; this module never imports `wsMessages.ts`'s wire
 * type directly (same "no reach into packages/host's wire layer" split
 * every other listener type here already follows -- see
 * {@link LineListener}/{@link FlashProgressListener}). Deliberately never
 * fired for a header-less or field-count-mismatched `t` line -- see
 * {@link DeviceRegistry.handleInboundLine}'s own doc comment for why
 * nothing is forwarded in that case. */
export type TelemetryEvent = { header: readonly string[] } | { frame: Record<string, string> };
export type TelemetryListener = (endpointId: string, event: TelemetryEvent) => void;
/** Notified once per {@link FlashPhase} as a `requestFlash` task
 * advances -- mirrors {@link LineListener}'s per-event shape rather
 * than a bulk snapshot, since `server.ts` forwards these directly as
 * {@link FlashProgressMessage}-shaped broadcasts. Carries the full
 * {@link FirmwareSourceRef} the flash was requested with (ticket 005)
 * rather than a bare {@link FirmwareKind} -- the same object `server.ts`
 * received on the originating `flash-start`, echoed straight through so
 * a `"local-hex"` flash's `fileName`/`sha256`/`uploadId` reach the
 * client without `server.ts` reconstructing them. */
export type FlashProgressListener = (endpointId: string, source: FirmwareSourceRef, phase: FlashPhase) => void;
/** Notified exactly once per `requestFlash` call, with its terminal
 * outcome -- mirrors {@link FlashResultMessage}'s own shape field for
 * field. `message` is present only on `status: "error"`.
 * `classification`/`name`/`reidentify` are present only on
 * `status: "ok"` (ticket 004): the post-flash identity, from whatever
 * {@link DeviceRegistry.reidentifyAfterFlash}'s `identify()` returned,
 * plus `reidentify: "timeout"` if it never returned a banner. Carries
 * the full {@link FirmwareSourceRef}, same as {@link FlashProgressListener}
 * -- see that type's own doc comment. */
export type FlashResultListener = (
  endpointId: string,
  source: FirmwareSourceRef,
  status: "ok" | "error",
  message?: string,
  classification?: DeviceClassification,
  name?: string | null,
  reidentify?: "timeout",
) => void;

export interface DeviceRegistryOptions {
  /** Injectable device watcher; defaults to a real {@link DeviceWatcher}
   * (real USB/HID enumeration). Tests substitute one backed by a
   * fixture `listDevices` function. */
  watcher?: DeviceWatcher;
  /** Injectable SWD name resolver; defaults to {@link readSwdName}. */
  resolveName?: NameResolver;
  /** Injectable {@link Link} factory; defaults to real `UsbSerialLink`
   * (via {@link defaultLinkFactory}). Tests substitute a fake
   * {@link LinkFactory} returning a fully synthetic {@link Link}. */
  createLink?: LinkFactory;
  /** Injectable firmware-source config accessor; defaults to a call to
   * `config.ts`'s real {@link getFirmwareConfig} (real environment/
   * dotconfig `.env` parsing). Tests substitute a function returning a
   * fixture {@link FirmwareConfigMap}, following this file's existing
   * `resolveName`/`createLink` injection pattern exactly -- no real
   * environment setup needed to exercise `requestFlash`. */
  getFirmwareConfig?: () => FirmwareConfigMap;
  /** Injectable `releases.ts` release resolver; defaults to the real,
   * network-backed {@link resolveRelease}. Tests substitute a fully
   * synthetic fake, never a real GitHub call. */
  resolveRelease?: typeof resolveRelease;
  /** Injectable `releases.ts` hex fetch+verify; defaults to the real,
   * network-backed {@link fetchAndVerifyHex}. Tests substitute a fully
   * synthetic fake, never a real GitHub call. */
  fetchAndVerifyHex?: typeof fetchAndVerifyHex;
  /** Injectable `flash.ts` entry point; defaults to the real DAPjs/
   * node-hid-backed {@link flash}. Tests substitute a fully synthetic
   * fake, never real USB/SWD I/O. */
  flash?: typeof flash;
  /** Ticket 005: retrieve (and consume) a previously verified local-hex
   * upload's bytes by `uploadId` -- the seam `runFlash`'s `"local-hex"`
   * branch calls instead of `resolveRelease`/`fetchAndVerifyHex`.
   * `server.ts` passes `localHexUpload.ts`'s `LocalHexUploadManager
   * #consumeUpload` (bound), the *same instance* it uses to handle
   * `flash-local-begin` and the binary frame, so an upload verified over
   * the socket is the very one `runFlash` consumes here -- these are two
   * views onto one shared upload store, not two independent ones.
   * Defaults to a function that always returns `undefined` (every
   * `"local-hex"` flash ends in a `flash-result` error) so a
   * `DeviceRegistry` built with no local-hex wiring at all (every
   * existing test in this file) never needs to know this seam exists. */
  consumeUpload?: (uploadId: string) => Buffer | undefined;
  /** Budget for a single post-flash reidentify attempt (ticket 004);
   * defaults to {@link DEFAULT_REIDENTIFY_TIMEOUT_MS}. Tests substitute
   * a tiny value so a fake `identify()` that never resolves doesn't
   * cost real wall-clock time. */
  reidentifyTimeoutMs?: number;
  /** Sprint 5: injectable {@link KnownRobotsStore} -- the durable
   * remembered-robot roster. Defaults to a real, state-dir-backed
   * `new KnownRobotsStore()`, mirroring every other injected seam on
   * this class. Tests substitute a store pointed at a temp directory,
   * or a fake object satisfying the same narrow interface (`list`,
   * `recordSighting`, `forget`), so no test needs a real filesystem to
   * exercise the write gate/projection/forget action below. */
  knownRobotsStore?: KnownRobotsStore;
  /** OOP 2026-09-09: how often the host polls `STATUS` on an open
   * robot session to keep {@link EndpointListEntry.robotStatus} fresh.
   * `0` disables the poll entirely. Default
   * {@link DEFAULT_STATUS_POLL_INTERVAL_MS}. */
  statusPollIntervalMs?: number;
  /** OOP 2026-09-09: whether to send `FUNCS` automatically once a robot
   * identifies, so {@link EndpointListEntry.functions} is populated
   * without a user pressing the button. Default `true`. */
  autoRequestFunctions?: boolean;
  /** OOP 2026-09-09: injectable `flash.ts` reset entry point, used to
   * return a relay to its command plane before a fresh radio handshake
   * -- see the module doc comment's "Robot-via-relay endpoints"
   * section. Defaults to the real, DAPjs/node-hid-backed
   * {@link resetOverSwd}. Tests substitute a fully synthetic fake,
   * never real USB/SWD I/O -- same precedent as {@link flash}'s own
   * injection. */
  resetOverSwd?: typeof resetOverSwd;
  /** OOP 2026-09-09: how long `openRobotViaRelay` waits after
   * {@link resetOverSwd} resets a relay before attempting a fresh
   * `!CG`/`!GO` handshake against it, giving the relay's firmware time
   * to come back up. Defaults to {@link DEFAULT_RELAY_BOOT_DELAY_MS}.
   * Tests pass `0` so this never costs real wall-clock time. */
  relayBootDelayMs?: number;
  /** Sprint 8 ticket 004: injectable {@link RelayConnector} (the real
   * {@link RelayConnectionCoordinator} by default, wired to this
   * registry's own `createLink`). Tests substitute a fully synthetic
   * fake -- never a real {@link RelayConnectionCoordinator} instance,
   * per this ticket's own testing note -- so resolution, connect,
   * liveness-probe timing, and failover are never exercised for real
   * here; this registry only tests that it calls the seam with the
   * right candidates and correctly turns its result into endpoint
   * bookkeeping. */
  relayConnectionCoordinator?: RelayConnector;
  /** Sprint 8 ticket 001/004: injectable {@link MdnsDiscovery}; defaults
   * to a real one (real `bonjour-service` multicast browsing). Started
   * alongside the device watcher in {@link DeviceRegistry.start} and
   * stopped alongside it in {@link DeviceRegistry.stop}. Tests
   * substitute one built from a fake `MdnsBackend` (mirroring
   * `mdnsDiscovery.test.ts`'s own fixtures), so no real multicast socket
   * is ever opened by a `DeviceRegistry` test. */
  mdnsDiscovery?: MdnsDiscovery;
  /** Sprint 10 ticket 004: whether a currently radio-connected robot
   * (`"relay-radio"`/`"mbrelay"`, never `"mbserial"`) is automatically
   * switched to WiFi once a gated WiFi advertisement for the same name
   * appears -- see this class's own doc comment, "Auto-switch radio ->
   * WiFi" section, for the full policy. Defaults to `true`; tests that
   * want ticket 003's plain endpoint-synthesis behavior without the
   * switch also firing pass `false`. */
  autoSwitchToWifi?: boolean;
  /** OOP 2026-09-10: whether a gated WiFi robot is connected and
   * identified (`HELLO`, then the `ID`/`STATUS`/`FUNCS` probes of
   * {@link DeviceRegistry.startRobotProbes}) as soon as its
   * advertisement is seen -- the same "identify at attach" behavior a
   * USB device gets -- rather than only on the first `session-open`
   * click. See {@link DeviceRegistry.autoConnectWifiRobot} for the
   * policy (retry on a failed attempt or a dropped link at the next
   * mDNS change; never after a deliberate close). Defaults to `true`;
   * tests that want ticket 003's list-first, connect-on-click shape
   * pass `false`. */
  autoConnectWifi?: boolean;
  /** OOP 2026-09-10 (second fix): how often the host retries a WiFi
   * endpoint whose discovery-time connect failed or whose link has
   * since dropped (robot rebooted, left the network). Needed because
   * the mDNS backend fires `up` only for a *new* service instance --
   * a robot re-announcing after a reboot updates the existing record
   * silently, so {@link DeviceRegistry.syncWifiEndpoints} would never
   * run again for it. `0` disables the timer (an mDNS change still
   * retries). Default {@link DEFAULT_WIFI_RETRY_INTERVAL_MS}. */
  wifiRetryIntervalMs?: number;
}

/** Default period of the WiFi reconnect retry timer (see
 * {@link DeviceRegistryOptions.wifiRetryIntervalMs}). Short enough that a
 * rebooted robot is back on the front page within seconds of rejoining
 * the network; a failed attempt against an unreachable name fails fast
 * (resolver `ENOTFOUND`), so this costs little while a robot is off. */
export const DEFAULT_WIFI_RETRY_INTERVAL_MS = 10_000;

/** Default period of the host's own `STATUS` poll on an open robot
 * session (see {@link DeviceRegistryOptions.statusPollIntervalMs}). */
export const DEFAULT_STATUS_POLL_INTERVAL_MS = 5000;

/**
 * Live registry of attached devices, their resolved identity/
 * classification, and any open per-endpoint session -- the one stateful
 * object `server.ts` composes to turn `devices.ts`/`swdName.ts`/
 * `classifyBanner`/`UsbSerialLink` into WebSocket messages. See the
 * module doc comment for the attach/detach flows and the race this
 * module's {@link KeyedMutex} usage prevents.
 */
export class DeviceRegistry {
  private readonly watcher: DeviceWatcher;
  private readonly resolveName: NameResolver;
  private readonly createLink: LinkFactory;
  private readonly getFirmwareConfigFn: () => FirmwareConfigMap;
  private readonly resolveReleaseFn: typeof resolveRelease;
  private readonly fetchAndVerifyHexFn: typeof fetchAndVerifyHex;
  private readonly flashFn: typeof flash;
  private readonly consumeUploadFn: (uploadId: string) => Buffer | undefined;
  private readonly reidentifyTimeoutMs: number;
  private readonly knownRobotsStore: KnownRobotsStore;
  private readonly statusPollIntervalMs: number;
  private readonly autoRequestFunctions: boolean;
  private readonly resetOverSwdFn: typeof resetOverSwd;
  private readonly relayBootDelayMs: number;
  private readonly relayConnectionCoordinator: RelayConnector;
  private readonly mdnsDiscovery: MdnsDiscovery;
  private readonly autoSwitchToWifi: boolean;
  private readonly autoConnectWifi: boolean;
  private readonly wifiRetryIntervalMs: number;
  private wifiRetryTimer: ReturnType<typeof setInterval> | undefined;
  private readonly mutex = new KeyedMutex();
  private readonly states = new Map<string, EndpointState>();
  private unsubscribeWatcher: (() => void) | undefined;
  private unsubscribeMdns: (() => void) | undefined;

  private readonly devicesListeners = new Set<DevicesListener>();
  private readonly lineListeners = new Set<LineListener>();
  private readonly errorListeners = new Set<RegistryErrorListener>();
  private readonly telemetryListeners = new Set<TelemetryListener>();
  private readonly flashProgressListeners = new Set<FlashProgressListener>();
  private readonly flashResultListeners = new Set<FlashResultListener>();

  constructor(options: DeviceRegistryOptions = {}) {
    this.watcher = options.watcher ?? new DeviceWatcher();
    this.resolveName = options.resolveName ?? readSwdName;
    this.createLink = options.createLink ?? defaultLinkFactory;
    this.getFirmwareConfigFn = options.getFirmwareConfig ?? (() => getFirmwareConfig());
    this.resolveReleaseFn = options.resolveRelease ?? resolveRelease;
    this.fetchAndVerifyHexFn = options.fetchAndVerifyHex ?? fetchAndVerifyHex;
    this.flashFn = options.flash ?? flash;
    this.consumeUploadFn = options.consumeUpload ?? (() => undefined);
    this.reidentifyTimeoutMs = options.reidentifyTimeoutMs ?? DEFAULT_REIDENTIFY_TIMEOUT_MS;
    this.knownRobotsStore = options.knownRobotsStore ?? new KnownRobotsStore();
    this.statusPollIntervalMs = options.statusPollIntervalMs ?? DEFAULT_STATUS_POLL_INTERVAL_MS;
    this.autoRequestFunctions = options.autoRequestFunctions ?? true;
    this.resetOverSwdFn = options.resetOverSwd ?? resetOverSwd;
    this.relayBootDelayMs = options.relayBootDelayMs ?? DEFAULT_RELAY_BOOT_DELAY_MS;
    this.relayConnectionCoordinator =
      options.relayConnectionCoordinator ??
      new RelayConnectionCoordinator({ linkFactory: (spec) => this.createLink(spec) });
    this.mdnsDiscovery = options.mdnsDiscovery ?? new MdnsDiscovery();
    this.autoSwitchToWifi = options.autoSwitchToWifi ?? true;
    this.autoConnectWifi = options.autoConnectWifi ?? true;
    this.wifiRetryIntervalMs = options.wifiRetryIntervalMs ?? DEFAULT_WIFI_RETRY_INTERVAL_MS;
  }

  /** Start watching for devices and browsing for relays/robots over
   * mDNS. Idempotent-ish in practice (callers are expected to call this
   * once); an immediate `pollOnce()` is kicked off so the first device
   * snapshot arrives promptly rather than waiting a full poll interval.
   * A discovery change re-broadcasts the full endpoint snapshot -- via
   * {@link syncWifiEndpoints} (sprint 10 ticket 003), which both
   * recomputes the gated WiFi endpoint set (see that method's own doc
   * comment) and re-broadcasts (via the same {@link onDevicesChanged}
   * path every other state change uses) so `server.ts`'s
   * `discoveredServices()`-carrying `EndpointsMessage` reaches clients
   * promptly -- {@link discoveredServices} itself never touches
   * {@link states}. {@link syncWifiEndpoints} is also called once
   * immediately here, mirroring `pollOnce()`'s own "don't wait for the
   * next event" rationale: {@link mdnsDiscovery}'s `current()` can
   * already be non-empty at this point (most notably after a
   * `stop()`/`start()` cycle -- `MdnsDiscovery.stop()`'s own doc comment
   * explains why its already-discovered maps are not cleared), and no
   * fresh `up`/`down` event would otherwise ever fire for an
   * already-known service to trigger a first sync. */
  start(): void {
    this.unsubscribeWatcher = this.watcher.onChange((event) => {
      this.handleChange(event);
    });
    this.watcher.start();
    void this.watcher.pollOnce();
    this.unsubscribeMdns = this.mdnsDiscovery.onChange(() => {
      this.syncWifiEndpoints();
    });
    this.mdnsDiscovery.start();
    this.syncWifiEndpoints();
    if (this.autoConnectWifi && this.wifiRetryIntervalMs > 0) {
      const timer = setInterval(() => this.retryWifiAutoConnects(), this.wifiRetryIntervalMs);
      timer.unref?.();
      this.wifiRetryTimer = timer;
    }
  }

  /** Stop watching and close every open link, best-effort. */
  async stop(): Promise<void> {
    this.watcher.stop();
    this.unsubscribeWatcher?.();
    this.unsubscribeWatcher = undefined;
    this.mdnsDiscovery.stop();
    this.unsubscribeMdns?.();
    this.unsubscribeMdns = undefined;
    if (this.wifiRetryTimer) {
      clearInterval(this.wifiRetryTimer);
      this.wifiRetryTimer = undefined;
    }
    const closes = [...this.states.values()].map((state) =>
      this.teardownLink(state).catch(() => {
        // Best-effort shutdown -- a failure to close one link must not
        // stop the others from being torn down too.
      }),
    );
    await Promise.all(closes);
    this.states.clear();
  }

  /** The current endpoint list, sorted by id for a deterministic order. */
  snapshot(): EndpointListEntry[] {
    return [...this.states.values()]
      .map(toEntry)
      .sort((a, b) => a.endpointId.localeCompare(b.endpointId));
  }

  /**
   * Sprint 5: the durable "remembered robots" projection -- every
   * {@link KnownRobotsStore} record whose name is *not* currently
   * attached, mapped to `RememberedRobotEntry`'s wire shape. A robot you
   * can see right now is an endpoint (in {@link snapshot}), not a
   * memory; showing it in both places would look like a duplicate. This
   * "subtract what's live" filter needs {@link states} (private to this
   * class), which is exactly why the projection lives here rather than
   * on `KnownRobotsStore` itself -- that module knows nothing about
   * live attachment.
   */
  rememberedRobots(): RememberedRobotEntry[] {
    const attachedNames = new Set(
      [...this.states.values()]
        .map((s) => s.name)
        .filter((n): n is string => n !== null),
    );
    return this.knownRobotsStore
      .list()
      .filter((r) => !attachedNames.has(r.name))
      .map((r) => ({
        name: r.name,
        lastSeenAt: r.lastSeenAt,
        lastSeenVia: r.lastSeenVia,
        lastRole: r.lastRole,
        lastUsbSerial: r.lastUsbSerial,
      }));
  }

  /**
   * Sprint 8 ticket 004: the current mDNS discovery snapshot, projected
   * onto `wsMessages.ts`'s wire shape -- see
   * {@link DiscoveredServicesSnapshot}'s own doc comment. A straight
   * pass-through of {@link mdnsDiscovery}'s own `current()` (this class
   * never caches or re-derives it), mirroring {@link rememberedRobots}'s
   * own "server.ts calls this fresh on every broadcast" precedent.
   */
  discoveredServices(): DiscoveredServicesSnapshot {
    const current = this.mdnsDiscovery.current();
    return {
      relays: current.relays.map((r) => ({
        instanceName: r.instanceName,
        host: r.host,
        port: r.port,
        ...(r.registryPort !== undefined ? { registryPort: r.registryPort } : {}),
      })),
      robots: current.robots.map((r) => ({
        instanceName: r.instanceName,
        host: r.host,
        port: r.port,
      })),
    };
  }

  /**
   * Sprint 10 ticket 003: recompute the gated set of WiFi-robot
   * {@link EndpointState}s from {@link mdnsDiscovery}'s current
   * `wifiRobots` snapshot and {@link knownRobotsStore}'s current roster
   * -- called on every {@link mdnsDiscovery} change (see {@link start}),
   * never on a timer and never reading `mdnsDiscovery.current().wifiRobots`
   * anywhere else in this class (this is the one gate call site --
   * `wifi/wifiRobotGate.ts`'s own module doc comment and this sprint's
   * Design Rationale, "No wire-visible ungated WiFi list").
   *
   * Mints a fresh, not-yet-connected `wifi-<name>` {@link EndpointState}
   * for every gated robot with no existing state (mirroring the USB
   * attach flow's "list first, connect on request" shape -- see
   * {@link EndpointState.wifiTarget}'s own doc comment), refreshes
   * `wifiTarget` in place for one that already exists but is not yet
   * connected (a re-advertisement may report a changed host/port), and
   * leaves an already-**open** session's `wifiTarget` untouched (nothing
   * reconnects a live session just because a later advertisement
   * repeats or changes it).
   *
   * A gated robot's state disappearing from this snapshot (its
   * advertisement went `down`, or it dropped out of the roster) removes
   * its `EndpointState` **only if no session is open** for it -- per
   * this sprint's Design Rationale, "An ad disappearing is not a
   * disconnect": only the link's own `close`/`error` (via
   * {@link handleLinkError}) ends an open WiFi session. An open session
   * whose advertisement is gone is left listed, `sessionOpen: true`,
   * exactly like a USB board that stops answering `HELLO` stays listed
   * as "connected, unresponsive" rather than disappearing.
   */
  private syncWifiEndpoints(): void {
    const gated = gateWifiRobots(this.mdnsDiscovery.current().wifiRobots, this.knownRobotsStore.list());
    const gatedByName = new Map<string, WifiRobotService>(gated.map((robot) => [robot.name, robot]));

    for (const [id, state] of this.states) {
      if (!state.wifiTarget) {
        continue;
      }
      const stillGated = state.name !== null && gatedByName.has(state.name);
      if (!stillGated && !state.sessionOpen) {
        this.states.delete(id);
      }
    }

    for (const robot of gatedByName.values()) {
      const id = wifiEndpointId(robot.name);
      const existing = this.states.get(id);
      if (existing) {
        if (!existing.sessionOpen) {
          existing.wifiTarget = { host: robot.host, port: robot.port };
        }
        continue;
      }
      this.states.set(id, {
        endpointId: id,
        resourceKey: id,
        name: robot.name,
        classification: classifyBanner(null),
        sessionOpen: false,
        wifiTarget: { host: robot.host, port: robot.port },
        wifiAutoConnect: true,
      });
    }

    this.emitDevices();

    // OOP 2026-09-10: identify at discovery, exactly like a USB attach
    // -- see autoConnectWifiRobot's own doc comment. Queued before the
    // auto-switch below under the same per-endpoint mutex key, so the
    // switch always observes the outcome of this attempt.
    if (this.autoConnectWifi) {
      for (const robot of gatedByName.values()) {
        void this.autoConnectWifiRobot(robot.name);
      }
    }

    // Sprint 10 ticket 004: after the gated set above is up to date,
    // look for any name that both has a gated WiFi record AND is a
    // currently-open radio-mediated child, and kick off the
    // host-initiated switch -- see this class's own doc comment,
    // "Auto-switch radio -> WiFi" section. Fire-and-forget: this method
    // itself must stay synchronous (the mdnsDiscovery.onChange contract
    // this is called from), so each candidate's actual switch runs as
    // an independent queued mutex task rather than being awaited here.
    if (this.autoSwitchToWifi) {
      for (const robot of gatedByName.values()) {
        void this.autoSwitchRadioToWifi(robot.name);
      }
    }
  }

  /**
   * OOP 2026-09-10: connect and identify a gated WiFi robot on the
   * host's own initiative, so the front page shows its role,
   * classification (`ID`), status and function list without anyone
   * clicking into it first -- the same thing a USB device gets at
   * attach time via {@link connectAndIdentify}. Fire-and-forget from
   * {@link syncWifiEndpoints} (which must stay synchronous), one queued
   * mutex task per name.
   *
   * Policy: attempt whenever the endpoint still wants it
   * ({@link EndpointState.wifiAutoConnect}), has no open session, and
   * the same name is not already connected directly over USB (a
   * direct USB session already carries everything this would fetch;
   * mirrors {@link autoSwitchRadioToWifi}'s own guard). A failed
   * attempt leaves the flag set, so the next mDNS announce (the robot
   * re-advertises on a 60 s period) retries; a deliberate
   * {@link requestClose} clears it. Never throws -- any failure is
   * reported on the endpoint via {@link emitError} and the state left
   * as {@link connectAndIdentifyOverLink} recorded it.
   */
  private async autoConnectWifiRobot(name: string): Promise<void> {
    const wifiId = wifiEndpointId(name);
    await this.mutex.run(wifiId, async () => {
      const state = this.states.get(wifiId);
      if (!state?.wifiTarget || !state.wifiAutoConnect || state.sessionOpen || state.identifying) {
        return;
      }
      if (this.hasOpenUsbSessionForName(name)) {
        return;
      }
      state.wifiConnecting = true;
      try {
        await this.connectAndIdentifyWifi(state);
      } catch (error) {
        this.emitError(wifiId, error instanceof Error ? error.message : String(error));
      } finally {
        state.wifiConnecting = false;
      }
    });
  }

  /**
   * OOP 2026-09-10 (second fix): the retry-timer pass -- see
   * {@link DeviceRegistryOptions.wifiRetryIntervalMs} for why an mDNS
   * change alone is not enough. Re-queues {@link autoConnectWifiRobot}
   * for every WiFi endpoint that still wants a connection and has none,
   * skipping any with an attempt already in flight. The stakeholder's
   * report: power-cycle a robot, its card shows the dropped link's
   * error, and it never came back on its own.
   */
  private retryWifiAutoConnects(): void {
    for (const state of this.states.values()) {
      if (
        state.wifiTarget &&
        state.wifiAutoConnect &&
        !state.sessionOpen &&
        !state.identifying &&
        !state.wifiConnecting &&
        state.name !== null
      ) {
        void this.autoConnectWifiRobot(state.name);
      }
    }
  }

  /** Sprint 10 ticket 004: the `-via-<name>` synthesized child endpoint
   * id currently open for `name`, if any -- restricted to
   * `"relay-radio"`/`"mbrelay"` (never `"mbserial"`, which has no local
   * relay to reopen a plain session on -- see this class's own doc
   * comment). Mirrors {@link findSynthesizedEndpointId}'s own linear-scan
   * precedent, keyed by robot name instead of relay endpoint id. */
  private findSynthesizedRelayChildForName(name: string): string | undefined {
    for (const [id, state] of this.states) {
      const target = state.synthesizedRelayTarget;
      if (target && target.robotName === name && target.transport !== "mbserial" && state.sessionOpen) {
        return id;
      }
    }
    return undefined;
  }

  /** Sprint 10 ticket 004: whether `name` is currently connected over a
   * plain, directly-attached USB endpoint (not a via-relay or WiFi
   * synthesized one) -- used to guard {@link autoSwitchRadioToWifi}: a
   * direct USB session is strictly better than WiFi, so this ticket never
   * switches a name that also has one open, even if a radio-mediated
   * child for the same name happens to be open too. */
  private hasOpenUsbSessionForName(name: string): boolean {
    for (const state of this.states.values()) {
      if (
        state.sessionOpen &&
        state.name === name &&
        state.device !== undefined &&
        !state.synthesizedRelayTarget &&
        !state.wifiTarget
      ) {
        return true;
      }
    }
    return false;
  }

  /**
   * Sprint 10 ticket 004: the host-initiated radio -> WiFi switch for
   * `name` -- see this class's own doc comment, "Auto-switch radio ->
   * WiFi" section, for the full policy this implements. A no-op unless
   * `name` currently has an open `"relay-radio"`/`"mbrelay"` child (see
   * {@link findSynthesizedRelayChildForName}) and no open plain-USB
   * session (see {@link hasOpenUsbSessionForName}).
   *
   * Attempts the WiFi connect *first*, under the WiFi endpoint's own
   * `resourceKey` in {@link KeyedMutex.run} -- per `sprint.md`'s SUC-004
   * Main Flow: a failed attempt must never regress an already-working
   * radio session, so the radio child is left completely untouched
   * unless and until the WiFi link is actually open. Only then does this
   * method acquire the relay's own `resourceKey` (a second, nested
   * {@link KeyedMutex.run} call, always in this order) to tear the radio
   * child down and reopen the relay's own plain USB session. Every
   * precondition is re-checked once each mutex slot is actually held
   * (this method's own initial reads are only a pre-queueing snapshot,
   * exactly like every other mutex-guarded entry point in this class),
   * so a state that changed while this task was queued (the child
   * already closed, switched, or the advertisement disappeared again)
   * degrades to a silent no-op rather than acting on stale information.
   */
  private async autoSwitchRadioToWifi(name: string): Promise<void> {
    const childId = this.findSynthesizedRelayChildForName(name);
    if (!childId) {
      return;
    }
    const child = this.states.get(childId);
    const relayEndpointId = child?.synthesizedRelayTarget?.relayEndpointId;
    if (!relayEndpointId) {
      return;
    }
    const wifiId = wifiEndpointId(name);

    await this.mutex.run(wifiId, async () => {
      if (this.hasOpenUsbSessionForName(name)) {
        return;
      }
      if (this.findSynthesizedRelayChildForName(name) !== childId) {
        // Changed (closed, switched, or replaced) while this task was
        // queued behind the WiFi endpoint's mutex slot -- nothing left
        // to switch.
        return;
      }
      const wifiState = this.states.get(wifiId);
      if (!wifiState?.wifiTarget) {
        // The advertisement disappeared again -- nothing to switch to.
        return;
      }

      // (a) Attempt the WiFi connect -- ticket 003's own click path,
      // unchanged -- *before* touching the radio session at all.
      // OOP 2026-09-10: when autoConnectWifi is on, the queued
      // autoConnectWifiRobot task already ran ahead of this one under
      // the same mutex key, so its outcome (open, or failed with
      // sessionError) is simply observed here rather than attempted a
      // second time. An already-open WiFi session (auto-connect or a
      // concurrent click) proceeds straight to the teardown in (b).
      if (!wifiState.sessionOpen && !this.autoConnectWifi) {
        await this.connectAndIdentifyWifi(wifiState);
      }

      if (!wifiState.sessionOpen) {
        // A socket-level connect failure, or a link error arriving
        // before identify() returned -- report it on the WiFi endpoint
        // only and stop. The radio child (and the relay's own session)
        // are left completely untouched: a transient loss of the WiFi
        // candidate must never strand the student with no working
        // session at all.
        this.emitError(
          wifiId,
          `Auto-switch of ${name} to WiFi failed` +
            (wifiState.sessionError ? `: ${wifiState.sessionError}` : "") +
            ` -- ${name} remains connected over relay ${relayEndpointId}`,
        );
        return;
      }

      // (b) The WiFi link is open -- now tear down the radio-mediated
      // child and reopen the relay's own plain USB session, exactly
      // like a deliberate requestClose on this same endpoint. Runs
      // under the relay's own resourceKey, nested inside the WiFi key
      // already held above (never the reverse order).
      const relayResourceKey = this.states.get(relayEndpointId)?.resourceKey ?? relayEndpointId;
      await this.mutex.run(relayResourceKey, async () => {
        const liveChildId = this.findSynthesizedRelayChildForName(name);
        if (liveChildId !== childId) {
          // The radio child changed underneath us (closed/switched
          // already) while queued behind the relay's mutex slot --
          // nothing left to tear down; the WiFi session just opened
          // above stays open regardless, since it is independently
          // valid on its own.
          return;
        }
        const liveChild = this.states.get(childId);
        if (!liveChild) {
          return;
        }
        await this.teardownLink(liveChild);
        this.states.delete(childId);
        this.emitDevices();
        const relay = this.states.get(relayEndpointId);
        if (relay && !relay.sessionOpen) {
          await this.connectAndIdentify(relay);
        }

        const target = wifiState.wifiTarget;
        const address = target ? `${target.host}:${target.port}` : "an unknown address";
        const notice = `Switched ${name} from relay ${relayEndpointId} to WiFi at ${address}`;
        this.emitError(relayEndpointId, notice);
        this.emitError(wifiId, notice);
      });
    });
  }

  /** Sprint 10 ticket 003: whether `name` currently gates through --
   * see {@link syncWifiEndpoints} for the full gating flow. Used by
   * {@link requestClose} to decide whether a WiFi endpoint's entry
   * should survive a deliberate close whose advertisement has already
   * gone `down` -- a fresh gate computation, not a read of
   * {@link states}, since the point is to check the *advertisement*,
   * not this class's own (about to be stale) bookkeeping. */
  private isWifiRobotGated(name: string): boolean {
    const gated = gateWifiRobots(this.mdnsDiscovery.current().wifiRobots, this.knownRobotsStore.list());
    return gated.some((robot) => robot.name === name);
  }

  /**
   * Sprint 5: remove `name` from the remembered-robot roster and emit a
   * fresh device snapshot so every connected client's `rememberedRobots`
   * list drops it immediately. Synchronous and not run through
   * {@link KeyedMutex} -- unlike every other public mutator on this
   * class, this one touches no physical resource, only the store's
   * in-memory map, so there is no resource to serialize access to.
   * `KnownRobotsStore.forget` is itself a silent no-op for an unknown
   * name (never throws), so forgetting an already-absent (or
   * never-known) name is harmless here too -- this still emits a
   * snapshot in that case, which is fine (a spurious notification, not a
   * spurious *change*).
   *
   * `sprint.md`'s Step 7 flags an accepted race: a forget landing at the
   * same moment as a re-identify of the same name is "last call wins" --
   * whichever of `forget`/`recordSighting` reaches the store's map last
   * determines the outcome. That is accepted as-is, not solved by this
   * method; keeping this call synchronous and side-effect-free beyond
   * the store mutation + one `emitDevices()` is what keeps it from
   * making that race any wider than it already is.
   */
  requestForgetKnownRobot(name: string): void {
    this.knownRobotsStore.forget(name);
    this.emitDevices();
  }

  /**
   * Sprint 5 write gate: record a sighting in the durable
   * {@link KnownRobotsStore} iff `state` is both named and classified as
   * a robot. Called from both places `state.classification` is assigned
   * from a live banner ({@link connectAndIdentify} and
   * {@link succeedFlash}) -- never from anywhere that only *might* have
   * seen a robot.
   *
   * Deliberately no separate "banner evidence" check
   * (`classification.evidence`) alongside the `type === "robot"` check.
   * It would look like an extra layer of defense, but `classifyBanner`
   * (`@robot-console/protocol`'s `deviceType.ts`) can only ever produce
   * `type: "robot"` by way of an actual banner match -- either
   * `commonName === "robot"` (`evidence: "common-name"`) or `role`
   * hitting the robot allowlist (`evidence: "role"`). There is no path
   * that produces `type: "robot"` with `evidence: "none"` or
   * `"unrecognized"`. An extra evidence check here would therefore never
   * reject anything this `type` check doesn't already reject -- it would
   * just be dead code that someone later "fixes" back in on the mistaken
   * belief it was load-bearing. If `classifyBanner`'s contract ever
   * changes such that `type: "robot"` no longer implies real banner
   * evidence, this comment (and this gate) is the place to revisit, not
   * a silent second check bolted on beside it.
   *
   * This method touches only the in-memory write gate's *decision*; it
   * never awaits anything. `KnownRobotsStore.recordSighting` is itself
   * synchronous, debounced, and documented "never throws" -- calling it
   * here cannot stall or fail the identify path it's called from.
   */
  private maybeRecordKnownRobot(state: EndpointState): void {
    if (state.name === null) {
      return;
    }
    if (state.classification.type !== "robot") {
      return;
    }
    // Sprint 10 ticket 003: a WiFi-synthesized state has no physical
    // `device` (see that field's own doc comment) and this call site is
    // never actually reached for one anyway -- `connectAndIdentifyWifi`
    // passes `recordKnownRobot: false` to `connectAndIdentifyOverLink`,
    // so this guard is a type-level narrowing only, not a reachable
    // no-op in practice.
    if (!state.device) {
      return;
    }
    this.knownRobotsStore.recordSighting({
      name: state.name,
      usbSerial: state.device.serialNumber,
      role: state.classification.role,
    });
  }

  onDevicesChanged(listener: DevicesListener): () => void {
    this.devicesListeners.add(listener);
    return () => {
      this.devicesListeners.delete(listener);
    };
  }

  onLine(listener: LineListener): () => void {
    this.lineListeners.add(listener);
    return () => {
      this.lineListeners.delete(listener);
    };
  }

  onError(listener: RegistryErrorListener): () => void {
    this.errorListeners.add(listener);
    return () => {
      this.errorListeners.delete(listener);
    };
  }

  /** Subscribe to decoded telemetry events (sprint 009 ticket 002) --
   * see {@link TelemetryEvent}'s own doc comment. Deliberately a
   * separate subscription from {@link onLine}: telemetry never rides
   * that channel (see {@link handleInboundLine}'s own doc comment), so a
   * caller that only wants console traffic is unaffected by 20 Hz
   * telemetry, and a caller that only wants telemetry (`server.ts`) does
   * not have to filter it out of every other reply verb. */
  onTelemetry(listener: TelemetryListener): () => void {
    this.telemetryListeners.add(listener);
    return () => {
      this.telemetryListeners.delete(listener);
    };
  }

  /** Subscribe to per-phase progress events from an in-flight
   * `requestFlash` task (sprint 2). Returns an unsubscribe function. */
  onFlashProgress(listener: FlashProgressListener): () => void {
    this.flashProgressListeners.add(listener);
    return () => {
      this.flashProgressListeners.delete(listener);
    };
  }

  /** Subscribe to the terminal outcome of `requestFlash` tasks (sprint
   * 2). Returns an unsubscribe function. */
  onFlashResult(listener: FlashResultListener): () => void {
    this.flashResultListeners.add(listener);
    return () => {
      this.flashResultListeners.delete(listener);
    };
  }

  /** (Re-)open a session to an endpoint, e.g. retrying after a
   * `connect()` failure (a genuine transport error). No-op if a session
   * is already open -- note that a "connected, unresponsive" endpoint
   * (a successful `connect()` whose `identify()` resolved `null`)
   * already has `sessionOpen: true`, so this is a no-op for it too;
   * retrying `identify()` on an already-open session is ticket 004's
   * concern, not this one. Errors are reported via {@link onError} and
   * reflected in the next {@link onDevicesChanged} snapshot -- never
   * thrown to the caller.
   *
   * Keyed by `endpointId`, not a looked-up `resourceKey` -- the two are
   * always equal for every endpoint this sprint (see
   * {@link EndpointState.resourceKey}'s own doc comment), and this
   * public API only ever receives an `endpointId` from a caller that
   * has no other resource to name. Every other {@link KeyedMutex} call
   * site in this class keys the same way, for the same reason.
   *
   * `target` (OOP 2026-09-09, extended sprint 8 ticket 004) routes
   * through a relay instead: when present, `endpointId` must name a
   * `classification.type === "relay"` endpoint, and this synthesizes a
   * new robot-via-relay endpoint rather than opening a session on the
   * relay itself -- see the module doc comment's "Robot-via-relay
   * endpoints" section and {@link openRobotViaRelay}'s own doc comment
   * for the full flow. `target.robotName` omitted (but `target` itself
   * still present, e.g. `{}`) triggers the default-failover candidate
   * list instead of a single named candidate -- see
   * {@link buildDefaultFailoverCandidates}. Still keyed by `endpointId`
   * here, which is exactly the relay's own `resourceKey` (a relay is
   * plain USB, 1:1 like every other USB endpoint) -- the synthesized
   * child's *different* `resourceKey` equality is established inside
   * {@link openRobotViaRelay} itself, not here. */
  async requestOpen(
    endpointId: string,
    target?: { robotName?: string; radio?: { channel: number; group: number } },
  ): Promise<void> {
    if (target) {
      await this.mutex.run(endpointId, async () => {
        await this.openRobotViaRelay(endpointId, target);
      });
      return;
    }
    await this.mutex.run(endpointId, async () => {
      const state = this.states.get(endpointId);
      if (!state) {
        this.emitError(endpointId, `no such device: ${endpointId}`);
        return;
      }
      if (state.sessionOpen) {
        return;
      }
      // Sprint 10 ticket 003: a gated WiFi robot's plain `session-open`
      // (no `target` -- see this method's own doc comment) connects via
      // its own `WifiLinkSpec`-built link instead of a USB device's --
      // still under this same `endpointId`-keyed mutex run, no new
      // synchronization mechanism.
      if (state.wifiTarget) {
        await this.connectAndIdentifyWifi(state);
        return;
      }
      await this.connectAndIdentify(state);
    });
  }

  /** The `endpointId` of the synthesized robot-via-relay endpoint
   * currently open for `relayEndpointId`, if any -- there is at most
   * one at a time (see {@link openRobotViaRelay}'s switching behavior).
   * A linear scan of {@link states} rather than a dedicated index: this
   * sprint's scale (a handful of endpoints) makes that the simplest
   * correct thing, matching {@link rememberedRobots}'s own precedent of
   * deriving a projection from {@link states} rather than maintaining a
   * second data structure in lockstep. */
  private findSynthesizedEndpointId(relayEndpointId: string): string | undefined {
    for (const [id, state] of this.states) {
      if (state.synthesizedRelayTarget?.relayEndpointId === relayEndpointId) {
        return id;
      }
    }
    return undefined;
  }

  /** Sprint 8 ticket 004: the registry location to resolve a candidate
   * name against, for a `"relay-radio"` candidate through this local
   * USB relay -- the discovered `_mbrelay._tcp` service (if any) whose
   * mDNS instance name matches this relay's own SWD-resolved five-letter
   * name (the identity concept the whole system keys relays/robots on).
   * `undefined` when the relay's name is not yet known, or no matching
   * service was discovered -- {@link RelayConnectionCoordinator}'s
   * `resolveRobotAddress` call then falls back to its own
   * `"local-derived"` outcome, per `sprint.md`'s Solution ("registry
   * discovery is itself an mDNS lookup"). Never a network call itself --
   * purely a lookup against {@link mdnsDiscovery}'s already-live
   * snapshot. */
  private findRegistryLocationForRelay(relayState: EndpointState): RegistryLocation | undefined {
    if (relayState.name === null) {
      return undefined;
    }
    const discovered = this.mdnsDiscovery
      .current()
      .relays.find((r) => r.instanceName === relayState.name);
    if (!discovered || discovered.registryPort === undefined) {
      return undefined;
    }
    return { host: discovered.host, port: discovered.registryPort };
  }

  /** Sprint 8 ticket 004: the single-candidate list for an explicitly
   * named `target.robotName` -- always a `"relay-radio"` candidate
   * through `relayState`'s own physical port. An explicit
   * `target.radio` override bypasses registry resolution entirely (the
   * coordinator's own contract -- see `RelayConnectionCoordinator.ts`'s
   * "Explicit address override" doc section), so `registry` is omitted
   * whenever `address` is present. */
  private buildSingleCandidate(
    relayState: EndpointState,
    relayPortPath: string,
    robotName: string,
    radio: { channel: number; group: number } | undefined,
  ): ConnectionCandidate[] {
    const registry = radio === undefined ? this.findRegistryLocationForRelay(relayState) : undefined;
    return [
      {
        transport: "relay-radio",
        name: robotName,
        portPath: relayPortPath,
        resourceKey: relayState.resourceKey,
        ...(radio !== undefined ? { address: radio } : {}),
        ...(registry !== undefined ? { registry } : {}),
      },
    ];
  }

  /**
   * Sprint 8 ticket 004: the default-failover candidate list for a
   * `session-open` against a relay with no `robotName` -- every
   * remembered robot name ({@link KnownRobotsStore.list}, most
   * recently seen first, each tried as a `"relay-radio"` candidate
   * through this same physical relay), followed by every discovered
   * `_mbserial._tcp` instance name not already among those (each tried
   * directly, bypassing this relay entirely -- see
   * {@link mbserialResourceKey}'s own doc comment for why that
   * candidate's `resourceKey` is independent of `relayState`'s). Names
   * are deduplicated across both sources so the coordinator never tries
   * the same name twice. `RelayConnectionCoordinator.connect` is what
   * actually tries them in order and fails over -- this method only
   * builds the ordered list.
   */
  private buildDefaultFailoverCandidates(
    relayState: EndpointState,
    relayPortPath: string,
  ): ConnectionCandidate[] {
    const registry = this.findRegistryLocationForRelay(relayState);
    const seen = new Set<string>();
    const candidates: ConnectionCandidate[] = [];

    const remembered = this.knownRobotsStore
      .list()
      .slice()
      .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
    for (const robot of remembered) {
      if (seen.has(robot.name)) {
        continue;
      }
      seen.add(robot.name);
      candidates.push({
        transport: "relay-radio",
        name: robot.name,
        portPath: relayPortPath,
        resourceKey: relayState.resourceKey,
        ...(registry !== undefined ? { registry } : {}),
      });
    }

    for (const robot of this.mdnsDiscovery.current().robots) {
      if (seen.has(robot.instanceName)) {
        continue;
      }
      seen.add(robot.instanceName);
      candidates.push({
        transport: "mbserial",
        name: robot.instanceName,
        host: robot.host,
        port: robot.port,
        resourceKey: mbserialResourceKey(robot.instanceName),
      });
    }

    return candidates;
  }

  /**
   * `requestOpen`'s relay-routing branch (OOP 2026-09-09, restructured
   * sprint 8 ticket 004 to delegate resolve/connect/liveness/identify/
   * failover to {@link relayConnectionCoordinator}) -- see the module
   * doc comment's "Robot-via-relay endpoints" section for the full
   * rationale. Runs entirely under `relayEndpointId` (the relay's own
   * `resourceKey`, since a relay is plain USB), so it correctly queues
   * behind -- or blocks -- any concurrent
   * `requestFlash`/`requestOpen`/`requestClose` against the same
   * physical relay; no new synchronization mechanism.
   *
   * This method still owns everything physical about the relay itself
   * -- tearing down any previous synthesized child, tearing down and
   * resetting the relay's own plain USB session, the boot delay, the
   * synthesized {@link EndpointState}, {@link attachSession}, the robot
   * probes, and reopening the relay's own session on failure. It no
   * longer builds a {@link LinkSpec}, calls `createLink`/`connect`/
   * `identify` itself, or retries a missed post-reset `HELLO` -- all of
   * that (plus liveness probing and candidate failover) is
   * {@link relayConnectionCoordinator}'s job now (ticket 003). One
   * observable consequence: the relay's own console no longer echoes
   * the `!CG`/`!GO` handshake replies live during an attempt (the
   * coordinator opens/closes each candidate's link internally, with no
   * hook back to this module until a candidate actually succeeds), and
   * neither the request nor the banner text is echoed to any console
   * for the coordinator's own internal `identify()` call -- accepted,
   * documented behavior changes from the OOP version, not oversights.
   *
   * `relayState` is re-fetched from {@link states} here rather than
   * passed in by the caller, exactly like every other mutex-guarded
   * body in this class (`requestOpen`'s plain-USB branch,
   * `requestClose`) -- the caller only has a synchronous snapshot from
   * before this task's turn in the queue, which may be stale by the
   * time it actually runs.
   */
  private async openRobotViaRelay(
    relayEndpointId: string,
    target: { robotName?: string; radio?: { channel: number; group: number } },
  ): Promise<void> {
    const relayState = this.states.get(relayEndpointId);
    if (!relayState) {
      this.emitError(relayEndpointId, `no such device: ${relayEndpointId}`);
      return;
    }
    if (relayState.classification.type !== "relay") {
      this.emitError(
        relayEndpointId,
        `${relayEndpointId} is not classified as a relay -- cannot route to robot "${target.robotName ?? "(default)"}" through it`,
      );
      return;
    }
    // Sprint 10 ticket 003: `device` is optional on `EndpointState` now
    // (absent for a WiFi-synthesized endpoint) -- narrowed into a local
    // const once here so every later read in this method (which always
    // runs against a real, USB-attached relay) doesn't need its own
    // `?.`.
    const relayDevice = relayState.device;
    if (!relayDevice) {
      this.emitError(relayEndpointId, `no physical device recorded for relay ${relayEndpointId}`);
      return;
    }
    const relayPortPath = relayDevice.serialPort?.path;
    if (relayPortPath === undefined) {
      this.emitError(relayEndpointId, `no serial port available for relay ${relayEndpointId}`);
      return;
    }

    // (a) Switching robots (or simply reopening): any existing
    // synthesized child for this relay is always torn down and
    // discarded first, never retargeted in place -- Link has no
    // retarget() method (link/Link.ts's own doc comment explains why).
    const previousSynthesizedId = this.findSynthesizedEndpointId(relayEndpointId);
    if (previousSynthesizedId) {
      const previous = this.states.get(previousSynthesizedId);
      if (previous) {
        await this.teardownLink(previous);
      }
      this.states.delete(previousSynthesizedId);
      this.emitDevices();
    }

    // (b) The radio link needs the relay's own physical port -- its
    // plain USB console session (if any) must be closed first.
    await this.teardownLink(relayState);
    relayState.sessionError = undefined;
    this.emitDevices();

    // (c) A relay already in its data plane (!GO confirmed) has no
    // in-band escape (link/RelayRadioLink.ts's own doc comment) --
    // reset it via the DAPLink interface chip (which does not
    // re-enumerate USB; see resetOverSwd's own doc comment) before
    // attempting a fresh command-plane handshake. A reset failure is
    // reported but not fatal -- the relay may already be sitting in its
    // command plane (e.g. this is the very first open since attach).
    const resetResult = await this.resetOverSwdFn(relayDevice);
    if (!resetResult.ok) {
      this.emitError(
        relayEndpointId,
        `relay reset before radio handshake failed: ${resetResult.error} -- continuing, the relay may already be ready`,
      );
    }
    await delay(this.relayBootDelayMs);

    // (d) Build the candidate list: a single named candidate, or the
    // default-failover list -- see buildSingleCandidate/
    // buildDefaultFailoverCandidates's own doc comments.
    const candidates =
      target.robotName !== undefined
        ? this.buildSingleCandidate(relayState, relayPortPath, target.robotName, target.radio)
        : this.buildDefaultFailoverCandidates(relayState, relayPortPath);

    if (candidates.length === 0) {
      this.emitError(
        relayEndpointId,
        `no candidate robot names available for default failover on ${relayEndpointId} ` +
          `-- no remembered robots and no discovered _mbserial._tcp services`,
      );
      await this.connectAndIdentify(relayState);
      return;
    }

    // (e) Delegate resolution, connect, liveness probing, identify, and
    // failover entirely to the coordinator -- see this method's own doc
    // comment for what changed from the OOP version.
    const result = await this.relayConnectionCoordinator.connect(candidates);

    if (result.outcome === "exhausted") {
      const triedNames = candidates.map((c) => c.name).join(", ");
      this.emitError(
        relayEndpointId,
        `no candidate robot answered through ${relayEndpointId} (tried: ${triedNames}) -- ` +
          `gave up after ${result.failoverTrail.length} attempt(s)`,
      );
      await this.connectAndIdentify(relayState);
      return;
    }

    // (f) The coordinator connected -- synthesize a new endpoint for
    // this robot (never a mutation of the relay's own EndpointState)
    // and attach the already-open, already-identified session. The
    // winning candidate is looked up by name to recover its transport/
    // resourceKey/explicit-address -- the coordinator's result itself
    // carries none of those (see RelayConnectionCoordinator.ts's own
    // doc comment), only `name`, which is unique across this method's
    // own candidate list by construction.
    const wonCandidate = candidates.find((c) => c.name === result.name);
    const transport = wonCandidate?.transport ?? "relay-radio";
    const resourceKey =
      transport === "mbserial" ? mbserialResourceKey(result.name) : relayState.resourceKey;
    const explicitAddress =
      wonCandidate && wonCandidate.transport !== "mbserial" ? wonCandidate.address : undefined;
    const address = transport === "mbserial" ? undefined : bestEffortRadioAddress(result.name, explicitAddress);

    const synthesizedId = `${relayEndpointId}-via-${result.name}`;
    const synthesizedState: EndpointState = {
      device: relayDevice,
      endpointId: synthesizedId,
      resourceKey,
      name: result.name,
      classification: result.classification,
      sessionOpen: true,
      synthesizedRelayTarget: {
        relayEndpointId,
        robotName: result.name,
        transport,
        failoverTrail: result.failoverTrail,
        ...(address !== undefined ? { address } : {}),
        ...(result.addressSource !== undefined ? { addressSource: result.addressSource } : {}),
      },
    };
    this.states.set(synthesizedId, synthesizedState);
    this.attachSession(synthesizedState, result.link);
    synthesizedState.desyncNotified = false;
    // The coordinator reports a `null`-banner ("connected,
    // unresponsive") candidate as a successful connect too -- liveness
    // was already established by its probe, only the banner is missing
    // (see RelayConnectionCoordinator.ts's own doc comment). Detected
    // via classifyBanner's own `evidence: "none"` signature (the exact
    // value `classifyBanner(null)` always produces) rather than a raw
    // banner this module no longer has access to.
    if (result.classification.evidence === "none") {
      synthesizedState.sessionError = `no reply from ${result.name} -- is it on and listening?`;
    }
    // Sprint 5 write gate deliberately NOT applied here -- a via-relay
    // identify never records a KnownRobotsStore sighting; see the
    // module doc comment's "Robot-via-relay endpoints" section and
    // maybeRecordKnownRobot's own doc comment for the USB-only scope.
    this.emitDevices();
    this.startRobotProbes(synthesizedState);
  }

  /**
   * Close an open session to an endpoint. No-op if not open.
   *
   * OOP 2026-09-09: for a robot-via-relay synthesized endpoint (`state.synthesizedRelayTarget`
   * set -- see the module doc comment's "Robot-via-relay endpoints"
   * section), closing means the endpoint is gone entirely, not merely
   * session-closed -- unlike a plain USB endpoint, which stays listed
   * with `sessionOpen: false` after this. It is torn down and deleted
   * from {@link states}, then the relay's own plain USB console session
   * is reopened automatically (if the relay is still attached and not
   * already open), so the relay isn't left stranded with no session at
   * all. Keyed by `state.resourceKey` (the relay's own key for a
   * synthesized endpoint, `endpointId` itself for a plain one) rather
   * than `endpointId` directly, so this correctly queues behind -- or
   * blocks -- a concurrent flash/open/close on the same physical relay,
   * matching {@link openRobotViaRelay}'s own keying.
   */
  async requestClose(endpointId: string): Promise<void> {
    const stateBeforeQueueing = this.states.get(endpointId);
    const mutexKey = stateBeforeQueueing?.resourceKey ?? endpointId;
    await this.mutex.run(mutexKey, async () => {
      const state = this.states.get(endpointId);
      if (!state) {
        this.emitError(endpointId, `no such device: ${endpointId}`);
        return;
      }
      await this.teardownLink(state);
      // OOP 2026-09-10: a deliberate close is not undone by the next
      // mDNS announce -- see EndpointState.wifiAutoConnect.
      state.wifiAutoConnect = false;
      const synthesizedTarget = state.synthesizedRelayTarget;
      if (!synthesizedTarget) {
        // Sprint 10 ticket 003: a WiFi endpoint's entry stays listed
        // after a deliberate close, exactly like a plain USB endpoint --
        // the ticket's own "requestClose tears it down but the entry
        // stays listed while the advertisement stands" rule. If the
        // advertisement has *also* gone (e.g. it went `down` while this
        // session was open, which `syncWifiEndpoints` deliberately left
        // alone -- see that method's own doc comment), this close is the
        // next opportunity to notice and drop the now-stale entry rather
        // than leaving it listed indefinitely with nothing to
        // reconnect it on the next mDNS change.
        if (state.wifiTarget && state.name !== null && !this.isWifiRobotGated(state.name)) {
          this.states.delete(endpointId);
        }
        this.emitDevices();
        return;
      }
      this.states.delete(endpointId);
      this.emitDevices();
      const relayState = this.states.get(synthesizedTarget.relayEndpointId);
      if (relayState && !relayState.sessionOpen) {
        await this.connectAndIdentify(relayState);
      }
    });
  }

  /**
   * Send a line to an endpoint's open session. Reports (via {@link onError})
   * rather than throws if the endpoint is unknown, has no open session,
   * or the underlying write itself fails. On success, also emits the
   * sent line back out via {@link onLine} (`direction: "tx"`) so every
   * connected client's console view reflects it, not just the sender.
   *
   * This is a raw, undisciplined text path deliberately -- unlike
   * {@link sendCommand}, whatever text is typed here goes to the wire
   * verbatim, bypassing `Session` entirely (no id, no pending
   * bookkeeping). `HELLO` is the one verb that cannot be allowed through
   * that door: it silently resets the robot's sequence state with none
   * of the host-side bookkeeping reset to match, which is exactly the
   * silent desync a real bug report traced to a lowercase `hello` typed
   * here (case folded before comparison for the same reason
   * `sendCommand`'s own HELLO check does -- see this module's own OOP
   * fix notes). Detected here as the raw line's own leading token,
   * case-insensitively, and routed through {@link resyncSession} instead
   * of {@link Link.sendLine} -- any trailing text on the line is
   * ignored, matching `HELLO`'s own no-fields wire shape.
   */
  async sendLine(endpointId: string, line: string): Promise<void> {
    await this.mutex.run(endpointId, async () => {
      const state = this.states.get(endpointId);
      if (!state?.sessionOpen || !state.session) {
        this.emitError(endpointId, `device ${endpointId} has no open link`);
        return;
      }
      const verb = line.trim().split(/\s+/)[0];
      if (verb !== undefined && verb.toUpperCase() === "HELLO") {
        await this.resyncSession(state, endpointId);
        return;
      }
      try {
        state.session.link.sendLine(line);
        this.emitLine(endpointId, "tx", line);
      } catch (error) {
        this.emitError(endpointId, error instanceof Error ? error.message : String(error));
      }
    });
  }

  /**
   * Send one verb (with optional fields) to an endpoint's open session,
   * dispatching through `@robot-console/protocol`'s `Session` rather
   * than {@link sendLine}'s raw, undisciplined text path (sprint 6
   * ticket 003 -- see the module doc comment's own "Command routing and
   * sequencing-state projection" section, and `wsMessages.ts`'s "Sprint
   * 6 addition" doc comment). Runs through the same per-endpoint
   * {@link KeyedMutex} as {@link sendLine}/{@link requestOpen}/
   * {@link requestClose}/{@link requestFlash} -- no new synchronization
   * primitive.
   *
   * Verb classification is never re-derived here -- `isSequencedVerb`
   * (`@robot-console/protocol`'s own allowlist) is the single source of
   * truth, and it folds case before checking membership, so a caller-
   * supplied verb spelling can never pick a different code path just by
   * arriving in a different case (see that function's own doc comment):
   *
   * - `"HELLO"` (matched case-insensitively, for the same reason) is
   *   routed to {@link resyncSession} rather than reaching `Session` in
   *   either form -- see that method's own doc comment. This used to be
   *   an outright refusal ("close and reopen the session instead"), but
   *   `Link.identify()` already IS the correct, disciplined way to
   *   (re)send `HELLO`, and refusing it left a genuinely desynced session
   *   with no in-band recovery at all.
   * - Every verb `isSequencedVerb` recognizes (`GET`, `SET`, `TLM`,
   *   `STOP`, `RUN`, `WHEELS_X`, `WHEELS_V`, `MOVE_X`, `MOVE_V`,
   *   `GO_TO_R`, `GO_TO_W`) dispatches to `Link.sendCommand` (id-assigned
   *   via `Session.send`, which also folds and encodes the verb
   *   canonically uppercase regardless of the case this was called
   *   with).
   * - Everything else (`STATUS`, `PING`, `ESTOP`, ...) dispatches to
   *   `Link.sendUnsequenced` -- `STATUS` included, despite sitting next
   *   to the sequenced verbs on the robot page (protocol.md's verb
   *   table is the authority, not this sprint's looser roadmap
   *   phrasing).
   *
   * Reports (via {@link emitError}), rather than throws, for an unknown
   * endpoint or no open session (matching {@link sendLine}'s own
   * pattern exactly), and for a thrown `SessionError`/`CodecError` from
   * either dispatch call -- mirrors {@link sendLine}'s existing
   * try/catch exactly, so a malformed verb or illegal field can never
   * crash the process.
   *
   * Deliberately does **not** call {@link emitDevices} on a successful
   * send: {@link toEntry} reads `pendingCount`/`seq` fresh off the open
   * session on every {@link snapshot} call, so a caller reading the very
   * next snapshot already sees the updated count with no event needed --
   * only a genuine state change (an ack/nack arriving, subscribed in
   * {@link connectAndIdentify}/{@link reidentifyAfterFlash}) triggers a
   * broadcast. A burst of held-drive-control sends (see this ticket's
   * own pacing test) would otherwise storm every connected client with
   * one snapshot per send, on top of the pacing already governing the
   * writes themselves. `resyncSession` is the one exception -- it calls
   * {@link emitDevices} itself once the resync settles, since a `HELLO`
   * always changes `seq`/`pendingCount`.
   */
  async sendCommand(endpointId: string, verb: string, fields: readonly WireField[] = []): Promise<void> {
    await this.mutex.run(endpointId, async () => {
      const state = this.states.get(endpointId);
      if (!state?.sessionOpen || !state.session) {
        this.emitError(endpointId, `device ${endpointId} has no open link`);
        return;
      }
      if (verb.toUpperCase() === "HELLO") {
        await this.resyncSession(state, endpointId);
        return;
      }
      if (verb.toUpperCase() === "FUNCS") {
        this.dispatchFuncs(state);
        return;
      }
      try {
        // OOP 2026-09-09: echo what was actually written (the encoded
        // line, id included) back through onLine as a `tx` line, exactly
        // as sendLine does -- button-sent commands used to leave no
        // trace in the console, only their replies.
        const line = isSequencedVerb(verb)
          ? state.session.link.sendCommand(verb, fields)
          : state.session.link.sendUnsequenced(verb, fields);
        this.emitLine(endpointId, "tx", line.replace(/\n$/, ""));
      } catch (error) {
        this.emitError(endpointId, error instanceof Error ? error.message : String(error));
      }
    });
  }

  /**
   * Flash `source` onto an endpoint: for `source.kind === "release"`,
   * orchestrates `config.ts` (which source) -> `releases.ts`
   * (fetch+verify the hex); for `"local-hex"`, retrieves the bytes a
   * prior local-hex upload already verified (see
   * {@link DeviceRegistryOptions.consumeUpload}) -- either way -> then
   * `flash.ts` (write it), run as one more task through the same
   * per-endpoint {@link KeyedMutex} as {@link requestOpen}/
   * {@link requestClose}/{@link sendLine} -- no new synchronization
   * primitive (see the module doc comment's "Flash flow" section). An
   * unknown `endpointId` is reported via {@link onError}, matching
   * {@link requestOpen}'s own handling -- never thrown to the caller.
   *
   * ## Mutex scope: the whole task, including `releases.ts`'s network fetch
   *
   * This is a deliberate choice, not an oversight. The alternative --
   * release the mutex for the (slow, network-bound) fetch+verify step
   * and re-acquire it only for teardown/write/reopen -- would open a
   * window in which a `requestOpen`/`requestClose`/`sendLine` (or a
   * second `requestFlash`) could run against *this same device* in
   * between. When this task resumed and called {@link teardownLink}, it
   * would then be racing whatever that interleaved operation left the
   * link in -- reintroducing, for a destructive flash, exactly the OS
   * port-lock race described in
   * `port-lock-contention-between-identify-and-user-open.md`, except
   * now the loser of the race is a firmware write instead of a benign
   * identify retry. Holding the mutex for the fetch's duration instead
   * costs one thing: `requestOpen`/`requestClose`/`sendLine`/name
   * resolution on *this one device* (never other devices -- the mutex
   * is per-resource-key, one per device this sprint) queue behind the
   * fetch until it completes. In practice this costs little: the flash
   * buttons only ever render for a device that has already failed to
   * identify (`role: null`, `sessionError` set -- see `sprint.md`'s
   * SUC-001 precondition), so there is normally no open session or
   * console traffic on this device for the fetch to actually block.
   *
   * The fetch itself has no timeout of its own -- `releases.ts`'s
   * network call can, in principle, hang indefinitely while holding
   * this device's mutex slot. Harmless this sprint (one USB device per
   * key, and a wedged fetch only ever blocks that one device); flagged
   * here rather than fixed because sprint 7 shares this same mutex with
   * TCP relay links, where a wedged connect could make a shared
   * resource permanently unresponsive to every endpoint behind it --
   * see this ticket's own notes and `sprint.md`'s Design Rationale for
   * why a per-task timeout is deferred to that sprint rather than added
   * speculatively here.
   *
   * ## Failure recovery
   *
   * A failure at any stage -- an unconfigured firmware source, a
   * `releases.ts` failure, a `flash.ts` failure, or an unexpected throw
   * from any injected step -- clears `flashStatus` and reports a
   * `flash-result` `status: "error"` event before returning. `flashStatus`
   * is never left set past the end of this task, and the registry never
   * believes a session is open once {@link teardownLink} has already
   * closed it: a failure after teardown simply leaves `sessionOpen:
   * false` (as teardown itself sets), the same state {@link requestClose}
   * leaves behind, ready for a future {@link requestOpen} retry.
   */
  async requestFlash(endpointId: string, source: FirmwareSourceRef): Promise<void> {
    await this.mutex.run(endpointId, async () => {
      const state = this.states.get(endpointId);
      if (!state) {
        this.emitError(endpointId, `no such device: ${endpointId}`);
        return;
      }
      await this.runFlash(state, source);
    });
  }

  /** The mutex-guarded body of {@link requestFlash} -- see that method's
   * doc comment for the mutex-scope and failure-recovery rationale, and
   * the module doc comment's "Flash flow" section for the `source.kind`
   * branch this method makes exactly once, to obtain `hexBuffer` --
   * every step from `flashFn` onward is identical for both kinds. */
  private async runFlash(state: EndpointState, source: FirmwareSourceRef): Promise<void> {
    const endpointId = state.endpointId;
    // Set at the very start (before teardown even) so a client that
    // observes the very next snapshot already sees flashStatus, per the
    // ticket's "set at the start of the flash task" requirement. There
    // is no dedicated FlashPhase for "tearing down the old link", so
    // this first phase is reported as "fetching" for a release source
    // (the next real progress event, "verifying", replaces it once
    // releases.ts resolves) -- same best-effort phase-reporting
    // precedent flash.ts's own doc comment already accepts for DAPjs's
    // coarser event surface. A local-hex source has nothing to fetch (the
    // bytes already arrived over the socket and were sha256-verified at
    // upload time), so it starts directly at "verifying" instead.
    this.setFlashPhase(state, endpointId, source, source.kind === "release" ? "fetching" : "verifying");

    // Sprint 10 ticket 003: `device` is optional on `EndpointState` now
    // (absent for a WiFi-synthesized endpoint, which has no physical
    // board `flash.ts` could ever write to) -- narrowed into a local
    // const once here so `flashFn` below reads a real `DaplinkDevice`,
    // never `undefined`. Flashing was never reachable for a WiFi
    // endpoint before this ticket either (no such endpoint existed);
    // this guard just makes the now-optional type explicit rather than
    // relying on a caller to never ask.
    const device = state.device;
    if (!device) {
      this.failFlash(state, endpointId, source, "flashing requires a directly attached USB device");
      return;
    }

    try {
      // OOP 2026-09-09: if this is a relay with an open robot-via-relay
      // synthesized child (see the module doc comment's "Robot-via-relay
      // endpoints" section), that child shares this relay's own
      // resourceKey -- requestFlash already queues behind it via the
      // shared KeyedMutex -- but its session also holds the same
      // physical port a flash needs, so it must be torn down and
      // removed first, not just left dangling once the relay itself is
      // reflashed out from under it.
      const synthesizedId = this.findSynthesizedEndpointId(state.endpointId);
      if (synthesizedId) {
        const synthesized = this.states.get(synthesizedId);
        if (synthesized) {
          await this.teardownLink(synthesized);
        }
        this.states.delete(synthesizedId);
      }

      // Tear down any open link before touching config/network/SWD --
      // flash.ts's DAPjs session must never contend with an open serial
      // port over the same physical board (see this class's own
      // requestFlash doc comment, and sprint.md's Design Rationale). In
      // the common case (a failed-identify device) there is nothing
      // open here; this call is defensive for any other caller.
      await this.teardownLink(state);
      this.emitDevices();

      // The one place this method branches on source.kind (see this
      // method's own doc comment) -- everything below, from flashFn
      // onward, is identical for both kinds.
      let hexBuffer: Buffer;
      if (source.kind === "release") {
        const firmwareSource = this.getFirmwareConfigFn()[source.firmware];
        if (!firmwareSource) {
          this.failFlash(state, endpointId, source, `no firmware source configured for "${source.firmware}"`);
          return;
        }

        const resolved = await this.resolveReleaseFn(firmwareSource);
        if ("reason" in resolved) {
          this.failFlash(state, endpointId, source, resolved.message);
          return;
        }

        // fetchAndVerifyHex both downloads and sha256-verifies in one
        // call (releases.ts has no seam between the two) -- "verifying"
        // is reported for the whole call, same best-effort phase mapping
        // as flash.ts's own erase/write/reset reporting.
        this.setFlashPhase(state, endpointId, source, "verifying");
        const fetched = await this.fetchAndVerifyHexFn(resolved);
        if ("error" in fetched) {
          this.failFlash(state, endpointId, source, fetched.error);
          return;
        }
        hexBuffer = fetched.hex;
      } else {
        // "local-hex": the bytes were already uploaded and sha256-verified
        // by localHexUpload.ts's receiveFrame -- consumeUpload just hands
        // them over (exactly once). An unknown/expired/already-consumed
        // uploadId is a flash-start error, never a crash -- the same
        // "failure is a value" shape as the release branch above.
        const uploaded = this.consumeUploadFn(source.uploadId);
        if (uploaded === undefined) {
          this.failFlash(
            state,
            endpointId,
            source,
            `no pending local-hex upload found for id ${source.uploadId} -- it may have expired, ` +
              `already been used, or never completed the upload handshake`,
          );
          return;
        }
        hexBuffer = uploaded;
      }

      const onProgress = (phase: FlashPhase) => {
        this.setFlashPhase(state, endpointId, source, phase);
      };
      const outcome = await this.flashFn(device, hexBuffer.toString("utf-8"), onProgress);
      if (outcome.status === "error") {
        this.failFlash(state, endpointId, source, outcome.error);
        return;
      }

      // The write succeeded. Re-acquire whatever object is currently
      // live under this id rather than continuing to write through
      // `state` -- a board that re-enumerated during the write (see
      // this class's own "Orphaned state during a flash" doc comment)
      // has already had its state object replaced by now, and
      // re-enumeration here is the *expected* outcome of a successful
      // flash, not a failure that should make {@link isLive} silently
      // drop the reidentify tail forever.
      const liveState = this.states.get(endpointId);
      if (!liveState) {
        // Gone entirely and never came back by the time the write
        // returned -- nothing left to attribute flashStatus to, but the
        // write itself succeeded and the client is still waiting for a
        // terminal result.
        this.emitFlashResult(endpointId, source, "ok", undefined, classifyBanner(null), null, "timeout");
        return;
      }
      await this.reidentifyAfterFlash(liveState, endpointId, source);
    } catch (error) {
      // Defense in depth: every injected step here (config.ts,
      // releases.ts, flash.ts) documents "never throws", but a flash
      // must not leave flashStatus stuck even if that contract is ever
      // violated -- by a future change, or by a test's own fake.
      this.failFlash(state, endpointId, source, error instanceof Error ? error.message : String(error));
    }
  }

  /** Whether `state` is still the live object registered under its own
   * endpoint id -- the same staleness check {@link resolveNameAndOpen}/
   * {@link connectAndIdentify} already make after every `await`. A
   * board that re-enumerates mid-flash is reported by the watcher as
   * remove+add, which can destroy and recreate this endpoint's state
   * object while {@link runFlash} still holds a reference to the old
   * one; every write {@link runFlash} makes checks this first. */
  private isLive(state: EndpointState): boolean {
    return this.states.get(state.endpointId) === state;
  }

  /** Advance an in-flight flash to `phase`: update `flashStatus` (for a
   * `"release"` source only -- see the module doc comment's "flashStatus
   * gap for local-hex" note; a `"local-hex"` source leaves `flashStatus`
   * `undefined` throughout), emit a {@link onFlashProgress} event
   * (carrying the full `source` either way), and emit an updated device
   * snapshot so a client that reconnects mid-flash sees the current
   * phase. A no-op, per {@link isLive}, if `state` has been orphaned. */
  private setFlashPhase(state: EndpointState, endpointId: string, source: FirmwareSourceRef, phase: FlashPhase): void {
    if (!this.isLive(state)) {
      return;
    }
    state.flashStatus = source.kind === "release" ? { firmware: source.firmware, phase } : undefined;
    this.emitFlashProgress(endpointId, source, phase);
    this.emitDevices();
  }

  /** End an in-flight flash in failure: clear `flashStatus` and emit a
   * `flash-result` `status: "error"` event plus an updated snapshot. A
   * no-op, per {@link isLive}, if `state` has been orphaned. */
  private failFlash(state: EndpointState, endpointId: string, source: FirmwareSourceRef, message: string): void {
    if (!this.isLive(state)) {
      return;
    }
    state.flashStatus = undefined;
    this.emitFlashResult(endpointId, source, "error", message);
    this.emitDevices();
  }

  /** End an in-flight flash in success -- clear `flashStatus`, apply the
   * post-flash `classification`, and emit a `flash-result` `status:
   * "ok"` event (carrying `classification`/`name`, plus `reidentify:
   * "timeout"` if the board never re-announced) plus an updated
   * snapshot. A no-op, per {@link isLive}, if `state` has been
   * orphaned -- see {@link reidentifyAfterFlash}'s own doc comment for
   * why that can still happen even this late. */
  private succeedFlash(
    state: EndpointState,
    endpointId: string,
    source: FirmwareSourceRef,
    classification: DeviceClassification,
    name: string | null,
    reidentify?: "timeout",
  ): void {
    if (!this.isLive(state)) {
      return;
    }
    state.flashStatus = undefined;
    state.classification = classification;
    // Sprint 5 write gate: a flash can turn an unknown device into a
    // correctly-classified robot (e.g. flashing robot firmware onto a
    // blank board) -- the post-flash reidentify is exactly as much "a
    // successful USB identify with banner evidence" as the plain attach
    // flow's own call site below, so it gates enrolment the same way.
    this.maybeRecordKnownRobot(state);
    if (reidentify) {
      this.emitFlashResult(endpointId, source, "ok", undefined, classification, name, reidentify);
    } else {
      this.emitFlashResult(endpointId, source, "ok", undefined, classification, name);
    }
    this.emitDevices();
  }

  /**
   * Reconnect and re-identify `state` after a successful flash write,
   * then emit the terminal `flash-result` -- the fix for the roadmap
   * issue's "finding 5" post-flash type flicker (see this class's own
   * "Post-flash reidentify sequencing" doc comment). Structurally the
   * same connect()-then-identify() shape as {@link connectAndIdentify},
   * with two differences: `identify()` is bounded by this registry's
   * (longer) `reidentifyTimeoutMs` via {@link identifyWithTimeout}
   * rather than whatever timeout the `Link` implementation defaults to,
   * and a `null` result is retried exactly once before giving up.
   *
   * A `connect()` failure here is reported the same way
   * `connectAndIdentify`'s own failure branch does (`sessionError` set,
   * no session) -- but unlike that method, this always still ends in a
   * `flash-result`, `status: "ok"`, `reidentify: "timeout"`: the flash
   * write already succeeded, so a failure to *reconnect* afterward is
   * never reported as a flash failure, per the ticket's own "never as a
   * failure" requirement.
   *
   * Known gap: if `state` is a freshly re-added object (the board
   * re-enumerated during the write -- see the module doc comment's
   * "Orphaned state during a flash" section), {@link handleChange}
   * already queued its own {@link resolveNameAndOpen} for it, behind
   * this very task's mutex slot. That queued task runs immediately
   * after this one returns and will attempt its own `connect()`/
   * `identify()` against the same physical port this method just
   * opened -- on real hardware the second `connect()` typically fails
   * (the port is still held open by the session this method
   * established), which then overwrites the session/classification
   * this method just set with a `sessionError`. This is a narrower,
   * separate race from the two defects this ticket fixes; flagged here
   * rather than fixed because closing it needs `handleChange` to know
   * a flash is in flight for the resource key, which is out of this
   * ticket's scope.
   */
  private async reidentifyAfterFlash(
    state: EndpointState,
    endpointId: string,
    source: FirmwareSourceRef,
  ): Promise<void> {
    this.setFlashPhase(state, endpointId, source, "reidentifying");

    const portPath = state.device?.serialPort?.path;
    if (!portPath) {
      this.succeedFlash(state, endpointId, source, classifyBanner(null), state.name, "timeout");
      return;
    }

    const link = this.createLink({ transport: "usb", resourceKey: state.resourceKey, portPath });

    try {
      await link.connect();
    } catch (error) {
      // A genuine transport-level failure reconnecting post-flash --
      // degrade exactly like connectAndIdentify's own connect() failure
      // branch, except the terminal report here is always "ok" (see
      // this method's own doc comment).
      if (this.isLive(state)) {
        state.sessionOpen = false;
        state.session = undefined;
        state.sessionError = error instanceof Error ? error.message : String(error);
      }
      await link.close().catch(() => {});
      this.succeedFlash(state, endpointId, source, classifyBanner(null), state.name, "timeout");
      return;
    }

    if (!this.isLive(state)) {
      // Orphaned while connecting -- don't leak the link we just opened.
      await link.close().catch(() => {});
      return;
    }

    state.session = {
      link,
      unsubscribeLine: link.onLine((decoded) => {
        this.handleInboundLine(state, decoded);
      }),
      // OOP 2026-09-09: non-protocol text (a relay's `#` command-plane
      // replies, echoes, other dialects) is shown verbatim -- see
      // LineRouter's onUnrouted.
      unsubscribeRawLine: link.onRawLine((raw) => {
        this.emitLine(state.endpointId, "rx", raw);
      }),
      // Sprint 6 ticket 003: re-emit a snapshot on every ack/nack so a
      // corrected seq/pendingCount reaches connected clients promptly --
      // see the module doc comment's own "Command routing and
      // sequencing-state projection" section for why this is bounded to
      // ack/nack events, not fired per send or per inbound line.
      // OOP fix (defect 1): also surface a desynced nack as a one-time
      // "resync needed" error -- see reportDesyncIfNeeded's own doc
      // comment.
      unsubscribeAckNack: link.onAckNack((event) => {
        this.emitDevices();
        this.reportDesyncIfNeeded(state, event);
      }),
      unsubscribeError: link.onError((err) => {
        this.handleLinkError(state, err);
      }),
    };
    state.sessionOpen = true;
    state.sessionError = undefined;
    state.desyncNotified = false;
    this.emitDevices();

    // One retry on a null identify, per the ticket's acceptance
    // criteria: identify() is called at most twice total.
    this.emitLine(state.endpointId, "tx", "HELLO");
    let banner = await identifyWithTimeout(link, this.reidentifyTimeoutMs);
    if (banner === null) {
      this.emitLine(state.endpointId, "tx", "HELLO");
      banner = await identifyWithTimeout(link, this.reidentifyTimeoutMs);
    }

    if (!this.isLive(state)) {
      // Orphaned while identifying -- teardownLink (already run for the
      // now-orphaned state via the detach path) owns closing it.
      return;
    }
    this.echoBanner(state, banner);

    const classification = classifyBanner(banner);
    if (banner) {
      this.succeedFlash(state, endpointId, source, classification, state.name);
      this.startRobotProbes(state);
    } else {
      this.succeedFlash(state, endpointId, source, classification, state.name, "timeout");
    }
  }

  // ---- watcher-driven attach/detach ------------------------------------

  private handleChange(event: DeviceChangeEvent): void {
    // Capture the *current* state object for each removed device before
    // any added device in the same diff (a modified device shows up as
    // a remove+add pair) has a chance to overwrite the map entry -- see
    // the module doc comment.
    for (const device of event.removed) {
      const endpointId = usbEndpointId(device.serialNumber);
      const state = this.states.get(endpointId);
      // OOP 2026-09-09: capture this too, before any later step in this
      // diff gets a chance to change it -- same "capture before the
      // mutex turn actually runs" precedent as `state` itself (see the
      // module doc comment's Detach flow). A removed relay's synthesized
      // robot-via-relay child (if any) shares its resourceKey and must
      // be torn down and discarded right alongside it -- see the module
      // doc comment's "Robot-via-relay endpoints" section.
      const synthesizedId = this.findSynthesizedEndpointId(endpointId);
      void this.mutex.run(endpointId, async () => {
        if (synthesizedId) {
          const synthesized = this.states.get(synthesizedId);
          if (synthesized) {
            await this.teardownLink(synthesized).catch(() => {});
          }
          if (this.states.get(synthesizedId) === synthesized) {
            this.states.delete(synthesizedId);
          }
        }
        if (state) {
          await this.teardownLink(state).catch(() => {});
        }
        if (this.states.get(endpointId) === state) {
          this.states.delete(endpointId);
        }
        this.emitDevices();
      });
    }

    for (const device of event.added) {
      const endpointId = usbEndpointId(device.serialNumber);
      const state: EndpointState = {
        device,
        endpointId,
        // USB is 1:1 between endpoint and physical resource this sprint
        // -- see EndpointState.resourceKey's own doc comment.
        resourceKey: endpointId,
        name: null,
        classification: classifyBanner(null),
        sessionOpen: false,
      };
      this.states.set(endpointId, state);
      void this.mutex.run(endpointId, async () => {
        await this.resolveNameAndOpen(state);
      });
    }

    // Emit once after scheduling the whole diff, in addition to each
    // mutexed step's own emit below -- clients see "attached, name
    // pending" immediately instead of waiting for SWD/serial I/O.
    this.emitDevices();
  }

  private async resolveNameAndOpen(state: EndpointState): Promise<void> {
    // Sprint 10 ticket 003: `device` is optional on `EndpointState` now,
    // but this method is only ever queued from `handleChange`'s USB
    // attach path, against a state constructed with a real device --
    // this guard is a type-level narrowing only (a WiFi-synthesized
    // state never reaches this method at all; see
    // `connectAndIdentifyWifi` for its own connect path).
    if (!state.device) {
      return;
    }
    const result = await this.resolveName(state.device);
    // The device may have been removed (and even re-added under a new
    // state object) while the SWD read was in flight; only apply the
    // result if this state object is still the live one.
    if (this.states.get(state.endpointId) !== state) {
      return;
    }
    if (result.status === "named") {
      state.name = result.name;
      state.nameError = undefined;
    } else {
      state.name = null;
      state.nameError = { reason: result.reason, message: result.error };
    }
    this.emitDevices();

    await this.connectAndIdentify(state);
  }

  /**
   * Connect a link to `state`'s device and identify it -- the
   * `Link.connect()` + `Link.identify()` two-step replacing the old
   * one-shot `UsbSerialLink.open()` (sprint 4 ticket 002). See this
   * module's own "Attach flow" doc comment for the two failure modes
   * this distinguishes.
   *
   * `connect()` and `identify()` are awaited as two separate steps
   * (not one combined try/catch) specifically so a `connect()` failure
   * -- a genuine transport error -- and an `identify()` `null` --
   * "connected, unresponsive", not an error -- update state
   * differently, per this module's own doc comment.
   */
  /** Attach `link`'s line/rawLine/ackNack/error subscriptions onto
   * `state.session` (OOP 2026-09-09) -- the exact block
   * {@link connectAndIdentify} used to build inline, extracted so
   * {@link openRobotViaRelay}'s relay-target flow can share it verbatim
   * rather than duplicating it. Deliberately does not touch
   * `sessionOpen`/`sessionError`/`desyncNotified` -- every caller sets
   * those itself immediately after, exactly as `connectAndIdentify` did
   * before this was extracted (a via-relay open sets `sessionOpen` at
   * state-construction time instead, since by the point this runs its
   * `connect()`/handshake has already succeeded). */
  private attachSession(state: EndpointState, link: Link): void {
    state.session = {
      link,
      unsubscribeLine: link.onLine((decoded) => {
        this.handleInboundLine(state, decoded);
      }),
      // OOP 2026-09-09: non-protocol text (a relay's `#` command-plane
      // replies, echoes, other dialects) is shown verbatim -- see
      // LineRouter's onUnrouted.
      unsubscribeRawLine: link.onRawLine((raw) => {
        this.emitLine(state.endpointId, "rx", raw);
      }),
      // Sprint 6 ticket 003: re-emit a snapshot on every ack/nack so a
      // corrected seq/pendingCount reaches connected clients promptly --
      // see the module doc comment's own "Command routing and
      // sequencing-state projection" section for why this is bounded to
      // ack/nack events, not fired per send or per inbound line.
      // OOP fix (defect 1): also surface a desynced nack as a one-time
      // "resync needed" error -- see reportDesyncIfNeeded's own doc
      // comment.
      unsubscribeAckNack: link.onAckNack((event) => {
        this.emitDevices();
        this.reportDesyncIfNeeded(state, event);
      }),
      unsubscribeError: link.onError((err) => {
        this.handleLinkError(state, err);
      }),
    };
  }

  private async connectAndIdentify(state: EndpointState): Promise<void> {
    const portPath = state.device?.serialPort?.path;
    if (!portPath) {
      state.sessionError = "no serial port available for this device";
      this.emitDevices();
      return;
    }

    const link = this.createLink({ transport: "usb", resourceKey: state.resourceKey, portPath });
    await this.connectAndIdentifyOverLink(state, link, { recordKnownRobot: true });
  }

  /**
   * Sprint 10 ticket 003: connect+identify a gated WiFi robot the same
   * way {@link connectAndIdentify} connects a USB device -- built from
   * {@link EndpointState.wifiTarget}'s `host`/`port` (ticket 002's
   * `WifiLinkSpec`) instead of a USB device's serial port path, and
   * reusing {@link MbserialLink} verbatim via {@link defaultLinkFactory}
   * (this sprint's Design Rationale, "TCP over UDP, reusing
   * `MbserialLink` unchanged"). `recordKnownRobot: false` is the one
   * behavioral difference from the USB path -- see
   * {@link maybeRecordKnownRobot}'s own doc comment: the durable roster
   * stays USB-sighting-only, and a robot only ever reaches this method
   * because it was already in the roster (the gate applied in
   * {@link syncWifiEndpoints}), so there is nothing new to enroll here
   * anyway.
   */
  private async connectAndIdentifyWifi(state: EndpointState): Promise<void> {
    const target = state.wifiTarget;
    if (!target) {
      this.emitError(state.endpointId, `no WiFi address recorded for ${state.endpointId}`);
      return;
    }
    if (state.session) {
      // A dropped link (handleLinkError) leaves the dead session in
      // place -- dispose of it before attaching a fresh one, so its
      // subscriptions are not left dangling alongside the new link's.
      await this.teardownLink(state);
    }
    const link = this.createLink({ transport: "wifi", host: target.host, port: target.port });
    await this.connectAndIdentifyOverLink(state, link, { recordKnownRobot: false });
  }

  /**
   * Sprint 10 ticket 003: the connect()/identify() body {@link
   * connectAndIdentify} used to run inline against a USB `Link` it built
   * itself -- extracted, unchanged in behavior, so
   * {@link connectAndIdentifyWifi} can share it verbatim against a WiFi
   * `Link` instead, mirroring {@link attachSession}'s own extraction
   * precedent (see that method's doc comment). `connect()` and
   * `identify()` are still awaited as two separate steps (not one
   * combined try/catch) specifically so a `connect()` failure -- a
   * genuine transport error -- and an `identify()` `null` -- "connected,
   * unresponsive", not an error -- update state differently, per this
   * module's own "Attach flow" doc comment. `options.recordKnownRobot`
   * is the only behavioral fork between callers -- see
   * {@link maybeRecordKnownRobot}'s own doc comment for why a WiFi
   * identify never writes the durable roster.
   */
  private async connectAndIdentifyOverLink(
    state: EndpointState,
    link: Link,
    options: { recordKnownRobot: boolean },
  ): Promise<void> {
    try {
      await link.connect();
    } catch (error) {
      // A genuine transport-level failure (the port itself refusing to
      // open, or erroring before it does) -- today's error state:
      // sessionOpen: false, sessionError set. Degrade gracefully: the
      // device stays listed, named, with role still null and this
      // reason recorded.
      state.sessionOpen = false;
      state.session = undefined;
      state.sessionError = error instanceof Error ? error.message : String(error);
      // Close the link we just created before giving up on it --
      // best-effort, since a failed close must not mask the sessionError
      // already recorded above (same precedent as teardownLink's and
      // flash.ts's own cleanup). Whether the underlying transport is
      // actually open at the OS level at this point depends on where
      // connect() failed; closing unconditionally is what
      // port-lock-contention-between-identify-and-user-open.md's
      // partial sprint-003 fix already established as the safe default
      // here.
      await link.close().catch(() => {});
      this.emitDevices();
      return;
    }

    if (!this.isLive(state)) {
      // Removed while connecting -- don't leak the link we just opened.
      await link.close().catch(() => {});
      return;
    }

    // The transport is up. Keep this link -- and only this link -- for
    // the endpoint's entire lifetime from here on: this is the
    // port-lock-contention fix (see this module's own doc comment and
    // port-lock-contention-between-identify-and-user-open.md). Unlike
    // the old open()-throws shape, a failed/timed-out identify() below
    // does NOT close this link or fall into the catch above -- there is
    // no repeated open/close cycle on this physical port for the OS to
    // contend over, whether identify() succeeds, comes back null, or is
    // retried later.
    this.attachSession(state, link);
    state.sessionOpen = true;
    state.sessionError = undefined;
    state.desyncNotified = false;
    this.emitDevices();

    // identify() never throws -- a silent board (never replies to
    // HELLO) resolves null here rather than hanging or rejecting; the
    // session above is already established either way.
    // OOP 2026-09-09: the HELLO and its banner reply are echoed into
    // the console like any other traffic -- identify() consumes the
    // banner itself (it never reaches the link's line listeners), so
    // without this the session's first exchange was invisible.
    this.emitLine(state.endpointId, "tx", "HELLO");
    const banner = await link.identify();
    if (!this.isLive(state)) {
      // Removed while identifying -- teardownLink (already run for the
      // now-orphaned state via the detach path) owns closing it.
      return;
    }
    this.echoBanner(state, banner);
    // classification (and the role/type it carries) is derived from
    // this banner alone -- see EndpointState's own doc comment for why
    // there is no separate `role` field to keep in sync here.
    // classifyBanner never throws (pure, no I/O) and accepts `null`
    // directly: a null banner classifies exactly like "no banner yet"
    // (type "unknown", evidence "none") -- a normal state, not an
    // error.
    state.classification = classifyBanner(banner);
    // Sprint 5 write gate -- see maybeRecordKnownRobot's own doc
    // comment for the write-gate rationale (robot + named, no separate
    // evidence check). Only a robot identified over its own USB
    // connection reaches this call site with `recordKnownRobot: true`:
    // a relay, an unknown/unidentified device, or a nameless device all
    // fall out of the gate automatically; a WiFi identify
    // (`recordKnownRobot: false`) never reaches it at all.
    if (options.recordKnownRobot) {
      this.maybeRecordKnownRobot(state);
    }
    this.emitDevices();
    this.startRobotProbes(state);
  }

  /**
   * OOP 2026-09-09: everything inbound on an open session funnels
   * through here. Every line is still echoed to {@link onLine} (a
   * console must see all traffic); on top of that, three reply verbs
   * are harvested into per-endpoint state for {@link toEntry}:
   *   - `status` -> {@link EndpointState.robotStatus} (parsed via
   *     {@link parseStatusReply}); tagged `origin: "poll"` when it
   *     answers the host's own poll.
   *   - `estop` (the `ESTOP` verb's own reply) -> `robotStatus.estopped`
   *     flips `true` immediately, ahead of the next poll confirming it.
   *   - `funcs <name> [signature]` -> appended to
   *     {@link EndpointState.functions}.
   *
   * Sprint 009 ticket 002: `thdr`/`t` are the one exception to "every
   * line is still echoed to `onLine`" above -- see
   * {@link handleTelemetryLine}'s own doc comment for why telemetry
   * rides {@link emitTelemetry} exclusively, never the rx log or a full
   * endpoint-snapshot broadcast.
   */
  private handleInboundLine(state: EndpointState, decoded: DecodedLine): void {
    const text = reconstructLineText(decoded);
    if (decoded.verb === "status") {
      let origin: LineOrigin | undefined;
      if (state.pollAwaitingStatus) {
        state.pollAwaitingStatus = false;
        origin = "poll";
      }
      state.robotStatus = parseStatusReply(decoded.fields);
      this.adoptStatusNext(state, state.robotStatus);
      this.emitLine(state.endpointId, "rx", text, origin);
      this.emitDevices();
      return;
    }
    if (decoded.verb === "estop") {
      const previous = state.robotStatus;
      state.robotStatus = {
        receivedAt: Date.now(),
        fields: previous?.fields ?? {},
        ready: previous?.ready ?? false,
        active: false,
        estopped: true,
        stallHalted: previous?.stallHalted ?? false,
        leaseExpired: previous?.leaseExpired ?? false,
      };
      this.emitLine(state.endpointId, "rx", text);
      this.emitDevices();
      return;
    }
    if (decoded.verb === "funcs") {
      const name = decoded.fields[0];
      if (name !== undefined && name.length > 0) {
        const fn: RobotFunction = { name };
        const signature = decoded.fields.slice(1).join(" ");
        if (signature.length > 0) {
          fn.signature = signature;
        }
        state.functions = [...(state.functions ?? []), fn];
      }
      this.emitLine(state.endpointId, "rx", text);
      this.emitDevices();
      return;
    }
    if (decoded.verb === "thdr" || decoded.verb === "t") {
      this.handleTelemetryLine(state, decoded);
      return;
    }
    if (decoded.verb === "id") {
      this.handleIdReply(state, decoded);
      this.emitLine(state.endpointId, "rx", text);
      return;
    }
    this.emitLine(state.endpointId, "rx", text);
  }

  /**
   * Sprint 011 ticket 001: harvest an `id <product> <program> <version>
   * <name>` reply -- sent unsequenced, once, by {@link startRobotProbes}
   * after every robot identify (any transport) -- into this endpoint's
   * `classification`. `@robot-console/protocol`'s {@link parseIdReply}
   * owns the positional parse; {@link refineForCalibration} owns the
   * `calibration-` prefix match (the one place it is matched -- see
   * that function's own doc comment). A malformed reply (fewer than
   * four fields) is silently ignored -- `parseIdReply` returning `null`
   * means the classification simply stays whatever it already was,
   * exactly like a robot that never answers `ID` at all. Only ever
   * called for a `decoded.verb === "id"` line, which arrives on a
   * session already classified `"robot"` or `"calibration"` (an
   * unrelated device would never have had `ID` sent to it in the first
   * place -- see {@link startRobotProbes}'s own guard).
   */
  private handleIdReply(state: EndpointState, decoded: DecodedLine): void {
    const idReply = parseIdReply(decoded.fields);
    if (!idReply) {
      return;
    }
    state.classification = refineForCalibration(state.classification, idReply);
    this.emitDevices();
  }

  /** Lazily create (never destroy on its own) the per-endpoint
   * {@link TelemetryDecoder} instance -- see
   * {@link EndpointState.telemetryDecoder}'s own doc comment for why it
   * is created on first use rather than at endpoint/session
   * construction time (this method is the one call site for both
   * branches {@link handleTelemetryLine} dispatches to). */
  private getTelemetryDecoder(state: EndpointState): TelemetryDecoder {
    if (!state.telemetryDecoder) {
      state.telemetryDecoder = new TelemetryDecoder();
    }
    return state.telemetryDecoder;
  }

  /**
   * Sprint 009 ticket 002: `thdr`/`t` handling, split out of
   * {@link handleInboundLine} since -- unlike every other reply verb
   * that method dispatches -- telemetry deliberately does **not** echo
   * to {@link onLine}/{@link emitLine} (the per-device rx log is capped
   * at `MAX_LINES_PER_DEVICE` and meant for human-readable console
   * traffic, not a 20 Hz structured stream) and does **not** call
   * {@link emitDevices} (that would re-broadcast the full endpoint
   * snapshot 20 times a second -- see `wsMessages.ts`'s own
   * {@link TelemetryMessage} doc comment and sprint.md's Design
   * Rationale #2). Telemetry rides {@link emitTelemetry}/{@link onTelemetry}
   * only.
   *
   * - `thdr` -> store the new header via {@link TelemetryDecoder.handleHeader},
   *   forward it as a header-update {@link TelemetryEvent}.
   * - `t` with no header held ({@link TelemetryDecoder.decodeFrame}
   *   returning `NoHeaderHeld`) or a field-count mismatch against the
   *   held header -> drop the row silently: forward nothing (the
   *   client's own default state already reads as "waiting for header"
   *   -- see `wsMessages.ts`'s {@link TelemetryMessage} doc comment) and
   *   issue **no** recovery command. See this method's own "Passive
   *   header recovery" note below for why -- an earlier revision of
   *   this ticket sent `TLM HDR` here; that was wrong and has been
   *   removed.
   * - `t` with a header held that decodes successfully -> zip via
   *   `@robot-console/protocol`'s `v6/telemetry.ts`, forward the
   *   resulting frame.
   *
   * ## Passive header recovery (revised; no `TLM HDR` request)
   *
   * An earlier revision of this ticket had this method send `TLM HDR`
   * on a gap, guarded like {@link pollAwaitingStatus}'s single-
   * outstanding-request pattern. Bench testing against gopiv (fw
   * `v1.20260909.2`, this repo's `vendor/pxt-nezha-diffdrive` checkout)
   * showed that request is wrong: `WireHandler::parseTlmMode`
   * (`vendor/pxt-nezha-diffdrive/src/comms/wire_handler.cpp:174-191`)
   * only recognizes `OFF`/`POSE`/`FULL`/`NOW`/`AUTO`/`BUFFER` as `TLM`
   * mode tokens -- there is no `HDR` mode on this firmware at all, so
   * sending it drew `err 2` plus a nack (the session's own nack-driven
   * resync absorbed the fallout, but the send itself was simply wrong
   * against the real firmware).
   *
   * Recovery does not need a request regardless: `WireHandler::emitTelemetry`
   * (`vendor/pxt-nezha-diffdrive/src/comms/wire_handler.cpp:1440-1453`)
   * re-emits `thdr` on its own whenever the column set changes
   * (`headerChanged(snapshot)`) OR every `kHeaderRefreshFrames` frames
   * (`framesSinceHeader_ >= kHeaderRefreshFrames`) -- so a host that
   * missed (or never held) a header only has to wait for the next
   * periodic re-emission, which arrives unprompted. Dropping a
   * header-less/mismatched row and doing nothing else is therefore the
   * correct behavior, not a stopgap: there is nothing this host could
   * usefully send to speed recovery up, and the one verb it used to
   * send for that purpose does not exist on the firmware it talks to.
   */
  private handleTelemetryLine(state: EndpointState, decoded: DecodedLine): void {
    const decoder = this.getTelemetryDecoder(state);
    if (decoded.verb === "thdr") {
      decoder.handleHeader(decoded.fields);
      this.emitTelemetry(state.endpointId, { header: decoder.currentHeader ?? decoded.fields });
      return;
    }
    const result = decoder.decodeFrame(decoded.fields);
    if (result.kind === "noHeaderHeld" || result.kind === "fieldCountMismatch") {
      // Drop silently -- see this method's own "Passive header
      // recovery" doc comment. The decoder's held header (if any) is
      // left untouched: `zipTelemetryFrame`/`decodeFrame` are pure and
      // never mutate it on a mismatch, so the very next matching `t`
      // (or a fresh `thdr`) resumes decoding normally with no action
      // needed here.
      return;
    }
    this.emitTelemetry(state.endpointId, { frame: result.fields });
  }

  /**
   * OOP 2026-09-09: protocol.md §8.7 -- `status next=<expectedNext_>`
   * exists precisely so a host can realign its counter without a
   * `HELLO`. With nothing pending, the id this session would send next
   * must equal what the robot expects next; if it does not (the robot
   * reset, or something out-of-band talked to it), adopt the robot's
   * number silently. Never touched while a command is in flight -- the
   * ack/nack path owns that case.
   */
  private adoptStatusNext(state: EndpointState, status: RobotStatus): void {
    const session = state.session?.link.session;
    const nextText = status.fields["next"];
    if (!session || nextText === undefined || session.pendingCount > 0) {
      return;
    }
    const next = Number(nextText);
    if (!Number.isInteger(next) || next < 1 || next === session.nextSequenceId) {
      return;
    }
    session.resyncTo(next);
    state.desyncNotified = false;
  }

  /** Echo a `HELLO` banner reply into the console (see
   * {@link connectAndIdentify}). A `null` banner echoes nothing -- the
   * caller reports the timeout in its own words. */
  private echoBanner(state: EndpointState, banner: ParsedBanner | null): void {
    if (!banner) {
      return;
    }
    const text = banner.raw ?? `${banner.role} ${banner.commonName} ${banner.name} ${banner.serial}`;
    this.emitLine(state.endpointId, "rx", text);
  }

  /**
   * OOP 2026-09-09: once a session identifies as a robot, the host
   * itself keeps two things current without the user asking: it sends
   * `FUNCS` once (so the function list is there when the page opens),
   * and it polls `STATUS` every {@link DeviceRegistryOptions.statusPollIntervalMs}
   * (so `robotStatus` -- and in particular the e-stop latch -- is
   * visible and stays fresh). Both are no-ops for a non-robot
   * classification. Idempotent: restarts the poll if one was running.
   *
   * Sprint 011 ticket 001: this is also the one shared post-identify
   * step every transport already runs through (USB attach, WiFi attach,
   * post-flash reidentify, and a relay/mbserial robot synthesized by
   * `openRobotViaRelay` -- see this module's own doc comment), so it is
   * where the unsequenced `ID` probe is sent too, exactly once per
   * identify, unconditionally (never gated by `autoRequestFunctions`/
   * `statusPollIntervalMs` -- those two are opt-in conveniences, this is
   * the classification signal the linked issue exists for). The reply
   * (if any) is harvested by {@link handleIdReply} whenever it arrives;
   * a robot that never answers (older firmware, a build without the
   * verb, or the request simply going unanswered) is never specially
   * waited for or timed out here -- `classification.type` simply stays
   * `"robot"`, exactly as the ticket's own acceptance criteria requires.
   */
  private startRobotProbes(state: EndpointState): void {
    this.stopRobotProbes(state);
    if (!this.isLive(state) || !state.sessionOpen || !state.session) {
      return;
    }
    if (state.classification.type !== "robot") {
      return;
    }
    this.probeIdentity(state);
    if (this.autoRequestFunctions) {
      this.dispatchFuncs(state);
    }
    if (this.statusPollIntervalMs > 0) {
      this.pollStatus(state);
      const timer = setInterval(() => this.pollStatus(state), this.statusPollIntervalMs);
      // Never keep the process alive just for a poll.
      timer.unref?.();
      state.statusPollTimer = timer;
    }
  }

  private stopRobotProbes(state: EndpointState): void {
    if (state.statusPollTimer) {
      clearInterval(state.statusPollTimer);
      state.statusPollTimer = undefined;
    }
    state.pollAwaitingStatus = false;
  }

  /** One `STATUS` on the host's own initiative, tagged `origin:
   * "poll"` on the tx side (and, via {@link EndpointState.pollAwaitingStatus},
   * on the matching `status` reply). Quiet while a `HELLO` round trip
   * is in flight. Reports (never throws) a failed write. */
  private pollStatus(state: EndpointState): void {
    if (!this.isLive(state) || !state.sessionOpen || !state.session || state.identifying) {
      return;
    }
    try {
      const line = state.session.link.sendUnsequenced("STATUS");
      state.pollAwaitingStatus = true;
      this.emitLine(state.endpointId, "tx", line.replace(/\n$/, ""), "poll");
    } catch (error) {
      this.emitError(state.endpointId, error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * Sprint 011 ticket 001: send unsequenced `ID` once, on the host's own
   * initiative, right after a robot identifies -- see
   * {@link startRobotProbes}'s own doc comment for why this lives there
   * rather than behind either of that method's two existing opt-in
   * flags. Fire-and-forget, exactly like {@link pollStatus}/{@link
   * dispatchFuncs}: this method never awaits a reply or tracks a
   * timeout of its own. The reply (if the robot ever answers) arrives
   * on the normal inbound-line path and is harvested by
   * {@link handleIdReply}; if it never arrives, nothing here times out
   * or retries -- the classification simply stays whatever it already
   * was, per the linked issue's own design caution that absence of a
   * reply is never evidence of a student build. Reports (never throws)
   * a failed write, same as every other probe here.
   */
  private probeIdentity(state: EndpointState): void {
    if (!state.session) {
      return;
    }
    try {
      const line = state.session.link.sendUnsequenced("ID");
      this.emitLine(state.endpointId, "tx", line.replace(/\n$/, ""));
    } catch (error) {
      this.emitError(state.endpointId, error instanceof Error ? error.message : String(error));
    }
  }

  /** Send `FUNCS` (sequenced -- see `SEQUENCED_VERBS`) and reset the
   * accumulated function list so the reply lines rebuild it from
   * scratch. Shared by {@link sendCommand} (a user pressing the
   * button) and {@link startRobotProbes} (the automatic request). */
  private dispatchFuncs(state: EndpointState): void {
    if (!state.session) {
      return;
    }
    state.functions = [];
    this.emitDevices();
    try {
      const line = state.session.link.sendCommand("FUNCS");
      this.emitLine(state.endpointId, "tx", line.replace(/\n$/, ""));
    } catch (error) {
      this.emitError(state.endpointId, error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * OOP fix (defect 1): a desynced `nack` (`AckNackEvent.desynced`,
   * `@robot-console/protocol`'s `Session`) means the robot's own
   * sequence reset out from under this session -- Session itself already
   * refuses to retransmit into that dead end (see its own doc comment),
   * so there is no resend flood to worry about here. What is still
   * missing without this method is telling the human at the bench: a
   * held drive-control button that keeps sending into an already-
   * desynced session would otherwise just go quiet with no visible sign
   * anything is wrong. Reported once per session (via
   * {@link EndpointState.desyncNotified}) rather than once per send, so
   * a held button does not flood the console with the same line.
   */
  private reportDesyncIfNeeded(state: EndpointState, event: AckNackEvent): void {
    if (event.kind === "ack") {
      // Progress: a later reset is a new episode worth reporting again.
      state.desyncNotified = false;
      return;
    }
    if (event.gaveUp !== undefined) {
      this.emitError(
        state.endpointId,
        `The robot kept rejecting "${event.gaveUp.replace(/\n$/, "")}" as malformed -- dropped it and continued at #${event.n}.`,
      );
      return;
    }
    if (!event.desynced || state.desyncNotified) {
      return;
    }
    state.desyncNotified = true;
    // OOP 2026-09-09: the Session has already adopted the robot's own
    // next-expected id (Session.resyncTo) -- this is a notice, not a
    // request for the user to do anything.
    this.emitError(
      state.endpointId,
      `The robot restarted its command counter -- resynced automatically, continuing at #${event.n}.`,
    );
  }

  /**
   * OOP fix (defect 2): the HELLO button's real recovery action, and the
   * only place besides the initial attach flow that this module ever
   * lets a live session send `HELLO`. Previously `sendCommand` refused
   * `HELLO` outright and told the user to close and reopen the session
   * instead -- but `Link.identify()` (via `@robot-console/protocol`'s
   * `Session.connect()`) already IS that "close and reopen" done right:
   * it sends `HELLO` and resets this session's own local sequencing
   * state (fresh id counter, empty pending table, `seq = 1`) in lockstep
   * with the reset `HELLO` causes on the robot side. Refusing to call it
   * left the user with no in-band way to recover from exactly the
   * desync {@link reportDesyncIfNeeded} above now warns about.
   *
   * Runs from inside `sendCommand`/`sendLine`'s existing per-endpoint
   * mutex, so no other send for this endpoint can interleave while this
   * awaits the banner reply -- unlike every other verb `sendCommand`
   * dispatches, which never await anything past the paced write.
   */
  private async resyncSession(state: EndpointState, endpointId: string): Promise<void> {
    const link = state.session?.link;
    if (!link) {
      return;
    }
    // OOP 2026-09-09: echo the HELLO and its banner reply into the
    // console -- identify() consumes the banner itself, so without
    // this a successful resync looked like "the button did nothing".
    state.identifying = true;
    this.emitLine(endpointId, "tx", "HELLO");
    const banner = await link.identify();
    state.identifying = false;
    if (!this.isLive(state) || !state.session) {
      // Device removed, or its session torn down, while the resync was
      // in flight -- nothing left here to update.
      return;
    }
    this.echoBanner(state, banner);
    state.desyncNotified = false;
    // Sprint 009 ticket 002: a HELLO resync is exactly the kind of
    // session discontinuity a stale telemetry header must not survive --
    // reset the decoder so the next `t` line is treated as a fresh gap
    // (dropped silently, per handleTelemetryLine's own doc comment),
    // never zipped against a header held before the resync.
    state.telemetryDecoder = undefined;
    this.emitDevices();
    if (!banner) {
      this.emitError(
        endpointId,
        "Sent HELLO but the robot didn't answer -- check the connection and try again.",
      );
    }
  }

  private handleLinkError(state: EndpointState, err: Error): void {
    this.stopRobotProbes(state);
    // Note: this deliberately leaves `state.session` in place even
    // though `sessionOpen` flips false immediately -- see
    // EndpointState.sessionOpen's own doc comment for why. Only
    // teardownLink (via requestClose or a detach) actually disposes of
    // the session's link and subscriptions.
    state.sessionOpen = false;
    state.sessionError = err.message;
    if (state.wifiTarget) {
      // OOP 2026-09-10: a dropped WiFi link (robot rebooted, left the
      // network) is re-identified when it next announces -- see
      // EndpointState.wifiAutoConnect.
      state.wifiAutoConnect = true;
    }
    this.emitDevices();
    this.emitError(state.endpointId, err.message);
  }

  private async teardownLink(state: EndpointState): Promise<void> {
    this.stopRobotProbes(state);
    state.robotStatus = undefined;
    state.functions = undefined;
    // Sprint 009 ticket 002: discard the held telemetry header along
    // with the rest of this session's state -- a fresh session must
    // never zip a `t` line against a header held by whatever session
    // came before it.
    state.telemetryDecoder = undefined;
    state.session?.unsubscribeLine();
    state.session?.unsubscribeRawLine();
    state.session?.unsubscribeAckNack();
    state.session?.unsubscribeError();
    const link = state.session?.link;
    state.session = undefined;
    state.sessionOpen = false;
    if (link) {
      await link.close();
    }
  }

  // ---- event dispatch ---------------------------------------------------

  private emitDevices(): void {
    const devices = this.snapshot();
    for (const listener of this.devicesListeners) {
      listener(devices);
    }
  }

  private emitLine(endpointId: string, direction: LineDirection, line: string, origin?: LineOrigin): void {
    for (const listener of this.lineListeners) {
      if (origin) {
        listener(endpointId, direction, line, origin);
      } else {
        listener(endpointId, direction, line);
      }
    }
  }

  private emitError(endpointId: string | undefined, message: string): void {
    for (const listener of this.errorListeners) {
      listener(endpointId, message);
    }
  }

  private emitTelemetry(endpointId: string, event: TelemetryEvent): void {
    for (const listener of this.telemetryListeners) {
      listener(endpointId, event);
    }
  }

  private emitFlashProgress(endpointId: string, source: FirmwareSourceRef, phase: FlashPhase): void {
    for (const listener of this.flashProgressListeners) {
      listener(endpointId, source, phase);
    }
  }

  private emitFlashResult(
    endpointId: string,
    source: FirmwareSourceRef,
    status: "ok" | "error",
    message?: string,
    classification?: DeviceClassification,
    name?: string | null,
    reidentify?: "timeout",
  ): void {
    for (const listener of this.flashResultListeners) {
      listener(endpointId, source, status, message, classification, name, reidentify);
    }
  }
}
