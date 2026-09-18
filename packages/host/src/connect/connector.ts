/**
 * connector.ts — `connectAndIdentify`, the one connect→attach→identify
 * path for every transport (sprint 015 ticket 001; issue
 * `rearch-05-connector-reconciler-harvester-retire-deviceregistry.md`;
 * `docs/design/architecture.md` §8, "Connector and reconciler"). Replaces
 * the four bespoke paths `deviceRegistry.ts` dispatched through its own
 * `defaultLinkFactory` for `UsbSerialLink`/`RelayRadioLink`/`MbrelayLink`/
 * `MbserialLink` — all deleted by ticket 003, along with the old
 * `link/Link.ts` interface those paths built on (ticket 015-010).
 *
 * ## What ticket 001 built vs. what ticket 003 added
 *
 * Ticket 001 built the connector in isolation, verified only against the
 * shared fake `ByteStream` harness (`link/__fixtures__/FakeByteStream.js`)
 * — not yet wired into the reconciler (ticket 002 does that) and without
 * the known-robots placeholder-device merge (SUC-003/SUC-004). Ticket 003
 * adds two things to this same file: the real harvester behind the
 * {@link HarvesterAttach} seam below (a narrow interface ticket 001
 * defined and stubbed with a no-op default so this module's own
 * signature never had to change), and `mergeUsbPlaceholderIfAny` (below,
 * near the failure-recording helpers) — see that function's own doc
 * comment for the merge itself. Sprint 017 ticket 006 adds a sibling,
 * `mergeNamePlaceholderIfAny`, generalizing the merge to any transport's
 * first identification (not only `usb`) — see its own doc comment,
 * directly below `mergeUsbPlaceholderIfAny`.
 *
 * ## `LinkRow.address` shapes, by transport
 *
 * `links.address` is free-form JSON (architecture.md §4); this module
 * is the one place that gives each `transport` value a concrete shape:
 *
 * - `usb`: `{ path: string; hidPath?: string | null }` — mirrors
 *   `watchers/usbWatcher.ts`'s own `usbLinkAddress()`.
 * - `wifi` / `mbserial`: `{ host: string; port: number }` — mirrors
 *   `watchers/mdnsWatcher.ts`'s own `handleWifi`/`handleMbserial`.
 * - `radio` / `mbrelay`: `{ relayLinkId: string; channel: number; group:
 *   number }` — architecture.md §4's own words for a radio link
 *   ("names the relay link it rides on and the (channel, group) used"),
 *   applied symmetrically to `mbrelay` too: both ride a relay, the only
 *   difference being whether that relay's own link is reached over a
 *   local USB port (`radio`, `relayLinkId` names a `usb`-transport link)
 *   or a remote TCP mbrelay pool (`mbrelay`, `relayLinkId` names an
 *   `mbrelay`-transport link — the row `watchers/mdnsWatcher.ts`'s
 *   `handleMbrelay` already writes for the relay's own presence). This
 *   is a ticket-001-level design call, not settled anywhere else in the
 *   sprint's architecture text — flagged here for whoever wires the
 *   reconciler (ticket 002) or a future per-robot mbrelay job to confirm
 *   against real hardware.
 *
 * ## Composing `RelayCommandPlane` as `LineLink`'s `preamble` hook
 *
 * `LineLink`'s own `preamble(stream, signal)` hook (ticket 014-005) runs
 * after `ByteStream.open()` resolves and before `connect()` returns, but
 * hands back the *raw* `ByteStream`, not the owning `LineLink` — writing
 * through `LineLink.sendLine()` during the preamble would throw
 * (`assertConnected` — the link is not `"connected"` yet), and reading
 * through `LineLink.onLine()` would run relay boot text and `#`-prefixed
 * command-plane replies through `@robot-console/protocol`'s `receive()`,
 * which is meaningless before the data plane is reached (see
 * `RelayCommandPlane.ts`'s own doc comment, "Raw lines, not decoded v6
 * lines"). This module resolves both problems the same way `RelayRadioLink`/
 * `MbrelayLink` did, minus their own hand-rolled reassembly: it gives
 * `RelayCommandPlane.ts`'s `runRelayCommandPlane` a `write` backed by a
 * dedicated, short-lived `WritePacer` writing straight to the raw
 * `ByteStream` (paced like every other write this codebase makes), and a
 * `subscribe` backed by `LineLink.onRawLine()` — reusing `LineLink`'s own
 * `LineReassembler` output rather than re-deriving line framing. A `#`-
 * prefixed relay reply decodes as `classifyLine`'s `"foreign"` bucket
 * (`v6/codec.ts`), so `LineLink` dispatches it as an ordinary unrouted
 * raw line during the preamble — exactly what `onRawLine` needs. Because
 * `LineLink` is constructed with this `preamble` function already
 * closed over a *forward reference* to the `LineLink` instance itself
 * (assigned immediately after construction, before `connect()` is ever
 * called), `onRawLine` is always available by the time the preamble
 * actually runs.
 *
 * ## Exclusivity: acquire-then-always-release, not held for the session
 *
 * Per this ticket's own Description: `board_owner` (usb) / `relay_leases`
 * (radio, mbrelay) is acquired before opening the transport and released
 * in a `finally` covering the whole attempt — success included. This
 * mirrors `watchers/usbWatcher.ts`'s own `attach()`, which holds
 * `board_owner` only around its SWD-naming critical section, not for the
 * life of a session: the OS already gives exclusive access to an open
 * serial port/TCP socket, so `board_owner`/`relay_leases` here exist to
 * serialize *attempts* (so two connector calls racing the same physical
 * resource do not both try to open it), not to reserve the resource for
 * as long as a session stays open.
 *
 * ## `KeyedMutex`, relocated
 *
 * `./keyedMutex.js` (moved from `deviceRegistry.ts`, `.tails` pruning
 * fixed — see that module's own doc comment) serializes concurrent
 * `connectAndIdentify` calls that would otherwise race the same
 * `board_owner`/`relay_leases` resource key, so a second caller queues
 * behind the first's whole attempt instead of both racing the same
 * acquire and one failing loudly for no operational reason.
 *
 * ## Ticket 016-002: helpers exported for `connect/relayBridger.ts`
 *
 * This module itself is unchanged behaviorally by sprint 016 — its own
 * single-candidate, no-reset radio/mbrelay `attempt()` path (and every
 * test in `connector.test.ts`) still behaves exactly as it did before.
 * What changed is that several previously-private helpers below
 * (address parsing, relay-physical resolution, exclusivity
 * acquire/release, the `RelayCommandPlane`-as-preamble composer,
 * cancellable identify, and failure recording) are now `export`ed, so
 * the new sibling module `connect/relayBridger.ts` — which adds a
 * per-candidate reset step and a multi-candidate default-failover loop
 * neither of which belongs in this module (sprint.md's own Design
 * Rationale: "relayBridger.ts is a new sibling module to connector.ts,
 * not a rewrite") — reuses this logic verbatim rather than duplicating
 * it.
 */
