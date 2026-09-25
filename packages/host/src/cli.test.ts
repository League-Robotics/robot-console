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

// Stakeholder instruction (018-010): `main()`'s default browser opener
// must launch Google Chrome, not whatever the OS default happens to be
// (Safari, on the macOS benches this project runs on). Mocked here so
// the "default opener" tests below can assert on the real, non-injected
// `openBrowser` default (`openInChrome` in `cli.ts`) without touching a
// real browser.
const openMock = vi.fn().mockResolvedValue(undefined);
vi.mock("open", () => ({
  default: (...args: unknown[]) => openMock(...args),
  apps: { chrome: "google chrome" },
}));

import { main, type CliDeps } from "./cli.js";
import { PortInUseError } from "./server.js";
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
      // Sprint 021 ticket 003: main() now writes/removes daemon.json
      // via these -- faked here so no test in this file ever touches
      // the real state directory.
      writeDaemonInfo: vi.fn(),
      removeDaemonInfo: vi.fn(),
      // Sprint 021 ticket 002: main() now calls startConsoleAdvertiser
      // unconditionally once startServer resolves -- faked here (not
      // exercising the real bonjour-service-backed default) so no test
      // in this file ever opens a real multicast socket.
      startConsoleAdvertiser: vi.fn().mockReturnValue({ stop: vi.fn() }),
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
    // Sprint 018 ticket 008: `startRuntime` reads `mbregistry.shareBoards`
    // off the store (`config.ts#getMbregistryShareBoards`) before
    // constructing the mbregistry client -- `getSetting` must exist on
    // this fake for that real call to succeed. Port contention (replay
    // guide §3): `startRuntime` also ages every usb link stale right
    // after the mbregistry connect succeeds -- `ageLinks` must exist too.
    const fakeStore = {
      close: vi.fn(),
      getSetting: vi.fn().mockReturnValue(undefined),
      ageLinks: vi.fn().mockReturnValue(0),
      marker: "fake-store",
    };
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
      // Sprint 021 ticket 003: main() now writes/removes daemon.json
      // via these -- faked here so no test in this file ever touches
      // the real state directory.
      writeDaemonInfo: vi.fn(),
      removeDaemonInfo: vi.fn(),
      // Sprint 021 ticket 002: main() now calls startConsoleAdvertiser
      // unconditionally once startServer resolves -- faked here (not
      // exercising the real bonjour-service-backed default) so no test
      // in this file ever opens a real multicast socket.
      startConsoleAdvertiser: vi.fn().mockReturnValue({ stop: vi.fn() }),
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
      // Sprint 021 ticket 003: main() now writes/removes daemon.json
      // via these -- faked here so no test in this file ever touches
      // the real state directory.
      writeDaemonInfo: vi.fn(),
      removeDaemonInfo: vi.fn(),
      // Sprint 021 ticket 002: main() now calls startConsoleAdvertiser
      // unconditionally once startServer resolves -- faked here (not
      // exercising the real bonjour-service-backed default) so no test
      // in this file ever opens a real multicast socket.
      startConsoleAdvertiser: vi.fn().mockReturnValue({ stop: vi.fn() }),
    };

    await main(["--port", "9999"], {} as NodeJS.ProcessEnv, deps);

    expect(startServerMock).toHaveBeenCalledWith(expect.objectContaining({ port: 9999 }));

    logSpy.mockRestore();
  });

  it("--no-open skips the browser launch entirely (018-002 Layer 2 bench harness)", async () => {
    const startRuntimeMock = vi.fn().mockReturnValue({ store: {}, reconciler: {}, telemetry: {}, stop: vi.fn() });
    const startServerMock = vi.fn().mockResolvedValue({ url: "http://127.0.0.1:4795", close: vi.fn().mockResolvedValue(undefined) });
    const openBrowserMock = vi.fn().mockResolvedValue(undefined);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const deps: CliDeps = {
      startRuntime: startRuntimeMock,
      startServer: startServerMock,
      openBrowser: openBrowserMock,
      getFirmwareConfig: vi.fn().mockReturnValue({}),
      // Sprint 021 ticket 003: main() now writes/removes daemon.json
      // via these -- faked here so no test in this file ever touches
      // the real state directory.
      writeDaemonInfo: vi.fn(),
      removeDaemonInfo: vi.fn(),
      // Sprint 021 ticket 002: main() now calls startConsoleAdvertiser
      // unconditionally once startServer resolves -- faked here (not
      // exercising the real bonjour-service-backed default) so no test
      // in this file ever opens a real multicast socket.
      startConsoleAdvertiser: vi.fn().mockReturnValue({ stop: vi.fn() }),
    };

    await main(["--no-open"], {} as NodeJS.ProcessEnv, deps);

    expect(openBrowserMock).not.toHaveBeenCalled();

    logSpy.mockRestore();
  });

  it("ROBOT_CONSOLE_NO_OPEN (any non-empty value) skips the browser launch the same way --no-open does", async () => {
    const startRuntimeMock = vi.fn().mockReturnValue({ store: {}, reconciler: {}, telemetry: {}, stop: vi.fn() });
    const startServerMock = vi.fn().mockResolvedValue({ url: "http://127.0.0.1:4795", close: vi.fn().mockResolvedValue(undefined) });
    const openBrowserMock = vi.fn().mockResolvedValue(undefined);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const deps: CliDeps = {
      startRuntime: startRuntimeMock,
      startServer: startServerMock,
      openBrowser: openBrowserMock,
      getFirmwareConfig: vi.fn().mockReturnValue({}),
      // Sprint 021 ticket 003: main() now writes/removes daemon.json
      // via these -- faked here so no test in this file ever touches
      // the real state directory.
      writeDaemonInfo: vi.fn(),
      removeDaemonInfo: vi.fn(),
      // Sprint 021 ticket 002: main() now calls startConsoleAdvertiser
      // unconditionally once startServer resolves -- faked here (not
      // exercising the real bonjour-service-backed default) so no test
      // in this file ever opens a real multicast socket.
      startConsoleAdvertiser: vi.fn().mockReturnValue({ stop: vi.fn() }),
    };

    await main([], { ROBOT_CONSOLE_NO_OPEN: "1" } as unknown as NodeJS.ProcessEnv, deps);

    expect(openBrowserMock).not.toHaveBeenCalled();

    logSpy.mockRestore();
  });

  it("018-010: without --sweep/ROBOT_CONSOLE_ENABLE_SWEEP, disableSweep is true -- the sweeper is off by default", async () => {
    const startRuntimeMock = vi.fn().mockReturnValue({ store: {}, reconciler: {}, telemetry: {}, stop: vi.fn() });
    const startServerMock = vi.fn().mockResolvedValue({ url: "http://127.0.0.1:4795", close: vi.fn().mockResolvedValue(undefined) });
    const openBrowserMock = vi.fn().mockResolvedValue(undefined);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const deps: CliDeps = {
      startRuntime: startRuntimeMock,
      startServer: startServerMock,
      openBrowser: openBrowserMock,
      getFirmwareConfig: vi.fn().mockReturnValue({}),
      // Sprint 021 ticket 003: main() now writes/removes daemon.json
      // via these -- faked here so no test in this file ever touches
      // the real state directory.
      writeDaemonInfo: vi.fn(),
      removeDaemonInfo: vi.fn(),
      // Sprint 021 ticket 002: main() now calls startConsoleAdvertiser
      // unconditionally once startServer resolves -- faked here (not
      // exercising the real bonjour-service-backed default) so no test
      // in this file ever opens a real multicast socket.
      startConsoleAdvertiser: vi.fn().mockReturnValue({ stop: vi.fn() }),
    };

    await main([], {} as NodeJS.ProcessEnv, deps);

    expect(startRuntimeMock).toHaveBeenCalledWith(expect.objectContaining({ disableSweep: true }));

    logSpy.mockRestore();
  });

  it("018-010: --sweep passes disableSweep: false to startRuntime -- the explicit opt back in", async () => {
    const startRuntimeMock = vi.fn().mockReturnValue({ store: {}, reconciler: {}, telemetry: {}, stop: vi.fn() });
    const startServerMock = vi.fn().mockResolvedValue({ url: "http://127.0.0.1:4795", close: vi.fn().mockResolvedValue(undefined) });
    const openBrowserMock = vi.fn().mockResolvedValue(undefined);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const deps: CliDeps = {
      startRuntime: startRuntimeMock,
      startServer: startServerMock,
      openBrowser: openBrowserMock,
      getFirmwareConfig: vi.fn().mockReturnValue({}),
      // Sprint 021 ticket 003: main() now writes/removes daemon.json
      // via these -- faked here so no test in this file ever touches
      // the real state directory.
      writeDaemonInfo: vi.fn(),
      removeDaemonInfo: vi.fn(),
      // Sprint 021 ticket 002: main() now calls startConsoleAdvertiser
      // unconditionally once startServer resolves -- faked here (not
      // exercising the real bonjour-service-backed default) so no test
      // in this file ever opens a real multicast socket.
      startConsoleAdvertiser: vi.fn().mockReturnValue({ stop: vi.fn() }),
    };

    await main(["--sweep"], {} as NodeJS.ProcessEnv, deps);

    expect(startRuntimeMock).toHaveBeenCalledWith(expect.objectContaining({ disableSweep: false }));

    logSpy.mockRestore();
  });

  it("018-010: ROBOT_CONSOLE_ENABLE_SWEEP (any non-empty value) passes disableSweep: false the same way --sweep does", async () => {
    const startRuntimeMock = vi.fn().mockReturnValue({ store: {}, reconciler: {}, telemetry: {}, stop: vi.fn() });
    const startServerMock = vi.fn().mockResolvedValue({ url: "http://127.0.0.1:4795", close: vi.fn().mockResolvedValue(undefined) });
    const openBrowserMock = vi.fn().mockResolvedValue(undefined);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const deps: CliDeps = {
      startRuntime: startRuntimeMock,
      startServer: startServerMock,
      openBrowser: openBrowserMock,
      getFirmwareConfig: vi.fn().mockReturnValue({}),
      // Sprint 021 ticket 003: main() now writes/removes daemon.json
      // via these -- faked here so no test in this file ever touches
      // the real state directory.
      writeDaemonInfo: vi.fn(),
      removeDaemonInfo: vi.fn(),
      // Sprint 021 ticket 002: main() now calls startConsoleAdvertiser
      // unconditionally once startServer resolves -- faked here (not
      // exercising the real bonjour-service-backed default) so no test
      // in this file ever opens a real multicast socket.
      startConsoleAdvertiser: vi.fn().mockReturnValue({ stop: vi.fn() }),
    };

    await main([], { ROBOT_CONSOLE_ENABLE_SWEEP: "1" } as unknown as NodeJS.ProcessEnv, deps);

    expect(startRuntimeMock).toHaveBeenCalledWith(expect.objectContaining({ disableSweep: false }));

    logSpy.mockRestore();
  });

  it("018-010: --no-sweep / ROBOT_CONSOLE_DISABLE_SWEEP are accepted as a silent no-op for compatibility -- disableSweep is still true (already the default) either way", async () => {
    const startRuntimeMock = vi.fn().mockReturnValue({ store: {}, reconciler: {}, telemetry: {}, stop: vi.fn() });
    const startServerMock = vi.fn().mockResolvedValue({ url: "http://127.0.0.1:4795", close: vi.fn().mockResolvedValue(undefined) });
    const openBrowserMock = vi.fn().mockResolvedValue(undefined);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const deps: CliDeps = {
      startRuntime: startRuntimeMock,
      startServer: startServerMock,
      openBrowser: openBrowserMock,
      getFirmwareConfig: vi.fn().mockReturnValue({}),
      // Sprint 021 ticket 003: main() now writes/removes daemon.json
      // via these -- faked here so no test in this file ever touches
      // the real state directory.
      writeDaemonInfo: vi.fn(),
      removeDaemonInfo: vi.fn(),
      // Sprint 021 ticket 002: main() now calls startConsoleAdvertiser
      // unconditionally once startServer resolves -- faked here (not
      // exercising the real bonjour-service-backed default) so no test
      // in this file ever opens a real multicast socket.
      startConsoleAdvertiser: vi.fn().mockReturnValue({ stop: vi.fn() }),
    };

    await main(["--no-sweep"], { ROBOT_CONSOLE_DISABLE_SWEEP: "1" } as unknown as NodeJS.ProcessEnv, deps);

    expect(startRuntimeMock).toHaveBeenCalledWith(expect.objectContaining({ disableSweep: true }));

    logSpy.mockRestore();
  });

  // Team-lead decision, replay-guide.md §4: ROBOT_CONSOLE_MDNS_LEGACY
  // re-enables listed legacy mDNS types by removing them from
  // runtime.ts's own default disabled set.
  it("ROBOT_CONSOLE_MDNS_LEGACY re-enables the listed legacy mDNS types, leaving the rest disabled", async () => {
    const startRuntimeMock = vi.fn().mockReturnValue({ store: {}, reconciler: {}, telemetry: {}, stop: vi.fn() });
    const startServerMock = vi.fn().mockResolvedValue({ url: "http://127.0.0.1:4795", close: vi.fn().mockResolvedValue(undefined) });
    const openBrowserMock = vi.fn().mockResolvedValue(undefined);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const deps: CliDeps = {
      startRuntime: startRuntimeMock,
      startServer: startServerMock,
      openBrowser: openBrowserMock,
      getFirmwareConfig: vi.fn().mockReturnValue({}),
      writeDaemonInfo: vi.fn(),
      removeDaemonInfo: vi.fn(),
      startConsoleAdvertiser: vi.fn().mockReturnValue({ stop: vi.fn() }),
    };

    await main([], { ROBOT_CONSOLE_MDNS_LEGACY: "mbserial, mbrelay" } as unknown as NodeJS.ProcessEnv, deps);

    expect(startRuntimeMock).toHaveBeenCalledWith(
      expect.objectContaining({ mdnsWatcherOptions: { disabledTypes: ["mbflash"] } }),
    );

    logSpy.mockRestore();
  });

  it("omits mdnsWatcherOptions entirely when ROBOT_CONSOLE_MDNS_LEGACY is unset -- runtime.ts's own default is untouched", async () => {
    const startRuntimeMock = vi.fn().mockReturnValue({ store: {}, reconciler: {}, telemetry: {}, stop: vi.fn() });
    const startServerMock = vi.fn().mockResolvedValue({ url: "http://127.0.0.1:4795", close: vi.fn().mockResolvedValue(undefined) });
    const openBrowserMock = vi.fn().mockResolvedValue(undefined);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const deps: CliDeps = {
      startRuntime: startRuntimeMock,
      startServer: startServerMock,
      openBrowser: openBrowserMock,
      getFirmwareConfig: vi.fn().mockReturnValue({}),
      writeDaemonInfo: vi.fn(),
      removeDaemonInfo: vi.fn(),
      startConsoleAdvertiser: vi.fn().mockReturnValue({ stop: vi.fn() }),
    };

    await main([], {} as NodeJS.ProcessEnv, deps);

    const call = startRuntimeMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(call).not.toHaveProperty("mdnsWatcherOptions");

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
      // Sprint 021 ticket 003: main() now writes/removes daemon.json
      // via these -- faked here so no test in this file ever touches
      // the real state directory.
      writeDaemonInfo: vi.fn(),
      removeDaemonInfo: vi.fn(),
      // Sprint 021 ticket 002: main() now calls startConsoleAdvertiser
      // unconditionally once startServer resolves -- faked here (not
      // exercising the real bonjour-service-backed default) so no test
      // in this file ever opens a real multicast socket.
      startConsoleAdvertiser: vi.fn().mockReturnValue({ stop: vi.fn() }),
    };

    await expect(main([], {} as NodeJS.ProcessEnv, deps)).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("no display"));

    logSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it("default opener (no deps.openBrowser override) passes the Chrome app option to `open`", async () => {
    const startRuntimeMock = vi.fn().mockReturnValue({ store: {}, reconciler: {}, telemetry: {}, stop: vi.fn() });
    const startServerMock = vi.fn().mockResolvedValue({ url: "http://127.0.0.1:4795", close: vi.fn().mockResolvedValue(undefined) });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    openMock.mockClear();

    const deps: CliDeps = {
      startRuntime: startRuntimeMock,
      startServer: startServerMock,
      getFirmwareConfig: vi.fn().mockReturnValue({}),
      // Sprint 021 ticket 003: main() now writes/removes daemon.json
      // via these -- faked here so no test in this file ever touches
      // the real state directory.
      writeDaemonInfo: vi.fn(),
      removeDaemonInfo: vi.fn(),
      startConsoleAdvertiser: vi.fn().mockReturnValue({ stop: vi.fn() }),
      // openBrowser deliberately omitted -- this exercises the real
      // default (`openInChrome`), not a test fake.
    };

    await main([], {} as NodeJS.ProcessEnv, deps);

    expect(openMock).toHaveBeenCalledWith("http://127.0.0.1:4795", { app: { name: "google chrome" } });

    logSpy.mockRestore();
  });

  it("default opener falls back to the plain default browser, and warns once, when Chrome is not found", async () => {
    const startRuntimeMock = vi.fn().mockReturnValue({ store: {}, reconciler: {}, telemetry: {}, stop: vi.fn() });
    const startServerMock = vi.fn().mockResolvedValue({ url: "http://127.0.0.1:4795", close: vi.fn().mockResolvedValue(undefined) });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    openMock.mockClear();
    openMock.mockRejectedValueOnce(new Error("Chrome not installed")).mockResolvedValueOnce(undefined);

    const deps: CliDeps = {
      startRuntime: startRuntimeMock,
      startServer: startServerMock,
      getFirmwareConfig: vi.fn().mockReturnValue({}),
      // Sprint 021 ticket 003: main() now writes/removes daemon.json
      // via these -- faked here so no test in this file ever touches
      // the real state directory.
      writeDaemonInfo: vi.fn(),
      removeDaemonInfo: vi.fn(),
      // Sprint 021 ticket 002: main() now calls startConsoleAdvertiser
      // unconditionally once startServer resolves -- faked here (not
      // exercising the real bonjour-service-backed default) so no test
      // in this file ever opens a real multicast socket.
      startConsoleAdvertiser: vi.fn().mockReturnValue({ stop: vi.fn() }),
    };

    await main([], {} as NodeJS.ProcessEnv, deps);

    expect(openMock).toHaveBeenNthCalledWith(1, "http://127.0.0.1:4795", { app: { name: "google chrome" } });
    expect(openMock).toHaveBeenNthCalledWith(2, "http://127.0.0.1:4795");
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Chrome not installed"));

    logSpy.mockRestore();
    warnSpy.mockRestore();
  });
});

