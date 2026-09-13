/**
 * runtime.ts — the one composition root for the whole host (sprint 015
 * ticket 005; issue `rearch-06-snapshot-wire-contract-and-thin-server.md`;
 * `docs/design/architecture.md` §6/§8; `sprint.md`'s own module table:
 * "Inside: `openStoreWithImports`, `startUsbWatcher`/`startMdnsWatcher`,
 * constructing the reconciler, `startServer({store, runtime})`, orderly
 * `stop()`. Outside: any component's own logic — this module only
 * wires.").
 *
 * `startRuntime` is the seam `cli.ts`'s `main()` now calls instead of
 * going straight to `startServer` — the first point since sprint 014
 * that production startup actually opens the store and starts both
 * watchers (until this ticket, only the now-retired `--watch-store` flag
 * did). This removes `server.ts`'s old inline construction of the
 * retired registry class (ticket 003 already deleted the class itself;
 * this was the last call site) by giving `server.ts` something real to
 * depend on instead.
 *
 * ## Composition order
 *
 * 1. {@link openStoreWithImports} — opens (creating/migrating as needed)
 *    `console.sqlite` and runs the one-time `known-robots.json`/
 *    `wifi-credentials.json` importers against it.
 * 2. `startUsbWatcher`/`startMdnsWatcher` (sprint 014) — write
 *    `devices`/`links`/`services` rows; neither opens a session itself
 *    any more (sprint 015 ticket 003's "watchers write rows only").
 * 2a. `startFirmwareWatcher` (sprint 017 ticket 002) — polls each
 *    firmware kind's GitHub release with `ETag`/backoff and writes
 *    `firmware` rows directly, replacing the retired
 *    `FirmwareAvailabilityCache` that `server.ts` used to construct and
 *    poll itself.
 * 3. `createHarvester` (ticket 003) — the real {@link HarvesterAttach}
 *    implementation, wired with `onTelemetry`/`onNotice` sinks this
 *    module fans out to every subscriber of {@link Runtime.telemetry}
 *    (`server.ts`, ticket 005, is the only production subscriber).
 * 4. `createConnector` (ticket 001), given that harvester.
 * 4a. `createRelayBridger` (ticket 016-002), given the same harvester —
 *    the reset-before-every-candidate fix for default failover's Linux
 *    bug; a sibling to the connector, not a replacement for it (see that
 *    module's own doc comment).
 * 5. `startReconciler` (ticket 002), given that connector and bridger —
 *    the only component that decides what should be connected, and the
 *    target `server.ts` forwards an explicit user `session-open`/
 *    `session-close` command to.
 * 5a. `createRelayLeaseRevocation` (ticket 016-003), constructed before
 *    the bridger (step 4a moved below this point in the actual wiring —
 *    see the code, not this list's own ordinal numbering, which is kept
 *    stable across tickets rather than renumbered) and handed to BOTH
 *    `createRelayBridger` and `startRelaySweeper` (ticket 016-004): the
 *    shared in-process seam that lets a student's connect find and abort
 *    a running sweep pass without either module importing the other.
 *    `startRelaySweeper` itself probes idle usb relays over the radio
 *    command plane for remembered robots; never touches `sessions`,
 *    never calls the connector or the reconciler.
 * 6. `installUnhandledRejectionBackstop` (ticket 003) — the process-wide
 *    last-resort net; see that module's own doc comment for why this is
 *    not a substitute for each component's own error handling.
 *
 * `stop()` tears all of it down in roughly the reverse order: the
 * backstop first (nothing should still be marking links failed once
 * everything else is stopping), the reconciler (stops scheduling new
 * jobs — does not close any already-open session, mirroring every
 * watcher's own `stop()` contract), the relay sweeper, all three
 * watchers, then the store.
 *
 * Every collaborator is injectable via {@link StartRuntimeOptions},
 * mirroring `cli.ts`'s own `CliDeps` seam ("real defaults, fakes in
 * tests") — no real store/serial/HID/mDNS I/O is ever touched by
 * `runtime.test.ts`.
 */
