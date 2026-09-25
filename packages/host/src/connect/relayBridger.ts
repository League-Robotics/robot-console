/**
 * relayBridger.ts — bridges one radio/mbrelay child link to its target
 * robot, resetting the relay before every candidate it tries (sprint 016
 * ticket 002; issue `rearch-09-relay-lease-idle-state-reset-between-candidates.md`;
 * `sprint.md`'s own Architecture, "relayBridger" module row and Design
 * Rationale, "relayBridger.ts is a new sibling module to connector.ts").
 *
 * ## The Linux bug this module fixes
 *
 * `connect/connector.ts`'s own `attempt()` already bridges a single,
 * already-named radio/mbrelay child link — full address resolution,
 * `relay_leases` acquisition, and the `RelayCommandPlane` preamble
 * through `!GO` — but it never resets the relay first, and it only ever
 * tries one candidate. A relay left in the data plane by a prior failed
 * attempt never recovers without a reset, so every candidate after the
 * first sends its own sync into a relay that cannot hear it. This only
 * ever appeared to work on macOS because opening a serial port happens
 * to toggle DTR, which incidentally resets a DAPLink board; Linux does
 * not do this. This module resets the relay — by its own physical
 * capability, see {@link chooseResetMethod} — before *every* candidate's
 * preamble, not just once before the first.
 *
 * ## Sibling to connector.ts, not a rewrite
 *
 * Per sprint.md's own Design Rationale: `connect/connector.ts` is
 * unchanged in behavior by this ticket — its own single-candidate,
 * no-reset radio/mbrelay path (and every one of its own tests) still
 * works exactly as before. This module reuses connector.ts's own
 * address-parsing, relay-physical-resolution, `RelayCommandPlane`-as-
 * preamble composition, cancellable identify, and failure-recording
 * helpers (all now `export`ed from that module for exactly this reuse —
 * see its own doc comment's "Ticket 016-002" section) rather than
 * duplicating them, and opens the relay's raw transport directly via the
 * same `link/adapters/{serialStream,tcpStream}.ts` adapters connector.ts
 * itself uses — never through `connector.connectAndIdentify` — since the
 * relay's own identity is already known from its one-time identify
 * (ticket 016-001) and does not need reconfirming.
 *
 * ## Two request shapes, one candidate loop
 *
 * {@link BridgeRequest} always carries a `relayLinkId` plus an ordered,
 * non-empty `candidates` array — the same reset-then-preamble-then-
 * identify loop runs either way:
 *
 *   - **Named** (`{relayLinkId, name}` session-open, or any existing
 *     radio/mbrelay child link the reconciler already knows about):
 *     {@link toBridgeRequest} wraps the one already-resolved child link
 *     into a single-candidate request — no candidate list, exactly
 *     today's behavior plus the new reset step (SUC-002's own "a named
 *     session-open bridge still works exactly as before this ticket").
 *   - **Default failover** (no name picked): {@link buildDefaultFailoverCandidates}
 *     builds the ordered, multi-candidate request — radio-sighted robots
 *     first (recency), then remembered robots by `last_seen` — resolving
 *     each candidate's address via {@link resolveDefaultFailoverAddress}
 *     (override → derived, **no registry GET**, rearch-09's own explicit
 *     acceptance criterion). Not yet wired to a live wire-protocol entry
 *     point as of this ticket (`wsMessages.ts`'s `SessionOpenMessage` has
 *     no "relayLinkId with no name" shape yet) — exported here, fully
 *     testable, for whichever future ticket adds that UI/wire path.
 *
 * ## Reset method selection
 *
 * {@link chooseResetMethod}: DAPLink-over-HID when the relay's own `usb`
 * link carries a `hidPath` (`watchers/usbWatcher.ts`'s own
 * `usbLinkAddress`, already recorded); else a serial break
 * (`link/adapters/serialStream.ts`'s new `sendBreak()`, ticket 016-002);
 * else (a `mbrelay`-transport relay) a disconnect+reconnect — a break
 * cannot be sent over TCP, and opening a *fresh* stream for every
 * candidate attempt (this module's own per-candidate stream lifecycle)
 * already performs the reconnect, so that branch is a deliberate no-op;
 * else (sprint 018 ticket 007 — a relay discovered only through
 * mbregistry, with neither direct HID access nor a raw serial port
 * available) {@link mbregistryResetSequence} over the *same* locked
 * `mbregistryStream` session already opened for this candidate's data
 * plane — never a second lock (sprint.md's own Design Rationale). See
 * that function's own doc comment for why `sendBreak()` is today's
 * chosen primitive and what remains unverified about it.
 *
 * ## Lease lifecycle
 *
 * One `relay_leases` acquisition (`owner = session:<firstCandidate's
 * childLinkId>`) covers the *whole* candidate loop — held across every
 * reset/preamble/identify attempt, released in `finally` on both success
 * and exhaustion (this ticket's own acceptance criterion: "lease never
 * leaked"). Never released and re-acquired between candidates: the
 * physical relay stays exclusively this bridge's own for the duration of
 * one `bridge()` call, exactly like `connector.ts`'s own
 * acquire-then-always-release contract applied to the whole attempt
 * rather than one candidate.
 *
 * ## Sweep takeover (sprint 016 ticket 004; SUC-004; UC-016's <= 1.5s
 * handback target)
 *
 * A lease-acquisition failure is not always a hard stop: if the relay's
 * lease is currently held by `watchers/relaySweeper.ts`'s own sweep pass
 * (`owner === "sweep"` — duplicated here as a literal, see {@link
 * SWEEP_LEASE_OWNER}'s own doc comment for why this module cannot import
 * that one to name it), a running sweep is preemptable: {@link
 * takeoverSweepLease} looks up that relay's registered `AbortController`
 * in the shared `connect/relayLeaseRevocation.ts` seam ({@link
 * RelayBridgerDeps.revocation}) and aborts it, then polls
 * `store.acquireRelayLease` (bounded by {@link
 * RelayBridgerOptions.takeoverMaxWaitMs}) until the sweeper's own
 * `finally` block (`relaySweeper.ts`'s own doc comment: "finish the
 * current wait ... release the lease") frees it. Any *other* owner
 * (`session:<linkId>`, i.e. another bridge already occupying the relay)
 * is not preemptable — this path only ever fires for a sweep-held lease,
 * exactly SUC-004's own scenario ("a student connects through a relay
 * while it is sweeping"), and falls straight through to the ordinary
 * immediate-failure path otherwise. A caller that never supplies {@link
 * RelayBridgerDeps.revocation} (every pre-016-004 test, and any future
 * caller with no sweeper in its own composition) gets exactly the old
 * behavior — a sweep-held lease fails immediately, as if it were any
 * other owner.
 */