describe("cli: main -- MCP server wiring (sprint 019 ticket 004)", () => {
  // main() unconditionally calls installShutdownHandlers, which
  // registers real process-level SIGINT/SIGTERM listeners -- cleaned up
  // here exactly like every other describe block in this file that
  // calls main(), so a listener left over from one of these tests can
  // never fire during (and spuriously fail) a later describe block's own
  // process.emit("SIGINT"/"SIGTERM") (bench finding, this ticket: an
  // earlier version of this suite leaked exactly that).
  afterEach(() => {
    process.removeAllListeners("SIGINT");
    process.removeAllListeners("SIGTERM");
  });

  it("passes a mountRoutes hook to startServer that reaches startMcpServer with the app, runtime.store/reconciler, and the flash extras", async () => {
    const fakeStore = { marker: "fake-store" };
    const fakeReconciler = { marker: "fake-reconciler" };
    const startRuntimeMock = vi.fn().mockReturnValue({ store: fakeStore, reconciler: fakeReconciler, telemetry: {}, stop: vi.fn() });
    const fakeApp = { marker: "fake-express-app" };
    const fakeStartFlash = vi.fn();
    const fakeEnumerateDaplinkDevices = vi.fn();
    // A real startServer would call mountRoutes(app, extra) itself,
    // before its own static/catch-all route registration (server.ts's
    // own doc comment on that hook) -- faked here to invoke it the same
    // way, without needing a real Express app or HTTP port. `extra`
    // mirrors server.ts's own `MountRoutesExtra` (sprint 019 ticket 008):
    // the exact `startFlash`/`enumerateDaplinkDevices` a real
    // `startServer` would hand down.
    const startServerMock = vi.fn().mockImplementation(
      async (options: { mountRoutes?: (app: unknown, extra: { startFlash: unknown; enumerateDaplinkDevices: unknown }) => void }) => {
        options.mountRoutes?.(fakeApp, { startFlash: fakeStartFlash, enumerateDaplinkDevices: fakeEnumerateDaplinkDevices });
        return { url: "http://127.0.0.1:4795", close: vi.fn().mockResolvedValue(undefined) };
      },
    );
    const startMcpServerMock = vi.fn().mockReturnValue({ path: "/mcp" });
    const openBrowserMock = vi.fn().mockResolvedValue(undefined);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const deps: CliDeps = {
      startRuntime: startRuntimeMock,
      startServer: startServerMock,
      startMcpServer: startMcpServerMock,
      openBrowser: openBrowserMock,
      getFirmwareConfig: vi.fn().mockReturnValue({}),
      // Sprint 021 ticket 003: main() now writes/removes daemon.json
      // via these -- faked here so no test in this file ever touches
      // the real state directory.
      writeDaemonInfo: vi.fn(),
      removeDaemonInfo: vi.fn(),
      // Sprint 021 ticket 002: main() now calls startConsoleAdvertiser
      // unconditionally once startServer resolves -- faked here (not
      // exercising the real bonjour-service-backed default) so no test
      // in this file ever opens a real multicast socket.
      startConsoleAdvertiser: vi.fn().mockReturnValue({ stop: vi.fn() }),
    };

    await main([], {} as NodeJS.ProcessEnv, deps);

    expect(startMcpServerMock).toHaveBeenCalledWith(fakeApp, {
      store: fakeStore,
      reconciler: fakeReconciler,
      startFlash: fakeStartFlash,
      enumerateDaplinkDevices: fakeEnumerateDaplinkDevices,
    });

    logSpy.mockRestore();
  });

  it("defaults to the real startMcpServer when deps.startMcpServer is not overridden -- main() still composes without it throwing", async () => {
    // Exercises the real default wiring path (deps.startMcpServer
    // omitted): startServer itself is still faked, and its fake never
    // calls the mountRoutes hook, so the real startMcpServer is never
    // actually invoked here -- this only proves main() does not fail to
    // resolve the real default when no override is given.
    const startRuntimeMock = vi.fn().mockReturnValue({ store: {}, reconciler: {}, telemetry: {}, stop: vi.fn() });
    const startServerMock = vi.fn().mockResolvedValue({ url: "http://127.0.0.1:4795", close: vi.fn().mockResolvedValue(undefined) });
    const openBrowserMock = vi.fn().mockResolvedValue(undefined);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(
      main([], {} as NodeJS.ProcessEnv, {
        startRuntime: startRuntimeMock,
        startServer: startServerMock,
        openBrowser: openBrowserMock,
        getFirmwareConfig: vi.fn().mockReturnValue({}),
      // Sprint 021 ticket 003: main() now writes/removes daemon.json
      // via these -- faked here so no test in this file ever touches
      // the real state directory.
      writeDaemonInfo: vi.fn(),
      removeDaemonInfo: vi.fn(),
        startConsoleAdvertiser: vi.fn().mockReturnValue({ stop: vi.fn() }),
      }),
    ).resolves.toBeUndefined();

    logSpy.mockRestore();
  });
});

