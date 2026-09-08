/**
 * Link.ts — the transport-agnostic link surface every transport
 * implements: `UsbSerialLink` this sprint, `RelayRadioLink`/
 * `MbrelayLink` in sprint 7 (per `docs/design/specification.md` §4.3 —
 * every transport reduces to the same shape, a paced, banner-aware
 * stream of newline-delimited protocol-v6 lines).
 *
 * ## `connect()` / `identify()`, not one `open()`
 *
 * The previous shape, `open(): Promise<ParsedBanner>`, threw when no
 * banner arrived in time. That conflates two independent things: the
 * transport failing outright (a port that will not open, a socket that
 * refuses to connect) and the transport succeeding but nothing
 * answering `HELLO` (a relay whose target robot is silent — a normal
 * state a relay page must render, not an exception). Splitting them:
 *
 * - {@link Link.connect} establishes the transport only — port open /
 *   socket connect and listener attachment. No `HELLO`, no banner
 *   wait. Throws only on a transport-level failure.
 * - {@link Link.identify} sends `HELLO` and waits for the banner reply.
 *   Resolves `null` on timeout instead of rejecting — a healthy
 *   transport with nothing answering is a normal, representable
 *   outcome. **Never throws.** It may be called again after a `null`
 *   resolution without re-connecting the transport underneath it.
 *
 * That last property is also the fix for
 * `port-lock-contention-between-identify-and-user-open.md`: the
 * transport opens exactly once, in `connect()`, and stays open across
 * every later `identify()` attempt or user-initiated retry — there is
 * no repeated open/close cycle on the same physical resource for the
 * OS to contend over.
 *
 * ## No `retarget()`
 *
 * A relay's data plane has no in-band escape once a target robot is
 * selected (protocol.md §6, UC-004 step 5) — over TCP a break cannot
 * even be sent. Switching a relay's target is close-session -> new
 * `LinkSpec` -> open-session, never a method on an existing `Link`.
 * This interface deliberately has no `retarget()` — its absence is
 * what stops a future change from adding one that the wire protocol
 * cannot actually support.
 */
import type { AckNackEvent, DecodedLine, ParsedBanner, Session, WireField } from "@robot-console/protocol";

export type LineListener = (line: DecodedLine) => void;
export type AckNackListener = (event: AckNackEvent) => void;
export type LinkErrorListener = (err: Error) => void;

/** The transport-agnostic link surface — see the module doc comment. */
export interface Link {
  /** The `@robot-console/protocol` `Session` backing this link's
   * sequencing state (id counter, pending-retransmit table, `seq`/
   * `pendingCount`/`lastDone`/`lastDoneReason`) — already satisfied by
   * `UsbSerialLink`'s own `session` getter, frozen onto the interface
   * here (sprint 6 ticket 002) so `deviceRegistry.ts` reads sequencing
   * state and dispatches `sendCommand`/`sendUnsequenced` through this
   * one accessor without ever branching on which concrete transport it
   * holds. That directly serves sprint 7's relay reuse, where a second
   * `Link` implementation exists alongside `UsbSerialLink`. */
  readonly session: Session;

  /** Establish the transport (open the port / connect the socket) and
   * attach listeners. Never sends `HELLO`, never waits for a banner.
   * Throws only on a transport-level failure. */
  connect(): Promise<void>;

  /** Send `HELLO` and wait for the banner reply. Resolves the parsed
   * banner, or `null` if no banner-shaped reply arrives within the
   * implementation's configured timeout. Never throws. May be called
   * again after a `null` resolution — see the module doc comment. */
  identify(): Promise<ParsedBanner | null>;

  /** Close the transport. Idempotent. */
  close(): Promise<void>;

  /** Send an already-formatted line verbatim, paced like every other
   * write. */
  sendLine(line: string): void;

  /** Send one of the 11 id-bearing verbs, sequenced via the protocol
   * package's `Session.send()`. Paced like every other write. Returns
   * the exact line text sent. */
  sendCommand(verb: string, fields?: readonly WireField[]): string;