import {
  classifyBanner,
  deviceIdToName,
  nameToRadioAddress,
  type DeviceClassification,
} from "@robot-console/protocol";
import { LineLink, type ByteStream, type LineLinkOptions } from "../link/LineLink.js";
import { serialStream, type SerialResettableStream } from "../link/adapters/serialStream.js";
import { tcpStream } from "../link/adapters/tcpStream.js";
import { mbregistryStream, type MbregistryResettableStream } from "../link/adapters/mbregistryStream.js";
import { parseHostPort, type MbregistryClient } from "../mbregistry/client.js";
import { realScheduler, WritePacer, type Scheduler } from "../link/pacing.js";
import { sync as syncRelayCommandPlane, type RelayLinkIO } from "../link/RelayCommandPlane.js";
import { LineReassembler } from "../link/lineStream.js";
import { DEFAULT_IDENTIFY_BUDGET_MS, DEFAULT_IDENTIFY_SCHEDULE_MS } from "../link/bootWindowIdentify.js";
import { HID as HidTransport, CortexM } from "../vendor/dapjs/index.js";
import { HID as NodeHidDevice } from "node-hid";
import { resolveDeviceRadio, type DeviceRadioOverride } from "../radioOverride.js";
import type { ResolvedAddress } from "../mbrelayRegistry.js";
import {
  Store,
  type DeviceKind,
  type ProjectionDeviceRow,
  type RadioSightingRow,
  type Transport,
} from "../store/index.js";
import type { RelayLeaseRevocation } from "./relayLeaseRevocation.js";
import {
  DEFAULT_BACKOFF_CAP_MS,
  DEFAULT_CONNECT_TIMEOUT_MS,
  NO_OP_HARVESTER,
  RELAY_PREAMBLE_WRITE_PACE_MS,
  abortError,
  buildRelayPreamble,
  identifyWithAbort,
  parseLinkAddress,
  recordFailure,
  resolveRelayPhysical,
  toError,
  type ConnectedSession,
  type HarvesterAttach,
  type LinkRow,
  type MbregistryAddress,
  type RelayAddress,
  type TcpAddress,
  type UsbAddress,
} from "./connector.js";

// ---------------------------------------------------------------------
// Public request/candidate shapes — see the module doc comment's "Two
// request shapes, one candidate loop" section.
// ---------------------------------------------------------------------

export interface RelayBridgeCandidate {
  /** The link id this candidate will be identified as on success — an
   * existing child link's own id for the named case ({@link
   * toBridgeRequest}), or a minted, deterministic
   * `<transport>-<name>-via-<relayLinkId>` id for a default-failover
   * candidate ({@link buildDefaultFailoverCandidates}) — matching
   * `server.ts`'s own `session-open {relayLinkId, name}` convention so a
   * repeat bridge to the same name reuses the same row. */
  readonly childLinkId: string;
  readonly channel: number;
  readonly group: number;
}

export interface BridgeRequest {
  readonly relayLinkId: string;
  /** Non-empty, in try-order. Length 1 for a named bridge (no candidate
   * list); length N for default failover. */
  readonly candidates: readonly RelayBridgeCandidate[];
}

export interface RelayBridgerDeps {
  /** Injectable USB serial adapter factory — defaults to the real {@link
   * serialStream} (with its `sendBreak()` reset capability). Tests
   * substitute a factory returning a fake implementing {@link
   * SerialResettableStream} (or plain {@link ByteStream}, if the reset
   * method under test never needs `sendBreak()`). */
  createSerialStream?: (path: string) => ByteStream;
  /** Injectable TCP adapter factory (the mbrelay physical hop). Defaults
   * to the real {@link tcpStream}. `ip`, when given, is the resolved
   * IPv4 address `watchers/mdnsWatcher.ts` already stored on the relay's
   * own link (018-007) — see `connector.ts`'s `TcpAddress.ip` doc
   * comment. */
  createTcpStream?: (host: string, port: number, ip?: string) => ByteStream;
  /** Injectable mbregistry stream adapter factory (ticket 003's {@link
   * mbregistryStream}) for an `mbregistry`-transport relay physical
   * (`resolveRelayPhysical`'s third branch) — mirrors `connector.ts`'s
   * own `ConnectorDeps.createMbregistryStream` seam exactly, including
   * its `kind` parameter (always `"relay"` here — this module only ever
   * opens an mbregistry stream for the relay hop itself, never a direct
   * board session). Defaults to the real adapter bound to {@link
   * RelayBridgerDeps.mbregistryClient}; tests substitute a factory
   * returning a fake implementing {@link MbregistryResettableStream}
   * (or plain {@link ByteStream}, mirroring `createSerialStream`'s own
   * convention above) — this is also the one factory a test counts calls
   * against to prove no second lock/connection is opened for the reset
   * step (module doc comment's own "reuse the *same* `mbregistryStream`
   * connection" rule): exactly one call per candidate attempt, reused for
   * both the reset and the data plane. */
  createMbregistryStream?: (address: MbregistryAddress, kind: "relay") => ByteStream;
  /** The already-connected {@link MbregistryClient} (ticket 001) the
   * default `createMbregistryStream` opens a `lock`+`stream` session
   * against — mirrors `ConnectorDeps.mbregistryClient` exactly.
   * `runtime.ts` wires the same instance handed to `connector.ts`. */
  mbregistryClient?: MbregistryClient;
  /** This console's own identity, forwarded as the default
   * `createMbregistryStream`'s `mbregistryStream` `label` option --
   * display-only (`registry-api.md`). Mirrors `ConnectorDeps.mbregistryLabel`. */
  mbregistryLabel?: string;
  /** Builds the `LineLink` wrapping a candidate's {@link ByteStream}.
   * Defaults to `new LineLink(stream, options)`. */
  createLineLink?: (stream: ByteStream, options: LineLinkOptions) => LineLink;
  /** Governs every wait this module makes (the reset's own break-hold
   * delay, the relay preamble's write pacing, `RelayCommandPlane`'s
   * waits, and the boot-window identify schedule). Defaults to {@link
   * realScheduler}. */
  scheduler?: Scheduler;
  /** Wall-clock reader for every store timestamp. Defaults to
   * `Date.now`. */
  now?: () => number;
  /** The harvester-attach seam (`connect/connector.ts`'s own {@link
   * HarvesterAttach}) — a bridged session is harvested exactly like a
   * connector-identified one. Defaults to a no-op stub. */
  harvester?: HarvesterAttach;
  /** Injectable DAPLink-over-HID reset primitive — `(hidPath, signal) =>
   * Promise<void>`, expected to connect, reset, and disconnect (see
   * {@link defaultHidReset}). Defaults to the real `node-hid` + vendored
   * `dapjs` stack; tests always substitute a fake — this repository's
   * own rule is that no test ever opens a real HID device. */
  hidReset?: (hidPath: string, signal: AbortSignal) => Promise<void>;
  /** Forwarded to {@link SerialResettableStream.sendBreak} as its
   * `durationMs`. Omitted, that method's own default applies. */
  breakMs?: number;
  /** The shared revocation seam (`connect/relayLeaseRevocation.ts`) this
   * bridger consults on a sweep-held lease-acquisition failure — see the
   * module doc comment's "Sweep takeover" section. Optional: omitted
   * (every pre-016-004 test, and any composition with no sweeper),
   * {@link takeoverSweepLease} is never attempted and a sweep-held lease
   * fails exactly as before this ticket. `runtime.ts` always wires the
   * same instance handed to `watchers/relaySweeper.ts`. */
  revocation?: RelayLeaseRevocation;
}