describe("cli: main -- daemon-info wiring (sprint 021 ticket 003)", () => {
  afterEach(() => {
    process.removeAllListeners("SIGINT");
    process.removeAllListeners("SIGTERM");
  });

  it("writes daemon.json with the actual bound pid/host/port once startServer resolves, for the plain no-subcommand path too", async () => {
    const startRuntimeMock = vi.fn().mockReturnValue({ store: {}, reconciler: {}, telemetry: {}, stop: vi.fn() });
    const startServerMock = vi.fn().mockResolvedValue({ url: "http://0.0.0.0:4795", host: "0.0.0.0", port: 4795, close: vi.fn().mockResolvedValue(undefined) });
    const writeDaemonInfoMock = vi.fn();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const beforeCall = Date.now();

    await main([], {} as NodeJS.ProcessEnv, {
      startRuntime: startRuntimeMock,
      startServer: startServerMock,
      openBrowser: vi.fn().mockResolvedValue(undefined),
      getFirmwareConfig: vi.fn().mockReturnValue({}),
      startConsoleAdvertiser: vi.fn().mockReturnValue({ stop: vi.fn() }),
      writeDaemonInfo: writeDaemonInfoMock,
      removeDaemonInfo: vi.fn(),
    });

    expect(writeDaemonInfoMock).toHaveBeenCalledTimes(1);
    const [info] = writeDaemonInfoMock.mock.calls[0] as [{ pid: number; host: string; port: number; startedAt: number }];
    expect(info.pid).toBe(process.pid);
    expect(info.host).toBe("0.0.0.0");
    expect(info.port).toBe(4795);
    expect(info.startedAt).toBeGreaterThanOrEqual(beforeCall);

    logSpy.mockRestore();
  });

  it("never writes daemon.json on the EADDRINUSE-attach path -- an attaching invocation never bound a port of its own", async () => {
    const conflictError = new PortInUseError("0.0.0.0", 4795);
    const startRuntimeMock = vi.fn().mockReturnValue({ store: {}, reconciler: {}, telemetry: {}, stop: vi.fn() });
    const startServerMock = vi.fn().mockRejectedValueOnce(conflictError);
    const probeHostInfoMock = vi.fn().mockResolvedValue({ ok: true, service: "robot-console", port: 4795 });
    const writeDaemonInfoMock = vi.fn();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(
      main([], {} as NodeJS.ProcessEnv, {
        startRuntime: startRuntimeMock,
        startServer: startServerMock,
        probeHostInfo: probeHostInfoMock,
        openBrowser: vi.fn().mockResolvedValue(undefined),
        getFirmwareConfig: vi.fn().mockReturnValue({}),
        startConsoleAdvertiser: vi.fn().mockReturnValue({ stop: vi.fn() }),
        writeDaemonInfo: writeDaemonInfoMock,
        removeDaemonInfo: vi.fn(),
      }),
    ).resolves.toBeUndefined();

    expect(writeDaemonInfoMock).not.toHaveBeenCalled();

    logSpy.mockRestore();
  });

  it("removes daemon.json during SIGINT/SIGTERM shutdown, after runtime.stop() (session teardown) has resolved", async () => {
    const runtimeStopOrder: string[] = [];
    const runtimeStopMock = vi.fn().mockImplementation(async () => {
      runtimeStopOrder.push("runtime.stop");
    });
    const removeDaemonInfoMock = vi.fn().mockImplementation(() => {
      runtimeStopOrder.push("removeDaemonInfo");
    });
    const startRuntimeMock = vi.fn().mockReturnValue({ store: {}, reconciler: {}, telemetry: {}, stop: runtimeStopMock });
    const startServerMock = vi.fn().mockResolvedValue({ url: "http://0.0.0.0:4795", host: "0.0.0.0", port: 4795, close: vi.fn().mockResolvedValue(undefined) });
    const exitMock = vi.fn();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await main([], {} as NodeJS.ProcessEnv, {
      startRuntime: startRuntimeMock,
      startServer: startServerMock,
      openBrowser: vi.fn().mockResolvedValue(undefined),
      getFirmwareConfig: vi.fn().mockReturnValue({}),
      startConsoleAdvertiser: vi.fn().mockReturnValue({ stop: vi.fn() }),
      writeDaemonInfo: vi.fn(),
      removeDaemonInfo: removeDaemonInfoMock,
      exit: exitMock,
    });

    process.emit("SIGINT");
    await vi.waitFor(() => expect(exitMock).toHaveBeenCalled());

    expect(removeDaemonInfoMock).toHaveBeenCalledTimes(1);
    expect(runtimeStopOrder).toEqual(["runtime.stop", "removeDaemonInfo"]);

    logSpy.mockRestore();
  });
});

