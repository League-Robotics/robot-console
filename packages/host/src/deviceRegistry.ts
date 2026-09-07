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
 * ## Flash flow (sprint 2)
 *
 * {@link DeviceRegistry.requestFlash} is one more operation run through
 * the same per-endpoint {@link KeyedMutex} as name resolution/link open/
 * close/send -- not a new synchronization mechanism. It composes
 * `config.ts` (which firmware source) -> `releases.ts` (fetch+verify
 * the hex) -> `flash.ts` (write it) as one mutex-guarded task: tear
 * down any open link first (so `flash.ts`'s DAPjs session never
 * contends with an open serial port over the same physical board),
 * look up the configured `FirmwareSource`, fetch+verify the hex
 * (reporting `"fetching"`/`"verifying"` progress), write it (reporting
 * `"erasing"`/`"writing"`/`"resetting"` progress), and -- on success --
 * connect and identify a link exactly the way the attach flow above
 * already does, so the newly-flashed firmware's banner is picked up
 * with no separate manual Connect click. See {@link DeviceRegistry.requestFlash}'s own
 * doc comment for why this task holds the endpoint's mutex slot across
 * the network fetch rather than releasing and re-acquiring it. A
 * failure at any stage clears `flashStatus` and reports a `flash-result`
 * error -- it never leaves `flashStatus` stuck or the registry believing
 * a link is open when {@link teardownLink} already closed it.
 *
 * Sprint 4 note: this ticket reshapes `FlashResultMessage` to carry
 * optional `classification`/`name`/`reidentify` fields and adds
 * `"reidentifying"` to {@link FlashPhase}, but {@link DeviceRegistry.requestFlash}
 * itself is *not yet* changed to populate them or to wait for a
 * post-flash re-identify -- it still clears `flashStatus` and reports
 * `flash-result` immediately after a successful write, exactly as
 * before. A later ticket makes the reidentify sequencing real; this one
 * only freezes the shape it will report through.
 */

import type { DecodedLine, DeviceClassification } from "@robot-console/protocol";
import { classifyBanner, encodeLine } from "@robot-console/protocol";
import {
  DeviceWatcher,
  type DaplinkDevice,
  type DeviceChangeEvent,
} from "./devices.js";
import { readSwdName, type SwdNameResult } from "./swdName.js";
import { UsbSerialLink } from "./link/UsbSerialLink.js";
import type { Link, LinkFactory, LinkSpec } from "./link/Link.js";
import { getFirmwareConfig, type FirmwareConfigMap } from "./config.js";
import { resolveRelease, fetchAndVerifyHex } from "./releases.js";
import { flash } from "./flash.js";
import type { EndpointListEntry, LineDirection, FirmwareKind, FlashPhase } from "./wsMessages.js";

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

// ---------------------------------------------------------------------
// Injectable seams (real implementations by default; fakes in tests)
// ---------------------------------------------------------------------

export type NameResolver = (device: DaplinkDevice) => Promise<SwdNameResult>;

/** Real `Link` factory: builds a {@link UsbSerialLink} from a
 * {@link LinkSpec} (only the `"usb"` variant exists this sprint --
 * see `link/Link.ts`'s own doc comment). Tests substitute a fake
 * {@link LinkFactory} returning a fully synthetic {@link Link}, without
 * any real `serialport` I/O -- the ticket's own testing note asks for
 * exactly this. */