export interface RelayBridgerOptions {
  /** Bounds each candidate's `LineLink.connect()` (transport open, reset,
   * relay preamble). Default {@link DEFAULT_CONNECT_TIMEOUT_MS}. */
  connectTimeoutMs?: number;
  /** `HELLO` resend offsets, ms from connect. Default {@link
   * DEFAULT_IDENTIFY_SCHEDULE_MS}. */
  identifySchedule?: readonly number[];
  /** Total budget for the boot-window identify sequence. Default {@link
   * DEFAULT_IDENTIFY_BUDGET_MS}. */
  identifyBudgetMs?: number;
  /** Per-step timeout for the relay command-plane handshake. Default is
   * `RelayCommandPlane.ts`'s own default (3000ms) when omitted. */
  relayHandshakeTimeoutMs?: number;
  /** Forwarded to `RelayCommandPlane.ts`'s own `sync()` retry loop (the
   * `?` probe run before every candidate's preamble proper) —
   * `syncRetryMs`/`syncAttempts`. Tests use this to shrink that loop's
   * real elapsed time (default 16 attempts x 500ms = 8s) when proving a
   * relay stuck in the data plane never answers `?`; production never
   * overrides it. */
  syncRetryMs?: number;
  syncAttempts?: number;
  /** Cap on the exponential backoff used for a failed *named*
   * (single-candidate) bridge's `next_retry_at`. Default {@link
   * DEFAULT_BACKOFF_CAP_MS}. */
  backoffCapMs?: number;
  /** Set `false` **only** to reproduce the pre-fix Linux failover bug in
   * a test (this ticket's own regression guard: the fake-relay-with-
   * plane-state fixture must fail without a reset between candidates).
   * Production code never sets this — every real `bridge()` call resets
   * before every candidate. Default `true`. */
  resetBetweenCandidates?: boolean;
  /** Bound on how long {@link takeoverSweepLease} waits for a revoked
   * sweep pass to actually release the lease before giving up — see the
   * module doc comment's "Sweep takeover" section. Comfortably above the
   * sweeper's own worst-case handback (its current `!CG`/`ID` wait, <=
   * `SWEEP_PROBE_TIMEOUT_MS` = 500ms, plus its own stream-close/
   * deregister overhead) while staying small relative to UC-016's <=
   * 1.5s end-to-end handback budget. Default {@link
   * DEFAULT_TAKEOVER_MAX_WAIT_MS}. */
  takeoverMaxWaitMs?: number;
  /** Poll interval while waiting for the lease to free during a
   * takeover. Default {@link DEFAULT_TAKEOVER_POLL_MS}. */
  takeoverPollMs?: number;
}

/** Default for {@link RelayBridgerOptions.takeoverMaxWaitMs}. */
export const DEFAULT_TAKEOVER_MAX_WAIT_MS = 1000;
/** Default for {@link RelayBridgerOptions.takeoverPollMs}. */
export const DEFAULT_TAKEOVER_POLL_MS = 25;

/** The literal `relay_leases.owner` a running sweep pass holds —
 * `watchers/relaySweeper.ts`'s own `SWEEP_OWNER` constant, duplicated
 * here rather than imported: that module already imports several
 * helpers *from* this one (`chooseResetMethod`, `performReset`,
 * `defaultHidReset`, `resolveDefaultFailoverAddress`,
 * `defaultFailoverChildLinkId`), so importing it back would create a
 * cycle. Mirrors `connect/relayLeaseRevocation.ts`'s own doc comment,
 * which names this exact convention the same way for the same reason. */
const SWEEP_LEASE_OWNER = "sweep";

export interface RelayBridger {
  /** Try every candidate in order, resetting the relay before each one's
   * preamble, until one identifies successfully. Acquires `relay_leases`
   * once for the whole call (`owner = session:<candidates[0].childLinkId>`)
   * and releases it in `finally` — success or exhaustion alike. Rejects
   * with the last candidate's own error once every candidate has been
   * tried and none identified. */
  bridge(request: BridgeRequest, signal: AbortSignal): Promise<ConnectedSession>;
}

// ---------------------------------------------------------------------
// Reset method selection — see the module doc comment's own section.
// ---------------------------------------------------------------------

export type RelayResetMethod = "hid" | "break" | "reconnect" | "mbregistry";

