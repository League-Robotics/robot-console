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
 *    the connector/bridger (steps 4/4a moved below this point in the
 *    actual wiring — see the code, not this list's own ordinal
 *    numbering, which is kept stable across tickets rather than
 *    renumbered) and handed to `createConnector` (ticket 019-001, a
 *    direct relay session-open's own takeover of an in-flight sweep),
 *    `createRelayBridger`, and `startRelaySweeper` (ticket 016-004): the
 *    shared in-process seam that lets a student's connect find and abort
 *    a running sweep pass without any of the three modules importing
 *    another. `startRelaySweeper` itself probes idle usb relays over the
 *    radio command plane for remembered robots; never touches
 *    `sessions`, never calls the connector or the reconciler.
 * 6. `installUnhandledRejectionBackstop` (ticket 003) — the process-wide
 *    last-resort net; see that module's own doc comment for why this is
 *    not a substitute for each component's own error handling.
 *
 * `stop()` tears all of it down in roughly the reverse order: the
 * backstop first (nothing should still be marking links failed once
 * everything else is stopping), the reconciler (stops scheduling new
 * jobs, then closes every session it still holds open — sprint 021
 * ticket 003; issue `reconciler-stop-leaks-open-sessions.md` — awaited
 * here so a real socket to a real robot never outlives this method,
 * unlike before that ticket), the relay sweeper, the harvester
 * (ticket 019-003 — clears every attached session's `pollStatus`
 * interval), all three watchers, then the store.
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
   * out from under a pass's still-running `finally` block), the
   * harvester (sprint 019 ticket 003, SUC-003: every attached session's
   * `pollStatus` interval, so a stray tick can never write to the store
   * below once it closes), all three watchers, uninstalls the
   * unhandled-rejection backstop, and closes the store. Awaits the
   * reconciler's own `stop()` first, which closes every session it still
   * holds open (sprint 021 ticket 003) — so once this resolves, no
   * session this runtime opened is still holding a real socket. */
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
  /** Every {@link ConnectorDeps} field except `harvester` (this module
   * always wires its own {@link createHarvester} call — see the module
   * doc comment's composition order; a caller that wants a fake
   * harvester overrides {@link createHarvester} instead) and `revocation`
   * (sprint 019 ticket 001 — always the same shared seam handed to the
   * bridger and the sweeper, per {@link createRelayLeaseRevocation}'s own
   * doc comment below). */
  connectorDeps?: Omit<ConnectorDeps, "harvester" | "revocation">;
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
  /** Never start the relay sweeper at all unless explicitly set to
   * `false`. **Defaults to `true` (the sweeper is off) when omitted** —
   * ticket 018-010: "you're not going to sweep when you're idle
   * RadioRelay, so turn that off." this inverts sprint 018 ticket 005
   * Step 0b's original sense, where `false`/omitted started the sweeper
   * and only an explicit `--no-sweep`/`ROBOT_CONSOLE_DISABLE_SWEEP`
   * (`cli.ts`'s own parsing) turned it off for the bench harness alone.
   * That harness reasoning still holds (the sweeper opening USB relay
   * ports on its own schedule races Layer 1's raw probes, or another
   * harness host instance, or a stakeholder's own separately-running
   * `npm run dev` — `exclusivity.ts`'s own running-host detection) but
   * is no longer the only reason to default it off: a classroom's
   * idle-radio sweep is disruptive enough on its own (bench flash wear,
   * `SWEEP_MIN_INTERVAL_MS`'s own doc comment) that the stakeholder
   * wants it opt-in everywhere, production startup included — `cli.ts`'s
   * `--sweep`/`ROBOT_CONSOLE_ENABLE_SWEEP` is that opt-in, and this
   * field's own default is what makes omitting it (as `scripts/dev.mjs`'s
   * bare `startRuntime()` call does) equivalent to `--no-sweep` used to
   * be, not to the old always-on default. */
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

  // Ticket 016-003/004 (extended by 019-001 to the connector itself): the
  // shared revocation seam, constructed once per runtime (exactly like
  // the harvester's fan-out above) and handed to the connector, the
  // bridger, and the sweeper alike -- this is what lets a student's
  // connect (the bridger, on a sweep-held lease-acquisition failure, or
  // the connector, on a direct relay session-open racing the sweeper's
  // own raw port open) find and abort a running sweep pass without any
  // of the three modules importing another (`connect/relayLeaseRevocation.ts`'s
  // own doc comment).
  const relayLeaseRevocation = createRelayLeaseRevocationFn();
  const connector = createConnectorFn(
    store,
    { ...options.connectorDeps, harvester, revocation: relayLeaseRevocation },
    options.connectorOptions,
  );

  const bridger = createRelayBridgerFn(
    store,
    { ...options.relayBridgerDeps, harvester, revocation: relayLeaseRevocation },
    options.relayBridgerOptions,
  );
  const reconciler = startReconcilerFn(store, { ...options.reconcilerDeps, connector, bridger });

  // 018-010: `disableSweep` defaults to `true` when omitted (see this
  // option's own doc comment) -- so the common case (no caller opinion
  // at all, e.g. `scripts/dev.mjs`'s bare `startRuntime()`) skips
  // calling `startRelaySweeperFn` entirely -- not merely passing it an
  // option that makes it a no-op -- so no scan-tick `setInterval` is
  // ever created and no relay lease is ever acquired by this runtime's
  // own sweeper, full stop. Only an explicit `disableSweep: false`
  // (`cli.ts`'s `--sweep`/`ROBOT_CONSOLE_ENABLE_SWEEP`) starts it.
  // `stop()` is still awaited uniformly below regardless of which
  // branch ran.
  const disableSweep = options.disableSweep ?? true;
  const relaySweeperHandle: RelaySweeperHandle = disableSweep
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
      // Awaited (sprint 021 ticket 003): the reconciler's own `stop()`
      // now closes every session it still holds before resolving -- see
      // `Reconciler.stop`'s own doc comment. This must happen, and be
      // waited for, before `store.close()` below, since closing a
      // session writes to the store.
      await reconciler.stop();
      // Awaited: ticket 016-008 fixed relaySweeperHandle.stop() to wait
      // for every in-flight per-relay pass's own cleanup, precisely so
      // this store.close() below can never again race a pass still
      // mid-`finally` (the same "database is not open" unhandled
      // rejection relaySweeper.test.ts's own flake surfaced).
      await relaySweeperHandle.stop();
      // Sprint 019 ticket 003 (SUC-003; issue
      // `harvester-has-no-teardown-seam.md`): symmetrical fix for the
      // harvester's own `pollStatus` interval, found at sprint 018's own
      // close gate ("database is not open" thrown from a bare timer
      // callback via `Store.reconcilerRows`, sprint 018 ticket 011's own
      // *test*-teardown fix). No in-flight work to await here (see
      // `HarvesterAttach.stop`'s own doc comment) -- calling it merely
      // clears every attached session's timer and makes each one's own
      // `fail()` inert, so a poll tick that would otherwise land after
      // `store.close()` below can never write to it.
      harvester.stop();
      usbHandle.stop();
      mdnsHandle.stop();
      firmwareHandle.stop();
      store.close();
    },
  };
}
