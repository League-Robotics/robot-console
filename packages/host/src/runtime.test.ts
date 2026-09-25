/**
 * runtime.test.ts — sprint 015 ticket 005's own suite for the
 * composition root: every collaborator is a fake injected via
 * {@link StartRuntimeOptions}, mirroring `cli.test.ts`'s existing
 * "real defaults, fakes in tests" convention -- no real store/serial/
 * HID/mDNS I/O is ever touched here.
 *
 * Sprint 018 ticket 006: `startRuntime` is now `async` (it resolves and
 * connects a real {@link MbregistryClient} before anything else), so
 * every call site below is `await`ed, and `fakeDeps()` fakes
 * `createMbregistryClient`/`startMbregistryWatcher` instead of
 * `startUsbWatcher` (which production wiring no longer calls -- see
 * `runtime.ts`'s own module doc comment).
 */
import { describe, expect, it, vi } from "vitest";
import { startRuntime, type StartRuntimeOptions } from "./runtime.js";
import type { HarvesterDeps, HarvesterTelemetryEvent } from "./connect/harvester.js";
import type { ConnectorDeps } from "./connect/connector.js";
import { DEFAULT_WIFI_DISCOVERY_GRACE_MS, type ReconcilerDeps } from "./connect/reconciler.js";
import type { RelayBridgerDeps } from "./connect/relayBridger.js";
import type { RelaySweeperDeps } from "./watchers/relaySweeper.js";
import type { MbregistryWatcherDeps } from "./watchers/mbregistryWatcher.js";

