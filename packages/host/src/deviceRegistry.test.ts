import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  Session,
  classifyBanner,
  nameToRadioAddress,
  type AckNackEvent,
  type DecodedLine,
  type ParsedBanner,
  type WireField,
} from "@robot-console/protocol";
import { DeviceWatcher, type DaplinkDevice } from "./devices.js";
import type { SwdNameResult } from "./swdName.js";
import { DeviceRegistry, KeyedMutex, defaultLinkFactory, parseStatusReply } from "./deviceRegistry.js";
import type { Link, LinkSpec } from "./link/Link.js";
import { UsbSerialLink, type SerialPortLike } from "./link/UsbSerialLink.js";
import { MbserialLink } from "./link/MbserialLink.js";
import type { Scheduler } from "./link/pacing.js";
import type { EndpointListEntry, FirmwareKind, FirmwareSourceRef, FlashPhase } from "./wsMessages.js";
import type { FirmwareConfigMap, FirmwareSource } from "./config.js";
import type { ResolvedRelease } from "./releases.js";
import type { FlashOutcome } from "./flash.js";
import { KnownRobotsStore } from "./store/knownRobots.js";
import type { ConnectionCandidate, RelayConnectionResult } from "./relay/RelayConnectionCoordinator.js";
import type { RelayConnector } from "./deviceRegistry.js";
import { MdnsDiscovery } from "./discovery/mdnsDiscovery.js";

// Sprint 8 ticket 004: DeviceRegistry's default MdnsDiscovery is real
// (real `bonjour-service` multicast browsing, started/stopped alongside
// the device watcher) -- verified live to actually reach the LAN and
// discover real services. Every test in this file gets a lightweight,
// fully synthetic fake instead, with NO edits needed at the ~100
// existing call sites that never mention mdnsDiscovery at all: this
// mock replaces the module for this file's whole graph (including
// deviceRegistry.ts's own `new MdnsDiscovery()` default), so no test
// here ever opens a real multicast socket. A test that cares about
// specific discovered services constructs its own `new MdnsDiscovery()`
// (the same mocked class) and calls its test-only `setSnapshot` to
// script one -- see the "robot-via-relay endpoints" describe block.
vi.mock("./discovery/mdnsDiscovery.js", () => {
  class FakeMdnsDiscoveryForTests {
    private snapshot: { relays: unknown[]; robots: unknown[]; wifiRobots: unknown[] } = {
      relays: [],
      robots: [],
      wifiRobots: [],
    };
    private listeners = new Set<(current: unknown) => void>();
    current(): unknown {
      return this.snapshot;
    }
    onChange(listener: (current: unknown) => void): () => void {
      this.listeners.add(listener);
      return () => {
        this.listeners.delete(listener);
      };
    }
    start(): void {
      // Intentionally inert -- no real backend, no real socket.
    }
    stop(): void {
      // Intentionally inert.
    }
    setSnapshot(next: { relays: unknown[]; robots: unknown[]; wifiRobots?: unknown[] }): void {
      this.snapshot = { wifiRobots: [], ...next };
      for (const listener of this.listeners) {
        listener(this.snapshot);
      }
    }
  }
  return { MdnsDiscovery: FakeMdnsDiscoveryForTests };
});

/** Cast helper for the mocked {@link MdnsDiscovery}'s test-only
 * `setSnapshot` -- TypeScript still types `new MdnsDiscovery()` against
 * the real class (mocking is a vitest runtime mechanism, invisible to
 * `tsc`), so this file's test bodies are excluded from `tsc -p
 * tsconfig.json` (see `tsconfig.json`'s own `exclude`); this cast keeps
 * call sites terse regardless. `wifiRobots` (sprint 10 ticket 003) is
 * optional and defaults to `[]`, so every existing call site written
 * before this ticket keeps compiling unchanged. */
function fakeMdnsDiscovery(snapshot: {
  relays: Array<{ instanceName: string; host: string; port: number; registryPort?: number }>;
  robots: Array<{ instanceName: string; host: string; port: number }>;
  wifiRobots?: Array<{ name: string; host: string; port: number; role?: string; link?: string }>;
}): MdnsDiscovery {
  const instance = new MdnsDiscovery() as unknown as MdnsDiscovery & {
    setSnapshot: (next: typeof snapshot) => void;
  };
  instance.setSnapshot(snapshot);
  return instance;
}

/** A fully synthetic {@link RelayConnector} (sprint 8 ticket 004) --
 * never a real {@link RelayConnectionCoordinator}, per this ticket's own
 * testing note. Records every candidate list it was called with, in
 * call order, so a test can assert exactly what `deviceRegistry.ts`
 * built without any real resolve/connect/probe timing. */
