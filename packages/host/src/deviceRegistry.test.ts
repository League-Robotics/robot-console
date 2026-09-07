import { describe, expect, it, vi } from "vitest";
import type { DecodedLine, ParsedBanner } from "@robot-console/protocol";
import { DeviceWatcher, type DaplinkDevice } from "./devices.js";
import type { SwdNameResult } from "./swdName.js";
import { DeviceRegistry, type UsbSerialLinkLike } from "./deviceRegistry.js";
import type { DeviceListEntry, FirmwareKind, FlashPhase } from "./wsMessages.js";
import type { FirmwareConfigMap, FirmwareSource } from "./config.js";
import type { ResolvedRelease } from "./releases.js";
import type { FlashOutcome } from "./flash.js";

// Per the ticket's Testing section: message-shaping logic is exercised
// here against fake devices.ts/swdName.ts/UsbSerialLink outputs -- no
// real hardware involved. `DeviceWatcher` itself (devices.ts, ticket
// 006) is real, but driven entirely by an injected fixture
// `listDevices` function and manual `pollOnce()` calls rather than real
// enumeration or real timers, so device attach/detach is fully
// deterministic here.

function device(overrides: Partial<DaplinkDevice> = {}): DaplinkDevice {
  return {
    serialNumber: "SERIAL-A",
    displaySerial: "SHORT-A",
    availability: "full",
    serialPort: { path: "/dev/cu.usbmodemA" },
    hid: { path: "/hid/A" },
    ...overrides,
  };
}

function namedResult(name: string): SwdNameResult {
  return { status: "named", name, deviceId: 1 };
}

function failingNameResult(): SwdNameResult {
  return { status: "unnamed", reason: "attach-failed", error: "boom" };
}

function banner(overrides: Partial<ParsedBanner> = {}): ParsedBanner {
  return {
    role: "RADIOBRIDGE",
    commonName: "relay",
    name: "abcde",
    serial: 123,
    dialect: "colon",
    ...overrides,
  };
}

/** A fully synthetic {@link UsbSerialLinkLike}: no real `serialport`
 * I/O, full control over open()'s outcome and timing, and helpers to
 * simulate an inbound line or a post-open error. */
class FakeLink implements UsbSerialLinkLike {
  openCalls = 0;
  closeCalls = 0;
  sentLines: string[] = [];
  private lineListeners = new Set<(line: DecodedLine) => void>();
  private errorListeners = new Set<(err: Error) => void>();

  constructor(private readonly openImpl: () => Promise<ParsedBanner>) {}

  open(): Promise<ParsedBanner> {
    this.openCalls++;
    return this.openImpl();
  }

  close(): Promise<void> {
    this.closeCalls++;
    return Promise.resolve();
  }

  sendLine(line: string): void {
    this.sentLines.push(line);
  }

  onLine(listener: (line: DecodedLine) => void): () => void {
    this.lineListeners.add(listener);
    return () => {
      this.lineListeners.delete(listener);
    };
  }

  onError(listener: (err: Error) => void): () => void {
    this.errorListeners.add(listener);
    return () => {
      this.errorListeners.delete(listener);
    };
  }

  emitLine(line: DecodedLine): void {
    for (const listener of this.lineListeners) {
      listener(line);
    }
  }

  emitError(err: Error): void {
    for (const listener of this.errorListeners) {
      listener(err);
    }
  }
}

/** Fixture watcher: fully driven by manual `pollOnce()` calls against a
 * mutable device list, with polling itself disabled (a huge interval)
 * so no real timer ever fires during a test. */
function fixtureWatcher(getDevices: () => DaplinkDevice[]): DeviceWatcher {
  return new DeviceWatcher({
    listDevices: () => Promise.resolve(getDevices()),
    pollIntervalMs: 3_600_000,
  });
}

/** Wait for `onDevicesChanged` to deliver a snapshot matching `predicate`,
 * polling microtasks/timers in between. Deterministic async chains (no
 * real timers involved in the fakes below) mean a handful of
 * `setTimeout(0)` flushes is always enough. */
