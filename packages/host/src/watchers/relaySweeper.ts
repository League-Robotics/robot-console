/**
 * relaySweeper.ts — for each idle, `usb`-transport, `kind='relay'` link,
 * probe remembered robots over the relay's radio command-plane pass-
 * through and record what answers (sprint 016 ticket 003; issue
 * `rearch-10-relay-sweeper-radio-sightings.md`; `sprint.md`'s Step 3
 * module table, "relaySweeper" row; SUC-003).
 *
 * ## Never enters the data plane, never sends `HELLO`
 *
 * The relay's command plane already has the radio live: `!CG <ch> <grp>`
 * retunes, `> <text>` sends one line over the radio, `< <text>` delivers
 * whatever came back — all without ever sending `!GO` (`RelayCommandPlane.ts`'s
 * own `sync`/`setChannelGroup` steps, sprint 014's own groundwork for
 * exactly this use). This module drives `setChannelGroup` then the new
 * `probeRadioId` step (`link/RelayCommandPlane.ts`, this same ticket) and
 * nothing else — a sweep never sends `!GO`, never opens a `sessions` row,
 * and never sends `HELLO` (which would reset any robot mid-session with a
 * different host on that channel — `ID`, not `HELLO`, is this module's
 * own liveness probe, per rearch-10's own explicit reasoning).
 *
 * ## Rate limiting: at most one `!CG` per relay per interval
 *
 * Every `!CG` persists to the relay's flash until rearch-12's firmware
 * change ships (`saveConfig()` skips only *unchanged* values) — a sweep
 * retuning every couple of seconds would wear it out. This module holds
 * one relay's own physical port open for a whole pass (one `!CG`+probe
 * per remembered candidate), waiting at least {@link SWEEP_MIN_INTERVAL_MS}
 * between successive `!CG` writes to *this* relay — not skipping
 * candidates, just spacing them out — until {@link isFastSweepEnabled}
 * reports the relay has advertised rearch-12's non-persisting tune
 * (ticket 007's own capability-detection ticket; this ticket only defines
 * the read and its off-by-default seam — see that function's own doc
 * comment).
 *
 * ## Opens the relay's raw transport directly — never through the connector
 *
 * Same reasoning as `connect/relayBridger.ts` (see that module's own doc
 * comment and sprint.md's Design Rationale, "relayBridger/relaySweeper
 * open the relay's raw transport directly"): a sweep probe re-identifying
 * the relay every pass would be pure churn (writing and immediately
 * tearing down a fresh `sessions` row for no informational gain), and
 * architecture.md §3 rule 1 ("a watcher never opens a session, never
 * calls the connector") protects against exactly that outcome, not
 * against any component ever touching a byte stream. This module opens
 * the relay's own `usb` serial port directly (`link/adapters/serialStream.ts`)
 * and drives a small raw-line write/subscribe pair over it (mirrors
 * `connect/connector.ts`'s own `buildRelayPreamble` construction, minus
 * the `LineLink`/identify machinery this module never needs), never
 * touching `sessions` at all.
 *
 * ## Revocation seam registration
 *
 * `connect/relayLeaseRevocation.ts`'s shared `Map<relayLinkId,
 * AbortController>` is how a student's bridge (ticket 004) will signal a
 * running pass to stop. This module registers its own per-pass
 * `AbortController` for the duration of every pass and deregisters it in
 * `finally`, checking `signal.aborted` between candidates (never mid a
 * candidate's own <= 500ms `!CG`/`ID` wait — see {@link runOnePass}'s own
 * comment for why letting that one short wait finish, rather than
 * force-aborting it, is this ticket's own deliberate choice).
 *
 * ## Parked-in-the-data-plane recovery
 *
 * If a prior crash left the relay mid-preamble (past `!GO`) it will not
 * answer `?` — {@link ensureCommandPlaneReady} tries `sync()` once, and
 * only on failure performs ticket 002's own reset step
 * (`connect/relayBridger.ts`'s exported `chooseResetMethod`/
 * `performReset`), then confirms `sync()` again before the pass proceeds.
 * A pass that still cannot get the relay to answer `?` after that single
 * reset is abandoned for this cycle (lease released, tried again after
 * the quiet period) rather than retried indefinitely.
 */