function fakeDeps() {
  const calls: string[] = [];

  // Sprint 018 ticket 008: `startRuntime` reads `mbregistry.shareBoards`
  // off the store (`config.ts#getMbregistryShareBoards`) right after
  // opening it, before creating the mbregistry client -- `getSetting`
  // must exist on the fake or that read throws. Defaults to no row
  // (`undefined`, reading as `false`, the documented default); a test
  // that cares about a specific value overrides `getSettingMock`'s
  // return.
  const getSettingMock = vi.fn((_key: string): string | undefined => undefined);
  // Port contention (replay guide §3): `startRuntime` ages every `usb`
  // link stale right after the mbregistry connect succeeds -- must
  // exist on the fake or that call throws.
  const ageLinksMock = vi.fn((_transport: string, _ttlMs: number, _now: number) => 0);
  const fakeStore = {
    close: vi.fn(() => calls.push("store.close")),
    getSetting: getSettingMock,
    ageLinks: ageLinksMock,
    marker: "fake-store",
  };
  const openStoreWithImportsMock = vi.fn(() => {
    calls.push("openStoreWithImports");
    return fakeStore;
  }) as unknown as StartRuntimeOptions["openStoreWithImports"];

  const mbregistryConnectMock = vi.fn(() => {
    calls.push("mbregistryClient.connect");
    return Promise.resolve({ kind: "unix", path: "/fake/api.sock" });
  });
  const mbregistryCloseMock = vi.fn(() => calls.push("mbregistryClient.close"));
  const fakeMbregistryClient = {
    connect: mbregistryConnectMock,
    close: mbregistryCloseMock,
    list: vi.fn(),
    find: vi.fn(),
    lock: vi.fn(),
    unlock: vi.fn(),
    watch: vi.fn(),
    stream: vi.fn(),
    resolvedEndpoint: undefined,
    remotePort: undefined,
  };
  const createMbregistryClientMock = vi.fn(() => {
    calls.push("createMbregistryClient");
    return fakeMbregistryClient;
  }) as unknown as StartRuntimeOptions["createMbregistryClient"];

  let capturedMbregistryWatcherDeps: (MbregistryWatcherDeps & { client: unknown }) | undefined;
  const mbregistryWatcherStopMock = vi.fn(() => calls.push("mbregistryWatcher.stop"));
  const startMbregistryWatcherMock = vi.fn((_store: unknown, deps: MbregistryWatcherDeps) => {
    calls.push("startMbregistryWatcher");
    capturedMbregistryWatcherDeps = deps as MbregistryWatcherDeps & { client: unknown };
    return { stop: mbregistryWatcherStopMock };
  }) as unknown as StartRuntimeOptions["startMbregistryWatcher"];

  const mdnsStopMock = vi.fn(() => calls.push("mdnsWatcher.stop"));
  const startMdnsWatcherMock = vi.fn(() => {
    calls.push("startMdnsWatcher");
    return { stop: mdnsStopMock };
  }) as unknown as StartRuntimeOptions["startMdnsWatcher"];

  const fakeBackend = { marker: "fake-backend" };
  const createBonjourBackendMock = vi.fn(() => fakeBackend) as unknown as StartRuntimeOptions["createBonjourBackend"];

  const firmwareStopMock = vi.fn(() => calls.push("firmwareWatcher.stop"));
  const startFirmwareWatcherMock = vi.fn(() => {
    calls.push("startFirmwareWatcher");
    return { stop: firmwareStopMock };
  }) as unknown as StartRuntimeOptions["startFirmwareWatcher"];

  let capturedHarvesterDeps: HarvesterDeps | undefined;
  // Sprint 019 ticket 003: `stop()` is now part of `HarvesterAttach`
  // (`connect/connector.ts`) -- this fake carries one, pushed onto the
  // same shared `calls` ledger every other collaborator's own stop uses,
  // so the "startRuntime -- stop()" ordering suite below can assert
  // where it lands relative to the others.
  const harvesterStopMock = vi.fn(() => calls.push("harvester.stop"));
  const fakeHarvester = { marker: "fake-harvester", stop: harvesterStopMock };
  const createHarvesterMock = vi.fn((_store: unknown, deps: HarvesterDeps) => {
    calls.push("createHarvester");
    capturedHarvesterDeps = deps;
    return fakeHarvester;
  }) as unknown as StartRuntimeOptions["createHarvester"];

  let capturedConnectorDeps: ConnectorDeps | undefined;
  const fakeConnector = { marker: "fake-connector" };
  const createConnectorMock = vi.fn((_store: unknown, deps: ConnectorDeps) => {
    calls.push("createConnector");
    capturedConnectorDeps = deps;
    return fakeConnector;
  }) as unknown as StartRuntimeOptions["createConnector"];

  let capturedRelayBridgerDeps: RelayBridgerDeps | undefined;
  const fakeBridger = { bridge: vi.fn(), marker: "fake-bridger" };
  const createRelayBridgerMock = vi.fn((_store: unknown, deps: RelayBridgerDeps) => {
    calls.push("createRelayBridger");
    capturedRelayBridgerDeps = deps;
    return fakeBridger;
  }) as unknown as StartRuntimeOptions["createRelayBridger"];

  let capturedReconcilerDeps: ReconcilerDeps | undefined;
  const reconcilerStopMock = vi.fn(() => calls.push("reconciler.stop"));
  const fakeReconciler = {
    requestOpen: vi.fn(),
    requestClose: vi.fn(),
    sessions: { get: () => undefined },
    stop: reconcilerStopMock,
  };
  const startReconcilerMock = vi.fn((_store: unknown, deps: ReconcilerDeps) => {
    calls.push("startReconciler");
    capturedReconcilerDeps = deps;
    return fakeReconciler;
  }) as unknown as StartRuntimeOptions["startReconciler"];

  const uninstallMock = vi.fn(() => calls.push("uninstallUnhandledRejectionBackstop"));
  const installUnhandledRejectionBackstopMock = vi.fn(() => {
    calls.push("installUnhandledRejectionBackstop");
    return uninstallMock;
  }) as unknown as StartRuntimeOptions["installUnhandledRejectionBackstop"];

  // Ticket 016-003: the shared revocation seam and the relay sweeper
  // itself -- both mocked here (never the real `startRelaySweeper`), so
  // this suite never risks a real timer touching this file's own
  // minimal fake store past the test's own synchronous assertions.
  const fakeRevocation = { marker: "fake-revocation" };
  const createRelayLeaseRevocationMock = vi.fn(() => {
    calls.push("createRelayLeaseRevocation");
    return fakeRevocation;
  }) as unknown as StartRuntimeOptions["createRelayLeaseRevocation"];

  let capturedRelaySweeperDeps: RelaySweeperDeps | undefined;
  const relaySweeperStopMock = vi.fn(() => calls.push("relaySweeper.stop"));
  const startRelaySweeperMock = vi.fn((_store: unknown, deps: RelaySweeperDeps) => {
    calls.push("startRelaySweeper");
    capturedRelaySweeperDeps = deps;
    return { stop: relaySweeperStopMock };
  }) as unknown as StartRuntimeOptions["startRelaySweeper"];

  const options: StartRuntimeOptions = {
    openStoreWithImports: openStoreWithImportsMock,
    createMbregistryClient: createMbregistryClientMock,
    startMbregistryWatcher: startMbregistryWatcherMock,
    startMdnsWatcher: startMdnsWatcherMock,
    createBonjourBackend: createBonjourBackendMock,
    startFirmwareWatcher: startFirmwareWatcherMock,
    createHarvester: createHarvesterMock,
    createConnector: createConnectorMock,
    createRelayBridger: createRelayBridgerMock,
    startReconciler: startReconcilerMock,
    createRelayLeaseRevocation: createRelayLeaseRevocationMock,
    startRelaySweeper: startRelaySweeperMock,
    installUnhandledRejectionBackstop: installUnhandledRejectionBackstopMock,
    // 018-010: `disableSweep` now defaults to `true` (sweeper off) when
    // omitted -- every fixture here explicitly opts back in so the
    // composition/telemetry/stop() suites below (which exist to test
    // wiring OTHER than the sweeper's own on/off default) keep
    // exercising `startRelaySweeperMock` exactly as before. The
    // dedicated "disableSweep default" describe block below is the one
    // place that omits this override on purpose.
    disableSweep: false,
  };

  return {
    options,
    calls,
    fakeStore,
    getSettingMock,
    ageLinksMock,
    fakeBackend,
    fakeHarvester,
    fakeConnector,
    fakeBridger,
    fakeReconciler,
    fakeRevocation,
    fakeMbregistryClient,
    mbregistryConnectMock,
    mbregistryCloseMock,
    mbregistryWatcherStopMock,
    mdnsStopMock,
    firmwareStopMock,
    startFirmwareWatcherMock,
    reconcilerStopMock,
    relaySweeperStopMock,
    harvesterStopMock,
    uninstallMock,
    openStoreWithImportsMock,
    createMbregistryClientMock,
    startMbregistryWatcherMock,
    startMdnsWatcherMock,
    createBonjourBackendMock,
    createHarvesterMock,
    createConnectorMock,
    createRelayBridgerMock,
    startReconcilerMock,
    createRelayLeaseRevocationMock,
    startRelaySweeperMock,
    installUnhandledRejectionBackstopMock,
    getCapturedHarvesterDeps: () => capturedHarvesterDeps,
    getCapturedConnectorDeps: () => capturedConnectorDeps,
    getCapturedRelayBridgerDeps: () => capturedRelayBridgerDeps,
    getCapturedReconcilerDeps: () => capturedReconcilerDeps,
    getCapturedRelaySweeperDeps: () => capturedRelaySweeperDeps,
    getCapturedMbregistryWatcherDeps: () => capturedMbregistryWatcherDeps,
  };
}

