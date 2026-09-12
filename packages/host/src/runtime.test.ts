/**
 * runtime.test.ts — sprint 015 ticket 005's own suite for the
 * composition root: every collaborator is a fake injected via
 * {@link StartRuntimeOptions}, mirroring `cli.test.ts`'s existing
 * "real defaults, fakes in tests" convention -- no real store/serial/
 * HID/mDNS I/O is ever touched here.
 */
import { describe, expect, it, vi } from "vitest";
import { startRuntime, type StartRuntimeOptions } from "./runtime.js";
import type { HarvesterDeps, HarvesterTelemetryEvent } from "./connect/harvester.js";
import type { ConnectorDeps } from "./connect/connector.js";
import type { ReconcilerDeps } from "./connect/reconciler.js";
import type { RelaySweeperDeps } from "./watchers/relaySweeper.js";

function fakeDeps() {
  const calls: string[] = [];

  const fakeStore = { close: vi.fn(() => calls.push("store.close")), marker: "fake-store" };
  const openStoreWithImportsMock = vi.fn(() => {
    calls.push("openStoreWithImports");
    return fakeStore;
  }) as unknown as StartRuntimeOptions["openStoreWithImports"];

  const usbStopMock = vi.fn(() => calls.push("usbWatcher.stop"));
  const startUsbWatcherMock = vi.fn(() => {
    calls.push("startUsbWatcher");
    return { stop: usbStopMock };
  }) as unknown as StartRuntimeOptions["startUsbWatcher"];

  const mdnsStopMock = vi.fn(() => calls.push("mdnsWatcher.stop"));
  const startMdnsWatcherMock = vi.fn(() => {
    calls.push("startMdnsWatcher");
    return { stop: mdnsStopMock };
  }) as unknown as StartRuntimeOptions["startMdnsWatcher"];

  const fakeBackend = { marker: "fake-backend" };
  const createBonjourBackendMock = vi.fn(() => fakeBackend) as unknown as StartRuntimeOptions["createBonjourBackend"];

  let capturedHarvesterDeps: HarvesterDeps | undefined;
  const fakeHarvester = { marker: "fake-harvester" };
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
    startUsbWatcher: startUsbWatcherMock,
    startMdnsWatcher: startMdnsWatcherMock,
    createBonjourBackend: createBonjourBackendMock,
    createHarvester: createHarvesterMock,
    createConnector: createConnectorMock,
    startReconciler: startReconcilerMock,
    createRelayLeaseRevocation: createRelayLeaseRevocationMock,
    startRelaySweeper: startRelaySweeperMock,
    installUnhandledRejectionBackstop: installUnhandledRejectionBackstopMock,
  };

  return {
    options,
    calls,
    fakeStore,
    fakeBackend,
    fakeHarvester,
    fakeConnector,
    fakeReconciler,
    fakeRevocation,
    usbStopMock,
    mdnsStopMock,
    reconcilerStopMock,
    relaySweeperStopMock,
    uninstallMock,
    openStoreWithImportsMock,
    startUsbWatcherMock,
    startMdnsWatcherMock,
    createBonjourBackendMock,
    createHarvesterMock,
    createConnectorMock,
    startReconcilerMock,
    createRelayLeaseRevocationMock,
    startRelaySweeperMock,
    installUnhandledRejectionBackstopMock,
    getCapturedHarvesterDeps: () => capturedHarvesterDeps,
    getCapturedConnectorDeps: () => capturedConnectorDeps,
    getCapturedReconcilerDeps: () => capturedReconcilerDeps,
    getCapturedRelaySweeperDeps: () => capturedRelaySweeperDeps,
  };
}

