/**
 * wsMessages.ts — the one WebSocket message contract between `server.ts`
 * and the browser UI (`packages/ui`).
 *
 * This module is pure type/shape definitions plus small, dependency-free
 * type guards for the client -> server direction (server.ts needs to
 * validate untrusted JSON arriving over the socket). It holds no naming,
 * framing, or sequencing logic of its own -- see `server.ts`'s own doc
 * comment for why that boundary matters.
 *
 * ## Sprint 15 reshape -- link vocabulary replaces endpoint vocabulary,
 * one `Snapshot` replaces five side channels
 *
 * `docs/design/architecture.md` §9 is the authoritative shape this module
 * matches; this ticket (015-004) freezes it here, as a clean break with
 * no dual-format transition period (architecture.md §2) -- `server.ts`
 * and `packages/ui` are expected to still reference the retired types
 * below until tickets 005 and 007-009 land (they do not compile against
 * this file in the interim; that is those tickets' problem to fix, not
 * this one's).
 *
 * Retired outright, not kept alongside the new types:
 *   - `EndpointsMessage`/`EndpointListEntry` (`type: "endpoints"`) --
 *     replaced by {@link Snapshot} (`type: "snapshot"`), which folds in
 *     what used to be three separate top-level lists
 *     (`rememberedRobots`, `discoveredServices`, `firmwareStatus`) plus
 *     the per-endpoint flash/WiFi side channels. Still always a full
 *     snapshot, never a delta, so a client that missed a broadcast
 *     self-heals on the next one -- that property is unchanged by this
 *     reshape.
 *   - `ErrorMessage` (`type: "error"`) -- replaced by {@link Notice}
 *     (`type: "notice"`), which also carries the `"info"`/`"warn"`
 *     server-initiated notices the old model had no room for (e.g. a
 *     state-change notice per architecture.md §8 rule 4, "a single
 *     notice per state change, not per attempt").
 *   - `ForgetKnownRobotMessage` (`type: "forget-known-robot"`, keyed by
 *     `name`) -- replaced by {@link ForgetDeviceMessage}
 *     (`type: "forget-device"`, keyed by the numeric `devices.id`): the
 *     store's `devices` table is keyed by chip id, not name (architecture.md
 *     §4), and a name is not even unique (~79% collision probability
 *     over a 100-robot fleet, per that section) -- so a wire message that
 *     asks to forget "the device named X" can no longer name its target
 *     unambiguously. `devices.id` always can.
 *   - `EndpointListEntry.endpointId`/`resourceKey` and every other
 *     `endpointId`-keyed field on the messages below -- renamed to
 *     `linkId` throughout, matching `links.id` (architecture.md §4:
 *     "opaque; never parsed by the UI") being the one addressable
 *     identity left once "endpoint" (a device/session pairing that only
 *     coincided 1:1 with a physical link before relays existed) and
 *     "resource key" (a distinct-but-always-equal shadow of endpointId,
 *     speculative generality that relays never actually needed) both
 *     drop out. Confirmed by ticket 008 ("route on `linkId` instead of
 *     `endpointId`") for the UI half of this same rename.
 *
 * Kept unchanged (this ticket does not touch their shape): {@link
 * FirmwareKind}, {@link FirmwareSourceRef}, {@link FlashPhase}, {@link
 * FirmwareAvailability}, {@link RobotStatus}, {@link RobotFunction},
 * {@link WireField}-carrying {@link SendCommandMessage},
 * {@link UPLOAD_ID_BYTE_LENGTH} and the local-hex upload handshake
 * messages, `line`/`telemetry`/`flash-progress`/`flash-result`/
 * `wifi-provision-result`'s own verb and validator style (only their
 * `endpointId` field is renamed `linkId`, per above) -- `connect/
 * harvester.ts` (ticket 003, already landed) imports {@link RobotStatus}/
 * {@link RobotFunction} straight from this file, so those two shapes are
 * frozen by an existing caller, not just by this ticket's own scope.
 *
 * Changed: {@link SessionOpenMessage} takes `{linkId}` (open/reopen a
 * link the projection already lists) or `{relayLinkId, name}` (route one
 * of a relay's several robots), never both, and never the old `radio`
 * override argument -- ticket 006 adds `set-radio-override` as its own
 * message, replacing what `radio` used to do inline. Every server ->
 * client message gains `seq`, an incrementing counter `server.ts` (ticket
 * 005) stamps on every broadcast, so a client can detect a gap after a
 * reconnect the same way {@link Snapshot}'s own `seq` already lets it
 * detect a stale snapshot.
 *
 * Direction:
 *   - client -> server: {@link SessionOpenMessage}, {@link
 *     SessionCloseMessage}, {@link LineMessage} (always `direction: "tx"`
 *     in this direction), {@link SendCommandMessage}, {@link
 *     FlashStartMessage}, {@link FlashLocalBeginMessage}, {@link
 *     ForgetDeviceMessage}, {@link SetRadioOverrideMessage}, {@link
 *     GetWifiCredentialsMessage}, {@link SetWifiCredentialsMessage},
 *     {@link ProvisionWifiMessage}.
 *   - server -> client: {@link Snapshot}, {@link Notice}, {@link
 *     LineMessage} (always `direction: "rx"` in this direction -- an
 *     inbound line from the device), {@link FlashProgressMessage},
 *     {@link FlashResultMessage}, {@link FlashLocalReadyMessage}, {@link
 *     TelemetryMessage}, {@link WifiCredentialsMessage}, {@link
 *     WifiProvisionResultMessage}.
 *   `LineMessage`/`TelemetryMessage` are shared shapes used in both
 *   directions -- `seq` is present only when the server sends one (see
 *   each field's own doc comment).
 */

