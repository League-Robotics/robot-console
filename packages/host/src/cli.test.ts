/**
 * cli.test.ts — flag parsing and wiring for `--dump-store` (kept), the
 * production startup path (`runtime.ts` -> `server.ts`), and
 * `SIGINT`/`SIGTERM` shutdown (sprint 015 ticket 005). `--watch-store`
 * is retired by this ticket -- see `cli.ts`'s own doc comment -- so its
 * old describe block is gone, not migrated.
 *
 * Every collaborator is a `CliDeps` fake -- the same "real defaults,
 * fakes in tests" seam this suite has always used -- so no real store,
 * watchers, ports, browser, or process exit is ever touched here.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { main, type CliDeps } from "./cli.js";
import type { StartRuntimeOptions } from "./runtime.js";
import type { StoreSnapshot } from "./store/index.js";

const EMPTY_SNAPSHOT: StoreSnapshot = { devices: [], links: [], services: [], sessions: [], tasks: [] };

describe("cli: main -- --dump-store", () => {
  it("prints the formatted snapshot and touches no other collaborator", async () => {
    const dumpStoreMock = vi.fn().mockReturnValue(EMPTY_SNAPSHOT);
    const formatStoreDumpMock = vi.fn().mockReturnValue("FORMATTED-DUMP");
    const startRuntimeMock = vi.fn();
    const startServerMock = vi.fn();
    const openBrowserMock = vi.fn().mockResolvedValue(undefined);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const deps: CliDeps = {
      dumpStore: dumpStoreMock,
      formatStoreDump: formatStoreDumpMock,
      startRuntime: startRuntimeMock,
      startServer: startServerMock,
      openBrowser: openBrowserMock,
    };
    const env = { SOME: "env" } as unknown as NodeJS.ProcessEnv;

    await main(["--dump-store"], env, deps);

    expect(dumpStoreMock).toHaveBeenCalledWith({ env });
    expect(formatStoreDumpMock).toHaveBeenCalledWith(EMPTY_SNAPSHOT);
    expect(logSpy).toHaveBeenCalledWith("FORMATTED-DUMP");
    // --dump-store must stay read-only: it never composes the runtime,
    // let alone starts the server.
    expect(startRuntimeMock).not.toHaveBeenCalled();
    expect(startServerMock).not.toHaveBeenCalled();
    expect(openBrowserMock).not.toHaveBeenCalled();

    logSpy.mockRestore();
  });
});

describe("cli: main -- --watch-store is gone", () => {
  it("no longer short-circuits main() -- it is treated as an ordinary (ignored) argv token, falling through to production startup", async () => {
    const runtimeStopMock = vi.fn();
    const startRuntimeMock = vi.fn().mockResolvedValue({ store: { marker: "fake-store" }, reconciler: {}, telemetry: {}, mbregistryClient: {} as unknown as import("./mbregistry/client.js").MbregistryClient, mbregistryLabel: "test", stop: runtimeStopMock });
    const startServerMock = vi.fn().mockResolvedValue({ url: "http://127.0.0.1:4795", close: vi.fn().mockResolvedValue(undefined) });
    const openBrowserMock = vi.fn().mockResolvedValue(undefined);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const deps: CliDeps = {
      startRuntime: startRuntimeMock,
      startServer: startServerMock,
      openBrowser: openBrowserMock,
      getFirmwareConfig: vi.fn().mockReturnValue({}),
    };

    await main(["--watch-store"], {} as NodeJS.ProcessEnv, deps);

    expect(startRuntimeMock).toHaveBeenCalledTimes(1);
    expect(startServerMock).toHaveBeenCalledTimes(1);

    logSpy.mockRestore();
  });
});

describe("cli: main -- production startup composes runtime then server", () => {
  afterEach(() => {
    process.removeAllListeners("SIGINT");
    process.removeAllListeners("SIGTERM");
  });

  it("calls the real startRuntime, which in turn invokes openStoreWithImports and starts the mbregistry/mDNS/firmware watchers -- not by re-running --watch-store", async () => {
    const fakeStore = { close: vi.fn(), marker: "fake-store" };
    const openStoreWithImportsMock = vi.fn().mockReturnValue(fakeStore);
    // Sprint 018 ticket 006: production startRuntime() resolves/connects
    // a real mbregistry client before anything else -- faked here (a
    // real client would try to spawn/connect to an actual mbregistry).
    const mbregistryConnectMock = vi.fn().mockResolvedValue({ kind: "unix", path: "/tmp/fake.sock" });
    const mbregistryCloseMock = vi.fn();
    const fakeMbregistryClient = {
      connect: mbregistryConnectMock,
      close: mbregistryCloseMock,
      resolvedEndpoint: undefined,
      remotePort: undefined,
    };
    const createMbregistryClientMock = vi.fn(() => fakeMbregistryClient);
    const mbregistryWatcherStopMock = vi.fn();
    const startMbregistryWatcherMock = vi.fn().mockReturnValue({ stop: mbregistryWatcherStopMock });
    const mdnsStopMock = vi.fn();
    const startMdnsWatcherMock = vi.fn().mockReturnValue({ stop: mdnsStopMock });
    const firmwareStopMock = vi.fn();
    const startFirmwareWatcherMock = vi.fn().mockReturnValue({ stop: firmwareStopMock });
    const fakeBackend = { find: vi.fn() };
    const createBonjourBackendMock = vi.fn(() => fakeBackend);
    const reconcilerStopMock = vi.fn();
    const startReconcilerMock = vi.fn().mockReturnValue({
      requestOpen: vi.fn(),
      requestClose: vi.fn(),
      sessions: { get: () => undefined, values: () => [].values() },
      stop: reconcilerStopMock,
    });
    const uninstallMock = vi.fn();
    const installUnhandledRejectionBackstopMock = vi.fn().mockReturnValue(uninstallMock);
    const createHarvesterMock = vi.fn().mockReturnValue({ attach: vi.fn() });
    const createConnectorMock = vi.fn().mockReturnValue({ connectAndIdentify: vi.fn() });

    const runtimeOptions: StartRuntimeOptions = {
      openStoreWithImports: openStoreWithImportsMock as unknown as StartRuntimeOptions["openStoreWithImports"],
      createMbregistryClient: createMbregistryClientMock as unknown as StartRuntimeOptions["createMbregistryClient"],
      startMbregistryWatcher: startMbregistryWatcherMock as unknown as StartRuntimeOptions["startMbregistryWatcher"],
      startMdnsWatcher: startMdnsWatcherMock as unknown as StartRuntimeOptions["startMdnsWatcher"],
      createBonjourBackend: createBonjourBackendMock as unknown as StartRuntimeOptions["createBonjourBackend"],
      startFirmwareWatcher: startFirmwareWatcherMock as unknown as StartRuntimeOptions["startFirmwareWatcher"],
      createHarvester: createHarvesterMock as unknown as StartRuntimeOptions["createHarvester"],
      createConnector: createConnectorMock as unknown as StartRuntimeOptions["createConnector"],
      startReconciler: startReconcilerMock as unknown as StartRuntimeOptions["startReconciler"],
      installUnhandledRejectionBackstop: installUnhandledRejectionBackstopMock as unknown as StartRuntimeOptions["installUnhandledRejectionBackstop"],
    };

    const startServerMock = vi.fn().mockResolvedValue({ url: "http://127.0.0.1:4795", close: vi.fn().mockResolvedValue(undefined) });
    const openBrowserMock = vi.fn().mockResolvedValue(undefined);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const env = { SOME: "env" } as unknown as NodeJS.ProcessEnv;

    const deps: CliDeps = {
      // startRuntime itself is the REAL implementation here -- only its
      // own dependencies are faked (via runtimeOptions) -- so this
      // assertion is "does main()'s wiring reach startRuntime's own
      // collaborators", per this ticket's own acceptance criterion, not
      // "was startRuntime called".
      runtimeOptions,
      startServer: startServerMock,
      openBrowser: openBrowserMock,
      getFirmwareConfig: vi.fn().mockReturnValue({}),
    };

    await main([], env, deps);

    expect(openStoreWithImportsMock).toHaveBeenCalledWith({ env });
    expect(mbregistryConnectMock).toHaveBeenCalledTimes(1);
    expect(startMbregistryWatcherMock).toHaveBeenCalled();
    expect(startMdnsWatcherMock).toHaveBeenCalled();
    expect(startFirmwareWatcherMock).toHaveBeenCalled();
    expect(installUnhandledRejectionBackstopMock).toHaveBeenCalled();
    expect(startServerMock).toHaveBeenCalledWith(
      expect.objectContaining({ store: fakeStore, mbregistryClient: fakeMbregistryClient }),
    );

    logSpy.mockRestore();
  });

  it("resolves --port/ROBOT_CONSOLE_PORT and forwards it to startServer", async () => {
    const startRuntimeMock = vi.fn().mockResolvedValue({ store: {}, reconciler: {}, telemetry: {}, mbregistryClient: {} as unknown as import("./mbregistry/client.js").MbregistryClient, mbregistryLabel: "test", stop: vi.fn() });
    const startServerMock = vi.fn().mockResolvedValue({ url: "http://127.0.0.1:9999", close: vi.fn().mockResolvedValue(undefined) });
    const openBrowserMock = vi.fn().mockResolvedValue(undefined);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const deps: CliDeps = {
      startRuntime: startRuntimeMock,
      startServer: startServerMock,
      openBrowser: openBrowserMock,
      getFirmwareConfig: vi.fn().mockReturnValue({}),
    };

    await main(["--port", "9999"], {} as NodeJS.ProcessEnv, deps);

    expect(startServerMock).toHaveBeenCalledWith(expect.objectContaining({ port: 9999 }));

    logSpy.mockRestore();
  });

  it("logs a warning, but does not throw, when opening the browser fails", async () => {
    const startRuntimeMock = vi.fn().mockResolvedValue({ store: {}, reconciler: {}, telemetry: {}, mbregistryClient: {} as unknown as import("./mbregistry/client.js").MbregistryClient, mbregistryLabel: "test", stop: vi.fn() });
    const startServerMock = vi.fn().mockResolvedValue({ url: "http://127.0.0.1:4795", close: vi.fn().mockResolvedValue(undefined) });
    const openBrowserMock = vi.fn().mockRejectedValue(new Error("no display"));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const deps: CliDeps = {
      startRuntime: startRuntimeMock,
      startServer: startServerMock,
      openBrowser: openBrowserMock,
      getFirmwareConfig: vi.fn().mockReturnValue({}),
    };

    await expect(main([], {} as NodeJS.ProcessEnv, deps)).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("no display"));

    logSpy.mockRestore();
    warnSpy.mockRestore();
  });
});

describe("cli: main -- SIGINT/SIGTERM shutdown", () => {
  afterEach(() => {
    process.removeAllListeners("SIGINT");
    process.removeAllListeners("SIGTERM");
  });

  function fakeServerAndRuntime() {
    const runtimeStopMock = vi.fn();
    const serverCloseMock = vi.fn().mockResolvedValue(undefined);
    const startRuntimeMock = vi.fn().mockResolvedValue({ store: {}, reconciler: {}, telemetry: {}, mbregistryClient: {} as unknown as import("./mbregistry/client.js").MbregistryClient, mbregistryLabel: "test", stop: runtimeStopMock });
    const startServerMock = vi.fn().mockResolvedValue({ url: "http://127.0.0.1:4795", close: serverCloseMock });
    return { runtimeStopMock, serverCloseMock, startRuntimeMock, startServerMock };
  }

  it("SIGINT calls server.close() then runtime.stop() then exit(0)", async () => {
    const f = fakeServerAndRuntime();
    const exitMock = vi.fn();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await main([], {} as NodeJS.ProcessEnv, {
      startRuntime: f.startRuntimeMock,
      startServer: f.startServerMock,
      openBrowser: vi.fn().mockResolvedValue(undefined),
      getFirmwareConfig: vi.fn().mockReturnValue({}),
      exit: exitMock,
    });

    process.emit("SIGINT");
    await vi.waitFor(() => expect(exitMock).toHaveBeenCalled());

    expect(f.serverCloseMock).toHaveBeenCalledTimes(1);
    expect(f.runtimeStopMock).toHaveBeenCalledTimes(1);
    expect(exitMock).toHaveBeenCalledWith(0);
    // Order matters: close() (and whatever it waits on) before stop().
    const closeOrder = f.serverCloseMock.mock.invocationCallOrder[0];
    const stopOrder = f.runtimeStopMock.mock.invocationCallOrder[0];
    expect(closeOrder).toBeLessThan(stopOrder);

    logSpy.mockRestore();
  });

  it("SIGTERM does the same shutdown as SIGINT", async () => {
    const f = fakeServerAndRuntime();
    const exitMock = vi.fn();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await main([], {} as NodeJS.ProcessEnv, {
      startRuntime: f.startRuntimeMock,
      startServer: f.startServerMock,
      openBrowser: vi.fn().mockResolvedValue(undefined),
      getFirmwareConfig: vi.fn().mockReturnValue({}),
      exit: exitMock,
    });

    process.emit("SIGTERM");
    await vi.waitFor(() => expect(exitMock).toHaveBeenCalled());

    expect(f.serverCloseMock).toHaveBeenCalledTimes(1);
    expect(f.runtimeStopMock).toHaveBeenCalledTimes(1);

    logSpy.mockRestore();
  });

  it("is idempotent -- a second signal while shutdown is already running does not double-close/double-stop/double-exit", async () => {
    const f = fakeServerAndRuntime();
    const exitMock = vi.fn();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await main([], {} as NodeJS.ProcessEnv, {
      startRuntime: f.startRuntimeMock,
      startServer: f.startServerMock,
      openBrowser: vi.fn().mockResolvedValue(undefined),
      getFirmwareConfig: vi.fn().mockReturnValue({}),
      exit: exitMock,
    });

    process.emit("SIGINT");
    process.emit("SIGTERM");
    await vi.waitFor(() => expect(exitMock).toHaveBeenCalled());

    expect(f.serverCloseMock).toHaveBeenCalledTimes(1);
    expect(f.runtimeStopMock).toHaveBeenCalledTimes(1);
    expect(exitMock).toHaveBeenCalledTimes(1);

    logSpy.mockRestore();
  });

  it("kill -INT during a fake in-flight flash: server.close() (which itself waits for the flash) resolves before runtime.stop()/exit run", async () => {
    // This exercises the same contract server.test.ts's own "close()
    // waits for an in-flight flash" case verifies directly against
    // server.ts -- here it is the *signal handler's* ordering under
    // test: server.close() is awaited in full (including whatever it
    // is internally waiting on) before runtime.stop()/exit ever run.
    let resolveClose!: () => void;
    const serverCloseMock = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveClose = resolve;
        }),
    );
    const runtimeStopMock = vi.fn();
    const exitMock = vi.fn();
    const startRuntimeMock = vi.fn().mockResolvedValue({ store: {}, reconciler: {}, telemetry: {}, mbregistryClient: {} as unknown as import("./mbregistry/client.js").MbregistryClient, mbregistryLabel: "test", stop: runtimeStopMock });
    const startServerMock = vi.fn().mockResolvedValue({ url: "http://127.0.0.1:4795", close: serverCloseMock });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await main([], {} as NodeJS.ProcessEnv, {
      startRuntime: startRuntimeMock,
      startServer: startServerMock,
      openBrowser: vi.fn().mockResolvedValue(undefined),
      getFirmwareConfig: vi.fn().mockReturnValue({}),
      exit: exitMock,
    });

    process.emit("SIGINT");
    await vi.waitFor(() => expect(serverCloseMock).toHaveBeenCalled());

    // While the fake flash is still "in flight" (server.close() has not
    // resolved yet), neither runtime.stop() nor exit() has run.
    expect(runtimeStopMock).not.toHaveBeenCalled();
    expect(exitMock).not.toHaveBeenCalled();

    // The flash finishes (server.close()'s own await settles) -- only
    // then does shutdown proceed.
    resolveClose();
    await vi.waitFor(() => expect(exitMock).toHaveBeenCalled());
    expect(runtimeStopMock).toHaveBeenCalledTimes(1);

    logSpy.mockRestore();
  });
});
