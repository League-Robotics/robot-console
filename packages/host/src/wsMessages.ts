/**
 * wsMessages.ts — the one WebSocket message contract between `server.ts`
 * and the browser UI (`packages/ui`).
 *
 * Per `docs/design/specification.md` §4.7: one WebSocket carries
 * endpoint-list updates and line traffic (telemetry frames join this
 * same channel in a later sprint). Per sprint 4's reshape (this
 * ticket): the shape is `type`-discriminated so every consumer can
 * share one connection and dispatch on `type`, and it lives in exactly
 * one place so both sides of the socket agree on it.
 *
 * This module is pure type/shape definitions plus small, dependency-free
 * type guards for the client -> server direction (server.ts needs to
 * validate untrusted JSON arriving over the socket). It holds no naming,
 * framing, or sequencing logic of its own -- see `server.ts`'s own doc
 * comment for why that boundary matters.
 *
 * ## Sprint 4 reshape -- endpoint/session vocabulary, frozen here
 *
 * Every message and type below was reshaped once, deliberately, in this
 * one ticket rather than incrementally across the sprint (see
 * `sprint.md`'s Design Rationale: "Freeze the wire contract entirely in
 * ticket 001") so every later ticket builds against one stable shape
 * instead of a moving target. The renames, in one place for the next
 * reader:
 *
 *   - `DeviceListEntry` -> {@link EndpointListEntry}: a device (a
 *     physical USB board) and an endpoint (a listable, routable thing)
 *     are different concepts that happen to coincide 1:1 for USB this
 *     sprint, but won't once a relay fronts several robots (sprint 7).
 *     Gains `endpointId` (URL-safe: `usb-<serial>`, since sprint 4's
 *     router puts it in a path segment), `transport`, `resourceKey`
 *     (see below), and `classification`. `linkOpen`/`linkError` ->
 *     `sessionOpen`/`sessionError`, since "session" (one open logical
 *     link) is the concept that generalizes across transports, where
 *     "link" implied a single physical connection.
 *   - `resourceKey` is a distinct field from `endpointId`, even though
 *     they are equal for every endpoint this sprint (USB is 1:1). It
 *     exists now, unused-but-equal, so sprint 7's relay-carries-many-
 *     robots case (one contended physical resource serving several
 *     routable endpoints) extends this model instead of requiring a
 *     second redesign of every call site that reads a key. This is
 *     intentional, not dead code.
 *   - `DevicesMessage` -> {@link EndpointsMessage} (`type: "devices"` ->
 *     `"endpoints"`); still always a full snapshot, never a delta (see
 *     that type's own doc comment) -- nothing in this reshape changes
 *     that self-healing property.
 *   - `open`/`close` client messages -> {@link SessionOpenMessage}/
 *     {@link SessionCloseMessage} (`type: "session-open"`/
 *     `"session-close"`), matching the `sessionOpen`/`sessionError`
 *     rename above. `SessionOpenMessage` gains an optional `robotName`,
 *     reserved for sprint 7 (a relay routing to one of several named
 *     robots) -- always absent and unused this sprint.
 *   - `LineMessage`/`ErrorMessage`'s `deviceId` -> `endpointId`, for the
 *     same device/endpoint distinction as above.
 *   - `FlashStartMessage`/`FlashProgressMessage`/`FlashResultMessage`
 *     carry a {@link FirmwareSourceRef} (`source`) instead of a bare
 *     {@link FirmwareKind} (`firmware`), so a flash can name either a
 *     configured release build or a locally-uploaded hex file
 *     (`flash-local-*`, new this sprint -- see below) through the same
 *     message shape.
 *   - {@link FlashPhase} gains `"reidentifying"`, after `"resetting"`:
 *     the stage where the server waits for the freshly-flashed board to
 *     announce itself again before reporting the terminal result (a
 *     later ticket -- see {@link FlashResultMessage}'s doc comment).
 *   - New {@link FlashLocalBeginMessage} (client -> server) and
 *     {@link FlashLocalReadyMessage} (server -> client): the JSON half
 *     of the local-hex upload handshake. The binary half is one raw
 *     WebSocket frame -- `uploadId` (ASCII, exactly
 *     {@link UPLOAD_ID_BYTE_LENGTH} bytes) immediately followed by the
 *     raw file bytes, with no length prefix or delimiter (the socket
 *     frame boundary *is* the message boundary) -- documented here as a
 *     convention; `localHexUpload.ts` (ticket 005) is the concrete
 *     handler that splits, verifies, and holds the frame's bytes, and
 *     `server.ts`'s `isBinary` branch is what routes a binary frame to
 *     it.
 *
 * ## Sprint 6 addition -- one generic `send-command`, not per-verb messages
 *
 * Sprint 6 (drive/`STATUS`/`GET`/`SET`/e-stop controls) needs a second
 * client -> server verb-sending path alongside {@link LineMessage}'s raw
 * text: {@link SendCommandMessage} names a verb and an optional
 * {@link WireField} list and lets `deviceRegistry.ts` (ticket 003)
 * decide how to dispatch it through `@robot-console/protocol`'s
 * `Session` -- sequenced verbs via `Session.send()`, everything else
 * (including `STATUS`, which is unsequenced despite sitting next to the
 * sequenced verbs on the Robot page) via `Session.sendUnsequenced()`.
 * Deliberately **one** message shape rather than one per verb: verb
 * classification (`isSequencedVerb`) is singly owned by
 * `@robot-console/protocol`'s `session.ts` and must never be duplicated
 * here, where it would drift from that module -- a per-verb message set
 * would force exactly that duplication onto this file. `WireField` is
 * already JSON-serializable as parsed (`number | string | FlagsField`,
 * and `FlagsField` is already a plain `{ wireType: "flags"; value:
 * number }` object), so no new wire-value encoding is introduced here.
 *
 * {@link EndpointListEntry} gains `sequencing`, present only while a
 * session is open (mirroring {@link EndpointListEntry.sessionError}'s
 * present-only-when-relevant shape) -- ticket 003 populates it from the
 * same `Session` (`seq`/`pendingCount`/`lastDone`/`lastDoneReason`) and
 * ticket 004's UI store reads it for SUC-003. It lives on this
 * already-full-snapshot message rather than its own event stream, for
 * the same self-healing reason the rest of `EndpointsMessage` does: a
 * client that missed one snapshot gets fully-current sequencing state
 * on the next, never a delta it needs to reconcile.
 *
 * ## Forward compatibility: an unrecognized `classification.type`
 *
 * `EndpointListEntry.classification.type` is a {@link DeviceType}
 * (`"unknown" | "relay" | "robot"`). A future fourth type is designed
 * to be purely additive on the wire (see `@robot-console/protocol`'s
 * `deviceType.ts` module doc comment) -- a client built against
 * *today's* two-type union that receives a `type` value it does not
 * recognize from a newer host **must** treat it as `"unknown"` (via
 * `normalizeDeviceType`) rather than crashing or rendering nothing.
 *
 * Direction:
 *   - client -> server: {@link SessionOpenMessage}, {@link SessionCloseMessage},
 *     {@link LineMessage} (always `direction: "tx"` in this direction),
 *     {@link SendCommandMessage}, {@link FlashStartMessage},
 *     {@link FlashLocalBeginMessage}, {@link ForgetKnownRobotMessage}.
 *   - server -> client: {@link EndpointsMessage}, {@link LineMessage}
 *     (always `direction: "rx"` in this direction -- an inbound line
 *     from the device), {@link ErrorMessage}, {@link FlashProgressMessage},
 *     {@link FlashResultMessage}, {@link FlashLocalReadyMessage},
 *     {@link TelemetryMessage} (sprint 009 ticket 002).
 *   `LineMessage` is one shared shape used in both directions,
 *   discriminated further by its own `direction` field.
 */

