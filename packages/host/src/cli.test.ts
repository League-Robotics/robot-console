/**
 * cli.test.ts — flag parsing and wiring for `--dump-store`/`--watch-store`
 * (ticket 014-009), plus a sanity check that the pre-existing
 * no-flags path still starts the server. Every collaborator is a
 * `CliDeps` fake -- the same "real defaults, fakes in tests" seam every
 * other module in this package uses -- so no real store, watchers,
 * ports, or browser are ever touched here, per this ticket's own
 * testing instruction ("do not open real ports in tests").
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { main, type CliDeps } from "./cli.js";
import type { StoreSnapshot } from "./store/index.js";

const EMPTY_SNAPSHOT: StoreSnapshot = { devices: [], links: [], services: [], sessions: [], tasks: [] };

describe("cli: main -- --dump-store", () => {
  it("prints the formatted snapshot and touches no other collaborator", async () => {
    const dumpStoreMock = vi.fn().mockReturnValue(EMPTY_SNAPSHOT);
    const formatStoreDumpMock = vi.fn().mockReturnValue("FORMATTED-DUMP");
    const openStoreMock = vi.fn();
    const startServerMock = vi.fn();
    const openBrowserMock = vi.fn().mockResolvedValue(undefined);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const deps: CliDeps = {
      dumpStore: dumpStoreMock,
      formatStoreDump: formatStoreDumpMock,
      openStore: openStoreMock,
      startServer: startServerMock,
      openBrowser: openBrowserMock,
    };
    const env = { SOME: "env" } as unknown as NodeJS.ProcessEnv;

    await main(["--dump-store"], env, deps);

    expect(dumpStoreMock).toHaveBeenCalledWith({ env });
    expect(formatStoreDumpMock).toHaveBeenCalledWith(EMPTY_SNAPSHOT);
    expect(logSpy).toHaveBeenCalledWith("FORMATTED-DUMP");
    expect(openStoreMock).not.toHaveBeenCalled();
    expect(startServerMock).not.toHaveBeenCalled();
    expect(openBrowserMock).not.toHaveBeenCalled();

    logSpy.mockRestore();
  });
});

describe("cli: main -- --watch-store", () => {
  afterEach(() => {
    // Defensive: a failed assertion before the SIGINT/SIGTERM emit below
    // must not leave a real listener registered against the shared
    // `process` object for later tests/files.
    process.removeAllListeners("SIGINT");
    process.removeAllListeners("SIGTERM");
  });

  function fakeStoreDeps() {
    const changeListeners: Array<(changes: unknown) => void> = [];
    const unsubscribeMock = vi.fn();
    const closeMock = vi.fn();
    const fakeStore = {
      onChange: vi.fn((listener: (changes: unknown) => void) => {
        changeListeners.push(listener);
        return unsubscribeMock;
      }),
      close: closeMock,
    };
    const openStoreMock = vi.fn().mockReturnValue(fakeStore);

    const usbStopMock = vi.fn();
    const startUsbWatcherMock = vi.fn().mockReturnValue({ stop: usbStopMock });
    const mdnsStopMock = vi.fn();
    const startMdnsWatcherMock = vi.fn().mockReturnValue({ stop: mdnsStopMock });
    // Only `find` matters here -- `startMdnsWatcher` itself is faked
    // below, so this backend is never actually driven, only asserted
    // to have been passed through unchanged.
    const fakeBackend = { find: vi.fn() };
    const createBonjourBackendMock = vi.fn(() => fakeBackend) as unknown as CliDeps["createBonjourBackend"];
    const startServerMock = vi.fn();
    const openBrowserMock = vi.fn().mockResolvedValue(undefined);

    const deps: CliDeps = {
      // Fakes only implement the members `runWatchStore` actually calls
      // (onChange/close, stop()) -- narrower than the real `Store`/
      // `UsbWatcherHandle`/`MdnsWatcherHandle` shapes, hence the cast.
      openStore: openStoreMock as unknown as CliDeps["openStore"],
      startUsbWatcher: startUsbWatcherMock as unknown as CliDeps["startUsbWatcher"],
      startMdnsWatcher: startMdnsWatcherMock as unknown as CliDeps["startMdnsWatcher"],
      createBonjourBackend: createBonjourBackendMock,
      startServer: startServerMock,
      openBrowser: openBrowserMock,
    };

    return {
      deps,
      changeListeners,
      unsubscribeMock,
      closeMock,
      usbStopMock,
      mdnsStopMock,
      openStoreMock,
      startUsbWatcherMock,
      startMdnsWatcherMock,
      createBonjourBackendMock,
      startServerMock,
      openBrowserMock,
      fakeStore,
      fakeBackend,
    };
  }

  it("opens the store, starts both watchers, logs changes, and stops cleanly on SIGINT", async () => {
    const f = fakeStoreDeps();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const env = {} as NodeJS.ProcessEnv;

    const mainPromise = main(["--watch-store"], env, f.deps);

    // Let the synchronous setup inside runWatchStore run before
    // asserting on it and before sending the stop signal.
    await Promise.resolve();
    await Promise.resolve();

    expect(f.openStoreMock).toHaveBeenCalledWith({ env });
    expect(f.startUsbWatcherMock).toHaveBeenCalledWith(f.fakeStore);
    expect(f.startMdnsWatcherMock).toHaveBeenCalledWith(f.fakeStore, { backend: f.fakeBackend });
    expect(f.startServerMock).not.toHaveBeenCalled();
    expect(f.openBrowserMock).not.toHaveBeenCalled();

    // Change events log as one JSON line each.
    expect(f.changeListeners).toHaveLength(1);
    f.changeListeners[0]?.([{ seq: 1, tbl: "devices", key: "1" }]);
    expect(logSpy).toHaveBeenCalledWith(
      JSON.stringify({ type: "change", changes: [{ seq: 1, tbl: "devices", key: "1" }] }),
    );

    process.emit("SIGINT");
    await mainPromise;

    expect(f.usbStopMock).toHaveBeenCalledTimes(1);
    expect(f.mdnsStopMock).toHaveBeenCalledTimes(1);
    expect(f.unsubscribeMock).toHaveBeenCalledTimes(1);
    expect(f.closeMock).toHaveBeenCalledTimes(1);

    logSpy.mockRestore();
  });

  it("stops cleanly on SIGTERM too", async () => {
    const f = fakeStoreDeps();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const mainPromise = main(["--watch-store"], {} as NodeJS.ProcessEnv, f.deps);
    await Promise.resolve();
    await Promise.resolve();

    process.emit("SIGTERM");
    await mainPromise;

    expect(f.usbStopMock).toHaveBeenCalledTimes(1);
    expect(f.closeMock).toHaveBeenCalledTimes(1);

    logSpy.mockRestore();
  });

  it("is idempotent if both SIGINT and SIGTERM somehow arrive -- stop() calls are not doubled", async () => {
    const f = fakeStoreDeps();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const mainPromise = main(["--watch-store"], {} as NodeJS.ProcessEnv, f.deps);
    await Promise.resolve();
    await Promise.resolve();

    process.emit("SIGINT");
    process.emit("SIGTERM");
    await mainPromise;

    expect(f.usbStopMock).toHaveBeenCalledTimes(1);
    expect(f.closeMock).toHaveBeenCalledTimes(1);

    logSpy.mockRestore();
  });
});

describe("cli: main -- no debug flags", () => {
  it("starts the server and opens a browser, untouched by the debug flags' wiring", async () => {
    const startServerMock = vi.fn().mockResolvedValue({ url: "http://127.0.0.1:4795" });
    const openBrowserMock = vi.fn().mockResolvedValue(undefined);
    const dumpStoreMock = vi.fn();
    const openStoreMock = vi.fn();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const deps: CliDeps = {
      startServer: startServerMock,
      openBrowser: openBrowserMock,
      dumpStore: dumpStoreMock,
      openStore: openStoreMock,
      getFirmwareConfig: vi.fn().mockReturnValue({}),
    };

    await main([], {} as NodeJS.ProcessEnv, deps);

    expect(startServerMock).toHaveBeenCalledTimes(1);
    expect(openBrowserMock).toHaveBeenCalledWith("http://127.0.0.1:4795");
    expect(dumpStoreMock).not.toHaveBeenCalled();
    expect(openStoreMock).not.toHaveBeenCalled();

    logSpy.mockRestore();
  });

  it("resolves --port/ROBOT_CONSOLE_PORT and forwards it to startServer", async () => {
    const startServerMock = vi.fn().mockResolvedValue({ url: "http://127.0.0.1:9999" });
    const openBrowserMock = vi.fn().mockResolvedValue(undefined);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const deps: CliDeps = {
      startServer: startServerMock,
      openBrowser: openBrowserMock,
      getFirmwareConfig: vi.fn().mockReturnValue({}),
    };

    await main(["--port", "9999"], {} as NodeJS.ProcessEnv, deps);

    expect(startServerMock).toHaveBeenCalledWith(expect.objectContaining({ port: 9999 }));

    logSpy.mockRestore();
  });

  it("logs a warning, but does not throw, when opening the browser fails", async () => {
    const startServerMock = vi.fn().mockResolvedValue({ url: "http://127.0.0.1:4795" });
    const openBrowserMock = vi.fn().mockRejectedValue(new Error("no display"));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const deps: CliDeps = {
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