import {
  bannerNameMatchesSerial,
  classifyBanner,
  deviceIdToName,
  type DeviceClassification,
  type ParsedBanner,
} from "@robot-console/protocol";
import { LineLink, type ByteStream, type LineLinkOptions } from "../link/LineLink.js";
import { serialStream } from "../link/adapters/serialStream.js";
import { tcpStream } from "../link/adapters/tcpStream.js";
import { realScheduler, WritePacer, type Scheduler } from "../link/pacing.js";
import {
  DEFAULT_IDENTIFY_BUDGET_MS,
  DEFAULT_IDENTIFY_SCHEDULE_MS,
  identifyWithBootWindowRetry,
} from "../link/bootWindowIdentify.js";
import { runRelayCommandPlane } from "../link/RelayCommandPlane.js";
import { Store, type DeviceKind, type Transport } from "../store/index.js";
import { mergeNamePlaceholderIfAny } from "../store/placeholderMerge.js";
import { KeyedMutex } from "./keyedMutex.js";
import type { RelayLeaseRevocation } from "./relayLeaseRevocation.js";

// ---------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------

/** The minimal read model of a `links` row this module needs — `id`/
 * `transport` plus its `address` (either already-parsed JSON, or the raw
 * JSON-text column value straight from `Store.snapshotRows()`; this
 * module parses a string itself so either can be passed unmodified). */
export interface LinkRow {
  readonly id: string;
  readonly transport: Transport;
  readonly address: unknown;
  /** The device this link's row is already associated with, if any --
   * for a `usb` link, this is populated by `watchers/usbWatcher.ts`'s SWD
   * naming pass (run before this module ever sees the link) and read
   * back here for the host-identity cross-check below (item E, team-lead
   * 2026-09-13). `undefined` when the caller does not track this (e.g. a
   * relay/radio candidate `relayBridger.ts` builds its own `LinkRow`
   * for), which this module treats identically to `null` (no cross-check
   * possible or needed). */
  readonly deviceId?: number | null;
}

/** What a successful {@link Connector.connectAndIdentify} call hands to
 * {@link HarvesterAttach.attach} and returns to its own caller. Named
 * `ConnectedSession`, not `Session`, to avoid colliding with
 * `@robot-console/protocol`'s own `Session` class (sequencing state,
 * already exposed via `LineLink.session`). */
export interface ConnectedSession {
  readonly linkId: string;
  readonly deviceId: number;
  readonly transport: Transport;
  readonly link: LineLink;
  readonly classification: DeviceClassification;
}

/** The harvester-attach seam (ticket 003 supplies the real
 * implementation) — narrow and injectable per this ticket's own
 * Implementation Plan, so wiring the real harvester in later never
 * changes this module's own signature. */
export interface HarvesterAttach {
  attach(session: ConnectedSession): void;
}

/** Exported (ticket 016-002) so `connect/relayBridger.ts` can reuse the
 * same no-op default rather than redefining an identical stub. */
export const NO_OP_HARVESTER: HarvesterAttach = {
  attach(): void {
    // Stubbed until ticket 003 — see the module doc comment.
  },
};

export interface ConnectorDeps {
  /** Injectable USB serial adapter factory. Defaults to the real {@link
   * serialStream}; tests substitute a factory returning a
   * `FakeByteStream`. */
  createSerialStream?: (path: string) => ByteStream;
  /** Injectable TCP adapter factory (wifi/mbserial direct, and the
   * physical transport under a `radio`/`mbrelay` relay hop). Defaults to
   * the real {@link tcpStream}. `ip`, when given, is the resolved IPv4
   * address `watchers/mdnsWatcher.ts` already stored on the link
   * (018-007) — dialed directly instead of ever resolving `host` again
   * here. */
  createTcpStream?: (host: string, port: number, ip?: string) => ByteStream;
  /** Builds the `LineLink` wrapping a {@link ByteStream}. Defaults to
   * `new LineLink(stream, options)`; overridable so a test can spy on
   * the link the connector drives. */
  createLineLink?: (stream: ByteStream, options: LineLinkOptions) => LineLink;
  /** Governs the boot-window resend schedule, the relay preamble's write
   * pacing, and `RelayCommandPlane`'s own waits. Defaults to {@link
   * realScheduler}; tests substitute a fake that resolves instantly. */
  scheduler?: Scheduler;
  /** Wall-clock reader for every store timestamp. Defaults to
   * `Date.now`. */
  now?: () => number;
  /** The harvester-attach seam — see {@link HarvesterAttach}. Defaults
   * to a no-op stub. */
  harvester?: HarvesterAttach;
  /** The shared revocation seam (`connect/relayLeaseRevocation.ts`) this
   * module consults before opening a `usb`-transport link that is
   * already known to be a relay device — see {@link
   * takeoverDirectOpenSweep}'s own doc comment (sprint 019 ticket 001,
   * SUC-001). Optional: omitted (a composition with no sweeper concept
   * at all — no test in this repository ever wires one but this
   * ticket's own), a direct relay session-open never attempts a
   * takeover (there is nothing to take over from), but a known relay's
   * port-lock failure is still reclassified — with no sweeper possible
   * in this composition, any such failure is external by construction.
   * `runtime.ts` always wires the same instance handed to
   * `watchers/relaySweeper.ts` and `connect/relayBridger.ts`. */
  revocation?: RelayLeaseRevocation;
}

export interface ConnectorOptions {
  /** Bounds `LineLink.connect()` (transport open + relay preamble, if
   * any). Default {@link DEFAULT_CONNECT_TIMEOUT_MS}. */
  connectTimeoutMs?: number;
  /** `HELLO` resend offsets, ms from connect. Default {@link
   * DEFAULT_IDENTIFY_SCHEDULE_MS}. */
  identifySchedule?: readonly number[];
  /** Total budget for the boot-window identify sequence — passed as the
   * link's own `identifyTimeoutMs`. Default {@link
   * DEFAULT_IDENTIFY_BUDGET_MS}. */
  identifyBudgetMs?: number;
  /** Per-step timeout for the relay command-plane handshake
   * (`!CG`/`!GO` confirmation waits). Default is
   * `RelayCommandPlane.ts`'s own default (3000ms) when omitted. */
  relayHandshakeTimeoutMs?: number;
  /** Cap on the exponential backoff used to compute a failed link's
   * `next_retry_at` (architecture.md §8: "capped at 60 s"). Default
   * {@link DEFAULT_BACKOFF_CAP_MS}. */
  backoffCapMs?: number;
  /** Bound on how long a direct relay session-open waits for a
   * `relaySweeper.ts` pass it has just taken over to actually hand back
   * the relay's port before proceeding regardless — see {@link
   * takeoverDirectOpenSweep}'s own doc comment (sprint 019 ticket 001).
   * Default {@link DEFAULT_DIRECT_OPEN_TAKEOVER_MAX_WAIT_MS}. */
  directOpenTakeoverMaxWaitMs?: number;
  /** Poll interval while waiting for the sweep to hand back the relay
   * during a direct-open takeover. Default {@link
   * DEFAULT_DIRECT_OPEN_TAKEOVER_POLL_MS}. */
  directOpenTakeoverPollMs?: number;
}