import { openStoreWithImports as defaultOpenStoreWithImports } from "./store/bootstrap.js";
import type { StoreDbOptions } from "./store/db.js";
import type { Store } from "./store/index.js";
import {
  startUsbWatcher as defaultStartUsbWatcher,
  type UsbWatcherDeps,
  type UsbWatcherHandle,
  type UsbWatcherOptions,
} from "./watchers/usbWatcher.js";
import {
  startMdnsWatcher as defaultStartMdnsWatcher,
  type MdnsWatcherOptions,
} from "./watchers/mdnsWatcher.js";
import {
  startFirmwareWatcher as defaultStartFirmwareWatcher,
  type FirmwareWatcherDeps,
  type FirmwareWatcherHandle,
  type FirmwareWatcherOptions,
} from "./watchers/firmwareWatcher.js";
import { createBonjourBackend as defaultCreateBonjourBackend, type MdnsBackend } from "./discovery/mdnsDiscovery.js";
import { createConnector as defaultCreateConnector, type ConnectorDeps, type ConnectorOptions } from "./connect/connector.js";
import {
  createHarvester as defaultCreateHarvester,
  type HarvesterDeps,
  type HarvesterTelemetryEvent,
} from "./connect/harvester.js";
import { startReconciler as defaultStartReconciler, type Reconciler, type ReconcilerDeps } from "./connect/reconciler.js";
import {
  createRelayBridger as defaultCreateRelayBridger,
  type RelayBridgerDeps,
  type RelayBridgerOptions,
} from "./connect/relayBridger.js";
import { createRelayLeaseRevocation as defaultCreateRelayLeaseRevocation } from "./connect/relayLeaseRevocation.js";
import {
  startRelaySweeper as defaultStartRelaySweeper,
  type RelaySweeperDeps,
  type RelaySweeperHandle,
  type RelaySweeperOptions,
} from "./watchers/relaySweeper.js";
import {
  installUnhandledRejectionBackstop as defaultInstallUnhandledRejectionBackstop,
  type UnhandledRejectionBackstopDeps,
} from "./connect/unhandled.js";

/** Subscribable telemetry/notice fan-out — the harvester (ticket 003)
 * produces both per open session, with no broadcast of its own (see that
 * module's own doc comment); this is where they become subscribable for
 * whatever composes a runtime ({@link startServer} in production). Both
 * default to a no-op if nothing ever subscribes, so a runtime started
 * with no server attached (e.g. a future headless tool) never pays for
 * an unused fan-out. */
export interface RuntimeTelemetry {
  /** Subscribe to every `thdr`/`t` telemetry event, across every open
   * session. Returns an unsubscribe function. */
  onTelemetry(listener: (linkId: string, event: HarvesterTelemetryEvent) => void): () => void;
  /** Subscribe to every harvester-originated notice (a resync, a
   * dropped-malformed-line notice, ...). Returns an unsubscribe
   * function. */
  onNotice(listener: (linkId: string, message: string) => void): () => void;
}

export interface Runtime {
  readonly store: Store;
  readonly reconciler: Reconciler;
  readonly telemetry: RuntimeTelemetry;
  /** Stops the reconciler (change-feed subscription + slow tick), the
   * relay sweeper (awaited — ticket 016-008: its own `stop()` now waits
   * for every in-flight per-relay pass's cleanup before resolving, so
   * this method must await it too, or the store below could still close
   * out from under a pass's still-running `finally` block), all three
   * watchers, uninstalls the unhandled-rejection backstop, and closes
   * the store. Does not close any already-open session — mirrors the
   * reconciler's own `stop()` contract (this module's doc comment). */
  stop(): Promise<void>;
}

/** Injectable seams for {@link startRuntime} — every field defaults to
 * the real implementation; `runtime.test.ts` substitutes fakes for
 * whichever fields the case under test touches, mirroring `cli.ts`'s own
 * `CliDeps` convention. */
export interface StartRuntimeOptions {
  /** Forwarded to {@link openStoreWithImports} verbatim (state dir/env/
   * file-path resolution). Ignored if {@link openStoreWithImports} below
   * is itself overridden. */
  storeOptions?: StoreDbOptions;
  openStoreWithImports?: typeof defaultOpenStoreWithImports;

  startUsbWatcher?: typeof defaultStartUsbWatcher;
  usbWatcherDeps?: UsbWatcherDeps;
  usbWatcherOptions?: UsbWatcherOptions;

  startMdnsWatcher?: typeof defaultStartMdnsWatcher;
  /** The mDNS backend `startMdnsWatcher` requires (no default of its
   * own — see that module's own doc comment). Defaults to a real
   * `bonjour-service`-backed one via {@link createBonjourBackend}. */
  mdnsBackend?: MdnsBackend;
  createBonjourBackend?: typeof defaultCreateBonjourBackend;
  mdnsWatcherOptions?: MdnsWatcherOptions;

  /** Sprint 017 ticket 002: replaces the retired `FirmwareAvailabilityCache`
   * (which `server.ts` used to construct and poll itself). Composed here
   * exactly like both other watchers — writes `firmware` rows directly;
   * `server.ts`'s existing `store.onChange` subscription broadcasts the
   * resulting snapshot with no firmware-specific glue of its own. */
  startFirmwareWatcher?: typeof defaultStartFirmwareWatcher;
  firmwareWatcherDeps?: FirmwareWatcherDeps;
  firmwareWatcherOptions?: FirmwareWatcherOptions;

