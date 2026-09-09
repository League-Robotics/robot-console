/**
 * RelayConnectionCoordinator.ts — resolve a candidate robot name to an
 * address, connect through sprint 007's `LinkFactory`, and fail over to
 * the next candidate on exhaustion.
 *
 * ## Why this is its own module, not more seams on `DeviceRegistry`
 *
 * Per `sprint.md`'s Design Rationale entry "Avoiding a tenth seam on
 * `DeviceRegistry`": sprint 005's own Architecture already counted eight
 * injected seams on `DeviceRegistry` (`watcher`, `resolveName`,
 * `createLink`, `getFirmwareConfig`, `resolveRelease`,
 * `fetchAndVerifyHex`, `flash`, `knownRobotsStore`) and named that as
 * the point past which its fan-out "is carrying real god-component
 * risk," warning against a future sprint "materially growing its
 * responsibilities further... adding a tenth seam by reflex."
 * Resolution policy, failover retry/timeout logic, and composing
 * `mbrelayRegistry.ts` + sprint 007's `LinkFactory` are exactly the kind
 * of *logic* `DeviceRegistry`'s own module doc comment disclaims
 * ("orchestration only — never naming, banner-parsing, classification,
 * framing, or sequencing logic"), not bookkeeping. This class exists so
 * that logic is unit-testable with zero `EndpointState`/`KeyedMutex`
 * fixture setup, and so `DeviceRegistry` gains exactly one new seam
 * (this class, injected the same way `resolveName`/`createLink`/`flash`
 * already are) instead of three. Mirrors `KeyedMutex`'s own doc-comment
 * precedent of explaining *why* a class exists as its own thing, not
 * just what it does.
 *
 * ## What this module owns, and does not
 *
 * Owns: resolving one candidate name to an address (deferring to
 * `mbrelayRegistry.ts`'s `resolveRobotAddress` for `relay-radio`/
 * `mbrelay` targets), building the matching `LinkSpec`, connecting via
 * an injected `LinkFactory`, probing liveness with explicit retries and
 * a timeout budget, and advancing to the next candidate on exhaustion.
 *
 * Does **not** own: `EndpointState`, `KeyedMutex`, wire-message shapes,
 * or the physical relay reset (DAP reset over SWD) that must happen
 * before a fresh command-plane handshake — `DeviceRegistry` (ticket 004)
 * owns the physical relay and performs that reset itself before calling
 * this class; this class only ever receives an already-ready-to-dial
 * candidate (a `portPath`/`host`+`port` the caller has already prepared)
 * and a `LinkFactory` to build specs with. This class returns a plain
 * result object to its caller and never throws.
 *
 * ## Liveness probing: `checkLiveness()` (`PING`), never `HELLO`
 *
 * Per `sprint.md`'s Step 3: probing is `Link.checkLiveness()` (`PING`,
 * matched by a `pong`-verb reply line) under an explicit retry count and
 * per-attempt timeout, never `Link.identify()` (`HELLO`) — a shared
 * radio address may have more than one robot listening, and repeatedly
 * re-sending `HELLO` mid-probe would each reset the session
 * (`@robot-console/protocol`'s `Session` — see `Link.ts`'s own doc
 * comment). `identify()` is called exactly once, only after a probe
 * attempt succeeds — it both yields the classification this module's
 * result carries and serves as the session-reset `Link`'s contract
 * requires before sequenced traffic. `identify()` never throws (per its
 * own contract) and a `null` resolution (a live, connected, but silent
 * target) is treated as a normal, representable **success** here — the
 * probe already established liveness; a missing banner only downgrades
 * `classification`, mirroring `deviceRegistry.ts`'s own
 * "connected, unresponsive" state for a direct USB/relay session.
 *
 * ## Explicit address override (`addressSource: "explicit"`)
 *
 * A `relay-radio`/`mbrelay` candidate may supply an explicit
 * `{ channel, group }` override (OOP 2026-09-09: today's robot image
 * listens on a fixed 55/114, not the name-derived address). When
 * present, resolution is bypassed entirely — `resolveRobotAddress` is
 * not called for that candidate — and the result's `addressSource` is
 * the literal `"explicit"`, a fourth tag alongside
 * `mbrelayRegistry.ts`'s own `"config"`/`"registry"`/`"derived"`/
 * `"local-derived"` outcomes, so a caller (and the disclosure chip,
 * eventually) can tell "the caller pinned this address" apart from
 * every registry/derivation outcome.
 *
 * ## Discovery data flows in as plain candidate fields, not a live accessor
 *
 * `sprint.md`'s component diagram draws an edge from
 * `discovery/mdnsDiscovery.ts` directly into this module. This module
 * satisfies that edge by taking already-extracted discovery fields on
 * each {@link ConnectionCandidate} (a `relay-radio` candidate's
 * `portPath`/`resourceKey`, an `mbrelay`/`mbserial` candidate's
 * `host`/`port`, and either transport's optional resolved
 * `registry` location) rather than holding its own mDNS-snapshot
 * accessor and a name-matching policy of its own — the caller (ticket
 * 004's `DeviceRegistry`, which already composes `mdnsDiscovery.ts`)
 * extracts those fields once per attempt. This keeps discovery's own
 * matching/parsing logic entirely inside `mdnsDiscovery.ts` (this
 * module never re-derives it) while still never touching a real mDNS
 * socket or registry HTTP call directly — see `ResolveRobotAddressFn`.
 *
 * ## Everything is driven by injected dependencies
 *
 * `resolveRobotAddress` (a plain function, defaulting to the real
 * `mbrelayRegistry.ts` export), `LinkFactory` (sprint 007), and a
 * `Scheduler` (`link/pacing.ts` — reused rather than inventing a second
 * timing abstraction, the same choice `RelayCommandPlane.ts` and
 * `mbrelayRegistry.ts` already made) are all injectable, so this module
 * needs zero real I/O and zero real wall-clock delay to test.
 */