import type { WireField } from "@robot-console/protocol";

/** Which firmware a flash operation targets, when the source is a
 * configured release build. `"relay"` is the radio-relay board's
 * firmware, `"robot"` the diff-drive robot's -- see `config.ts`'s
 * `FirmwareConfigMap` for how each maps to a configured
 * `<repo-url>:<tag>` source. */
export type FirmwareKind = "relay" | "robot";

/** Where the hex a flash operation writes comes from: a configured
 * release build (`config.ts`/`releases.ts`), or a file the student
 * picked from their own machine and uploaded over the socket
 * (`local-hex`). `local-hex`'s `fileName`/`sha256` are carried here (not
 * just the `uploadId`) so a client that reconnects mid-flash can still
 * show what's being flashed. */
export type FirmwareSourceRef =
  | { kind: "release"; firmware: FirmwareKind }
  | { kind: "local-hex"; uploadId: string; fileName: string; sha256: string };

/** Stage of an in-flight flash, in the order `flash.ts`/the connector
 * report them: `"fetching"`/`"verifying"` come from `releases.ts`
 * resolving and checking the hex; `"erasing"`/`"writing"`/`"resetting"`
 * come from `flash.ts` writing it to the board; `"reidentifying"` is the
 * server waiting for the freshly-flashed board to announce itself again
 * before reporting the terminal {@link FlashResultMessage}. Purely
 * informational for the UI's progress text. */
export type FlashPhase = "fetching" | "verifying" | "erasing" | "writing" | "resetting" | "reidentifying";

/** Which transport a link is reachable over -- mirrors `store/index.ts`'s
 * own `Transport` union verbatim, independently declared here (this
 * module never imports the store -- it is shared with `packages/ui`,
 * which must not pull in `node:sqlite`) rather than re-exported, the
 * same way {@link RadioSourceWire} mirrors the store's `RadioSource`.
 * `"radio"` is a robot reached over a relay's radio; `"mbrelay"` is a
 * robot reached through a remote TCP relay pool; `"mbserial"` is a
 * direct-to-robot TCP link; `"wifi"` is a direct-to-robot roster-gated
 * TCP/UDP link. */
export type Transport = "usb" | "wifi" | "radio" | "mbrelay" | "mbserial";

/** A link's place in the state machine `docs/design/architecture.md` §5
 * diagrams. Mirrors `store/index.ts`'s own `LinkState` verbatim -- see
 * {@link Transport}'s own doc comment for why this is an independent
 * declaration, not an import. */
export type LinkState =
  | "discovered"
  | "connectable"
  | "connecting"
  | "connected"
  | "unresponsive"
  | "failed"
  | "closed_by_user"
  | "stale";

/** Where a device's `(channel, group)` radio address came from --
 * mirrors `store/index.ts`'s `RadioSource` (`"override" | "registry" |
 * null`), except the host-side `null` ("no override or registry hit;
 * fell back to the name-derived default") is spelled out on the wire as
 * `"derived"` rather than sent as a bare null, so a client never needs
 * to know that absence-means-derived convention itself. */
export type RadioSourceWire = "override" | "registry" | "derived";

/** Who opened a session -- mirrors `store/index.ts`'s own `SessionOrigin`
 * verbatim; see {@link Transport}'s own doc comment for why this is an
 * independent declaration, not an import. `"ui"` is a browser session;
 * `"mcp"` is one an MCP client opened (sprint 019 ticket 005, SUC-005).
 * Reused verbatim by {@link SnapshotLink.flash}'s own `origin` (sprint
 * 019 ticket 006) -- who opened a session and who started a flash are the
 * same two-value question. */
export type SessionOriginWire = "ui" | "mcp";

/** One row of the device page's "Recent agent activity" list (sprint 019
 * ticket 006; SUC-006/SUC-007) -- mirrors `store/index.ts`'s own
 * `AgentActionRow`, but display-shaped: `summary` is already-rendered
 * text (`projection.ts`'s own presentation choice from `kind`/`params`/
 * `result`/`resultReason`, e.g. `"WHEELS_V 40 40 -- sent"` or `"flash
 * nezha-robot-template -- failed: <reason>"`), never parsed by a client
 * (mirrors {@link SnapshotLink.label}'s own convention), so the UI never
 * has to know `params`'s per-`kind` shape. Purely informational -- no
 * interactive element renders from this, ever (this ticket's own
 * acceptance criterion: "No interactive element ... purely
 * informational"). */
export interface AgentActionActivity {
  kind: "drive" | "flash";
  caller: string;
  summary: string;
  /** `agent_actions.executed_at`. */
  at: number;
}

/** A parsed `status k=v ...` reply (robot firmware `wire_handler.cpp`
 * `execStatus`). `fields` is every `k=v` pair verbatim, order-free; the
 * named booleans are derived host-side from the `flags=<hex>` bitfield
 * (`wire_adapter.h`: bit0 ready, bit1 estopped, bit2 stall-halted, bit3
 * lease-expired) so a client never has to know the bit layout. Frozen by
 * `connect/harvester.ts` (ticket 003), which imports this type directly
 * from this file. */