  createConnector?: typeof defaultCreateConnector;
  /** Every {@link ConnectorDeps} field except `harvester`, which this
   * module always wires to its own {@link createHarvester} call (see
   * the module doc comment's composition order) — a caller that wants a
   * fake harvester overrides {@link createHarvester} instead. */
  connectorDeps?: Omit<ConnectorDeps, "harvester">;
  connectorOptions?: ConnectorOptions;

  createHarvester?: typeof defaultCreateHarvester;
  /** Every {@link HarvesterDeps} field except `onTelemetry`/`onNotice`,
   * which this module always wires to its own fan-out (see
   * {@link Runtime.telemetry}) — a caller that wants to observe every
   * event a test harvester itself produces subscribes to `telemetry`
   * instead of overriding these sinks directly. */
  harvesterDeps?: Omit<HarvesterDeps, "onTelemetry" | "onNotice">;

  createRelayBridger?: typeof defaultCreateRelayBridger;
  /** Every {@link RelayBridgerDeps} field. Ticket 016-002's relay bridger
   * — always constructed and handed to the reconciler as {@link
   * ReconcilerDeps.bridger} (see the module doc comment's composition
   * order), fixing the Linux default-failover bug at its root (a reset
   * before every candidate). */
  relayBridgerDeps?: RelayBridgerDeps;
  relayBridgerOptions?: RelayBridgerOptions;

  startReconciler?: typeof defaultStartReconciler;
  /** Every {@link ReconcilerDeps} field except `connector`/`bridger`,
   * which this module always wires to its own {@link createConnector}/
   * {@link createRelayBridger} calls. */
  reconcilerDeps?: Omit<ReconcilerDeps, "connector" | "bridger">;

  createRelayLeaseRevocation?: typeof defaultCreateRelayLeaseRevocation;

  startRelaySweeper?: typeof defaultStartRelaySweeper;
  /** Every {@link RelaySweeperDeps} field except `revocation`, which this
   * module always wires to its own {@link createRelayLeaseRevocation}
   * call (ticket 016-003) — the same shared seam a future ticket wires
   * into the bridger too. */
  relaySweeperDeps?: Omit<RelaySweeperDeps, "revocation">;
  relaySweeperOptions?: RelaySweeperOptions;
  /** 018-005 Step 0b: never start the relay sweeper at all when `true`
   * (`--no-sweep` / `ROBOT_CONSOLE_DISABLE_SWEEP=1`, `cli.ts`'s own
   * parsing). The bench harness's Layer 2/3 each start their own real
   * host instance against a scratch state dir — with the sweeper
   * running, that instance's own `watchers/relaySweeper.ts` opens usb
   * relay ports on its own schedule, on top of whatever this same
   * harness run is *also* trying to probe against the identical
   * physical relay (Layer 1's raw probe, or another harness host
   * instance), racing itself the same way the stakeholder's `npm run
   * dev` was found to race a harness run (`exclusivity.ts`'s own
   * running-host detection). `false`/omitted (the default) starts the
   * sweeper exactly as before this option existed — production startup
   * (`bin/robot-console.js`) never sets this. */
  disableSweep?: boolean;

  installUnhandledRejectionBackstop?: typeof defaultInstallUnhandledRejectionBackstop;
  unhandledRejectionDeps?: UnhandledRejectionBackstopDeps;
}

/**
 * Compose the store, all three watchers, the harvester/connector/
 * reconciler, and the unhandled-rejection backstop into one running
 * host. See the module doc comment for composition order and every
 * collaborator's own module for what it does. Synchronous: every
 * collaborator constructed here starts (or opens) synchronously — the
 * reconciler's own initial `tick()` (and, on top of it, each watcher's
 * own poll) dispatches whatever real I/O they need fire-and-forget from
 * there, exactly as running
 * `startReconciler`/`startUsbWatcher`/`startMdnsWatcher`/
 * `startFirmwareWatcher` directly already does.
 */
