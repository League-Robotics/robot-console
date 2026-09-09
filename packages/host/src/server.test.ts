import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { Session, type AckNackEvent, type DecodedLine, type ParsedBanner, type WireField } from "@robot-console/protocol";
import { DeviceWatcher, type DaplinkDevice } from "./devices.js";
import { DeviceRegistry, type DeviceRegistryOptions } from "./deviceRegistry.js";
import type { Link } from "./link/Link.js";
import type { FirmwareConfigMap, FirmwareSource } from "./config.js";
import { LocalHexUploadManager } from "./localHexUpload.js";
import { FirmwareAvailabilityCache, type ResolvedRelease } from "./releases.js";
import { startServer, type RunningServer } from "./server.js";
import { KnownRobotsStore, type KnownRobotRecord } from "./store/knownRobots.js";
import { UPLOAD_ID_BYTE_LENGTH, type FlashPhase, type ServerMessage } from "./wsMessages.js";
import type { MdnsDiscovery } from "./discovery/mdnsDiscovery.js";

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

/** See `deviceRegistry.test.ts`'s own `FakeLink` for the full doc
 * comment on the `connect()`/`identify()` split this implements --
 * `connectImpl` defaults to an immediately-succeeding transport since
 * every test here except the "no open link" one below cares only about
 * `identify()`'s outcome. */
class FakeLink implements Link {
  readonly session = new Session();
  sentLines: string[] = [];
  private lineListeners = new Set<(line: DecodedLine) => void>();
  private ackNackListeners = new Set<(event: AckNackEvent) => void>();
  private errorListeners = new Set<(err: Error) => void>();

  constructor(
    private readonly identifyImpl: () => Promise<ParsedBanner | null>,
    private readonly connectImpl: () => Promise<void> = () => Promise.resolve(),
  ) {}

  connect(): Promise<void> {
    return this.connectImpl();
  }

  identify(): Promise<ParsedBanner | null> {
    return this.identifyImpl();
  }

  close(): Promise<void> {
    return Promise.resolve();
  }

  sendLine(line: string): void {
    this.sentLines.push(line);
  }

  sendCommand(verb: string, fields: readonly WireField[] = []): string {
    const line = this.session.send(verb, fields);
    this.sentLines.push(line);
    return line;
  }

  sendUnsequenced(verb: string, fields: readonly WireField[] = []): string {
    const line = this.session.sendUnsequenced(verb, fields);
    this.sentLines.push(line);
    return line;
  }

  checkLiveness(): void {
    // Not exercised here -- no-op.
  }

  onLine(listener: (line: DecodedLine) => void): () => void {
    this.lineListeners.add(listener);
    return () => {
      this.lineListeners.delete(listener);
    };
  }

  private rawLineListeners = new Set<(raw: string) => void>();
  onRawLine(listener: (raw: string) => void): () => void {
    this.rawLineListeners.add(listener);
    return () => {
      this.rawLineListeners.delete(listener);
    };
  }