/**
 * Choose how to reset the physical relay before a candidate's preamble:
 * `"hid"` when the relay's own `usb` link carries a `hidPath`, else
 * `"break"` for a `usb`-transport relay with none, `"reconnect"` for an
 * `mbrelay`-transport (TCP) relay — a break cannot be sent over TCP
 * (`docs/design/specification.md` §6), and a fresh per-candidate TCP
 * connection already performs the reconnect — else (sprint 018 ticket
 * 007) `"mbregistry"` for a relay reached only through mbregistry, where
 * neither direct HID access nor a raw serial break is available; the
 * reset instead goes over the same locked `mbregistryStream` session via
 * {@link mbregistryResetSequence}. Pure — no I/O.
 */
export function chooseResetMethod(hidPath: string | null, relayTransport: "usb" | "mbrelay" | "mbregistry"): RelayResetMethod {
  if (relayTransport === "mbregistry") {
    return "mbregistry";
  }
  if (relayTransport === "mbrelay") {
    return "reconnect";
  }
  return hidPath ? "hid" : "break";
}

/** Small, real-time-safe defaults for {@link mbregistryResetSequence}'s
 * own pre-reset `sync()` check (ticket 018-011 finding 4) — deliberately
 * shorter than `RelayCommandPlane.ts`'s own real 8s/4s defaults: this is
 * "is the relay already answering right now", not a recovery loop with
 * its own retry budget (that's what the BREAK fallback below is for). */
export const MBREGISTRY_RESET_SYNC_ATTEMPTS = 2;
export const MBREGISTRY_RESET_SYNC_RETRY_MS = 200;

/** A minimal raw line write/subscribe pair over `stream` for {@link
 * mbregistryResetSequence}'s own `sync()` probe — mirrors
 * `watchers/relaySweeper.ts`'s own `buildRawLineIO` (that module's own
 * doc comment: "Raw line write/subscribe pair over a directly-opened
 * ByteStream"), duplicated in miniature here rather than shared/exported
 * from there, since this call site needs no write-failure reporting hook
 * (a write failure here surfaces via `sync()`'s own confirmation timeout,
 * exactly like the sweeper's own primary use). */
