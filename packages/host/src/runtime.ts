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
 * 1a. **Sprint 018 ticket 006**: {@link createMbregistryClient} (ticket
 *    001), then `await client.connect()` — this is the one place in this
 *    module's otherwise-synchronous composition that must be awaited
 *    (hence `startRuntime` is now `async`), because SUC-001's own
 *    contract requires a resolution/spawn failure to fail startup
 *    outright, never silently fall back to `startUsbWatcher`. Only once
 *    this resolves does `startMbregistryWatcher` (ticket 002) start, in
 *    place of `startUsbWatcher` (sprint 014) — `usbWatcher.ts` itself is
 *    untouched, just no longer wired here. `startMdnsWatcher` (sprint
 *    014) still starts too, but with its `_mbserial`/`_mbrelay`/
 *    `_mbflash` browses disabled (`MdnsWatcherOptions.disabledTypes`) —
 *    `_robotlink.*` (WiFi) browsing is unaffected. Both watchers write
 *    `devices`/`links`/`services` rows only; neither opens a session
 *    itself any more (sprint 015 ticket 003's "watchers write rows
 *    only").
 * 2a. `startFirmwareWatcher` (sprint 017 ticket 002) — polls each
 *    firmware kind's GitHub release with `ETag`/backoff and writes
 *    `firmware` rows directly, replacing the retired
 *    `FirmwareAvailabilityCache` that `server.ts` used to construct and
 *    poll itself.
 * 3. `createHarvester` (ticket 003) — the real {@link HarvesterAttach}
 *    implementation, wired with `onTelemetry`/`onNotice` sinks this
 *    module fans out to every subscriber of {@link Runtime.telemetry}
 *    (`server.ts`, ticket 005, is the only production subscriber).
 * 4. `createConnector` (ticket 001), given that harvester and (sprint
 *    018 ticket 006) the same `mbregistryClient`/`mbregistryLabel` from
 *    step 1a, so an `mbregistry`-transport connect/relay-physical opens
 *    over the same already-connected client this module resolved.
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
 * watchers (mbregistryWatcher in place of usbWatcher), the mbregistry
 * client's own control connection, then the store.
 *
 * Every collaborator is injectable via {@link StartRuntimeOptions},
 * mirroring `cli.ts`'s own `CliDeps` seam ("real defaults, fakes in
 * tests") — no real store/serial/HID/mDNS I/O is ever touched by
 * `runtime.test.ts`.
 */
import { hostname } from "node:os";
import { getMbregistryShareBoards } from "./config.js";
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
  createMbregistryClient as defaultCreateMbregistryClient,
  type MbregistryClient,
  type MbregistryClientDeps,
} from "./mbregistry/client.js";
import {
  startMbregistryWatcher as defaultStartMbregistryWatcher,
  type MbregistryWatcherDeps,
  type MbregistryWatcherHandle,
} from "./watchers/mbregistryWatcher.js";
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
  /** Sprint 018 ticket 006: the same already-`connect()`ed
   * {@link MbregistryClient} this module resolved and handed to
   * `createConnector`/`startMbregistryWatcher` — `cli.ts`'s `main()`
   * forwards this (and {@link mbregistryLabel}) on to
   * `startServer`'s own `mbregistryClient`/`mbregistryLabel` options, so
   * `server.ts#runFlashTask`'s `mbregistry`-transport branch uses the
   * exact same client/label, not a second, separately-resolved one. */
  readonly mbregistryClient: MbregistryClient;
  /** This console's own display label, sent as every mbregistry `lock`'s
   * `label` — see {@link StartRuntimeOptions.mbregistryLabel}. */
  readonly mbregistryLabel: string;
  /** Stops the reconciler (change-feed subscription + slow tick), the
   * relay sweeper (awaited — ticket 016-008: its own `stop()` now waits
   * for every in-flight per-relay pass's cleanup before resolving, so
   * this method must await it too, or the store below could still close
   * out from under a pass's still-running `finally` block), all three
   * watchers (mbregistryWatcher in place of usbWatcher), closes the
   * mbregistry client's own control connection, uninstalls the
   * unhandled-rejection backstop, and closes the store. Does not close
   * any already-open session — mirrors the reconciler's own `stop()`
   * contract (this module's doc comment). */
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

  /** Sprint 018 ticket 006: no longer called by production wiring
   * (`startMbregistryWatcher` replaces it below) — `usbWatcher.ts`
   * itself, and its own test suite, are untouched; this field/its
   * `*Deps`/`*Options` siblings are kept only so a caller that still
   * wants the old path for a diagnostic/manual run can inject it via an
   * overridden {@link startMbregistryWatcher}/composition — no
   * production code path reaches them any more. Sprint 019 is expected
   * to remove them outright, alongside `usbWatcher.ts`'s own deletion. */
  startUsbWatcher?: typeof defaultStartUsbWatcher;
  usbWatcherDeps?: UsbWatcherDeps;
  usbWatcherOptions?: UsbWatcherOptions;

  /** Sprint 018 ticket 006: constructs the {@link MbregistryClient}
   * (ticket 001) this runtime resolves/spawns and connects *before*
   * starting anything else that depends on it (`startMbregistryWatcher`,
   * `createConnector`) — see the module doc comment's step 1a. A
   * resolution/spawn failure here rejects {@link startRuntime}'s own
   * promise outright (SUC-001's contract: no silent fallback to
   * `startUsbWatcher`). */
  createMbregistryClient?: typeof defaultCreateMbregistryClient;
  /** Sprint 018 ticket 008: `shareBoards` here defaults to the stored
   * `mbregistry.shareBoards` `settings` row (`config.ts
   * #getMbregistryShareBoards`), read off the store this call just
   * opened — an explicit `shareBoards` field on this object still wins
   * over that default (a test seam, or a future caller that already
   * knows the answer); every other field is passed through untouched,
   * same as before this ticket. */
  mbregistryClientDeps?: MbregistryClientDeps;
  /** This console's own display label, sent as every mbregistry `lock`'s
   * `label` (`ConnectorDeps.mbregistryLabel`/`StartServerOptions.
   * mbregistryLabel`, both wired from the same value here) — purely
   * cosmetic (`registry-api.md`: "display-only"). Defaults to
   * `"<hostname> / robot-console"`. */
  mbregistryLabel?: string;

  /** Sprint 018 ticket 006: starts in place of `startUsbWatcher` above,
   * once {@link createMbregistryClient}'s connection resolves — see the
   * module doc comment's step 1a. */
  startMbregistryWatcher?: typeof defaultStartMbregistryWatcher;
  /** Every {@link MbregistryWatcherDeps} field except `client`, which
   * this module always wires to its own already-connected
   * {@link MbregistryClient}. */
  mbregistryWatcherDeps?: Omit<MbregistryWatcherDeps, "client">;

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

  installUnhandledRejectionBackstop?: typeof defaultInstallUnhandledRejectionBackstop;
  unhandledRejectionDeps?: UnhandledRejectionBackstopDeps;
}