export interface Connector {
  /** Acquire exclusivity, open the transport, run the relay preamble if
   * any, identify over the boot window, and on success upsert
   * `devices`/`sessions` and mark the link `connected` — cancellable via
   * `signal` at every await. See the module doc comment for the full
   * contract. Rejects (never an unhandled rejection — every internal
   * await is wrapped) after recording `links.state = 'failed'` with
   * backoff fields and releasing any acquired owner/lease. */
  connectAndIdentify(link: LinkRow, signal: AbortSignal): Promise<ConnectedSession>;
}

export const DEFAULT_CONNECT_TIMEOUT_MS = 5000;
export const DEFAULT_BACKOFF_CAP_MS = 60_000;
/** Write pacing for the relay preamble's own dedicated `WritePacer` —
 * matches every other transport's write cadence in this codebase
 * (`link/LineLink.ts`'s own default). Exported (ticket 016-002) so
 * `connect/relayBridger.ts` paces its own reset-then-preamble writes
 * identically. */
export const RELAY_PREAMBLE_WRITE_PACE_MS = 10;

// ---------------------------------------------------------------------
// Address shapes — see the module doc comment's own section. Exported
// (ticket 016-002) so `connect/relayBridger.ts` — a sibling module that
// reuses this same address-parsing logic rather than duplicating it, per
// sprint.md's own Design Rationale — can share these shapes verbatim.
// ---------------------------------------------------------------------

export interface UsbAddress {
  readonly path: string;
  readonly hidPath?: string | null;
}
export interface TcpAddress {
  readonly host: string;
  readonly port: number;
  /** Resolved IPv4 address (018-007), when `watchers/mdnsWatcher.ts` has
   * observed one for this service — see that module's own doc comment.
   * Absent for a link stored before this ticket landed, or if no A
   * record was ever seen; `buildStreamPlan` below falls back to
   * `tcpStream`'s own bounded `dns.lookup` in that case, never a raw
   * `.local` hostname straight to `net.connect`. */
  readonly ip?: string;
}
export interface RelayAddress {
  readonly relayLinkId: string;
  readonly channel: number;
  readonly group: number;
}
export type ParsedAddress = UsbAddress | TcpAddress | RelayAddress;

function asRecord(raw: unknown, context: string): Record<string, unknown> {
  const value = typeof raw === "string" ? (JSON.parse(raw) as unknown) : raw;
  if (value === null || typeof value !== "object") {
    throw new Error(`connector: ${context} address is not a JSON object`);
  }
  return value as Record<string, unknown>;
}

/** Parse `link.address` into a shape matching `link.transport` — see the
 * module doc comment's own section for what each transport expects.
 * Throws a descriptive `Error` (never returns a partially-valid shape)
 * if the address does not match. */
export function parseLinkAddress(transport: Transport, raw: unknown): ParsedAddress {
  const rec = asRecord(raw, transport);
  switch (transport) {
    case "usb": {
      if (typeof rec.path !== "string") {
        throw new Error(`connector: usb address missing string "path" (got ${JSON.stringify(rec)})`);
      }
      const hidPath = typeof rec.hidPath === "string" ? rec.hidPath : null;
      return { path: rec.path, hidPath };
    }
    case "wifi":
    case "mbserial": {
      if (typeof rec.host !== "string" || typeof rec.port !== "number") {
        throw new Error(`connector: ${transport} address missing string "host"/number "port" (got ${JSON.stringify(rec)})`);
      }
      return { host: rec.host, port: rec.port, ...(typeof rec.ip === "string" ? { ip: rec.ip } : {}) };
    }
    case "radio":
    case "mbrelay": {
      if (typeof rec.relayLinkId !== "string" || typeof rec.channel !== "number" || typeof rec.group !== "number") {
        throw new Error(
          `connector: ${transport} address missing string "relayLinkId"/number "channel"/"group" (got ${JSON.stringify(rec)})`,
        );
      }
      return { relayLinkId: rec.relayLinkId, channel: rec.channel, group: rec.group };
    }
    default: {
      const exhaustive: never = transport;
      throw new Error(`connector: unrecognized transport "${String(exhaustive)}"`);
    }
  }
}

// ---------------------------------------------------------------------
// Exclusivity — board_owner (usb) or relay_leases (radio/mbrelay)
// ---------------------------------------------------------------------

export interface Exclusivity {
  readonly kind: "board_owner" | "relay_leases" | "none";
  readonly resourceKey?: string;
}

const USB_LINK_ID_PREFIX = "usb-";

/** Recovers the USB serial number from a `usb`-transport link id —
 * `watchers/usbWatcher.ts`'s own `usbLinkId()` always derives a usb
 * link's id as `usb-<serialNumber>`, which is the only place a usb
 * link's serial is recoverable from: `links.address` for `usb` carries
 * only `{path, hidPath}` (no serial field), and `board_owner` is keyed
 * by the raw USB serial, not a link id. */
export function usbSerialFromLinkId(linkId: string): string {
  if (!linkId.startsWith(USB_LINK_ID_PREFIX)) {
    throw new Error(`connector: usb link id "${linkId}" does not follow the "usb-<serial>" convention`);
  }
  return linkId.slice(USB_LINK_ID_PREFIX.length);
}

export function resolveExclusivity(link: LinkRow, address: ParsedAddress): Exclusivity {
  switch (link.transport) {
    case "usb":
      return { kind: "board_owner", resourceKey: usbSerialFromLinkId(link.id) };
    case "radio":
    case "mbrelay":
      return { kind: "relay_leases", resourceKey: (address as RelayAddress).relayLinkId };
    case "wifi":
    case "mbserial":
      return { kind: "none" };
    default: {
      const exhaustive: never = link.transport;
      throw new Error(`connector: unrecognized transport "${String(exhaustive)}"`);
    }
  }
}

export function acquireExclusivity(store: Store, exclusivity: Exclusivity, owner: string, at: number): boolean {
  if (exclusivity.kind === "none") {
    return true;
  }
  const resourceKey = exclusivity.resourceKey as string;
  return exclusivity.kind === "board_owner"
    ? store.acquireBoardOwner(resourceKey, owner, at)
    : store.acquireRelayLease(resourceKey, owner, at);
}

export function releaseExclusivity(store: Store, exclusivity: Exclusivity, owner: string): void {
  if (exclusivity.kind === "none") {
    return;
  }
  const resourceKey = exclusivity.resourceKey as string;
  if (exclusivity.kind === "board_owner") {
    store.releaseBoardOwner(resourceKey, owner);
  } else {
    store.releaseRelayLease(resourceKey, owner);
  }
}