import { classifyBanner, type DeviceClassification, type ParsedBanner } from "@robot-console/protocol";
import type { Link, LinkFactory, LinkSpec } from "../link/Link.js";
import { realScheduler, type Scheduler } from "../link/pacing.js";
import {
  resolveRobotAddress as defaultResolveRobotAddress,
  type AddressOutcome,
  type RegistryLocation,
  type ResolvedAddress,
} from "../mbrelayRegistry.js";

/** An explicit `{ channel, group }` override, bypassing resolution
 * entirely for a `relay-radio`/`mbrelay` candidate — see the module doc
 * comment's "Explicit address override" section. */
export interface RadioAddressOverride {
  readonly channel: number;
  readonly group: number;
}

/** A `relay-radio` candidate: routes through a local USB relay whose
 * physical port/resource the caller (`DeviceRegistry`) already owns and
 * supplies directly — this module never discovers or opens a relay's
 * physical port itself. */
export interface RelayRadioCandidate {
  readonly transport: "relay-radio";
  /** The robot name to resolve/try. */
  readonly name: string;
  /** The local relay's OS device path, already resolved by the caller
   * (mirrors {@link import("../link/Link.js").RelayLinkSpec.portPath}). */
  readonly portPath: string;
  /** The physical relay's own `resourceKey`, shared with the relay's own
   * endpoint per `sprint.md`'s `KeyedMutex` design rationale. */
  readonly resourceKey: string;
  /** Registry location to resolve `name` against (the discovered
   * relay's own host + advertised `registryPort`), when one exists.
   * `undefined` yields `resolveRobotAddress`'s own `"local-derived"`
   * outcome. Ignored entirely when {@link address} is supplied. */
  readonly registry?: RegistryLocation;
  /** Explicit override — see the module doc comment. */
  readonly address?: RadioAddressOverride;
}

/** An `mbrelay` candidate: routes through a remote TCP relay discovered
 * via `_mbrelay._tcp`, whose host/port the caller already extracted from
 * the discovery snapshot. */
export interface MbrelayCandidate {
  readonly transport: "mbrelay";
  readonly name: string;
  readonly host: string;
  readonly port: number;
  readonly resourceKey: string;
  readonly registry?: RegistryLocation;
  readonly address?: RadioAddressOverride;
}

/** An `mbserial` candidate: the discovered `_mbserial._tcp` service's own
 * host/port, used directly — per `sprint.md`'s Design Rationale, the
 * registry is never consulted for this transport (there is no radio
 * channel/group to resolve at all), so no `registry`/`address` field
 * exists on this variant. */
export interface MbserialCandidate {
  readonly transport: "mbserial";
  readonly name: string;
  readonly host: string;
  readonly port: number;
  readonly resourceKey: string;
}

/** One candidate to try, in order. A single-candidate call (the common
 * "explicit dropdown pick" case) is simply a one-element array. */
export type ConnectionCandidate = RelayRadioCandidate | MbrelayCandidate | MbserialCandidate;

/** Every value {@link RelayConnectionCoordinator}'s result can report for
 * `addressSource` — `mbrelayRegistry.ts`'s own three registry-resolution
 * outcomes, `"local-derived"` (also from that module, covering "no
 * registry was ever discovered"), plus this module's own `"explicit"`
 * for a caller-supplied override. Absent entirely for an `mbserial`
 * result — see this module's doc comment. */