export interface RobotStatus {
  /** `Date.now()` on the host when this was parsed. */
  receivedAt: number;
  fields: Record<string, string>;
  ready: boolean;
  active: boolean;
  estopped: boolean;
  stallHalted: boolean;
  leaseExpired: boolean;
}

/** One `funcs <name> [signature]` reply line. `signature` is the rest of
 * the line after the name when the firmware reports one (today's
 * firmware omits it), so a client must treat its absence as "parameters
 * unknown", never as "takes none". Frozen by `connect/harvester.ts`
 * (ticket 003), which imports this type directly from this file. */
export interface RobotFunction {
  name: string;
  signature?: string;
}

/** Which way a line is travelling on the shared `"line"` message shape:
 * `"tx"` — client -> server -> device; `"rx"` — device -> server ->
 * client. */
export type LineDirection = "tx" | "rx";

/** See {@link LineMessage.origin}. */
export type LineOrigin = "poll";

/** A single protocol line, either sent to a device (`direction: "tx"`,
 * client -> server) or received from one (`direction: "rx"`, server ->
 * client). `line` is the raw wire text (no trailing newline). Shared
 * between both directions -- {@link seq} is present only when the server
 * sends one. */
export interface LineMessage {
  type: "line";
  linkId: string;
  direction: LineDirection;
  line: string;
  /** `"poll"` marks a line the host sent or received on its own
   * initiative -- the periodic `STATUS` poll -- rather than on behalf of
   * a user action. Absent for every other line. A console may hide poll
   * traffic by default; nothing else should key on it. */
  origin?: LineOrigin;
  /** Present only server -> client -- see the module doc comment's
   * "Every server -> client message gains seq" note. Absent on the
   * client -> server direction of this same shared shape. */
  seq?: number;
}

/** Server -> client: one decoded telemetry event for a link -- either a
 * header update, when a `thdr` line arrives or changes, or one decoded
 * frame, when a `t` line successfully zips against the currently held
 * header. Never both on the same message.
 *
 * Deliberately its own message type (`type: "telemetry"`), distinct from
 * {@link LineMessage} (bounded, feeds the console log -- the wrong
 * vehicle for a 20 Hz structured-data stream) and from {@link Snapshot}
 * (a deliberately infrequent full snapshot -- folding 20 Hz data into it
 * would mean re-broadcasting the entire device list 20 times a second).
 *
 * A `t` frame that arrives with no header held for the link (or one that
 * fails to zip against the held header) produces no {@link
 * TelemetryMessage} at all. */
export interface TelemetryMessage {
  type: "telemetry";
  linkId: string;
  /** Present only on a header update -- the ordered column names from
   * the most recent `thdr` line, verbatim (no validation, no scaling). */
  header?: readonly string[];
  /** Present only on a decoded frame -- `header[i]` -> the `t` line's
   * `fields[i]`, raw wire text, completely unconverted. */
  frame?: Record<string, string>;
  /** Server -> client only; see {@link LineMessage.seq}'s own doc
   * comment. */
  seq?: number;
}

/** Client -> server: send one protocol verb, with optional fields, to a
 * link's open session -- the structured alternative to {@link
 * LineMessage}'s raw text. `deviceRegistry.ts`'s successor (the
 * connector/harvester pair) decides, via `@robot-console/protocol`'s
 * `isSequencedVerb`, whether `verb` goes through `Session.send()`
 * (sequenced) or `Session.sendUnsequenced()` (everything else, including
 * `STATUS`) -- that classification is never re-derived here. `fields`
 * omitted is equivalent to an empty array, for bare verbs like `GET`
 * with no arguments. */
export interface SendCommandMessage {
  type: "send-command";
  linkId: string;
  verb: string;
  fields?: WireField[];
}

/** Per-firmware availability, as `watchers/firmwareWatcher.ts` (sprint
 * 017 ticket 002, replacing the retired `FirmwareAvailabilityCache`)
 * reports it. `configured: false` means `config.ts` found no
 * `<repo-url>:<tag>` env value for this {@link FirmwareKind} -- the
 * button stays disabled with no network check ever attempted.
 * `configured: true` always carries `repoUrl`/`tag` (so the UI can show
 * what will be flashed) plus the live `available` result of the most
 * recent poll; `reason` is present only when `available` is `false`.
 * `message` is the specific diagnostic `releases.ts`'s `resolveRelease`
 * already computes for the failure, carried alongside `reason` so a
 * client can show *why*, not just which short token failed. `checkedAt`
 * (ticket 018-017) is the store's `firmware.checked_at` for this kind's
 * most recent poll (`null` if it has never been checked at all) -- the
 * flash modal and Calibration tab firmware panel both show it next to
 * the repo/tag so a student or instructor can tell how fresh the
 * resolved release is.
 *
 * Out-of-process, 2026-09-16: a configured firmware may now be a hex
 * file on the host's own disk instead of a GitHub release (see
 * `config.ts`'s `LocalHexFirmwareSource`), so `configured: true` has a
 * second arm discriminated by `kind`. `kind` is **optional and absent**
 * on the release arm, which is what every pre-existing client literal
 * and test fixture already constructs; only the local-file arm states it
 * explicitly. Clients branch with `kind === "local-file"`, never by
 * probing for a field. The local arm carries no `repoUrl` at all --
 * there is no repo and no release page to link to -- so a client cannot
 * accidentally render a filesystem path as a URL. Its `tag` is the
 * file's build stamp (`localFirmware.ts`'s `formatBuildStamp`, derived
 * from the hex's mtime): for a locally built image, *which build this
 * is* is exactly what a tag names. */
