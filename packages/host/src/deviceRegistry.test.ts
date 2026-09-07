import { describe, expect, it, vi } from "vitest";
import type { AckNackEvent, DecodedLine, ParsedBanner } from "@robot-console/protocol";
import { DeviceWatcher, type DaplinkDevice } from "./devices.js";
import type { SwdNameResult } from "./swdName.js";
import { DeviceRegistry, KeyedMutex } from "./deviceRegistry.js";
import type { Link } from "./link/Link.js";
import type { EndpointListEntry, FirmwareKind, FirmwareSourceRef, FlashPhase } from "./wsMessages.js";
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

/** A fully synthetic {@link Link}: no real `serialport` I/O, full
 * control over `connect()`/`identify()`'s outcome and timing (separate
 * seams, per the ticket's `connect()`/`identify()` split), and helpers
 * to simulate an inbound line or a post-connect error.
 *
 * `connectImpl` defaults to an immediately-succeeding transport, since
 * most tests care only about `identify()`'s outcome (a banner, or `null`
 * for a silent board) -- tests exercising a genuine transport failure
 * (`connect()` itself failing) pass their own rejecting `connectImpl`.
 */
class FakeLink implements Link {
  connectCalls = 0;
  identifyCalls = 0;
  closeCalls = 0;
  sentLines: string[] = [];
  private lineListeners = new Set<(line: DecodedLine) => void>();
  private ackNackListeners = new Set<(event: AckNackEvent) => void>();
  private errorListeners = new Set<(err: Error) => void>();

  constructor(
    private readonly identifyImpl: () => Promise<ParsedBanner | null>,
    private readonly connectImpl: () => Promise<void> = () => Promise.resolve(),
  ) {}

  connect(): Promise<void> {
    this.connectCalls++;
    return this.connectImpl();
  }

  identify(): Promise<ParsedBanner | null> {
    this.identifyCalls++;
    return this.identifyImpl();
  }

  close(): Promise<void> {
    this.closeCalls++;
    return Promise.resolve();
  }

  sendLine(line: string): void {
    this.sentLines.push(line);
  }

  sendCommand(): string {
    throw new Error("FakeLink.sendCommand is not exercised by DeviceRegistry");
  }

  sendUnsequenced(): string {
    throw new Error("FakeLink.sendUnsequenced is not exercised by DeviceRegistry");
  }

  checkLiveness(): void {
    // Not exercised by DeviceRegistry -- no-op.
  }

  onLine(listener: (line: DecodedLine) => void): () => void {
    this.lineListeners.add(listener);
    return () => {
      this.lineListeners.delete(listener);
    };
  }

  onAckNack(listener: (event: AckNackEvent) => void): () => void {
    this.ackNackListeners.add(listener);
    return () => {
      this.ackNackListeners.delete(listener);
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
  predicate: (devices: EndpointListEntry[]) => boolean,
): Promise<EndpointListEntry[]> {
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
    const createLink = vi.fn(() => new FakeLink(() => new Promise<ParsedBanner | null>(() => {})));

    const registry = new DeviceRegistry({ watcher, resolveName, createLink });
    const seen: EndpointListEntry[][] = [];
    registry.onDevicesChanged((snap) => seen.push(snap));
    registry.start();

    const resolved = await waitForSnapshot(registry, (snap) => snap[0]?.name === "zeguz");
    expect(resolved).toEqual([
      expect.objectContaining({
        endpointId: "usb-SERIAL-A",
        name: "zeguz",
        usb: expect.objectContaining({
          serialNumber: "SERIAL-A",
          displaySerial: "SHORT-A",
          port: "/dev/cu.usbmodemA",
        }),
      }),
    ]);
    // Some earlier snapshot showed the device before naming resolved.
    expect(seen.some((snap) => snap.length === 1 && snap[0]?.name === null)).toBe(true);

    await registry.stop();
  });