import {
  RelayHandshakeError,
  probeRadioId,
  setChannelGroup,
  sync,
  type RelayLinkIO,
} from "../link/RelayCommandPlane.js";
import { LineReassembler } from "../link/lineStream.js";
import { realScheduler, WritePacer, type Scheduler } from "../link/pacing.js";
import type { ByteStream } from "../link/LineLink.js";
import { serialStream } from "../link/adapters/serialStream.js";
import {
  RELAY_PREAMBLE_WRITE_PACE_MS,
  resolveRelayPhysical,
  type UsbAddress,
} from "../connect/connector.js";
import {
  chooseResetMethod,
  defaultFailoverChildLinkId,
  defaultHidReset,
  performReset,
  resolveDefaultFailoverAddress,
  type RelayResetMethod,
} from "../connect/relayBridger.js";
import type { RelayLeaseRevocation } from "../connect/relayLeaseRevocation.js";
import type { DeviceRadioOverride } from "../radioOverride.js";
import {
  Store,
  type LinkState,
  type ProjectionDeviceRow,
  type ProjectionLinkRow,
  type RadioSightingRow,
  type Transport,
} from "../store/index.js";

// ---------------------------------------------------------------------
// Constants — every one bench-tunable, per sprint.md's own posture
// ("bench-tunable, not final") for exactly this kind of interval.
// ---------------------------------------------------------------------

/** At most one `!CG` per relay per this many ms until {@link
 * isFastSweepEnabled} reports the relay has advertised rearch-12's
 * non-persisting tune (sprint.md's own default: "a full pass over 20
 * robots takes ~10 minutes"). */
export const SWEEP_MIN_INTERVAL_MS = 30_000;
/** The interval {@link isFastSweepEnabled} switches to once ticket 007
 * detects the relay's advertised capability. Not reachable by this
 * ticket alone (nothing yet ever sets the setting {@link
 * isFastSweepEnabled} reads) — defined now so ticket 007 has a name to
 * import rather than inventing its own. */
export const SWEEP_FAST_INTERVAL_MS = 2_000;
/** Bound on each candidate's `!CG` confirmation wait and its `> ID`
 * reply wait — sprint.md's own SUC-003: "wait <= 500 ms". */
export const SWEEP_PROBE_TIMEOUT_MS = 500;
/** How long a relay sits idle between one pass ending (candidate list
 * exhausted, or abandoned after a failed ready-check) and the next pass
 * re-acquiring the lease. This ticket's own call — sprint.md's Step 3
 * table only says "sleep a quiet period, re-acquire" without naming a
 * value. */
export const SWEEP_QUIET_PERIOD_MS = 5_000;
/** How often this module re-scans `links` for newly-idle usb relays to
 * start a fresh per-relay sweep loop for. Mirrors `usbWatcher.ts`'s own
 * `DEFAULT_POLL_INTERVAL_MS`. */
export const SWEEP_SCAN_INTERVAL_MS = 1_000;
/** `relay_leases.owner` this module always acquires under —
 * architecture.md §7.2's own convention. */
export const SWEEP_OWNER = "sweep";
/** `sync()`'s own retry knobs for the lease-acquisition ready-check —
 * deliberately much shorter than a candidate probe's own budget: this is
 * "is the relay in its command plane at all", not a per-candidate wait. */
export const SWEEP_READY_SYNC_ATTEMPTS = 3;
export const SWEEP_READY_SYNC_RETRY_MS = 500;
/** `tasks.name` this module heartbeats once per scan tick. */
const TASK_NAME = "relaySweeper";

// ---------------------------------------------------------------------
// Backoff — pure, table-tested (ticket's own acceptance criterion).
// ---------------------------------------------------------------------

/** Base delay after a candidate's *first* consecutive sweep failure —
 * this ticket's own chosen table: 1 min, 2 min, 4 min, 8 min, ...,
 * capped at {@link SWEEP_BACKOFF_CAP_MS} (30 min). A name that keeps
 * failing is checked less and less often rather than on every single
 * pass, without ever being permanently excluded (a robot that comes back
 * online is still found — its next eligible attempt is merely delayed,
 * never dropped from the candidate list). */
export const SWEEP_BACKOFF_BASE_MS = 60_000;
/** Cap on {@link sweepBackoffMs} — never wait longer than this between
 * attempts for a name that keeps failing. */
export const SWEEP_BACKOFF_CAP_MS = 30 * 60_000;