describe("startRuntime -- composition", () => {
  it("opens the store, resolves the mbregistry client, starts the mbregistry/mDNS/firmware watchers against it, and wires harvester -> connector -> reconciler in order", async () => {
    const f = fakeDeps();

    const runtime = await startRuntime(f.options);

    expect(f.openStoreWithImportsMock).toHaveBeenCalledTimes(1);
    // Sprint 018 ticket 006: mbregistryClient.connect() is awaited BEFORE
    // startMbregistryWatcher/createConnector are ever called.
    expect(f.mbregistryConnectMock).toHaveBeenCalledTimes(1);
    expect(f.startMbregistryWatcherMock).toHaveBeenCalledWith(
      f.fakeStore,
      expect.objectContaining({ client: f.fakeMbregistryClient }),
    );
    expect(f.getCapturedMbregistryWatcherDeps()?.client).toBe(f.fakeMbregistryClient);
    // mdnsWatcher starts with the three legacy browses disabled by
    // default (see `runtime.ts`'s own `DEFAULT_DISABLED_MDNS_TYPES`).
    expect(f.startMdnsWatcherMock).toHaveBeenCalledWith(f.fakeStore, { backend: f.fakeBackend }, {
      disabledTypes: ["mbserial", "mbrelay", "mbflash"],
    });
    // Sprint 017 ticket 002: the firmware watcher is composed here too,
    // exactly like the other two -- replacing the retired
    // `FirmwareAvailabilityCache` server.ts used to construct itself.
    expect(f.startFirmwareWatcherMock).toHaveBeenCalledWith(f.fakeStore, undefined, undefined);
    expect(f.createHarvesterMock).toHaveBeenCalledTimes(1);
    expect(f.createHarvesterMock).toHaveBeenCalledWith(f.fakeStore, expect.any(Object));
    // The connector this runtime builds is handed the harvester this
    // runtime itself built -- never a separately-constructed one -- plus
    // the same mbregistryClient/mbregistryLabel this runtime resolved.
    expect(f.getCapturedConnectorDeps()?.harvester).toBe(f.fakeHarvester);
    expect(f.getCapturedConnectorDeps()?.mbregistryClient).toBe(f.fakeMbregistryClient);
    expect(typeof f.getCapturedConnectorDeps()?.mbregistryLabel).toBe("string");
    expect(f.createConnectorMock).toHaveBeenCalledWith(
      f.fakeStore,
      expect.objectContaining({ harvester: f.fakeHarvester, mbregistryClient: f.fakeMbregistryClient }),
      undefined,
    );
    // Same for the reconciler and the connector.
    expect(f.getCapturedReconcilerDeps()?.connector).toBe(f.fakeConnector);
    expect(f.startReconcilerMock).toHaveBeenCalledWith(f.fakeStore, expect.objectContaining({ connector: f.fakeConnector }));
    // 020-003: real production wiring opts into the wrong-robot-hazard
    // discovery grace window by default -- `reconciler.ts`'s own
    // `startReconciler` defaults this to disabled (`0`) for every other
    // caller (test harnesses built directly on it), so this runtime is
    // the one place that must supply it explicitly.
    expect(f.getCapturedReconcilerDeps()?.wifiDiscoveryGraceMs).toBe(DEFAULT_WIFI_DISCOVERY_GRACE_MS);
    // Ticket 016-002/004: the reconciler is handed the SAME bridger this
    // runtime itself built, and that bridger is handed the same harvester
    // as the connector.
    expect(f.getCapturedReconcilerDeps()?.bridger).toBe(f.fakeBridger);
    expect(f.getCapturedRelayBridgerDeps()?.harvester).toBe(f.fakeHarvester);
    // Ticket 018-011 finding 1: `relayBridger` must receive the same
    // mbregistryClient/mbregistryLabel the connector receives -- ticket
    // 007 added `RelayBridgerDeps.mbregistryClient`/`mbregistryLabel`, but
    // this composition root never forwarded them, so bridging a relay
    // discovered only through mbregistry failed immediately. This
    // assertion fails if that wiring gap ever regresses.
    expect(f.getCapturedRelayBridgerDeps()?.mbregistryClient).toBe(f.fakeMbregistryClient);
    expect(f.getCapturedRelayBridgerDeps()?.mbregistryLabel).toBe(f.getCapturedConnectorDeps()?.mbregistryLabel);
    expect(typeof f.getCapturedRelayBridgerDeps()?.mbregistryLabel).toBe("string");
    expect(f.createRelayBridgerMock).toHaveBeenCalledWith(
      f.fakeStore,
      expect.objectContaining({ harvester: f.fakeHarvester, mbregistryClient: f.fakeMbregistryClient }),
      undefined,
    );
    expect(f.installUnhandledRejectionBackstopMock).toHaveBeenCalledWith(f.fakeStore, undefined);

    // Ticket 016-003/004: the revocation seam this runtime itself built
    // is handed to BOTH the sweeper and the bridger -- never two
    // separately constructed instances -- so a student's connect (the
    // bridger) can find and abort the sweeper's own registered pass.
    expect(f.createRelayLeaseRevocationMock).toHaveBeenCalledTimes(1);
    expect(f.getCapturedRelaySweeperDeps()?.revocation).toBe(f.fakeRevocation);
    expect(f.getCapturedRelayBridgerDeps()?.revocation).toBe(f.fakeRevocation);
    expect(f.startRelaySweeperMock).toHaveBeenCalledWith(
      f.fakeStore,
      expect.objectContaining({ revocation: f.fakeRevocation }),
      undefined,
    );

    expect(runtime.store).toBe(f.fakeStore);
    expect(runtime.reconciler).toBe(f.fakeReconciler);
    expect(runtime.mbregistryClient).toBe(f.fakeMbregistryClient);
    expect(typeof runtime.mbregistryLabel).toBe("string");
  });

  // Sprint 018 ticket 008: `mbregistry.shareBoards` is a `settings` row
  // (`config.ts#getMbregistryShareBoards`), not an in-memory-only flag --
  // `startRuntime` reads it off the just-opened store and passes it as
  // `createMbregistryClient`'s own `shareBoards` default, so a spawned
  // instance's peering follows whatever was last persisted.
  it("reads mbregistry.shareBoards off the store and passes it as the mbregistry client's shareBoards default", async () => {
    const f = fakeDeps();
    f.getSettingMock.mockImplementation((key: string) => (key === "mbregistry.shareBoards" ? "true" : undefined));

    await startRuntime(f.options);

    expect(f.getSettingMock).toHaveBeenCalledWith("mbregistry.shareBoards");
    expect(f.createMbregistryClientMock).toHaveBeenCalledWith(expect.objectContaining({ shareBoards: true }));
  });

  it("defaults mbregistry shareBoards to false when no settings row is stored", async () => {
    const f = fakeDeps();

    await startRuntime(f.options);

    expect(f.createMbregistryClientMock).toHaveBeenCalledWith(expect.objectContaining({ shareBoards: false }));
  });

  it("lets an explicit mbregistryClientDeps.shareBoards override the stored setting", async () => {
    const f = fakeDeps();
    f.getSettingMock.mockImplementation((key: string) => (key === "mbregistry.shareBoards" ? "true" : undefined));

    await startRuntime({ ...f.options, mbregistryClientDeps: { shareBoards: false } });

    expect(f.createMbregistryClientMock).toHaveBeenCalledWith(expect.objectContaining({ shareBoards: false }));
  });

  it("forwards storeOptions/mdnsWatcherOptions/firmwareWatcherDeps/firmwareWatcherOptions/connectorOptions/reconcilerDeps/harvesterDeps/mbregistryClientDeps/mbregistryWatcherDeps/mbregistryLabel through untouched", async () => {
    const f = fakeDeps();
    const storeOptions = { filePath: ":memory:" };
    const mbregistryClientDeps = { shareBoards: true };
    const mbregistryWatcherDeps = { now: () => 3 };
    const mbregistryLabel = "custom-label";
    const mdnsWatcherOptions = { requeryIntervalMs: 5 };
    const firmwareWatcherDeps = { now: () => 11 };
    const firmwareWatcherOptions = { pollIntervalMs: 5 };
    const connectorOptions = { connectTimeoutMs: 5 };
    const reconcilerDeps = { now: () => 99, tickIntervalMs: 5 };
    const harvesterDeps = { now: () => 7 };

    await startRuntime({
      ...f.options,
      storeOptions,
      mbregistryClientDeps,
      mbregistryWatcherDeps,
      mbregistryLabel,
      mdnsWatcherOptions,
      firmwareWatcherDeps,
      firmwareWatcherOptions,
      connectorOptions,
      reconcilerDeps,
      harvesterDeps,
    });

    expect(f.openStoreWithImportsMock).toHaveBeenCalledWith(storeOptions);
    expect(f.createMbregistryClientMock).toHaveBeenCalledWith(mbregistryClientDeps);
    expect(f.getCapturedMbregistryWatcherDeps()).toMatchObject(mbregistryWatcherDeps);
    expect(f.getCapturedConnectorDeps()?.mbregistryLabel).toBe(mbregistryLabel);
    // An explicit mdnsWatcherOptions still gets the disabledTypes default
    // merged in (not overridden away) unless the caller sets its own.
    expect(f.startMdnsWatcherMock).toHaveBeenCalledWith(
      f.fakeStore,
      { backend: f.fakeBackend },
      expect.objectContaining(mdnsWatcherOptions),
    );
    expect(f.startFirmwareWatcherMock).toHaveBeenCalledWith(f.fakeStore, firmwareWatcherDeps, firmwareWatcherOptions);
    expect(f.createConnectorMock).toHaveBeenCalledWith(f.fakeStore, expect.any(Object), connectorOptions);
    expect(f.getCapturedReconcilerDeps()).toMatchObject(reconcilerDeps);
    expect(f.getCapturedHarvesterDeps()).toMatchObject(harvesterDeps);
  });

  it("020-003: an explicit reconcilerDeps.wifiDiscoveryGraceMs overrides this runtime's own default", async () => {
    const f = fakeDeps();
    await startRuntime({ ...f.options, reconcilerDeps: { wifiDiscoveryGraceMs: 5 } });
    expect(f.getCapturedReconcilerDeps()?.wifiDiscoveryGraceMs).toBe(5);
  });

  it("uses a caller-supplied mdnsBackend instead of constructing one via createBonjourBackend", async () => {
    const f = fakeDeps();
    const suppliedBackend = { marker: "supplied-backend" };

    await startRuntime({ ...f.options, mdnsBackend: suppliedBackend });

    expect(f.createBonjourBackendMock).not.toHaveBeenCalled();
    expect(f.startMdnsWatcherMock).toHaveBeenCalledWith(
      f.fakeStore,
      { backend: suppliedBackend },
      expect.objectContaining({ disabledTypes: ["mbserial", "mbrelay", "mbflash"] }),
    );
  });

  it("mbregistry resolution/spawn failure rejects startRuntime outright -- no mbregistryWatcher/connector/reconciler is ever constructed, and there is no fallback watcher", async () => {
    const f = fakeDeps();
    const failure = new Error("mbregistry ('mbregistry') not found on $MBREGISTRY_BIN/$PATH (requires >= 0.20260924.7)");
    f.fakeMbregistryClient.connect.mockRejectedValueOnce(failure);

    await expect(startRuntime(f.options)).rejects.toThrow(failure.message);

    expect(f.startMbregistryWatcherMock).not.toHaveBeenCalled();
    expect(f.createConnectorMock).not.toHaveBeenCalled();
    expect(f.startReconcilerMock).not.toHaveBeenCalled();
    // No usbWatcher fallback either -- production wiring has no such
    // option to fall back to any more (see runtime.ts's own doc
    // comment); this suite has nothing further to assert there beyond
    // "nothing downstream of the failed connect ever ran".
  });

  // Port contention (replay guide §3): a failed mbregistry connect must
  // not leak the store this call already opened above.
  it("closes the already-opened store when the mbregistry connect fails", async () => {
    const f = fakeDeps();
    f.fakeMbregistryClient.connect.mockRejectedValueOnce(new Error("spawn failed"));

    await expect(startRuntime(f.options)).rejects.toThrow("spawn failed");

    expect(f.fakeStore.close).toHaveBeenCalledTimes(1);
  });

  // Port contention (replay guide §3): with usbWatcher off in favor of
  // mbregistryWatcher, nothing else ages a leftover `usb` link row --
  // startRuntime must do it itself, right after the mbregistry connect
  // succeeds, so the reconciler/sweeper/flasher never race mbregistry
  // for the same serial port.
  it("ages every usb link stale once the mbregistry connect succeeds", async () => {
    const f = fakeDeps();

    await startRuntime(f.options);

    expect(f.ageLinksMock).toHaveBeenCalledWith("usb", 0, expect.any(Number));
  });
});