export function startRuntime(options: StartRuntimeOptions = {}): Runtime {
  const openStoreWithImportsFn = options.openStoreWithImports ?? defaultOpenStoreWithImports;
  const startUsbWatcherFn = options.startUsbWatcher ?? defaultStartUsbWatcher;
  const startMdnsWatcherFn = options.startMdnsWatcher ?? defaultStartMdnsWatcher;
  const createBonjourBackendFn = options.createBonjourBackend ?? defaultCreateBonjourBackend;
  const startFirmwareWatcherFn = options.startFirmwareWatcher ?? defaultStartFirmwareWatcher;
  const createConnectorFn = options.createConnector ?? defaultCreateConnector;
  const createHarvesterFn = options.createHarvester ?? defaultCreateHarvester;
  const createRelayBridgerFn = options.createRelayBridger ?? defaultCreateRelayBridger;
  const startReconcilerFn = options.startReconciler ?? defaultStartReconciler;
  const createRelayLeaseRevocationFn = options.createRelayLeaseRevocation ?? defaultCreateRelayLeaseRevocation;
  const startRelaySweeperFn = options.startRelaySweeper ?? defaultStartRelaySweeper;
  const installUnhandledRejectionBackstopFn =
    options.installUnhandledRejectionBackstop ?? defaultInstallUnhandledRejectionBackstop;

  const store = openStoreWithImportsFn(options.storeOptions ?? {});

  const telemetryListeners = new Set<(linkId: string, event: HarvesterTelemetryEvent) => void>();
  const noticeListeners = new Set<(linkId: string, message: string) => void>();
  const telemetry: RuntimeTelemetry = {
    onTelemetry(listener) {
      telemetryListeners.add(listener);
      return () => telemetryListeners.delete(listener);
    },
    onNotice(listener) {
      noticeListeners.add(listener);
      return () => noticeListeners.delete(listener);
    },
  };

  const usbHandle: UsbWatcherHandle = startUsbWatcherFn(store, options.usbWatcherDeps, options.usbWatcherOptions);
  const mdnsBackend = options.mdnsBackend ?? createBonjourBackendFn();
  const mdnsHandle = startMdnsWatcherFn(store, { backend: mdnsBackend }, options.mdnsWatcherOptions);
  const firmwareHandle: FirmwareWatcherHandle = startFirmwareWatcherFn(
    store,
    options.firmwareWatcherDeps,
    options.firmwareWatcherOptions,
  );

  const harvester = createHarvesterFn(store, {
    ...options.harvesterDeps,
    onTelemetry: (linkId, event) => {
      for (const listener of telemetryListeners) {
        listener(linkId, event);
      }
    },
    onNotice: (linkId, message) => {
      for (const listener of noticeListeners) {
        listener(linkId, message);
      }
    },
  });

  const connector = createConnectorFn(store, { ...options.connectorDeps, harvester }, options.connectorOptions);

  // Ticket 016-003/004: the shared revocation seam, constructed once per
  // runtime (exactly like the harvester's fan-out above) and handed to
  // BOTH the bridger and the sweeper -- this is what lets a student's
  // connect (the bridger, on a sweep-held lease-acquisition failure) find
  // and abort a running sweep pass without either module importing the
  // other (`connect/relayLeaseRevocation.ts`'s own doc comment).
  const relayLeaseRevocation = createRelayLeaseRevocationFn();
  const bridger = createRelayBridgerFn(
    store,
    { ...options.relayBridgerDeps, harvester, revocation: relayLeaseRevocation },
    options.relayBridgerOptions,
  );
  const reconciler = startReconcilerFn(store, { ...options.reconcilerDeps, connector, bridger });

  // 018-005 Step 0b: `disableSweep` skips calling `startRelaySweeperFn`
  // entirely -- not merely passing it an option that makes it a no-op --
  // so no scan-tick `setInterval` is ever created and no relay lease is
  // ever acquired by this runtime's own sweeper, full stop. `stop()` is
  // still awaited uniformly below regardless of which branch ran.
  const relaySweeperHandle: RelaySweeperHandle = options.disableSweep
    ? { stop: async () => {} }
    : startRelaySweeperFn(store, { ...options.relaySweeperDeps, revocation: relayLeaseRevocation }, options.relaySweeperOptions);

  const uninstallUnhandledRejectionBackstop = installUnhandledRejectionBackstopFn(store, options.unhandledRejectionDeps);

  let stopped = false;

  return {
    store,
    reconciler,
    telemetry,
    async stop(): Promise<void> {
      if (stopped) {
        return;
      }
      stopped = true;
      uninstallUnhandledRejectionBackstop();
      reconciler.stop();
      // Awaited: ticket 016-008 fixed relaySweeperHandle.stop() to wait
      // for every in-flight per-relay pass's own cleanup, precisely so
      // this store.close() below can never again race a pass still
      // mid-`finally` (the same "database is not open" unhandled
      // rejection relaySweeper.test.ts's own flake surfaced).
      await relaySweeperHandle.stop();
      usbHandle.stop();
      mdnsHandle.stop();
      firmwareHandle.stop();
      store.close();
    },
  };
}