import type { DeviceClassification, WireField } from "@robot-console/protocol";

/** Which firmware a flash operation targets, when the source is a
 * configured release build. `"relay"` is the radio-relay board's
 * firmware, `"robot"` the diff-drive robot's -- see `config.ts`'s
 * `FirmwareConfigMap` for how each maps to a configured
 * `<repo-url>:<tag>` source. */
export type FirmwareKind = "relay" | "robot";

/** Where the hex a flash operation writes comes from: a configured
 * release build (`config.ts`/`releases.ts`, the only source that
 * exists before this sprint), or a file the student picked from their
 * own machine and uploaded over the socket (`local-hex`, new this
 * sprint -- the local-hex upload handshake itself, per the module doc
 * comment, is not implemented by this ticket). `local-hex`'s
 * `fileName`/`sha256` are carried here (not just the `uploadId`) so a
 * client that reconnects mid-flash can still show what's being
 * flashed. */
export type FirmwareSourceRef =
  | { kind: "release"; firmware: FirmwareKind }
  | { kind: "local-hex"; uploadId: string; fileName: string; sha256: string };

/** Stage of an in-flight flash, in the order `deviceRegistry.ts`
 * reports them: `"fetching"`/`"verifying"` come from `releases.ts`
 * resolving and checking the hex; `"erasing"`/`"writing"`/`"resetting"`
 * come from `flash.ts` writing it to the board; `"reidentifying"` (new
 * this sprint) is the server waiting for the freshly-flashed board to
 * announce itself again before the terminal {@link FlashResultMessage}
 * is sent -- see that type's own doc comment. Purely informational for
 * the UI's progress text -- nothing in this module depends on the
 * ordering. */
export type FlashPhase = "fetching" | "verifying" | "erasing" | "writing" | "resetting" | "reidentifying";

/** Which transport an endpoint is reachable over. `"usb"` was the only
 * value through sprint 6 (a board plugged directly into this machine).
 * Sprint 7 ticket 002 extends this union for the three relay/remote
 * transports its architecture defines: `"relay-radio"` (a local USB
 * relay, `RelayRadioLink`), `"mbrelay"` (a remote TCP relay,
 * `MbrelayLink`, ticket 003), and `"mbserial"` (a remote TCP link
 * straight to one robot's serial port, `MbserialLink`, ticket 004).
 * This is a type-only extension, per this module's "no logic of its
 * own" contract (see the module doc comment) -- only `"relay-radio"`
 * has a concrete `LinkSpec`/`Link` as of ticket 002; nothing in
 * `packages/host`/`packages/ui` constructs an endpoint carrying any of
 * these three new values yet (sprint 8's job -- endpoint synthesis from
 * discovery). Sprint 10 ticket 002 adds `"wifi"`: a direct-to-robot TCP
 * link to a roster-gated `_robotlink._tcp`/`_robotlink._udp` advertisement
 * (`wifi/wifiRobotGate.ts`), reusing `MbserialLink` unchanged (see
 * `link/Link.ts`'s `WifiLinkSpec` doc comment and this sprint's Design
 * Rationale, "TCP over UDP, reusing `MbserialLink` unchanged"). Endpoint
 * synthesis for `"wifi"` is ticket 003's job -- this ticket only extends
 * the type. An older client that does not recognize `"wifi"` degrades
 * per this module's own forward-compatibility discipline (see the
 * module doc comment's "Forward compatibility" section for the sibling
 * `classification.type` case). */
export type EndpointTransport = "usb" | "relay-radio" | "mbrelay" | "mbserial" | "wifi";

/** Sprint 8 ticket 004: every value {@link EndpointListEntry.addressSource}
 * can report -- `mbrelayRegistry.ts`'s own three registry-resolution
 * outcomes (`"config"`/`"registry"` for an authoritative reply,
 * `"derived"` for a registry that only echoed its own guess,
 * `"local-derived"` for no registry reachable at all), plus
 * `"explicit"` for a caller-supplied radio override that bypassed
 * resolution entirely. Structurally identical to (but independently
 * declared from) `relay/RelayConnectionCoordinator.ts`'s own
 * `CoordinatorAddressSource` -- this module never imports host-internal
 * modules, per its own "no logic of its own" contract (see the module
 * doc comment), so `deviceRegistry.ts` assigns that module's values into
 * this type by structural typing rather than a shared declaration. */