/**
 * How long to wait, after a candidate's most recent attempt, before it is
 * eligible again — `0` for `consecutiveFailures <= 0` (never backed off;
 * either it has never failed, or its last attempt succeeded), otherwise
 * exponential from {@link SWEEP_BACKOFF_BASE_MS}, capped at {@link
 * SWEEP_BACKOFF_CAP_MS}. Pure — table-tested directly, no store/clock
 * involved.
 */
export function sweepBackoffMs(consecutiveFailures: number): number {
  if (consecutiveFailures <= 0) {
    return 0;
  }
  return Math.min(SWEEP_BACKOFF_BASE_MS * 2 ** (consecutiveFailures - 1), SWEEP_BACKOFF_CAP_MS);
}

/**
 * Is a candidate still within its backoff window at `now`, given its
 * radio link's own `failCount` and the time of its most recent attempt
 * (`lastAttemptAt`, `undefined` if never attempted)? Pure.
 */
export function isSweepCandidateBackedOff(failCount: number, lastAttemptAt: number | undefined, now: number): boolean {
  if (failCount <= 0 || lastAttemptAt === undefined) {
    return false;
  }
  return now < lastAttemptAt + sweepBackoffMs(failCount);
}

// ---------------------------------------------------------------------
// Candidate selection — pure, store-shape-in/store-shape-out so every
// piece is separately table-testable before the full pass loop.
// ---------------------------------------------------------------------

/** A device counts as "already reachable a better way" (and so is never
 * a sweep candidate) if it has a *connected* link over any of these
 * transports — sprint.md's own SUC-003 Main Flow: "no connected
 * usb/wifi/mbserial link". */
const BETTER_TRANSPORTS: ReadonlySet<Transport> = new Set(["usb", "wifi", "mbserial"]);

/**
 * Owned robots with no `connected` `usb`/`wifi`/`mbserial` link — the raw
 * candidate pool, before ordering or backoff. Pure.
 */
export function eligibleSweepDevices(
  devices: readonly ProjectionDeviceRow[],
  links: readonly ProjectionLinkRow[],
): ProjectionDeviceRow[] {
  const betterConnectedDeviceIds = new Set<number>();
  for (const link of links) {
    if (link.deviceId !== null && link.state === "connected" && BETTER_TRANSPORTS.has(link.transport)) {
      betterConnectedDeviceIds.add(link.deviceId);
    }
  }
  return devices.filter((d) => d.kind === "robot" && d.owned && !betterConnectedDeviceIds.has(d.id));
}

/**
 * Order candidates oldest radio `sightings.at` first (sprint.md's own
 * SUC-003 Main Flow: "oldest sighting first") — a device with no
 * successful radio sighting at all sorts first (never yet checked counts
 * as "longest overdue"). Pure.
 */
export function orderSweepCandidates(
  devices: readonly ProjectionDeviceRow[],
  radioSightings: readonly RadioSightingRow[],
): ProjectionDeviceRow[] {
  const sightingAt = new Map(radioSightings.map((s) => [s.deviceId, s.at] as const));
  return [...devices].sort((a, b) => (sightingAt.get(a.id) ?? -Infinity) - (sightingAt.get(b.id) ?? -Infinity));
}

/** The `links(radio)` row id a sighting of `name` via `relayLinkId` reads
 * and writes — the exact same convention
 * `connect/relayBridger.ts`'s own default-failover candidates mint, so a
 * sighting and a later bridge to the same name converge on one row (see
 * `defaultFailoverChildLinkId`'s own doc comment). */
export function radioChildLinkId(name: string, relayLinkId: string): string {
  return defaultFailoverChildLinkId("radio", name, relayLinkId);
}

/**
 * The full candidate queue for one pass against `relayLinkId`: {@link
 * eligibleSweepDevices}, ordered by {@link orderSweepCandidates}, with
 * any name still inside its own backoff window ({@link
 * isSweepCandidateBackedOff}, read off that name's own `links(radio)` row
 * for this relay) filtered out. Pure given already-read store rows and
 * `now`.
 */
export function buildSweepPassCandidates(
  devices: readonly ProjectionDeviceRow[],
  links: readonly ProjectionLinkRow[],
  radioSightings: readonly RadioSightingRow[],
  relayLinkId: string,
  now: number,
): ProjectionDeviceRow[] {
  const ordered = orderSweepCandidates(eligibleSweepDevices(devices, links), radioSightings);
  const linkById = new Map(links.map((l) => [l.id, l] as const));
  return ordered.filter((device) => {
    const link = linkById.get(radioChildLinkId(device.name, relayLinkId));
    if (!link) {
      return true;
    }
    return !isSweepCandidateBackedOff(link.failCount, link.lastSeen ?? undefined, now);
  });
}