describe("cli: main -- console advertiser wiring (sprint 021 ticket 002)", () => {
  afterEach(() => {
    process.removeAllListeners("SIGINT");
    process.removeAllListeners("SIGTERM");
  });

  it("calls startConsoleAdvertiser with the server's actual bound port once startServer resolves", async () => {
    const startRuntimeMock = vi.fn().mockReturnValue({ store: {}, reconciler: {}, telemetry: {}, stop: vi.fn() });
    const startServerMock = vi.fn().mockResolvedValue({ url: "http://0.0.0.0:54219", port: 54219, close: vi.fn().mockResolvedValue(undefined) });
    const startConsoleAdvertiserMock = vi.fn().mockReturnValue({ stop: vi.fn() });
    const openBrowserMock = vi.fn().mockResolvedValue(undefined);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await main([], {} as NodeJS.ProcessEnv, {
      startRuntime: startRuntimeMock,
      startServer: startServerMock,
      openBrowser: openBrowserMock,
      getFirmwareConfig: vi.fn().mockReturnValue({}),
      // Sprint 021 ticket 003: main() now writes/removes daemon.json
      // via these -- faked here so no test in this file ever touches
      // the real state directory.
      writeDaemonInfo: vi.fn(),
      removeDaemonInfo: vi.fn(),
      startConsoleAdvertiser: startConsoleAdvertiserMock,
    });

    expect(startConsoleAdvertiserMock).toHaveBeenCalledTimes(1);
    expect(startConsoleAdvertiserMock).toHaveBeenCalledWith({ port: 54219 });

    logSpy.mockRestore();
  });

  it("never starts an advertiser on the EADDRINUSE-attach path -- an attaching invocation never bound a port of its own", async () => {
    const conflictError = new PortInUseError("0.0.0.0", 4795);
    const startRuntimeMock = vi.fn().mockReturnValue({ store: {}, reconciler: {}, telemetry: {}, stop: vi.fn() });
    const startServerMock = vi.fn().mockRejectedValueOnce(conflictError);
    const probeHostInfoMock = vi.fn().mockResolvedValue({ ok: true, service: "robot-console", port: 4795 });
    const startConsoleAdvertiserMock = vi.fn().mockReturnValue({ stop: vi.fn() });
    const openBrowserMock = vi.fn().mockResolvedValue(undefined);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(
      main([], {} as NodeJS.ProcessEnv, {
        startRuntime: startRuntimeMock,
        startServer: startServerMock,
        probeHostInfo: probeHostInfoMock,
        openBrowser: openBrowserMock,
        getFirmwareConfig: vi.fn().mockReturnValue({}),
      // Sprint 021 ticket 003: main() now writes/removes daemon.json
      // via these -- faked here so no test in this file ever touches
      // the real state directory.
      writeDaemonInfo: vi.fn(),
      removeDaemonInfo: vi.fn(),
        startConsoleAdvertiser: startConsoleAdvertiserMock,
      }),
    ).resolves.toBeUndefined();

    expect(startConsoleAdvertiserMock).not.toHaveBeenCalled();

    logSpy.mockRestore();
  });

  it("shutdown stops the advertiser before closing the server", async () => {
    const runtimeStopMock = vi.fn();
    const serverCloseMock = vi.fn().mockResolvedValue(undefined);
    const advertiserStopMock = vi.fn();
    const startRuntimeMock = vi.fn().mockReturnValue({ store: {}, reconciler: {}, telemetry: {}, stop: runtimeStopMock });
    const startServerMock = vi.fn().mockResolvedValue({ url: "http://0.0.0.0:4795", port: 4795, close: serverCloseMock });
    const startConsoleAdvertiserMock = vi.fn().mockReturnValue({ stop: advertiserStopMock });
    const exitMock = vi.fn();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await main([], {} as NodeJS.ProcessEnv, {
      startRuntime: startRuntimeMock,
      startServer: startServerMock,
      openBrowser: vi.fn().mockResolvedValue(undefined),
      getFirmwareConfig: vi.fn().mockReturnValue({}),
      // Sprint 021 ticket 003: main() now writes/removes daemon.json
      // via these -- faked here so no test in this file ever touches
      // the real state directory.
      writeDaemonInfo: vi.fn(),
      removeDaemonInfo: vi.fn(),
      startConsoleAdvertiser: startConsoleAdvertiserMock,
      exit: exitMock,
    });

    process.emit("SIGINT");
    await vi.waitFor(() => expect(exitMock).toHaveBeenCalled());

    expect(advertiserStopMock).toHaveBeenCalledTimes(1);
    expect(serverCloseMock).toHaveBeenCalledTimes(1);
    const advertiserStopOrder = advertiserStopMock.mock.invocationCallOrder[0];
    const closeOrder = serverCloseMock.mock.invocationCallOrder[0];
    expect(advertiserStopOrder).toBeLessThan(closeOrder);

    logSpy.mockRestore();
  });
});