export type AddressSource = "config" | "registry" | "derived" | "local-derived" | "explicit";

/** Sprint 8 ticket 004: one candidate `RelayConnectionCoordinator.ts`
 * tried and abandoned before the one that ultimately succeeded (or,
 * for a connection attempt reported as exhausted, every candidate
 * given) -- mirrors that module's own `FailoverTrailEntry` structurally,
 * for the same reason {@link AddressSource} does. `reason` is
 * diagnostic text only, never parsed by a client. */
export interface FailoverTrailEntry {
  name: string;
  transport: "relay-radio" | "mbrelay" | "mbserial";
  reason: string;
}

/** USB-specific identity fields, present on {@link EndpointListEntry}
 * only when {@link EndpointListEntry.transport} is `"usb"`. Nested
 * (rather than flattened onto the entry) so a future remote endpoint
 * (no local serial number, no OS port path) does not carry meaningless
 * nulls for fields that only make sense for a physically-attached
 * board -- and so a consumer can tell "no port because this endpoint
 * is remote" apart from "no port because this USB device is HID-only"
 * (`devices.ts`'s `DeviceAvailability` already models that third
 * state) instead of both collapsing to the same `null`. */
export interface UsbEndpointIdentity {
  /** Full USB serial number of the DAPLink interface chip -- the same
   * value `endpointId` is derived from (`usb-<serialNumber>`). */
  serialNumber: string;
  /** Short display form of {@link serialNumber}, sliced from its
   * board-unique middle field (`devices.ts`'s `shortSerialDisplay`) --
   * safe to show next to two boards that share an interface-chip
   * build's prefix/suffix. */
  displaySerial: string;
  /** OS serial port path, or `null` if this device was only found on
   * its HID persona (`devices.ts`'s `DeviceAvailability`). */
  port: string | null;
}

/** One endpoint as shown on the front page: a listable, routable
 * thing, distinct from the physical device or the session backing it
 * (see the module doc comment's "Sprint 4 reshape" section, and
 * `sprint.md`'s Step 1). Keyed by {@link endpointId} across snapshots. */