export type CoordinatorAddressSource = AddressOutcome | "explicit";

/** One candidate abandoned before the one that ultimately succeeded (or,
 * for an exhausted result, every candidate given). */
export interface FailoverTrailEntry {
  readonly name: string;
  readonly transport: ConnectionCandidate["transport"];
  /** Diagnostic text: why this candidate was abandoned (a transport
   * connect failure, or liveness-probe exhaustion). Never parsed by a
   * caller — for logging/disclosure only. */
  readonly reason: string;
}

/** A successful resolve-connect-identify attempt. */
export interface RelayConnectionSuccess {
  readonly outcome: "connected";
  readonly link: Link;
  readonly classification: DeviceClassification;
  readonly name: string;
  /** Present for `relay-radio`/`mbrelay`; absent (never `undefined`, per
   * `exactOptionalPropertyTypes`) for `mbserial` — see this module's doc
   * comment. */
  readonly addressSource?: CoordinatorAddressSource;
  /** Every candidate abandoned before this one — empty when the first
   * candidate given succeeded. */
  readonly failoverTrail: readonly FailoverTrailEntry[];
}

/** Every candidate in the list was exhausted — never a thrown exception,
 * never an unresolved promise (this module's own acceptance criteria). */
export interface RelayConnectionExhausted {
  readonly outcome: "exhausted";
  readonly failoverTrail: readonly FailoverTrailEntry[];
}

export type RelayConnectionResult = RelayConnectionSuccess | RelayConnectionExhausted;

/** The subset of `mbrelayRegistry.ts`'s `resolveRobotAddress` this module
 * calls — structurally satisfied by the real export (its third
 * `options` parameter is optional, so the real function is assignable
 * here as-is) and trivially fakeable in tests with no HTTP/timer setup
 * at all. */
export type ResolveRobotAddressFn = (
  name: string,
  registry: RegistryLocation | undefined,
) => Promise<ResolvedAddress>;

/** ms to wait for one `checkLiveness()` attempt's `pong` reply before
 * retrying. Mirrors `RelayCommandPlane.ts`'s own per-step timeout order
 * of magnitude. */
export const DEFAULT_PROBE_TIMEOUT_MS = 500;

/** How many `checkLiveness()` attempts one candidate gets before this
 * module gives up on it and moves to the next. */
export const DEFAULT_PROBE_ATTEMPTS = 3;

export interface RelayConnectionCoordinatorOptions {
  /** Builds a {@link Link} for a given {@link LinkSpec} (sprint 007).
   * Required — this module performs zero I/O of its own beyond calling
   * this and {@link resolveRobotAddress}. */
  readonly linkFactory: LinkFactory;
  /** Injectable `resolveRobotAddress`. Defaults to the real
   * `mbrelayRegistry.ts` export. Tests substitute a fake so no real HTTP
   * call or registry timing is ever exercised here — the write-on-read
   * trap and TTL cache are `mbrelayRegistry.ts`'s own concern, not
   * re-tested by this module. */
  readonly resolveRobotAddress?: ResolveRobotAddressFn;
  /** Injectable delay primitive for probe-attempt timeouts. Defaults to
   * real timers ({@link realScheduler}); tests substitute a fake so
   * every retry/timeout path is provable with no real wall-clock delay. */
  readonly scheduler?: Scheduler;
  /** ms to wait for one probe attempt's `pong` before retrying. Default
   * {@link DEFAULT_PROBE_TIMEOUT_MS}. */
  readonly probeTimeoutMs?: number;
  /** How many `checkLiveness()` attempts per candidate before giving up
   * on it. Default {@link DEFAULT_PROBE_ATTEMPTS}. */
  readonly probeAttempts?: number;
}

/** One candidate's outcome, internal to {@link RelayConnectionCoordinator.connect}'s
 * loop — collapsed into a {@link FailoverTrailEntry} on failure, or into
 * the final {@link RelayConnectionSuccess} on success. */
type AttemptResult =
  | { readonly ok: true; readonly link: Link; readonly classification: DeviceClassification; readonly addressSource?: CoordinatorAddressSource }
  | { readonly ok: false; readonly reason: string };

/**
 * Resolve → connect → probe → (identify) → fail over, per candidate, in
 * order. See the module doc comment for the full design.
 */
export class RelayConnectionCoordinator {
  private readonly linkFactory: LinkFactory;
  private readonly resolveRobotAddress: ResolveRobotAddressFn;
  private readonly scheduler: Scheduler;
  private readonly probeTimeoutMs: number;
  private readonly probeAttempts: number;