  emitRawLine(raw: string): void {
    for (const listener of this.rawLineListeners) {
      listener(raw);
    }
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
}

/** A fixture {@link KnownRobotRecord}, following this file's own
 * `device()`/`banner()` "sensible defaults, override what a test cares
 * about" pattern. `name` deliberately differs from `banner()`'s
 * "zeguz" -- a remembered-robot fixture and the live-attached device in
 * these tests must never collide, since `DeviceRegistry.rememberedRobots()`
 * (ticket 003) excludes whatever is currently attached. */
function knownRobotRecord(overrides: Partial<KnownRobotRecord> = {}): KnownRobotRecord {
  return {
    name: "kwazi",
    firstSeenAt: "2024-01-01T00:00:00.000Z",
    lastSeenAt: "2024-01-01T00:00:00.000Z",
    lastSeenVia: "usb",
    lastUsbSerial: "SERIAL-REMEMBERED",
    lastRole: "NEZHA2",
    lastType: "robot",
    ...overrides,
  };
}

/** An in-memory fake {@link KnownRobotsStore}, mirroring
 * `deviceRegistry.test.ts`'s own "records the exact recordSighting call
 * shape (fake store)" fixture (`as unknown as KnownRobotsStore`) rather
 * than a real, temp-directory-backed one -- `knownRobots.test.ts`
 * already covers the real store's own persistence/atomic-write
 * behavior in isolation, so nothing here needs real filesystem I/O.
 * `forget` is a real, mutating no-op-on-unknown-name implementation
 * (matching {@link KnownRobotsStore.forget}'s own contract) since these
 * tests care about the observable effect of a forget round-tripping
 * through `server.ts`. */
function fakeKnownRobotsStore(initial: KnownRobotRecord[] = []): KnownRobotsStore {
  const records = new Map(initial.map((record) => [record.name, record]));
  return {
    list: () => [...records.values()],
    get: (name: string) => records.get(name),
    recordSighting: () => {},
    forget: (name: string) => records.delete(name),
    flush: async () => {},
    isReadOnly: false,
  } as unknown as KnownRobotsStore;
}

/** Sprint 8 ticket 004: a fully synthetic {@link MdnsDiscovery}, never
 * the real `bonjour-service`-backed default (which would depend on --
 * and reach out onto -- whatever LAN the suite happens to run on,
 * exactly the "environment leak" {@link fakeKnownRobotsStore}'s own doc
 * comment already guards against for the remembered-robot roster).
 * Static: `onChange` never fires, matching every test here that only
 * ever reads `EndpointsMessage.discoveredServices` from an already-built
 * snapshot rather than a live update. */
function fakeMdnsDiscovery(
  snapshot: { relays?: unknown[]; robots?: unknown[] } = {},
): MdnsDiscovery {
  return {
    current: () => ({ relays: snapshot.relays ?? [], robots: snapshot.robots ?? [] }),
    onChange: () => () => {},
    start: () => {},
    stop: () => {},
  } as unknown as MdnsDiscovery;
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
    // The host's own robot probes (OOP 2026-09-09: automatic FUNCS +
    // periodic STATUS) stay off here so every test below sees exactly
    // the lines it sent -- they have their own coverage in
    // deviceRegistry.test.ts.
    statusPollIntervalMs: 0,
    autoRequestFunctions: false,
    // Sprint 5: default to an empty, in-memory fake store rather than
    // DeviceRegistry's own default (a real KnownRobotsStore reading
    // this machine's actual ~/.local/state roster) -- without this
    // override, every test's `rememberedRobots` assertion would depend
    // on whatever roster happens to exist on the machine running the
    // suite, exactly the kind of environment leak `NO_FIRMWARE` (below)
    // already guards against for firmwareConfig. A test that cares
    // about a non-empty roster overrides `knownRobotsStore` itself.
    knownRobotsStore: fakeKnownRobotsStore(),
    // Sprint 8 ticket 004: same "never the real, environment-dependent
    // default" rationale as knownRobotsStore just above -- see
    // fakeMdnsDiscovery's own doc comment.
    mdnsDiscovery: fakeMdnsDiscovery(),
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

  /** Every message received so far, for a test that needs to assert an
   * absence (e.g. "no error was ever sent") rather than wait for a
   * presence -- {@link waitFor} alone cannot express that. */
  get all(): readonly ServerMessage[] {
    return this.received;
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

  it("sends an endpoints snapshot on connect, then a live-updated one with name/role resolved", async () => {
    const link = new FakeLink(async () => banner());
    server = await startServer({ port: 0, registry: buildRegistry(link), firmwareConfig: NO_FIRMWARE });
    const connected = await connect(server.url.replace("http://", "ws://"));
    ws = connected.ws;

    const resolved = await connected.messages.waitFor(
      (m) => m.type === "endpoints" && m.endpoints[0]?.role === "NEZHA2",
    );
    expect(resolved).toEqual({
      type: "endpoints",
      endpoints: [
        expect.objectContaining({
          endpointId: "usb-SERIAL-A",
          transport: "usb",
          resourceKey: "usb-SERIAL-A",
          classification: expect.objectContaining({ type: "robot" }),
          name: "zeguz",
          role: "NEZHA2",
          sessionOpen: true,
          usb: {
            serialNumber: "SERIAL-A",
            displaySerial: "SHORT-A",
            port: "/dev/cu.usbmodemA",
          },
        }),
      ],
      // Every `endpoints` broadcast carries `firmwareStatus`, built from
      // the availability cache -- no `firmwareConfig`/
      // `availabilityCache` override was passed to `startServer` here,
      // so this exercises the real default (`getFirmwareConfig()` off
      // this test process's real, firmware-var-free environment) rather
      // than a fixture, and confirms it degrades to "not configured"
      // rather than throwing or omitting the field.
      firmwareStatus: {
        relay: { configured: false },
        robot: { configured: false },
      },
      rememberedRobots: [],
      // Sprint 8 ticket 004: always present, mirroring rememberedRobots'
      // own "empty array, never an omitted field" discipline -- no
      // mdnsDiscovery override was passed to buildRegistry here, so this
      // exercises fakeMdnsDiscovery()'s own empty default.
      discoveredServices: { relays: [], robots: [] },
    });
  });

  it("includes registry.discoveredServices() (relays + robots) in every endpoints snapshot (sprint 8 ticket 004)", async () => {
    const link = new FakeLink(async () => banner());
    const mdnsDiscovery = fakeMdnsDiscovery({
      relays: [{ instanceName: "torture", host: "torture.local", port: 8760, registryPort: 8761 }],
      robots: [{ instanceName: "gopiv", host: "gopiv.local", port: 9000 }],
    });
    server = await startServer({
      port: 0,
      registry: buildRegistry(link, { mdnsDiscovery }),
      firmwareConfig: NO_FIRMWARE,
    });
    const connected = await connect(server.url.replace("http://", "ws://"));
    ws = connected.ws;

    const initial = await connected.messages.waitFor((m) => m.type === "endpoints");
    expect(initial).toMatchObject({
      discoveredServices: {
        relays: [{ instanceName: "torture", host: "torture.local", port: 8760, registryPort: 8761 }],
        robots: [{ instanceName: "gopiv", host: "gopiv.local", port: 9000 }],
      },
    });
  });

  it("round-trips a line: client sends a line for a device and receives its reply", async () => {
    const link = new FakeLink(async () => banner());
    server = await startServer({ port: 0, registry: buildRegistry(link), firmwareConfig: NO_FIRMWARE });
    const connected = await connect(server.url.replace("http://", "ws://"));
    ws = connected.ws;

    await connected.messages.waitFor((m) => m.type === "endpoints" && m.endpoints[0]?.sessionOpen === true);

    // Any raw line other than HELLO -- see the dedicated raw-HELLO
    // resync test below for why HELLO itself is intercepted rather than
    // written verbatim (deviceRegistry.ts's own `sendLine` doc comment).
    ws.send(JSON.stringify({ type: "line", endpointId: "usb-SERIAL-A", direction: "tx", line: "STATUS" }));

    // Server echoes the sent line back to every client...
    const echoed = await connected.messages.waitFor((m) => m.type === "line" && m.direction === "tx");
    expect(echoed).toEqual({ type: "line", endpointId: "usb-SERIAL-A", direction: "tx", line: "STATUS" });
    expect(link.sentLines).toEqual(["STATUS"]);

    // ...and once the fake device "replies", the client sees that too.
    link.emitLine({ kind: "line", verb: "status", fields: ["mode=idle"] });
    const reply = await connected.messages.waitFor((m) => m.type === "line" && m.direction === "rx");
    expect(reply).toEqual({ type: "line", endpointId: "usb-SERIAL-A", direction: "rx", line: "status mode=idle" });
  });

  it("forwards robotName and radio from a session-open message to registry.requestOpen as its target argument (OOP 2026-09-09)", async () => {
    // deviceRegistry.ts's own relay-routing behavior for `target` is
    // covered in deviceRegistry.test.ts's "robot-via-relay endpoints"
    // describe block -- this test only proves server.ts's wiring: the
    // client-sent robotName/radio fields reach registry.requestOpen
    // unchanged, as its second argument.
    const link = new FakeLink(async () => banner());
    const registry = buildRegistry(link);
    const requestOpenSpy = vi.spyOn(registry, "requestOpen");
    server = await startServer({ port: 0, registry, firmwareConfig: NO_FIRMWARE });
    const connected = await connect(server.url.replace("http://", "ws://"));
    ws = connected.ws;

    await connected.messages.waitFor((m) => m.type === "endpoints");

    ws.send(
      JSON.stringify({
        type: "session-open",
        endpointId: "usb-SERIAL-A",
        robotName: "gopiv",
        radio: { channel: 55, group: 114 },
      }),
    );

    await vi.waitFor(() => {
      expect(requestOpenSpy).toHaveBeenCalledWith("usb-SERIAL-A", {
        robotName: "gopiv",
        radio: { channel: 55, group: 114 },
      });
    });
  });

  it("session-open with robotName but no radio still forwards a target (radio omitted)", async () => {
    const link = new FakeLink(async () => banner());
    const registry = buildRegistry(link);
    const requestOpenSpy = vi.spyOn(registry, "requestOpen");
    server = await startServer({ port: 0, registry, firmwareConfig: NO_FIRMWARE });
    const connected = await connect(server.url.replace("http://", "ws://"));
    ws = connected.ws;

    await connected.messages.waitFor((m) => m.type === "endpoints");

    ws.send(JSON.stringify({ type: "session-open", endpointId: "usb-SERIAL-A", robotName: "gopiv" }));

    await vi.waitFor(() => {
      expect(requestOpenSpy).toHaveBeenCalledWith("usb-SERIAL-A", { robotName: "gopiv" });
    });
  });

  it("session-open with autoRobot: true forwards an empty target to registry.requestOpen, requesting default failover (sprint 8 ticket 005)", async () => {
    // deviceRegistry.ts's own default-failover candidate building
    // (buildDefaultFailoverCandidates) is covered in deviceRegistry.test.ts
    // -- this test only proves server.ts's wiring: `autoRobot: true` with
    // no `robotName` reaches registry.requestOpen as an empty target
    // object (`{}`), the signal that means "use the default-failover
    // list" rather than "open the endpoint's own plain USB session".
    const link = new FakeLink(async () => banner());
    const registry = buildRegistry(link);
    const requestOpenSpy = vi.spyOn(registry, "requestOpen");
    server = await startServer({ port: 0, registry, firmwareConfig: NO_FIRMWARE });
    const connected = await connect(server.url.replace("http://", "ws://"));
    ws = connected.ws;

    await connected.messages.waitFor((m) => m.type === "endpoints");

    ws.send(JSON.stringify({ type: "session-open", endpointId: "usb-SERIAL-A", autoRobot: true }));

    await vi.waitFor(() => {
      expect(requestOpenSpy).toHaveBeenCalledWith("usb-SERIAL-A", {});
    });
  });

  it("session-open with no robotName still forwards to registry.requestOpen with no target argument", async () => {
    const link = new FakeLink(async () => banner());
    const registry = buildRegistry(link);
    const requestOpenSpy = vi.spyOn(registry, "requestOpen");
    server = await startServer({ port: 0, registry, firmwareConfig: NO_FIRMWARE });
    const connected = await connect(server.url.replace("http://", "ws://"));
    ws = connected.ws;

    await connected.messages.waitFor((m) => m.type === "endpoints");

    ws.send(JSON.stringify({ type: "session-open", endpointId: "usb-SERIAL-A" }));

    await vi.waitFor(() => {
      expect(requestOpenSpy).toHaveBeenCalledWith("usb-SERIAL-A");
    });
  });

  it("routes a send-command message to registry.sendCommand: dispatches sequenced/unsequenced verbs and resyncs HELLO (OOP fix, defect 2)", async () => {
    // HELLO used to be flatly rejected here (sprint 6). It is now routed
    // through Link.identify() -- the disciplined resync path -- instead;
    // configuring identify() to fail on this second call (the resync)
    // gives this test a deterministic `error` message to wait on, same
    // as the old rejection did, while proving the new dispatch target.
    let identifyCalls = 0;
    const link = new FakeLink(async () => {
      identifyCalls++;
      return identifyCalls === 1 ? banner() : null;
    });
    server = await startServer({ port: 0, registry: buildRegistry(link), firmwareConfig: NO_FIRMWARE });
    const connected = await connect(server.url.replace("http://", "ws://"));
    ws = connected.ws;

    await connected.messages.waitFor((m) => m.type === "endpoints" && m.endpoints[0]?.sessionOpen === true);

    ws.send(JSON.stringify({ type: "send-command", endpointId: "usb-SERIAL-A", verb: "GET", fields: [] }));
    ws.send(JSON.stringify({ type: "send-command", endpointId: "usb-SERIAL-A", verb: "STATUS" }));
    // Sent last, per this same client's own message order -- the
    // per-endpoint mutex `deviceRegistry.ts` already serializes every
    // operation through guarantees GET/STATUS above are fully applied to
    // the fake link before this one's resync is even attempted, exactly
    // as `sendLine`'s own ordering already relies on.
    ws.send(JSON.stringify({ type: "send-command", endpointId: "usb-SERIAL-A", verb: "HELLO" }));

    const error = await connected.messages.waitFor((m) => m.type === "error");
    expect(error).toEqual({
      type: "error",
      endpointId: "usb-SERIAL-A",
      message: expect.stringMatching(/didn't answer|no reply|check the connection/i),
    });

    // GET is sequenced (id-assigned via Session.send); STATUS is
    // unsequenced (protocol.md's verb table, not sprint.md's looser
    // phrasing) -- both already reached the link, and HELLO reached
    // neither `sendCommand` nor `sendUnsequenced` on it at all (it went
    // through identify() instead, called twice: the initial connect and
    // this resync).
    expect(link.sentLines).toEqual(["GET #1\n", "STATUS\n"]);
    expect(identifyCalls).toBe(2);
  });

  it("reports a graceful error, not a crash, for a line sent to a device with no open link", async () => {
    // Mirrors the real UsbSerialLink against a genuine transport
    // failure: connect() eventually rejects (a bounded timeout in
    // production; a short delay here) rather than ever resolving. Under
    // sprint 4 ticket 002's connect()/identify() split, only a
    // connect() failure leaves the endpoint with no open link
    // (sessionOpen: false) -- an identify() timeout (a silent board) no
    // longer does, since that link stays open (see
    // deviceRegistry.test.ts's "connected-but-unresponsive" test).
    // DeviceRegistry serializes connect/send per device, so sendLine()
    // sent while this is still in flight is queued behind it and
    // observes the settled (failed) state -- see deviceRegistry.ts's
    // "serializes name-read and link-open" test for the same guarantee
    // in isolation.
    const link = new FakeLink(
      async () => banner(), // never reached -- connect() fails first
      () =>
        new Promise<void>((_resolve, reject) => {
          setTimeout(() => reject(new Error("permission denied opening port")), 20);
        }),
    );
    server = await startServer({ port: 0, registry: buildRegistry(link), firmwareConfig: NO_FIRMWARE });
    const connected = await connect(server.url.replace("http://", "ws://"));
    ws = connected.ws;

    await connected.messages.waitFor((m) => m.type === "endpoints" && m.endpoints.length === 1);
    ws.send(JSON.stringify({ type: "line", endpointId: "usb-SERIAL-A", direction: "tx", line: "HELLO" }));

    const error = await connected.messages.waitFor((m) => m.type === "error");
    expect(error).toEqual({
      type: "error",
      endpointId: "usb-SERIAL-A",
      message: "device usb-SERIAL-A has no open link",
    });
  });

  it("reports a graceful error for a malformed client message instead of closing the connection", async () => {
    const link = new FakeLink(async () => banner());
    server = await startServer({ port: 0, registry: buildRegistry(link), firmwareConfig: NO_FIRMWARE });
    const connected = await connect(server.url.replace("http://", "ws://"));
    ws = connected.ws;

    await connected.messages.waitFor((m) => m.type === "endpoints");
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

describe("server.ts rememberedRobots and forget-known-robot (sprint 5, ticket 004)", () => {
  let server: RunningServer | undefined;
  let ws: WebSocket | undefined;

  afterEach(async () => {
    ws?.close();
    ws = undefined;
    await server?.close();
    server = undefined;
  });

  it("includes a pre-seeded remembered robot on the initial connect snapshot", async () => {
    const link = new FakeLink(async () => banner());
    const knownRobotsStore = fakeKnownRobotsStore([knownRobotRecord()]);
    server = await startServer({
      port: 0,
      registry: buildRegistry(link, { knownRobotsStore }),
      firmwareConfig: NO_FIRMWARE,
    });
    const connected = await connect(server.url.replace("http://", "ws://"));
    ws = connected.ws;

    const initial = await connected.messages.waitFor((m) => m.type === "endpoints");
    expect(initial).toMatchObject({
      type: "endpoints",
      rememberedRobots: [
        {
          name: "kwazi",
          lastSeenAt: "2024-01-01T00:00:00.000Z",
          lastSeenVia: "usb",
          lastRole: "NEZHA2",
          lastUsbSerial: "SERIAL-REMEMBERED",
        },
      ],
    });
  });

  it("drops a forgotten robot from the next broadcast endpoints message", async () => {
    const link = new FakeLink(async () => banner());
    const knownRobotsStore = fakeKnownRobotsStore([knownRobotRecord()]);
    server = await startServer({
      port: 0,
      registry: buildRegistry(link, { knownRobotsStore }),
      firmwareConfig: NO_FIRMWARE,
    });
    const connected = await connect(server.url.replace("http://", "ws://"));
    ws = connected.ws;

    await connected.messages.waitFor(
      (m) => m.type === "endpoints" && m.rememberedRobots.some((r) => r.name === "kwazi"),
    );

    ws.send(JSON.stringify({ type: "forget-known-robot", name: "kwazi" }));

    // requestForgetKnownRobot (ticket 003) removes it from the store and
    // calls its own emitDevices() -- picked up here by the existing
    // onDevicesChanged -> broadcast(buildEndpointsMessage(...)) path,
    // with no new event type.
    const updated = await connected.messages.waitFor(
      (m) => m.type === "endpoints" && !m.rememberedRobots.some((r) => r.name === "kwazi"),
    );
    expect(updated).toMatchObject({ rememberedRobots: [] });
  });

  it("silently no-ops forgetting a name that isn't on the roster, without crashing or erroring", async () => {
    const link = new FakeLink(async () => banner());
    const knownRobotsStore = fakeKnownRobotsStore([knownRobotRecord()]);
    server = await startServer({
      port: 0,
      registry: buildRegistry(link, { knownRobotsStore }),
      firmwareConfig: NO_FIRMWARE,
    });
    const connected = await connect(server.url.replace("http://", "ws://"));
    ws = connected.ws;

    await connected.messages.waitFor(
      (m) => m.type === "endpoints" && m.rememberedRobots.some((r) => r.name === "kwazi"),
    );

    // An unknown name is a silent no-op per KnownRobotsStore.forget's own
    // contract -- send it, then send a real forget for "kwazi" and
    // confirm *that* still succeeds, proving the server kept processing
    // messages on this connection rather than crashing on the first one.
    ws.send(JSON.stringify({ type: "forget-known-robot", name: "not-a-known-robot" }));
    ws.send(JSON.stringify({ type: "forget-known-robot", name: "kwazi" }));

    const updated = await connected.messages.waitFor(
      (m) => m.type === "endpoints" && !m.rememberedRobots.some((r) => r.name === "kwazi"),
    );
    expect(updated).toMatchObject({ rememberedRobots: [] });
    expect(ws.readyState).toBe(WebSocket.OPEN);
    expect(connected.messages.all.some((m) => m.type === "error")).toBe(false);
  });

  it("rejects a malformed forget-known-robot (missing name) with the existing generic parse error", async () => {
    const link = new FakeLink(async () => banner());
    server = await startServer({ port: 0, registry: buildRegistry(link), firmwareConfig: NO_FIRMWARE });
    const connected = await connect(server.url.replace("http://", "ws://"));
    ws = connected.ws;

    await connected.messages.waitFor((m) => m.type === "endpoints");
    ws.send(JSON.stringify({ type: "forget-known-robot" }));

    const error = await connected.messages.waitFor((m) => m.type === "error");
    expect(error).toEqual({ type: "error", message: "unrecognized message shape" });
    expect(ws.readyState).toBe(WebSocket.OPEN);
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

    await first.messages.waitFor((m) => m.type === "endpoints" && m.endpoints[0]?.sessionOpen === true);

    first.ws.send(
      JSON.stringify({
        type: "flash-start",
        endpointId: "usb-SERIAL-A",
        source: { kind: "release", firmware: "relay" },
      }),
    );

    const progressOnFirst = await first.messages.waitFor((m) => m.type === "flash-progress");
    expect(progressOnFirst).toEqual({
      type: "flash-progress",
      endpointId: "usb-SERIAL-A",
      source: { kind: "release", firmware: "relay" },
      phase: "fetching",
    });

    // ticket 004: the terminal flash-result waits for the post-flash
    // reidentify to settle and carries its classification/name --
    // FakeLink's identify() resolves the same banner() both times here
    // (createLink returns the one shared `link` fake), so the endpoint's
    // classification survives the round trip unchanged, but the field is
    // now populated end to end over the wire.
    const expectedResult = {
      type: "flash-result",
      endpointId: "usb-SERIAL-A",
      source: { kind: "release", firmware: "relay" },
      status: "ok",
      classification: { type: "robot", role: "NEZHA2", commonName: "robot", dialect: "space", evidence: "common-name" },
      name: "zeguz",
    };
    const resultOnFirst = await first.messages.waitFor((m) => m.type === "flash-result");
    expect(resultOnFirst).toEqual(expectedResult);

    // The requester's own client saw it; confirm the *other* connected
    // client did too.
    const resultOnSecond = await second.messages.waitFor((m) => m.type === "flash-result");
    expect(resultOnSecond).toEqual(expectedResult);

    expect(resolveReleaseFn).toHaveBeenCalledTimes(1);
    expect(fetchAndVerifyHexFn).toHaveBeenCalledTimes(1);
    expect(flashFn).toHaveBeenCalledTimes(1);
  });
});

function sha256Hex(payload: Buffer): string {
  return createHash("sha256").update(payload).digest("hex");
}

describe("server.ts local-hex upload handshake (sprint 4 ticket 005)", () => {
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

  it("routes a binary frame to localHexUpload (isBinary branch), distinct from the JSON text path", async () => {
    const link = new FakeLink(async () => banner());
    server = await startServer({ port: 0, registry: buildRegistry(link), firmwareConfig: NO_FIRMWARE });
    const connected = await connectTracked(server.url.replace("http://", "ws://"));
    await connected.messages.waitFor((m) => m.type === "endpoints");

    // A text message that isn't valid JSON goes through the JSON/
    // parseClientMessage path and reports the "malformed JSON message"
    // error -- confirms the baseline (non-binary) behavior first.
    connected.ws.send("not json");
    const textError = await connected.messages.waitFor((m) => m.type === "error");
    expect(textError).toEqual({ type: "error", message: "malformed JSON message" });

    // A binary frame carrying a well-formed-length but unknown uploadId
    // prefix goes through localHexUpload.receiveFrame instead -- a
    // distinctly different error message proves the isBinary branch
    // actually dispatched to it rather than falling through to
    // JSON.parse (which would report "malformed JSON message" again for
    // this same garbage bytes).
    const unknownUploadId = "00000000-0000-0000-0000-000000000000";
    expect(unknownUploadId).toHaveLength(UPLOAD_ID_BYTE_LENGTH);
    const frame = Buffer.concat([Buffer.from(unknownUploadId, "ascii"), Buffer.from("payload", "utf-8")]);
    connected.ws.send(frame);

    const binaryError = await connected.messages.waitFor(
      (m) => m.type === "error" && m.message !== "malformed JSON message",
    );
    expect(binaryError).toEqual({
      type: "error",
      message: expect.stringContaining(unknownUploadId),
    });

    // The connection survives both -- a bad message is never a reason to
    // close the socket.
    expect(connected.ws.readyState).toBe(WebSocket.OPEN);
  });

  it("round-trips the full handshake: flash-local-begin -> flash-local-ready -> binary frame -> flash-start -> successful flash", async () => {
    const link = new FakeLink(async () => banner());
    const localHexUpload = new LocalHexUploadManager();

    let observedHexText: string | undefined;
    const flashFn = vi.fn(
      async (
        _device: DaplinkDevice,
        hexText: string,
        onProgress: (phase: FlashPhase) => void,
      ) => {
        observedHexText = hexText;
        onProgress("erasing");
        onProgress("writing");
        onProgress("resetting");
        return { status: "ok" as const, method: "swd" as const };
      },
    );
    const registry = buildRegistry(link, {
      // The same LocalHexUploadManager instance server.ts uses for the
      // JSON/binary handling below -- see StartServerOptions
      // .localHexUpload's own doc comment for why a caller-supplied
      // registry must wire this itself.
      consumeUpload: (uploadId) => localHexUpload.consumeUpload(uploadId),
      flash: flashFn,
    });

    server = await startServer({
      port: 0,
      registry,
      firmwareConfig: NO_FIRMWARE,
      localHexUpload,
    });
    const connected = await connectTracked(server.url.replace("http://", "ws://"));
    await connected.messages.waitFor((m) => m.type === "endpoints" && m.endpoints[0]?.sessionOpen === true);

    const payload = Buffer.from(":10000000AABBCCDD00000000000000000000005A\n:00000001FF\n", "utf-8");
    const fileName = "my-firmware.hex";
    const sha256 = sha256Hex(payload);

    connected.ws.send(
      JSON.stringify({ type: "flash-local-begin", fileName, byteLength: payload.length, sha256 }),
    );
    const ready = await connected.messages.waitFor((m) => m.type === "flash-local-ready");
    expect(ready).toEqual({ type: "flash-local-ready", uploadId: expect.any(String) });
    const uploadId = (ready as { uploadId: string }).uploadId;
    expect(uploadId).toHaveLength(UPLOAD_ID_BYTE_LENGTH);

    connected.ws.send(Buffer.concat([Buffer.from(uploadId, "ascii"), payload]));

    const source = { kind: "local-hex" as const, uploadId, fileName, sha256 };
    connected.ws.send(
      JSON.stringify({ type: "flash-start", endpointId: "usb-SERIAL-A", source }),
    );

    const progress = await connected.messages.waitFor((m) => m.type === "flash-progress");
    expect(progress).toEqual({ type: "flash-progress", endpointId: "usb-SERIAL-A", source, phase: "verifying" });

    const result = await connected.messages.waitFor((m) => m.type === "flash-result");
    expect(result).toEqual({
      type: "flash-result",
      endpointId: "usb-SERIAL-A",
      source,
      status: "ok",
      classification: { type: "robot", role: "NEZHA2", commonName: "robot", dialect: "space", evidence: "common-name" },
      name: "zeguz",
    });

    expect(observedHexText).toBe(payload.toString("utf-8"));
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
    // cache's real interval timer.
    await availabilityCache.pollOnce();

    server = await startServer({ port: 0, registry: buildRegistry(link), availabilityCache });
    const connected = await connect(server.url.replace("http://", "ws://"));
    ws = connected.ws;

    const initial = await connected.messages.waitFor((m) => m.type === "endpoints");
    expect(initial).toMatchObject({
      type: "endpoints",
      firmwareStatus: {
        relay: { configured: true, repoUrl: firmwareSource().repoUrl, tag: "latest", available: true },
        robot: { configured: false },
      },
    });
    // The explicit pollOnce() call above drove this snapshot's content,
    // but `startServer()` itself now *also* fires an immediate poll on
    // startup (see the "checks firmware availability immediately at
    // startup" test below) -- so `checkAvailabilityFn` is called at
    // least once more in the background here. Both calls resolve to the
    // same fixed `{ available: true }` result, so the assertions above
    // are unaffected; this test only pins the message shape, not the
    // call count.
    expect(checkAvailabilityFn.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it("checks firmware availability immediately at startup, without waiting for the poll interval, and delivers the result to a client that connected before the check resolved (regression, OOP fix)", async () => {
    const link = new FakeLink(async () => banner());
    // Controlled by hand rather than a real timer/network call: the
    // check stays pending until `resolveCheck()` is invoked below, so
    // the test can deterministically connect a client *while the very
    // first poll is still in flight* and then observe the update land
    // on that already-open connection -- no fixed-tick `flushAsync`,
    // just condition-based waits (`MessageCollector.waitFor`).
    let resolveCheck!: (result: { available: boolean; reason?: string }) => void;
    const checkAvailabilityFn = vi.fn(
      () =>
        new Promise<{ available: boolean; reason?: string }>((resolve) => {
          resolveCheck = resolve;
        }),
    );
    const availabilityCache = new FirmwareAvailabilityCache(
      { relay: firmwareSource(), robot: undefined },
      // A poll interval far longer than this test could ever run: if
      // the fix regresses to "only the interval polls", the assertions
      // below time out waiting for a poll that never comes, rather than
      // passing by accident on a lucky interval tick.
      { checkAvailability: checkAvailabilityFn, pollIntervalMs: 3_600_000 },
    );

    server = await startServer({ port: 0, registry: buildRegistry(link), availabilityCache });
    // `startServer()` returning (i.e. `listen()` resolving) does not
    // wait on the availability poll -- confirm the immediate poll was
    // nonetheless *started* by the time startup completes.
    expect(checkAvailabilityFn).toHaveBeenCalledTimes(1);

    const connected = await connect(server.url.replace("http://", "ws://"));
    ws = connected.ws;

    // This client connected after startup but *before* the in-flight
    // poll resolved -- its very first snapshot must still show the
    // "not yet checked" placeholder, not the eventual result, proving
    // the check really was still pending at connect time.
    const initial = await connected.messages.waitFor((m) => m.type === "endpoints");
    expect(initial).toMatchObject({
      type: "endpoints",
      firmwareStatus: { relay: { configured: true, available: false, reason: "not-yet-checked" } },
    });

    // Now let the startup poll resolve.
    resolveCheck({ available: true });

    // The already-connected client -- no reconnect, no client-sent
    // message -- must receive the updated status via the normal
    // onChange -> broadcast path.
    const updated = await connected.messages.waitFor(
      (m) => m.type === "endpoints" && m.firmwareStatus.relay.configured === true && m.firmwareStatus.relay.available === true,
    );
    expect(updated).toMatchObject({
      type: "endpoints",
      firmwareStatus: {
        relay: { configured: true, repoUrl: firmwareSource().repoUrl, tag: "latest", available: true },
      },
    });

    // The interval timer (5-min default, here set to an hour) must not
    // have been touched by any of this -- exactly one check so far.
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

    const initial = await connected.messages.waitFor((m) => m.type === "endpoints");
    expect(initial).toMatchObject({ firmwareStatus: { robot: { configured: true, available: false } } });

    // The poll (not any client message) is what flips this -- simulating
    // pxt-nezha-diffdrive cutting its first release.
    available = true;
    await availabilityCache.pollOnce();

    const updated = await connected.messages.waitFor(
      (m) =>
        m.type === "endpoints" &&
        m.firmwareStatus.robot.configured === true &&
        m.firmwareStatus.robot.available === true,
    );
    expect(updated).toMatchObject({
      type: "endpoints",
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