export interface EndpointListEntry {
  /** Stable, URL-safe id for this endpoint across snapshots -- minted
   * as `usb-<serialNumber>` for a USB endpoint so it can be used
   * directly as a router path segment (`/d/:endpointId`) with no
   * encode/decode step. */
  endpointId: string;
  /** Which transport this endpoint is reachable over. See that type's
   * own doc comment. */
  transport: EndpointTransport;
  /** The physical resource this endpoint contends for exclusive access
   * to, distinct from {@link endpointId} -- see the module doc
   * comment's "Sprint 4 reshape" section for why this field exists now
   * even though it always equals `endpointId` this sprint (USB is
   * 1:1). Never assume `resourceKey === endpointId` in new code --
   * that equality is a this-sprint fact, not an invariant. */
  resourceKey: string;
  /** This endpoint's device-type classification, derived from its most
   * recently seen banner (or the lack of one) via
   * `@robot-console/protocol`'s `classifyBanner`. Drives the per-type
   * page dispatch (`classification.type`) and diagnostics
   * (`classification.role`/`commonName`/`dialect`/`evidence`). */
  classification: DeviceClassification;
  /** Banner role token (e.g. `"RADIOBRIDGE"`, `"NEZHA2"`), populated
   * once a link to this device is open; `null` before that, or if the
   * open attempt failed or timed out (e.g. a silently-running board
   * that never replies to `HELLO`). Kept as its own top-level field
   * (verbatim, identical to {@link DeviceClassification.role}) for
   * diagnostics and forward compatibility -- a UI or log line reading
   * `role` directly should never need to reach into `classification`
   * for it. */
  role: string | null;
  /** Five-letter friendly name from `swdName.ts`, or `null` while
   * unresolved or unresolvable. Never a USB-serial-derived fallback --
   * see `swdName.ts`'s own module doc for why. */
  name: string | null;
  /** Present only when SWD name resolution failed. `reason`/`message`
   * mirror `swdName.ts`'s `SwdNameFailure` so the UI can show *why*,
   * never silently omit the device or invent a fallback name. */
  nameError?: { reason: string; message: string };
  /** Whether `server.ts` currently has an open session (a link, for a
   * USB endpoint) to this endpoint. Renamed from `linkOpen` -- see the
   * module doc comment. */
  sessionOpen: boolean;
  /** Present only when the most recent session-open attempt failed
   * (e.g. a `HELLO` reply timeout against a silent board). Cleared on
   * a subsequent successful open. Renamed from `linkError` -- see the
   * module doc comment. */
  sessionError?: string;
  /** Sequencing state from `@robot-console/protocol`'s `Session` for
   * this endpoint's open session -- `seq`/`pendingCount`/`lastDone`/
   * `lastDoneReason` mirror that class's own fields of the same names
   * verbatim. Present only while
   * {@link sessionOpen} is `true` (mirroring {@link sessionError}'s
   * present-only-when-relevant shape), so a client can distinguish
   * "session open, nothing pending yet" (`pendingCount: 0`) from "no
   * session, or talking to a server too old to send this field"
   * (`undefined`). Populated by ticket 003; this ticket only freezes
   * the shape. New this sprint -- see the module doc comment's "Sprint
   * 6 addition" section. */
  sequencing?: { seq: number; pendingCount: number; lastDone: number; lastDoneReason: string };
  /** Present only while a flash is in flight for this endpoint --
   * absent the rest of the time, mirroring {@link sessionError}'s
   * present-only-when-relevant shape. A reconnecting client sees this
   * in the next full snapshot even if it missed every
   * {@link FlashProgressMessage} along the way, so it never renders a
   * stale, clickable flash button for an endpoint mid-operation. */
  flashStatus?: { firmware: FirmwareKind; phase: FlashPhase };
  /** USB-specific identity fields -- see {@link UsbEndpointIdentity}'s
   * own doc comment. Present only when {@link transport} is `"usb"`,
   * which is every endpoint that exists this sprint. */
  usb?: UsbEndpointIdentity;
  /** Sprint 10 ticket 003: present only when {@link transport} is
   * `"wifi"` -- the gated WiFi robot's `host`/`port` (the same pair
   * `deviceRegistry.ts` builds a `WifiLinkSpec` from on `session-open`),
   * so a client can display where a not-yet-connected WiFi card would
   * connect to. No {@link usb} block accompanies a WiFi-transport entry
   * -- there is no physical device backing it (see `deviceRegistry.ts`'s
   * `EndpointState.device` doc comment for why that field is itself
   * optional now). */
  wifi?: { host: string; port: number };
  /** The most recent parsed `status` reply from this endpoint (added
   * out-of-process, 2026-09-09) -- see {@link RobotStatus}. Present
   * once any `status` (or bare `estop`) reply has been seen on the
   * current session; cleared when the session closes. The host polls
   * `STATUS` itself on an open robot session, so this stays fresh
   * without the client asking. */
  robotStatus?: RobotStatus;
  /** The robot's `RUN`-able function list as reported by its `funcs
   * <name> [signature]` reply lines to the most recent `FUNCS` (added
   * out-of-process, 2026-09-09). Reset to `[]` every time a `FUNCS` is
   * sent, then grows one entry per reply line, so a client sees the
   * list fill in. Absent until the first `FUNCS` of the session. */
  functions?: RobotFunction[];
  /** OOP 2026-09-09, extended sprint 8 ticket 004: present only on an
   * endpoint the host synthesized for a robot reached THROUGH a relay
   * (`transport: "relay-radio"`/`"mbrelay"`): which relay endpoint
   * carries it, the robot name the user asked for (or the coordinator's
   * default-failover flow settled on), and the radio address in use.
   * Such an endpoint has no {@link usb} block of its own -- the relay
   * owns the USB port -- and shares the relay's `resourceKey` for
   * `"relay-radio"`/`"mbrelay"`, so flashing the relay and driving
   * through it are mutually exclusive. Its `endpointId` is
   * `<relayEndpointId>-via-<robotName>` regardless of which transport
   * `RelayConnectionCoordinator.ts` ultimately connected through -- see
   * `deviceRegistry.ts`'s own `usbEndpointId` doc comment for the
   * naming precedent this mirrors. **Absent** for a synthesized endpoint
   * reached via `"mbserial"` (that transport has no `channel`/`group` to
   * report at all -- `RelayConnectionCoordinator.ts`'s own module doc
   * comment) and for every non-synthesized entry. */
  viaRelay?: { relayEndpointId: string; robotName: string; channel: number; group: number };
  /** Sprint 8 ticket 004: which of `RelayConnectionCoordinator.ts`'s
   * outcomes produced the address currently in use, for the disclosure
   * chip (ticket 006) -- see {@link AddressSource}'s own doc comment for
   * the five possible values. Present only for a relay-mediated
   * (`transport: "relay-radio"`/`"mbrelay"`), non-`mbserial` endpoint
   * with an open session -- mirrors {@link sessionError}'s
   * present-only-when-relevant discipline. */
  addressSource?: AddressSource;
  /** Sprint 8 ticket 004: every candidate `RelayConnectionCoordinator.ts`
   * abandoned before reaching {@link name} -- an empty array (never
   * absent) whenever {@link addressSource} is present and the first
   * candidate tried already succeeded. Present under the exact same
   * condition as {@link addressSource}. */
  failoverTrail?: FailoverTrailEntry[];
  /** Sprint 13 ticket 001: present only while the relay's own entry has
   * an in-flight or recently-failed radio-bridging attempt -- absent
   * once the attempt succeeds (at that point "connected" is derived
   * from the synthesized `-via-<name>` child endpoint's existence + open
   * session, not from this field) or once superseded by a later
   * attempt. Mirrors {@link sessionError}'s present-only-when-relevant
   * discipline. See `deviceRegistry.ts`'s `openRobotViaRelay` for where
   * this is set and cleared, and `sprint.md` (sprint 013) Architecture
   * for the full state flow (Idle/Connecting/Connected/Failed). */
  relayBridge?: {
    state: "connecting" | "failed";
    /** The robot name the attempt is/was targeting. Absent for a
     * no-pick default-failover attempt where the eventual candidate
     * name isn't known yet (see sprint 013 sprint.md, Open
     * Questions). */
    robotName?: string;
    /** Every candidate name considered for this attempt, in order. Only
     * populated once known -- see sprint.md's Open Questions for when
     * ticket 002 populates this (expected: only at `state: "failed"`,
     * not during `"connecting"`). */
    triedNames?: string[];
    /** Present only when `state === "failed"` -- the same message text
     * `openRobotViaRelay` already builds for `emitError`, reused
     * verbatim (see sprint.md Open Questions: one message, not two). */
    error?: string;
  };
}

/** A parsed `status k=v ...` reply (robot firmware `wire_handler.cpp`
 * `execStatus`). `fields` is every `k=v` pair verbatim, order-free;
 * the named booleans are derived host-side from the `flags=<hex>`
 * bitfield (`wire_adapter.h`: bit0 ready, bit1 estopped, bit2 stall-
 * halted, bit3 lease-expired) so a client never has to know the bit
 * layout. `estopped` is also forced `true` the moment a bare `estop`
 * reply (the `ESTOP` verb's own acknowledgement) is seen, ahead of the
 * next `status` poll confirming it. */
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

/** One `funcs <name> [signature]` reply line. `signature` is the
 * rest of the line after the name when the firmware reports one
 * (today's firmware omits it -- `captures/funcs-run-acceptance-
 * 20260907`), so a client must treat its absence as "parameters
 * unknown", never as "takes none". */