export type FirmwareAvailability =
  | { configured: false }
  | {
      configured: true;
      kind?: "release";
      repoUrl: string;
      tag: string;
      available: boolean;
      checkedAt: number | null;
      reason?: string;
      message?: string;
    }
  | {
      configured: true;
      kind: "local-file";
      /** Absolute path to the hex this firmware kind flashes. */
      hexPath: string;
      /** `hexPath`'s basename -- what the UI names, so it never has to
       * split a path itself. */
      fileName: string;
      /** Human-readable build stamp from the file's mtime (e.g.
       * `"built 2026-09-13 10:52"`), shown where a release's tag is. */
      tag: string;
      available: boolean;
      checkedAt: number | null;
      reason?: string;
      message?: string;
    };

/** One link as rendered on the front page -- inside a {@link
 * SnapshotDevice.links} list when its `deviceId` is known, or inside
 * {@link Snapshot.unassigned} when it is a USB board not yet identified.
 * Keyed by {@link id} across snapshots -- `links.id` (architecture.md
 * §4), opaque, never parsed by the UI. */
export interface SnapshotLink {
  /** Same value as `links.id` -- opaque, stable across snapshots. */
  id: string;
  transport: Transport;
  /** Short human-readable summary of this link's transport and address
   * (e.g. `"USB · /dev/cu.usbmodem1234"`, `"Radio · ch41/grp3"`) --
   * `projection.ts`'s own presentation choice (architecture.md §9 gives
   * one illustrative example, not a literal format this module pins);
   * never parsed by a client, display text only. */
  label: string;
  state: LinkState;
  /** `links.state_reason` -- present only when the state machine
   * recorded one (a failure detail, a close reason, …). */
  reason: string | null;
  /** `links.state_since`. */
  since: number;
  /** `links.last_seen` -- `null` if the underlying watcher has never
   * refreshed it. */
  lastSeen: number | null;
  /** `links.next_retry_at` -- present only while `state === "failed"`
   * and a backoff is pending; `null` otherwise. */
  nextRetryAt: number | null;
  /** Present only for a `radio`/`mbrelay` link -- which relay it rides
   * on and the `(channel, group)` in use, so a client never has to parse
   * {@link id} to find that out. */
  via?: {
    relayLinkId: string;
    relayName: string;
    channel: number;
    group: number;
    addressSource: RadioSourceWire;
  };
  /** Present only while a session is open on this link. `seq`/`pending`
   * default to `0` when a session has just opened and no `updateSession`
   * call has landed yet (mirrors `sessions.seq`/`sessions.pending` being
   * `NULL` at that point) -- distinguishing "session open, nothing
   * pending yet" from "no session" is exactly what {@link
   * SnapshotLink.session}'s own presence/absence already does, so the
   * numeric fields themselves never need to be optional too. */
  session?: {
    seq: number;
    pending: number;
    lastDone: number | null;
    lastDoneReason: string | null;
    robotStatus: RobotStatus | null;
    functions: RobotFunction[] | null;
    /** Sprint 018 ticket 010 (SUC-007): wall-clock time this session
     * last actually answered something (any decoded reply -- see
     * `connect/harvester.ts`'s `syncSession`), `null` if it never has.
     * The UI's "Linked" criterion (`deviceDisplay.ts`'s
     * `isLinkAnswering`) needs this to tell "the transport is open" from
     * "the robot is actually there and answering" -- `state ===
     * 'connected'` alone cannot (bench evidence: a bridge that accepts
     * TCP but never replies to `HELLO` still flips its link to
     * `connected`). Optional (like {@link SnapshotRelay.bridging}) so a
     * pre-018-010 snapshot literal — most existing test fixtures — need
     * not be updated to keep type-checking; a fixture that omits it is
     * simply never "Linked" under the new criterion. */
    answeredAt?: number | null;
    /** Sprint 019 ticket 005 (SUC-005): `'ui'` for a session opened from
     * the browser (the default -- see `store/index.ts`'s
     * `UI_SESSION_IDENTITY`), `'mcp'` for one an MCP client opened via
     * `connect/sessionOps.ts`'s `openSession`. Optional (like {@link
     * answeredAt}) so pre-019-005 snapshot literals need not be updated
     * to keep type-checking -- a fixture that omits it is simply never
     * shown as an agent session. */
    origin?: SessionOriginWire;
    /** The MCP client's own declared `clientInfo.name` when `origin ===
     * "mcp"`, `null`/absent otherwise -- what the console's device card
     * shows alongside the existing "who holds this board" text (ticket
     * 005's own acceptance criterion). */
    caller?: string | null;
  };
  /** Present only while a flash is in flight for this link. Flash
   * progress is held in server-side memory, not in the store
   * (architecture.md §4 has no `flash` table) -- `projection.ts`'s
   * `buildSnapshot`, being a pure function over store rows only, never
   * populates this field; `server.ts` (ticket 005) overlays it before
   * broadcasting. Typed here so that overlay has somewhere to write. */
  flash?: {
    source: FirmwareSourceRef;
    phase: FlashPhase;
    /** Sprint 019 ticket 006 (SUC-007): who started this flash --
     * `"ui"` for a browser's own `flash-start` (no {@link caller}
     * alongside it), `"mcp"` for one `mcp/tools/flash.ts` (ticket 008)
     * started, always paired with `caller` there. Both fields are
     * optional so a pre-ticket-006 fixture/test literal need not be
     * updated to keep type-checking -- a `flash` overlay that omits them
     * is simply never shown as agent-attributed, exactly like {@link
     * SnapshotLink.session}'s own `origin`/`caller` convention
     * (ticket 005). Held only for the duration of the flash -- `server.ts`'s
     * `finishFlash`/`failFlash` delete this whole overlay the instant the
     * flash settles, success or failure, so this is never reconstructed
     * after the fact; `agent_actions` (this ticket's own audit table) is
     * the durable record once the overlay is gone. */
    origin?: SessionOriginWire;
    caller?: string;
  };
  /** Whether `open`/`close`/`flash`/`provisionWifi` are currently
   * meaningful actions for this link, given its transport and state --
   * `projection.ts`'s own derivation, so the UI never re-implements the
   * ownership/transport rules architecture.md §7-§8 already state. */
  capabilities: { open: boolean; close: boolean; flash: boolean; provisionWifi: boolean };
}