// ---------------------------------------------------------------------
// Fast-sweep capability flag — a `settings` read, off by default. Ticket
// 007's own job is to *write* this once it detects the relay's advertised
// capability token (rearch-12); this ticket only defines the read and its
// default so the rate-limit mechanism has a real gate to switch on later
// without another sweeper change.
// ---------------------------------------------------------------------

/** `settings.key` for one relay's fast-sweep capability flag. Per-relay
 * (not global): a classroom can have relays on mixed firmware versions
 * at once, each independently advertising (or not) rearch-12's
 * non-persisting tune. */
export function fastSweepSettingKey(relayLinkId: string): string {
  return `relaySweepFast:${relayLinkId}`;
}

/**
 * Has ticket 007 recorded that `relayLinkId` advertised rearch-12's
 * capability? Reads `store.getSetting(fastSweepSettingKey(relayLinkId))`,
 * `true` only for the literal value `"1"` — anything else (unset,
 * malformed) is treated as "not yet advertised", so this defaults off
 * until ticket 007 actually writes it. See this module's own doc comment
 * for why a `settings` row, not the in-memory-only shape sprint.md's own
 * "No ERD" section sketches for the *detection* step itself: ticket 007
 * owns how it re-derives the flag on each lease acquisition; this
 * function is only the read contract this ticket promises to honor.
 */
export function isFastSweepEnabled(store: Store, relayLinkId: string): boolean {
  return store.getSetting(fastSweepSettingKey(relayLinkId)) === "1";
}

// ---------------------------------------------------------------------
// Raw line write/subscribe pair over a directly-opened ByteStream —
// mirrors connect/connector.ts's own buildRelayPreamble construction,
// minus the LineLink/identify machinery this module never needs (see the
// module doc comment's "opens the relay's raw transport directly"
// section).
// ---------------------------------------------------------------------

function buildRawLineIO(stream: ByteStream, scheduler: Scheduler): RelayLinkIO {
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
        // No separate reporting channel at this phase either -- same
        // posture as connector.ts's own buildRelayPreamble: a real write
        // failure surfaces via this step's own confirmation wait timing
        // out, or the stream's own "error"/"close" event.
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

// ---------------------------------------------------------------------
// Injectable seams
// ---------------------------------------------------------------------

export interface RelaySweeperDeps {
  /** Injectable USB serial adapter factory. Defaults to the real {@link
   * serialStream}. Tests substitute a factory returning a fake `ByteStream`. */
  createSerialStream?: (path: string) => ByteStream;
  /** Governs every wait this module makes (write pacing, the ready-check
   * sync loop, each candidate's CG/ID waits, the rate-limit/quiet-period
   * sleeps). Defaults to {@link realScheduler}. */
  scheduler?: Scheduler;
  /** Wall-clock reader for every store timestamp and rate-limit/backoff
   * comparison. Defaults to `Date.now`. */
  now?: () => number;
  /** Injectable DAPLink-over-HID reset primitive, forwarded to
   * `connect/relayBridger.ts`'s exported {@link performReset} exactly as
   * that module's own `RelayBridgerDeps.hidReset` is. Defaults to the
   * real `defaultHidReset` (`connect/relayBridger.ts`) — tests always
   * substitute a fake (no test in this repository ever opens a real HID
   * device). */
  hidReset?: (hidPath: string, signal: AbortSignal) => Promise<void>;
  /** Forwarded to `performReset`'s own `sendBreak` call. */
  breakMs?: number;
  /** The shared revocation seam (`connect/relayLeaseRevocation.ts`) this
   * sweeper registers its per-pass `AbortController` with. Required —
   * unlike every other dep here, there is no sensible "real" default a
   * caller could omit: `runtime.ts` constructs exactly one instance and
   * shares it with (ticket 004's) bridger. */
  revocation: RelayLeaseRevocation;
}

export interface RelaySweeperOptions {
  /** Default {@link SWEEP_MIN_INTERVAL_MS}. */
  sweepMinIntervalMs?: number;
  /** Default {@link SWEEP_FAST_INTERVAL_MS}. */
  fastSweepIntervalMs?: number;
  /** Default {@link SWEEP_PROBE_TIMEOUT_MS}. */
  probeTimeoutMs?: number;
  /** Default {@link SWEEP_QUIET_PERIOD_MS}. */
  quietPeriodMs?: number;
  /** Default {@link SWEEP_SCAN_INTERVAL_MS}. */
  scanIntervalMs?: number;
  /** Default {@link SWEEP_READY_SYNC_ATTEMPTS}. */
  readySyncAttempts?: number;
  /** Default {@link SWEEP_READY_SYNC_RETRY_MS}. */
  readySyncRetryMs?: number;
}

export interface RelaySweeperHandle {
  /** Stop the scan tick and abort every in-flight per-relay pass.
   * Idempotent. */
  stop(): void;
}

/** Resolve (or reject) once `ms` has elapsed, or immediately once `signal`
 * aborts — used for the rate-limit wait between candidates and the
 * inter-pass quiet period, both of which must be cut short immediately on
 * abort (unlike a single candidate's own <= `probeTimeoutMs` CG/ID wait —
 * see {@link RelaySweepPassRunner.runOnePass}'s own comment for why those
 * are deliberately NOT abort-gated the same way). Module-level (not a
 * closure) so both {@link createRelaySweepPassRunner} (the rate-limit
 * wait) and {@link startRelaySweeper} (the inter-pass quiet period) share
 * one implementation. */
function abortableDelay(scheduler: Scheduler, ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted || ms <= 0) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    let settled = false;
    const onAbort = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void scheduler.delay(ms).then(() => {
      if (settled) {
        return;
      }
      settled = true;
      signal.removeEventListener("abort", onAbort);
      resolve();
    });
  });
}