// ---------------------------------------------------------------------
// Direct relay session-open sweep takeover (sprint 019 ticket 001;
// SUC-001; issue `bench-relay-port-contention-sweeper-vs-session.md`)
//
// A direct `session-open {linkId: <relay usb link>}` reaches this module
// through the exact same `usb`-transport `board_owner` exclusivity path
// as any other usb link (`resolveExclusivity`, above) -- `board_owner` is
// keyed by USB serial number, a resource `watchers/relaySweeper.ts`
// never touches at all. The sweeper instead holds `relay_leases` (keyed
// by the relay's own link id, `SWEEP_OWNER = "sweep"`) for the duration
// of one probe pass, and opens the *same physical serial port* directly
// (never through this module) while it does. Because these are two
// unrelated store-level locks, `acquireExclusivity` above always
// succeeds even while a sweep pass is running -- the actual contention
// is invisible at the store layer and only ever surfaces once this
// module's own `createSerialStream`/`SerialPort.open()` call reaches the
// OS, which fails the *second* concurrent open of one physical port with
// `@serialport/bindings-cpp`'s own `flock(LOCK_EX | LOCK_NB)` failure --
// literal text "Cannot lock port" (`serialport_unix.cpp`'s `open()`).
//
// `connect/relayBridger.ts`'s own `takeoverSweepLease` (016-004) already
// solved this for a *bridged* session-open, by aborting the sweep's own
// registered `AbortController` (`connect/relayLeaseRevocation.ts`'s
// shared seam) and waiting for it to hand back `relay_leases` before
// proceeding. This is the second code path that needs the identical
// guarantee: {@link takeoverDirectOpenSweep} below finds and aborts any
// sweep pass currently registered against this link (a no-op if none is
// running), then gives it a bounded window to actually let go of the
// physical port -- `relaySweeper.ts`'s own per-pass `finally` block
// closes its stream *before* deregistering from the revocation seam, so
// "no longer registered" is a reliable proxy for "the physical port is
// free again". Only ever attempted for a `usb` link already known (by an
// earlier identify) to be a relay device -- {@link isKnownRelayUsbLink}
// -- never for a plain robot's own usb link, which `relaySweeper.ts`
// never opens a sweep pass against in the first place (this also keeps
// the *reason text* below accurate: "another app has this relay open"
// would be a wrong diagnosis for a robot's own port, e.g. the recorded
// MakeCode-holds-the-board case).
//
// If the physical open *still* fails with that same "Cannot lock port"
// text after this takeover step has already run (whether it found a
// sweep to take over or not), the holder cannot be our own sweeper --
// {@link PORT_LOCK_FAILURE_PATTERN} below reclassifies that one failure
// shape into {@link RELAY_EXTERNAL_LOCK_REASON}, a plain-language reason
// distinguishable from an ordinary "no banner"/parse failure, exactly
// this ticket's own acceptance criteria.
// ---------------------------------------------------------------------

/** Default for {@link ConnectorOptions.directOpenTakeoverMaxWaitMs} --
 * mirrors `connect/relayBridger.ts`'s own `DEFAULT_TAKEOVER_MAX_WAIT_MS`
 * (comfortably above the sweeper's own worst-case handback: its current
 * `!CG`/`ID` wait, <= `relaySweeper.ts`'s `SWEEP_PROBE_TIMEOUT_MS` =
 * 500ms, plus stream-close/deregister overhead). Duplicated as its own
 * constant, not imported, for the same reason {@link
 * PORT_LOCK_FAILURE_PATTERN}'s neighbor below is duplicated rather than
 * imported: `connect/relayBridger.ts` already imports several helpers
 * *from* this module, so importing back from it would create a cycle. */
export const DEFAULT_DIRECT_OPEN_TAKEOVER_MAX_WAIT_MS = 1000;
/** Default for {@link ConnectorOptions.directOpenTakeoverPollMs}. */
export const DEFAULT_DIRECT_OPEN_TAKEOVER_POLL_MS = 25;

/** Reported verbatim in `links.state_reason` when a direct relay
 * session-open's raw port fails to lock *after* {@link
 * takeoverDirectOpenSweep} has already run (see this section's own doc
 * comment for why that ordering is what makes "genuinely external" a
 * safe conclusion). Never confused with the `board_owner`/`relay_leases`
 * "held by another owner" message above (an in-process store
 * disagreement, reported before the physical port is ever touched) --
 * this is the OS's own advisory lock failing, which only happens when a
 * different process or file handle already has the physical port open. */
export const RELAY_EXTERNAL_LOCK_REASON = "another app has this relay open";

/** `@serialport/bindings-cpp`'s own literal error text
 * (`serialport_unix.cpp`'s `open()`: ``"Error %s Cannot lock port"``, an
 * OS-level `flock(LOCK_EX | LOCK_NB)` failure) -- matched case-
 * insensitively since the surrounding `strerror()` text is platform-
 * dependent. */
export const PORT_LOCK_FAILURE_PATTERN = /cannot lock port/i;

/** Is `link` a `usb`-transport link already known (via an earlier
 * identify — `watchers/usbWatcher.ts`'s own SWD naming, or a previous
 * banner) to be a relay device? The only usb links `relaySweeper.ts`
 * ever runs a sweep pass against — see this section's own doc comment
 * for why a not-yet-identified usb link, or a known robot's own usb
 * link, is deliberately never treated as one here. */
export function isKnownRelayUsbLink(store: Store, link: LinkRow): boolean {
  if (link.transport !== "usb" || link.deviceId === undefined || link.deviceId === null) {
    return false;
  }
  const device = store.snapshotRows().devices.find((row) => Number(row.id) === link.deviceId);
  return device?.kind === "relay";
}

/**
 * Find and abort any `relaySweeper.ts` pass currently registered against
 * `linkId` in the shared `revocation` seam, then wait (bounded by
 * `maxWaitMs`, polling every `pollMs`) for it to deregister — proxy for
 * "the physical port is free again", see this section's own doc comment.
 * A no-op, resolving immediately, when `revocation` is undefined (no
 * sweeper in this composition) or nothing is currently registered for
 * `linkId` (the common case: an idle relay, or any non-relay usb link).
 * Never throws except for `signal`'s own abort; a timeout is not an
 * error here either — the caller's own subsequent physical port open is
 * what will actually fail (and be reclassified, if it is still a lock
 * failure) if the sweep genuinely never let go in time.
 */
export async function takeoverDirectOpenSweep(
  revocation: RelayLeaseRevocation | undefined,
  linkId: string,
  owner: string,
  scheduler: Scheduler,
  now: () => number,
  signal: AbortSignal,
  maxWaitMs: number,
  pollMs: number,
): Promise<void> {
  if (!revocation) {
    return;
  }
  const controller = revocation.get(linkId);
  if (!controller) {
    return;
  }
  controller.abort(new Error(`connector: takeover of relay "${linkId}" for a direct session-open by "${owner}"`));

  const deadline = now() + maxWaitMs;
  while (revocation.get(linkId) === controller) {
    if (signal.aborted) {
      throw abortError(signal);
    }
    if (now() >= deadline) {
      return;
    }
    await scheduler.delay(pollMs);
  }
}

// ---------------------------------------------------------------------
// Physical resolution for a relay hop (radio/mbrelay)
// ---------------------------------------------------------------------

export interface RelayPhysical {
  readonly transport: "usb" | "mbrelay";
  readonly address: UsbAddress | TcpAddress;
}