  /** Send an unsequenced verb via `Session.sendUnsequenced()`. Paced
   * like every other write. Refuses `"HELLO"` — see `Session`'s own
   * doc comment. */
  sendUnsequenced(verb: string, fields?: readonly WireField[]): string;

  /** Send `PING` — the liveness probe to use instead of re-sending
   * `HELLO` once a session is live. */
  checkLiveness(): void;

  /** Subscribe to every inbound reply-direction line. Returns an
   * unsubscribe function. */
  onLine(listener: LineListener): () => void;

  /** Subscribe to `ack`/`nack` events specifically. Returns an
   * unsubscribe function. */
  onAckNack(listener: AckNackListener): () => void;

  /** Subscribe to transport-level errors that occur after {@link
   * connect} has already resolved. Returns an unsubscribe function. */
  onError(listener: LinkErrorListener): () => void;
}

/**
 * The USB serial transport variant of {@link LinkSpec} — pure data, no
 * behavior. `resourceKey` identifies the contended physical resource
 * this spec opens; for USB this sprint it is always equal to the
 * endpoint's own id (one physical device, one endpoint, one resource —
 * see `wsMessages.ts`'s own `resourceKey` doc comment for why the field
 * exists at all even though it is redundant with `endpointId` until
 * sprint 7's relay-carries-many-robots case).
 */
export interface UsbLinkSpec {
  transport: "usb";
  resourceKey: string;
  /** OS device path, e.g. `/dev/tty.usbmodemXXXX` — translated to the
   * platform's open-safe callout path by the implementation, not by
   * the spec itself (see `UsbSerialLink`'s own doc comment). */
  portPath: string;
}

/**
 * The local USB relay transport variant of {@link LinkSpec} (sprint 7
 * ticket 002) — pure data, mirroring {@link UsbLinkSpec}'s own shape and
 * discipline exactly. `resourceKey` **is** the relay's own `usb-<serial>`
 * (sprint 4's model): driving through the relay and flashing the relay
 * are mutually exclusive through the existing `KeyedMutex`, with no new
 * locking mechanism (`sprint.md`'s Resource keying section). `channel`/
 * `group` are the radio address `RelayCommandPlane`'s `!CG` step tunes
 * the relay to — this ticket takes no position on how they get chosen
 * (a default derivation or a registry lookup); that is sprint 8's job,
 * per this ticket's own Description.
 */
export interface RelayLinkSpec {
  transport: "relay-radio";
  resourceKey: string;
  /** OS device path of the local USB relay, e.g.
   * `/dev/tty.usbmodemXXXX` — translated to the platform's open-safe
   * callout path by {@link RelayRadioLink}, exactly as {@link
   * UsbLinkSpec.portPath} is by `UsbSerialLink`. */
  portPath: string;
  /** Radio channel to tune the relay to via `!CG <channel> <group>`. */
  channel: number;
  /** Radio group to tune the relay to via `!CG <channel> <group>`. */
  group: number;
}

/**
 * Pure data describing which transport to open and how — one variant
 * per transport. {@link UsbLinkSpec} exists since sprint 4; {@link
 * RelayLinkSpec} is added this sprint (sprint 7 ticket 002).
 * `MbrelayLinkSpec`/`MbserialLinkSpec` follow in tickets 003/004. Being
 * pure data (not a link instance) makes a spec loggable, comparable by
 * value, and testable with no I/O at all.
 */
export type LinkSpec = UsbLinkSpec | RelayLinkSpec;

/** Builds a {@link Link} for a given {@link LinkSpec}. Replaces the
 * previous `(portPath: string) => UsbSerialLinkLike` shape — a pure
 * data-in/link-out factory, so a caller (or a test) can construct and
 * compare specs without ever touching I/O. */
export type LinkFactory = (spec: LinkSpec) => Link;