describe("startRuntime -- composition", () => {
  it("opens the store, starts both watchers against it, and wires harvester -> connector -> reconciler in order", () => {
    const f = fakeDeps();

    const runtime = startRuntime(f.options);

    expect(f.openStoreWithImportsMock).toHaveBeenCalledTimes(1);
    expect(f.startUsbWatcherMock).toHaveBeenCalledWith(f.fakeStore, undefined, undefined);
    expect(f.startMdnsWatcherMock).toHaveBeenCalledWith(f.fakeStore, { backend: f.fakeBackend }, undefined);
    expect(f.createHarvesterMock).toHaveBeenCalledTimes(1);
    expect(f.createHarvesterMock).toHaveBeenCalledWith(f.fakeStore, expect.any(Object));
    // The connector this runtime builds is handed the harvester this
    // runtime itself built -- never a separately-constructed one.
    expect(f.getCapturedConnectorDeps()?.harvester).toBe(f.fakeHarvester);
    expect(f.createConnectorMock).toHaveBeenCalledWith(f.fakeStore, expect.objectContaining({ harvester: f.fakeHarvester }), undefined);
    // Same for the reconciler and the connector.
    expect(f.getCapturedReconcilerDeps()?.connector).toBe(f.fakeConnector);
    expect(f.startReconcilerMock).toHaveBeenCalledWith(f.fakeStore, expect.objectContaining({ connector: f.fakeConnector }));
    expect(f.installUnhandledRejectionBackstopMock).toHaveBeenCalledWith(f.fakeStore, undefined);

    // Ticket 016-003: the sweeper is always constructed with the
    // revocation seam this runtime itself built -- never a separately
    // constructed one, mirroring the harvester -> connector wiring above.
    expect(f.createRelayLeaseRevocationMock).toHaveBeenCalledTimes(1);
    expect(f.getCapturedRelaySweeperDeps()?.revocation).toBe(f.fakeRevocation);
    expect(f.startRelaySweeperMock).toHaveBeenCalledWith(
      f.fakeStore,
      expect.objectContaining({ revocation: f.fakeRevocation }),
      undefined,
    );

    expect(runtime.store).toBe(f.fakeStore);
    expect(runtime.reconciler).toBe(f.fakeReconciler);
  });

  it("forwards storeOptions/usbWatcherDeps/usbWatcherOptions/mdnsWatcherOptions/connectorOptions/reconcilerDeps/harvesterDeps through untouched", () => {
    const f = fakeDeps();
    const storeOptions = { filePath: ":memory:" };
    const usbWatcherDeps = { now: () => 42 };
    const usbWatcherOptions = { pollIntervalMs: 5 };
    const mdnsWatcherOptions = { requeryIntervalMs: 5 };
    const connectorOptions = { connectTimeoutMs: 5 };
    const reconcilerDeps = { now: () => 99, tickIntervalMs: 5 };
    const harvesterDeps = { now: () => 7 };

    startRuntime({
      ...f.options,
      storeOptions,
      usbWatcherDeps,
      usbWatcherOptions,
      mdnsWatcherOptions,
      connectorOptions,
      reconcilerDeps,
      harvesterDeps,
    });

    expect(f.openStoreWithImportsMock).toHaveBeenCalledWith(storeOptions);
    expect(f.startUsbWatcherMock).toHaveBeenCalledWith(f.fakeStore, usbWatcherDeps, usbWatcherOptions);
    expect(f.startMdnsWatcherMock).toHaveBeenCalledWith(f.fakeStore, { backend: f.fakeBackend }, mdnsWatcherOptions);
    expect(f.createConnectorMock).toHaveBeenCalledWith(f.fakeStore, expect.any(Object), connectorOptions);
    expect(f.getCapturedReconcilerDeps()).toMatchObject(reconcilerDeps);
    expect(f.getCapturedHarvesterDeps()).toMatchObject(harvesterDeps);
  });

  it("uses a caller-supplied mdnsBackend instead of constructing one via createBonjourBackend", () => {
    const f = fakeDeps();
    const suppliedBackend = { marker: "supplied-backend" };

    startRuntime({ ...f.options, mdnsBackend: suppliedBackend });

    expect(f.createBonjourBackendMock).not.toHaveBeenCalled();
    expect(f.startMdnsWatcherMock).toHaveBeenCalledWith(f.fakeStore, { backend: suppliedBackend }, undefined);
  });
});

describe("startRuntime -- telemetry fan-out", () => {
  it("forwards the harvester's onTelemetry/onNotice callbacks to every runtime.telemetry subscriber, and unsubscribe stops delivery", () => {
    const f = fakeDeps();
    const runtime = startRuntime(f.options);

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

  it("supports more than one concurrent telemetry subscriber", () => {
    const f = fakeDeps();
    const runtime = startRuntime(f.options);
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
  it("stops the backstop, the reconciler, the relay sweeper, both watchers, then closes the store, in that order", () => {
    const f = fakeDeps();
    const runtime = startRuntime(f.options);
    f.calls.length = 0; // only care about stop()'s own ordering from here

    runtime.stop();

    expect(f.calls).toEqual([
      "uninstallUnhandledRejectionBackstop",
      "reconciler.stop",
      "relaySweeper.stop",
      "usbWatcher.stop",
      "mdnsWatcher.stop",
      "store.close",
    ]);
  });

  it("is idempotent -- a second stop() call touches nothing again", () => {
    const f = fakeDeps();
    const runtime = startRuntime(f.options);

    runtime.stop();
    runtime.stop();

    expect(f.uninstallMock).toHaveBeenCalledTimes(1);
    expect(f.reconcilerStopMock).toHaveBeenCalledTimes(1);
    expect(f.relaySweeperStopMock).toHaveBeenCalledTimes(1);
    expect(f.usbStopMock).toHaveBeenCalledTimes(1);
    expect(f.mdnsStopMock).toHaveBeenCalledTimes(1);
    expect(f.fakeStore.close).toHaveBeenCalledTimes(1);
  });
});