  constructor(options: RelayConnectionCoordinatorOptions) {
    this.linkFactory = options.linkFactory;
    this.resolveRobotAddress = options.resolveRobotAddress ?? defaultResolveRobotAddress;
    this.scheduler = options.scheduler ?? realScheduler;
    this.probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
    this.probeAttempts = options.probeAttempts ?? DEFAULT_PROBE_ATTEMPTS;
  }

  /**
   * Try each candidate in order, resolving an address, connecting, and
   * probing liveness, until one succeeds or the list is exhausted.
   * Never throws and never leaves an unresolved promise — see this
   * module's acceptance criteria.
   */
  async connect(candidates: readonly ConnectionCandidate[]): Promise<RelayConnectionResult> {
    const trail: FailoverTrailEntry[] = [];

    for (const candidate of candidates) {
      const attempt = await this.attempt(candidate);
      if (attempt.ok) {
        return {
          outcome: "connected",
          link: attempt.link,
          classification: attempt.classification,
          name: candidate.name,
          failoverTrail: trail,
          ...(attempt.addressSource !== undefined ? { addressSource: attempt.addressSource } : {}),
        };
      }
      trail.push({ name: candidate.name, transport: candidate.transport, reason: attempt.reason });
    }

    return { outcome: "exhausted", failoverTrail: trail };
  }

  /** Resolve, build the spec, connect, and probe liveness for exactly
   * one candidate. Always closes any transport it opened before
   * returning a failure. */
  private async attempt(candidate: ConnectionCandidate): Promise<AttemptResult> {
    let addressSource: CoordinatorAddressSource | undefined;
    let spec: LinkSpec;

    if (candidate.transport === "mbserial") {
      spec = {
        transport: "mbserial",
        resourceKey: candidate.resourceKey,
        host: candidate.host,
        port: candidate.port,
      };
    } else {
      let channel: number;
      let group: number;
      if (candidate.address !== undefined) {
        // Explicit override -- resolveRobotAddress is never called for
        // this candidate. See the module doc comment.
        channel = candidate.address.channel;
        group = candidate.address.group;
        addressSource = "explicit";
      } else {
        const resolved = await this.resolveRobotAddress(candidate.name, candidate.registry);
        channel = resolved.channel;
        group = resolved.group;
        addressSource = resolved.outcome;
      }
      spec =
        candidate.transport === "relay-radio"
          ? { transport: "relay-radio", resourceKey: candidate.resourceKey, portPath: candidate.portPath, channel, group }
          : { transport: "mbrelay", resourceKey: candidate.resourceKey, host: candidate.host, port: candidate.port, channel, group };
    }

    const link = this.linkFactory(spec);

    try {
      await link.connect();
    } catch (error) {
      await link.close().catch(() => {});
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, reason: `connect failed: ${message}` };
    }

    const isLive = await this.probeLiveness(link);
    if (!isLive) {
      await link.close().catch(() => {});
      return {
        ok: false,
        reason: `no liveness reply from ${candidate.name} after ${this.probeAttempts} probe attempt(s)`,
      };
    }

    // identify() never throws -- see the module doc comment's liveness
    // section. A null banner (connected, unresponsive) is still success
    // here; only classification reflects it.
    const banner: ParsedBanner | null = await link.identify();
    const classification = classifyBanner(banner);

    return addressSource !== undefined ? { ok: true, link, classification, addressSource } : { ok: true, link, classification };
  }

  /** Probe liveness via `checkLiveness()` (`PING`, matched by a
   * `pong`-verb reply) up to {@link probeAttempts} times, each bounded
   * by {@link probeTimeoutMs} via {@link scheduler}. Never calls
   * `identify()`/`HELLO` -- see this module's acceptance criteria. */
  private async probeLiveness(link: Link): Promise<boolean> {
    for (let attempt = 0; attempt < this.probeAttempts; attempt++) {
      const answered = await this.probeOnce(link);
      if (answered) {
        return true;
      }
    }
    return false;
  }

  /** One `checkLiveness()` call, raced against {@link probeTimeoutMs}.
   * Subscribes before calling `checkLiveness()` so a fake `Link` that
   * emits its `pong` synchronously is never missed. */
  private probeOnce(link: Link): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false;
      const unsubscribe = link.onLine((line) => {
        if (settled || line.verb !== "pong") {
          return;
        }
        settled = true;
        unsubscribe();
        resolve(true);
      });

      link.checkLiveness();

      void this.scheduler.delay(this.probeTimeoutMs).then(() => {
        if (settled) {
          return;
        }
        settled = true;
        unsubscribe();
        resolve(false);
      });
    });
  }
}
