import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import type { DecodedLine, ParsedBanner } from "@robot-console/protocol";
import { DeviceWatcher, type DaplinkDevice } from "./devices.js";
import { DeviceRegistry, type DeviceRegistryOptions, type UsbSerialLinkLike } from "./deviceRegistry.js";
import type { FirmwareConfigMap, FirmwareSource } from "./config.js";
import { FirmwareAvailabilityCache, type ResolvedRelease } from "./releases.js";
import { startServer, type RunningServer } from "./server.js";
import type { FlashPhase, ServerMessage } from "./wsMessages.js";

// Per the ticket's Testing section: a full end-to-end WebSocket round
// trip -- a real Express/`ws` server, a real WebSocket client, and fake
// underlying device/link modules (no real hardware) -- since that does
// not require hardware, only devices.ts/UsbSerialLink's own seams.

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

function banner(overrides: Partial<ParsedBanner> = {}): ParsedBanner {
  return {
    role: "NEZHA2",
    commonName: "robot",
    name: "zeguz",
    serial: 123,
    dialect: "space",
    ...overrides,
  };
}

class FakeLink implements UsbSerialLinkLike {
  sentLines: string[] = [];
  private lineListeners = new Set<(line: DecodedLine) => void>();
  private errorListeners = new Set<(err: Error) => void>();

  constructor(private readonly openImpl: () => Promise<ParsedBanner>) {}

  open(): Promise<ParsedBanner> {
    return this.openImpl();
  }

  close(): Promise<void> {
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
}

function buildRegistry(link: FakeLink, overrides: DeviceRegistryOptions = {}): DeviceRegistry {
  const watcher = new DeviceWatcher({
    listDevices: () => Promise.resolve([device()]),
    pollIntervalMs: 3_600_000,
  });
  return new DeviceRegistry({
    watcher,
    resolveName: async () => ({ status: "named", name: "zeguz", deviceId: 1 }),
    createLink: () => link,
    ...overrides,
  });
}

// ---------------------------------------------------------------------
// Flash/firmware-status fixtures (sprint 2, ticket 006) -- fully
// synthetic fakes for config.ts/releases.ts/flash.ts, following this
// file's own "no real hardware/network" precedent (see the module doc
// comment above).
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

/** A fixture `getFirmwareConfig`-shaped accessor -- the same injection
 * seam `deviceRegistry.test.ts` uses in place of `config.ts`'s real
 * environment/dotconfig read. */
function configWith(relay?: FirmwareSource, robot?: FirmwareSource): () => FirmwareConfigMap {
  return () => ({ relay, robot });
}

/** Collect parsed messages from a WebSocket client until `predicate`
 * matches one, or a timeout elapses. Buffers every message from the
 * moment it is constructed (not from whenever `waitFor` happens to be
 * called), and checks already-received messages before waiting for a
 * new one -- otherwise a message that arrives between the socket's
 * `"open"` event and a caller getting around to attaching a listener
 * (server.ts sends the initial devices snapshot synchronously in its
 * own `"connection"` handler, so this is a real race, not a
 * theoretical one) would be missed entirely and the wait would hang
 * until timeout. */
class MessageCollector {
  private readonly received: ServerMessage[] = [];
  private readonly waiters: Array<{
    predicate: (message: ServerMessage) => boolean;
    resolve: (message: ServerMessage) => void;
  }> = [];

  constructor(ws: WebSocket) {
    ws.on("message", (data: WebSocket.RawData) => {
      const message = JSON.parse(data.toString()) as ServerMessage;
      this.received.push(message);
      const index = this.waiters.findIndex((w) => w.predicate(message));
      if (index >= 0) {
        const [waiter] = this.waiters.splice(index, 1);
        waiter?.resolve(message);
      }
    });
  }

  waitFor(predicate: (message: ServerMessage) => boolean, timeoutMs = 5000): Promise<ServerMessage> {
    const existing = this.received.find(predicate);
    if (existing) {
      return Promise.resolve(existing);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.waiters.findIndex((w) => w.resolve === resolveAndClear);
        if (index >= 0) {
          this.waiters.splice(index, 1);
        }
        reject(
          new Error(
            `MessageCollector.waitFor: timed out; received so far: ${JSON.stringify(this.received)}`,
          ),
        );
      }, timeoutMs);
      const resolveAndClear = (message: ServerMessage): void => {
        clearTimeout(timer);
        resolve(message);
      };
      this.waiters.push({ predicate, resolve: resolveAndClear });
    });
  }
}

