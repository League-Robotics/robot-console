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
 * already performs the reconnect, so that branch is a deliberate no-op.
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
import { realScheduler, type Scheduler } from "../link/pacing.js";
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
import {
  DEFAULT_BACKOFF_CAP_MS,
  DEFAULT_CONNECT_TIMEOUT_MS,
  NO_OP_HARVESTER,
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
   * to the real {@link tcpStream}. */
  createTcpStream?: (host: string, port: number) => ByteStream;
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
}

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

export type RelayResetMethod = "hid" | "break" | "reconnect";

/**
 * Choose how to reset the physical relay before a candidate's preamble:
 * `"hid"` when the relay's own `usb` link carries a `hidPath`, else
 * `"break"` for a `usb`-transport relay with none, else `"reconnect"`
 * for an `mbrelay`-transport (TCP) relay — a break cannot be sent over
 * TCP (`docs/design/specification.md` §6), and a fresh per-candidate TCP
 * connection already performs the reconnect. Pure — no I/O.
 */
export function chooseResetMethod(hidPath: string | null, relayTransport: "usb" | "mbrelay"): RelayResetMethod {
  if (relayTransport === "mbrelay") {
    return "reconnect";
  }
  return hidPath ? "hid" : "break";
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

function relayLinkTransport(store: Store, relayLinkId: string): "usb" | "mbrelay" {
  const row = store.snapshotRows().links.find((candidate) => candidate.id === relayLinkId);
  if (!row) {
    throw new Error(`relayBridger: relay link "${relayLinkId}" not found in the store`);
  }
  // Positive-narrowing (not `!==`) so this actually narrows `row.transport`
  // (typed `unknown` -- `StoreSnapshot.links` is a raw, untyped passthrough,
  // `store/index.ts`'s own doc comment) down from `unknown` to the literal
  // union: negated equality checks against an `unknown` value never narrow
  // it (there is no enumerable union to eliminate members from).
  if (row.transport === "usb" || row.transport === "mbrelay") {
    return row.transport;
  }
  throw new Error(`relayBridger: relay link "${relayLinkId}" is transport "${String(row.transport)}", expected "usb" or "mbrelay"`);
}

/**
 * Build a {@link RelayBridger} bound to `store`. See the module doc
 * comment for the full contract; see {@link RelayBridgerDeps}/{@link
 * RelayBridgerOptions} for every injectable seam.
 */
export function createRelayBridger(store: Store, deps: RelayBridgerDeps = {}, opts: RelayBridgerOptions = {}): RelayBridger {
  const createSerialStreamFn = deps.createSerialStream ?? ((path: string) => serialStream(path));
  const createTcpStreamFn = deps.createTcpStream ?? ((host: string, port: number) => tcpStream(host, port));
  const createLineLinkFn = deps.createLineLink ?? ((stream: ByteStream, options: LineLinkOptions) => new LineLink(stream, options));
  const scheduler = deps.scheduler ?? realScheduler;
  const now = deps.now ?? (() => Date.now());
  const harvester = deps.harvester ?? NO_OP_HARVESTER;
  const hidResetFn = deps.hidReset ?? ((hidPath: string, signal: AbortSignal) => defaultHidReset(hidPath, signal));
  const breakMs = deps.breakMs;

  const connectTimeoutMs = opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const identifySchedule = opts.identifySchedule ?? DEFAULT_IDENTIFY_SCHEDULE_MS;
  const identifyBudgetMs = opts.identifyBudgetMs ?? DEFAULT_IDENTIFY_BUDGET_MS;
  const relayHandshakeTimeoutMs = opts.relayHandshakeTimeoutMs;
  const backoffCapMs = opts.backoffCapMs ?? DEFAULT_BACKOFF_CAP_MS;
  const resetBetweenCandidates = opts.resetBetweenCandidates ?? true;
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
    relayTransport: "usb" | "mbrelay",
    candidate: RelayBridgeCandidate,
    signal: AbortSignal,
  ): Promise<ConnectedSession> {
    if (signal.aborted) {
      throw abortError(signal);
    }

    const physical = resolveRelayPhysical(store, relayLinkId, relayTransport);
    const hidPath = physical.transport === "usb" ? ((physical.address as UsbAddress).hidPath ?? null) : null;
    const resetMethod = chooseResetMethod(hidPath, physical.transport);

    const stream: ByteStream =
      physical.transport === "usb"
        ? createSerialStreamFn((physical.address as UsbAddress).path)
        : createTcpStreamFn((physical.address as TcpAddress).host, (physical.address as TcpAddress).port);

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
        await performReset(resetMethod, openedStream, hidPath, hidResetFn, breakMs, abortSignal);
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
    const childTransport: Transport = relayTransport === "usb" ? "radio" : "mbrelay";
    const address: RelayAddress = { relayLinkId, channel: candidate.channel, group: candidate.group };

    store.upsertDevice({ id: deviceId, name, kind, role: banner.role, at: now() });
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

      const acquired = store.acquireRelayLease(request.relayLinkId, owner, now());
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
        store.releaseRelayLease(request.relayLinkId, owner);
      }
    },
  };
}