export interface RobotFunction {
  name: string;
  signature?: string;
}

/** Which way a line is travelling on the shared `"line"` message shape:
 * `"tx"` — client -> server -> device; `"rx"` — device -> server ->
 * client. */
export type LineDirection = "tx" | "rx";

/** A single protocol line, either sent to a device (`direction: "tx"`,
 * client -> server) or received from one (`direction: "rx"`, server ->
 * client). `line` is the raw wire text (no trailing newline). */
export interface LineMessage {
  type: "line";
  endpointId: string;
  direction: LineDirection;
  line: string;
  /** `"poll"` marks a line the host sent or received on its own
   * initiative -- the periodic `STATUS` poll behind
   * {@link EndpointListEntry.robotStatus} -- rather than on behalf of
   * a user action (added out-of-process, 2026-09-09). Absent for every
   * other line. A console may hide poll traffic by default; nothing
   * else should key on it. */
  origin?: LineOrigin;
}

/** See {@link LineMessage.origin}. */
export type LineOrigin = "poll";

/** Server -> client: one decoded telemetry event for an endpoint (sprint
 * 009 ticket 002) -- either a header update, when a `thdr` line arrives
 * or changes, or one decoded frame, when a `t` line successfully zips
 * against the currently held header. Never both on the same message;
 * `deviceRegistry.ts` sends one or the other, never a combined message.
 *
 * Deliberately its own message type (`type: "telemetry"`), distinct from
 * {@link LineMessage} (bounded by `MAX_LINES_PER_DEVICE`, feeds the
 * console log -- the wrong vehicle for a 20 Hz structured-data stream)
 * and from {@link EndpointsMessage} (a deliberately infrequent full
 * snapshot -- folding 20 Hz data into it would mean re-broadcasting the
 * entire endpoint list 20 times a second). See sprint.md's Design
 * Rationale #2.
 *
 * A `t` frame that arrives with no header held for the endpoint (or one
 * that fails to zip against the held header, a field-count mismatch)
 * produces no {@link TelemetryMessage} at all -- the client's own
 * default per-endpoint state already reads as "waiting for header" (see
 * `deviceRegistry.ts`'s own header-recovery doc comment), so there is
 * nothing useful to forward until a `thdr` (or a decodable `t`) arrives. */
export interface TelemetryMessage {
  type: "telemetry";
  endpointId: string;
  /** Present only on a header update -- the ordered column names from
   * the most recent `thdr` line, verbatim (no validation, no scaling;
   * see `@robot-console/protocol`'s `v6/telemetry.ts` module doc
   * comment for why this module holds no column-name knowledge at
   * all). */
  header?: readonly string[];
  /** Present only on a decoded frame -- `header[i]` -> the `t` line's
   * `fields[i]`, raw wire text, completely unconverted (unit conversion
   * for named columns like `ox`/`oy`/`oh`/`rotation`/`omega` is a
   * consumer-side concern, applied only where those names happen to be
   * present -- see `v6/telemetry.ts`'s own doc comment). */
  frame?: Record<string, string>;
}

/** Client -> server: send one protocol verb, with optional fields, to an
 * endpoint's open session -- the structured alternative to
 * {@link LineMessage}'s raw text, added this sprint (see the module doc
 * comment's "Sprint 6 addition" section for why this is one generic
 * message rather than one per verb). `deviceRegistry.ts` (ticket 003)
 * is the one place that decides, via `@robot-console/protocol`'s
 * `isSequencedVerb`, whether `verb` goes through `Session.send()`
 * (sequenced) or `Session.sendUnsequenced()` (everything else,
 * including `STATUS`) -- that classification is never re-derived here.
 * `fields` omitted is equivalent to an empty array, for bare verbs like
 * `GET` with no arguments. */
export interface SendCommandMessage {
  type: "send-command";
  endpointId: string;
  verb: string;
  fields?: WireField[];
}

/** Per-firmware availability, as `server.ts`'s `FirmwareAvailabilityCache`
 * (`releases.ts`) reports it. `configured: false` means `config.ts`
 * found no `<repo-url>:<tag>` env value for this {@link FirmwareKind} --
 * the button stays disabled with no network check ever attempted.
 * `configured: true` always carries `repoUrl`/`tag` (so the UI can show
 * what will be flashed) plus the live `available` result of the most
 * recent poll; `reason` is present only when `available` is `false`
 * (e.g. `"no-releases"`), mirroring {@link EndpointListEntry.nameError}'s
 * present-only-when-relevant shape.
 *
 * `message` (added out-of-process, 2026-09-08) is the specific diagnostic
 * `releases.ts`'s `resolveRelease` already computes for the failure --
 * e.g. `` `release v0.20260909.1 is missing MICROBIT.hex` `` -- carried
 * across the wire alongside `reason` so a client can show *why*, not
 * just which short token failed. Present under the same condition as
 * `reason` (only when `available` is `false`, and never set for the
 * cache's own pre-poll `"not-yet-checked"` placeholder, which never ran
 * `resolveRelease` at all). Deliberately **not** a substitute for
 * `reason`: `reason` stays the stable token every existing branch
 * switches on (`deviceDisplay.ts`'s `firmwareDisabledReason`); `message`
 * is additive, free-text, and only for a diagnostic surface (e.g. a
 * details disclosure) aimed at whoever is troubleshooting the setup, not
 * the calm student-facing summary. An older host that never sends this
 * field, or a client built before it existed, both degrade cleanly: the
 * field is optional on the wire and every reader treats its absence as
 * "no extra detail available", never as malformed input. Never populated
 * from a raw caught exception or stack trace -- see `resolveRelease`'s
 * own doc comment for what it does and does not put in `message`. */
export type FirmwareAvailability =
  | { configured: false }
  | { configured: true; repoUrl: string; tag: string; available: boolean; reason?: string; message?: string };