/** One device (a robot or a relay board) as rendered on the front page --
 * `devices` joined with its owned `links`. */
export interface SnapshotDevice {
  /** `devices.id` -- `FICR.DEVICEID[1]`, decoded. */
  id: number;
  /** `devices.name` -- `deviceIdToName(id)`. */
  name: string;
  kind: "robot" | "relay";
  role: string | null;
  /** Banner `commonName` (`packages/protocol/src/banner.ts`'s
   * `ParsedBanner.commonName`, e.g. `"robot"`) -- `null` until this
   * device has identified at least once since `devices.common_name`
   * started being written (018-016). `packages/ui/src/deviceDisplay.ts`'s
   * `roleDisplay` folds this into a robot's one-line identity alongside
   * `role`/`version`; unused for relays. */
  commonName: string | null;
  program: string | null;
  version: string | null;
  owned: boolean;
  /** This device's radio address, always resolved to concrete numbers --
   * `override`/`registry` when `devices.radio_channel`/`radio_group` are
   * set, otherwise the name-derived default (`nameToRadioAddress`),
   * reported as `source: "derived"` (architecture.md: "A derived
   * (channel, group) is a default, not an address" -- still always a
   * displayable value, never absent). */
  radio: { channel: number; group: number; source: RadioSourceWire };
  /** `devices.last_seen`. */
  lastSeen: number;
  /** The `at` of the newest `sightings` row for this device, across any
   * transport -- `null` if this device has never been sighted (probed)
   * at all yet. */
  lastChecked: number | null;
  links: SnapshotLink[];
  /** The newest few `agent_actions` rows touching this device (its own
   * `flash` rows, plus its links' `drive` rows), newest first -- sprint
   * 019 ticket 006 (SUC-006/SUC-007), sourced from `store/index.ts`'s
   * `projectionRows` (`recentAgentActionsByDevice`). Optional, like
   * {@link SnapshotLink.session}'s own `origin`/`caller` (ticket 005) and
   * {@link SnapshotRelay.sweep} (ticket 016-007), so a pre-ticket-006
   * snapshot literal -- most existing test fixtures -- need not be
   * updated to keep type-checking; a client treats an absent value
   * exactly like an empty array (no agent has ever touched this device),
   * never as "unknown" or a reason to show a loading state. Purely
   * informational; see {@link AgentActionActivity}'s own doc comment. */
  recentAgentActions?: AgentActionActivity[];
}

/** One relay's lease/bridging status, alongside (not instead of) its own
 * entry in {@link Snapshot.devices} (a relay is still a `kind: "relay"`
 * device with its own links) -- see this field's own doc comment on
 * {@link Snapshot.relays}. */
export interface SnapshotRelay {
  /** The relay's own connectivity link id (`relay_leases.relay_link_id`
   * — architecture.md §7.2). */
  linkId: string;
  /** `"sweep"` while the sweeper (sprint 016) holds the port,
   * `"session"` while a student is bridged through it, `null` when
   * idle (no `relay_leases` row for this link at all). */
  lease: "sweep" | "session" | null;
  /** Present only while a radio-bridging attempt is in flight or
   * recently failed. Bridging state is held in server-side memory, not
   * the store (same reasoning as {@link SnapshotLink.flash}) --
   * `buildSnapshot` never populates this; `server.ts` overlays it. */
  bridging?: { state: "connecting" | "failed"; robotName?: string; error?: string };
  /** Which rate `watchers/relaySweeper.ts`'s sweep is currently running
   * this relay at (ticket 016-007; rearch-12,
   * `League-Robotics/microbit-radio-relay#1`, merged) -- `"fast"` once a
   * lease-acquisition sync has found the relay advertising `caps: CGT`
   * (the non-persisting `!CGT` tune), `"slow"` once a sync has completed
   * and found no such advertisement (the original 30s-spaced, persisting
   * `!CG` rate limit), `null`/omitted when no sync has completed against
   * this relay link yet at all -- a distinct, honest "not known yet"
   * rather than defaulting to either rate. Populated by `buildSnapshot`
   * itself (unlike {@link bridging}), from a `settings` row `runOnePass`
   * writes fresh on every lease acquisition -- see `store/index.ts`'s
   * `ProjectionRows.fastSweepByRelayLinkId` doc comment. Optional (like
   * {@link bridging}) so a pre-016-007 snapshot literal — most existing
   * test fixtures — need not be updated to keep type-checking. */
  sweep?: { rate: "fast" | "slow" } | null;
}