describe("startRuntime -- telemetry fan-out", () => {
  it("forwards the harvester's onTelemetry/onNotice callbacks to every runtime.telemetry subscriber, and unsubscribe stops delivery", async () => {
    const f = fakeDeps();
    const runtime = await startRuntime(f.options);

    const harvesterDeps = f.getCapturedHarvesterDeps();
    expect(harvesterDeps?.onTelemetry).toBeInstanceOf(Function);
    expect(harvesterDeps?.onNotice).toBeInstanceOf(Function);

    const telemetryEvents: Array<[string, HarvesterTelemetryEvent]> = [];
    const unsubscribeTelemetry = runtime.telemetry.onTelemetry((linkId, event) => telemetryEvents.push([linkId, event]));
    const notices: Array<[string, string]> = [];
    const unsubscribeNotice = runtime.telemetry.onNotice((linkId, message) => notices.push([linkId, message]));

    harvesterDeps?.onTelemetry?.("link-1", { frame: { x: "1" } });
    harvesterDeps?.onNotice?.("link-1", "resynced");

    expect(telemetryEvents).toEqual([["link-1", { frame: { x: "1" } }]]);
    expect(notices).toEqual([["link-1", "resynced"]]);

    unsubscribeTelemetry();
    unsubscribeNotice();
    harvesterDeps?.onTelemetry?.("link-1", { frame: { x: "2" } });
    harvesterDeps?.onNotice?.("link-1", "another");

    // No further delivery once unsubscribed.
    expect(telemetryEvents).toHaveLength(1);
    expect(notices).toHaveLength(1);
  });

  it("supports more than one concurrent telemetry subscriber", async () => {
    const f = fakeDeps();
    const runtime = await startRuntime(f.options);
    const harvesterDeps = f.getCapturedHarvesterDeps();

    const a: string[] = [];
    const b: string[] = [];
    runtime.telemetry.onTelemetry((linkId) => a.push(linkId));
    runtime.telemetry.onTelemetry((linkId) => b.push(linkId));

    harvesterDeps?.onTelemetry?.("link-2", {});

    expect(a).toEqual(["link-2"]);
    expect(b).toEqual(["link-2"]);
  });
});