/** The wire projection of sprint 5's `KnownRobotRecord`
 * (`store/knownRobots.ts`) -- a name the host has seen before over USB
 * and might reach again, **not** a routable {@link EndpointListEntry}.
 * Deliberately a separate, independent shape rather than a field
 * folded into `EndpointListEntry`: an entry models something with a
 * `resourceKey` that can hold a session and be flashed, and a
 * remembered robot has none of those things -- it is just a name and a
 * last-seen time. Only the fields a consumer needs this sprint are
 * carried; `firstSeenAt`/`lastType` from `KnownRobotRecord` are
 * deliberately omitted (see this ticket) as speculative generality with
 * no reader yet. `lastUsbSerial` is a display hint only, exactly as in
 * `KnownRobotRecord` -- never authoritative for matching an incoming
 * device to this entry, since the name and the USB serial come from
 * different chips and can drift apart. */
export interface RememberedRobotEntry {
  name: string;
  lastSeenAt: string;
  lastSeenVia: "usb";
  lastRole: string | null;
  lastUsbSerial: string;
}

/** Sprint 8 ticket 001/004: a discovered `_mbrelay._tcp` service, wire
 * projection of `discovery/mdnsDiscovery.ts`'s `RelayService`. Like
 * {@link RememberedRobotEntry}, deliberately **not** an
 * {@link EndpointListEntry} -- a bare discovery has no `resourceKey` and
 * no session, and forcing it into that vocabulary would mean inventing
 * placeholder values for fields that don't apply (see `sprint.md`'s
 * Design Rationale). `registryPort` is omitted (never sent as
 * `undefined`) when the service's TXT record carried no parseable
 * `registry=<port>` field. */
export interface DiscoveredRelayEntry {
  instanceName: string;
  host: string;
  port: number;
  registryPort?: number;
}

/** Sprint 8 ticket 001/004: a discovered `_mbserial._tcp` service, wire
 * projection of `discovery/mdnsDiscovery.ts`'s `RobotService`.
 * `instanceName` **is** the target robot's five-letter name directly --
 * see that module's own doc comment. */
export interface DiscoveredRobotEntry {
  instanceName: string;
  host: string;
  port: number;
}

/** Sprint 8 ticket 004: the current mDNS discovery snapshot, split by
 * service type -- mirrors `discovery/mdnsDiscovery.ts`'s own
 * `MdnsDiscoverySnapshot` shape one to one. Always present on
 * {@link EndpointsMessage} with both lists defaulting to `[]` (never an
 * omitted field), matching {@link RememberedRobotEntry}'s own
 * always-present-even-when-empty discipline. */
export interface DiscoveredServicesSnapshot {
  relays: DiscoveredRelayEntry[];
  robots: DiscoveredRobotEntry[];
}

/** Server -> client: the full current endpoint list. Sent once on
 * connect and again on every live attach/detach/state change -- always
 * a full snapshot, never a delta, so a client that missed an update
 * self-heals on the next one. This full-snapshot property is
 * deliberately preserved by the sprint 4 reshape -- nothing added here
 * may turn this into anything resembling a delta; high-frequency data
 * (lines, telemetry, flash progress) stays on its own message types.
 * `firmwareStatus` is sent as part of this same snapshot rather than a
 * separate message, for the same self-healing reason: a client that
 * connects or reconnects after an availability change gets it on the
 * very next `endpoints` message with no separate discovery step.
 * Renamed from `DevicesMessage`/`type: "devices"` -- see the module doc
 * comment.
 *
 * `rememberedRobots` (sprint 5) is a second, independent top-level
 * snapshot list, not folded into `endpoints` -- see
 * {@link RememberedRobotEntry}'s own doc comment for why a remembered
 * robot isn't an `EndpointListEntry`. It upholds the same full-snapshot
 * property as the rest of this message: always the complete remembered
 * roster, always present (an empty array when there is nothing
 * remembered, never an omitted field, so a client can tell "no
 * remembered robots" apart from "talking to a server old enough not to
 * send this field"). */
export interface EndpointsMessage {
  type: "endpoints";
  endpoints: EndpointListEntry[];
  firmwareStatus: Record<FirmwareKind, FirmwareAvailability>;
  rememberedRobots: RememberedRobotEntry[];
  /** Sprint 8 ticket 004: the current mDNS discovery snapshot (relays +
   * robots) -- see {@link DiscoveredServicesSnapshot}'s own doc comment.
   * A separate, independent top-level list, never folded into
   * `endpoints`, for the same reason {@link rememberedRobots} isn't. */
  discoveredServices: DiscoveredServicesSnapshot;
}

/** Client -> server: open (or re-open, e.g. after a failed attempt) a
 * session to an endpoint. Renamed from `OpenDeviceMessage`/`type:
 * "open"` -- see the module doc comment. */
export interface SessionOpenMessage {
  type: "session-open";
  endpointId: string;
  /** Reserved since sprint 4, live since the 2026-09-09 OOP relay work
   * and extended by sprint 8 ticket 004: which of a relay's several
   * routable robots to open a session to, when `endpointId` names an
   * endpoint classified `"relay"`. `deviceRegistry.ts#requestOpen`
   * forwards this straight through as its `target.robotName` -- see that
   * method's own doc comment. Note: this message shape has no way to
   * ask for `deviceRegistry.ts`'s own default-failover candidate list
   * (every remembered/discovered name, most-recently-seen first) --
   * that capability exists host-side (`requestOpen(endpointId, {})`)
   * but is not yet reachable over the wire; wiring a dropdown's "no
   * selection" state to it is left to whichever ticket adds that UI
   * affordance. */
  robotName?: string;
  /** OOP 2026-09-09: the radio address to tune the relay to for
   * `robotName`. Optional -- when absent the host derives it from the
   * name (`@robot-console/protocol`'s `nameToRadioAddress`). Needed
   * because a robot image may listen on a fixed address instead of its
   * name-derived one (the calibration template hardcodes channel 55 /
   * group 114 for every board). Ignored unless `robotName` is set. */
  radio?: { channel: number; group: number };
  /** Sprint 8 ticket 005: request `deviceRegistry.ts#requestOpen`'s
   * default-failover candidate list (every remembered/discovered name,
   * most-recently-seen first -- `buildDefaultFailoverCandidates`)
   * instead of a single named candidate. Set only when `robotName` is
   * absent -- `RelayPage`'s Connect action with the dropdown's
   * placeholder still selected sends exactly `{ type: "session-open",
   * endpointId, autoRobot: true }`, no `robotName`, no `radio` (a radio
   * override only makes sense alongside an explicit name). The literal
   * type `true` (not `boolean`) mirrors {@link FirmwareSourceRef}'s own
   * discriminated-literal style: `false` has no meaning here distinct
   * from the field's own absence, so it is never a legal value. */
  autoRobot?: true;
}