/** Sprint 018 ticket 006: `_mbserial`/`_mbrelay`/`_mbflash` are disabled
 * by default in production wiring, in favor of `mbregistryWatcher` —
 * `_robotlink.*` (WiFi) is not in this list, unaffected either way. An
 * explicit `mdnsWatcherOptions.disabledTypes` from the caller overrides
 * this default entirely (see {@link startRuntime}'s own merge). */
const DEFAULT_DISABLED_MDNS_TYPES: readonly ("mbserial" | "mbrelay" | "mbflash")[] = ["mbserial", "mbrelay", "mbflash"];

/** `ConnectorDeps.mbregistryLabel`/`StartServerOptions.mbregistryLabel`'s
 * own default — purely cosmetic (`registry-api.md`: "display-only"),
 * naming this machine so a lock/flash contention message can say who
 * holds it. */
function defaultMbregistryLabel(): string {
  return `${hostname()} / robot-console`;
}

/**
 * Compose the store, the mbregistry client, all three watchers, the
 * harvester/connector/reconciler, and the unhandled-rejection backstop
 * into one running host. See the module doc comment for composition
 * order and every collaborator's own module for what it does.
 *
 * `async` since sprint 018 ticket 006: resolving/spawning the
 * mbregistry connection (step 1a) is the one genuinely asynchronous
 * step in an otherwise-synchronous composition, and SUC-001 requires
 * that failure to fail this call outright (rejects, no watcher/
 * connector/reconciler is ever constructed) rather than falling back to
 * `startUsbWatcher`. Every other collaborator constructed here still
 * starts (or opens) synchronously once that resolves — the reconciler's
 * own initial `tick()` (and, on top of it, each watcher's own poll)
 * dispatches whatever real I/O they need fire-and-forget from there,
 * exactly as running `startReconciler`/`startMbregistryWatcher`/
 * `startMdnsWatcher`/`startFirmwareWatcher` directly already does.
 */