describe("startRuntime -- stop()", () => {
  it("stops the backstop, the reconciler, the relay sweeper, the harvester, all three watchers, closes the mbregistry client, then closes the store, in that order", async () => {
    const f = fakeDeps();
    const runtime = await startRuntime(f.options);
    f.calls.length = 0; // only care about stop()'s own ordering from here

    // Ticket 016-008: stop() now awaits the relay sweeper's own stop()
    // (which itself awaits every in-flight pass's cleanup) before
    // continuing on to the watchers and the store -- see runtime.ts's
    // own Runtime.stop doc comment. Ticket 019-003: the harvester's own
    // `stop()` lands right after the sweeper's, still before every
    // watcher and the store.
    await runtime.stop();

    expect(f.calls).toEqual([
      "uninstallUnhandledRejectionBackstop",
      "reconciler.stop",
      "relaySweeper.stop",
      "harvester.stop",
      "mbregistryWatcher.stop",
      "mdnsWatcher.stop",
      "firmwareWatcher.stop",
      "mbregistryClient.close",
      "store.close",
    ]);
  });

  it("is idempotent -- a second stop() call touches nothing again", async () => {
    const f = fakeDeps();
    const runtime = await startRuntime(f.options);

    await runtime.stop();
    await runtime.stop();

    expect(f.uninstallMock).toHaveBeenCalledTimes(1);
    expect(f.reconcilerStopMock).toHaveBeenCalledTimes(1);
    expect(f.relaySweeperStopMock).toHaveBeenCalledTimes(1);
    expect(f.harvesterStopMock).toHaveBeenCalledTimes(1);
    expect(f.mbregistryWatcherStopMock).toHaveBeenCalledTimes(1);
    expect(f.mdnsStopMock).toHaveBeenCalledTimes(1);
    expect(f.firmwareStopMock).toHaveBeenCalledTimes(1);
    expect(f.mbregistryCloseMock).toHaveBeenCalledTimes(1);
    expect(f.fakeStore.close).toHaveBeenCalledTimes(1);
  });
});