/** Client -> server: close an open session to an endpoint. Renamed
 * from `CloseDeviceMessage`/`type: "close"` -- see the module doc
 * comment. */
export interface SessionCloseMessage {
  type: "session-close";
  endpointId: string;
}

/** Client -> server: flash the given {@link FirmwareSourceRef} onto an
 * endpoint. `deviceRegistry.ts` runs this through the same per-endpoint
 * mutex as `session-open`/`session-close`, so it queues behind (or
 * blocks) an in-flight operation on the same board rather than racing
 * it. */
export interface FlashStartMessage {
  type: "flash-start";
  endpointId: string;
  source: FirmwareSourceRef;
}

/** Server -> client: one stage of an in-flight flash. Sent as the flash
 * progresses through {@link FlashPhase}; the corresponding endpoint's
 * {@link EndpointListEntry.flashStatus} carries the same `firmware`/
 * `phase` pair for a client that connects mid-flash. */
export interface FlashProgressMessage {
  type: "flash-progress";
  endpointId: string;
  source: FirmwareSourceRef;
  phase: FlashPhase;
}

/** Server -> client: the terminal outcome of a flash -- exactly one of
 * these is sent per `flash-start`, after which
 * {@link EndpointListEntry.flashStatus} for that endpoint is cleared.
 * `message` is present only on `status: "error"`, carrying a
 * human-readable reason for the UI to display.
 *
 * `classification`/`name`/`reidentify` are present only on
 * `status: "ok"`, and only their *type* exists as of this ticket --
 * `deviceRegistry.ts` does not populate them yet. It still clears
 * `flashStatus` and reports this message immediately after a
 * successful write, exactly as before the sprint 4 reshape. A later
 * ticket makes them real: waiting for the freshly-flashed board to
 * re-announce (reporting `"reidentifying"` via
 * {@link FlashProgressMessage} while it waits) and populating
 * `classification`/`name` from that new banner, or setting
 * `reidentify: "timeout"` if it never arrives. */
export interface FlashResultMessage {
  type: "flash-result";
  endpointId: string;
  source: FirmwareSourceRef;
  status: "ok" | "error";
  message?: string;
  /** The endpoint's post-flash classification. Present only on
   * `status: "ok"`; not yet populated by this ticket (see this type's
   * own doc comment). */
  classification?: DeviceClassification;
  /** The endpoint's post-flash SWD name (unchanged by a flash in
   * practice, but re-read alongside re-identify for one consistent
   * post-flash snapshot). Present only on `status: "ok"`; not yet
   * populated by this ticket. */
  name?: string | null;
  /** Present only on `status: "ok"`, and only when the post-flash
   * re-identify attempt never received a banner in time -- the write
   * itself succeeded, so this is reported as "waiting for the board to
   * come back", never as a failure. Not yet populated by this ticket. */
  reidentify?: "timeout";
}

/** Client -> server: begin a local-hex upload. The UI computes
 * `fileName`/`byteLength`/`sha256` from the file the student picked,
 * client-side, before sending anything -- so the server can reject an
 * oversized file (per `sprint.md`'s >4MB limit) before allocating a
 * buffer for it. Part of the local-hex upload handshake documented in
 * the module doc comment; not yet implemented by this ticket (a later
 * ticket adds `localHexUpload.ts` and the server-side handler). */
export interface FlashLocalBeginMessage {
  type: "flash-local-begin";
  fileName: string;
  byteLength: number;
  sha256: string;
}

/** Server -> client: the server is ready to receive the binary frame
 * for a local-hex upload it did not reject. `uploadId` is what the
 * client prefixes the upcoming binary frame with, and later references
 * in a `flash-start` message's `source`. See the module doc comment's
 * binary-frame convention and {@link UPLOAD_ID_BYTE_LENGTH}. */
export interface FlashLocalReadyMessage {
  type: "flash-local-ready";
  uploadId: string;
}

/** Exact byte length of the ASCII `uploadId` prefix on the local-hex
 * upload's binary WebSocket frame (an ASCII-encoded UUID, e.g.
 * `"3fa85f64-5717-4562-b3fc-2c963f66afa6"`). The frame is
 * `uploadId || payload` with no length prefix or delimiter between
 * them -- the receiver reads exactly this many bytes as the id and
 * treats everything after as the file's raw bytes. Documented here so
 * ticket 005's implementation and this module agree on the convention
 * without re-deriving it. `localHexUpload.ts`'s `LocalHexUploadManager`
 * is the concrete implementation of this convention (ticket 005) --
 * `receiveFrame` there is the one place a raw binary frame is actually
 * split using this constant; this module only documents the shape. */
export const UPLOAD_ID_BYTE_LENGTH = 36;

/** Client -> server: forget a remembered robot -- `deviceRegistry.ts`
 * (ticket 003) is the write gate that removes it from
 * `KnownRobotsStore` and, in turn, the next `EndpointsMessage.rememberedRobots`
 * snapshot no longer carries it. `name` mirrors
 * {@link RememberedRobotEntry.name}, matching {@link SessionCloseMessage}'s
 * shape exactly: a single required string field, no optional fields. */