describe("cli: main -- EADDRINUSE attach vs hard-fail (021-001)", () => {
  afterEach(() => {
    process.removeAllListeners("SIGINT");
    process.removeAllListeners("SIGTERM");
  });

  it("an explicit --port conflict rethrows today's exact message, unchanged -- no probe is even attempted", async () => {
    const conflictError = new PortInUseError("127.0.0.1", 9999);
    const runtimeStopMock = vi.fn();
    const startRuntimeMock = vi.fn().mockReturnValue({ store: {}, reconciler: {}, telemetry: {}, stop: runtimeStopMock });
    const startServerMock = vi.fn().mockRejectedValue(conflictError);
    const probeHostInfoMock = vi.fn();
    const openBrowserMock = vi.fn().mockResolvedValue(undefined);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const deps: CliDeps = {
      startRuntime: startRuntimeMock,
      startServer: startServerMock,
      probeHostInfo: probeHostInfoMock,
      openBrowser: openBrowserMock,
      getFirmwareConfig: vi.fn().mockReturnValue({}),
      // Sprint 021 ticket 003: main() now writes/removes daemon.json
      // via these -- faked here so no test in this file ever touches
      // the real state directory.
      writeDaemonInfo: vi.fn(),
      removeDaemonInfo: vi.fn(),
      // Sprint 021 ticket 002: main() now calls startConsoleAdvertiser
      // unconditionally once startServer resolves -- faked here (not
      // exercising the real bonjour-service-backed default) so no test
      // in this file ever opens a real multicast socket.
      startConsoleAdvertiser: vi.fn().mockReturnValue({ stop: vi.fn() }),
    };

    await expect(main(["--port", "9999"], {} as NodeJS.ProcessEnv, deps)).rejects.toThrow(conflictError.message);
    // Regression: the explicit-port branch never even considers
    // attaching -- no probe, no runtime.stop() of this invocation's own
    // (never-bound) runtime.
    expect(probeHostInfoMock).not.toHaveBeenCalled();
    expect(runtimeStopMock).not.toHaveBeenCalled();

    logSpy.mockRestore();
  });

  it("no --port, a positive host-info probe: logs attaching, stops this invocation's own runtime, and returns without throwing or starting a second server", async () => {
    const conflictError = new PortInUseError("127.0.0.1", 4795);
    const runtimeStopMock = vi.fn();
    const startRuntimeMock = vi.fn().mockReturnValue({ store: {}, reconciler: {}, telemetry: {}, stop: runtimeStopMock });
    const startServerMock = vi.fn().mockRejectedValueOnce(conflictError);
    const probeHostInfoMock = vi.fn().mockResolvedValue({ ok: true, service: "robot-console", port: 4795 });
    const openBrowserMock = vi.fn().mockResolvedValue(undefined);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const deps: CliDeps = {
      startRuntime: startRuntimeMock,
      startServer: startServerMock,
      probeHostInfo: probeHostInfoMock,
      openBrowser: openBrowserMock,
      getFirmwareConfig: vi.fn().mockReturnValue({}),
      // Sprint 021 ticket 003: main() now writes/removes daemon.json
      // via these -- faked here so no test in this file ever touches
      // the real state directory.
      writeDaemonInfo: vi.fn(),
      removeDaemonInfo: vi.fn(),
      // Sprint 021 ticket 002: main() now calls startConsoleAdvertiser
      // unconditionally once startServer resolves -- faked here (not
      // exercising the real bonjour-service-backed default) so no test
      // in this file ever opens a real multicast socket.
      startConsoleAdvertiser: vi.fn().mockReturnValue({ stop: vi.fn() }),
    };

    await expect(main([], {} as NodeJS.ProcessEnv, deps)).resolves.toBeUndefined();

    expect(probeHostInfoMock).toHaveBeenCalledWith("http://127.0.0.1:4795/api/host-info");
    expect(startRuntimeMock).toHaveBeenCalledTimes(1);
    expect(startServerMock).toHaveBeenCalledTimes(1);
    // Attaching must not double-construct a runtime or retry startServer.
    expect(runtimeStopMock).toHaveBeenCalledTimes(1);
    expect(openBrowserMock).toHaveBeenCalledWith("http://127.0.0.1:4795");
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("already running"));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("attaching"));

    logSpy.mockRestore();
  });

  it("--no-open is respected on the attach path too -- no browser is opened", async () => {
    const conflictError = new PortInUseError("127.0.0.1", 4795);
    const startRuntimeMock = vi.fn().mockReturnValue({ store: {}, reconciler: {}, telemetry: {}, stop: vi.fn() });
    const startServerMock = vi.fn().mockRejectedValueOnce(conflictError);
    const probeHostInfoMock = vi.fn().mockResolvedValue({ ok: true, service: "robot-console", port: 4795 });
    const openBrowserMock = vi.fn().mockResolvedValue(undefined);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const deps: CliDeps = {
      startRuntime: startRuntimeMock,
      startServer: startServerMock,
      probeHostInfo: probeHostInfoMock,
      openBrowser: openBrowserMock,
      getFirmwareConfig: vi.fn().mockReturnValue({}),
      // Sprint 021 ticket 003: main() now writes/removes daemon.json
      // via these -- faked here so no test in this file ever touches
      // the real state directory.
      writeDaemonInfo: vi.fn(),
      removeDaemonInfo: vi.fn(),
      // Sprint 021 ticket 002: main() now calls startConsoleAdvertiser
      // unconditionally once startServer resolves -- faked here (not
      // exercising the real bonjour-service-backed default) so no test
      // in this file ever opens a real multicast socket.
      startConsoleAdvertiser: vi.fn().mockReturnValue({ stop: vi.fn() }),
    };

    await expect(main(["--no-open"], {} as NodeJS.ProcessEnv, deps)).resolves.toBeUndefined();
    expect(openBrowserMock).not.toHaveBeenCalled();

    logSpy.mockRestore();
  });

  it("no --port, the probe fails/times out (resolves undefined): rethrows a clear conflict error, not a false 'already running'", async () => {
    const conflictError = new PortInUseError("127.0.0.1", 4795);
    const runtimeStopMock = vi.fn();
    const startRuntimeMock = vi.fn().mockReturnValue({ store: {}, reconciler: {}, telemetry: {}, stop: runtimeStopMock });
    const startServerMock = vi.fn().mockRejectedValue(conflictError);
    const probeHostInfoMock = vi.fn().mockResolvedValue(undefined);
    const openBrowserMock = vi.fn().mockResolvedValue(undefined);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const deps: CliDeps = {
      startRuntime: startRuntimeMock,
      startServer: startServerMock,
      probeHostInfo: probeHostInfoMock,
      openBrowser: openBrowserMock,
      getFirmwareConfig: vi.fn().mockReturnValue({}),
      // Sprint 021 ticket 003: main() now writes/removes daemon.json
      // via these -- faked here so no test in this file ever touches
      // the real state directory.
      writeDaemonInfo: vi.fn(),
      removeDaemonInfo: vi.fn(),
      // Sprint 021 ticket 002: main() now calls startConsoleAdvertiser
      // unconditionally once startServer resolves -- faked here (not
      // exercising the real bonjour-service-backed default) so no test
      // in this file ever opens a real multicast socket.
      startConsoleAdvertiser: vi.fn().mockReturnValue({ stop: vi.fn() }),
    };

    await expect(main([], {} as NodeJS.ProcessEnv, deps)).rejects.toThrow(conflictError.message);
    expect(probeHostInfoMock).toHaveBeenCalledWith("http://127.0.0.1:4795/api/host-info");
    expect(runtimeStopMock).not.toHaveBeenCalled();

    logSpy.mockRestore();
  });

  it("no --port, the probe answers but does not identify as robot-console: rethrows the conflict error too", async () => {
    const conflictError = new PortInUseError("127.0.0.1", 4795);
    const startRuntimeMock = vi.fn().mockReturnValue({ store: {}, reconciler: {}, telemetry: {}, stop: vi.fn() });
    const startServerMock = vi.fn().mockRejectedValue(conflictError);
    const probeHostInfoMock = vi.fn().mockResolvedValue({ ok: true, service: "some-other-thing" });
    const openBrowserMock = vi.fn().mockResolvedValue(undefined);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const deps: CliDeps = {
      startRuntime: startRuntimeMock,
      startServer: startServerMock,
      probeHostInfo: probeHostInfoMock,
      openBrowser: openBrowserMock,
      getFirmwareConfig: vi.fn().mockReturnValue({}),
      // Sprint 021 ticket 003: main() now writes/removes daemon.json
      // via these -- faked here so no test in this file ever touches
      // the real state directory.
      writeDaemonInfo: vi.fn(),
      removeDaemonInfo: vi.fn(),
      // Sprint 021 ticket 002: main() now calls startConsoleAdvertiser
      // unconditionally once startServer resolves -- faked here (not
      // exercising the real bonjour-service-backed default) so no test
      // in this file ever opens a real multicast socket.
      startConsoleAdvertiser: vi.fn().mockReturnValue({ stop: vi.fn() }),
    };

    await expect(main([], {} as NodeJS.ProcessEnv, deps)).rejects.toThrow(conflictError.message);

    logSpy.mockRestore();
  });

  it("a non-PortInUseError failure from startServer still propagates unchanged", async () => {
    const otherError = new Error("some unrelated startup failure");
    const startRuntimeMock = vi.fn().mockReturnValue({ store: {}, reconciler: {}, telemetry: {}, stop: vi.fn() });
    const startServerMock = vi.fn().mockRejectedValue(otherError);
    const probeHostInfoMock = vi.fn();
    const openBrowserMock = vi.fn().mockResolvedValue(undefined);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const deps: CliDeps = {
      startRuntime: startRuntimeMock,
      startServer: startServerMock,
      probeHostInfo: probeHostInfoMock,
      openBrowser: openBrowserMock,
      getFirmwareConfig: vi.fn().mockReturnValue({}),
      // Sprint 021 ticket 003: main() now writes/removes daemon.json
      // via these -- faked here so no test in this file ever touches
      // the real state directory.
      writeDaemonInfo: vi.fn(),
      removeDaemonInfo: vi.fn(),
      // Sprint 021 ticket 002: main() now calls startConsoleAdvertiser
      // unconditionally once startServer resolves -- faked here (not
      // exercising the real bonjour-service-backed default) so no test
      // in this file ever opens a real multicast socket.
      startConsoleAdvertiser: vi.fn().mockReturnValue({ stop: vi.fn() }),
    };

    await expect(main([], {} as NodeJS.ProcessEnv, deps)).rejects.toThrow(otherError.message);
    expect(probeHostInfoMock).not.toHaveBeenCalled();

    logSpy.mockRestore();
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
      // Sprint 021 ticket 003: main() now writes/removes daemon.json
      // via these -- faked here so no test in this file ever touches
      // the real state directory.
      writeDaemonInfo: vi.fn(),
      removeDaemonInfo: vi.fn(),
      startConsoleAdvertiser: vi.fn().mockReturnValue({ stop: vi.fn() }),
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
      // Sprint 021 ticket 003: main() now writes/removes daemon.json
      // via these -- faked here so no test in this file ever touches
      // the real state directory.
      writeDaemonInfo: vi.fn(),
      removeDaemonInfo: vi.fn(),
      startConsoleAdvertiser: vi.fn().mockReturnValue({ stop: vi.fn() }),
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
      // Sprint 021 ticket 003: main() now writes/removes daemon.json
      // via these -- faked here so no test in this file ever touches
      // the real state directory.
      writeDaemonInfo: vi.fn(),
      removeDaemonInfo: vi.fn(),
      startConsoleAdvertiser: vi.fn().mockReturnValue({ stop: vi.fn() }),
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
      // Sprint 021 ticket 003: main() now writes/removes daemon.json
      // via these -- faked here so no test in this file ever touches
      // the real state directory.
      writeDaemonInfo: vi.fn(),
      removeDaemonInfo: vi.fn(),
      startConsoleAdvertiser: vi.fn().mockReturnValue({ stop: vi.fn() }),
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