describe("startRuntime -- disableSweep (018-005 Step 0b)", () => {
  it("never calls startRelaySweeper when disableSweep: true -- no scan tick, no relay lease, ever", async () => {
    const f = fakeDeps();
    await startRuntime({ ...f.options, disableSweep: true });

    expect(f.startRelaySweeperMock).not.toHaveBeenCalled();
    // The shared revocation seam is still constructed -- the bridger
    // still needs it even with the sweeper disabled.
    expect(f.createRelayLeaseRevocationMock).toHaveBeenCalledTimes(1);
  });

  it("stop() still resolves cleanly with the sweeper disabled (its stub stop() is a no-op, never the real relaySweeperStopMock)", async () => {
    const f = fakeDeps();
    const runtime = await startRuntime({ ...f.options, disableSweep: true });
    f.calls.length = 0;

    await expect(runtime.stop()).resolves.toBeUndefined();

    expect(f.relaySweeperStopMock).not.toHaveBeenCalled();
    expect(f.calls).toEqual([
      "uninstallUnhandledRejectionBackstop",
      "reconciler.stop",
      "harvester.stop",
      "mbregistryWatcher.stop",
      "mdnsWatcher.stop",
      "firmwareWatcher.stop",
      "mbregistryClient.close",
      "store.close",
    ]);
  });

  it("starts the sweeper when disableSweep: false is passed explicitly", async () => {
    const f = fakeDeps();
    await startRuntime({ ...f.options, disableSweep: false });
    expect(f.startRelaySweeperMock).toHaveBeenCalledTimes(1);
  });
});