function buildResetProbeIO(stream: ByteStream, scheduler: Scheduler): RelayLinkIO {
  const pacer = new WritePacer(RELAY_PREAMBLE_WRITE_PACE_MS, scheduler);
  const reassembler = new LineReassembler();
  const listeners = new Set<(line: string) => void>();

  stream.on("data", (chunk) => {
    for (const line of reassembler.push(chunk)) {
      for (const listener of [...listeners]) {
        listener(line);
      }
    }
  });

  const write = (line: string): void => {
    pacer.schedule(
      () =>
        new Promise<void>((resolve, reject) => {
          stream.write(line, (err) => (err ? reject(err) : resolve()));
        }),
      () => {
        // No separate reporting channel -- a real write failure surfaces
        // via sync()'s own confirmation wait timing out.
      },
    );
  };

  const subscribe = (listener: (line: string) => void): (() => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  return { write, subscribe };
}

/**
 * The mbregistry-backed relay reset primitive (sprint 018 ticket 007):
 * a single `BREAK` frame sent over the candidate's own already-open
 * `mbregistryStream` session — never a second lock/connection (module
 * doc comment's "Reset method selection" and sprint.md's Design
 * Rationale, "reuse the *same* `mbregistryStream` connection already
 * open for the candidate being bridged").
 *
 * **Ticket 018-011 finding 4's own bench result — BREAK is not safe to
 * send unconditionally.** This function's own doc comment previously
 * flagged the choice of `sendBreak()` as "genuinely unresolved... sprint
 * 018 ticket 009 (bench verification) must confirm this actually resets
 * a DAPLink board... before this is treated as settled." That
 * verification's result: against a real mbregistry-connected relay
 * (`getez`) that a raw `lock`+`stream` client confirmed was already
 * healthy and answering its command plane (`< PING` heartbeat lines,
 * registry side fine), sending this unconditional `BREAK` anyway — every
 * single bridge attempt did, every candidate, regardless of whether the
 * relay needed resetting at all — produced a connection that appeared to
 * bridge successfully for a few seconds and then dropped with no
 * diagnosable reason (`harvester.ts`'s own `onClose`-with-no-`reason`
 * `fail()` branch: "unresponsive: link closed"). The most likely
 * mechanism (not independently confirmed against mbregistry's own
 * server-side logs, which this ticket had no access to): a raw serial
 * `BREAK` condition is also how several USB-CDC bridge chips signal a
 * target MCU reset, so an *already-healthy* relay's own microcontroller
 * physically reboots on every attempt; a directly-opened local serial
 * port (the legacy `usb`-transport `"break"` branch, unaffected by this
 * finding) tolerates that fine, but the *remote*, pyserial-backed port
 * mbregistry itself owns does not survive its target disappearing and
 * reappearing mid-connection, and mbregistry closes its end of the
 * stream without telling this client why.
 *
 * **The fix**: mirror `watchers/relaySweeper.ts`'s own
 * `ensureCommandPlaneReady` pattern — try a quick `sync()` (a `?`/status
 * round trip, {@link MBREGISTRY_RESET_SYNC_ATTEMPTS}/{@link
 * MBREGISTRY_RESET_SYNC_RETRY_MS}) over this same connection first; a
 * relay that already answers needs no reset at all, so no `BREAK` is
 * sent. Only a relay that fails to answer (genuinely parked mid a prior
 * session — the scenario `resetBetweenCandidates` exists for in the
 * first place, and this function's own pre-011 headline test, "candidate
 * 2 succeeds only because the relay was reset first") still gets the
 * `BREAK` fallback.
 *
 * **Which primitive actually performs that fallback reset remains the
 * same open question this doc comment flagged before** — `sendBreak()`
 * mirrors `performReset`'s existing `"break"` branch for a plain serial
 * stream, but mbregistry's wire protocol also exposes
 * `SET_DTR`/`SET_RTS` with no documented "reset" combination of them
 * (`stream_frame.py`, mbtools `docs/design/registry-api.md`); this is
 * still the *one* function to change if `sendBreak()` itself turns out
 * to be the wrong fallback primitive for a given platform. What ticket
 * 011's own bench finding resolves is narrower and more urgent: never
 * send it to a relay that was never broken in the first place.
 */
export async function mbregistryResetSequence(stream: ByteStream, signal: AbortSignal, scheduler: Scheduler = realScheduler): Promise<void> {
  const resettable = stream as Partial<MbregistryResettableStream>;
  if (typeof resettable.sendBreak !== "function") {
    throw new Error("relayBridger: mbregistry reset method chosen but the stream has no sendBreak()");
  }

  const io = buildResetProbeIO(stream, scheduler);
  try {
    await syncRelayCommandPlane({
      ...io,
      scheduler,
      syncAttempts: MBREGISTRY_RESET_SYNC_ATTEMPTS,
      syncRetryMs: MBREGISTRY_RESET_SYNC_RETRY_MS,
      signal,
    });
    // Already answering -- no reset needed at all (finding 4's own fix:
    // see this function's own doc comment for why sending BREAK anyway
    // was actively harmful here).
    return;
  } catch {
    // Not answering -- parked mid a prior session. Fall through to the
    // one-time BREAK fallback below, exactly the pre-011 behavior.
  }
  await resettable.sendBreak();
}

/** Function shape used to obtain a fully-formed SWD transport/processor
 * pair from an HID path for {@link defaultHidReset} — deliberately its
 * own type, not `swdName.ts`'s own `CortexMFactory`: that module's own
 * doc comment warns "attach, never reset" (reading a name must never
 * reboot a robot mid-session); this module's entire purpose for the HID
 * path is the opposite — reset the relay on purpose. */
export type ResetCortexMFactory = (hidPath: string) => CortexM;

function defaultCortexMFactory(hidPath: string): CortexM {
  const hidDevice = new NodeHidDevice(hidPath);
  const transport = new HidTransport(hidDevice);
  return new CortexM(transport);
}

/**
 * The real DAPLink-over-HID reset: attach, issue a hardware reset via
 * the CMSIS-DAP proxy's own `reset()` (`vendor/dapjs/dap/adi.ts`), then
 * disconnect — best-effort (a failed disconnect never masks a successful
 * reset, mirroring `swdName.ts`'s own cleanup discipline). Never called
 * by any test in this repository (no test ever opens a real HID device)
 * — {@link RelayBridgerDeps.hidReset} is always substituted with a fake.
 * Exported (ticket 016-003) so `watchers/relaySweeper.ts` can default its
 * own `hidReset` dep to the identical real implementation rather than
 * redefining it.
 */
export async function defaultHidReset(
  hidPath: string,
  signal: AbortSignal,
  createCortexM: ResetCortexMFactory = defaultCortexMFactory,
): Promise<void> {
  if (signal.aborted) {
    throw abortError(signal);
  }
  const processor = createCortexM(hidPath);
  try {
    await processor.connect();
    await processor.reset();
  } finally {
    try {
      await processor.disconnect();
    } catch {
      // Best-effort cleanup only -- see swdName.ts's own identical
      // discipline.
    }
  }
}

/** Perform the chosen reset against this candidate attempt's own
 * already-open `stream` (for `"break"`) or independently (for `"hid"`),
 * or do nothing (for `"reconnect"` — see the module doc comment).
 * Exported (ticket 016-003) so `watchers/relaySweeper.ts` can reuse the
 * identical reset primitive for its own "relay parked in the data plane
 * on lease acquisition" recovery step, rather than duplicating the
 * per-method dispatch. */
export async function performReset(
  method: RelayResetMethod,
  stream: ByteStream,
  hidPath: string | null,
  hidResetFn: (hidPath: string, signal: AbortSignal) => Promise<void>,
  breakMs: number | undefined,
  signal: AbortSignal,
  /** Ticket 018-011 finding 4: governs the "mbregistry" method's own
   * pre-reset `sync()` check ({@link mbregistryResetSequence}); ignored
   * by every other method. Defaults to {@link realScheduler} -- only
   * `relayBridger.ts`'s own tests (and `relaySweeper.ts`, which never
   * reaches the "mbregistry" branch at all) ever override it. */
  scheduler: Scheduler = realScheduler,
): Promise<void> {
  if (signal.aborted) {
    throw abortError(signal);
  }
  if (method === "hid") {
    if (!hidPath) {
      throw new Error("relayBridger: HID reset method chosen but the relay has no hidPath");
    }
    await hidResetFn(hidPath, signal);
    return;
  }
  if (method === "break") {
    const breakable = stream as Partial<SerialResettableStream>;
    if (typeof breakable.sendBreak !== "function") {
      throw new Error("relayBridger: break reset method chosen but the stream has no sendBreak()");
    }
    await breakable.sendBreak(breakMs);
    return;
  }
  if (method === "mbregistry") {
    await mbregistryResetSequence(stream, signal, scheduler);
    return;
  }
  // "reconnect": this candidate's own freshly-opened TCP stream already
  // is the reconnect -- nothing further to do.
}

// ---------------------------------------------------------------------
// Default-failover candidate ordering and address resolution — see the
// module doc comment's own section. Pure/near-pure and separately
// testable before the full bridge() loop, per sprint.md's Implementation
// Plan ("mirrors sprint 015's own connector-testing precedent").
// ---------------------------------------------------------------------

export interface DefaultFailoverCandidateName {
  readonly name: string;
  readonly deviceId: number;
}

/**
 * Order remembered robots for the no-name-picked default-failover path:
 * robots with a recent radio `sighting` first (most recent first), then
 * every other owned robot by `last_seen` (most recent first) — SUC-002's
 * own Main Flow step 1. Pure: no store or network access. Only `owned`
 * robots are ever candidates (mirrors `reconciler.ts`'s own `owned` gate
 * for wifi/mbserial — an unowned device is never a connect candidate of
 * any kind).
 */
export function orderDefaultFailoverCandidateNames(
  devices: readonly Pick<ProjectionDeviceRow, "id" | "name" | "kind" | "owned" | "lastSeen">[],
  radioSightings: readonly RadioSightingRow[],
): DefaultFailoverCandidateName[] {
  const sightingAt = new Map(radioSightings.map((s) => [s.deviceId, s.at] as const));
  const robots = devices.filter((d) => d.kind === "robot" && d.owned);
  const sighted = [...robots.filter((d) => sightingAt.has(d.id))].sort(
    (a, b) => (sightingAt.get(b.id) ?? 0) - (sightingAt.get(a.id) ?? 0),
  );
  const unsighted = [...robots.filter((d) => !sightingAt.has(d.id))].sort((a, b) => b.lastSeen - a.lastSeen);
  return [...sighted, ...unsighted].map((d) => ({ name: d.name, deviceId: d.id }));
}

/** `resolveDeviceRadio`'s own injectable `resolveRegistry` seam
 * (`radioOverride.ts`), substituted here to guarantee **no registry
 * GET** ever happens during default failover (rearch-09's own explicit
 * acceptance criterion) — this never performs network I/O; it always
 * falls straight through to the name-derived default, tagged
 * `"local-derived"` exactly like a real unreachable-registry outcome
 * would be. This is the "injectable sightings lookup" sprint.md's own
 * Architecture section asks for: `radioOverride.ts`'s resolver is
 * extended via its *existing* seam rather than duplicated, and the
 * "last radio sighting" tier of override → last radio sighting → derived
 * collapses to this module's own sighting-recency-based *candidate
 * ordering* above plus a plain derived address here — `sightings` itself
 * (architecture.md §4) never stores a channel/group of its own to
 * recall, only whether/when a name was last heard. */
async function noRegistryResolve(name: string): Promise<ResolvedAddress> {
  return { ...nameToRadioAddress(name), outcome: "local-derived" };
}

/**
 * Resolve one candidate's radio address for default failover: a stored
 * override always wins outright; otherwise the name-derived default —
 * never the registry (see {@link noRegistryResolve}'s own doc comment).
 * Reuses `radioOverride.ts`'s own `resolveDeviceRadio` (override-wins
 * ordering) rather than reimplementing it.
 */
export async function resolveDefaultFailoverAddress(
  name: string,
  override: DeviceRadioOverride,
): Promise<{ channel: number; group: number }> {
  const resolved = await resolveDeviceRadio(name, override, { resolveRegistry: noRegistryResolve });
  return { channel: resolved.channel, group: resolved.group };
}

/** The deterministic `<transport>-<name>-via-<relayLinkId>` child-link-id
 * convention (see {@link RelayBridgeCandidate.childLinkId}'s own doc
 * comment). Exported (ticket 016-003) so `watchers/relaySweeper.ts`
 * mints the *same* id for a radio sighting's `links(radio)` row that a
 * later default-failover bridge to the same name would use — the
 * sighting and a subsequent bridge converge on one row rather than two,
 * which is what lets ticket 004's projection show a sighted robot's
 * "Radio via <relay>" card carry through into an actual bridge. */
export function defaultFailoverChildLinkId(childTransport: "radio" | "mbrelay", name: string, relayLinkId: string): string {
  return `${childTransport}-${name}-via-${relayLinkId}`;
}

/**
 * Build the full ordered {@link BridgeRequest} for a no-name-picked
 * default-failover bridge: {@link orderDefaultFailoverCandidateNames}
 * for order, {@link resolveDefaultFailoverAddress} (per candidate,
 * registry-free) for each one's `(channel, group)`, and {@link
 * defaultFailoverChildLinkId}'s deterministic id convention — matching
 * `server.ts`'s own `session-open {relayLinkId, name}` naming, so a
 * default-failover success and a later named bridge to the same robot
 * converge on the same `links` row. Not yet called by any production
 * wire-protocol entry point as of this ticket — see the module doc
 * comment's own section.
 */
export async function buildDefaultFailoverCandidates(
  relayLinkId: string,
  childTransport: "radio" | "mbrelay",
  devices: readonly ProjectionDeviceRow[],
  radioSightings: readonly RadioSightingRow[],
): Promise<BridgeRequest> {
  const ordered = orderDefaultFailoverCandidateNames(devices, radioSightings);
  const deviceByName = new Map(devices.map((d) => [d.name, d] as const));
  const candidates: RelayBridgeCandidate[] = [];
  for (const { name } of ordered) {
    const device = deviceByName.get(name);
    const override: DeviceRadioOverride = device
      ? { radioChannel: device.radioChannel, radioGroup: device.radioGroup, radioSource: device.radioSource }
      : { radioChannel: null, radioGroup: null, radioSource: null };
    const { channel, group } = await resolveDefaultFailoverAddress(name, override);
    candidates.push({ childLinkId: defaultFailoverChildLinkId(childTransport, name, relayLinkId), channel, group });
  }
  return { relayLinkId, candidates };
}

/**
 * Wrap one already-resolved radio/mbrelay child `LinkRow` (today's only
 * real production shape — a named `session-open` or an existing
 * reconciler-known child link) into a single-candidate {@link
 * BridgeRequest} — no candidate list, per SUC-002's own "a named
 * session-open bridge ... still works exactly as before this ticket".
 * `connect/reconciler.ts`'s executor calls this for a radio/mbrelay job.
 */
export function toBridgeRequest(link: LinkRow): BridgeRequest {
  const address = parseLinkAddress(link.transport, link.address) as RelayAddress;
  return {
    relayLinkId: address.relayLinkId,
    candidates: [{ childLinkId: link.id, channel: address.channel, group: address.group }],
  };
}

// ---------------------------------------------------------------------
// createRelayBridger
// ---------------------------------------------------------------------

function relayLinkTransport(store: Store, relayLinkId: string): "usb" | "mbrelay" | "mbregistry" {
  const row = store.snapshotRows().links.find((candidate) => candidate.id === relayLinkId);
  if (!row) {
    throw new Error(`relayBridger: relay link "${relayLinkId}" not found in the store`);
  }
  // Positive-narrowing (not `!==`) so this actually narrows `row.transport`
  // (typed `unknown` -- `StoreSnapshot.links` is a raw, untyped passthrough,
  // `store/index.ts`'s own doc comment) down from `unknown` to the literal
  // union: negated equality checks against an `unknown` value never narrow
  // it (there is no enumerable union to eliminate members from).
  //
  // A relay row of transport "mbregistry" is always accepted too (sprint
  // 018 ticket 007), mirroring `connector.ts`'s own `resolveRelayPhysical`
  // doc comment: once a relay board is discovered through
  // `mbregistryWatcher` instead of the disabled `usb`/`mbrelay` discovery
  // paths, this relay's own link row can be transport "mbregistry" no
  // matter which of "usb"/"mbrelay" its riding candidates would otherwise
  // imply.
  if (row.transport === "usb" || row.transport === "mbrelay" || row.transport === "mbregistry") {
    return row.transport;
  }
  throw new Error(
    `relayBridger: relay link "${relayLinkId}" is transport "${String(row.transport)}", expected "usb", "mbrelay", or "mbregistry"`,
  );
}

/**
 * Build a {@link RelayBridger} bound to `store`. See the module doc
 * comment for the full contract; see {@link RelayBridgerDeps}/{@link
 * RelayBridgerOptions} for every injectable seam.
 */
export function createRelayBridger(store: Store, deps: RelayBridgerDeps = {}, opts: RelayBridgerOptions = {}): RelayBridger {
  const createSerialStreamFn = deps.createSerialStream ?? ((path: string) => serialStream(path));
  const createTcpStreamFn = deps.createTcpStream ?? ((host: string, port: number, ip?: string) => tcpStream(host, port, ip !== undefined ? { ip } : {}));
  // Mirrors `connector.ts`'s own `createConnector`'s identical default --
  // see `RelayBridgerDeps.createMbregistryStream`'s own doc comment.
  const createMbregistryStreamFn =
    deps.createMbregistryStream ??
    ((address: MbregistryAddress, kind: "relay") => {
      if (!deps.mbregistryClient) {
        throw new Error(
          "relayBridger: mbregistry transport requires RelayBridgerDeps.mbregistryClient (or an overriding createMbregistryStream)",
        );
      }
      return mbregistryStream(
        {
          uid: address.uid,
          host: address.host ?? null,
          endpoint: parseHostPort(typeof address.endpoint === "string" ? address.endpoint : undefined),
        },
        {
          client: deps.mbregistryClient,
          kind,
          ...(deps.mbregistryLabel !== undefined ? { label: deps.mbregistryLabel } : {}),
        },
      );
    });
  const createLineLinkFn = deps.createLineLink ?? ((stream: ByteStream, options: LineLinkOptions) => new LineLink(stream, options));
  const scheduler = deps.scheduler ?? realScheduler;
  const now = deps.now ?? (() => Date.now());
  const harvester = deps.harvester ?? NO_OP_HARVESTER;
  const hidResetFn = deps.hidReset ?? ((hidPath: string, signal: AbortSignal) => defaultHidReset(hidPath, signal));
  const breakMs = deps.breakMs;
  const revocation = deps.revocation;

  const connectTimeoutMs = opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const identifySchedule = opts.identifySchedule ?? DEFAULT_IDENTIFY_SCHEDULE_MS;
  const identifyBudgetMs = opts.identifyBudgetMs ?? DEFAULT_IDENTIFY_BUDGET_MS;
  const relayHandshakeTimeoutMs = opts.relayHandshakeTimeoutMs;
  const backoffCapMs = opts.backoffCapMs ?? DEFAULT_BACKOFF_CAP_MS;
  const resetBetweenCandidates = opts.resetBetweenCandidates ?? true;
  const takeoverMaxWaitMs = opts.takeoverMaxWaitMs ?? DEFAULT_TAKEOVER_MAX_WAIT_MS;
  const takeoverPollMs = opts.takeoverPollMs ?? DEFAULT_TAKEOVER_POLL_MS;
  const syncOptions =
    opts.syncRetryMs !== undefined || opts.syncAttempts !== undefined
      ? {
          ...(opts.syncRetryMs !== undefined ? { syncRetryMs: opts.syncRetryMs } : {}),
          ...(opts.syncAttempts !== undefined ? { syncAttempts: opts.syncAttempts } : {}),
        }
      : undefined;

  /** One candidate attempt: open the relay's raw transport directly,
   * reset (if enabled), run the full `RelayCommandPlane` preamble through
   * `!GO`, then identify over the boot window — mirrors
   * `connector.ts`'s own `attempt()` tail (device/link/session
   * finalization) for a radio/mbrelay child, since that part of the
   * contract is unchanged by this ticket. */
  async function attemptCandidate(
    relayLinkId: string,
    relayTransport: "usb" | "mbrelay" | "mbregistry",
    candidate: RelayBridgeCandidate,
    signal: AbortSignal,
  ): Promise<ConnectedSession> {
    if (signal.aborted) {
      throw abortError(signal);
    }

    // `resolveRelayPhysical`'s own `expectedTransport` param is only
    // meaningful for a row whose transport is literally "usb"/"mbrelay"
    // (its own equality check); a row of transport "mbregistry" bypasses
    // that check entirely and always resolves through its own branch
    // regardless of what's passed here (connector.ts's own doc comment on
    // `RelayPhysical` and `resolveRelayPhysical`) -- so any "usb"/"mbrelay"
    // placeholder is safe for the `relayTransport === "mbregistry"` case.
    const physical = resolveRelayPhysical(store, relayLinkId, relayTransport === "mbrelay" ? "mbrelay" : "usb");
    const hidPath = physical.transport === "usb" ? ((physical.address as UsbAddress).hidPath ?? null) : null;
    const resetMethod = chooseResetMethod(hidPath, physical.transport);

    const stream: ByteStream =
      physical.transport === "usb"
        ? createSerialStreamFn((physical.address as UsbAddress).path)
        : physical.transport === "mbrelay"
          ? createTcpStreamFn(
              (physical.address as TcpAddress).host,
              (physical.address as TcpAddress).port,
              (physical.address as TcpAddress).ip,
            )
          : createMbregistryStreamFn(physical.address as MbregistryAddress, "relay");

    let lineLink: LineLink | undefined;
    const runPreamble = buildRelayPreamble(
      candidate.channel,
      candidate.group,
      () => lineLink as LineLink,
      scheduler,
      relayHandshakeTimeoutMs,
      syncOptions,
    );
    const preamble = async (openedStream: ByteStream, abortSignal: AbortSignal): Promise<void> => {
      if (resetBetweenCandidates) {
        await performReset(resetMethod, openedStream, hidPath, hidResetFn, breakMs, abortSignal, scheduler);
      }
      await runPreamble(openedStream, abortSignal);
    };

    lineLink = createLineLinkFn(stream, {
      identifyTimeoutMs: identifyBudgetMs,
      connectTimeoutMs,
      scheduler,
      preamble,
    });

    await lineLink.connect({ timeoutMs: connectTimeoutMs, signal });

    const banner = await identifyWithAbort(lineLink, signal, identifySchedule, scheduler);
    if (!banner) {
      void lineLink.close();
      throw new Error(`relayBridger: candidate "${candidate.childLinkId}" produced no banner within the identify budget`);
    }

    const classification: DeviceClassification = classifyBanner(banner);
    const deviceId = banner.serial;
    const name = deviceIdToName(deviceId);
    const kind: DeviceKind = classification.type === "relay" ? "relay" : "robot";
    // "usb"/"mbrelay" relayTransport map 1:1 onto "radio"/"mbrelay" child
    // links today (connector.ts's own address-shapes doc comment: "both
    // ride a relay, the only difference being whether that relay's own
    // link is reached over a local USB port ... or a remote TCP mbrelay
    // pool"). An "mbregistry"-transport relay row replaces either of
    // those two discovery paths (sprint.md Step 5's own "Impact"), so the
    // same local-vs-remote distinction is recovered from the resolved
    // `MbregistryAddress`'s own `endpoint` -- `null`/`undefined` for a
    // device local to this console's own mbregistry instance (the
    // `usb`-replacement case this ticket's own Description calls out) or
    // a `{host, port}` for a remote peer (the `mbrelay`-replacement case
    // `connector.test.ts`'s own "mbrelay: ... resolves to an
    // mbregistry-transport row" test exercises).
    const childTransport: Transport =
      relayTransport === "usb"
        ? "radio"
        : relayTransport === "mbrelay"
          ? "mbrelay"
          : (physical.address as MbregistryAddress).endpoint == null
            ? "radio"
            : "mbrelay";
    const address: RelayAddress = { relayLinkId, channel: candidate.channel, group: candidate.group };

    store.upsertDevice({ id: deviceId, name, kind, role: banner.role, commonName: banner.commonName, at: now() });
    store.upsertLink({ id: candidate.childLinkId, transport: childTransport, address, deviceId, at: now() });
    store.openSession(candidate.childLinkId, now());
    store.setLinkState({ id: candidate.childLinkId, state: "connected", at: now() });

    const session: ConnectedSession = {
      linkId: candidate.childLinkId,
      deviceId,
      transport: childTransport,
      link: lineLink,
      classification,
    };
    harvester.attach(session);
    return session;
  }

  /** See the module doc comment's "Sweep takeover" section. Aborts
   * `relayLinkId`'s currently-registered sweep pass (a no-op if none is
   * registered — e.g. the sweep released it independently between the
   * failed `acquireRelayLease` above and this call) and polls for the
   * lease to free, bounded by `takeoverMaxWaitMs`. Resolves `true` once
   * `owner` holds the lease, `false` on timeout — never throws except
   * for `signal`'s own abort. */
  async function takeoverSweepLease(relayLinkId: string, owner: string, signal: AbortSignal): Promise<boolean> {
    if (!revocation) {
      return false;
    }
    revocation.get(relayLinkId)?.abort(new Error(`relayBridger: takeover of relay "${relayLinkId}" requested by "${owner}"`));

    const deadline = now() + takeoverMaxWaitMs;
    for (;;) {
      if (signal.aborted) {
        throw abortError(signal);
      }
      if (store.acquireRelayLease(relayLinkId, owner, now())) {
        return true;
      }
      if (now() >= deadline) {
        return false;
      }
      await scheduler.delay(takeoverPollMs);
    }
  }

  return {
    async bridge(request: BridgeRequest, signal: AbortSignal): Promise<ConnectedSession> {
      if (request.candidates.length === 0) {
        throw new Error(`relayBridger: bridge() called with no candidates for relay "${request.relayLinkId}"`);
      }
      if (signal.aborted) {
        throw abortError(signal);
      }

      const relayTransport = relayLinkTransport(store, request.relayLinkId);
      const firstCandidate = request.candidates[0] as RelayBridgeCandidate;
      const owner = `session:${firstCandidate.childLinkId}`;
      // An mbrelay pool hands every TCP connection its own relay board, so
      // bridges through one pool never contend for a board and take no
      // lease -- see `reconciler.ts`'s `isRelayPool`. Only a USB radio
      // bridge (one serial port, one robot) is exclusive.
      // Sprint 018 ticket 007: an mbregistry-transport relay needs the
      // same lease as a usb one -- only mbrelay's own always-on TCP
      // bridge (no exclusive OS handle to contend over) skips it.
      const needsLease = relayTransport === "usb" || relayTransport === "mbregistry";

      let acquired = !needsLease || store.acquireRelayLease(request.relayLinkId, owner, now());
      if (!acquired) {
        // Sprint 016 ticket 004 (SUC-004): a sweep-held lease is
        // preemptable -- see the module doc comment's "Sweep takeover"
        // section and takeoverSweepLease's own doc comment. Any other
        // owner (an existing bridge) is not; this falls straight through
        // to the ordinary immediate-failure path below.
        const currentOwner = store.reconcilerRows().relayLeases.find((lease) => lease.relayLinkId === request.relayLinkId)?.owner;
        if (currentOwner === SWEEP_LEASE_OWNER) {
          acquired = await takeoverSweepLease(request.relayLinkId, owner, signal);
        }
      }
      if (!acquired) {
        const err = new Error(
          `relayBridger: could not acquire relay_leases for "${request.relayLinkId}" -- held by another owner`,
        );
        if (request.candidates.length === 1) {
          recordFailure(store, firstCandidate.childLinkId, err.message, now(), backoffCapMs);
        }
        throw err;
      }

      try {
        let lastError: Error = new Error(`relayBridger: no candidates given for relay "${request.relayLinkId}"`);
        for (const candidate of request.candidates) {
          if (signal.aborted) {
            throw abortError(signal);
          }
          try {
            return await attemptCandidate(request.relayLinkId, relayTransport, candidate, signal);
          } catch (error) {
            lastError = toError(error);
            if (request.candidates.length === 1) {
              recordFailure(store, candidate.childLinkId, lastError.message, now(), backoffCapMs);
            }
          }
        }
        throw new Error(
          `relayBridger: no candidate identified on relay "${request.relayLinkId}" (${request.candidates.length} tried) -- last error: ${lastError.message}`,
        );
      } finally {
        if (needsLease) {
          store.releaseRelayLease(request.relayLinkId, owner);
        }
      }
    },
  };
}