async function waitForSnapshot(
  registry: DeviceRegistry,
  predicate: (devices: DeviceListEntry[]) => boolean,
): Promise<DeviceListEntry[]> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const snap = registry.snapshot();
    if (predicate(snap)) {
      return snap;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`waitForSnapshot: predicate never satisfied; last snapshot: ${JSON.stringify(registry.snapshot())}`);
}

describe("DeviceRegistry", () => {
  it("lists an attached device immediately (name null), then updates once naming resolves", async () => {
    const devices = [device()];
    const watcher = fixtureWatcher(() => devices);
    const resolveName = vi.fn(async () => namedResult("zeguz"));
    const createLink = vi.fn(() => new FakeLink(() => new Promise<ParsedBanner>(() => {})));

    const registry = new DeviceRegistry({ watcher, resolveName, createLink });
    const seen: DeviceListEntry[][] = [];
    registry.onDevicesChanged((snap) => seen.push(snap));
    registry.start();

    const resolved = await waitForSnapshot(registry, (snap) => snap[0]?.name === "zeguz");
    expect(resolved).toEqual([
      expect.objectContaining({
        id: "SERIAL-A",
        serialNumber: "SERIAL-A",
        displaySerial: "SHORT-A",
        name: "zeguz",
        port: "/dev/cu.usbmodemA",
      }),
    ]);
    // Some earlier snapshot showed the device before naming resolved.
    expect(seen.some((snap) => snap.length === 1 && snap[0]?.name === null)).toBe(true);

    await registry.stop();
  });

  it("opens a link automatically after naming resolves and reflects the banner role", async () => {
    const devices = [device()];
    const watcher = fixtureWatcher(() => devices);
    const resolveName = async () => namedResult("zeguz");
    const link = new FakeLink(async () => banner({ role: "NEZHA2" }));
    const createLink = vi.fn(() => link);

    const registry = new DeviceRegistry({ watcher, resolveName, createLink });
    registry.start();

    const snap = await waitForSnapshot(registry, (s) => s[0]?.linkOpen === true);
    expect(snap[0]).toEqual(
      expect.objectContaining({ name: "zeguz", role: "NEZHA2", linkOpen: true }),
    );
    expect(link.openCalls).toBe(1);

    await registry.stop();
  });

  it("degrades gracefully when link open fails: named, role null, linkError set, no throw", async () => {
    const devices = [device()];
    const watcher = fixtureWatcher(() => devices);
    const resolveName = async () => namedResult("zeguz");
    const createLink = () =>
      new FakeLink(() => Promise.reject(new Error("timed out waiting for a HELLO banner reply")));

    const registry = new DeviceRegistry({ watcher, resolveName, createLink });
    registry.start();

    const snap = await waitForSnapshot(registry, (s) => s[0]?.linkError !== undefined);
    expect(snap[0]).toEqual(
      expect.objectContaining({
        name: "zeguz",
        role: null,
        linkOpen: false,
        linkError: expect.stringContaining("HELLO"),
      }),
    );

    await registry.stop();
  });

  it("reports detected-but-unnamed devices via nameError rather than a fallback name", async () => {
    const devices = [device()];
    const watcher = fixtureWatcher(() => devices);
    const resolveName = async () => failingNameResult();
    const createLink = () => new FakeLink(async () => banner());

    const registry = new DeviceRegistry({ watcher, resolveName, createLink });
    registry.start();

    const snap = await waitForSnapshot(registry, (s) => s[0]?.nameError !== undefined);
    expect(snap[0]?.name).toBeNull();
    expect(snap[0]?.nameError).toEqual({ reason: "attach-failed", message: "boom" });

    await registry.stop();
  });

  it("removes a device from the snapshot on detach and closes its link", async () => {
    let devices = [device()];
    const watcher = fixtureWatcher(() => devices);
    const resolveName = async () => namedResult("zeguz");
    const link = new FakeLink(async () => banner());
    const createLink = () => link;

    const registry = new DeviceRegistry({ watcher, resolveName, createLink });
    registry.start();
    await waitForSnapshot(registry, (s) => s[0]?.linkOpen === true);

    devices = [];
    await watcher.pollOnce();
    const snap = await waitForSnapshot(registry, (s) => s.length === 0);
    expect(snap).toEqual([]);
    expect(link.closeCalls).toBe(1);

    await registry.stop();
  });

  it("serializes name resolution and link open per device (never races)", async () => {
    const order: string[] = [];
    const devices = [device()];
    const watcher = fixtureWatcher(() => devices);
    const resolveName = async () => {
      order.push("name-start");
      await new Promise((resolve) => setTimeout(resolve, 10));
      order.push("name-end");
      return namedResult("zeguz");
    };
    const createLink = () =>
      new FakeLink(async () => {
        order.push("open-start");
        await new Promise((resolve) => setTimeout(resolve, 5));
        order.push("open-end");
        return banner();
      });

    const registry = new DeviceRegistry({ watcher, resolveName, createLink });
    registry.start();
    await waitForSnapshot(registry, (s) => s[0]?.linkOpen === true);

    expect(order).toEqual(["name-start", "name-end", "open-start", "open-end"]);

    await registry.stop();
  });

  it("requestOpen retries a previously-failed link and requestClose tears it down", async () => {
    const devices = [device()];
    const watcher = fixtureWatcher(() => devices);
    const resolveName = async () => namedResult("zeguz");
    let attempt = 0;
    const links: FakeLink[] = [];
    const createLink = () => {
      const shouldFail = attempt === 0;
      attempt++;
      const link = new FakeLink(async () =>
        shouldFail ? Promise.reject(new Error("no reply")) : banner(),
      );
      links.push(link);
      return link;
    };

    const registry = new DeviceRegistry({ watcher, resolveName, createLink });
    registry.start();
    await waitForSnapshot(registry, (s) => s[0]?.linkError !== undefined);

    await registry.requestOpen("SERIAL-A");
    const opened = await waitForSnapshot(registry, (s) => s[0]?.linkOpen === true);
    expect(opened[0]?.linkOpen).toBe(true);
    expect(links).toHaveLength(2);

    await registry.requestClose("SERIAL-A");
    const closed = await waitForSnapshot(registry, (s) => s[0]?.linkOpen === false);
    expect(closed[0]?.linkOpen).toBe(false);
    expect(links[1]?.closeCalls).toBe(1);

    await registry.stop();
  });

  it("sendLine writes to the open link and echoes a tx line event; errors if no link is open", async () => {
    const devices = [device()];
    const watcher = fixtureWatcher(() => devices);
    const resolveName = async () => namedResult("zeguz");
    const link = new FakeLink(async () => banner());
    const createLink = () => link;

    const registry = new DeviceRegistry({ watcher, resolveName, createLink });
    const lines: Array<{ deviceId: string; direction: string; line: string }> = [];
    const errors: Array<{ deviceId: string | undefined; message: string }> = [];
    registry.onLine((deviceId, direction, line) => lines.push({ deviceId, direction, line }));
    registry.onError((deviceId, message) => errors.push({ deviceId, message }));
    registry.start();

    await waitForSnapshot(registry, (s) => s[0]?.linkOpen === true);
    await registry.sendLine("SERIAL-A", "HELLO");
    expect(link.sentLines).toEqual(["HELLO"]);
    expect(lines).toContainEqual({ deviceId: "SERIAL-A", direction: "tx", line: "HELLO" });

    await registry.sendLine("no-such-device", "HELLO");
    expect(errors).toContainEqual({
      deviceId: "no-such-device",
      message: "device no-such-device has no open link",
    });

    await registry.stop();
  });

  it("reconstructs an inbound line from the link and emits it as an rx line event", async () => {
    const devices = [device()];
    const watcher = fixtureWatcher(() => devices);
    const resolveName = async () => namedResult("zeguz");
    const link = new FakeLink(async () => banner());
    const createLink = () => link;

    const registry = new DeviceRegistry({ watcher, resolveName, createLink });
    const lines: Array<{ deviceId: string; direction: string; line: string }> = [];
    registry.onLine((deviceId, direction, l) => lines.push({ deviceId, direction, line: l }));
    registry.start();

    await waitForSnapshot(registry, (s) => s[0]?.linkOpen === true);
    link.emitLine({ kind: "line", verb: "status", fields: ["mode=idle", "flags=d8"], id: 3 });

    expect(lines).toContainEqual({
      deviceId: "SERIAL-A",
      direction: "rx",
      line: "status mode=idle flags=d8 #3",
    });

    await registry.stop();
  });

  it("handles a post-open link error without throwing, and reflects it in the snapshot", async () => {
    const devices = [device()];
    const watcher = fixtureWatcher(() => devices);
    const resolveName = async () => namedResult("zeguz");
    const link = new FakeLink(async () => banner());
    const createLink = () => link;

    const registry = new DeviceRegistry({ watcher, resolveName, createLink });
    const errors: Array<{ deviceId: string | undefined; message: string }> = [];
    registry.onError((deviceId, message) => errors.push({ deviceId, message }));
    registry.start();

    await waitForSnapshot(registry, (s) => s[0]?.linkOpen === true);
    expect(() => link.emitError(new Error("device unplugged"))).not.toThrow();

    const snap = await waitForSnapshot(registry, (s) => s[0]?.linkOpen === false);
    expect(snap[0]?.linkError).toBe("device unplugged");
    expect(errors).toContainEqual({ deviceId: "SERIAL-A", message: "device unplugged" });

    await registry.stop();
  });
});