function fakeCoordinator(
  handler: (
    candidates: readonly ConnectionCandidate[],
  ) => Promise<RelayConnectionResult> | RelayConnectionResult,
): RelayConnector & { calls: ConnectionCandidate[][] } {
  const calls: ConnectionCandidate[][] = [];
  return {
    calls,
    async connect(candidates) {
      calls.push([...candidates]);
      return handler(candidates);
    },
  };
}

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
  readonly session = new Session();
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

  /** Delegates to the fake's own real `Session` (sprint 6 ticket 003),
   * so a sequenced send actually assigns an id, buffers it for
   * retransmit, and advances `pendingCount` exactly as a real `Link`
   * would -- ticket 003's own testing note asks for this real
   * `Session` rather than a further-synthetic stub. */
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
    // Not exercised by DeviceRegistry -- no-op.
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

  emitError(err: Error): void {
    for (const listener of this.errorListeners) {
      listener(err);
    }
  }

  /** Feed a decoded ack/nack reply through the fake's own real
   * `Session` (updating `seq`/`pendingCount`/`lastDone` exactly as a
   * real `Link`'s `LineRouter` would), then notify `onAckNack`
   * subscribers with the resulting event -- lets a test simulate a
   * robot's ack/nack reply with no real transport. A no-op (no
   * listener notified) for any other reply verb, mirroring
   * `Session.handleReply`'s own `null`-for-everything-else contract. */
  receiveReply(reply: DecodedLine): void {
    const event = this.session.handleReply(reply);
    if (event) {
      for (const listener of this.ackNackListeners) {
        listener(event);
      }
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

    const registry = new DeviceRegistry({ statusPollIntervalMs: 0, autoRequestFunctions: false,  watcher, resolveName, createLink });
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

    const registry = new DeviceRegistry({ statusPollIntervalMs: 0, autoRequestFunctions: false,  watcher, resolveName, createLink });
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

    const registry = new DeviceRegistry({ statusPollIntervalMs: 0, autoRequestFunctions: false,  watcher, resolveName, createLink });
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

    const registry = new DeviceRegistry({ statusPollIntervalMs: 0, autoRequestFunctions: false,  watcher, resolveName, createLink });
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

    const registry = new DeviceRegistry({ statusPollIntervalMs: 0, autoRequestFunctions: false,  watcher, resolveName, createLink });
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

    const registry = new DeviceRegistry({ statusPollIntervalMs: 0, autoRequestFunctions: false,  watcher, resolveName, createLink });
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

    const registry = new DeviceRegistry({ statusPollIntervalMs: 0, autoRequestFunctions: false,  watcher, resolveName, createLink });
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

    const registry = new DeviceRegistry({ statusPollIntervalMs: 0, autoRequestFunctions: false,  watcher, resolveName, createLink });
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

    const registry = new DeviceRegistry({ statusPollIntervalMs: 0, autoRequestFunctions: false,  watcher, resolveName, createLink });
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

    const registry = new DeviceRegistry({ statusPollIntervalMs: 0, autoRequestFunctions: false,  watcher, resolveName, createLink });
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

    const registry = new DeviceRegistry({ statusPollIntervalMs: 0, autoRequestFunctions: false,  watcher, resolveName, createLink });
    const lines: Array<{ endpointId: string; direction: string; line: string }> = [];
    const errors: Array<{ endpointId: string | undefined; message: string }> = [];
    registry.onLine((endpointId, direction, line) => lines.push({ endpointId, direction, line }));
    registry.onError((endpointId, message) => errors.push({ endpointId, message }));
    registry.start();

    await waitForSnapshot(registry, (s) => s[0]?.sessionOpen === true);
    // Any raw line other than HELLO (see the dedicated HELLO-interception
    // tests below) goes to the wire verbatim.
    await registry.sendLine("usb-SERIAL-A", "STATUS");
    expect(link.sentLines).toEqual(["STATUS"]);
    expect(lines).toContainEqual({ endpointId: "usb-SERIAL-A", direction: "tx", line: "STATUS" });

    await registry.sendLine("no-such-device", "STATUS");
    expect(errors).toContainEqual({
      endpointId: "no-such-device",
      message: "device no-such-device has no open link",
    });

    await registry.stop();
  });

  it("sendLine intercepts a raw-typed HELLO (any case) and resyncs instead of writing it to the wire", async () => {
    // OOP fix (defect 3): typing "hello" into the console used to sail
    // straight through as raw text, resetting the robot's sequence with
    // none of the host-side bookkeeping reset to match -- a silent
    // desync. It must now be detected regardless of case and routed
    // through the same resync path as the structured HELLO command.
    const devices = [device()];
    const watcher = fixtureWatcher(() => devices);
    const resolveName = async () => namedResult("zeguz");
    const link = new FakeLink(async () => banner());
    const createLink = () => link;

    const registry = new DeviceRegistry({ statusPollIntervalMs: 0, autoRequestFunctions: false,  watcher, resolveName, createLink });
    registry.start();

    await waitForSnapshot(registry, (s) => s[0]?.sessionOpen === true);
    expect(link.identifyCalls).toBe(1); // the initial connect-time identify()

    await registry.sendLine("usb-SERIAL-A", "hello");

    // Routed through Link.identify(), never written to the wire as raw
    // text -- sendLine's own `link.sendLine()` call never fires for it.
    expect(link.identifyCalls).toBe(2);
    expect(link.sentLines).toEqual([]);

    await registry.stop();
  });

  it("reconstructs an inbound line from the link and emits it as an rx line event", async () => {
    const devices = [device()];
    const watcher = fixtureWatcher(() => devices);
    const resolveName = async () => namedResult("zeguz");
    const link = new FakeLink(async () => banner());
    const createLink = () => link;

    const registry = new DeviceRegistry({ statusPollIntervalMs: 0, autoRequestFunctions: false,  watcher, resolveName, createLink });
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

    const registry = new DeviceRegistry({ statusPollIntervalMs: 0, autoRequestFunctions: false,  watcher, resolveName, createLink });
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
// sendCommand (sprint 6 ticket 003) -- routing sequenced vs unsequenced
// verbs through Session, the HELLO guard, sequencing-state projection,
// and (against a real UsbSerialLink + fake port/scheduler) the full
// sendCommand -> Link.sendCommand -> WritePacer pacing path.
// ---------------------------------------------------------------------

/** A fully synthetic stand-in for `serialport`'s `SerialPort`, used only
 * by the pacing test below where a real `UsbSerialLink` (not the
 * `FakeLink` above) is needed to prove the *whole* path holds writes
 * paced, not just `WritePacer` in isolation (which `pacing.test.ts`
 * already covers) or `UsbSerialLink` in isolation (which
 * `UsbSerialLink.test.ts` already covers). Mirrors that file's own
 * `FakeSerialPort` fixture. */
class FakeSerialPort extends EventEmitter implements SerialPortLike {
  writes: string[] = [];

  write(data: string, callback?: (err?: Error | null) => void): boolean {
    this.writes.push(data);
    callback?.(null);
    return true;
  }

  close(callback?: (err?: Error | null) => void): void {
    callback?.(null);
    this.emit("close");
  }
}

/** A scheduler that resolves `delay()` on a microtask (no real
 * wall-clock wait) but records every call, so pacing is assertable
 * without slowing the test down or needing fake timers. Mirrors
 * `UsbSerialLink.test.ts`'s own `recordingScheduler`. */
function recordingScheduler(): Scheduler & { calls: number[] } {
  const calls: number[] = [];
  return {
    calls,
    delay: (ms: number) => {
      calls.push(ms);
      return Promise.resolve();
    },
  };
}

describe("DeviceRegistry.sendCommand", () => {
  it("routes a sequenced verb (GET) to link.sendCommand, assigning it an id via Session", async () => {
    const devices = [device()];
    const watcher = fixtureWatcher(() => devices);
    const link = new FakeLink(async () => banner({ role: "NEZHA2" }));
    const registry = new DeviceRegistry({ statusPollIntervalMs: 0, autoRequestFunctions: false,  watcher, resolveName: async () => namedResult("zavaz"), createLink: () => link });
    registry.start();

    await waitForSnapshot(registry, (s) => s[0]?.sessionOpen === true);
    await registry.sendCommand("usb-SERIAL-A", "GET", []);

    expect(link.sentLines).toEqual(["GET #1\n"]);
    expect(link.session.pendingCount).toBe(1);

    await registry.stop();
  });

  it("routes an unsequenced verb (STATUS) to link.sendUnsequenced, never assigning it an id", async () => {
    const devices = [device()];
    const watcher = fixtureWatcher(() => devices);
    const link = new FakeLink(async () => banner({ role: "NEZHA2" }));
    const registry = new DeviceRegistry({ statusPollIntervalMs: 0, autoRequestFunctions: false,  watcher, resolveName: async () => namedResult("zavaz"), createLink: () => link });
    registry.start();

    await waitForSnapshot(registry, (s) => s[0]?.sessionOpen === true);
    await registry.sendCommand("usb-SERIAL-A", "STATUS", []);

    expect(link.sentLines).toEqual(["STATUS\n"]);
    expect(link.session.pendingCount).toBe(0);

    await registry.stop();
  });

  it("also routes ESTOP and PING as unsequenced", async () => {
    const devices = [device()];
    const watcher = fixtureWatcher(() => devices);
    const link = new FakeLink(async () => banner({ role: "NEZHA2" }));
    const registry = new DeviceRegistry({ statusPollIntervalMs: 0, autoRequestFunctions: false,  watcher, resolveName: async () => namedResult("zavaz"), createLink: () => link });
    registry.start();

    await waitForSnapshot(registry, (s) => s[0]?.sessionOpen === true);
    await registry.sendCommand("usb-SERIAL-A", "ESTOP", []);
    await registry.sendCommand("usb-SERIAL-A", "PING", []);

    expect(link.sentLines).toEqual(["ESTOP\n", "PING\n"]);
    expect(link.session.pendingCount).toBe(0);

    await registry.stop();
  });

  it("routes HELLO sent as a command through the resync path (Link.identify()), never through Session.send/sendUnsequenced", async () => {
    // OOP fix (defect 2): HELLO used to be flatly refused here ("close
    // and reopen the session instead"). It is now the button's real
    // recovery action -- Link.identify() is the disciplined way to
    // (re)send HELLO. (The actual session-state reset this causes --
    // Session.connect()'s fresh id counter/empty pending table/seq=1 --
    // lives inside a real Link's identify() implementation, e.g.
    // UsbSerialLink's own doc comment; FakeLink here is deliberately a
    // thinner double that only proves DeviceRegistry calls identify()
    // and nothing else for HELLO, not that identify() itself resets
    // state, which is that other layer's contract, not this one's.)
    const devices = [device()];
    const watcher = fixtureWatcher(() => devices);
    const link = new FakeLink(async () => banner({ role: "NEZHA2" }));
    const registry = new DeviceRegistry({ statusPollIntervalMs: 0, autoRequestFunctions: false,  watcher, resolveName: async () => namedResult("zavaz"), createLink: () => link });
    const errors: Array<{ endpointId: string | undefined; message: string }> = [];
    registry.onError((endpointId, message) => errors.push({ endpointId, message }));
    registry.start();

    await waitForSnapshot(registry, (s) => s[0]?.sessionOpen === true);
    expect(link.identifyCalls).toBe(1); // the initial connect-time identify()

    await registry.sendCommand("usb-SERIAL-A", "GET", []);
    expect(link.session.pendingCount).toBe(1);

    await registry.sendCommand("usb-SERIAL-A", "HELLO", []);

    expect(link.identifyCalls).toBe(2);
    // Never reached Session.send/sendUnsequenced -- no raw "HELLO" line
    // and no SessionError from sendUnsequenced()'s own refusal. The
    // pending GET from before the resync is untouched by this fake
    // (see the note above) -- it not throwing/erroring is the point.
    expect(link.sentLines).toEqual(["GET #1\n"]);
    expect(errors).toEqual([]);

    await registry.stop();
  });

  it("reports an error (but still resets local state) when HELLO gets no reply", async () => {
    const devices = [device()];
    const watcher = fixtureWatcher(() => devices);
    let identifyCount = 0;
    const link = new FakeLink(async () => {
      identifyCount++;
      // The initial connect-time identify() succeeds; a later resync
      // attempt (from the HELLO command below) gets no reply.
      return identifyCount === 1 ? banner({ role: "NEZHA2" }) : null;
    });
    const registry = new DeviceRegistry({ statusPollIntervalMs: 0, autoRequestFunctions: false,  watcher, resolveName: async () => namedResult("zavaz"), createLink: () => link });
    const errors: Array<{ endpointId: string | undefined; message: string }> = [];
    registry.onError((endpointId, message) => errors.push({ endpointId, message }));
    registry.start();

    await waitForSnapshot(registry, (s) => s[0]?.sessionOpen === true);
    await registry.sendCommand("usb-SERIAL-A", "HELLO", []);

    expect(errors).toEqual([
      expect.objectContaining({
        endpointId: "usb-SERIAL-A",
        message: expect.stringMatching(/didn't answer|no reply|check the connection/i),
      }),
    ]);
    // Still went through identify() (twice: initial connect + resync),
    // never a raw sendUnsequenced("HELLO") -- a null banner is a normal
    // outcome here, not a thrown SessionError.
    expect(link.identifyCalls).toBe(2);
    expect(link.sentLines).toEqual([]);

    await registry.stop();
  });

  it("HELLO sent lowercase via sendCommand still resyncs -- case cannot select a different behavior", async () => {
    const devices = [device()];
    const watcher = fixtureWatcher(() => devices);
    const link = new FakeLink(async () => banner({ role: "NEZHA2" }));
    const registry = new DeviceRegistry({ statusPollIntervalMs: 0, autoRequestFunctions: false,  watcher, resolveName: async () => namedResult("zavaz"), createLink: () => link });
    registry.start();

    await waitForSnapshot(registry, (s) => s[0]?.sessionOpen === true);
    expect(link.identifyCalls).toBe(1);

    await registry.sendCommand("usb-SERIAL-A", "hello", []);
    expect(link.identifyCalls).toBe(2);
    expect(link.sentLines).toEqual([]);

    await registry.stop();
  });

  it("catches a thrown CodecError from an illegal verb and reports it via emitError, without crashing", async () => {
    const devices = [device()];
    const watcher = fixtureWatcher(() => devices);
    const link = new FakeLink(async () => banner({ role: "NEZHA2" }));
    const registry = new DeviceRegistry({ statusPollIntervalMs: 0, autoRequestFunctions: false,  watcher, resolveName: async () => namedResult("zavaz"), createLink: () => link });
    const errors: Array<{ endpointId: string | undefined; message: string }> = [];
    registry.onError((endpointId, message) => errors.push({ endpointId, message }));
    registry.start();

    await waitForSnapshot(registry, (s) => s[0]?.sessionOpen === true);
    // "bad verb" contains whitespace -- not a legal wire verb token
    // (codec.ts's VERB_PATTERN), and not one of the 11 sequenced verbs,
    // so this reaches sendUnsequenced() -> encodeLine(), which throws
    // CodecError.
    await expect(registry.sendCommand("usb-SERIAL-A", "bad verb", [])).resolves.toBeUndefined();

    expect(errors).toEqual([
      expect.objectContaining({ endpointId: "usb-SERIAL-A", message: expect.any(String) }),
    ]);

    await registry.stop();
  });

  it("reports emitError for an unknown endpoint or one with no open session, matching sendLine's pattern", async () => {
    const devices = [device()];
    const watcher = fixtureWatcher(() => devices);
    const link = new FakeLink(() => new Promise<ParsedBanner | null>(() => {}));
    const registry = new DeviceRegistry({ statusPollIntervalMs: 0, autoRequestFunctions: false,  watcher, resolveName: async () => namedResult("zavaz"), createLink: () => link });
    const errors: Array<{ endpointId: string | undefined; message: string }> = [];
    registry.onError((endpointId, message) => errors.push({ endpointId, message }));
    registry.start();

    await registry.sendCommand("no-such-device", "STATUS", []);
    expect(errors).toContainEqual({
      endpointId: "no-such-device",
      message: "device no-such-device has no open link",
    });

    await registry.stop();
  });

  it("omits sequencing entirely while no session is open (connect() never resolves)", async () => {
    const devices = [device()];
    const watcher = fixtureWatcher(() => devices);
    // A connectImpl that never resolves keeps sessionOpen false (and
    // state.session undefined) for the life of the test -- deterministic,
    // unlike racing FakeLink's normal immediately-resolving connect().
    const link = new FakeLink(
      () => new Promise<ParsedBanner | null>(() => {}),
      () => new Promise<void>(() => {}),
    );
    const registry = new DeviceRegistry({ statusPollIntervalMs: 0, autoRequestFunctions: false,  watcher, resolveName: async () => namedResult("zavaz"), createLink: () => link });
    registry.start();

    const snap = await waitForSnapshot(registry, (s) => s.length === 1);
    expect(snap[0]?.sessionOpen).toBe(false);
    expect(snap[0]?.sequencing).toBeUndefined();

    await registry.stop();
  });

  it("projects sequencing into the snapshot after a send and after a simulated ack/nack", async () => {
    const devices = [device()];
    const watcher = fixtureWatcher(() => devices);
    const link = new FakeLink(async () => banner({ role: "NEZHA2" }));
    const registry = new DeviceRegistry({ statusPollIntervalMs: 0, autoRequestFunctions: false,  watcher, resolveName: async () => namedResult("zavaz"), createLink: () => link });
    registry.start();

    const opened = await waitForSnapshot(registry, (s) => s[0]?.sessionOpen === true);
    expect(opened[0]?.sequencing).toEqual({ seq: 0, pendingCount: 0, lastDone: 0, lastDoneReason: "none" });

    await registry.sendCommand("usb-SERIAL-A", "GET", []);
    const afterSend = registry.snapshot();
    expect(afterSend[0]?.sequencing).toEqual({ seq: 0, pendingCount: 1, lastDone: 0, lastDoneReason: "none" });

    // Simulate the robot's ack reply -- this exercises the onAckNack
    // subscription wired in connectAndIdentify, and its emitDevices()
    // call, not just the direct-projection path above.
    const snapshots: EndpointListEntry[][] = [];
    registry.onDevicesChanged((s) => snapshots.push(s));
    link.receiveReply({ kind: "line", verb: "ack", fields: ["1", "0", "none"] });

    const afterAck = await waitForSnapshot(registry, (s) => s[0]?.sequencing?.seq === 1);
    expect(afterAck[0]?.sequencing).toEqual({ seq: 1, pendingCount: 0, lastDone: 0, lastDoneReason: "none" });
    expect(snapshots.length).toBeGreaterThan(0);

    await registry.stop();
  });

  it("surfaces a desynced nack (defect 1) as a one-time automatic-resync notice, and the session picks up at the robot's id (OOP 2026-09-09)", async () => {
    const devices = [device()];
    const watcher = fixtureWatcher(() => devices);
    const link = new FakeLink(async () => banner({ role: "NEZHA2" }));
    const registry = new DeviceRegistry({ statusPollIntervalMs: 0, autoRequestFunctions: false,  watcher, resolveName: async () => namedResult("zavaz"), createLink: () => link });
    const errors: Array<{ endpointId: string | undefined; message: string }> = [];
    registry.onError((endpointId, message) => errors.push({ endpointId, message }));
    registry.start();

    await waitForSnapshot(registry, (s) => s[0]?.sessionOpen === true);

    // Confirm #1, then send #2 -- simulating the robot's own sequence
    // having since reset below everything the host now holds pending.
    await registry.sendCommand("usb-SERIAL-A", "GET", []); // #1
    link.receiveReply({ kind: "line", verb: "ack", fields: ["1", "0", "none"] });
    await registry.sendCommand("usb-SERIAL-A", "GET", []); // #2

    link.receiveReply({ kind: "line", verb: "nack", fields: ["1", "0", "none"] });
    // The session adopted the robot's expected id: the held-button
    // style next send is #1, which the robot accepts -- a further
    // nack 1 is an ordinary lost-frame resend, not a second desync.
    await registry.sendCommand("usb-SERIAL-A", "GET", []);
    expect(link.sentLines.at(-1)).toBe("GET #1\n");
    link.receiveReply({ kind: "line", verb: "nack", fields: ["1", "0", "none"] });

    const notices = errors.filter((e) => e.message.includes("resynced automatically"));
    expect(notices).toEqual([expect.objectContaining({ endpointId: "usb-SERIAL-A" })]);
    expect(errors.map((e) => e.message).join(" ")).not.toMatch(/press HELLO/);

    await registry.stop();
  });

  it("a client reading a fresh snapshot after connecting sees current sequencing immediately, no separate event needed", async () => {
    const devices = [device()];
    const watcher = fixtureWatcher(() => devices);
    const link = new FakeLink(async () => banner({ role: "NEZHA2" }));
    const registry = new DeviceRegistry({ statusPollIntervalMs: 0, autoRequestFunctions: false,  watcher, resolveName: async () => namedResult("zavaz"), createLink: () => link });
    registry.start();

    await waitForSnapshot(registry, (s) => s[0]?.sessionOpen === true);
    await registry.sendCommand("usb-SERIAL-A", "GET", []);
    link.receiveReply({ kind: "line", verb: "ack", fields: ["1", "0", "none"] });

    // A brand-new call to snapshot() -- as a freshly-connecting client's
    // own initial read would be -- already reflects the post-ack state,
    // with no event needed to resync (toEntry() reads live session
    // state, never a cached copy).
    await waitForSnapshot(registry, (s) => s[0]?.sequencing?.seq === 1);
    const freshSnapshot = registry.snapshot();
    expect(freshSnapshot[0]?.sequencing).toEqual({ seq: 1, pendingCount: 0, lastDone: 0, lastDoneReason: "none" });

    await registry.stop();
  });

  it("paces a burst of sequenced sends through DeviceRegistry.sendCommand end-to-end (sendCommand -> Link.sendCommand -> WritePacer), against a real UsbSerialLink", async () => {
    const devices = [device()];
    const watcher = fixtureWatcher(() => devices);
    const port = new FakeSerialPort();
    const scheduler = recordingScheduler();
    const createLink = () =>
      new UsbSerialLink("/dev/tty.usbmodemFAKE", {
        createPort: () => port,
        writePaceMs: 10,
        scheduler,
        openTimeoutMs: 200,
      });

    const registry = new DeviceRegistry({ statusPollIntervalMs: 0, autoRequestFunctions: false, 
      watcher,
      resolveName: async () => namedResult("zavaz"),
      createLink,
    });
    registry.start();

    // Let every microtask up through UsbSerialLink#connect()'s
    // port.once("open", ...) registration run before emitting "open" --
    // resolveName/connectAndIdentify/link.connect() are all promise
    // chains with no real timers in between, so a single macrotask
    // boundary drains them all (mirrors this file's own waitForSnapshot
    // polling precedent, and UsbSerialLink.test.ts's identical-purpose
    // "flush" helper).
    await new Promise((resolve) => setTimeout(resolve, 0));
    port.emit("open");
    // sessionOpen flips true as soon as connect() resolves -- before
    // identify()'s own HELLO round trip settles (see
    // connectAndIdentify's own doc comment) -- so sendCommand is already
    // callable at this point.
    await waitForSnapshot(registry, (s) => s[0]?.sessionOpen === true);

    // Drain the HELLO write's own paced delay (sent by identify(), which
    // connectAndIdentify kicks off right after sessionOpen flips true)
    // before measuring the burst below, so it doesn't get counted as
    // part of it.
    await new Promise((resolve) => setTimeout(resolve, 0));
    scheduler.calls.length = 0;
    port.writes.length = 0;

    const BURST = 4;
    for (let i = 0; i < BURST; i++) {
      await registry.sendCommand("usb-SERIAL-A", "GET", []);
    }
    // Flush the WritePacer's chained promises so every scheduled write
    // and its trailing pace delay has actually run.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(scheduler.calls).toEqual(Array(BURST).fill(10));
    expect(port.writes).toHaveLength(BURST);

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

    const registry = new DeviceRegistry({ statusPollIntervalMs: 0, autoRequestFunctions: false, 
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

    const registry = new DeviceRegistry({ statusPollIntervalMs: 0, autoRequestFunctions: false, 
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

    const registry = new DeviceRegistry({ statusPollIntervalMs: 0, autoRequestFunctions: false, 
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

    const registry = new DeviceRegistry({ statusPollIntervalMs: 0, autoRequestFunctions: false, 
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

    const registry = new DeviceRegistry({ statusPollIntervalMs: 0, autoRequestFunctions: false, 
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

    const registry = new DeviceRegistry({ statusPollIntervalMs: 0, autoRequestFunctions: false, 
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

    const registry = new DeviceRegistry({ statusPollIntervalMs: 0, autoRequestFunctions: false, 
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
    const registry = new DeviceRegistry({ statusPollIntervalMs: 0, autoRequestFunctions: false, 
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

    const registry = new DeviceRegistry({ statusPollIntervalMs: 0, autoRequestFunctions: false, 
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
// Ticket 003 (sprint 5): the write gate, the rememberedRobots()
// projection, and the forget action. `knownRobots.test.ts` covers the
// store's own persistence/atomic-write/read-only behavior in isolation
// -- these tests exercise only how DeviceRegistry wires that store into
// live USB attach/identify/flash flow. Each test gets its own temp
// directory-backed KnownRobotsStore, per the ticket's testing note, so
// nothing here ever touches a real ~/.local/state.
// ---------------------------------------------------------------------

describe("DeviceRegistry — known robots (sprint 5)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "device-registry-known-robots-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("enrols a robot identified over its own USB connection (real store)", async () => {
    const devices = [device()];
    const watcher = fixtureWatcher(() => devices);
    const resolveName = async () => namedResult("zeguz");
    const createLink = () => new FakeLink(async () => banner({ role: "NEZHA2", commonName: "robot" }));
    const knownRobotsStore = new KnownRobotsStore({ stateDir: tmpDir });

    const registry = new DeviceRegistry({ statusPollIntervalMs: 0, autoRequestFunctions: false,  watcher, resolveName, createLink, knownRobotsStore });
    registry.start();

    await waitForSnapshot(registry, (s) => s[0]?.role === "NEZHA2");

    expect(knownRobotsStore.list()).toEqual([
      expect.objectContaining({ name: "zeguz", lastRole: "NEZHA2", lastUsbSerial: "SERIAL-A" }),
    ]);

    await registry.stop();
  });

  it("records the exact recordSighting call shape (fake store)", async () => {
    const devices = [device()];
    const watcher = fixtureWatcher(() => devices);
    const resolveName = async () => namedResult("zeguz");
    const createLink = () => new FakeLink(async () => banner({ role: "NEZHA2", commonName: "robot" }));

    const recordSighting = vi.fn();
    const fakeStore = {
      list: () => [],
      get: () => undefined,
      recordSighting,
      forget: vi.fn(() => false),
      flush: async () => {},
      isReadOnly: false,
    } as unknown as KnownRobotsStore;

    const registry = new DeviceRegistry({ statusPollIntervalMs: 0, autoRequestFunctions: false,  watcher, resolveName, createLink, knownRobotsStore: fakeStore });
    registry.start();

    await waitForSnapshot(registry, (s) => s[0]?.role === "NEZHA2");

    expect(recordSighting).toHaveBeenCalledWith({ name: "zeguz", usbSerial: "SERIAL-A", role: "NEZHA2" });

    await registry.stop();
  });

  it("does NOT enrol a relay identify -- the sprint's explicitly-required negative case", async () => {
    // banner()'s default fixture is role RADIOBRIDGE/commonName relay --
    // all three boards on the bench right now classify this way, which
    // is exactly why this negative case is provable today with no
    // hardware change.
    const devices = [device()];
    const watcher = fixtureWatcher(() => devices);
    const resolveName = async () => namedResult("zeguz");
    const createLink = () => new FakeLink(async () => banner());
    const knownRobotsStore = new KnownRobotsStore({ stateDir: tmpDir });

    const registry = new DeviceRegistry({ statusPollIntervalMs: 0, autoRequestFunctions: false,  watcher, resolveName, createLink, knownRobotsStore });
    registry.start();

    const snap = await waitForSnapshot(registry, (s) => s[0]?.sessionOpen === true);
    expect(snap[0]?.classification.type).toBe("relay");

    expect(knownRobotsStore.list()).toEqual([]);

    await registry.stop();
  });

  it("does not enrol an unknown/unidentified device (identify() resolves null)", async () => {
    const devices = [device()];
    const watcher = fixtureWatcher(() => devices);
    const resolveName = async () => namedResult("zeguz");
    const createLink = () => new FakeLink(async () => null);
    const knownRobotsStore = new KnownRobotsStore({ stateDir: tmpDir });

    const registry = new DeviceRegistry({ statusPollIntervalMs: 0, autoRequestFunctions: false,  watcher, resolveName, createLink, knownRobotsStore });
    registry.start();

    const snap = await waitForSnapshot(registry, (s) => s[0]?.sessionOpen === true);
    expect(snap[0]?.classification.type).toBe("unknown");

    expect(knownRobotsStore.list()).toEqual([]);

    await registry.stop();
  });

  it("does not enrol a device whose name never resolved, even though its classification is robot", async () => {
    const devices = [device()];
    const watcher = fixtureWatcher(() => devices);
    const resolveName = async () => failingNameResult();
    const createLink = () => new FakeLink(async () => banner({ role: "NEZHA2", commonName: "robot" }));
    const knownRobotsStore = new KnownRobotsStore({ stateDir: tmpDir });

    const registry = new DeviceRegistry({ statusPollIntervalMs: 0, autoRequestFunctions: false,  watcher, resolveName, createLink, knownRobotsStore });
    registry.start();

    const snap = await waitForSnapshot(registry, (s) => s[0]?.role === "NEZHA2");
    expect(snap[0]?.name).toBeNull();

    expect(knownRobotsStore.list()).toEqual([]);

    await registry.stop();
  });

  it("also enrols via the post-flash reidentify path (succeedFlash's call site)", async () => {
    const devices = [device()];
    const watcher = fixtureWatcher(() => devices);
    const resolveName = async () => namedResult("zeguz");
    const links: FakeLink[] = [];
    const createLink = vi.fn(() => {
      const isFirst = links.length === 0;
      const link = new FakeLink(async () =>
        isFirst ? banner() : banner({ role: "NEZHA2", commonName: "robot" }),
      );
      links.push(link);
      return link;
    });
    const knownRobotsStore = new KnownRobotsStore({ stateDir: tmpDir });

    const registry = new DeviceRegistry({ statusPollIntervalMs: 0, autoRequestFunctions: false, 
      watcher,
      resolveName,
      createLink,
      getFirmwareConfig: configWith(firmwareSource()),
      resolveRelease: async () => resolvedRelease(),
      fetchAndVerifyHex: async () => ({ hex: Buffer.from(":00000001FF\n", "utf-8") }),
      flash: async () => ({ status: "ok", method: "swd" }) as FlashOutcome,
      knownRobotsStore,
    });

    registry.start();
    await waitForSnapshot(registry, (s) => s[0]?.sessionOpen === true);

    // Pre-flash: identifies as a relay, not enrolled yet.
    expect(knownRobotsStore.list()).toEqual([]);

    await registry.requestFlash("usb-SERIAL-A", releaseSource("relay"));
    await waitForSnapshot(registry, (s) => s[0]?.role === "NEZHA2");

    expect(knownRobotsStore.list()).toEqual([expect.objectContaining({ name: "zeguz", lastRole: "NEZHA2" })]);

    await registry.stop();
  });

  it("rememberedRobots() excludes a currently-attached name and includes an absent one", async () => {
    const devices = [device()]; // resolves to "zeguz" below -- currently attached
    const watcher = fixtureWatcher(() => devices);
    const resolveName = async () => namedResult("zeguz");
    const createLink = () => new FakeLink(async () => banner({ role: "NEZHA2", commonName: "robot" }));
    const knownRobotsStore = new KnownRobotsStore({ stateDir: tmpDir });
    // Pre-populate the roster with a record matching the currently-
    // attached fixture device's resolved name, plus one that stays
    // absent.
    knownRobotsStore.recordSighting({ name: "zeguz", usbSerial: "OLD-SERIAL", role: "NEZHA2" });
    knownRobotsStore.recordSighting({ name: "absnt", usbSerial: "SERIAL-B", role: "NEZHA2" });

    const registry = new DeviceRegistry({ statusPollIntervalMs: 0, autoRequestFunctions: false,  watcher, resolveName, createLink, knownRobotsStore });
    registry.start();

    await waitForSnapshot(registry, (s) => s[0]?.role === "NEZHA2");

    const remembered = registry.rememberedRobots();
    expect(remembered.map((r) => r.name)).toEqual(["absnt"]);
    // The attached name stays visible via snapshot()/endpoints -- it's
    // just not duplicated into rememberedRobots().
    expect(registry.snapshot().map((e) => e.name)).toContain("zeguz");

    await registry.stop();
  });

  it("requestForgetKnownRobot removes the record from rememberedRobots() and notifies devicesListeners", async () => {
    const knownRobotsStore = new KnownRobotsStore({ stateDir: tmpDir });
    knownRobotsStore.recordSighting({ name: "gonee", usbSerial: "SERIAL-X", role: "NEZHA2" });

    const watcher = fixtureWatcher(() => []);
    const registry = new DeviceRegistry({ statusPollIntervalMs: 0, autoRequestFunctions: false,  watcher, knownRobotsStore });
    const notifications: EndpointListEntry[][] = [];
    registry.onDevicesChanged((snap) => notifications.push(snap));

    expect(registry.rememberedRobots().map((r) => r.name)).toEqual(["gonee"]);

    registry.requestForgetKnownRobot("gonee");

    expect(registry.rememberedRobots()).toEqual([]);
    expect(notifications.length).toBeGreaterThan(0);
  });

  it("requestForgetKnownRobot for a name not in the roster does not throw", () => {
    const knownRobotsStore = new KnownRobotsStore({ stateDir: tmpDir });
    const watcher = fixtureWatcher(() => []);
    const registry = new DeviceRegistry({ statusPollIntervalMs: 0, autoRequestFunctions: false,  watcher, knownRobotsStore });

    expect(() => registry.requestForgetKnownRobot("nobody-home")).not.toThrow();
    expect(registry.rememberedRobots()).toEqual([]);
  });

  it("a read-only store does not break identify -- a robot still identifies normally, it just isn't recorded", async () => {
    const devices = [device()];
    const watcher = fixtureWatcher(() => devices);
    const resolveName = async () => namedResult("zeguz");
    const createLink = () => new FakeLink(async () => banner({ role: "NEZHA2", commonName: "robot" }));

    // Force read-only by pre-writing a file with a version newer than
    // this build supports -- see knownRobots.ts's own doc comment.
    const filePath = path.join(tmpDir, "known-robots.json");
    writeFileSync(filePath, JSON.stringify({ version: 999, robots: [] }), "utf8");
    const knownRobotsStore = new KnownRobotsStore({ filePath });
    expect(knownRobotsStore.isReadOnly).toBe(true);

    const registry = new DeviceRegistry({ statusPollIntervalMs: 0, autoRequestFunctions: false,  watcher, resolveName, createLink, knownRobotsStore });
    registry.start();

    const snap = await waitForSnapshot(registry, (s) => s[0]?.role === "NEZHA2");
    expect(snap[0]).toEqual(expect.objectContaining({ name: "zeguz", role: "NEZHA2", sessionOpen: true }));

    expect(knownRobotsStore.list()).toEqual([]);

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

    const registry = new DeviceRegistry({ statusPollIntervalMs: 0, autoRequestFunctions: false, 
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

    const registry = new DeviceRegistry({ statusPollIntervalMs: 0, autoRequestFunctions: false, 
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
// Robot-via-relay endpoints (OOP 2026-09-09) -- requestOpen(relayId,
// { robotName, radio? }) synthesizing a new endpoint that bridges to a
// robot over a local USB relay's radio. See deviceRegistry.ts's own
// module doc comment's "Robot-via-relay endpoints" section.
//
// No code path exercised below (or in deviceRegistry.ts itself) ever
// calls a `retarget`-shaped method on `Link` -- `link/Link.ts`'s
// interface has no such method at all, so this is enforced by the type
// system, not by a runtime assertion here.
// ---------------------------------------------------------------------

describe("robot-via-relay endpoints (OOP 2026-09-09, coordinator-driven since sprint 8 ticket 004)", () => {
  function relayDevice(overrides: Partial<DaplinkDevice> = {}): DaplinkDevice {
    return device({
      serialNumber: "SERIAL-RELAY",
      displaySerial: "SHORT-RELAY",
      serialPort: { path: "/dev/cu.usbmodemRELAY" },
      ...overrides,
    });
  }

  function robotBanner(overrides: Partial<ParsedBanner> = {}): ParsedBanner {
    return banner({ role: "NEZHA2", commonName: "robot", name: "gopiv", ...overrides });
  }

  /** `createLink` fake for the relay's OWN plain USB session only --
   * every relay-radio/mbrelay/mbserial candidate is now built and
   * connected entirely inside {@link fakeCoordinator}'s handler (never
   * via this module's `createLink` seam, since
   * `RelayConnectionCoordinator.ts` owns that -- see
   * `deviceRegistry.ts`'s own module doc comment, "Relay-target
   * endpoint synthesis and switching" section). Throws for any other
   * transport so a test that forgets to fake the coordinator fails
   * loudly instead of silently reusing the wrong link. */
  function usbOnlyCreateLink(relayUsbLink: FakeLink): (spec: LinkSpec) => Link {
    return (spec) => {
      if (spec.transport === "usb") {
        return relayUsbLink;
      }
      throw new Error(
        `unexpected transport in this fixture: ${spec.transport} -- relay-radio/mbrelay/mbserial specs are the coordinator's job now, never this module's createLink`,
      );
    };
  }

  /** Attach `order.push(label)` onto an already-constructed `FakeLink`'s
   * `close()`, so a test can observe *when* a specific link was closed
   * relative to other events (`resetOverSwd`, the coordinator's own
   * `connect`) without `FakeLink` itself needing to know about any of
   * this. */
  function trackClose(link: FakeLink, order: string[], label: string): void {
    const originalClose = link.close.bind(link);
    link.close = () => {
      order.push(label);
      return originalClose();
    };
  }

  it("routes an explicit robotName through a single relay-radio candidate: candidate shape (including a matched _mbrelay._tcp registry location), reset-then-coordinator ordering, and both entries in the snapshot with addressSource/failoverTrail present while open", async () => {
    const devices = [relayDevice()];
    const watcher = fixtureWatcher(() => devices);
    const resolveName = async () => namedResult("rly01"); // matches the discovered _mbrelay._tcp instance name below.

    const order: string[] = [];
    const relayUsbLink = new FakeLink(async () => banner()); // banner()'s default fixture classifies as a relay.
    trackClose(relayUsbLink, order, "relay-usb-close");
    const createLink = usbOnlyCreateLink(relayUsbLink);

    const resetOverSwd = vi.fn(async () => {
      order.push("reset");
      return { ok: true as const };
    });

    const mdnsDiscovery = fakeMdnsDiscovery({
      relays: [{ instanceName: "rly01", host: "rly01.local", port: 8760, registryPort: 8761 }],
      robots: [],
    });

    const robotLink = new FakeLink(async () => robotBanner());
    const coordinator = fakeCoordinator(async (candidates) => {
      order.push("coordinator-connect");
      return {
        outcome: "connected",
        link: robotLink,
        name: candidates[0]!.name,
        classification: classifyBanner(robotBanner()),
        addressSource: "registry",
        failoverTrail: [],
      };
    });

    const registry = new DeviceRegistry({
      statusPollIntervalMs: 0,
      autoRequestFunctions: false,
      watcher,
      resolveName,
      createLink,
      resetOverSwd,
      relayBootDelayMs: 0,
      relayConnectionCoordinator: coordinator,
      mdnsDiscovery,
    });
    registry.start();

    await waitForSnapshot(
      registry,
      (s) => s[0]?.sessionOpen === true && s[0]?.classification.type === "relay",
    );
    expect(relayUsbLink.connectCalls).toBe(1);

    const expectedAddress = nameToRadioAddress("gopiv");
    await registry.requestOpen("usb-SERIAL-RELAY", { robotName: "gopiv" });

    const snap = await waitForSnapshot(registry, (s) =>
      s.some((e) => e.endpointId === "usb-SERIAL-RELAY-via-gopiv"),
    );

    // (i) the coordinator was called with exactly one relay-radio
    // candidate, carrying the matched registry location.
    expect(coordinator.calls).toHaveLength(1);
    expect(coordinator.calls[0]).toEqual([
      {
        transport: "relay-radio",
        name: "gopiv",
        portPath: "/dev/cu.usbmodemRELAY",
        resourceKey: "usb-SERIAL-RELAY",
        registry: { host: "rly01.local", port: 8761 },
      },
    ]);

    // (ii) the relay's plain link was closed first, resetOverSwd ran
    // before the coordinator was ever called.
    expect(order).toEqual(["relay-usb-close", "reset", "coordinator-connect"]);
    expect(resetOverSwd).toHaveBeenCalledWith(devices[0]);

    // (iii) both the relay entry (sessionOpen false) and the
    // synthesized via-gopiv entry (transport relay-radio, viaRelay, no
    // usb, shared resourceKey, classification from the fake banner,
    // addressSource/failoverTrail present since the session is open)
    // are present at once.
    const relayEntry = snap.find((e) => e.endpointId === "usb-SERIAL-RELAY");
    expect(relayEntry).toEqual(
      expect.objectContaining({ sessionOpen: false, transport: "usb", resourceKey: "usb-SERIAL-RELAY" }),
    );
    const viaEntry = snap.find((e) => e.endpointId === "usb-SERIAL-RELAY-via-gopiv");
    expect(viaEntry).toEqual(
      expect.objectContaining({
        transport: "relay-radio",
        resourceKey: "usb-SERIAL-RELAY",
        sessionOpen: true,
        name: "gopiv",
        viaRelay: {
          relayEndpointId: "usb-SERIAL-RELAY",
          robotName: "gopiv",
          channel: expectedAddress.channel,
          group: expectedAddress.group,
        },
        addressSource: "registry",
        failoverTrail: [],
        classification: expect.objectContaining({ type: "robot" }),
      }),
    );
    expect(viaEntry?.usb).toBeUndefined();

    // (iv) closing the session (a link error, not a deliberate close)
    // makes addressSource/failoverTrail disappear -- present only while
    // the session is open -- while the entry itself remains listed.
    robotLink.emitError(new Error("boom"));
    const snap2 = await waitForSnapshot(
      registry,
      (s) => s.find((e) => e.endpointId === "usb-SERIAL-RELAY-via-gopiv")?.sessionOpen === false,
    );
    const viaEntry2 = snap2.find((e) => e.endpointId === "usb-SERIAL-RELAY-via-gopiv");
    expect(viaEntry2).toBeDefined();
    expect(viaEntry2?.addressSource).toBeUndefined();
    expect(viaEntry2?.failoverTrail).toBeUndefined();

    await registry.stop();
  });

  it("an explicit radio override becomes the candidate's explicit address and addressSource \"explicit\", never consulting a matched registry location", async () => {
    const devices = [relayDevice()];
    const watcher = fixtureWatcher(() => devices);
    const resolveName = async () => namedResult("rly01");
    const relayUsbLink = new FakeLink(async () => banner());
    const createLink = usbOnlyCreateLink(relayUsbLink);
    // A matching registry location exists but must be ignored -- an
    // explicit override bypasses resolution entirely (RelayConnectionCoordinator.ts's
    // own "Explicit address override" contract).
    const mdnsDiscovery = fakeMdnsDiscovery({
      relays: [{ instanceName: "rly01", host: "rly01.local", port: 8760, registryPort: 8761 }],
      robots: [],
    });

    const robotLink = new FakeLink(async () => robotBanner());
    const coordinator = fakeCoordinator(async (candidates) => ({
      outcome: "connected",
      link: robotLink,
      name: candidates[0]!.name,
      classification: classifyBanner(robotBanner()),
      addressSource: "explicit",
      failoverTrail: [],
    }));

    const registry = new DeviceRegistry({
      statusPollIntervalMs: 0,
      autoRequestFunctions: false,
      watcher,
      resolveName,
      createLink,
      resetOverSwd: async () => ({ ok: true }),
      relayBootDelayMs: 0,
      relayConnectionCoordinator: coordinator,
      mdnsDiscovery,
    });
    registry.start();
    await waitForSnapshot(registry, (s) => s[0]?.sessionOpen === true);

    await registry.requestOpen("usb-SERIAL-RELAY", { robotName: "gopiv", radio: { channel: 55, group: 114 } });
    const snap = await waitForSnapshot(registry, (s) => s.some((e) => e.endpointId === "usb-SERIAL-RELAY-via-gopiv"));

    expect(coordinator.calls[0]).toEqual([
      {
        transport: "relay-radio",
        name: "gopiv",
        portPath: "/dev/cu.usbmodemRELAY",
        resourceKey: "usb-SERIAL-RELAY",
        address: { channel: 55, group: 114 },
      },
    ]);
    const viaEntry = snap.find((e) => e.endpointId === "usb-SERIAL-RELAY-via-gopiv");
    expect(viaEntry?.addressSource).toBe("explicit");
    expect(viaEntry?.viaRelay).toEqual(
      expect.objectContaining({ channel: 55, group: 114 }),
    );

    await registry.stop();
  });

  it("switching to another robot name removes the old synthesized endpoint and adds a new one", async () => {
    const devices = [relayDevice()];
    const watcher = fixtureWatcher(() => devices);
    const resolveName = async () => namedResult("rly01");

    const relayUsbLink = new FakeLink(async () => banner());
    const createLink = usbOnlyCreateLink(relayUsbLink);
    const links: FakeLink[] = [];
    const coordinator = fakeCoordinator(async (candidates) => {
      const link = new FakeLink(async () => robotBanner({ name: candidates[0]!.name }));
      links.push(link);
      return {
        outcome: "connected",
        link,
        name: candidates[0]!.name,
        classification: classifyBanner(robotBanner()),
        failoverTrail: [],
      };
    });

    const registry = new DeviceRegistry({
      statusPollIntervalMs: 0,
      autoRequestFunctions: false,
      watcher,
      resolveName,
      createLink,
      resetOverSwd: async () => ({ ok: true }),
      relayBootDelayMs: 0,
      relayConnectionCoordinator: coordinator,
    });
    registry.start();
    await waitForSnapshot(registry, (s) => s[0]?.sessionOpen === true);

    await registry.requestOpen("usb-SERIAL-RELAY", { robotName: "gopiv" });
    await waitForSnapshot(registry, (s) => s.some((e) => e.endpointId === "usb-SERIAL-RELAY-via-gopiv"));

    await registry.requestOpen("usb-SERIAL-RELAY", { robotName: "tapaz" });
    const snap = await waitForSnapshot(registry, (s) => s.some((e) => e.endpointId === "usb-SERIAL-RELAY-via-tapaz"));

    expect(snap.some((e) => e.endpointId === "usb-SERIAL-RELAY-via-gopiv")).toBe(false);
    expect(snap.some((e) => e.endpointId === "usb-SERIAL-RELAY-via-tapaz")).toBe(true);
    expect(links).toHaveLength(2);
    expect(links[0]?.closeCalls).toBe(1); // the old synthesized link was torn down.

    await registry.stop();
  });

  it("requestClose on the synthesized endpoint removes it and reopens the relay's own plain USB session", async () => {
    const devices = [relayDevice()];
    const watcher = fixtureWatcher(() => devices);
    const resolveName = async () => namedResult("rly01");

    let usbLinkCreations = 0;
    const createLink = (spec: LinkSpec): Link => {
      if (spec.transport === "usb") {
        usbLinkCreations++;
        return new FakeLink(async () => banner());
      }
      throw new Error(`unexpected transport in this fixture: ${spec.transport}`);
    };
    const radioLink = new FakeLink(async () => robotBanner());
    const coordinator = fakeCoordinator(async (candidates) => ({
      outcome: "connected",
      link: radioLink,
      name: candidates[0]!.name,
      classification: classifyBanner(robotBanner()),
      failoverTrail: [],
    }));

    const registry = new DeviceRegistry({
      statusPollIntervalMs: 0,
      autoRequestFunctions: false,
      watcher,
      resolveName,
      createLink,
      resetOverSwd: async () => ({ ok: true }),
      relayBootDelayMs: 0,
      relayConnectionCoordinator: coordinator,
    });
    registry.start();
    await waitForSnapshot(registry, (s) => s[0]?.sessionOpen === true);
    expect(usbLinkCreations).toBe(1);

    await registry.requestOpen("usb-SERIAL-RELAY", { robotName: "gopiv" });
    await waitForSnapshot(registry, (s) => s.some((e) => e.endpointId === "usb-SERIAL-RELAY-via-gopiv"));

    await registry.requestClose("usb-SERIAL-RELAY-via-gopiv");
    const snap = await waitForSnapshot(
      registry,
      (s) => !s.some((e) => e.endpointId === "usb-SERIAL-RELAY-via-gopiv") && s[0]?.sessionOpen === true,
    );

    expect(snap.find((e) => e.endpointId === "usb-SERIAL-RELAY")?.sessionOpen).toBe(true);
    expect(usbLinkCreations).toBe(2); // a fresh plain USB link was opened for the relay again.

    await registry.stop();
  });

  it("exhausted candidates report an error, create no synthesized entry, and reopen the relay's own session", async () => {
    const devices = [relayDevice()];
    const watcher = fixtureWatcher(() => devices);
    const resolveName = async () => namedResult("rly01");

    let usbLinkCreations = 0;
    const createLink = (spec: LinkSpec): Link => {
      if (spec.transport === "usb") {
        usbLinkCreations++;
        return new FakeLink(async () => banner());
      }
      throw new Error(`unexpected transport in this fixture: ${spec.transport}`);
    };
    const coordinator = fakeCoordinator(async (candidates) => ({
      outcome: "exhausted",
      failoverTrail: candidates.map((c) => ({ name: c.name, transport: c.transport, reason: "mock: no reply" })),
    }));

    const registry = new DeviceRegistry({
      statusPollIntervalMs: 0,
      autoRequestFunctions: false,
      watcher,
      resolveName,
      createLink,
      resetOverSwd: async () => ({ ok: true }),
      relayBootDelayMs: 0,
      relayConnectionCoordinator: coordinator,
    });
    const errors: Array<{ endpointId: string | undefined; message: string }> = [];
    registry.onError((endpointId, message) => errors.push({ endpointId, message }));
    registry.start();
    await waitForSnapshot(registry, (s) => s[0]?.sessionOpen === true);
    expect(usbLinkCreations).toBe(1);

    await registry.requestOpen("usb-SERIAL-RELAY", { robotName: "gopiv" });
    const snap = await waitForSnapshot(registry, (s) => s[0]?.sessionOpen === true);

    expect(snap.some((e) => e.endpointId === "usb-SERIAL-RELAY-via-gopiv")).toBe(false);
    expect(errors).toContainEqual(
      expect.objectContaining({
        endpointId: "usb-SERIAL-RELAY",
        message: expect.stringContaining("gopiv"),
      }),
    );
    expect(usbLinkCreations).toBe(2); // relay's own session was reopened after exhaustion.

    await registry.stop();
  });

  it("removing the relay device also removes its synthesized via-relay endpoint", async () => {
    let devices = [relayDevice()];
    const watcher = fixtureWatcher(() => devices);
    const resolveName = async () => namedResult("rly01");

    const relayUsbLink = new FakeLink(async () => banner());
    const createLink = usbOnlyCreateLink(relayUsbLink);
    const radioLink = new FakeLink(async () => robotBanner());
    const coordinator = fakeCoordinator(async (candidates) => ({
      outcome: "connected",
      link: radioLink,
      name: candidates[0]!.name,
      classification: classifyBanner(robotBanner()),
      failoverTrail: [],
    }));

    const registry = new DeviceRegistry({
      statusPollIntervalMs: 0,
      autoRequestFunctions: false,
      watcher,
      resolveName,
      createLink,
      resetOverSwd: async () => ({ ok: true }),
      relayBootDelayMs: 0,
      relayConnectionCoordinator: coordinator,
    });
    registry.start();
    await waitForSnapshot(registry, (s) => s[0]?.sessionOpen === true);

    await registry.requestOpen("usb-SERIAL-RELAY", { robotName: "gopiv" });
    await waitForSnapshot(registry, (s) => s.some((e) => e.endpointId === "usb-SERIAL-RELAY-via-gopiv"));

    devices = [];
    await watcher.pollOnce();
    const snap = await waitForSnapshot(registry, (s) => s.length === 0);
    expect(snap).toEqual([]);
    expect(radioLink.closeCalls).toBe(1);

    await registry.stop();
  });

  it("sendCommand on the synthesized endpoint routes to the coordinator-connected link", async () => {
    const devices = [relayDevice()];
    const watcher = fixtureWatcher(() => devices);
    const resolveName = async () => namedResult("rly01");

    const relayUsbLink = new FakeLink(async () => banner());
    const createLink = usbOnlyCreateLink(relayUsbLink);
    const radioLink = new FakeLink(async () => robotBanner());
    const coordinator = fakeCoordinator(async (candidates) => ({
      outcome: "connected",
      link: radioLink,
      name: candidates[0]!.name,
      classification: classifyBanner(robotBanner()),
      failoverTrail: [],
    }));

    const registry = new DeviceRegistry({
      statusPollIntervalMs: 0,
      autoRequestFunctions: false,
      watcher,
      resolveName,
      createLink,
      resetOverSwd: async () => ({ ok: true }),
      relayBootDelayMs: 0,
      relayConnectionCoordinator: coordinator,
    });
    registry.start();
    await waitForSnapshot(registry, (s) => s[0]?.sessionOpen === true);

    await registry.requestOpen("usb-SERIAL-RELAY", { robotName: "gopiv" });
    await waitForSnapshot(registry, (s) => s.some((e) => e.endpointId === "usb-SERIAL-RELAY-via-gopiv"));

    await registry.sendCommand("usb-SERIAL-RELAY-via-gopiv", "STATUS");
    expect(radioLink.sentLines).toEqual(["STATUS\n"]);

    await registry.stop();
  });

  it("a connected-but-silent coordinator result (classifyBanner(null), evidence \"none\") leaves the synthesized endpoint open with a descriptive sessionError", async () => {
    const devices = [relayDevice()];
    const watcher = fixtureWatcher(() => devices);
    const resolveName = async () => namedResult("rly01");

    const relayUsbLink = new FakeLink(async () => banner());
    const createLink = usbOnlyCreateLink(relayUsbLink);
    const radioLink = new FakeLink(async () => null);
    const coordinator = fakeCoordinator(async (candidates) => ({
      outcome: "connected",
      link: radioLink,
      name: candidates[0]!.name,
      classification: classifyBanner(null),
      failoverTrail: [],
    }));

    const registry = new DeviceRegistry({
      statusPollIntervalMs: 0,
      autoRequestFunctions: false,
      watcher,
      resolveName,
      createLink,
      resetOverSwd: async () => ({ ok: true }),
      relayBootDelayMs: 0,
      relayConnectionCoordinator: coordinator,
    });
    registry.start();
    await waitForSnapshot(registry, (s) => s[0]?.sessionOpen === true);

    await registry.requestOpen("usb-SERIAL-RELAY", { robotName: "gopiv" });
    const snap = await waitForSnapshot(registry, (s) =>
      s.some((e) => e.endpointId === "usb-SERIAL-RELAY-via-gopiv"),
    );

    const viaEntry = snap.find((e) => e.endpointId === "usb-SERIAL-RELAY-via-gopiv");
    expect(viaEntry?.sessionOpen).toBe(true);
    expect(viaEntry?.classification.type).toBe("unknown");
    expect(viaEntry?.sessionError).toEqual(expect.stringContaining("gopiv"));

    await registry.stop();
  });

  it("an mbserial-transport coordinator result has no viaRelay/addressSource/failoverTrail on the wire (no channel/group, no address-source spectrum for that transport)", async () => {
    const devices = [relayDevice()];
    const watcher = fixtureWatcher(() => devices);
    const resolveName = async () => namedResult("rly01");

    const relayUsbLink = new FakeLink(async () => banner());
    const createLink = usbOnlyCreateLink(relayUsbLink);
    const mdnsDiscovery = fakeMdnsDiscovery({
      relays: [],
      robots: [{ instanceName: "mmmmm", host: "mmmmm.local", port: 9000 }],
    });

    const robotLink = new FakeLink(async () => robotBanner({ name: "mmmmm" }));
    const coordinator = fakeCoordinator(async () => ({
      outcome: "connected",
      link: robotLink,
      name: "mmmmm",
      classification: classifyBanner(robotBanner({ name: "mmmmm" })),
      failoverTrail: [{ name: "rly01-roster-miss", transport: "relay-radio", reason: "mock: no reply" }],
      // no addressSource -- mbserial never reports one.
    }));

    const registry = new DeviceRegistry({
      statusPollIntervalMs: 0,
      autoRequestFunctions: false,
      watcher,
      resolveName,
      createLink,
      resetOverSwd: async () => ({ ok: true }),
      relayBootDelayMs: 0,
      relayConnectionCoordinator: coordinator,
      mdnsDiscovery,
    });
    registry.start();
    await waitForSnapshot(registry, (s) => s[0]?.sessionOpen === true);

    // Default-failover (no robotName) is what can land on an mbserial
    // candidate at all -- see the dedicated ordering test below for the
    // candidate-building policy itself.
    await registry.requestOpen("usb-SERIAL-RELAY", {});
    const snap = await waitForSnapshot(registry, (s) => s.some((e) => e.endpointId === "usb-SERIAL-RELAY-via-mmmmm"));

    const viaEntry = snap.find((e) => e.endpointId === "usb-SERIAL-RELAY-via-mmmmm");
    expect(viaEntry?.transport).toBe("mbserial");
    // mbserial has its own independent resourceKey -- never shared with
    // the triggering relay.
    expect(viaEntry?.resourceKey).toBe("mbserial-mmmmm");
    expect(viaEntry?.viaRelay).toBeUndefined();
    expect(viaEntry?.addressSource).toBeUndefined();
    expect(viaEntry?.failoverTrail).toBeUndefined();
    expect(viaEntry?.usb).toBeUndefined();

    await registry.stop();
  });

  it("default failover (no robotName): candidates are every remembered robot name most-recently-seen-first, then every discovered _mbserial._tcp instance name not already listed", async () => {
    const devices = [relayDevice()];
    const watcher = fixtureWatcher(() => devices);
    const resolveName = async () => namedResult("rly01");

    const relayUsbLink = new FakeLink(async () => banner());
    const createLink = usbOnlyCreateLink(relayUsbLink);

    const knownRobotsStore = {
      list: () => [
        {
          name: "aaaaa",
          firstSeenAt: "2026-01-01T00:00:00.000Z",
          lastSeenAt: "2026-01-01T00:00:00.000Z",
          lastSeenVia: "usb" as const,
          lastUsbSerial: "X",
          lastRole: null,
          lastType: "robot" as const,
        },
        {
          name: "zzzzz",
          firstSeenAt: "2026-06-01T00:00:00.000Z",
          lastSeenAt: "2026-06-01T00:00:00.000Z",
          lastSeenVia: "usb" as const,
          lastUsbSerial: "Y",
          lastRole: null,
          lastType: "robot" as const,
        },
      ],
      get: () => undefined,
      recordSighting: () => {},
      forget: () => false,
      flush: async () => {},
      isReadOnly: false,
    } as unknown as KnownRobotsStore;

    const mdnsDiscovery = fakeMdnsDiscovery({
      relays: [],
      robots: [
        { instanceName: "zzzzz", host: "zzzzz.local", port: 1 }, // already remembered -- must not be duplicated
        { instanceName: "mmmmm", host: "mmmmm.local", port: 2 }, // new -- included
      ],
    });

    const coordinator = fakeCoordinator(async (candidates) => ({
      outcome: "exhausted",
      failoverTrail: candidates.map((c) => ({ name: c.name, transport: c.transport, reason: "mock: no reply" })),
    }));

    const registry = new DeviceRegistry({
      statusPollIntervalMs: 0,
      autoRequestFunctions: false,
      watcher,
      resolveName,
      createLink,
      resetOverSwd: async () => ({ ok: true }),
      relayBootDelayMs: 0,
      relayConnectionCoordinator: coordinator,
      knownRobotsStore,
      mdnsDiscovery,
    });
    registry.start();
    await waitForSnapshot(registry, (s) => s[0]?.sessionOpen === true);

    await registry.requestOpen("usb-SERIAL-RELAY", {});
    await waitForSnapshot(registry, (s) => s[0]?.sessionOpen === true); // exhausted -> relay's own session reopened.

    expect(coordinator.calls).toHaveLength(1);
    expect(coordinator.calls[0]).toEqual([
      { transport: "relay-radio", name: "zzzzz", portPath: "/dev/cu.usbmodemRELAY", resourceKey: "usb-SERIAL-RELAY" },
      { transport: "relay-radio", name: "aaaaa", portPath: "/dev/cu.usbmodemRELAY", resourceKey: "usb-SERIAL-RELAY" },
      { transport: "mbserial", name: "mmmmm", host: "mmmmm.local", port: 2, resourceKey: "mbserial-mmmmm" },
    ]);

    await registry.stop();
  });

  it("a flash request against the relay's own endpointId queues behind an in-flight robot-via-relay open on the shared resourceKey (direct KeyedMutex ordering)", async () => {
    const devices = [relayDevice()];
    const watcher = fixtureWatcher(() => devices);
    const resolveName = async () => namedResult("rly01");

    const relayUsbLink = new FakeLink(async () => banner());
    const createLink = usbOnlyCreateLink(relayUsbLink);
    const radioLink = new FakeLink(async () => robotBanner());

    const order: string[] = [];
    const coordinator = fakeCoordinator(async (candidates) => {
      order.push("coordinator-connect-start");
      await new Promise((resolve) => setTimeout(resolve, 10));
      order.push("coordinator-connect-end");
      return {
        outcome: "connected",
        link: radioLink,
        name: candidates[0]!.name,
        classification: classifyBanner(robotBanner()),
        failoverTrail: [],
      };
    });

    const resolveReleaseFn = vi.fn(async (): Promise<ResolvedRelease> => {
      order.push("flash-resolve-start");
      await new Promise((resolve) => setTimeout(resolve, 10));
      order.push("flash-resolve-end");
      return resolvedRelease();
    });
    const fetchAndVerifyHexFn = vi.fn(async () => ({ hex: Buffer.from(":00000001FF\n") }));
    const flashFn = vi.fn(async (): Promise<FlashOutcome> => ({ status: "ok", method: "swd" }));

    const registry = new DeviceRegistry({
      statusPollIntervalMs: 0,
      autoRequestFunctions: false,
      watcher,
      resolveName,
      createLink,
      resetOverSwd: async () => ({ ok: true }),
      relayBootDelayMs: 0,
      relayConnectionCoordinator: coordinator,
      getFirmwareConfig: configWith(firmwareSource()),
      resolveRelease: resolveReleaseFn,
      fetchAndVerifyHex: fetchAndVerifyHexFn,
      flash: flashFn,
    });
    registry.start();
    await waitForSnapshot(registry, (s) => s[0]?.sessionOpen === true);

    // Issued back-to-back on the relay's own endpointId: requestOpen's
    // mutex slot for "usb-SERIAL-RELAY" is claimed first (it is called
    // first, synchronously), so requestFlash's own work must wait for
    // the whole robot-via-relay open (including the coordinator's own
    // slow "connect") to finish before it ever starts -- the same
    // KeyedMutex guarantee the existing plain-USB precedent test above
    // proves, now for the relay's shared resourceKey with a
    // robot-via-relay child in the picture.
    const openPromise = registry
      .requestOpen("usb-SERIAL-RELAY", { robotName: "gopiv" })
      .then(() => order.push("open-done"));
    const flashPromise = registry
      .requestFlash("usb-SERIAL-RELAY", releaseSource("relay"))
      .then(() => order.push("flash-done"));

    await Promise.all([openPromise, flashPromise]);

    expect(order).toEqual([
      "coordinator-connect-start",
      "coordinator-connect-end",
      "open-done",
      "flash-resolve-start",
      "flash-resolve-end",
      "flash-done",
    ]);

    await registry.stop();
  });

  // AC (sprint 8 ticket 004): no code path in deviceRegistry.ts (or in
  // this test file) calls a retarget-shaped method on Link -- the
  // Link interface (link/Link.ts) has no such method at all, so this
  // is enforced by the type system, not a runtime check exercised here.
});

// ---------------------------------------------------------------------
// WiFi endpoint synthesis and connect-on-click (sprint 10 ticket 003).
// A gated WiFi robot (ticket 002's gateWifiRobots, applied to ticket
// 001's mdnsDiscovery.current().wifiRobots and knownRobotsStore.list())
// is minted immediately as an EndpointListEntry -- list first, connect
// on request, mirroring the USB attach flow -- and connected via an
// ordinary session-open, exactly like every other transport.
// ---------------------------------------------------------------------

describe("WiFi endpoint synthesis and connect-on-click (sprint 10 ticket 003)", () => {
  /** A `KnownRobotsStore`-shaped fake roster containing exactly `names`
   * -- mirrors the "robot-via-relay endpoints" describe block's own
   * inline fake-store fixture pattern above, trimmed to just what
   * `gateWifiRobots` reads (`list()`). */
  function fakeRoster(names: string[]): KnownRobotsStore {
    return {
      list: () =>
        names.map((name) => ({
          name,
          firstSeenAt: "2026-01-01T00:00:00.000Z",
          lastSeenAt: "2026-01-01T00:00:00.000Z",
          lastSeenVia: "usb" as const,
          lastUsbSerial: `SERIAL-${name}`,
          lastRole: "NEZHA2",
          lastType: "robot" as const,
        })),
      get: () => undefined,
      recordSighting: () => {},
      forget: () => false,
      flush: async () => {},
      isReadOnly: false,
    } as unknown as KnownRobotsStore;
  }

  function wifiRobotBanner(overrides: Partial<ParsedBanner> = {}): ParsedBanner {
    return banner({ role: "NEZHA2", commonName: "robot", name: "gopiv", ...overrides });
  }

  /** `createLink` fake dispatching only on `"wifi"` -- every test in
   * this block never attaches a USB device, so any other transport
   * reaching this seam is itself a bug in the fixture. */
  function wifiOnlyCreateLink(byHostPort: Map<string, FakeLink>): (spec: LinkSpec) => Link {
    return (spec) => {
      if (spec.transport !== "wifi") {
        throw new Error(`unexpected transport in this fixture: ${spec.transport} -- only "wifi" is faked here`);
      }
      const link = byHostPort.get(`${spec.host}:${spec.port}`);
      if (!link) {
        throw new Error(`no fake link registered for wifi ${spec.host}:${spec.port}`);
      }
      return link;
    };
  }

  it("a gated WiFi robot (roster-matched) appears in snapshot() as transport: wifi, sessionOpen: false, before any connect is requested", async () => {
    const watcher = fixtureWatcher(() => []);
    const knownRobotsStore = fakeRoster(["gopiv"]);
    const mdnsDiscovery = fakeMdnsDiscovery({
      relays: [],
      robots: [],
      wifiRobots: [{ name: "gopiv", host: "gopiv.local.", port: 7654, role: "robot", link: "v6" }],
    });

    const registry = new DeviceRegistry({
      statusPollIntervalMs: 0,
      autoRequestFunctions: false,
      watcher,
      knownRobotsStore,
      mdnsDiscovery,
    });
    registry.start();

    const snap = await waitForSnapshot(registry, (s) => s.some((e) => e.endpointId === "wifi-gopiv"));
    expect(snap).toEqual([
      expect.objectContaining({
        endpointId: "wifi-gopiv",
        transport: "wifi",
        resourceKey: "wifi-gopiv",
        name: "gopiv",
        sessionOpen: false,
        wifi: { host: "gopiv.local.", port: 7654 },
      }),
    ]);
    expect(snap[0]?.usb).toBeUndefined();

    await registry.stop();
  });

  it("end-to-end negative: an advertised robot absent from the roster never produces an EndpointListEntry, even though the raw discovery fixture contains it", async () => {
    const watcher = fixtureWatcher(() => []);
    const knownRobotsStore = fakeRoster(["zeguz"]); // "gopiv" is NOT enrolled.
    const mdnsDiscovery = fakeMdnsDiscovery({
      relays: [],
      robots: [],
      wifiRobots: [{ name: "gopiv", host: "gopiv.local.", port: 7654 }],
    });

    const registry = new DeviceRegistry({
      statusPollIntervalMs: 0,
      autoRequestFunctions: false,
      watcher,
      knownRobotsStore,
      mdnsDiscovery,
    });
    registry.start();

    // Give the (inert, fake) mdns start a moment; there is no discovery
    // event to await here beyond what start() itself may fire, so poll
    // the plain snapshot a handful of times and confirm it never gains
    // an entry.
    for (let i = 0; i < 10; i++) {
      expect(registry.snapshot().some((e) => e.endpointId === "wifi-gopiv")).toBe(false);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    await registry.stop();
  });

  it('requestOpen("wifi-<name>") connects via a WifiLinkSpec built from the gated record\'s host/port, identifies, and flips sessionOpen to true with classification/name populated', async () => {
    const watcher = fixtureWatcher(() => []);
    const knownRobotsStore = fakeRoster(["gopiv"]);
    const mdnsDiscovery = fakeMdnsDiscovery({
      relays: [],
      robots: [],
      wifiRobots: [{ name: "gopiv", host: "gopiv.local.", port: 7654 }],
    });

    const wifiLink = new FakeLink(async () => wifiRobotBanner());
    const createLink = vi.fn(wifiOnlyCreateLink(new Map([["gopiv.local.:7654", wifiLink]])));

    const registry = new DeviceRegistry({
      statusPollIntervalMs: 0,
      autoRequestFunctions: false,
      watcher,
      knownRobotsStore,
      mdnsDiscovery,
      createLink,
    });
    registry.start();
    await waitForSnapshot(registry, (s) => s.some((e) => e.endpointId === "wifi-gopiv"));

    await registry.requestOpen("wifi-gopiv");
    const snap = await waitForSnapshot(registry, (s) => s.find((e) => e.endpointId === "wifi-gopiv")?.sessionOpen === true);

    expect(createLink).toHaveBeenCalledWith({ transport: "wifi", host: "gopiv.local.", port: 7654 });
    expect(wifiLink.connectCalls).toBe(1);
    expect(wifiLink.identifyCalls).toBe(1);
    expect(snap[0]).toEqual(
      expect.objectContaining({
        endpointId: "wifi-gopiv",
        transport: "wifi",
        sessionOpen: true,
        name: "gopiv",
        role: "NEZHA2",
        classification: expect.objectContaining({ type: "robot" }),
      }),
    );

    // Sprint 5 write gate stays USB-only -- a WiFi identify never
    // enrolls or refreshes the durable roster (deviceRegistry.ts's own
    // maybeRecordKnownRobot doc comment).
    expect(knownRobotsStore.list()).toEqual([expect.objectContaining({ name: "gopiv" })]);

    await registry.stop();
  });

  it("a null banner on WiFi connect is 'connected, unresponsive', not an error: sessionOpen stays true with classification.type unknown", async () => {
    const watcher = fixtureWatcher(() => []);
    const knownRobotsStore = fakeRoster(["gopiv"]);
    const mdnsDiscovery = fakeMdnsDiscovery({
      relays: [],
      robots: [],
      wifiRobots: [{ name: "gopiv", host: "gopiv.local.", port: 7654 }],
    });
    const wifiLink = new FakeLink(async () => null);
    const createLink = wifiOnlyCreateLink(new Map([["gopiv.local.:7654", wifiLink]]));

    const registry = new DeviceRegistry({
      statusPollIntervalMs: 0,
      autoRequestFunctions: false,
      watcher,
      knownRobotsStore,
      mdnsDiscovery,
      createLink,
    });
    registry.start();
    await waitForSnapshot(registry, (s) => s.some((e) => e.endpointId === "wifi-gopiv"));

    await registry.requestOpen("wifi-gopiv");
    const snap = await waitForSnapshot(registry, (s) => s.find((e) => e.endpointId === "wifi-gopiv")?.sessionOpen === true);

    expect(snap[0]).toEqual(
      expect.objectContaining({
        sessionOpen: true,
        classification: expect.objectContaining({ type: "unknown" }),
      }),
    );
    expect(snap[0]?.sessionError).toBeUndefined();

    await registry.stop();
  });

  it("requestClose tears the session down but keeps the entry listed while the advertisement stands", async () => {
    const watcher = fixtureWatcher(() => []);
    const knownRobotsStore = fakeRoster(["gopiv"]);
    const mdnsDiscovery = fakeMdnsDiscovery({
      relays: [],
      robots: [],
      wifiRobots: [{ name: "gopiv", host: "gopiv.local.", port: 7654 }],
    });
    const wifiLink = new FakeLink(async () => wifiRobotBanner());
    const createLink = wifiOnlyCreateLink(new Map([["gopiv.local.:7654", wifiLink]]));

    const registry = new DeviceRegistry({
      statusPollIntervalMs: 0,
      autoRequestFunctions: false,
      watcher,
      knownRobotsStore,
      mdnsDiscovery,
      createLink,
    });
    registry.start();
    await waitForSnapshot(registry, (s) => s.some((e) => e.endpointId === "wifi-gopiv"));
    await registry.requestOpen("wifi-gopiv");
    await waitForSnapshot(registry, (s) => s.find((e) => e.endpointId === "wifi-gopiv")?.sessionOpen === true);

    await registry.requestClose("wifi-gopiv");
    const snap = await waitForSnapshot(registry, (s) => s.find((e) => e.endpointId === "wifi-gopiv")?.sessionOpen === false);

    expect(wifiLink.closeCalls).toBe(1);
    expect(snap.some((e) => e.endpointId === "wifi-gopiv")).toBe(true);

    await registry.stop();
  });

  it("a down event on a not-yet-connected WiFi robot removes its EndpointListEntry from the next snapshot", async () => {
    const watcher = fixtureWatcher(() => []);
    const knownRobotsStore = fakeRoster(["gopiv"]);
    const mdnsDiscovery = fakeMdnsDiscovery({
      relays: [],
      robots: [],
      wifiRobots: [{ name: "gopiv", host: "gopiv.local.", port: 7654 }],
    }) as unknown as MdnsDiscovery & { setSnapshot: (next: unknown) => void };

    const registry = new DeviceRegistry({
      statusPollIntervalMs: 0,
      autoRequestFunctions: false,
      watcher,
      knownRobotsStore,
      mdnsDiscovery,
    });
    registry.start();
    await waitForSnapshot(registry, (s) => s.some((e) => e.endpointId === "wifi-gopiv"));

    // The advertisement goes down -- gopiv no longer appears in the raw
    // discovery snapshot at all.
    mdnsDiscovery.setSnapshot({ relays: [], robots: [], wifiRobots: [] });
    const snap = await waitForSnapshot(registry, (s) => !s.some((e) => e.endpointId === "wifi-gopiv"));
    expect(snap).toEqual([]);

    await registry.stop();
  });

  it("a down event on an already-open WiFi session's advertisement does not close the session or remove the endpoint", async () => {
    const watcher = fixtureWatcher(() => []);
    const knownRobotsStore = fakeRoster(["gopiv"]);
    const mdnsDiscovery = fakeMdnsDiscovery({
      relays: [],
      robots: [],
      wifiRobots: [{ name: "gopiv", host: "gopiv.local.", port: 7654 }],
    }) as unknown as MdnsDiscovery & { setSnapshot: (next: unknown) => void };
    const wifiLink = new FakeLink(async () => wifiRobotBanner());
    const createLink = wifiOnlyCreateLink(new Map([["gopiv.local.:7654", wifiLink]]));

    const registry = new DeviceRegistry({
      statusPollIntervalMs: 0,
      autoRequestFunctions: false,
      watcher,
      knownRobotsStore,
      mdnsDiscovery,
      createLink,
    });
    registry.start();
    await waitForSnapshot(registry, (s) => s.some((e) => e.endpointId === "wifi-gopiv"));
    await registry.requestOpen("wifi-gopiv");
    await waitForSnapshot(registry, (s) => s.find((e) => e.endpointId === "wifi-gopiv")?.sessionOpen === true);

    // The advertisement disappears while the session is open.
    mdnsDiscovery.setSnapshot({ relays: [], robots: [], wifiRobots: [] });
    // Give the (synchronous) change handler a moment to run, then assert
    // the entry is still there and still open -- never removed, never
    // torn down, by this ad-disappearing event alone.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const snap = registry.snapshot();
    const entry = snap.find((e) => e.endpointId === "wifi-gopiv");
    expect(entry?.sessionOpen).toBe(true);
    expect(wifiLink.closeCalls).toBe(0);

    // Only the link's own close/error ends it -- confirm that still
    // works normally afterward.
    wifiLink.emitError(new Error("connection reset"));
    const afterError = await waitForSnapshot(registry, (s) => s.find((e) => e.endpointId === "wifi-gopiv")?.sessionOpen === false);
    expect(afterError.some((e) => e.endpointId === "wifi-gopiv")).toBe(true);

    await registry.stop();
  });

  it("requestOpen on a wifi-transport endpoint runs under the same per-endpoint KeyedMutex as every other operation (a concurrent requestClose queues behind it)", async () => {
    const watcher = fixtureWatcher(() => []);
    const knownRobotsStore = fakeRoster(["gopiv"]);
    const mdnsDiscovery = fakeMdnsDiscovery({
      relays: [],
      robots: [],
      wifiRobots: [{ name: "gopiv", host: "gopiv.local.", port: 7654 }],
    });

    let resolveConnect: (() => void) | undefined;
    const wifiLink = new FakeLink(
      async () => wifiRobotBanner(),
      () => new Promise<void>((resolve) => { resolveConnect = resolve; }),
    );
    const createLink = wifiOnlyCreateLink(new Map([["gopiv.local.:7654", wifiLink]]));

    const registry = new DeviceRegistry({
      statusPollIntervalMs: 0,
      autoRequestFunctions: false,
      watcher,
      knownRobotsStore,
      mdnsDiscovery,
      createLink,
    });
    registry.start();
    await waitForSnapshot(registry, (s) => s.some((e) => e.endpointId === "wifi-gopiv"));

    const openPromise = registry.requestOpen("wifi-gopiv");
    // requestClose queues behind the still-connecting requestOpen on the
    // same resourceKey/endpointId ("wifi-gopiv") -- it must not run (and
    // therefore not call close()) until connect() resolves and the
    // session is fully attached.
    const closePromise = registry.requestClose("wifi-gopiv");

    // KeyedMutex.run schedules the queued task via a Promise `.then()`
    // (a microtask), not synchronously -- give it a chance to actually
    // reach connectAndIdentifyWifi's `link.connect()` call before
    // asserting anything about it.
    for (let i = 0; i < 20 && wifiLink.connectCalls === 0; i++) {
      await Promise.resolve();
    }
    expect(wifiLink.connectCalls).toBe(1);
    expect(wifiLink.closeCalls).toBe(0);

    resolveConnect?.();
    await openPromise;
    await closePromise;

    expect(wifiLink.connectCalls).toBe(1);
    expect(wifiLink.closeCalls).toBe(1);

    await registry.stop();
  });
});

// ---------------------------------------------------------------------
// Auto-switch radio -> WiFi (sprint 10 ticket 004). A robot currently
// connected through a relay (a `<relay>-via-<name>` synthesized child,
// session open) that starts advertising over WiFi is automatically
// switched: `wifi-<name>` is opened via ticket 003's own connect path
// *first*; only once that succeeds is the radio child torn down
// (reopening the relay's own plain USB session, exactly like a
// deliberate requestClose). A failed WiFi attempt leaves the radio
// session completely untouched. See deviceRegistry.ts's own doc
// comment, "Auto-switch radio -> WiFi" section, for the full policy
// this exercises.
// ---------------------------------------------------------------------

describe("Auto-switch radio -> WiFi (sprint 10 ticket 004)", () => {
  function relayDevice(overrides: Partial<DaplinkDevice> = {}): DaplinkDevice {
    return device({
      serialNumber: "SERIAL-RELAY",
      displaySerial: "SHORT-RELAY",
      serialPort: { path: "/dev/cu.usbmodemRELAY" },
      ...overrides,
    });
  }

  function robotBanner(overrides: Partial<ParsedBanner> = {}): ParsedBanner {
    return banner({ role: "NEZHA2", commonName: "robot", name: "gopiv", ...overrides });
  }

  function fakeRoster(names: string[]): KnownRobotsStore {
    return {
      list: () =>
        names.map((name) => ({
          name,
          firstSeenAt: "2026-01-01T00:00:00.000Z",
          lastSeenAt: "2026-01-01T00:00:00.000Z",
          lastSeenVia: "usb" as const,
          lastUsbSerial: `SERIAL-${name}`,
          lastRole: "NEZHA2",
          lastType: "robot" as const,
        })),
      get: () => undefined,
      recordSighting: () => {},
      forget: () => false,
      flush: async () => {},
      isReadOnly: false,
    } as unknown as KnownRobotsStore;
  }

  type ScriptableMdns = MdnsDiscovery & {
    setSnapshot: (next: { relays: unknown[]; robots: unknown[]; wifiRobots?: unknown[] }) => void;
  };

  function scriptableMdnsDiscovery(): ScriptableMdns {
    return fakeMdnsDiscovery({ relays: [], robots: [] }) as ScriptableMdns;
  }

  /** `createLink` fake dispatching on both `"usb"` (the relay's own
   * plain session -- one fixed link instance reused across opens/
   * reopens, mirroring the "robot-via-relay endpoints" describe block's
   * own `usbOnlyCreateLink`) and `"wifi"` (looked up by host:port).
   * Every relay-radio/mbrelay/mbserial candidate itself is built and
   * connected inside the fake coordinator, never through this seam. */
  function autoSwitchCreateLink(relayUsbLink: FakeLink, wifiLinks: Map<string, FakeLink>): (spec: LinkSpec) => Link {
    return (spec) => {
      if (spec.transport === "usb") {
        return relayUsbLink;
      }
      if (spec.transport === "wifi") {
        const link = wifiLinks.get(`${spec.host}:${spec.port}`);
        if (!link) {
          throw new Error(`no fake link registered for wifi ${spec.host}:${spec.port}`);
        }
        return link;
      }
      throw new Error(`unexpected transport in this fixture: ${spec.transport}`);
    };
  }

  /** Collects every notice/error delivered over `onError` -- this
   * ticket's "one informational notice on both endpoints" travels over
   * the same channel as an error report, so a test asserts against it
   * the same way an error test would. */
  function collectNotices(registry: DeviceRegistry): Array<{ endpointId: string | undefined; message: string }> {
    const notices: Array<{ endpointId: string | undefined; message: string }> = [];
    registry.onError((endpointId, message) => {
      notices.push({ endpointId, message });
    });
    return notices;
  }

  /** Build a registry with a relay already attached and a robot named
   * "gopiv" already open through it (a `usb-SERIAL-RELAY-via-gopiv`
   * synthesized child, `sessionOpen: true`) -- the shared precondition
   * every test below starts from. Mirrors the "robot-via-relay
   * endpoints" describe block's own setup, trimmed to what this
   * describe's tests share. */
  async function startWithOpenRelayChild(
    options: {
      knownRobotsStore?: KnownRobotsStore;
      mdnsDiscovery?: MdnsDiscovery;
      autoSwitchToWifi?: boolean;
      relayUsbLink?: FakeLink;
      radioLink?: FakeLink;
      wifiLinks?: Map<string, FakeLink>;
    } = {},
  ): Promise<{
    registry: DeviceRegistry;
    relayUsbLink: FakeLink;
    radioLink: FakeLink;
    wifiLinks: Map<string, FakeLink>;
    notices: Array<{ endpointId: string | undefined; message: string }>;
  }> {
    const devices = [relayDevice()];
    const watcher = fixtureWatcher(() => devices);
    const resolveName = async () => namedResult("rly01");
    const relayUsbLink = options.relayUsbLink ?? new FakeLink(async () => banner());
    const radioLink = options.radioLink ?? new FakeLink(async () => robotBanner());
    const wifiLinks = options.wifiLinks ?? new Map<string, FakeLink>();
    const createLink = autoSwitchCreateLink(relayUsbLink, wifiLinks);
    const coordinator = fakeCoordinator(async (candidates) => ({
      outcome: "connected",
      link: radioLink,
      name: candidates[0]!.name,
      classification: classifyBanner(robotBanner()),
      failoverTrail: [],
    }));

    const registry = new DeviceRegistry({
      statusPollIntervalMs: 0,
      autoRequestFunctions: false,
      watcher,
      resolveName,
      createLink,
      resetOverSwd: async () => ({ ok: true }),
      relayBootDelayMs: 0,
      relayConnectionCoordinator: coordinator,
      knownRobotsStore: options.knownRobotsStore ?? fakeRoster(["gopiv"]),
      mdnsDiscovery: options.mdnsDiscovery ?? scriptableMdnsDiscovery(),
      ...(options.autoSwitchToWifi !== undefined ? { autoSwitchToWifi: options.autoSwitchToWifi } : {}),
    });
    const notices = collectNotices(registry);
    registry.start();
    await waitForSnapshot(registry, (s) => s[0]?.sessionOpen === true);

    await registry.requestOpen("usb-SERIAL-RELAY", { robotName: "gopiv" });
    await waitForSnapshot(registry, (s) =>
      s.find((e) => e.endpointId === "usb-SERIAL-RELAY-via-gopiv")?.sessionOpen === true,
    );

    return { registry, relayUsbLink, radioLink, wifiLinks, notices };
  }

  it("switches an open relay-radio child to WiFi when its name starts advertising over WiFi, and notifies both endpoints", async () => {
    const mdnsDiscovery = scriptableMdnsDiscovery();
    const wifiLink = new FakeLink(async () => robotBanner());
    const wifiLinks = new Map([["gopiv.local.:7654", wifiLink]]);

    const { registry, radioLink, notices } = await startWithOpenRelayChild({ mdnsDiscovery, wifiLinks });

    mdnsDiscovery.setSnapshot({
      relays: [],
      robots: [],
      wifiRobots: [{ name: "gopiv", host: "gopiv.local.", port: 7654 }],
    });
    // Fire the same match a second time immediately (simulating a
    // duplicate/coalesced mdns change notification) -- the per-resource
    // mutex must serialize these so the switch only ever runs once.
    mdnsDiscovery.setSnapshot({
      relays: [],
      robots: [],
      wifiRobots: [{ name: "gopiv", host: "gopiv.local.", port: 7654 }],
    });

    const snap = await waitForSnapshot(
      registry,
      (s) => s.find((e) => e.endpointId === "wifi-gopiv")?.sessionOpen === true,
    );

    expect(snap.some((e) => e.endpointId === "usb-SERIAL-RELAY-via-gopiv")).toBe(false);
    const relayEntry = snap.find((e) => e.endpointId === "usb-SERIAL-RELAY");
    expect(relayEntry).toEqual(expect.objectContaining({ sessionOpen: true, transport: "usb" }));
    const wifiEntry = snap.find((e) => e.endpointId === "wifi-gopiv");
    expect(wifiEntry).toEqual(
      expect.objectContaining({
        transport: "wifi",
        sessionOpen: true,
        name: "gopiv",
        wifi: { host: "gopiv.local.", port: 7654 },
      }),
    );
    expect(wifiLink.connectCalls).toBe(1);
    expect(wifiLink.identifyCalls).toBe(1);
    expect(radioLink.closeCalls).toBe(1);

    const expectedNotice = "Switched gopiv from relay usb-SERIAL-RELAY to WiFi at gopiv.local.:7654";
    expect(notices).toEqual(
      expect.arrayContaining([
        { endpointId: "usb-SERIAL-RELAY", message: expectedNotice },
        { endpointId: "wifi-gopiv", message: expectedNotice },
      ]),
    );

    await registry.stop();
  });

  it("does not auto-switch anything when autoSwitchToWifi is false", async () => {
    const mdnsDiscovery = scriptableMdnsDiscovery();
    const wifiLink = new FakeLink(async () => robotBanner());
    const wifiLinks = new Map([["gopiv.local.:7654", wifiLink]]);

    const { registry } = await startWithOpenRelayChild({ mdnsDiscovery, wifiLinks, autoSwitchToWifi: false });

    mdnsDiscovery.setSnapshot({
      relays: [],
      robots: [],
      wifiRobots: [{ name: "gopiv", host: "gopiv.local.", port: 7654 }],
    });

    // Give the (disabled) auto-switch every chance to fire if it were
    // going to -- poll a handful of times and confirm nothing changed.
    for (let i = 0; i < 10; i++) {
      const snap = registry.snapshot();
      expect(snap.some((e) => e.endpointId === "usb-SERIAL-RELAY-via-gopiv" && e.sessionOpen === true)).toBe(true);
      expect(snap.find((e) => e.endpointId === "wifi-gopiv")?.sessionOpen).toBe(false);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(wifiLink.connectCalls).toBe(0);

    await registry.stop();
  });

  it("never switches a name that is also currently connected directly over USB", async () => {
    // A second, directly USB-attached device happens to share the same
    // resolved name as the robot open via the relay -- an edge case
    // (the same physical robot plugged into USB while also reachable
    // via radio through a relay), but auto-switch must never act on it:
    // a USB session is strictly better than WiFi.
    const usbRobotDevice = device({
      serialNumber: "SERIAL-DIRECT",
      displaySerial: "SHORT-DIRECT",
      serialPort: { path: "/dev/cu.usbmodemDIRECT" },
    });
    const directUsbLink = new FakeLink(async () => robotBanner());
    const relayUsbLink = new FakeLink(async () => banner());
    const wifiLink = new FakeLink(async () => robotBanner());
    const wifiLinks = new Map([["gopiv.local.:7654", wifiLink]]);
    const mdnsDiscovery = scriptableMdnsDiscovery();

    const devices = [relayDevice(), usbRobotDevice];
    const watcher = fixtureWatcher(() => devices);
    const resolveName = async (d: DaplinkDevice) =>
      d.serialNumber === "SERIAL-RELAY" ? namedResult("rly01") : namedResult("gopiv");
    const createLink = (spec: LinkSpec): Link => {
      if (spec.transport === "usb") {
        return spec.portPath === "/dev/cu.usbmodemDIRECT" ? directUsbLink : relayUsbLink;
      }
      if (spec.transport === "wifi") {
        const link = wifiLinks.get(`${spec.host}:${spec.port}`);
        if (!link) {
          throw new Error(`no fake link for wifi ${spec.host}:${spec.port}`);
        }
        return link;
      }
      throw new Error(`unexpected transport: ${spec.transport}`);
    };
    const radioLink = new FakeLink(async () => robotBanner());
    const coordinator = fakeCoordinator(async (candidates) => ({
      outcome: "connected",
      link: radioLink,
      name: candidates[0]!.name,
      classification: classifyBanner(robotBanner()),
      failoverTrail: [],
    }));

    const registry = new DeviceRegistry({
      statusPollIntervalMs: 0,
      autoRequestFunctions: false,
      watcher,
      resolveName,
      createLink,
      resetOverSwd: async () => ({ ok: true }),
      relayBootDelayMs: 0,
      relayConnectionCoordinator: coordinator,
      knownRobotsStore: fakeRoster(["gopiv"]),
      mdnsDiscovery,
    });
    registry.start();

    await waitForSnapshot(
      registry,
      (s) =>
        s.find((e) => e.endpointId === "usb-SERIAL-DIRECT")?.sessionOpen === true &&
        s.find((e) => e.endpointId === "usb-SERIAL-RELAY")?.sessionOpen === true,
    );

    await registry.requestOpen("usb-SERIAL-RELAY", { robotName: "gopiv" });
    await waitForSnapshot(registry, (s) =>
      s.find((e) => e.endpointId === "usb-SERIAL-RELAY-via-gopiv")?.sessionOpen === true,
    );

    mdnsDiscovery.setSnapshot({
      relays: [],
      robots: [],
      wifiRobots: [{ name: "gopiv", host: "gopiv.local.", port: 7654 }],
    });

    for (let i = 0; i < 10; i++) {
      const snap = registry.snapshot();
      expect(snap.some((e) => e.endpointId === "usb-SERIAL-RELAY-via-gopiv" && e.sessionOpen === true)).toBe(true);
      expect(snap.find((e) => e.endpointId === "wifi-gopiv")?.sessionOpen).toBe(false);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(wifiLink.connectCalls).toBe(0);

    await registry.stop();
  });

  it("a discovery match for a name not currently connected over radio triggers no open/close of anything", async () => {
    const wifiLink = new FakeLink(async () => robotBanner());
    const mdnsDiscovery = fakeMdnsDiscovery({
      relays: [],
      robots: [],
      wifiRobots: [{ name: "gopiv", host: "gopiv.local.", port: 7654 }],
    });

    const watcher = fixtureWatcher(() => []);
    const registry = new DeviceRegistry({
      statusPollIntervalMs: 0,
      autoRequestFunctions: false,
      watcher,
      knownRobotsStore: fakeRoster(["gopiv"]),
      mdnsDiscovery,
      createLink: (spec) => {
        if (spec.transport === "wifi") {
          return wifiLink;
        }
        throw new Error(`unexpected transport: ${spec.transport}`);
      },
    });
    registry.start();

    await waitForSnapshot(registry, (s) => s.some((e) => e.endpointId === "wifi-gopiv"));
    // No radio session for "gopiv" ever existed -- the endpoint is
    // listed (ticket 003's own synthesis), but sessionOpen must stay
    // false; nothing auto-connects it.
    for (let i = 0; i < 10; i++) {
      expect(registry.snapshot().find((e) => e.endpointId === "wifi-gopiv")?.sessionOpen).toBe(false);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(wifiLink.connectCalls).toBe(0);

    await registry.stop();
  });

  it("a failed WiFi connect attempt reports an error on the WiFi endpoint and leaves the radio child completely untouched", async () => {
    const mdnsDiscovery = scriptableMdnsDiscovery();
    const wifiLink = new FakeLink(
      async () => robotBanner(),
      () => Promise.reject(new Error("connection refused")),
    );
    const wifiLinks = new Map([["gopiv.local.:7654", wifiLink]]);

    const { registry, notices } = await startWithOpenRelayChild({ mdnsDiscovery, wifiLinks });
    const beforeAttempt = registry
      .snapshot()
      .find((e) => e.endpointId === "usb-SERIAL-RELAY-via-gopiv");

    mdnsDiscovery.setSnapshot({
      relays: [],
      robots: [],
      wifiRobots: [{ name: "gopiv", host: "gopiv.local.", port: 7654 }],
    });

    // The WiFi connect is attempted first and fails -- wait for the
    // attempt itself, then confirm the radio child was never touched.
    for (let i = 0; i < 40 && wifiLink.connectCalls === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(wifiLink.connectCalls).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 20));

    const snap = registry.snapshot();
    const afterAttempt = snap.find((e) => e.endpointId === "usb-SERIAL-RELAY-via-gopiv");
    // The radio-mediated child is still open, unmodified -- same
    // sessionOpen, same resourceKey -- never torn down just because the
    // WiFi candidate failed.
    expect(afterAttempt).toEqual(beforeAttempt);
    expect(afterAttempt?.sessionOpen).toBe(true);
    // The relay's own plain USB session was never reopened either (it
    // was never closed in the first place).
    expect(snap.some((e) => e.endpointId === "usb-SERIAL-RELAY" && e.sessionOpen === true)).toBe(false);
    // wifi-gopiv is present (ticket 003's own synthesis) but not open.
    expect(snap.find((e) => e.endpointId === "wifi-gopiv")?.sessionOpen).toBe(false);

    expect(
      notices.some((n) => n.endpointId === "wifi-gopiv" && /Auto-switch of gopiv to WiFi failed/.test(n.message)),
    ).toBe(true);
    // No notice at all on the radio side.
    expect(notices.some((n) => n.endpointId === "usb-SERIAL-RELAY-via-gopiv")).toBe(false);

    await registry.stop();
  });

  it("an mDNS down for the now-WiFi-connected robot leaves the session open (no switch-back to relay)", async () => {
    const mdnsDiscovery = scriptableMdnsDiscovery();
    const wifiLink = new FakeLink(async () => robotBanner());
    const wifiLinks = new Map([["gopiv.local.:7654", wifiLink]]);

    const { registry } = await startWithOpenRelayChild({ mdnsDiscovery, wifiLinks });

    mdnsDiscovery.setSnapshot({
      relays: [],
      robots: [],
      wifiRobots: [{ name: "gopiv", host: "gopiv.local.", port: 7654 }],
    });
    await waitForSnapshot(registry, (s) => s.find((e) => e.endpointId === "wifi-gopiv")?.sessionOpen === true);

    mdnsDiscovery.setSnapshot({ relays: [], robots: [], wifiRobots: [] });

    for (let i = 0; i < 10; i++) {
      const entry = registry.snapshot().find((e) => e.endpointId === "wifi-gopiv");
      expect(entry?.sessionOpen).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(wifiLink.closeCalls).toBe(0);

    await registry.stop();
  });

  it("runs the switch under the WiFi endpoint's own resourceKey mutex first, then the relay's own key: the WiFi connect fully completes before the radio teardown/reopen is attempted", async () => {
    const order: string[] = [];
    const mdnsDiscovery = scriptableMdnsDiscovery();

    const radioLink = new FakeLink(async () => robotBanner());
    const originalRadioClose = radioLink.close.bind(radioLink);
    radioLink.close = () => {
      order.push("radio-child-close");
      return originalRadioClose();
    };

    const relayUsbLink = new FakeLink(async () => banner());
    const originalRelayConnect = relayUsbLink.connect.bind(relayUsbLink);
    relayUsbLink.connect = () => {
      order.push("relay-reopen-connect");
      return originalRelayConnect();
    };

    const wifiLink = new FakeLink(async () => robotBanner());
    const originalWifiConnect = wifiLink.connect.bind(wifiLink);
    wifiLink.connect = () => {
      order.push("wifi-connect");
      return originalWifiConnect();
    };
    const wifiLinks = new Map([["gopiv.local.:7654", wifiLink]]);

    const { registry } = await startWithOpenRelayChild({ mdnsDiscovery, wifiLinks, relayUsbLink, radioLink });
    order.length = 0; // discard setup-phase entries (the initial attach/open above).

    mdnsDiscovery.setSnapshot({
      relays: [],
      robots: [],
      wifiRobots: [{ name: "gopiv", host: "gopiv.local.", port: 7654 }],
    });
    await waitForSnapshot(registry, (s) => s.find((e) => e.endpointId === "wifi-gopiv")?.sessionOpen === true);

    expect(order).toEqual(["wifi-connect", "radio-child-close", "relay-reopen-connect"]);

    await registry.stop();
  });
});

// ---------------------------------------------------------------------
// defaultLinkFactory -- sprint 10 ticket 002's "wifi" case. Every prior
// transport's dispatch is exercised only indirectly (through
// DeviceRegistry's injected `createLink` fake); this ticket's own
// acceptance criteria specifically ask for a direct assertion against
// the real factory function for "wifi", per link/Link.ts's WifiLinkSpec
// doc comment ("TCP over UDP, reusing MbserialLink unchanged"). This
// does not re-test MbserialLink's own connect/identify behavior
// (MbserialLink.test.ts already covers that) -- only that "wifi"
// dispatches to it with the spec's exact host/port.
// ---------------------------------------------------------------------

describe("defaultLinkFactory", () => {
  it('constructs an MbserialLink for transport "wifi", with that spec\'s exact host/port', () => {
    const spec: LinkSpec = { transport: "wifi", host: "gopiv.local.", port: 7654 };
    const link = defaultLinkFactory(spec);
    expect(link).toBeInstanceOf(MbserialLink);
    expect((link as unknown as { host: string; port: number }).host).toBe("gopiv.local.");
    expect((link as unknown as { host: string; port: number }).port).toBe(7654);
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

// ---------------------------------------------------------------------
// OOP 2026-09-09: console echo of HELLO/banner and button-sent
// commands, harvested `status`/`estop`/`funcs` replies, and the host's
// own robot probes (automatic FUNCS + periodic STATUS poll).
// ---------------------------------------------------------------------

type SeenLine = { endpointId: string; direction: string; line: string; origin?: string };

function robotBanner(): ParsedBanner {
  return banner({ role: "NEZHA2", commonName: "robot", name: "gopiv", dialect: "space", raw: "device NEZHA2 robot gopiv 123" });
}

function decoded(verb: string, fields: string[] = [], id?: number): DecodedLine {
  return id === undefined ? { kind: "line", verb, fields } : { kind: "line", verb, fields, id };
}

async function openRobot(options: { statusPollIntervalMs?: number; autoRequestFunctions?: boolean } = {}) {
  const devices = [device()];
  const watcher = fixtureWatcher(() => devices);
  const link = new FakeLink(async () => robotBanner());
  const registry = new DeviceRegistry({
    statusPollIntervalMs: 0,
    autoRequestFunctions: false,
    ...options,
    watcher,
    resolveName: async () => namedResult("gopiv"),
    createLink: () => link,
  });
  const lines: SeenLine[] = [];
  registry.onLine((endpointId, direction, line, origin) =>
    lines.push(origin ? { endpointId, direction, line, origin } : { endpointId, direction, line }),
  );
  registry.start();
  await waitForSnapshot(registry, (s) => s[0]?.sessionOpen === true && s[0]?.role === "NEZHA2");
  return { registry, link, lines };
}

describe("parseStatusReply", () => {
  it("keeps every k=v pair and derives the named booleans from the flags bitfield", () => {
    const status = parseStatusReply(
      ["ready=1", "active=0", "connL=1", "connR=1", "otos=0", "wedge=0", "flags=3", "i2cf=0", "cyc=42", "tlm=off", "next=5", "done=4", "reason=stop"],
      1000,
    );
    expect(status).toEqual({
      receivedAt: 1000,
      fields: {
        ready: "1", active: "0", connL: "1", connR: "1", otos: "0", wedge: "0", flags: "3", i2cf: "0",
        cyc: "42", tlm: "off", next: "5", done: "4", reason: "stop",
      },
      ready: true,
      active: false,
      estopped: true, // bit 1
      stallHalted: false,
      leaseExpired: false,
    });
  });

  it("reads stall-halted / lease-expired bits and falls back to ready= when flags is absent", () => {
    expect(parseStatusReply(["flags=c"], 0)).toMatchObject({ stallHalted: true, leaseExpired: true, estopped: false, ready: false });
    expect(parseStatusReply(["ready=1", "active=1"], 0)).toMatchObject({ ready: true, active: true, estopped: false });
    expect(parseStatusReply(["junk"], 0).fields).toEqual({ junk: "" });
  });
});

describe("DeviceRegistry console echo (OOP 2026-09-09)", () => {
  it("echoes the connect-time HELLO and its banner reply as console lines", async () => {
    const { registry, lines } = await openRobot();
    expect(lines).toContainEqual({ endpointId: "usb-SERIAL-A", direction: "tx", line: "HELLO" });
    expect(lines).toContainEqual({ endpointId: "usb-SERIAL-A", direction: "rx", line: "device NEZHA2 robot gopiv 123" });
    await registry.stop();
  });

  it("echoes a button-sent command's exact encoded line as a tx console line", async () => {
    const { registry, lines } = await openRobot();
    await registry.sendCommand("usb-SERIAL-A", "GET", ["speed"]);
    await registry.sendCommand("usb-SERIAL-A", "STATUS", []);
    expect(lines).toContainEqual({ endpointId: "usb-SERIAL-A", direction: "tx", line: "GET speed #1" });
    expect(lines).toContainEqual({ endpointId: "usb-SERIAL-A", direction: "tx", line: "STATUS" });
    await registry.stop();
  });

  it("HELLO pressed on a live session echoes HELLO and the fresh banner, so the button visibly does something", async () => {
    const { registry, link, lines } = await openRobot();
    lines.length = 0;
    await registry.sendCommand("usb-SERIAL-A", "HELLO", []);
    expect(link.identifyCalls).toBe(2);
    expect(lines).toEqual([
      { endpointId: "usb-SERIAL-A", direction: "tx", line: "HELLO" },
      { endpointId: "usb-SERIAL-A", direction: "rx", line: "device NEZHA2 robot gopiv 123" },
    ]);
    await registry.stop();
  });
});

describe("DeviceRegistry robot status and functions (OOP 2026-09-09)", () => {
  it("harvests a status reply into robotStatus and flips estopped on a bare estop reply", async () => {
    const { registry, link } = await openRobot();
    expect(registry.snapshot()[0]?.robotStatus).toBeUndefined();

    link.emitLine(decoded("status", ["ready=1", "active=0", "flags=1", "tlm=off"]));
    let entry = registry.snapshot()[0]!;
    expect(entry.robotStatus).toMatchObject({ ready: true, estopped: false, fields: { tlm: "off" } });

    link.emitLine(decoded("estop"));
    entry = registry.snapshot()[0]!;
    expect(entry.robotStatus).toMatchObject({ estopped: true, active: false, fields: { tlm: "off" } });

    link.emitLine(decoded("status", ["ready=1", "active=0", "flags=1"]));
    expect(registry.snapshot()[0]?.robotStatus?.estopped).toBe(false);

    await registry.stop();
    // Cleared with the session.
    expect(registry.snapshot()[0]?.robotStatus).toBeUndefined();
  });

  it("FUNCS resets the function list, then funcs reply lines rebuild it (signature optional)", async () => {
    const { registry, link, lines } = await openRobot();
    expect(registry.snapshot()[0]?.functions).toBeUndefined();

    await registry.sendCommand("usb-SERIAL-A", "FUNCS", []);
    expect(link.sentLines).toEqual(["FUNCS #1\n"]);
    expect(lines).toContainEqual({ endpointId: "usb-SERIAL-A", direction: "tx", line: "FUNCS #1" });
    expect(registry.snapshot()[0]?.functions).toEqual([]);

    link.emitLine(decoded("funcs", ["clearestop"]));
    link.emitLine(decoded("funcs", ["straight", "dist", "speed"]));
    expect(registry.snapshot()[0]?.functions).toEqual([
      { name: "clearestop" },
      { name: "straight", signature: "dist speed" },
    ]);
    // Every funcs line is still echoed to the console.
    expect(lines).toContainEqual({ endpointId: "usb-SERIAL-A", direction: "rx", line: "funcs straight dist speed" });

    await registry.sendCommand("usb-SERIAL-A", "funcs", []); // case-folded like every other verb
    expect(registry.snapshot()[0]?.functions).toEqual([]);
    await registry.stop();
  });

  it("automatically requests FUNCS and polls STATUS once a robot identifies, tagging poll traffic", async () => {
    const { registry, link, lines } = await openRobot({ statusPollIntervalMs: 60_000, autoRequestFunctions: true });
    expect(link.sentLines).toEqual(["FUNCS #1\n", "STATUS\n"]);
    expect(registry.snapshot()[0]?.functions).toEqual([]);
    expect(lines).toContainEqual({ endpointId: "usb-SERIAL-A", direction: "tx", line: "STATUS", origin: "poll" });
    // The reply to the host's own poll is tagged too; a later one is not.
    link.emitLine(decoded("status", ["flags=1"]));
    expect(lines).toContainEqual({ endpointId: "usb-SERIAL-A", direction: "rx", line: "status flags=1", origin: "poll" });
    link.emitLine(decoded("status", ["flags=1"]));
    expect(lines.filter((l) => l.line === "status flags=1")).toEqual([
      { endpointId: "usb-SERIAL-A", direction: "rx", line: "status flags=1", origin: "poll" },
      { endpointId: "usb-SERIAL-A", direction: "rx", line: "status flags=1" },
    ]);
    await registry.stop();
  });

  it("adopts status next= when nothing is pending, so the next command carries the id the robot expects", async () => {
    const { registry, link } = await openRobot();
    await registry.sendCommand("usb-SERIAL-A", "GET", []);
    link.receiveReply(decoded("ack", ["1", "0", "none"]));
    expect(link.session.nextSequenceId).toBe(2);

    link.emitLine(decoded("status", ["flags=1", "next=9"]));
    expect(link.session.nextSequenceId).toBe(9);
    await registry.sendCommand("usb-SERIAL-A", "GET", []);
    expect(link.sentLines.at(-1)).toBe("GET #9\n");

    // In flight -> left alone.
    link.emitLine(decoded("status", ["flags=1", "next=3"]));
    expect(link.session.nextSequenceId).toBe(10);
    await registry.stop();
  });

  it("reports a desynced nack as an automatic resync notice, never as a request to press HELLO", async () => {
    const { registry, link } = await openRobot();
    const errors: string[] = [];
    registry.onError((_endpointId, message) => errors.push(message));
    await registry.sendCommand("usb-SERIAL-A", "GET", []);
    link.receiveReply(decoded("ack", ["1", "0", "none"]));
    await registry.sendCommand("usb-SERIAL-A", "GET", []); // #2
    link.receiveReply(decoded("nack", ["1", "0", "none"])); // robot reset
    expect(errors).toEqual(["The robot restarted its command counter -- resynced automatically, continuing at #1."]);
    expect(errors.join(" ")).not.toMatch(/press HELLO/);
    await registry.sendCommand("usb-SERIAL-A", "GET", []);
    expect(link.sentLines.at(-1)).toBe("GET #1\n");
    await registry.stop();
  });

  it("shows non-protocol inbound text (a relay's # command-plane reply) verbatim in the console", async () => {
    const { registry, link, lines } = await openRobot();
    link.emitRawLine("# Relay v0.20260907.1 -- commands: !CG !GO !P");
    link.emitRawLine("!HELP");
    expect(lines).toContainEqual({ endpointId: "usb-SERIAL-A", direction: "rx", line: "# Relay v0.20260907.1 -- commands: !CG !GO !P" });
    expect(lines).toContainEqual({ endpointId: "usb-SERIAL-A", direction: "rx", line: "!HELP" });
    await registry.stop();
  });

  it("never probes a non-robot (relay) endpoint", async () => {
    const devices = [device()];
    const watcher = fixtureWatcher(() => devices);
    const link = new FakeLink(async () => banner());
    const registry = new DeviceRegistry({
      statusPollIntervalMs: 60_000,
      autoRequestFunctions: true,
      watcher,
      resolveName: async () => namedResult("getez"),
      createLink: () => link,
    });
    registry.start();
    await waitForSnapshot(registry, (s) => s[0]?.sessionOpen === true && s[0]?.role === "RADIOBRIDGE");
    expect(link.sentLines).toEqual([]);
    await registry.stop();
  });
});

describe("DeviceRegistry telemetry (thdr/t) and TLM HDR recovery (sprint 009 ticket 002)", () => {
  it("does not append thdr/t to the console rx log or trigger an endpoints snapshot", async () => {
    const { registry, link, lines } = await openRobot();
    const snapshots: unknown[] = [];
    registry.onDevicesChanged((snap) => snapshots.push(snap));
    lines.length = 0;

    link.emitLine(decoded("thdr", ["seq", "now", "flags", "posl", "posr", "vell", "velr"]));
    link.emitLine(decoded("t", ["1", "2", "3", "4", "5", "6", "7"]));

    expect(lines).toEqual([]);
    expect(snapshots).toEqual([]);
    await registry.stop();
  });

  it("forwards a thdr header update, then zips a t frame against it and forwards the decoded frame", async () => {
    const { registry, link } = await openRobot();
    const events: Array<{ endpointId: string; event: unknown }> = [];
    registry.onTelemetry((endpointId, event) => events.push({ endpointId, event }));

    link.emitLine(decoded("thdr", ["seq", "now", "flags", "posl", "posr", "vell", "velr"]));
    expect(events).toEqual([
      {
        endpointId: "usb-SERIAL-A",
        event: { header: ["seq", "now", "flags", "posl", "posr", "vell", "velr"] },
      },
    ]);

    link.emitLine(decoded("t", ["1", "2", "3", "4", "5", "6", "7"]));
    expect(events).toEqual([
      expect.anything(),
      {
        endpointId: "usb-SERIAL-A",
        event: { frame: { seq: "1", now: "2", flags: "3", posl: "4", posr: "5", vell: "6", velr: "7" } },
      },
    ]);
    await registry.stop();
  });

  it("a t frame with no header held sends TLM HDR exactly once -- never TLM NOW -- and does not resend while still waiting", async () => {
    const { registry, link } = await openRobot();
    link.sentLines.length = 0;

    link.emitLine(decoded("t", ["1", "2", "3"]));
    expect(link.sentLines).toEqual([expect.stringMatching(/^TLM HDR #\d+\n$/)]);

    // A second (and third) header-less t frame while still waiting must
    // not resend -- the one-shot guard, not a resend-per-frame.
    link.emitLine(decoded("t", ["4", "5", "6"]));
    link.emitLine(decoded("t", ["7", "8", "9"]));
    expect(link.sentLines).toEqual([expect.stringMatching(/^TLM HDR #\d+\n$/)]);
    expect(link.sentLines.some((l) => /^TLM NOW/.test(l))).toBe(false);
    await registry.stop();
  });

  it("a field-count mismatch against an already-held header also triggers a guarded TLM HDR recovery request", async () => {
    const { registry, link } = await openRobot();
    link.emitLine(decoded("thdr", ["seq", "now", "flags", "posl", "posr", "vell", "velr"])); // 7 columns
    link.sentLines.length = 0;

    link.emitLine(decoded("t", ["1", "2", "3"])); // only 3 fields -- mismatch
    expect(link.sentLines).toEqual([expect.stringMatching(/^TLM HDR #\d+\n$/)]);

    // Still mismatched/waiting -- no second request.
    link.emitLine(decoded("t", ["4", "5", "6"]));
    expect(link.sentLines).toEqual([expect.stringMatching(/^TLM HDR #\d+\n$/)]);
    await registry.stop();
  });

  it("clears the one-shot guard once a frame decodes successfully, so a later independent gap can trigger TLM HDR again", async () => {
    const { registry, link } = await openRobot();

    link.emitLine(decoded("t", ["1", "2", "3"])); // no header -- first gap
    expect(link.sentLines.filter((l) => l.startsWith("TLM"))).toHaveLength(1);

    link.emitLine(decoded("thdr", ["seq", "now", "flags", "posl", "posr", "vell", "velr"]));
    link.emitLine(decoded("t", ["1", "2", "3", "4", "5", "6", "7"])); // decodes fine -- clears the guard

    link.emitLine(decoded("t", ["1", "2", "3"])); // a second, independent gap (mismatch again)
    expect(link.sentLines.filter((l) => l.startsWith("TLM"))).toHaveLength(2);
    await registry.stop();
  });

  it("resets the held header and recovery guard on session teardown, so a reopened session starts from a fresh gap", async () => {
    const { registry, link } = await openRobot();
    link.emitLine(decoded("thdr", ["seq", "now", "flags", "posl", "posr", "vell", "velr"]));
    link.emitLine(decoded("t", ["1", "2", "3", "4", "5", "6", "7"])); // decodes fine, no recovery needed

    await registry.requestClose("usb-SERIAL-A");
    await registry.requestOpen("usb-SERIAL-A");
    await waitForSnapshot(registry, (s) => s[0]?.sessionOpen === true);
    link.sentLines.length = 0;

    // Same column count as before teardown, but the decoder held no
    // header across the reopened session -- this must be treated as a
    // fresh gap, not zipped against the pre-teardown header.
    link.emitLine(decoded("t", ["1", "2", "3", "4", "5", "6", "7"]));
    expect(link.sentLines).toEqual([expect.stringMatching(/^TLM HDR #\d+\n$/)]);
    await registry.stop();
  });

  it("resets the held header and recovery guard on a HELLO resync", async () => {
    const { registry, link } = await openRobot();
    link.emitLine(decoded("thdr", ["seq", "now", "flags", "posl", "posr", "vell", "velr"]));
    link.emitLine(decoded("t", ["1", "2", "3", "4", "5", "6", "7"])); // decodes fine

    await registry.sendCommand("usb-SERIAL-A", "HELLO", []);
    link.sentLines.length = 0;

    link.emitLine(decoded("t", ["1", "2", "3", "4", "5", "6", "7"])); // held header must be gone
    expect(link.sentLines).toEqual([expect.stringMatching(/^TLM HDR #\d+\n$/)]);
    await registry.stop();
  });
});