/** Resolve `relayLinkId` (named by a `radio`/`mbrelay` link's own
 * address) to the physical transport/address of the relay it rides —
 * read via {@link Store.snapshotRows}, never raw SQL (`store/README.md`'s
 * own rule). `expectedTransport` is the relay-link transport this
 * `link.transport` requires (`usb` for `radio`, `mbrelay` for
 * `mbrelay`) — see the module doc comment's address-shapes section. */
export function resolveRelayPhysical(store: Store, relayLinkId: string, expectedTransport: "usb" | "mbrelay"): RelayPhysical {
  const row = store.snapshotRows().links.find((candidate) => candidate.id === relayLinkId);
  if (!row) {
    throw new Error(`connector: relay link "${relayLinkId}" not found in the store`);
  }
  if (row.transport !== expectedTransport) {
    throw new Error(
      `connector: relay link "${relayLinkId}" is transport "${String(row.transport)}", expected "${expectedTransport}"`,
    );
  }
  const rec = asRecord(row.address, `relay link "${relayLinkId}"`);
  if (expectedTransport === "usb") {
    if (typeof rec.path !== "string") {
      throw new Error(`connector: relay link "${relayLinkId}" (usb) address missing string "path"`);
    }
    return { transport: "usb", address: { path: rec.path, hidPath: typeof rec.hidPath === "string" ? rec.hidPath : null } };
  }
  if (typeof rec.host !== "string" || typeof rec.port !== "number") {
    throw new Error(`connector: relay link "${relayLinkId}" (mbrelay) address missing string "host"/number "port"`);
  }
  return { transport: "mbrelay", address: { host: rec.host, port: rec.port, ...(typeof rec.ip === "string" ? { ip: rec.ip } : {}) } };
}

// ---------------------------------------------------------------------
// Relay command-plane preamble — see the module doc comment
// ---------------------------------------------------------------------

export function buildRelayPreamble(
  channel: number,
  group: number,
  getLink: () => LineLink,
  scheduler: Scheduler,
  relayHandshakeTimeoutMs: number | undefined,
  /** Ticket 016-002: forwarded verbatim to `runRelayCommandPlane`'s own
   * `syncRetryMs`/`syncAttempts` — connector.ts's own call site never
   * passes this (identical behavior to before this ticket); it exists so
   * `connect/relayBridger.ts`'s tests can shrink the sync retry loop's
   * real elapsed time (`RelayCommandPlane.ts`'s own default is 16
   * attempts x 500ms = 8s) without needing a scheduler mismatch that
   * would risk racing a synchronously-scripted reply against its own
   * step's timeout (see `connector.test.ts`'s own note on why these
   * relay-preamble tests use `realScheduler`, not an immediate one). */
  syncOptions?: { syncRetryMs?: number; syncAttempts?: number },
): (stream: ByteStream, signal: AbortSignal) => Promise<void> {
  return async (stream, signal) => {
    const pacer = new WritePacer(RELAY_PREAMBLE_WRITE_PACE_MS, scheduler);
    const write = (line: string): void => {
      pacer.schedule(
        () =>
          new Promise<void>((resolve, reject) => {
            stream.write(line, (err) => (err ? reject(err) : resolve()));
          }),
        () => {
          // No separate reporting channel exists at this pre-data-plane
          // phase -- a real write failure surfaces indirectly, either as
          // the ByteStream's own "error"/"close" event (which
          // LineLink.connect()'s open()/preamble failure handling
          // already treats as a connect failure) or as this step's own
          // confirmation wait timing out.
        },
      );
    };
    const subscribe = (listener: (line: string) => void): (() => void) => getLink().onRawLine(listener);
    await runRelayCommandPlane({
      write,
      subscribe,
      channel,
      group,
      scheduler,
      signal,
      ...(syncOptions?.syncRetryMs !== undefined ? { syncRetryMs: syncOptions.syncRetryMs } : {}),
      ...(syncOptions?.syncAttempts !== undefined ? { syncAttempts: syncOptions.syncAttempts } : {}),
      ...(relayHandshakeTimeoutMs !== undefined ? { timeoutMs: relayHandshakeTimeoutMs } : {}),
    });
  };
}

// ---------------------------------------------------------------------
// Stream construction
// ---------------------------------------------------------------------

interface StreamPlan {
  readonly stream: ByteStream;
  readonly preamble?: (stream: ByteStream, signal: AbortSignal) => Promise<void>;
}

function buildStreamPlan(
  link: LinkRow,
  address: ParsedAddress,
  store: Store,
  createSerialStream: (path: string) => ByteStream,
  createTcpStream: (host: string, port: number, ip?: string) => ByteStream,
  getLink: () => LineLink,
  scheduler: Scheduler,
  relayHandshakeTimeoutMs: number | undefined,
): StreamPlan {
  switch (link.transport) {
    case "usb": {
      const usb = address as UsbAddress;
      return { stream: createSerialStream(usb.path) };
    }
    case "wifi":
    case "mbserial": {
      const tcp = address as TcpAddress;
      return { stream: createTcpStream(tcp.host, tcp.port, tcp.ip) };
    }
    case "radio":
    case "mbrelay": {
      const relay = address as RelayAddress;
      const expected = link.transport === "radio" ? "usb" : "mbrelay";
      const physical = resolveRelayPhysical(store, relay.relayLinkId, expected);
      const stream =
        physical.transport === "usb"
          ? createSerialStream((physical.address as UsbAddress).path)
          : createTcpStream((physical.address as TcpAddress).host, (physical.address as TcpAddress).port, (physical.address as TcpAddress).ip);
      const preamble = buildRelayPreamble(relay.channel, relay.group, getLink, scheduler, relayHandshakeTimeoutMs);
      return { stream, preamble };
    }
    default: {
      const exhaustive: never = link.transport;
      throw new Error(`connector: unrecognized transport "${String(exhaustive)}"`);
    }
  }
}

// ---------------------------------------------------------------------
// Cancellable identify — races LineLink's boot-window retry against
// `signal`, closing the link (and releasing any listener it holds) the
// moment an abort fires.
// ---------------------------------------------------------------------

export function abortError(signal: AbortSignal): Error {
  const reason = (signal as { reason?: unknown }).reason;
  return reason instanceof Error ? reason : new Error(String(reason ?? "aborted"));
}