  it("stamps resourceKey on every snapshot entry, equal to endpointId for every USB endpoint", async () => {
    // Ticket 003's endpoint/session/resource-key model: resourceKey is
    // always present, and always equal to endpointId for USB this
    // sprint (see EndpointState.resourceKey's own doc comment) -- a
    // relay in sprint 7 is what makes them diverge, not this ticket.
    const devices = [device(), device({ serialNumber: "SERIAL-B", displaySerial: "SHORT-B" })];
    const watcher = fixtureWatcher(() => devices);
    const resolveName = async () => namedResult("zeguz");
    const createLink = () => new FakeLink(() => new Promise<ParsedBanner | null>(() => {}));

    const registry = new DeviceRegistry({ watcher, resolveName, createLink });
    registry.start();

    const snap = await waitForSnapshot(registry, (s) => s.length === 2);
    expect(snap).toHaveLength(2);
    for (const entry of snap) {
      expect(entry.resourceKey).toBe(entry.endpointId);
    }
    expect(snap.map((e) => e.resourceKey).sort()).toEqual(["usb-SERIAL-A", "usb-SERIAL-B"]);

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

    const snap = await waitForSnapshot(registry, (s) => s[0]?.sessionOpen === true);
    expect(snap[0]).toEqual(
      expect.objectContaining({ name: "zeguz", role: "NEZHA2", sessionOpen: true }),
    );
    expect(link.connectCalls).toBe(1);
    expect(link.identifyCalls).toBe(1);

    await registry.stop();
  });

  it("degrades gracefully when connect() fails: named, role null, sessionError set, sessionOpen false, no throw", async () => {
    // A genuine transport-level failure -- the port itself refusing to
    // open. Distinct from identify() timing out (see the next test):
    // only a connect() failure is still an error state under sprint 4
    // ticket 002's connect()/identify() split.
    const devices = [device()];
    const watcher = fixtureWatcher(() => devices);
    const resolveName = async () => namedResult("zeguz");
    const createLink = () =>
      new FakeLink(
        async () => banner(), // never reached -- connect() fails first
        () => Promise.reject(new Error("permission denied opening port")),
      );

    const registry = new DeviceRegistry({ watcher, resolveName, createLink });
    registry.start();

    const snap = await waitForSnapshot(registry, (s) => s[0]?.sessionError !== undefined);
    expect(snap[0]).toEqual(
      expect.objectContaining({
        name: "zeguz",
        role: null,
        sessionOpen: false,
        sessionError: expect.stringContaining("permission denied"),
      }),
    );

    await registry.stop();
  });

  it("treats a silent board (identify() resolves null) as connected-but-unresponsive, not an error", async () => {
    // The core behavior change this ticket introduces: a healthy
    // transport with nothing answering HELLO is a normal, representable
    // state -- sessionOpen: true, classification unknown, no
    // sessionError -- not the error state a connect() failure produces
    // (previous test). This is also the port-lock-contention fix: the
    // link connect() opened is never closed just because identify()
    // found nothing.
    const devices = [device()];
    const watcher = fixtureWatcher(() => devices);
    const resolveName = async () => namedResult("zeguz");
    const link = new FakeLink(async () => null);
    const createLink = () => link;

    const registry = new DeviceRegistry({ watcher, resolveName, createLink });
    registry.start();

    const snap = await waitForSnapshot(registry, (s) => s[0]?.sessionOpen === true);
    expect(snap[0]).toEqual(
      expect.objectContaining({
        name: "zeguz",
        role: null,
        sessionOpen: true,
        classification: expect.objectContaining({ type: "unknown", evidence: "none" }),
      }),
    );
    expect(snap[0]?.sessionError).toBeUndefined();
    expect(link.closeCalls).toBe(0);

    await registry.stop();
  });

  it("closes the underlying link after a failed connect(), so the OS-level port handle is not leaked", async () => {
    // Regression test for a real bug sprint 003 ticket 005's bench
    // session exposed, carried forward under the connect()/identify()
    // split (sprint 4 ticket 002): a transport-level connect() failure
    // may still leave the underlying port genuinely open at the OS
    // level by the time it rejects. The old `openLink`'s failure branch
    // recorded `sessionError` but never called `link.close()` on the
    // link it had just created, leaking the OS-level handle for the
    // rest of the process's lifetime -- verified against real hardware:
    // every later open attempt on that same port (a manual "Retry
    // connection", or `requestFlash`'s own post-flash reopen) then
    // failed with "Cannot lock port". `connectAndIdentify`'s connect()
    // failure branch still closes the link it just created.
    const devices = [device()];
    const watcher = fixtureWatcher(() => devices);
    const resolveName = async () => namedResult("zeguz");
    let failedLink: FakeLink | undefined;
    const createLink = () => {
      failedLink = new FakeLink(
        async () => banner(), // never reached
        () => Promise.reject(new Error("permission denied opening port")),
      );
      return failedLink;
    };

    const registry = new DeviceRegistry({ watcher, resolveName, createLink });
    registry.start();

    await waitForSnapshot(registry, (s) => s[0]?.sessionError !== undefined);
    expect(failedLink?.closeCalls).toBe(1);

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
    await waitForSnapshot(registry, (s) => s[0]?.sessionOpen === true);

    devices = [];
    await watcher.pollOnce();
    const snap = await waitForSnapshot(registry, (s) => s.length === 0);
    expect(snap).toEqual([]);
    expect(link.closeCalls).toBe(1);

    await registry.stop();
  });