// ---------------------------------------------------------------------
// requestFlash (sprint 2, ticket 005) -- fully synthetic fakes for
// config.ts/releases.ts/flash.ts, following this file's own "never test
// against real hardware/network" precedent. No real GitHub HTTP call,
// no real USB/SWD I/O, no real environment/dotconfig read.
// ---------------------------------------------------------------------

function firmwareSource(overrides: Partial<FirmwareSource> = {}): FirmwareSource {
  return { repoUrl: "https://github.com/org/relay-firmware", tag: "latest", ...overrides };
}

function resolvedRelease(overrides: Partial<ResolvedRelease> = {}): ResolvedRelease {
  return {
    tag: "v1.0.0",
    hexUrl: "https://example.com/MICROBIT.hex",
    manifestUrl: "https://example.com/MICROBIT.hex.txt",
    ...overrides,
  };
}

/** A fixture `getFirmwareConfig`-shaped accessor -- the injection seam
 * `requestFlash` uses in place of config.ts's real environment/dotconfig
 * read (see the ticket's testing note). */
function configWith(relay?: FirmwareSource, robot?: FirmwareSource): () => FirmwareConfigMap {
  return () => ({ relay, robot });
}

describe("DeviceRegistry — requestFlash", () => {
  it("flashes successfully end to end: progress sequence, result, flashStatus cleared, link re-opened", async () => {
    const devices = [device()];
    const watcher = fixtureWatcher(() => devices);
    const resolveName = async () => namedResult("zeguz");
    const links: FakeLink[] = [];
    const createLink = vi.fn(() => {
      const isFirst = links.length === 0;
      const link = new FakeLink(async () => banner({ role: isFirst ? "RADIOBRIDGE" : "RADIORELAY" }));
      links.push(link);
      return link;
    });

    const resolveReleaseFn = vi.fn(async (): Promise<ResolvedRelease> => resolvedRelease());
    const fetchAndVerifyHexFn = vi.fn(async () => ({ hex: Buffer.from(":00000001FF\n", "utf-8") }));
    const flashFn = vi.fn(
      async (
        _device: DaplinkDevice,
        _hexText: string,
        onProgress: (phase: FlashPhase) => void,
      ): Promise<FlashOutcome> => {
        onProgress("erasing");
        onProgress("writing");
        onProgress("resetting");
        return { status: "ok", method: "swd" };
      },
    );

    const registry = new DeviceRegistry({
      watcher,
      resolveName,
      createLink,
      getFirmwareConfig: configWith(firmwareSource()),
      resolveRelease: resolveReleaseFn,
      fetchAndVerifyHex: fetchAndVerifyHexFn,
      flash: flashFn,
    });

    const progress: Array<{ deviceId: string; firmware: FirmwareKind; phase: FlashPhase }> = [];
    const results: Array<{ deviceId: string; firmware: FirmwareKind; status: string; message: string | undefined }> = [];
    const flashStatusSnapshots: Array<{ firmware: FirmwareKind; phase: FlashPhase } | undefined> = [];
    registry.onFlashProgress((deviceId, firmware, phase) => progress.push({ deviceId, firmware, phase }));
    registry.onFlashResult((deviceId, firmware, status, message) =>
      results.push({ deviceId, firmware, status, message }),
    );
    registry.onDevicesChanged((snap) => flashStatusSnapshots.push(snap[0]?.flashStatus));

    registry.start();
    await waitForSnapshot(registry, (s) => s[0]?.linkOpen === true);
    expect(links).toHaveLength(1);

    await registry.requestFlash("SERIAL-A", "relay");

    expect(progress.map((p) => p.phase)).toEqual([
      "fetching",
      "verifying",
      "erasing",
      "writing",
      "resetting",
    ]);
    expect(results).toEqual([{ deviceId: "SERIAL-A", firmware: "relay", status: "ok", message: undefined }]);
    expect(resolveReleaseFn).toHaveBeenCalledTimes(1);
    expect(fetchAndVerifyHexFn).toHaveBeenCalledTimes(1);
    expect(flashFn).toHaveBeenCalledTimes(1);
    // The pre-existing link was torn down before flashing began.
    expect(links[0]?.closeCalls).toBe(1);
    expect(flashStatusSnapshots).toContainEqual({ firmware: "relay", phase: "erasing" });

    const snap = await waitForSnapshot(registry, (s) => s[0]?.role === "RADIORELAY");
    expect(snap[0]?.flashStatus).toBeUndefined();
    expect(snap[0]?.linkOpen).toBe(true);
    // Re-opened after success to pick up the new banner.
    expect(links).toHaveLength(2);

    await registry.stop();
  });

  it("a fetch failure ends in a flash-result error without ever calling flash.ts", async () => {
    const devices = [device()];
    const watcher = fixtureWatcher(() => devices);
    const resolveName = async () => namedResult("zeguz");
    const createLink = () => new FakeLink(() => Promise.reject(new Error("no reply")));

    const resolveReleaseFn = vi.fn(async (): Promise<ResolvedRelease> => resolvedRelease());
    const fetchAndVerifyHexFn = vi.fn(async () => ({ error: "sha256 mismatch for downloaded hex" }));
    const flashFn = vi.fn(async (): Promise<FlashOutcome> => ({ status: "ok", method: "swd" }));

    const registry = new DeviceRegistry({
      watcher,
      resolveName,
      createLink,
      getFirmwareConfig: configWith(firmwareSource()),
      resolveRelease: resolveReleaseFn,
      fetchAndVerifyHex: fetchAndVerifyHexFn,
      flash: flashFn,
    });

    const results: Array<{ status: string; message: string | undefined }> = [];
    registry.onFlashResult((_deviceId, _firmware, status, message) => results.push({ status, message }));

    registry.start();
    await waitForSnapshot(registry, (s) => s[0]?.linkError !== undefined);

    await registry.requestFlash("SERIAL-A", "relay");

    expect(flashFn).not.toHaveBeenCalled();
    expect(results).toEqual([{ status: "error", message: "sha256 mismatch for downloaded hex" }]);
    expect(registry.snapshot()[0]?.flashStatus).toBeUndefined();

    await registry.stop();
  });

  it("a resolveRelease failure ends in a flash-result error without ever calling flash.ts", async () => {
    const devices = [device()];
    const watcher = fixtureWatcher(() => devices);
    const resolveName = async () => namedResult("zeguz");
    const createLink = () => new FakeLink(() => Promise.reject(new Error("no reply")));

    const resolveReleaseFn = vi.fn(async () => ({ reason: "no-releases" as const, message: "no releases published" }));
    const fetchAndVerifyHexFn = vi.fn(async () => ({ hex: Buffer.from(":00000001FF\n") }));
    const flashFn = vi.fn(async (): Promise<FlashOutcome> => ({ status: "ok", method: "swd" }));

    const registry = new DeviceRegistry({
      watcher,
      resolveName,
      createLink,
      getFirmwareConfig: configWith(undefined, firmwareSource()),
      resolveRelease: resolveReleaseFn,
      fetchAndVerifyHex: fetchAndVerifyHexFn,
      flash: flashFn,
    });

    const results: Array<{ status: string; message: string | undefined }> = [];
    registry.onFlashResult((_deviceId, _firmware, status, message) => results.push({ status, message }));

    registry.start();
    await waitForSnapshot(registry, (s) => s[0]?.linkError !== undefined);

    await registry.requestFlash("SERIAL-A", "robot");

    expect(fetchAndVerifyHexFn).not.toHaveBeenCalled();
    expect(flashFn).not.toHaveBeenCalled();
    expect(results).toEqual([{ status: "error", message: "no releases published" }]);
    expect(registry.snapshot()[0]?.flashStatus).toBeUndefined();

    await registry.stop();
  });

  it("a mid-write flash failure clears flashStatus and reports an error without reopening", async () => {
    const devices = [device()];
    const watcher = fixtureWatcher(() => devices);
    const resolveName = async () => namedResult("zeguz");
    const createLink = vi.fn(() => new FakeLink(() => Promise.reject(new Error("no reply"))));

    const resolveReleaseFn = vi.fn(async (): Promise<ResolvedRelease> => resolvedRelease());
    const fetchAndVerifyHexFn = vi.fn(async () => ({ hex: Buffer.from(":00000001FF\n") }));
    const flashFn = vi.fn(
      async (): Promise<FlashOutcome> => ({
        status: "error",
        method: "swd",
        reason: "program-failed",
        error: "write failed at page 3",
      }),
    );

    const registry = new DeviceRegistry({
      watcher,
      resolveName,
      createLink,
      getFirmwareConfig: configWith(firmwareSource()),
      resolveRelease: resolveReleaseFn,
      fetchAndVerifyHex: fetchAndVerifyHexFn,
      flash: flashFn,
    });

    const results: Array<{ status: string; message: string | undefined }> = [];
    registry.onFlashResult((_deviceId, _firmware, status, message) => results.push({ status, message }));

    registry.start();
    await waitForSnapshot(registry, (s) => s[0]?.linkError !== undefined);
    const createLinkCallsBefore = createLink.mock.calls.length;

    await registry.requestFlash("SERIAL-A", "relay");

    expect(results).toEqual([{ status: "error", message: "write failed at page 3" }]);
    const snap = registry.snapshot();
    expect(snap[0]?.flashStatus).toBeUndefined();
    expect(snap[0]?.linkOpen).toBe(false);
    // A failed flash never attempts to reopen -- nothing new to identify.
    expect(createLink.mock.calls.length).toBe(createLinkCallsBefore);

    await registry.stop();
  });

  it("an unconfigured firmware source ends in an error result without calling releases.ts or flash.ts", async () => {
    const devices = [device()];
    const watcher = fixtureWatcher(() => devices);
    const resolveName = async () => namedResult("zeguz");
    const createLink = () => new FakeLink(() => Promise.reject(new Error("no reply")));

    const resolveReleaseFn = vi.fn(async (): Promise<ResolvedRelease> => resolvedRelease());
    const fetchAndVerifyHexFn = vi.fn(async () => ({ hex: Buffer.from(":00000001FF\n") }));
    const flashFn = vi.fn(async (): Promise<FlashOutcome> => ({ status: "ok", method: "swd" }));

    const registry = new DeviceRegistry({
      watcher,
      resolveName,
      createLink,
      getFirmwareConfig: configWith(undefined, undefined),
      resolveRelease: resolveReleaseFn,
      fetchAndVerifyHex: fetchAndVerifyHexFn,
      flash: flashFn,
    });

    const results: Array<{ status: string; message: string | undefined }> = [];
    registry.onFlashResult((_deviceId, _firmware, status, message) => results.push({ status, message }));

    registry.start();
    await waitForSnapshot(registry, (s) => s[0]?.linkError !== undefined);

    await registry.requestFlash("SERIAL-A", "relay");

    expect(resolveReleaseFn).not.toHaveBeenCalled();
    expect(fetchAndVerifyHexFn).not.toHaveBeenCalled();
    expect(flashFn).not.toHaveBeenCalled();
    expect(results).toEqual([{ status: "error", message: expect.stringContaining("relay") }]);
    expect(registry.snapshot()[0]?.flashStatus).toBeUndefined();

    await registry.stop();
  });

  it("requestFlash for an unknown deviceId reports via onError, never throws", async () => {
    const registry = new DeviceRegistry({
      watcher: fixtureWatcher(() => []),
      getFirmwareConfig: configWith(firmwareSource()),
    });
    const errors: Array<{ deviceId: string | undefined; message: string }> = [];
    registry.onError((deviceId, message) => errors.push({ deviceId, message }));

    await expect(registry.requestFlash("no-such-device", "relay")).resolves.toBeUndefined();
    expect(errors).toContainEqual({ deviceId: "no-such-device", message: "no such device: no-such-device" });

    await registry.stop();
  });

  it("serializes requestFlash against a concurrent requestOpen on the same device (never interleaved)", async () => {
    const order: string[] = [];
    const devices = [device()];
    const watcher = fixtureWatcher(() => devices);
    const resolveName = async () => namedResult("zeguz");
    const createLink = () => new FakeLink(() => Promise.reject(new Error("no reply")));

    const resolveReleaseFn = vi.fn(async (): Promise<ResolvedRelease> => {
      order.push("flash-resolve-start");
      await new Promise((resolve) => setTimeout(resolve, 10));
      order.push("flash-resolve-end");
      return resolvedRelease();
    });
    const fetchAndVerifyHexFn = vi.fn(async () => ({ hex: Buffer.from(":00000001FF\n") }));
    const flashFn = vi.fn(async (): Promise<FlashOutcome> => ({ status: "ok", method: "swd" }));

    const registry = new DeviceRegistry({
      watcher,
      resolveName,
      createLink,
      getFirmwareConfig: configWith(firmwareSource()),
      resolveRelease: resolveReleaseFn,
      fetchAndVerifyHex: fetchAndVerifyHexFn,
      flash: flashFn,
    });

    registry.start();
    await waitForSnapshot(registry, (s) => s[0]?.linkError !== undefined);

    // Issued back-to-back for the same device: requestFlash's mutex slot
    // is claimed first, so requestOpen's own work must wait for the
    // entire flash task (including the slow "network" resolve step) to
    // finish before it ever runs -- the core mutex guarantee this
    // ticket relies on.
    const flashPromise = registry.requestFlash("SERIAL-A", "relay").then(() => order.push("flash-done"));
    const openPromise = registry.requestOpen("SERIAL-A").then(() => order.push("open-done"));

    await Promise.all([flashPromise, openPromise]);

    expect(order).toEqual(["flash-resolve-start", "flash-resolve-end", "flash-done", "open-done"]);

    await registry.stop();
  });
});