/** Server -> client: the full current state of every device, link, and
 * relay, plus firmware availability, the stored WiFi network, and
 * running background tasks -- sent once on connect and again on every
 * coalesced change-feed batch. Always a full snapshot, never a delta, so
 * a client that missed one self-heals on the next. Replaces
 * `EndpointsMessage`/`EndpointListEntry` and the `rememberedRobots`/
 * `discoveredServices`/`firmwareStatus` side lists entirely -- see the
 * module doc comment's "Sprint 15 reshape" section. */
export interface Snapshot {
  type: "snapshot";
  /** Incrementing counter, one higher than the previous broadcast --
   * lets a client detect a missed/stale snapshot on reconnect. Stamped
   * by `server.ts` (ticket 005); `projection.ts`'s `buildSnapshot` takes
   * it as a parameter rather than deriving it, since sequencing the
   * broadcast stream is a transport concern, not a projection one. */
  seq: number;
  /** `Date.now()` when this snapshot was built. */
  at: number;
  devices: SnapshotDevice[];
  /** USB boards seen but not yet identified to a `devices` row (no
   * `link.device_id` yet) -- architecture.md §9. */
  unassigned: SnapshotLink[];
  relays: SnapshotRelay[];
  firmware: Record<FirmwareKind, FirmwareAvailability>;
  /** The network the host would provision robots onto, as currently
   * stored -- never the password (mirrors the retired
   * `WifiCredentialsMessage`'s own non-reveal shape). `source` is
   * `"stored"` when a `settings` row exists, `null` otherwise;
   * `buildSnapshot` has no access to `config.ts`'s env-derived
   * fallback (out of the store), unlike the old per-request
   * `get-wifi-credentials` reply, which still exists for that reason
   * (see {@link GetWifiCredentialsMessage}). */
  wifi: { ssid: string | null; source: "stored" | null };
  tasks: Array<{ name: string; state: string; heartbeatAt: number }>;
}

/** Server -> client: something worth telling the student/instructor
 * about -- replaces the retired `ErrorMessage`, and also covers
 * `"info"`/`"warn"` notices the old model had no room for (e.g. one
 * notice per link state change, architecture.md §8 rule 4). `linkId` is
 * present when the notice is scoped to one link; absent for a
 * connection-level notice (e.g. a malformed message, a task failure). */
export interface Notice {
  type: "notice";
  level: "info" | "warn" | "error";
  linkId?: string;
  text: string;
  at: number;
  /** See the module doc comment's "Every server -> client message gains
   * seq" note. */
  seq: number;
}

/** Client -> server: open (or re-open, e.g. after a failed attempt) a
 * session. Exactly one of two shapes, never both:
 *   - `{ linkId }` -- open a link the current {@link Snapshot} already
 *     lists (a USB board, a WiFi/mbserial robot, or a relay's own
 *     link).
 *   - `{ relayLinkId, name }` -- route one of a relay's several robots:
 *     "bridge `relayLinkId` to the robot named `name`". The reconciler
 *     (`connect/reconciler.ts`'s `planUserOpen`) is what turns this into
 *     a close-then-open of the relay's current child, as one job.
 * Replaces the old `{ endpointId, robotName?, radio? }` shape --
 * `radio` is gone entirely (ticket 006's `set-radio-override` is the
 * replacement path for a non-default address), and `autoRobot`'s
 * default-failover request has no replacement in this shape (not carried
 * forward by this ticket's scope; a future ticket may reintroduce a
 * "no preference" request if wanted). */
export type SessionOpenMessage = { type: "session-open"; linkId: string } | { type: "session-open"; relayLinkId: string; name: string };

/** Client -> server: close an open session on a link. */
export interface SessionCloseMessage {
  type: "session-close";
  linkId: string;
}

/** Client -> server: flash the given {@link FirmwareSourceRef} onto a
 * link. The connector/harvester's board-owner/relay-lease acquisition
 * serializes this against a concurrent `session-open`/`session-close` on
 * the same physical resource. */
export interface FlashStartMessage {
  type: "flash-start";
  linkId: string;
  source: FirmwareSourceRef;
}

/** Server -> client: one stage of an in-flight flash. The corresponding
 * link's {@link SnapshotLink.flash} carries the same `source`/`phase`
 * pair for a client that connects mid-flash. */
export interface FlashProgressMessage {
  type: "flash-progress";
  linkId: string;
  source: FirmwareSourceRef;
  phase: FlashPhase;
  seq: number;
}

/** Server -> client: the terminal outcome of a flash -- exactly one of
 * these is sent per `flash-start`, after which {@link
 * SnapshotLink.flash} for that link is cleared. `message` is present
 * only on `status: "error"`. `classification`/`name`/`reidentify` are
 * present only on `status: "ok"`, once the freshly-flashed board has
 * re-announced (or timed out waiting). */
export interface FlashResultMessage {
  type: "flash-result";
  linkId: string;
  source: FirmwareSourceRef;
  status: "ok" | "error";
  message?: string;
  /** The link's post-flash banner role, once re-identified. Present
   * only on `status: "ok"`. */
  role?: string | null;
  /** The link's post-flash SWD name (unchanged by a flash in practice,
   * but re-read alongside re-identify for one consistent post-flash
   * snapshot). Present only on `status: "ok"`. */
  name?: string | null;
  /** Present only on `status: "ok"`, and only when the post-flash
   * re-identify attempt never received a banner in time -- the write
   * itself succeeded, so this is reported as "waiting for the board to
   * come back", never as a failure. */
  reidentify?: "timeout";
  seq: number;
}