export function identifyWithAbort(
  link: LineLink,
  signal: AbortSignal,
  schedule: readonly number[],
  scheduler: Scheduler,
): Promise<ParsedBanner | null> {
  if (signal.aborted) {
    void link.close();
    return Promise.reject(abortError(signal));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const onAbort = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      void link.close();
      reject(abortError(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    identifyWithBootWindowRetry(link, schedule, scheduler).then(
      (banner) => {
        if (settled) {
          return;
        }
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve(banner);
      },
      (error: unknown) => {
        if (settled) {
          return;
        }
        settled = true;
        signal.removeEventListener("abort", onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

// ---------------------------------------------------------------------
// Failure recording
// ---------------------------------------------------------------------

export function currentFailCount(store: Store, linkId: string): number {
  const row = store.snapshotRows().links.find((candidate) => candidate.id === linkId);
  const raw = row?.fail_count;
  return typeof raw === "number" && Number.isFinite(raw) ? raw : 0;
}

export function recordFailure(store: Store, linkId: string, reason: string, at: number, backoffCapMs: number): void {
  const failCount = currentFailCount(store, linkId) + 1;
  const nextRetryAt = at + Math.min(1000 * 2 ** (failCount - 1), backoffCapMs);
  store.setLinkState({ id: linkId, state: "failed", at, reason, failCount, nextRetryAt });
}

export function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

// ---------------------------------------------------------------------
// 018-008: mbserial/WiFi bridge contention -- distinct from a genuine
// no-banner failure. See sprint 018's own bench facts: the farm bridges
// this ticket hardens (`loki` for `gopiv`, `magni` for `tigez`, `hodr`
// for `vevov`) are single-client -- a second concurrent client gets
// `ERR busy` (sometimes only right before the bridge resets the
// connection, sometimes the reset alone with no reply text at all)
// instead of a banner, and the host used to misreport either shape as a
// generic "produced no banner" failure with no way for a student (or
// the UI) to tell "this bridge is busy, try again" from "this robot is
// truly unreachable". A WiFi robot's own single TCP listener can be held
// the same way by another host process (live-bench evidence: the
// stakeholder's own `scripts/dev.mjs`, pid 82496, holding
// `192.168.1.184:7654` for the whole of a bench run) -- both transports
// ride a plain TCP stream to something a second client can find already
// held, so both are in scope here.
// ---------------------------------------------------------------------

/** `radio`/`mbrelay` are deliberately excluded -- ticket 009's own
 * mbrelay-bridging defect ("produced no banner" / "transport closed"
 * against the `torture` pool) is a different failure shape on a
 * different pool, not this ticket's concern. `usb` is excluded too: a
 * serial port closing during identify is never "another app is
 * connected" -- there is no second client to contend with a local
 * serial port the way there is with a shared network bridge. */
const CONTENTION_DETECTABLE_TRANSPORTS: ReadonlySet<Transport> = new Set<Transport>(["wifi", "mbserial"]);

export function isContentionDetectableTransport(transport: Transport): boolean {
  return CONTENTION_DETECTABLE_TRANSPORTS.has(transport);
}

/** `ERR busy` exactly, ignoring surrounding whitespace -- kept in sync
 * deliberately with `scripts/bench/layer1/mbserialProbe.ts`'s own
 * `BUSY_PATTERN`, this ticket's own live-bench reproduction of the
 * bridge's actual reply text. */
export const BRIDGE_BUSY_LINE_PATTERN = /^ERR\s+busy\s*$/i;

/** Reported verbatim in `links.state_reason` -- plain words, used by the
 * UI as-is (this ticket's own acceptance criteria: "another app is
 * connected to this bridge", never "no banner"/"transport closed"). */
export const BRIDGE_CONTENTION_REASON = "another app is connected to this bridge";

/** What `attempt()` observed while waiting for a banner that never
 * arrived -- either signal alone is enough to call it contention: a
 * bridge that prints `ERR busy` and keeps the connection open a while
 * longer is just as much "another app is connected" as one that resets
 * instantly with no text at all. */
export interface IdentifyFailureSignals {
  readonly sawBusyLine: boolean;
  readonly closedBeforeBanner: boolean;
}

/**
 * Classify a `!banner` (no banner arrived within the identify budget)
 * outcome into the reason text `recordFailure` stores. Pure -- easy to
 * unit-test against a scripted transcript, per this ticket's own
 * acceptance criteria ("a fixture transcript ending in `ERR busy`
 * classifies as contention, not no-banner").
 *
 * `closedBeforeBanner` alone (no `ERR busy` text at all) is also treated
 * as contention for a contention-detectable transport: the distinguishing
 * signal is *not* a fixed time threshold on "immediately" but the shape
 * itself -- `LineLink.handleStreamClose` only resolves a pending
 * `identify()` wait early when the transport actually closes; a genuine
 * "the device never replied" timeout (this ticket's own live-bench
 * `tigez` finding: 3000ms of silence with the TCP connection still open
 * the entire time, no close, no `ERR busy`) leaves the connection open
 * and lets `identify()`'s own internal timer expire instead. Only a real
 * close event ever sets `closedBeforeBanner`, so the two cases can never
 * be confused.
 */
export function classifyIdentifyFailureReason(
  linkId: string,
  contentionDetectable: boolean,
  signals: IdentifyFailureSignals,
): string {
  if (contentionDetectable && (signals.sawBusyLine || signals.closedBeforeBanner)) {
    return BRIDGE_CONTENTION_REASON;
  }
  return `connector: link "${linkId}" produced no banner within the identify budget`;
}

// ---------------------------------------------------------------------
// Placeholder-device merge (sprint 015 ticket 003; SUC-003/SUC-004) --
// see the module doc comment's own section below.
// ---------------------------------------------------------------------

/**
 * `importKnownRobots` (sprint 014) seeds a `devices` row keyed by a
 * synthetic name-derived id, since `known-robots.json` never recorded
 * the true chip id -- but it *does* carry the USB interface chip's own
 * serial (`usbSerial`, a stable hardware identifier independent of
 * whatever name the firmware reports) as a display hint. That is the
 * only reliable join key once the real device identifies over USB: two
 * rows can disagree on `name`/`id` entirely (a known bench case --
 * `known-robots.json` recorded a robot as `vevov`/1031, a synthetic id,
 * while its real chip id 536019796 decodes to the *different* name
 * `vevav` -- a legacy naming disagreement this importer's own doc
 * comment already calls out as an accepted limitation) yet still be the
 * same physical board, correlated by `usb_serial` alone. Matching on
 * `name` instead would miss exactly this case, and matching on `id`
 * would never fire at all (the whole reason a merge is needed).
 *
 * A no-op when `usbSerial` is `undefined` (a non-`usb` transport --
 * SUC-003/SUC-004 only ever apply to a USB identify) or when no
 * `devices` row carries that `usb_serial` under a different id (nothing
 * to merge, or `known-robots.json` predates `lastUsbSerial` being
 * recorded at all -- an accepted limitation, not this function's to
 * fix).
 */
function mergeUsbPlaceholderIfAny(store: Store, usbSerial: string | undefined, deviceId: number, at: number): void {
  if (usbSerial === undefined) {
    return;
  }
  const placeholder = store
    .snapshotRows()
    .devices.find((row) => row.usb_serial === usbSerial && Number(row.id) !== deviceId);
  if (placeholder) {
    store.mergeDevice(Number(placeholder.id), deviceId, at);
  }
}

/**
 * Generalizes the merge above to any transport's first identification
 * (sprint 017 ticket 006; SUC-006; issue
 * `placeholder-merge-for-non-usb-transports.md`). `mergeUsbPlaceholderIfAny`
 * only ever fires for a `usb` identify -- it is the join key of choice
 * *when available* (a hardware serial survives a legacy naming
 * disagreement, per its own doc comment's `vevov`/`vevav` case) but a
 * robot first identified over `mbserial`/`wifi` has no USB serial to
 * correlate against at all, so a `known-robots.json`-seeded placeholder
 * for that robot (synthetic id, no true chip id) and its real row never
 * collapse -- seen on the bench for `gopiv` (placeholder 1461 vs. real
 * 2175407711, sprint 016 ticket 008).
 *
 * ### Bench defect 2 (2026-09-12): the original `usb_serial IS NULL`
 * filter never matched a real imported placeholder
 *
 * The first cut of this function (sprint 017 ticket 006) matched
 * placeholder candidates by `usb_serial IS NULL`, reasoning that a row
 * already carrying a `usb_serial` must have already been correlated.
 * That reasoning was wrong: `store/importers/knownRobots.ts` writes the
 * JSON's own `lastUsbSerial` into every imported placeholder's
 * `usb_serial` column unconditionally (`KnownRobotRecord.lastUsbSerial`
 * is a required field, not optional) -- so a placeholder imported from a
 * real `known-robots.json` almost always *does* carry a `usb_serial`,
 * and the old filter excluded exactly the rows it was meant to find.
 * Confirmed live: `gopiv` 1461 (imported, `owned=1`, `usb_serial` set)
 * never merged with the real row 2175407711 identified over
 * `mbserial`/`wifi`; same for `tovez` (2665/2314287040) and `vevov`
 * (1031/1198504156).
 *
 * The fix (now implemented in `store/placeholderMerge.ts`'s
 * `mergeNamePlaceholderIfAny`, imported above) drops the `usb_serial`
 * test entirely and instead defines a placeholder by **how it was
 * constructed** -- see that module's own doc comment for the full
 * reasoning, including why a plain `find` suffices (no
 * `candidates.length` ambiguity check) and which *different* ambiguous
 * case is still deliberately left untouched.
 *
 * ### Bench defect (2026-09-13): the same robot appears twice, again
 *
 * This merge only ever ran here, after a full connect *and* a successful
 * banner identify -- a bad USB cable that never once produces a clean
 * banner (bench evidence: `tovez` on a flaky cable) means this call site
 * simply never fires, even though `watchers/usbWatcher.ts`'s own SWD
 * naming (a separate, earlier identification step over the debug
 * interface, immune to the same serial-line corruption) already knows
 * the robot's real name and id. `usbWatcher.ts`'s `attach()` now calls
 * the same shared `mergeNamePlaceholderIfAny` directly after a successful
 * SWD name read, closing that gap -- see `store/placeholderMerge.ts`'s
 * own doc comment.
 */

// ---------------------------------------------------------------------
// createConnector
// ---------------------------------------------------------------------

/**
 * Build a {@link Connector} bound to `store`. See the module doc
 * comment for the full contract; see {@link ConnectorDeps}/{@link
 * ConnectorOptions} for every injectable seam.
 */
export function createConnector(store: Store, deps: ConnectorDeps = {}, opts: ConnectorOptions = {}): Connector {
  const createSerialStream = deps.createSerialStream ?? ((path: string) => serialStream(path));
  const createTcpStream = deps.createTcpStream ?? ((host: string, port: number, ip?: string) => tcpStream(host, port, ip !== undefined ? { ip } : {}));
  const createLineLink = deps.createLineLink ?? ((stream: ByteStream, options: LineLinkOptions) => new LineLink(stream, options));
  const scheduler = deps.scheduler ?? realScheduler;
  const now = deps.now ?? (() => Date.now());
  const harvester = deps.harvester ?? NO_OP_HARVESTER;
  const revocation = deps.revocation;

  const connectTimeoutMs = opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const identifySchedule = opts.identifySchedule ?? DEFAULT_IDENTIFY_SCHEDULE_MS;
  const identifyBudgetMs = opts.identifyBudgetMs ?? DEFAULT_IDENTIFY_BUDGET_MS;
  const relayHandshakeTimeoutMs = opts.relayHandshakeTimeoutMs;
  const backoffCapMs = opts.backoffCapMs ?? DEFAULT_BACKOFF_CAP_MS;
  const directOpenTakeoverMaxWaitMs = opts.directOpenTakeoverMaxWaitMs ?? DEFAULT_DIRECT_OPEN_TAKEOVER_MAX_WAIT_MS;
  const directOpenTakeoverPollMs = opts.directOpenTakeoverPollMs ?? DEFAULT_DIRECT_OPEN_TAKEOVER_POLL_MS;

  const mutex = new KeyedMutex();

  /** One connect attempt. Every await is bound by `signal`; every exit
   * path (success, a thrown error, or `signal` aborting) releases any
   * exclusivity this call itself acquired — see the module doc
   * comment's "Exclusivity" section. */
  async function attempt(link: LinkRow, signal: AbortSignal): Promise<ConnectedSession> {
    if (signal.aborted) {
      throw abortError(signal);
    }

    let address: ParsedAddress;
    try {
      address = parseLinkAddress(link.transport, link.address);
    } catch (error) {
      const err = toError(error);
      recordFailure(store, link.id, err.message, now(), backoffCapMs);
      throw err;
    }

    const exclusivity = resolveExclusivity(link, address);
    const owner = `session:${link.id}`;
    let acquired = false;

    try {
      if (exclusivity.kind !== "none") {
        acquired = acquireExclusivity(store, exclusivity, owner, now());
        if (!acquired) {
          const err = new Error(
            `connector: could not acquire ${exclusivity.kind} for "${String(exclusivity.resourceKey)}" -- held by another owner`,
          );
          recordFailure(store, link.id, err.message, now(), backoffCapMs);
          throw err;
        }
      }

      if (signal.aborted) {
        throw abortError(signal);
      }

      // Sprint 019 ticket 001 (SUC-001): a direct session-open of a
      // relay's own usb link races `watchers/relaySweeper.ts`'s periodic
      // probe for the same physical port -- board_owner (just acquired
      // above) never sees that contention at all, since the sweeper
      // holds `relay_leases`, a different lock entirely. Take over any
      // in-flight sweep pass registered against this link before ever
      // touching the raw port -- see `takeoverDirectOpenSweep`'s own doc
      // comment for the full reasoning. A no-op for every non-relay usb
      // link (a robot's own port) and for an idle relay with no sweep
      // running.
      const relayTakeoverEligible = link.transport === "usb" && isKnownRelayUsbLink(store, link);
      if (relayTakeoverEligible) {
        await takeoverDirectOpenSweep(
          revocation,
          link.id,
          owner,
          scheduler,
          now,
          signal,
          directOpenTakeoverMaxWaitMs,
          directOpenTakeoverPollMs,
        );
      }

      let lineLink: LineLink | undefined;
      const plan = buildStreamPlan(
        link,
        address,
        store,
        createSerialStream,
        createTcpStream,
        () => lineLink as LineLink,
        scheduler,
        relayHandshakeTimeoutMs,
      );
      lineLink = createLineLink(plan.stream, {
        identifyTimeoutMs: identifyBudgetMs,
        connectTimeoutMs,
        scheduler,
        ...(plan.preamble ? { preamble: plan.preamble } : {}),
      });

      try {
        await lineLink.connect({ timeoutMs: connectTimeoutMs, signal });
      } catch (error) {
        const err = toError(error);
        // Sprint 019 ticket 001: a port-lock failure reaching here *after*
        // the takeover attempt above already ran cannot be our own
        // sweeper -- see the "Direct relay session-open sweep takeover"
        // section's own doc comment for why that ordering makes this
        // conclusion safe. Reclassified into a distinct, plain-language
        // reason rather than the raw OS error text.
        const reported =
          relayTakeoverEligible && PORT_LOCK_FAILURE_PATTERN.test(err.message)
            ? new Error(RELAY_EXTERNAL_LOCK_REASON)
            : err;
        recordFailure(store, link.id, reported.message, now(), backoffCapMs);
        throw reported;
      }

      // 018-008: watch for the two shapes a single-client bridge's
      // contention takes -- an `ERR busy` line, or the bridge simply
      // resetting the connection with no reply at all -- for exactly the
      // two transports that ride a plain TCP stream to something that
      // may already be held by another client (a farm `mbserial` bridge;
      // a WiFi robot's own single listener, observed live-bench held by
      // the stakeholder's own `scripts/dev.mjs`). Never for `radio`/
      // `mbrelay` (ticket 009's own, different mbrelay-pool defect) or
      // `usb` (a closed serial port during identify is never contention
      // -- see `classifyIdentifyFailureReason`'s own doc comment).
      const contentionDetectable = isContentionDetectableTransport(link.transport);
      let sawBusyLine = false;
      let closedBeforeBanner = false;
      const unsubscribeInbound = contentionDetectable
        ? lineLink.onInboundLine((raw) => {
            if (BRIDGE_BUSY_LINE_PATTERN.test(raw.trim())) {
              sawBusyLine = true;
            }
          })
        : undefined;
      const unsubscribeClose = contentionDetectable
        ? lineLink.onClose(() => {
            closedBeforeBanner = true;
          })
        : undefined;

      let banner: ParsedBanner | null;
      try {
        banner = await identifyWithAbort(lineLink, signal, identifySchedule, scheduler);
      } catch (error) {
        unsubscribeInbound?.();
        unsubscribeClose?.();
        void lineLink.close();
        const err = toError(error);
        recordFailure(store, link.id, err.message, now(), backoffCapMs);
        throw err;
      }
      unsubscribeInbound?.();
      unsubscribeClose?.();

      if (!banner) {
        void lineLink.close();
        const err = new Error(
          classifyIdentifyFailureReason(link.id, contentionDetectable, { sawBusyLine, closedBeforeBanner }),
        );
        recordFailure(store, link.id, err.message, now(), backoffCapMs);
        throw err;
      }

      // Item E (team-lead, 2026-09-13): reject a banner whose own
      // name/serial fields are internally inconsistent -- a well-formed
      // banner's `name` is always derivable from its `serial` (protocol
      // §2.2; `bannerNameMatchesSerial`'s own doc comment). A mismatch
      // here means the bytes themselves are corrupted (the same failure
      // mode this ticket's other identity check targets), not a naming
      // policy question -- there is no device identity to safely act on.
      if (!bannerNameMatchesSerial(banner)) {
        void lineLink.close();
        const err = new Error(
          `connector: link "${link.id}" produced a banner whose name "${banner.name}" does not match its own serial ${banner.serial} -- serial data corrupted, check the USB cable`,
        );
        recordFailure(store, link.id, err.message, now(), backoffCapMs);
        throw err;
      }

      // Item E (team-lead, 2026-09-13): bench defect -- a `usb` link
      // already carrying a `deviceId` from SWD naming (`usbWatcher.ts`,
      // run before this module ever sees the link) is a claim about
      // which physical board is on the other end of this port. A banner
      // read over the same serial connection that disagrees with that
      // claim is not a "new device" -- on the observed bench hardware
      // (`zapuz`/`tigez`/`tovez`), it was a single flaky USB cable
      // producing a different corrupted serial number on each read. Do
      // NOT upsert a device or set owned in that case; record the
      // disagreement (reaching the front-page card via this link's own
      // `state_reason`, per `deviceDisplay.ts`'s `linkStateText`) and
      // close the line link, exactly like every other identify failure
      // above.
      if (link.transport === "usb" && link.deviceId !== undefined && link.deviceId !== null && link.deviceId !== banner.serial) {
        void lineLink.close();
        const swdName = deviceIdToName(link.deviceId);
        const err = new Error(
          `banner identity ${banner.name} disagrees with SWD name ${swdName} -- serial data corrupted, check the USB cable`,
        );
        recordFailure(store, link.id, err.message, now(), backoffCapMs);
        throw err;
      }

      const classification = classifyBanner(banner);
      const deviceId = banner.serial;
      const name = deviceIdToName(deviceId);
      const kind: DeviceKind = classification.type === "relay" ? "relay" : "robot";
      const usbSerial = link.transport === "usb" ? usbSerialFromLinkId(link.id) : undefined;

      store.upsertDevice({
        id: deviceId,
        name,
        kind,
        role: banner.role,
        commonName: banner.commonName,
        ...(usbSerial !== undefined ? { usbSerial } : {}),
        at: now(),
      });
      mergeUsbPlaceholderIfAny(store, usbSerial, deviceId, now());
      if (kind === "robot") {
        mergeNamePlaceholderIfAny(store, name, deviceId, now());
      }
      if (link.transport === "usb" && classification.type === "robot") {
        store.setOwned(deviceId, true, now());
      }
      store.upsertLink({ id: link.id, transport: link.transport, address, deviceId, at: now() });
      store.openSession(link.id, now());
      store.setLinkState({ id: link.id, state: "connected", at: now() });

      const session: ConnectedSession = {
        linkId: link.id,
        deviceId,
        transport: link.transport,
        link: lineLink,
        classification,
      };
      harvester.attach(session);
      return session;
    } finally {
      if (acquired) {
        releaseExclusivity(store, exclusivity, owner);
      }
    }
  }

  /** Best-effort resourceKey for {@link mutex}, so concurrent calls for
   * the same physical resource queue behind each other instead of both
   * racing the same `board_owner`/`relay_leases` acquire. Returns
   * `undefined` (no serialization) for a transport with no exclusivity,
   * or an address this module cannot parse -- `attempt()` itself will
   * fail with a clear parse error in the latter case regardless. */
  function mutexKeyFor(link: LinkRow): string | undefined {
    try {
      const address = parseLinkAddress(link.transport, link.address);
      const exclusivity = resolveExclusivity(link, address);
      return exclusivity.kind === "none" ? undefined : `${exclusivity.kind}:${String(exclusivity.resourceKey)}`;
    } catch {
      return undefined;
    }
  }

  return {
    connectAndIdentify(link: LinkRow, signal: AbortSignal): Promise<ConnectedSession> {
      const key = mutexKeyFor(link);
      return key ? mutex.run(key, () => attempt(link, signal)) : attempt(link, signal);
    },
  };
}