// ---------------------------------------------------------------------
// createRelaySweepPassRunner — the per-relay probe pass, factored out
// from the scan/loop machinery below so it is directly callable from a
// test with one `relayLinkId` and one `AbortController`, with no need to
// wait on a real scan-interval tick (sprint.md's own Implementation Plan
// phasing: "the per-candidate probe step... then the task loop
// (start/stop/heartbeat)" — this is that probe-step layer).
// ---------------------------------------------------------------------

/** Options {@link createRelaySweepPassRunner} itself reads — the subset
 * of {@link RelaySweeperOptions} relevant to one pass; `quietPeriodMs`/
 * `scanIntervalMs` belong to {@link startRelaySweeper}'s own scan/loop
 * layer instead. */
export interface RelaySweepPassRunnerOptions {
  sweepMinIntervalMs?: number;
  fastSweepIntervalMs?: number;
  probeTimeoutMs?: number;
  readySyncAttempts?: number;
  readySyncRetryMs?: number;
}

export interface RelaySweepPassRunner {
  /** Run one full pass over `relayLinkId`: acquire the sweep lease,
   * confirm (or recover) the command plane, probe every eligible
   * candidate in order (rate-limited), then release. Never throws past
   * its own `finally` cleanup — a caller (`startRelaySweeper`'s own loop,
   * or a test) still wraps this in its own `try`/`catch` defensively,
   * but nothing inside this method itself is expected to escape it. */
  runOnePass(relayLinkId: string, passController: AbortController): Promise<void>;
}

/**
 * Build a {@link RelaySweepPassRunner} bound to `store`. See the module
 * doc comment for the full per-pass flow; see {@link RelaySweeperDeps}/
 * {@link RelaySweepPassRunnerOptions} for every injectable seam.
 */