/** Client -> server: begin a local-hex upload. The UI computes
 * `fileName`/`byteLength`/`sha256` from the file the student picked,
 * client-side, before sending anything -- so the server can reject an
 * oversized file before allocating a buffer for it. Part of the
 * local-hex upload handshake documented in this module's own doc
 * comment. */
export interface FlashLocalBeginMessage {
  type: "flash-local-begin";
  fileName: string;
  byteLength: number;
  sha256: string;
}

/** Server -> client: the server is ready to receive the binary frame for
 * a local-hex upload it did not reject. `uploadId` is what the client
 * prefixes the upcoming binary frame with, and later references in a
 * `flash-start` message's `source`. */
export interface FlashLocalReadyMessage {
  type: "flash-local-ready";
  uploadId: string;
  seq: number;
}

/** Exact byte length of the ASCII `uploadId` prefix on the local-hex
 * upload's binary WebSocket frame (an ASCII-encoded UUID). The frame is
 * `uploadId || payload` with no length prefix or delimiter between them
 * -- the receiver reads exactly this many bytes as the id and treats
 * everything after as the file's raw bytes. `localHexUpload.ts`'s
 * `LocalHexUploadManager` imports this constant directly. */
export const UPLOAD_ID_BYTE_LENGTH = 36;

/** Client -> server: forget a device -- removes its `devices` row (and,
 * transitively, any `links`/`sightings` rows pointing at it) so it no
 * longer appears in the next {@link Snapshot}. Replaces the retired
 * `ForgetKnownRobotMessage`, which named its target by (non-unique)
 * name; this names it by `devices.id`, the actual primary key. */
export interface ForgetDeviceMessage {
  type: "forget-device";
  deviceId: number;
}

/** Client -> server: set (`{channel, group}`) or clear (`{clear: true}`)
 * one device's radio address override -- architecture.md §2's decision
 * to move radio overrides out of browser `localStorage` and into the
 * host DB (ticket 006). Exactly one of the two shapes, never both --
 * same discipline as {@link SessionOpenMessage}. Range/integer
 * validation (`radioOverride.ts`'s own `isValidRadioOverride`, "0-83
 * channel / 0-255 group, both integers") is deliberately *not* this
 * module's job -- it happens once, host-side, in `server.ts`'s handler,
 * the same split {@link ProvisionWifiMessage}'s own whitespace check
 * uses (shape here, domain rules in the handler); an invalid
 * `channel`/`group` that still matches this shape is rejected there with
 * a `notice`, never written. */
export type SetRadioOverrideMessage =
  | { type: "set-radio-override"; deviceId: number; channel: number; group: number }
  | { type: "set-radio-override"; deviceId: number; clear: true };

/** Every message shape a client may send. */
export type ClientMessage =
  | SessionOpenMessage
  | SessionCloseMessage
  | LineMessage
  | SendCommandMessage
  | FlashStartMessage
  | FlashLocalBeginMessage
  | ForgetDeviceMessage
  | SetRadioOverrideMessage
  | GetWifiCredentialsMessage
  | SetWifiCredentialsMessage
  | ProvisionWifiMessage;

/** Ask what network the host would provision robots onto -- answered to
 * this client alone with {@link WifiCredentialsMessage}. */
export interface GetWifiCredentialsMessage {
  type: "get-wifi-credentials";
  /** Include the password in the reply -- only ever at a person's
   * explicit request (the Configuration tab's "show the password in the
   * code" control). */
  reveal?: boolean;
}

/** Store a network in the host's persistent state. An empty `password`
 * keeps the one already held for the same SSID. Answered with a fresh
 * {@link WifiCredentialsMessage}. */
export interface SetWifiCredentialsMessage {
  type: "set-wifi-credentials";
  ssid: string;
  password: string;
}

/** Write the stored network to one robot's credential slot
 * (`WIFICRED SET`) over its open link. Answered with {@link
 * WifiProvisionResultMessage}. */
export interface ProvisionWifiMessage {
  type: "provision-wifi";
  linkId: string;
  slot?: number;
}

/** What a browser may know about the stored network -- the SSID and
 * whether a password is held, never the password. */
export interface WifiCredentialsMessage {
  type: "wifi-credentials";
  ssid: string | null;
  hasPassword: boolean;
  source: "stored" | "env" | "none";
  /** Present only in reply to a `reveal: true` request. */
  password?: string;
  seq: number;
}

/** The outcome of one {@link ProvisionWifiMessage}. */
export interface WifiProvisionResultMessage {
  type: "wifi-provision-result";
  linkId: string;
  ok: boolean;
  message: string;
  seq: number;
}

/** Every message shape the server may send. */
export type ServerMessage =
  | Snapshot
  | Notice
  | LineMessage
  | FlashProgressMessage
  | FlashResultMessage
  | FlashLocalReadyMessage
  | TelemetryMessage
  | WifiCredentialsMessage
  | WifiProvisionResultMessage;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isFirmwareKind(value: unknown): value is FirmwareKind {
  return value === "relay" || value === "robot";
}

function isFlagsFieldShape(value: unknown): value is { wireType: "flags"; value: number } {
  return isRecord(value) && value.wireType === "flags" && typeof value.value === "number";
}