function defaultLinkFactory(spec: LinkSpec): Link {
  return new UsbSerialLink(spec.portPath);
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
 * ({@link DeviceRegistry.sendLine}). Absent whenever there is no open
 * session for the endpoint (never connected, a `connect()` failure, or
 * after teardown) -- see {@link EndpointState.sessionOpen}'s own doc
 * comment for why "open" is tracked as its own field rather than
 * derived from this object's presence. */
interface EndpointSession {
  link: Link;
  unsubscribeLine: () => void;
  unsubscribeError: () => void;
}

interface EndpointState {
  device: DaplinkDevice;
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
  /** Present only while a flash is in flight for this device (sprint
   * 2) -- set at the start of {@link DeviceRegistry.requestFlash}'s
   * task and cleared (success or error) at its end. Reflected into
   * {@link EndpointListEntry.flashStatus} by {@link toEntry}. */
  flashStatus?: { firmware: FirmwareKind; phase: FlashPhase } | undefined;
}

function toEntry(state: EndpointState): EndpointListEntry {
  const entry: EndpointListEntry = {
    endpointId: state.endpointId,
    transport: "usb",
    resourceKey: state.resourceKey,
    classification: state.classification,
    name: state.name,
    role: state.classification.role,
    sessionOpen: state.sessionOpen,
    usb: {
      serialNumber: state.device.serialNumber,
      displaySerial: state.device.displaySerial,
      port: state.device.serialPort?.path ?? null,
    },
  };
  if (state.nameError) {
    entry.nameError = state.nameError;
  }
  if (state.sessionError) {
    entry.sessionError = state.sessionError;
  }
  if (state.flashStatus) {
    entry.flashStatus = state.flashStatus;
  }
  return entry;
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
export type LineListener = (endpointId: string, direction: LineDirection, line: string) => void;
export type RegistryErrorListener = (endpointId: string | undefined, message: string) => void;
/** Notified once per {@link FlashPhase} as a `requestFlash` task
 * advances -- mirrors {@link LineListener}'s per-event shape rather
 * than a bulk snapshot, since `server.ts` forwards these directly as
 * {@link FlashProgressMessage}-shaped broadcasts. */
export type FlashProgressListener = (endpointId: string, firmware: FirmwareKind, phase: FlashPhase) => void;
/** Notified exactly once per `requestFlash` call, with its terminal
 * outcome -- `message` is present only on `status: "error"`, mirroring
 * {@link FlashResultMessage}'s own shape. */
export type FlashResultListener = (
  endpointId: string,
  firmware: FirmwareKind,
  status: "ok" | "error",
  message?: string,
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
}

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
  private readonly mutex = new KeyedMutex();
  private readonly states = new Map<string, EndpointState>();
  private unsubscribeWatcher: (() => void) | undefined;

  private readonly devicesListeners = new Set<DevicesListener>();
  private readonly lineListeners = new Set<LineListener>();
  private readonly errorListeners = new Set<RegistryErrorListener>();
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
  }

  /** Start watching for devices. Idempotent-ish in practice (callers
   * are expected to call this once); an immediate `pollOnce()` is
   * kicked off so the first snapshot arrives promptly rather than
   * waiting a full poll interval. */
  start(): void {
    this.unsubscribeWatcher = this.watcher.onChange((event) => {
      this.handleChange(event);
    });
    this.watcher.start();
    void this.watcher.pollOnce();
  }

  /** Stop watching and close every open link, best-effort. */
  async stop(): Promise<void> {
    this.watcher.stop();
    this.unsubscribeWatcher?.();
    this.unsubscribeWatcher = undefined;
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
   * site in this class keys the same way, for the same reason. */
  async requestOpen(endpointId: string): Promise<void> {
    await this.mutex.run(endpointId, async () => {
      const state = this.states.get(endpointId);
      if (!state) {
        this.emitError(endpointId, `no such device: ${endpointId}`);
        return;
      }
      if (state.sessionOpen) {
        return;
      }
      await this.connectAndIdentify(state);
    });
  }

  /** Close an open session to an endpoint. No-op if not open. */
  async requestClose(endpointId: string): Promise<void> {
    await this.mutex.run(endpointId, async () => {
      const state = this.states.get(endpointId);
      if (!state) {
        this.emitError(endpointId, `no such device: ${endpointId}`);
        return;
      }
      await this.teardownLink(state);
      this.emitDevices();
    });
  }

  /** Send a line to an endpoint's open session. Reports (via {@link onError})
   * rather than throws if the endpoint is unknown, has no open session,
   * or the underlying write itself fails. On success, also emits the
   * sent line back out via {@link onLine} (`direction: "tx"`) so every
   * connected client's console view reflects it, not just the sender. */
  async sendLine(endpointId: string, line: string): Promise<void> {
    await this.mutex.run(endpointId, async () => {
      const state = this.states.get(endpointId);
      if (!state?.sessionOpen || !state.session) {
        this.emitError(endpointId, `device ${endpointId} has no open link`);
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
   * Flash `firmware` onto an endpoint: orchestrates `config.ts` (which
   * source) -> `releases.ts` (fetch+verify the hex) -> `flash.ts`
   * (write it), run as one more task through the same per-endpoint
   * {@link KeyedMutex} as {@link requestOpen}/{@link requestClose}/
   * {@link sendLine} -- no new synchronization primitive (see the
   * module doc comment's "Flash flow" section). An unknown `endpointId`
   * is reported via {@link onError}, matching {@link requestOpen}'s own
   * handling -- never thrown to the caller.
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
  async requestFlash(endpointId: string, firmware: FirmwareKind): Promise<void> {
    await this.mutex.run(endpointId, async () => {
      const state = this.states.get(endpointId);
      if (!state) {
        this.emitError(endpointId, `no such device: ${endpointId}`);
        return;
      }
      await this.runFlash(state, firmware);
    });
  }

  /** The mutex-guarded body of {@link requestFlash} -- see that method's
   * doc comment for the mutex-scope and failure-recovery rationale. */
  private async runFlash(state: EndpointState, firmware: FirmwareKind): Promise<void> {
    const endpointId = state.endpointId;
    // Set at the very start (before teardown even) so a client that
    // observes the very next snapshot already sees flashStatus, per the
    // ticket's "set at the start of the flash task" requirement. There
    // is no dedicated FlashPhase for "tearing down the old link", so
    // this first phase is reported as "fetching" -- the next real
    // progress event ("verifying", once releases.ts resolves) replaces
    // it, same best-effort phase-reporting precedent flash.ts's own doc
    // comment already accepts for DAPjs's coarser event surface.
    this.setFlashPhase(state, endpointId, firmware, "fetching");

    try {
      // Tear down any open link before touching config/network/SWD --
      // flash.ts's DAPjs session must never contend with an open serial
      // port over the same physical board (see this class's own
      // requestFlash doc comment, and sprint.md's Design Rationale). In
      // the common case (a failed-identify device) there is nothing
      // open here; this call is defensive for any other caller.
      await this.teardownLink(state);
      this.emitDevices();

      const source = this.getFirmwareConfigFn()[firmware];
      if (!source) {
        this.failFlash(state, endpointId, firmware, `no firmware source configured for "${firmware}"`);
        return;
      }

      const resolved = await this.resolveReleaseFn(source);
      if ("reason" in resolved) {
        this.failFlash(state, endpointId, firmware, resolved.message);
        return;
      }

      // fetchAndVerifyHex both downloads and sha256-verifies in one
      // call (releases.ts has no seam between the two) -- "verifying"
      // is reported for the whole call, same best-effort phase mapping
      // as flash.ts's own erase/write/reset reporting.
      this.setFlashPhase(state, endpointId, firmware, "verifying");
      const fetched = await this.fetchAndVerifyHexFn(resolved);
      if ("error" in fetched) {
        this.failFlash(state, endpointId, firmware, fetched.error);
        return;
      }

      const onProgress = (phase: FlashPhase) => {
        this.setFlashPhase(state, endpointId, firmware, phase);
      };
      const outcome = await this.flashFn(state.device, fetched.hex.toString("utf-8"), onProgress);
      if (outcome.status === "error") {
        this.failFlash(state, endpointId, firmware, outcome.error);
        return;
      }

      state.flashStatus = undefined;
      this.emitFlashResult(endpointId, firmware, "ok");
      this.emitDevices();

      // Pick up the newly-flashed firmware's banner without a separate
      // manual Connect click (SUC-001's postcondition).
      // connectAndIdentify() never throws and reports its own errors via
      // sessionError/onDevicesChanged rather than rejecting, so a failed
      // re-connect here never turns an already-succeeded flash into a
      // reported failure.
      await this.connectAndIdentify(state);
    } catch (error) {
      // Defense in depth: every injected step here (config.ts,
      // releases.ts, flash.ts) documents "never throws", but a flash
      // must not leave flashStatus stuck even if that contract is ever
      // violated -- by a future change, or by a test's own fake.
      this.failFlash(state, endpointId, firmware, error instanceof Error ? error.message : String(error));
    }
  }

  /** Advance an in-flight flash to `phase`: update `flashStatus`, emit a
   * {@link onFlashProgress} event, and emit an updated device snapshot
   * so a client that reconnects mid-flash sees the current phase. */
  private setFlashPhase(state: EndpointState, endpointId: string, firmware: FirmwareKind, phase: FlashPhase): void {
    state.flashStatus = { firmware, phase };
    this.emitFlashProgress(endpointId, firmware, phase);
    this.emitDevices();
  }

  /** End an in-flight flash in failure: clear `flashStatus` and emit a
   * `flash-result` `status: "error"` event plus an updated snapshot. */
  private failFlash(state: EndpointState, endpointId: string, firmware: FirmwareKind, message: string): void {
    state.flashStatus = undefined;
    this.emitFlashResult(endpointId, firmware, "error", message);
    this.emitDevices();
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
      void this.mutex.run(endpointId, async () => {
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
  private async connectAndIdentify(state: EndpointState): Promise<void> {
    const portPath = state.device.serialPort?.path;
    if (!portPath) {
      state.sessionError = "no serial port available for this device";
      this.emitDevices();
      return;
    }

    const link = this.createLink({ transport: "usb", resourceKey: state.resourceKey, portPath });

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

    if (this.states.get(state.endpointId) !== state) {
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
    state.session = {
      link,
      unsubscribeLine: link.onLine((decoded) => {
        this.emitLine(state.endpointId, "rx", reconstructLineText(decoded));
      }),
      unsubscribeError: link.onError((err) => {
        this.handleLinkError(state, err);
      }),
    };
    state.sessionOpen = true;
    state.sessionError = undefined;
    this.emitDevices();

    // identify() never throws -- a silent board (never replies to
    // HELLO) resolves null here rather than hanging or rejecting; the
    // session above is already established either way.
    const banner = await link.identify();
    if (this.states.get(state.endpointId) !== state) {
      // Removed while identifying -- teardownLink (already run for the
      // now-orphaned state via the detach path) owns closing it.
      return;
    }
    // classification (and the role/type it carries) is derived from
    // this banner alone -- see EndpointState's own doc comment for why
    // there is no separate `role` field to keep in sync here.
    // classifyBanner never throws (pure, no I/O) and accepts `null`
    // directly: a null banner classifies exactly like "no banner yet"
    // (type "unknown", evidence "none") -- a normal state, not an
    // error.
    state.classification = classifyBanner(banner);
    this.emitDevices();
  }

  private handleLinkError(state: EndpointState, err: Error): void {
    // Note: this deliberately leaves `state.session` in place even
    // though `sessionOpen` flips false immediately -- see
    // EndpointState.sessionOpen's own doc comment for why. Only
    // teardownLink (via requestClose or a detach) actually disposes of
    // the session's link and subscriptions.
    state.sessionOpen = false;
    state.sessionError = err.message;
    this.emitDevices();
    this.emitError(state.endpointId, err.message);
  }

  private async teardownLink(state: EndpointState): Promise<void> {
    state.session?.unsubscribeLine();
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

  private emitLine(endpointId: string, direction: LineDirection, line: string): void {
    for (const listener of this.lineListeners) {
      listener(endpointId, direction, line);
    }
  }

  private emitError(endpointId: string | undefined, message: string): void {
    for (const listener of this.errorListeners) {
      listener(endpointId, message);
    }
  }

  private emitFlashProgress(endpointId: string, firmware: FirmwareKind, phase: FlashPhase): void {
    for (const listener of this.flashProgressListeners) {
      listener(endpointId, firmware, phase);
    }
  }

  private emitFlashResult(
    endpointId: string,
    firmware: FirmwareKind,
    status: "ok" | "error",
    message?: string,
  ): void {
    for (const listener of this.flashResultListeners) {
      listener(endpointId, firmware, status, message);
    }
  }
}