export async function startRuntime(options: StartRuntimeOptions = {}): Promise<Runtime> {
  const openStoreWithImportsFn = options.openStoreWithImports ?? defaultOpenStoreWithImports;
  const createMbregistryClientFn = options.createMbregistryClient ?? defaultCreateMbregistryClient;
  const startMbregistryWatcherFn = options.startMbregistryWatcher ?? defaultStartMbregistryWatcher;
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

  // Step 1a (module doc comment): resolve/spawn and connect the
  // mbregistry client BEFORE anything that depends on it. A
  // resolution/spawn failure here (ticket 001's SUC-001 error contract)
  // propagates out of this `await` and rejects `startRuntime` itself --
  // no `startMbregistryWatcher`/`createConnector`/anything else below is
  // ever reached, and there is no fallback to `startUsbWatcher`.
  // Sprint 018 ticket 008: `mbregistry.shareBoards` (a `settings` row,
  // `config.ts#getMbregistryShareBoards`) decides whether a
  // console-*spawned* instance turns peering on -- read after `store`
  // opens (above) but before the client is created, so it's available
  // as this call's own default. An explicit `shareBoards` in
  // `options.mbregistryClientDeps` (test seam, or a future caller that
  // already knows the answer) always wins over the stored setting --
  // this read only ever fills in what the caller didn't already decide.
  const mbregistryClientDeps: MbregistryClientDeps = {
    shareBoards: getMbregistryShareBoards(store),
    ...options.mbregistryClientDeps,
  };
  const mbregistryClient: MbregistryClient = createMbregistryClientFn(mbregistryClientDeps);
  await mbregistryClient.connect();
  const mbregistryLabel = options.mbregistryLabel ?? defaultMbregistryLabel();

  const mbregistryHandle: MbregistryWatcherHandle = startMbregistryWatcherFn(store, {
    ...options.mbregistryWatcherDeps,
    client: mbregistryClient,
  });

  const mdnsBackend = options.mdnsBackend ?? createBonjourBackendFn();
  const mdnsWatcherOptions: MdnsWatcherOptions = {
    disabledTypes: DEFAULT_DISABLED_MDNS_TYPES,
    ...options.mdnsWatcherOptions,
  };
  const mdnsHandle = startMdnsWatcherFn(store, { backend: mdnsBackend }, mdnsWatcherOptions);
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

  const connector = createConnectorFn(
    store,
    { ...options.connectorDeps, harvester, mbregistryClient, mbregistryLabel },
    options.connectorOptions,
  );

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

  const relaySweeperHandle: RelaySweeperHandle = startRelaySweeperFn(
    store,
    { ...options.relaySweeperDeps, revocation: relayLeaseRevocation },
    options.relaySweeperOptions,
  );

  const uninstallUnhandledRejectionBackstop = installUnhandledRejectionBackstopFn(store, options.unhandledRejectionDeps);

  let stopped = false;

  return {
    store,
    reconciler,
    telemetry,
    mbregistryClient,
    mbregistryLabel,
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
      mbregistryHandle.stop();
      mdnsHandle.stop();
      firmwareHandle.stop();
      mbregistryClient.close();
      store.close();
    },
  };
}