/** Is `value` a legal {@link WireField} as parsed from JSON: a string, a
 * number, or an object shaped exactly like `@robot-console/protocol`'s
 * `FlagsField` (`{ wireType: "flags"; value: number }`)? Mirrors that
 * package's own runtime shape rather than importing its type guard,
 * since this module only ever sees already-parsed JSON, never a real
 * `FlagsField` instance. */
function isWireField(value: unknown): value is WireField {
  return typeof value === "string" || typeof value === "number" || isFlagsFieldShape(value);
}

function isWireFieldArray(value: unknown): value is WireField[] {
  return Array.isArray(value) && value.every(isWireField);
}

function isFirmwareSourceRef(value: unknown): value is FirmwareSourceRef {
  if (!isRecord(value)) {
    return false;
  }
  if (value.kind === "release") {
    return isFirmwareKind(value.firmware);
  }
  if (value.kind === "local-hex") {
    return (
      isNonEmptyString(value.uploadId) &&
      isNonEmptyString(value.fileName) &&
      isNonEmptyString(value.sha256)
    );
  }
  return false;
}

/**
 * Validate and narrow an arbitrary parsed-JSON value into a
 * {@link ClientMessage}, or `undefined` if it does not match any known
 * shape. This is the one place untrusted client input is trusted from
 * -- `server.ts` calls this before acting on anything a WebSocket
 * client sends, rather than trusting `type` and reaching into fields
 * unchecked.
 */
export function parseClientMessage(value: unknown): ClientMessage | undefined {
  if (!isRecord(value) || typeof value.type !== "string") {
    return undefined;
  }
  switch (value.type) {
    case "session-open": {
      const hasLinkId = value.linkId !== undefined;
      const hasRelayShape = value.relayLinkId !== undefined || value.name !== undefined;
      if (hasLinkId === hasRelayShape) {
        // Neither shape present, or both at once -- exactly one is legal.
        return undefined;
      }
      if (hasLinkId) {
        return isNonEmptyString(value.linkId) ? { type: "session-open", linkId: value.linkId } : undefined;
      }
      return isNonEmptyString(value.relayLinkId) && isNonEmptyString(value.name)
        ? { type: "session-open", relayLinkId: value.relayLinkId, name: value.name }
        : undefined;
    }
    case "session-close":
      return isNonEmptyString(value.linkId) ? { type: "session-close", linkId: value.linkId } : undefined;
    case "get-wifi-credentials":
      return value.reveal === true ? { type: "get-wifi-credentials", reveal: true } : { type: "get-wifi-credentials" };
    case "set-wifi-credentials":
      return isNonEmptyString(value.ssid) && typeof value.password === "string"
        ? { type: "set-wifi-credentials", ssid: value.ssid, password: value.password }
        : undefined;
    case "provision-wifi": {
      if (!isNonEmptyString(value.linkId)) {
        return undefined;
      }
      if (value.slot !== undefined && !(Number.isInteger(value.slot) && (value.slot as number) >= 0)) {
        return undefined;
      }
      return value.slot !== undefined
        ? { type: "provision-wifi", linkId: value.linkId, slot: value.slot as number }
        : { type: "provision-wifi", linkId: value.linkId };
    }
    case "line":
      return isNonEmptyString(value.linkId) &&
        value.direction === "tx" &&
        typeof value.line === "string"
        ? { type: "line", linkId: value.linkId, direction: "tx", line: value.line }
        : undefined;
    case "send-command": {
      if (!isNonEmptyString(value.linkId) || !isNonEmptyString(value.verb)) {
        return undefined;
      }
      if (value.fields !== undefined && !isWireFieldArray(value.fields)) {
        return undefined;
      }
      return value.fields !== undefined
        ? { type: "send-command", linkId: value.linkId, verb: value.verb, fields: value.fields }
        : { type: "send-command", linkId: value.linkId, verb: value.verb };
    }
    case "flash-start":
      return isNonEmptyString(value.linkId) && isFirmwareSourceRef(value.source)
        ? { type: "flash-start", linkId: value.linkId, source: value.source }
        : undefined;
    case "flash-local-begin":
      return isNonEmptyString(value.fileName) &&
        typeof value.byteLength === "number" &&
        Number.isFinite(value.byteLength) &&
        value.byteLength > 0 &&
        isNonEmptyString(value.sha256)
        ? {
            type: "flash-local-begin",
            fileName: value.fileName,
            byteLength: value.byteLength,
            sha256: value.sha256,
          }
        : undefined;
    case "forget-device":
      return Number.isInteger(value.deviceId)
        ? { type: "forget-device", deviceId: value.deviceId as number }
        : undefined;
    case "set-radio-override": {
      if (!Number.isInteger(value.deviceId)) {
        return undefined;
      }
      const deviceId = value.deviceId as number;
      const hasClear = value.clear !== undefined;
      const hasChannelOrGroup = value.channel !== undefined || value.group !== undefined;
      if (hasClear === hasChannelOrGroup) {
        // Neither shape present, or both at once -- exactly one is
        // legal (mirrors session-open's own "hasLinkId === hasRelayShape"
        // guard above).
        return undefined;
      }
      if (hasClear) {
        return value.clear === true ? { type: "set-radio-override", deviceId, clear: true } : undefined;
      }
      return typeof value.channel === "number" && typeof value.group === "number"
        ? { type: "set-radio-override", deviceId, channel: value.channel, group: value.group }
        : undefined;
    }
    default:
      return undefined;
  }
}