  it("serializes name resolution and link connect/identify per device (never races)", async () => {
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
        order.push("identify-start");
        await new Promise((resolve) => setTimeout(resolve, 5));
        order.push("identify-end");
        return banner();
      });

    const registry = new DeviceRegistry({ watcher, resolveName, createLink });
    registry.start();
    // sessionOpen flips true as soon as connect() succeeds, before
    // identify() even starts (see connectAndIdentify's own doc comment)
    // -- wait for role instead, which is only set once identify()
    // resolves, to observe the full sequence.
    await waitForSnapshot(registry, (s) => s.length > 0 && s[0]?.role !== null);

    expect(order).toEqual(["name-start", "name-end", "identify-start", "identify-end"]);

    await registry.stop();
  });

  it("requestOpen retries after a previously-failed connect() and requestClose tears it down", async () => {
    // requestOpen() only retries a link whose connect() genuinely
    // failed (sessionOpen: false) -- a "connected, unresponsive"
    // endpoint already has sessionOpen: true and is out of scope for
    // this ticket's requestOpen (see connectAndIdentify's own doc
    // comment).
    const devices = [device()];
    const watcher = fixtureWatcher(() => devices);
    const resolveName = async () => namedResult("zeguz");
    let attempt = 0;
    const links: FakeLink[] = [];
    const createLink = () => {
      const shouldFail = attempt === 0;
      attempt++;
      const link = new FakeLink(
        async () => banner(),
        shouldFail ? () => Promise.reject(new Error("permission denied opening port")) : () => Promise.resolve(),
      );
      links.push(link);
      return link;
    };

    const registry = new DeviceRegistry({ watcher, resolveName, createLink });
    registry.start();
    await waitForSnapshot(registry, (s) => s[0]?.sessionError !== undefined);

    await registry.requestOpen("usb-SERIAL-A");
    const opened = await waitForSnapshot(registry, (s) => s[0]?.sessionOpen === true);
    expect(opened[0]?.sessionOpen).toBe(true);
    expect(links).toHaveLength(2);

    await registry.requestClose("usb-SERIAL-A");
    const closed = await waitForSnapshot(registry, (s) => s[0]?.sessionOpen === false);
    expect(closed[0]?.sessionOpen).toBe(false);
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
    const lines: Array<{ endpointId: string; direction: string; line: string }> = [];
    const errors: Array<{ endpointId: string | undefined; message: string }> = [];
    registry.onLine((endpointId, direction, line) => lines.push({ endpointId, direction, line }));
    registry.onError((endpointId, message) => errors.push({ endpointId, message }));
    registry.start();

    await waitForSnapshot(registry, (s) => s[0]?.sessionOpen === true);
    await registry.sendLine("usb-SERIAL-A", "HELLO");
    expect(link.sentLines).toEqual(["HELLO"]);
    expect(lines).toContainEqual({ endpointId: "usb-SERIAL-A", direction: "tx", line: "HELLO" });

    await registry.sendLine("no-such-device", "HELLO");
    expect(errors).toContainEqual({
      endpointId: "no-such-device",
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
    const lines: Array<{ endpointId: string; direction: string; line: string }> = [];
    registry.onLine((endpointId, direction, l) => lines.push({ endpointId, direction, line: l }));
    registry.start();

    await waitForSnapshot(registry, (s) => s[0]?.sessionOpen === true);
    link.emitLine({ kind: "line", verb: "status", fields: ["mode=idle", "flags=d8"], id: 3 });

    expect(lines).toContainEqual({
      endpointId: "usb-SERIAL-A",
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
    const errors: Array<{ endpointId: string | undefined; message: string }> = [];
    registry.onError((endpointId, message) => errors.push({ endpointId, message }));
    registry.start();

    await waitForSnapshot(registry, (s) => s[0]?.sessionOpen === true);
    expect(() => link.emitError(new Error("device unplugged"))).not.toThrow();

    const snap = await waitForSnapshot(registry, (s) => s[0]?.sessionOpen === false);
    expect(snap[0]?.sessionError).toBe("device unplugged");
    expect(errors).toContainEqual({ endpointId: "usb-SERIAL-A", message: "device unplugged" });

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

/** A `release`-kind {@link FirmwareSourceRef} for `firmware` -- ticket
 * 005's `requestFlash` takes the full source ref now, not a bare
 * {@link FirmwareKind}, so every existing release-flash test in this
 * file wraps its firmware kind with this helper. */
function releaseSource(firmware: FirmwareKind): FirmwareSourceRef {
  return { kind: "release", firmware };
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

/** A `results` entry shape shared by the requestFlash tests below --
 * mirrors {@link FlashResultListener}'s own parameter list (ticket
 * 004's reidentify fields included) rather than {@link
 * FlashResultMessage}'s object shape, since that's what `onFlashResult`
 * actually delivers. */
interface FlashResultEvent {
  endpointId: string;
  source: FirmwareSourceRef;
  status: "ok" | "error";
  message: string | undefined;
  classification: unknown;
  name: string | null | undefined;
  reidentify: "timeout" | undefined;
}

describe("DeviceRegistry — requestFlash", () => {
  it("flashes successfully end to end: progress sequence through reidentifying, result carries the post-flash identity with no flicker, flashStatus cleared once, link re-opened", async () => {
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

    const progress: Array<{ endpointId: string; source: FirmwareSourceRef; phase: FlashPhase }> = [];
    const results: FlashResultEvent[] = [];
    const flashStatusSnapshots: Array<{ firmware: FirmwareKind; phase: FlashPhase } | undefined> = [];
    registry.onFlashProgress((endpointId, source, phase) => progress.push({ endpointId, source, phase }));
    registry.onFlashResult((endpointId, source, status, message, classification, name, reidentify) =>
      results.push({ endpointId, source, status, message, classification, name, reidentify }),
    );
    registry.onDevicesChanged((snap) => flashStatusSnapshots.push(snap[0]?.flashStatus));

    registry.start();
    await waitForSnapshot(registry, (s) => s[0]?.sessionOpen === true);
    expect(links).toHaveLength(1);
    const preFlashRole = registry.snapshot()[0]?.role;

    await registry.requestFlash("usb-SERIAL-A", releaseSource("relay"));

    // "reidentifying" now runs between the write's last phase and the
    // terminal result -- see this class's own "Post-flash reidentify
    // sequencing" doc comment.
    expect(progress.map((p) => p.phase)).toEqual([
      "fetching",
      "verifying",
      "erasing",
      "writing",
      "resetting",
      "reidentifying",
    ]);
    // Exactly one flash-result, carrying the *post-flash* classification
    // (role "RADIORELAY") -- never the pre-flash one ("RADIOBRIDGE"),
    // and never an intermediate "ok" sent before it (no flicker).
    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe("ok");
    expect(results[0]?.message).toBeUndefined();
    expect(results[0]?.reidentify).toBeUndefined();
    expect(results[0]?.name).toBe("zeguz");
    expect(results[0]?.classification).toEqual(expect.objectContaining({ role: "RADIORELAY", type: "relay" }));
    expect((results[0]?.classification as { role: string }).role).not.toBe(preFlashRole);
    expect(resolveReleaseFn).toHaveBeenCalledTimes(1);
    expect(fetchAndVerifyHexFn).toHaveBeenCalledTimes(1);
    expect(flashFn).toHaveBeenCalledTimes(1);
    // The pre-existing link was torn down before flashing began.
    expect(links[0]?.closeCalls).toBe(1);
    expect(flashStatusSnapshots).toContainEqual({ firmware: "relay", phase: "erasing" });
    // flashStatus is still present mid-reidentify -- it is cleared only
    // at the final flash-result emission, not before.
    expect(flashStatusSnapshots).toContainEqual({ firmware: "relay", phase: "reidentifying" });

    const snap = await waitForSnapshot(registry, (s) => s[0]?.role === "RADIORELAY");
    expect(snap[0]?.flashStatus).toBeUndefined();
    expect(snap[0]?.sessionOpen).toBe(true);
    // Re-opened after success to pick up the new banner.
    expect(links).toHaveLength(2);

    await registry.stop();
  });

  it("reidentify timeout: identify() called at most twice, result is status ok with classification unknown and reidentify timeout, never an error", async () => {
    const devices = [device()];
    const watcher = fixtureWatcher(() => devices);
    const resolveName = async () => namedResult("zeguz");
    const links: FakeLink[] = [];
    let reidentifyLink: FakeLink | undefined;
    const createLink = vi.fn(() => {
      if (links.length === 0) {
        const link = new FakeLink(async () => banner());
        links.push(link);
        return link;
      }
      // The post-flash reidentify link: never replies to HELLO.
      reidentifyLink = new FakeLink(() => new Promise<ParsedBanner | null>(() => {}));
      links.push(reidentifyLink);
      return reidentifyLink;
    });

    const resolveReleaseFn = vi.fn(async (): Promise<ResolvedRelease> => resolvedRelease());
    const fetchAndVerifyHexFn = vi.fn(async () => ({ hex: Buffer.from(":00000001FF\n", "utf-8") }));
    const flashFn = vi.fn(async (): Promise<FlashOutcome> => ({ status: "ok", method: "swd" }));

    const registry = new DeviceRegistry({
      watcher,
      resolveName,
      createLink,
      getFirmwareConfig: configWith(firmwareSource()),
      resolveRelease: resolveReleaseFn,
      fetchAndVerifyHex: fetchAndVerifyHexFn,
      flash: flashFn,
      // A hung identify() would otherwise cost DEFAULT_REIDENTIFY_TIMEOUT_MS
      // (~8s) of real wall-clock time per attempt, twice over.
      reidentifyTimeoutMs: 5,
    });

    const results: FlashResultEvent[] = [];
    registry.onFlashResult((endpointId, source, status, message, classification, name, reidentify) =>
      results.push({ endpointId, source, status, message, classification, name, reidentify }),
    );

    registry.start();
    await waitForSnapshot(registry, (s) => s[0]?.sessionOpen === true);

    await registry.requestFlash("usb-SERIAL-A", releaseSource("relay"));

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ status: "ok", message: undefined, reidentify: "timeout" });
    expect(results[0]?.classification).toEqual(expect.objectContaining({ type: "unknown" }));
    // identify() is called exactly twice against the reidentify link
    // (the initial attempt, plus one retry) -- never more.
    expect(reidentifyLink?.identifyCalls).toBe(2);

    const snap = registry.snapshot();
    expect(snap[0]?.flashStatus).toBeUndefined();
    expect(snap[0]?.classification.type).toBe("unknown");

    await registry.stop();
  });

  it("orphaned-state guard: a device re-enumerating mid-flash (remove+add) drops runFlash's stale writes without touching the live re-added endpoint or emitting a flash-result", async () => {
    let devices = [device()];
    const watcher = fixtureWatcher(() => devices);
    const resolveName = async () => namedResult("zeguz");
    const createLink = () => new FakeLink(async () => banner());

    const resolveReleaseFn = vi.fn(async (): Promise<ResolvedRelease> => resolvedRelease());
    const fetchAndVerifyHexFn = vi.fn(async () => ({ hex: Buffer.from(":00000001FF\n", "utf-8") }));
    // Orphan the state mid-write (between "erasing" and "writing"), then
    // let the write itself fail -- mirrors a board that reset and
    // re-enumerated (a fresh state object registered under the same id)
    // while runFlash still held the original object, per the module's
    // own "Orphaned state during a flash" doc comment.
    const flashFn = vi.fn(
      async (
        _device: DaplinkDevice,
        _hexText: string,
        onProgress: (phase: FlashPhase) => void,
      ): Promise<FlashOutcome> => {
        onProgress("erasing");
        // Same serial number (same endpoint id) but a changed field --
        // devices.ts's diff (content-equality per serial number) reports
        // this as a "modified" device, i.e. remove+add, exactly like a
        // real re-enumeration after a reset.
        devices = [device({ hid: { path: "/hid/A-REENUM" } })];
        await watcher.pollOnce();
        onProgress("writing");
        return { status: "error", method: "swd", reason: "program-failed", error: "write failed at page 3" };
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

    const results: FlashResultEvent[] = [];
    registry.onFlashResult((endpointId, source, status, message, classification, name, reidentify) =>
      results.push({ endpointId, source, status, message, classification, name, reidentify }),
    );

    registry.start();
    await waitForSnapshot(registry, (s) => s[0]?.sessionOpen === true);
    const originalState = registry.snapshot()[0];
    expect(originalState).toBeDefined();

    await registry.requestFlash("usb-SERIAL-A", releaseSource("relay"));

    // The re-added endpoint (a brand new attach, unrelated to the stale
    // flash) is live and untouched by runFlash's orphaned writes -- no
    // flashStatus ever attributed to it.
    const snap = await waitForSnapshot(registry, (s) => s[0]?.sessionOpen === true);
    expect(snap[0]?.flashStatus).toBeUndefined();
    expect(snap[0]?.endpointId).toBe("usb-SERIAL-A");

    // No flash-result at all -- the guard silently dropped the failure
    // write against the now-stale state object.
    expect(results).toEqual([]);

    await registry.stop();
  });

  it("a fetch failure ends in a flash-result error without ever calling flash.ts", async () => {
    const devices = [device()];
    const watcher = fixtureWatcher(() => devices);
    const resolveName = async () => namedResult("zeguz");
    const createLink = () => new FakeLink(
      async () => banner(), // never reached -- connect() fails first
      () => Promise.reject(new Error("no reply")),
    );

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
    registry.onFlashResult((_endpointId, _source, status, message) => results.push({ status, message }));

    registry.start();
    await waitForSnapshot(registry, (s) => s[0]?.sessionError !== undefined);

    await registry.requestFlash("usb-SERIAL-A", releaseSource("relay"));

    expect(flashFn).not.toHaveBeenCalled();
    expect(results).toEqual([{ status: "error", message: "sha256 mismatch for downloaded hex" }]);
    expect(registry.snapshot()[0]?.flashStatus).toBeUndefined();

    await registry.stop();
  });

  it("a resolveRelease failure ends in a flash-result error without ever calling flash.ts", async () => {
    const devices = [device()];
    const watcher = fixtureWatcher(() => devices);
    const resolveName = async () => namedResult("zeguz");
    const createLink = () => new FakeLink(
      async () => banner(), // never reached -- connect() fails first
      () => Promise.reject(new Error("no reply")),
    );

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
    registry.onFlashResult((_endpointId, _source, status, message) => results.push({ status, message }));

    registry.start();
    await waitForSnapshot(registry, (s) => s[0]?.sessionError !== undefined);

    await registry.requestFlash("usb-SERIAL-A", releaseSource("robot"));

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
    const createLink = vi.fn(() => new FakeLink(
      async () => banner(), // never reached -- connect() fails first
      () => Promise.reject(new Error("no reply")),
    ));

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
    registry.onFlashResult((_endpointId, _source, status, message) => results.push({ status, message }));

    registry.start();
    await waitForSnapshot(registry, (s) => s[0]?.sessionError !== undefined);
    const createLinkCallsBefore = createLink.mock.calls.length;

    await registry.requestFlash("usb-SERIAL-A", releaseSource("relay"));

    expect(results).toEqual([{ status: "error", message: "write failed at page 3" }]);
    const snap = registry.snapshot();
    expect(snap[0]?.flashStatus).toBeUndefined();
    expect(snap[0]?.sessionOpen).toBe(false);
    // A failed flash never attempts to reopen -- nothing new to identify.
    expect(createLink.mock.calls.length).toBe(createLinkCallsBefore);

    await registry.stop();
  });

  it("an unconfigured firmware source ends in an error result without calling releases.ts or flash.ts", async () => {
    const devices = [device()];
    const watcher = fixtureWatcher(() => devices);
    const resolveName = async () => namedResult("zeguz");
    const createLink = () => new FakeLink(
      async () => banner(), // never reached -- connect() fails first
      () => Promise.reject(new Error("no reply")),
    );

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
    registry.onFlashResult((_endpointId, _source, status, message) => results.push({ status, message }));

    registry.start();
    await waitForSnapshot(registry, (s) => s[0]?.sessionError !== undefined);

    await registry.requestFlash("usb-SERIAL-A", releaseSource("relay"));

    expect(resolveReleaseFn).not.toHaveBeenCalled();
    expect(fetchAndVerifyHexFn).not.toHaveBeenCalled();
    expect(flashFn).not.toHaveBeenCalled();
    expect(results).toEqual([{ status: "error", message: expect.stringContaining("relay") }]);
    expect(registry.snapshot()[0]?.flashStatus).toBeUndefined();

    await registry.stop();
  });

  it("requestFlash for an unknown endpointId reports via onError, never throws", async () => {
    const registry = new DeviceRegistry({
      watcher: fixtureWatcher(() => []),
      getFirmwareConfig: configWith(firmwareSource()),
    });
    const errors: Array<{ endpointId: string | undefined; message: string }> = [];
    registry.onError((endpointId, message) => errors.push({ endpointId, message }));

    await expect(registry.requestFlash("no-such-device", releaseSource("relay"))).resolves.toBeUndefined();
    expect(errors).toContainEqual({ endpointId: "no-such-device", message: "no such device: no-such-device" });

    await registry.stop();
  });

  it("serializes requestFlash against a concurrent requestOpen on the same device (never interleaved)", async () => {
    const order: string[] = [];
    const devices = [device()];
    const watcher = fixtureWatcher(() => devices);
    const resolveName = async () => namedResult("zeguz");
    const createLink = () => new FakeLink(
      async () => banner(), // never reached -- connect() fails first
      () => Promise.reject(new Error("no reply")),
    );

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
    await waitForSnapshot(registry, (s) => s[0]?.sessionError !== undefined);

    // Issued back-to-back for the same device: requestFlash's mutex slot
    // is claimed first, so requestOpen's own work must wait for the
    // entire flash task (including the slow "network" resolve step) to
    // finish before it ever runs -- the core mutex guarantee this
    // ticket relies on.
    const flashPromise = registry
      .requestFlash("usb-SERIAL-A", releaseSource("relay"))
      .then(() => order.push("flash-done"));
    const openPromise = registry.requestOpen("usb-SERIAL-A").then(() => order.push("open-done"));

    await Promise.all([flashPromise, openPromise]);

    expect(order).toEqual(["flash-resolve-start", "flash-resolve-end", "flash-done", "open-done"]);

    await registry.stop();
  });
});

// ---------------------------------------------------------------------
// requestFlash -- local-hex source (sprint 4 ticket 005). The
// consumeUpload seam stands in for localHexUpload.ts's
// LocalHexUploadManager#consumeUpload -- server.ts wires the real one;
// these tests exercise only DeviceRegistry's own branch on
// source.kind, per this file's "never test against real hardware"
// precedent.
// ---------------------------------------------------------------------

type LocalHexSourceRef = Extract<FirmwareSourceRef, { kind: "local-hex" }>;

function localHexSource(overrides: Partial<LocalHexSourceRef> = {}): LocalHexSourceRef {
  return {
    kind: "local-hex",
    uploadId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
    fileName: "my-firmware.hex",
    sha256: "d".repeat(64),
    ...overrides,
  };
}

describe("DeviceRegistry — requestFlash (local-hex source)", () => {
  it("flashes the consumed upload bytes through the unchanged flash.ts pipeline, skipping the fetching phase", async () => {
    const devices = [device()];
    const watcher = fixtureWatcher(() => devices);
    const resolveName = async () => namedResult("zeguz");
    const createLink = () => new FakeLink(async () => banner());

    const uploadedHex = Buffer.from(":10000000AABBCCDD00000000000000000000005A\n:00000001FF\n", "utf-8");
    const consumeUploadFn = vi.fn((uploadId: string) =>
      uploadId === "3fa85f64-5717-4562-b3fc-2c963f66afa6" ? uploadedHex : undefined,
    );

    let observedHexText: string | undefined;
    const flashFn = vi.fn(
      async (
        _device: DaplinkDevice,
        hexText: string,
        onProgress: (phase: FlashPhase) => void,
      ): Promise<FlashOutcome> => {
        observedHexText = hexText;
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
      consumeUpload: consumeUploadFn,
      flash: flashFn,
    });

    const progress: Array<{ source: FirmwareSourceRef; phase: FlashPhase }> = [];
    const results: FlashResultEvent[] = [];
    registry.onFlashProgress((endpointId, source, phase) => progress.push({ source, phase }));
    registry.onFlashResult((endpointId, source, status, message, classification, name, reidentify) =>
      results.push({ endpointId, source, status, message, classification, name, reidentify }),
    );

    registry.start();
    await waitForSnapshot(registry, (s) => s[0]?.sessionOpen === true);

    const source = localHexSource();
    await registry.requestFlash("usb-SERIAL-A", source);

    // No "fetching" phase for a local-hex source -- the bytes already
    // arrived over the socket; verification already happened at upload
    // time (localHexUpload.ts), so "verifying" here is a display-only
    // formality before the real write phases.
    expect(progress.map((p) => p.phase)).toEqual(["verifying", "erasing", "writing", "resetting", "reidentifying"]);
    // Every progress event echoes the exact source the flash was
    // requested with, including its fileName/sha256 -- not just the
    // uploadId.
    for (const p of progress) {
      expect(p.source).toEqual(source);
    }

    expect(consumeUploadFn).toHaveBeenCalledWith(source.uploadId);
    expect(observedHexText).toBe(uploadedHex.toString("utf-8"));

    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe("ok");
    expect(results[0]?.source).toEqual(source);
    expect(results[0]?.message).toBeUndefined();

    await registry.stop();
  });

  it("an unknown/already-consumed uploadId ends in a flash-result error without ever calling flash.ts", async () => {
    const devices = [device()];
    const watcher = fixtureWatcher(() => devices);
    const resolveName = async () => namedResult("zeguz");
    const createLink = () => new FakeLink(async () => banner());

    // Always reports "not found" -- stands in for an expired, unknown,
    // or already-consumed uploadId (localHexUpload.ts's own
    // consumeUpload contract: undefined for all three cases).
    const consumeUploadFn = vi.fn((_uploadId: string) => undefined);
    const flashFn = vi.fn(async (): Promise<FlashOutcome> => ({ status: "ok", method: "swd" }));

    const registry = new DeviceRegistry({
      watcher,
      resolveName,
      createLink,
      consumeUpload: consumeUploadFn,
      flash: flashFn,
    });

    const results: FlashResultEvent[] = [];
    registry.onFlashResult((endpointId, source, status, message, classification, name, reidentify) =>
      results.push({ endpointId, source, status, message, classification, name, reidentify }),
    );

    registry.start();
    await waitForSnapshot(registry, (s) => s[0]?.sessionOpen === true);

    const source = localHexSource({ uploadId: "00000000-0000-0000-0000-000000000000" });
    await expect(registry.requestFlash("usb-SERIAL-A", source)).resolves.toBeUndefined();

    expect(flashFn).not.toHaveBeenCalled();
    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe("error");
    expect(results[0]?.message).toEqual(expect.stringContaining(source.uploadId));
    expect(registry.snapshot()[0]?.flashStatus).toBeUndefined();

    await registry.stop();
  });
});

// ---------------------------------------------------------------------
// KeyedMutex -- the mechanism sprint 7's relay (many endpoints, one
// shared resourceKey) will lean on for real. No second transport exists
// yet this sprint (see the ticket's own scope note), so this exercises
// the mutex directly: two different "logical" callers issuing run()
// under the *same* resourceKey string are still serialized against each
// other, exactly as if one caller had issued both tasks -- the mutex
// has no notion of which caller a task belongs to, only the key it was
// queued under.
// ---------------------------------------------------------------------

describe("KeyedMutex", () => {
  it("serializes two run() calls sharing one resourceKey regardless of which logical caller issued them", async () => {
    const mutex = new KeyedMutex();
    const order: string[] = [];
    const RELAY_PORT_RESOURCE_KEY = "usb-RELAY-SERIAL";

    // "robot-a" and "robot-b" stand in for two logical targets reached
    // through one relay in sprint 7 -- both contend for the relay's one
    // physical USB port, so both run() calls below share one
    // resourceKey even though nothing else about them is related.
    const robotATask = mutex.run(RELAY_PORT_RESOURCE_KEY, async () => {
      order.push("robot-a-start");
      await new Promise((resolve) => setTimeout(resolve, 10));
      order.push("robot-a-end");
    });
    const robotBTask = mutex.run(RELAY_PORT_RESOURCE_KEY, async () => {
      order.push("robot-b-start");
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push("robot-b-end");
    });

    await Promise.all([robotATask, robotBTask]);

    // robot-b's task never starts until robot-a's fully finishes --
    // "run() serialized under a shared resourceKey" is exactly the
    // guarantee DeviceRegistry relies on for every one of its own
    // per-endpoint operations today (requestOpen/requestClose/sendLine/
    // requestFlash), and what a relay's several endpoints will rely on
    // in sprint 7.
    expect(order).toEqual(["robot-a-start", "robot-a-end", "robot-b-start", "robot-b-end"]);
  });

  it("runs tasks under different resourceKeys fully in parallel", async () => {
    const mutex = new KeyedMutex();
    const order: string[] = [];

    const taskA = mutex.run("usb-SERIAL-A", async () => {
      order.push("a-start");
      await new Promise((resolve) => setTimeout(resolve, 10));
      order.push("a-end");
    });
    const taskB = mutex.run("usb-SERIAL-B", async () => {
      order.push("b-start");
      await new Promise((resolve) => setTimeout(resolve, 1));
      order.push("b-end");
    });

    await Promise.all([taskA, taskB]);

    // b (shorter delay, different key) finishes before a even though a
    // started first -- proof the two keys never queue behind each other.
    expect(order).toEqual(["a-start", "b-start", "b-end", "a-end"]);
  });
});