export function createRelaySweepPassRunner(
  store: Store,
  deps: RelaySweeperDeps,
  opts: RelaySweepPassRunnerOptions = {},
): RelaySweepPassRunner {
  const createSerialStreamFn = deps.createSerialStream ?? ((path: string) => serialStream(path));
  const scheduler = deps.scheduler ?? realScheduler;
  const now = deps.now ?? (() => Date.now());
  const hidResetFn = deps.hidReset ?? ((hidPath: string, signal: AbortSignal) => defaultHidReset(hidPath, signal));
  const breakMs = deps.breakMs;
  const revocation = deps.revocation;

  const sweepMinIntervalMs = opts.sweepMinIntervalMs ?? SWEEP_MIN_INTERVAL_MS;
  const fastSweepIntervalMs = opts.fastSweepIntervalMs ?? SWEEP_FAST_INTERVAL_MS;
  const probeTimeoutMs = opts.probeTimeoutMs ?? SWEEP_PROBE_TIMEOUT_MS;
  const readySyncAttempts = opts.readySyncAttempts ?? SWEEP_READY_SYNC_ATTEMPTS;
  const readySyncRetryMs = opts.readySyncRetryMs ?? SWEEP_READY_SYNC_RETRY_MS;

  /** Confirm the relay answers `?` (still in its command plane); if not,
   * perform ticket 002's own reset step once, then confirm again. Returns
   * `false` if the relay still does not answer after that one reset —
   * the pass is abandoned for this cycle rather than retried
   * indefinitely (sprint.md's own SUC-003 wording: "perform the reset
   * step once, then continue"). */
  async function ensureCommandPlaneReady(
    io: RelayLinkIO,
    stream: ByteStream,
    hidPath: string | null,
    resetMethod: RelayResetMethod,
    signal: AbortSignal,
  ): Promise<boolean> {
    if (signal.aborted) {
      return false;
    }
    try {
      await sync({ ...io, scheduler, syncAttempts: readySyncAttempts, syncRetryMs: readySyncRetryMs, signal });
      return true;
    } catch {
      // Not answering `?` -- parked in the data plane by a prior crash.
      // Fall through to the one-time reset below.
    }
    try {
      await performReset(resetMethod, stream, hidPath, hidResetFn, breakMs, signal);
    } catch {
      return false;
    }
    try {
      await sync({ ...io, scheduler, syncAttempts: readySyncAttempts, syncRetryMs: readySyncRetryMs, signal });
      return true;
    } catch {
      return false;
    }
  }

  /** Record one candidate's outcome: a `sightings` row always; on success
   * upsert `links(radio, connectable)` (failCount reset to 0 -- a fresh
   * success clears any prior consecutive-failure streak); on failure,
   * `upsertLink` still runs (so a never-before-seen name gets a row to
   * bump `fail_count` on -- ticket's own AC: "non-answering names show
   * fail_count = 1"), but the link's existing `state` is left exactly as
   * it was (ticket's own words: "leave any existing radio link"). */
  function recordCandidateOutcome(
    candidate: ProjectionDeviceRow,
    relayLinkId: string,
    channel: number,
    group: number,
    ok: boolean,
    at: number,
  ): void {
    const linkId = radioChildLinkId(candidate.name, relayLinkId);
    store.recordSighting({
      deviceId: candidate.id,
      name: candidate.name,
      transport: "radio",
      viaLinkId: relayLinkId,
      at,
      ok,
      detail: ok ? null : "no ID reply within the probe window",
    });
    store.upsertLink({
      id: linkId,
      transport: "radio",
      address: { relayLinkId, channel, group },
      deviceId: candidate.id,
      at,
    });
    if (ok) {
      store.setLinkState({ id: linkId, state: "connectable", at, failCount: 0 });
      return;
    }
    const current = store.snapshotRows().links.find((l) => l.id === linkId);
    const preservedState = (current?.state as LinkState | undefined) ?? "discovered";
    const failCount = Number(current?.fail_count ?? 0) + 1;
    store.setLinkState({ id: linkId, state: preservedState, at, failCount });
  }

  /** One full pass over `relayLinkId` — see {@link RelaySweepPassRunner.runOnePass}'s
   * own doc comment. Never throws past `finally`'s own cleanup —
   * `startRelaySweeper`'s own loop still wraps a call to this in its own
   * `try`/`catch` defensively (mirrors `usbWatcher.ts`'s own per-attach
   * discipline), but nothing here is expected to reach it. */
  async function runOnePass(relayLinkId: string, passController: AbortController): Promise<void> {
    const acquired = store.acquireRelayLease(relayLinkId, SWEEP_OWNER, now());
    if (!acquired) {
      return;
    }
    revocation.register(relayLinkId, passController);
    let stream: ByteStream | undefined;
    try {
      if (passController.signal.aborted) {
        return;
      }
      const physical = resolveRelayPhysical(store, relayLinkId, "usb");
      const usbAddress = physical.address as UsbAddress;
      const hidPath = usbAddress.hidPath ?? null;
      const resetMethod = chooseResetMethod(hidPath, "usb");

      stream = createSerialStreamFn(usbAddress.path);
      await stream.open(passController.signal);
      const io = buildRawLineIO(stream, scheduler);

      const ready = await ensureCommandPlaneReady(io, stream, hidPath, resetMethod, passController.signal);
      if (!ready) {
        return;
      }

      const fastEnabled = isFastSweepEnabled(store, relayLinkId);
      const intervalMs = fastEnabled ? fastSweepIntervalMs : sweepMinIntervalMs;

      const projection = store.projectionRows();
      const queue = buildSweepPassCandidates(projection.devices, projection.links, store.radioSightings(), relayLinkId, now());

      let lastCgAt: number | undefined;
      for (const candidate of queue) {
        if (passController.signal.aborted) {
          break;
        }

        // Rate limit: at most one !CG per relay per intervalMs. This
        // wait -- unlike the CG/ID waits below -- IS abort-gated: it can
        // be many seconds long (up to sweepMinIntervalMs), and "between
        // probes, check the abort signal" (ticket's own words) means
        // here, not mid a single <= probeTimeoutMs confirmation wait.
        if (lastCgAt !== undefined) {
          const waitMs = lastCgAt + intervalMs - now();
          if (waitMs > 0) {
            await abortableDelay(scheduler, waitMs, passController.signal);
          }
        }
        if (passController.signal.aborted) {
          break;
        }

        const override: DeviceRadioOverride = {
          radioChannel: candidate.radioChannel,
          radioGroup: candidate.radioGroup,
          radioSource: candidate.radioSource,
        };
        const { channel, group } = await resolveDefaultFailoverAddress(candidate.name, override);

        let ok = false;
        try {
          // Deliberately NOT passed `passController.signal`: on abort
          // mid-candidate, this module lets the *current* <= probeTimeoutMs
          // wait finish naturally (never longer than probeTimeoutMs
          // anyway) rather than force-cancelling it -- the module doc
          // comment's own "Revocation seam registration" section, and
          // ticket's own wording ("on abort, finish the current wait").
          await setChannelGroup(channel, group, { ...io, scheduler, timeoutMs: probeTimeoutMs });
          ok = await probeRadioId(candidate.name, { ...io, scheduler, timeoutMs: probeTimeoutMs });
        } catch (error) {
          if (!(error instanceof RelayHandshakeError)) {
            throw error;
          }
          ok = false;
        }
        // Measured AFTER the !CG write (and its confirmation wait, and
        // the ID probe) rather than before: a "before" timestamp
        // systematically understates the actual on-wire gap between
        // successive !CG writes by however long the write itself takes
        // to leave the pacer -- measuring here only ever adds margin to
        // the next candidate's rate-limit wait, never subtracts from it,
        // which is what "no two !CG writes closer than intervalMs"
        // actually requires. Set unconditionally (success or
        // RelayHandshakeError alike) -- a rejected/unconfirmed !CG was
        // still a physical write to the relay, so it still counts
        // against the rate limit.
        const outcomeAt = now();
        lastCgAt = outcomeAt;
        recordCandidateOutcome(candidate, relayLinkId, channel, group, ok, outcomeAt);
      }
    } finally {
      if (stream) {
        await stream.close().catch(() => {
          // Best-effort close only -- mirrors identifyWithAbort's own
          // "close and move on" discipline elsewhere in this codebase.
        });
      }
      revocation.clear(relayLinkId, passController);
      store.releaseRelayLease(relayLinkId, SWEEP_OWNER);
    }
  }

  return { runOnePass };
}