/** Connect and start collecting messages in the same synchronous step
 * the socket is constructed in -- see {@link MessageCollector}'s doc
 * comment for why that matters. */
function connect(url: string): Promise<{ ws: WebSocket; messages: MessageCollector }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const messages = new MessageCollector(ws);
    ws.once("open", () => resolve({ ws, messages }));
    ws.once("error", reject);
  });
}

/** No firmware configured, injected explicitly so these tests never
 * read the developer's own repo-root `.env`. Without this they pass or
 * fail depending on whether `dotconfig load` has been run on the
 * machine -- which is exactly how this file started failing once a real
 * `.env` appeared. */
const NO_FIRMWARE: FirmwareConfigMap = { relay: undefined, robot: undefined };

describe("server.ts end-to-end (fake device/link modules, real Express/ws)", () => {
  let server: RunningServer | undefined;
  let ws: WebSocket | undefined;

  afterEach(async () => {
    ws?.close();
    ws = undefined;
    await server?.close();
    server = undefined;
  });

  it("binds to localhost only", async () => {
    const link = new FakeLink(async () => banner());
    server = await startServer({ port: 0, registry: buildRegistry(link), firmwareConfig: NO_FIRMWARE });
    expect(server.host).toBe("127.0.0.1");
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it("sends a devices snapshot on connect, then a live-updated one with name/role resolved", async () => {
    const link = new FakeLink(async () => banner());
    server = await startServer({ port: 0, registry: buildRegistry(link), firmwareConfig: NO_FIRMWARE });
    const connected = await connect(server.url.replace("http://", "ws://"));
    ws = connected.ws;

    const resolved = await connected.messages.waitFor(
      (m) => m.type === "devices" && m.devices[0]?.role === "NEZHA2",
    );
    expect(resolved).toEqual({
      type: "devices",
      devices: [
        expect.objectContaining({
          id: "SERIAL-A",
          serialNumber: "SERIAL-A",
          displaySerial: "SHORT-A",
          name: "zeguz",
          role: "NEZHA2",
          port: "/dev/cu.usbmodemA",
          linkOpen: true,
        }),
      ],
      // Ticket 006: every `devices` broadcast carries `firmwareStatus`,
      // built from the availability cache -- no `firmwareConfig`/
      // `availabilityCache` override was passed to `startServer` here,
      // so this exercises the real default (`getFirmwareConfig()` off
      // this test process's real, firmware-var-free environment) rather
      // than a fixture, and confirms it degrades to "not configured"
      // rather than throwing or omitting the field.
      firmwareStatus: {
        relay: { configured: false },
        robot: { configured: false },
      },
    });
  });

  it("round-trips a line: client sends a line for a device and receives its reply", async () => {
    const link = new FakeLink(async () => banner());
    server = await startServer({ port: 0, registry: buildRegistry(link), firmwareConfig: NO_FIRMWARE });
    const connected = await connect(server.url.replace("http://", "ws://"));
    ws = connected.ws;

    await connected.messages.waitFor((m) => m.type === "devices" && m.devices[0]?.linkOpen === true);

    ws.send(JSON.stringify({ type: "line", deviceId: "SERIAL-A", direction: "tx", line: "HELLO" }));

    // Server echoes the sent line back to every client...
    const echoed = await connected.messages.waitFor((m) => m.type === "line" && m.direction === "tx");
    expect(echoed).toEqual({ type: "line", deviceId: "SERIAL-A", direction: "tx", line: "HELLO" });
    expect(link.sentLines).toEqual(["HELLO"]);

    // ...and once the fake device "replies", the client sees that too.
    link.emitLine({ kind: "line", verb: "status", fields: ["mode=idle"] });
    const reply = await connected.messages.waitFor((m) => m.type === "line" && m.direction === "rx");
    expect(reply).toEqual({ type: "line", deviceId: "SERIAL-A", direction: "rx", line: "status mode=idle" });
  });

  it("reports a graceful error, not a crash, for a line sent to a device with no open link", async () => {
    // Mirrors the real UsbSerialLink against a silent board: open()
    // eventually rejects (a bounded timeout in production; a short
    // delay here) rather than ever resolving. DeviceRegistry serializes
    // open/send per device, so sendLine() sent while this is still in
    // flight is queued behind it and observes the settled (failed)
    // state -- see deviceRegistry.ts's "serializes name-read and
    // link-open" test for the same guarantee in isolation.
    const link = new FakeLink(
      () =>
        new Promise<ParsedBanner>((_resolve, reject) => {
          setTimeout(() => reject(new Error("timed out waiting for a HELLO banner reply")), 20);
        }),
    );
    server = await startServer({ port: 0, registry: buildRegistry(link), firmwareConfig: NO_FIRMWARE });
    const connected = await connect(server.url.replace("http://", "ws://"));
    ws = connected.ws;

    await connected.messages.waitFor((m) => m.type === "devices" && m.devices.length === 1);
    ws.send(JSON.stringify({ type: "line", deviceId: "SERIAL-A", direction: "tx", line: "HELLO" }));

    const error = await connected.messages.waitFor((m) => m.type === "error");
    expect(error).toEqual({
      type: "error",
      deviceId: "SERIAL-A",
      message: "device SERIAL-A has no open link",
    });
  });

  it("reports a graceful error for a malformed client message instead of closing the connection", async () => {
    const link = new FakeLink(async () => banner());
    server = await startServer({ port: 0, registry: buildRegistry(link), firmwareConfig: NO_FIRMWARE });
    const connected = await connect(server.url.replace("http://", "ws://"));
    ws = connected.ws;

    await connected.messages.waitFor((m) => m.type === "devices");
    ws.send("not json");

    const error = await connected.messages.waitFor((m) => m.type === "error");
    expect(error).toEqual({ type: "error", message: "malformed JSON message" });
    expect(ws.readyState).toBe(WebSocket.OPEN);
  });

  it("fails clearly, rather than silently picking another port, when the port is already in use", async () => {
    const link = new FakeLink(async () => banner());
    server = await startServer({ port: 0, registry: buildRegistry(link), firmwareConfig: NO_FIRMWARE });

    await expect(
      startServer({
        port: server.port,
        registry: buildRegistry(new FakeLink(async () => banner())),
        firmwareConfig: NO_FIRMWARE,
      }),
    ).rejects.toThrow(/already in use/);
  });
});

describe("server.ts flash wiring (sprint 2, ticket 006)", () => {
  let server: RunningServer | undefined;
  let sockets: WebSocket[] = [];

  afterEach(async () => {
    for (const socket of sockets) {
      socket.close();
    }
    sockets = [];
    await server?.close();
    server = undefined;
  });

  async function connectTracked(url: string): Promise<{ ws: WebSocket; messages: MessageCollector }> {
    const connected = await connect(url);
    sockets.push(connected.ws);
    return connected;
  }

  it("routes a flash-start message to registry.requestFlash and broadcasts flash-progress/flash-result to every connected client", async () => {
    const link = new FakeLink(async () => banner());
    const resolveReleaseFn = vi.fn(async (): Promise<ResolvedRelease> => resolvedRelease());
    const fetchAndVerifyHexFn = vi.fn(async () => ({ hex: Buffer.from(":00000001FF\n", "utf-8") }));
    const flashFn = vi.fn(
      async (
        _device: DaplinkDevice,
        _hexText: string,
        onProgress: (phase: FlashPhase) => void,
      ) => {
        onProgress("erasing");
        onProgress("writing");
        onProgress("resetting");
        return { status: "ok" as const, method: "swd" as const };
      },
    );
    const registry = buildRegistry(link, {
      getFirmwareConfig: configWith(firmwareSource()),
      resolveRelease: resolveReleaseFn,
      fetchAndVerifyHex: fetchAndVerifyHexFn,
      flash: flashFn,
    });

    server = await startServer({ port: 0, registry, firmwareConfig: NO_FIRMWARE });
    const first = await connectTracked(server.url.replace("http://", "ws://"));
    // A second, independently-connected client -- proves the broadcast
    // reaches every connected socket, not just the one that sent
    // flash-start (per the ticket's own "visible to a second connected
    // tab too" requirement).
    const second = await connectTracked(server.url.replace("http://", "ws://"));

    await first.messages.waitFor((m) => m.type === "devices" && m.devices[0]?.linkOpen === true);

    first.ws.send(JSON.stringify({ type: "flash-start", deviceId: "SERIAL-A", firmware: "relay" }));

    const progressOnFirst = await first.messages.waitFor((m) => m.type === "flash-progress");
    expect(progressOnFirst).toEqual({
      type: "flash-progress",
      deviceId: "SERIAL-A",
      firmware: "relay",
      phase: "fetching",
    });

    const resultOnFirst = await first.messages.waitFor((m) => m.type === "flash-result");
    expect(resultOnFirst).toEqual({
      type: "flash-result",
      deviceId: "SERIAL-A",
      firmware: "relay",
      status: "ok",
    });

    // The requester's own client saw it; confirm the *other* connected
    // client did too.
    const resultOnSecond = await second.messages.waitFor((m) => m.type === "flash-result");
    expect(resultOnSecond).toEqual({
      type: "flash-result",
      deviceId: "SERIAL-A",
      firmware: "relay",
      status: "ok",
    });

    expect(resolveReleaseFn).toHaveBeenCalledTimes(1);
    expect(fetchAndVerifyHexFn).toHaveBeenCalledTimes(1);
    expect(flashFn).toHaveBeenCalledTimes(1);
  });
});

describe("server.ts firmwareStatus (sprint 2, ticket 006)", () => {
  let server: RunningServer | undefined;
  let ws: WebSocket | undefined;

  afterEach(async () => {
    ws?.close();
    ws = undefined;
    await server?.close();
    server = undefined;
  });

  it("includes firmwareStatus, built from the availability cache, on the initial connect snapshot", async () => {
    const link = new FakeLink(async () => banner());
    const checkAvailabilityFn = vi.fn(async () => ({ available: true }));
    const availabilityCache = new FirmwareAvailabilityCache(
      { relay: firmwareSource(), robot: undefined },
      { checkAvailability: checkAvailabilityFn },
    );
    // Deterministic: drive the poll directly rather than waiting on the
    // cache's real interval timer (never started here since `start()`
    // itself does not poll immediately -- see releases.ts).
    await availabilityCache.pollOnce();

    server = await startServer({ port: 0, registry: buildRegistry(link), availabilityCache });
    const connected = await connect(server.url.replace("http://", "ws://"));
    ws = connected.ws;

    const initial = await connected.messages.waitFor((m) => m.type === "devices");
    expect(initial).toMatchObject({
      type: "devices",
      firmwareStatus: {
        relay: { configured: true, repoUrl: firmwareSource().repoUrl, tag: "latest", available: true },
        robot: { configured: false },
      },
    });
    // Exactly the one explicit pollOnce() call above drove the check --
    // startServer()/availabilityCache.start() itself does not poll
    // immediately (see releases.ts), so this is deterministic with no
    // real timer/network dependency.
    expect(checkAvailabilityFn).toHaveBeenCalledTimes(1);
  });

  it("re-broadcasts the device snapshot with updated firmwareStatus when the availability cache changes, with no client action", async () => {
    const link = new FakeLink(async () => banner());
    let available = false;
    const checkAvailabilityFn = vi.fn(async () =>
      available ? { available: true } : { available: false, reason: "no-releases" },
    );
    const availabilityCache = new FirmwareAvailabilityCache(
      { relay: undefined, robot: firmwareSource({ repoUrl: "https://github.com/org/robot-firmware" }) },
      { checkAvailability: checkAvailabilityFn },
    );
    await availabilityCache.pollOnce();

    server = await startServer({ port: 0, registry: buildRegistry(link), availabilityCache });
    const connected = await connect(server.url.replace("http://", "ws://"));
    ws = connected.ws;

    const initial = await connected.messages.waitFor((m) => m.type === "devices");
    expect(initial).toMatchObject({ firmwareStatus: { robot: { configured: true, available: false } } });

    // The poll (not any client message) is what flips this -- simulating
    // pxt-nezha-diffdrive cutting its first release.
    available = true;
    await availabilityCache.pollOnce();

    const updated = await connected.messages.waitFor(
      (m) =>
        m.type === "devices" &&
        m.firmwareStatus.robot.configured === true &&
        m.firmwareStatus.robot.available === true,
    );
    expect(updated).toMatchObject({
      type: "devices",
      firmwareStatus: {
        relay: { configured: false },
        robot: {
          configured: true,
          repoUrl: "https://github.com/org/robot-firmware",
          tag: "latest",
          available: true,
        },
      },
    });
  });

  it("stops the availability cache's poll timer when the server closes, leaving no live handle", async () => {
    const link = new FakeLink(async () => banner());
    const availabilityCache = new FirmwareAvailabilityCache(
      { relay: firmwareSource(), robot: undefined },
      { checkAvailability: async () => ({ available: false, reason: "no-releases" }), pollIntervalMs: 5 },
    );
    const stopSpy = vi.spyOn(availabilityCache, "stop");

    server = await startServer({ port: 0, registry: buildRegistry(link), availabilityCache });
    await server.close();
    server = undefined;

    expect(stopSpy).toHaveBeenCalledTimes(1);
  });
});