describe("startRuntime -- disableSweep defaults to true (018-010: sweeper off by default)", () => {
  it("never calls startRelaySweeper when disableSweep is omitted entirely -- not just when it's explicitly true. Mirrors scripts/dev.mjs's own bare startRuntime() call, which has no opinion on disableSweep at all", async () => {
    const f = fakeDeps();
    const { disableSweep: _drop, ...optionsWithoutDisableSweep } = f.options;

    await startRuntime(optionsWithoutDisableSweep);

    expect(f.startRelaySweeperMock).not.toHaveBeenCalled();
    // The shared revocation seam is still constructed -- the bridger
    // still needs it even with the sweeper off by default.
    expect(f.createRelayLeaseRevocationMock).toHaveBeenCalledTimes(1);
  });
});

describe("startRuntime -- two consoles on one machine (sprint 018 success criterion)", () => {
  it("two startRuntime calls (two different ports is server.ts's own concern -- see cli.test.ts/server.test.ts) produce two fully independent stores/reconcilers/mbregistry clients with no shared state", async () => {
    const f1 = fakeDeps();
    const f2 = fakeDeps();

    const runtime1 = await startRuntime(f1.options);
    const runtime2 = await startRuntime(f2.options);

    expect(runtime1.store).not.toBe(runtime2.store);
    expect(runtime1.reconciler).not.toBe(runtime2.reconciler);
    expect(runtime1.mbregistryClient).not.toBe(runtime2.mbregistryClient);
    expect(f1.createMbregistryClientMock).toHaveBeenCalledTimes(1);
    expect(f2.createMbregistryClientMock).toHaveBeenCalledTimes(1);

    await runtime1.stop();
    // Stopping the first instance never touches the second's own
    // collaborators.
    expect(f2.reconcilerStopMock).not.toHaveBeenCalled();
    expect(f2.mbregistryCloseMock).not.toHaveBeenCalled();
    expect(f2.fakeStore.close).not.toHaveBeenCalled();

    await runtime2.stop();
  });
});