// ---------------------------------------------------------------------
// startRelaySweeper — the scan/loop layer around createRelaySweepPassRunner
// ---------------------------------------------------------------------

/**
 * Start the relay sweeper against `store`. See the module doc comment
 * for the full per-pass flow. Returns a handle whose `stop()` tears
 * everything down — architecture.md §3 rule 5: every long-lived task has
 * `start()`/`stop()`.
 */
export function startRelaySweeper(store: Store, deps: RelaySweeperDeps, opts: RelaySweeperOptions = {}): RelaySweeperHandle {
  const scheduler = deps.scheduler ?? realScheduler;
  const now = deps.now ?? (() => Date.now());
  const quietPeriodMs = opts.quietPeriodMs ?? SWEEP_QUIET_PERIOD_MS;
  const scanIntervalMs = opts.scanIntervalMs ?? SWEEP_SCAN_INTERVAL_MS;
  const passRunner = createRelaySweepPassRunner(store, deps, opts);

  /** One entry per relay this module currently runs a sweep loop for —
   * mirrors `usbWatcher.ts`'s own `attachTasks` Map. The controller here
   * is the *loop's* own lifetime signal (stopped by `stop()` or by a
   * relay going ineligible), distinct from each individual pass's own
   * `AbortController` registered with the revocation seam inside {@link
   * createRelaySweepPassRunner}. */
  const relayLoops = new Map<string, AbortController>();
  let stopped = false;

  /** One relay's own forever-loop: pass, quiet period, repeat, until
   * `stop()` or `outerSignal` fires. A single failed pass never crashes
   * this loop -- mirrors `usbWatcher.ts`'s own `handleAdded().catch()`. */
  async function runRelayLoop(relayLinkId: string, outerSignal: AbortSignal): Promise<void> {
    while (!stopped && !outerSignal.aborted) {
      const passController = new AbortController();
      const onOuterAbort = (): void => passController.abort(outerSignal.reason);
      outerSignal.addEventListener("abort", onOuterAbort, { once: true });
      try {
        await passRunner.runOnePass(relayLinkId, passController);
      } catch {
        // A pass that throws past its own try/finally (e.g. the relay's
        // physical link vanished mid-pass) must not take down the whole
        // sweeper -- try again after the quiet period below.
      } finally {
        outerSignal.removeEventListener("abort", onOuterAbort);
      }
      store.heartbeat(TASK_NAME, now());
      if (stopped || outerSignal.aborted) {
        return;
      }
      await abortableDelay(scheduler, quietPeriodMs, outerSignal);
    }
  }

  function startLoopFor(relayLinkId: string): void {
    const outerController = new AbortController();
    relayLoops.set(relayLinkId, outerController);
    void runRelayLoop(relayLinkId, outerController.signal).finally(() => {
      if (relayLoops.get(relayLinkId) === outerController) {
        relayLoops.delete(relayLinkId);
      }
    });
  }

  /** A `usb`-transport, `kind='relay'` link sitting idle (ticket 001's
   * own `connectable` idle state) -- the only thing this module ever
   * starts a sweep loop for. */
  function isEligibleIdleRelayLink(link: ProjectionLinkRow, deviceKindById: Map<number, string>): boolean {
    return (
      link.transport === "usb" &&
      link.deviceId !== null &&
      deviceKindById.get(link.deviceId) === "relay" &&
      link.state === "connectable"
    );
  }

  function scanOnce(): void {
    if (stopped) {
      return;
    }
    const projection = store.projectionRows();
    const deviceKindById = new Map(projection.devices.map((d) => [d.id, d.kind] as const));
    const currentlyEligible = new Set<string>();

    for (const link of projection.links) {
      if (isEligibleIdleRelayLink(link, deviceKindById)) {
        currentlyEligible.add(link.id);
        if (!relayLoops.has(link.id)) {
          startLoopFor(link.id);
        }
      }
    }

    // A relay that stopped being eligible (taken over, removed, gone
    // stale) gets its loop stopped -- it will be picked up again by a
    // later scan if it becomes idle again.
    for (const [relayLinkId, controller] of [...relayLoops.entries()]) {
      if (!currentlyEligible.has(relayLinkId)) {
        controller.abort(new Error("relaySweeper: relay no longer an idle usb relay"));
        relayLoops.delete(relayLinkId);
      }
    }

    store.heartbeat(TASK_NAME, now());
  }

  const timer: ReturnType<typeof setInterval> = setInterval(() => {
    try {
      scanOnce();
    } catch {
      // Defensive only -- a real Store always implements every method
      // this tick reads; this guard exists so a caller that supplies an
      // incomplete/fake store for a collaborator it does not itself
      // exercise (e.g. a composition-root test overriding every other
      // dependency but this one) can never crash the process from this
      // tick alone, mirroring `usbWatcher.ts`'s own per-item catch
      // discipline applied at the tick level instead.
    }
  }, scanIntervalMs);
  timer.unref?.();

  return {
    stop(): void {
      if (stopped) {
        return;
      }
      stopped = true;
      clearInterval(timer);
      for (const controller of relayLoops.values()) {
        controller.abort(new Error("relaySweeper: stopped"));
      }
      relayLoops.clear();
    },
  };
}