export interface ForgetKnownRobotMessage {
  type: "forget-known-robot";
  name: string;
}

/** Server -> client: something went wrong. `endpointId` is present when
 * the error is scoped to one endpoint (a failed session open, a send to
 * an endpoint with no open session); absent for a connection-level
 * problem (malformed message). Never thrown as an uncaught exception on
 * the server side -- see `server.ts` and `deviceRegistry.ts`'s own doc
 * comments. */
export interface ErrorMessage {
  type: "error";
  endpointId?: string;
  message: string;
}

/** Every message shape a client may send. */
export type ClientMessage =
  | SessionOpenMessage
  | SessionCloseMessage
  | LineMessage
  | SendCommandMessage
  | FlashStartMessage
  | FlashLocalBeginMessage
  | ForgetKnownRobotMessage
  | GetWifiCredentialsMessage
  | SetWifiCredentialsMessage
  | ProvisionWifiMessage;

/** OOP 2026-09-10: ask what network the host would provision robots
 * onto -- answered to this client alone with {@link WifiCredentialsMessage}. */
export interface GetWifiCredentialsMessage {
  type: "get-wifi-credentials";
  /** OOP 2026-09-11: include the password in the reply -- only ever at
   * a person's explicit request (the Configuration tab's "show the
   * password in the code" control). */
  reveal?: boolean;
}

/** OOP 2026-09-10: store a network in the host's persistent state. An
 * empty `password` keeps the one already held for the same SSID. Answered
 * with a fresh {@link WifiCredentialsMessage}. */
export interface SetWifiCredentialsMessage {
  type: "set-wifi-credentials";
  ssid: string;
  password: string;
}

/** OOP 2026-09-10: write the stored network to one robot's credential
 * slot (`WIFICRED SET`) over its open link. Answered with
 * {@link WifiProvisionResultMessage}. */
export interface ProvisionWifiMessage {
  type: "provision-wifi";
  endpointId: string;
  slot?: number;
}

/** OOP 2026-09-10: what a browser may know about the stored network --
 * the SSID and whether a password is held, never the password. */
export interface WifiCredentialsMessage {
  type: "wifi-credentials";
  ssid: string | null;
  hasPassword: boolean;
  source: "stored" | "env" | "none";
  /** Present only in reply to a `reveal: true` request. */
  password?: string;
}

/** OOP 2026-09-10: the outcome of one {@link ProvisionWifiMessage}. */
export interface WifiProvisionResultMessage {
  type: "wifi-provision-result";
  endpointId: string;
  ok: boolean;
  message: string;
}

/** Every message shape the server may send. */
export type ServerMessage =
  | EndpointsMessage
  | LineMessage
  | ErrorMessage
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
 * package's own runtime shape rather than importing its type guard, since
 * this module only ever sees already-parsed JSON, never a real
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
      if (!isNonEmptyString(value.endpointId)) {
        return undefined;
      }
      if (value.robotName !== undefined && !isNonEmptyString(value.robotName)) {
        return undefined;
      }
      if (value.autoRobot !== undefined && value.autoRobot !== true) {
        return undefined;
      }
      if (value.robotName === undefined) {
        return value.autoRobot === true
          ? { type: "session-open", endpointId: value.endpointId, autoRobot: true }
          : { type: "session-open", endpointId: value.endpointId };
      }
      if (value.radio === undefined) {
        return { type: "session-open", endpointId: value.endpointId, robotName: value.robotName };
      }
      if (
        !isRecord(value.radio) ||
        !Number.isInteger(value.radio.channel) ||
        !Number.isInteger(value.radio.group)
      ) {
        return undefined;
      }
      return {
        type: "session-open",
        endpointId: value.endpointId,
        robotName: value.robotName,
        radio: { channel: value.radio.channel as number, group: value.radio.group as number },
      };
    }
    case "session-close":
      return isNonEmptyString(value.endpointId)
        ? { type: "session-close", endpointId: value.endpointId }
        : undefined;
    case "get-wifi-credentials":
      return value.reveal === true ? { type: "get-wifi-credentials", reveal: true } : { type: "get-wifi-credentials" };
    case "set-wifi-credentials":
      return isNonEmptyString(value.ssid) && typeof value.password === "string"
        ? { type: "set-wifi-credentials", ssid: value.ssid, password: value.password }
        : undefined;
    case "provision-wifi": {
      if (!isNonEmptyString(value.endpointId)) {
        return undefined;
      }
      if (value.slot !== undefined && !(Number.isInteger(value.slot) && (value.slot as number) >= 0)) {
        return undefined;
      }
      return value.slot !== undefined
        ? { type: "provision-wifi", endpointId: value.endpointId, slot: value.slot as number }
        : { type: "provision-wifi", endpointId: value.endpointId };
    }
    case "line":
      return isNonEmptyString(value.endpointId) &&
        value.direction === "tx" &&
        typeof value.line === "string"
        ? { type: "line", endpointId: value.endpointId, direction: "tx", line: value.line }
        : undefined;
    case "send-command": {
      if (!isNonEmptyString(value.endpointId) || !isNonEmptyString(value.verb)) {
        return undefined;
      }
      if (value.fields !== undefined && !isWireFieldArray(value.fields)) {
        return undefined;
      }
      return value.fields !== undefined
        ? { type: "send-command", endpointId: value.endpointId, verb: value.verb, fields: value.fields }
        : { type: "send-command", endpointId: value.endpointId, verb: value.verb };
    }
    case "flash-start":
      return isNonEmptyString(value.endpointId) && isFirmwareSourceRef(value.source)
        ? { type: "flash-start", endpointId: value.endpointId, source: value.source }
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
    case "forget-known-robot":
      return isNonEmptyString(value.name)
        ? { type: "forget-known-robot", name: value.name }
        : undefined;
    default:
      return undefined;
  }
}
