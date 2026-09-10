import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { Session, type DecodedLine, type ParsedBanner, type WireField } from "@robot-console/protocol";
import {
  DEFAULT_PROBE_ATTEMPTS,
  RelayConnectionCoordinator,
  type ConnectionCandidate,
  type MbserialCandidate,
  type RelayRadioCandidate,
  type ResolveRobotAddressFn,
} from "./RelayConnectionCoordinator.js";
import type { Link, LinkSpec } from "../link/Link.js";
import type { Scheduler } from "../link/pacing.js";
import type { ResolvedAddress } from "../mbrelayRegistry.js";

// Every test in this file drives resolution, connection, liveness
// probing, and failover against fully synthetic fakes -- no real
// DeviceRegistry, no real transport, no real registry HTTP call, and no
// real wall-clock delay anywhere here, per the ticket's own Testing
// section.

/** A fully synthetic {@link Link}, mirroring `deviceRegistry.test.ts`'s
 * own `FakeLink` precedent but adding `checkLivenessCalls` tracking and
 * an `emitPong()` helper, since this module's own liveness probe (not
 * `identify()`) is what this file must exercise. */
class FakeLink implements Link {
  readonly session = new Session();
  connectCalls = 0;
  identifyCalls = 0;
  checkLivenessCalls = 0;
  closeCalls = 0;
  private lineListeners = new Set<(line: DecodedLine) => void>();

  constructor(
    private readonly connectImpl: () => Promise<void> = () => Promise.resolve(),
    private readonly identifyImpl: () => Promise<ParsedBanner | null> = () => Promise.resolve(null),
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

  sendLine(): void {
    // Not exercised by this module.
  }

  sendCommand(verb: string, fields: readonly WireField[] = []): string {
    return this.session.send(verb, fields);
  }

  sendUnsequenced(verb: string, fields: readonly WireField[] = []): string {
    return this.session.sendUnsequenced(verb, fields);
  }

  checkLiveness(): void {
    this.checkLivenessCalls++;
  }

  onLine(listener: (line: DecodedLine) => void): () => void {
    this.lineListeners.add(listener);
    return () => {
      this.lineListeners.delete(listener);
    };
  }

  onRawLine(): () => void {
    return () => {};
  }

  onAckNack(): () => void {
    return () => {};
  }

  onError(): () => void {
    return () => {};
  }

  /** Deliver a `pong` reply line to every current `onLine` subscriber --
   * what a real `Link` would emit in answer to `checkLiveness()`'s
   * `PING`. */
  emitPong(): void {
    for (const listener of this.lineListeners) {
      listener({ kind: "line", verb: "pong", fields: [] });
    }
  }
}

/** A `Scheduler` whose `delay()` never resolves on its own -- a test
 * drives every timeout deterministically via `fireAll()`, so no probe
 * timeout in this file ever waits on a real timer. Mirrors
 * `RelayCommandPlane.test.ts`/`mbrelayRegistry.test.ts`'s own
 * `controllableScheduler`. */
function controllableScheduler(): Scheduler & { fireAll: () => void } {
  const resolvers: Array<() => void> = [];
  return {
    delay: (_ms: number) =>
      new Promise<void>((resolve) => {
        resolvers.push(resolve);
      }),
    fireAll: () => {
      const pending = resolvers.splice(0, resolvers.length);
      for (const resolve of pending) {
        resolve();
      }
    },
  };
}

/** Flush pending microtasks so awaited steps have settled before
 * assertions run -- same technique `RelayCommandPlane.test.ts` uses. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function relayRadioCandidate(overrides: Partial<RelayRadioCandidate> = {}): RelayRadioCandidate {
  return {
    transport: "relay-radio",
    name: "zuzuv",
    portPath: "/dev/cu.usbmodemRELAY",
    resourceKey: "usb-RELAY123",
    ...overrides,
  };
}

function mbserialCandidate(overrides: Partial<MbserialCandidate> = {}): MbserialCandidate {
  return {
    transport: "mbserial",
    name: "gopiv",
    host: "gopiv.local",
    port: 9000,
    resourceKey: "mbserial-gopiv.local:9000",
    ...overrides,
  };
}

function neverResolvingResolve(): ResolveRobotAddressFn {
  return () => new Promise<ResolvedAddress>(() => {});
}

describe("RelayConnectionCoordinator.connect", () => {
  it("a single candidate that resolves and connects on the first attempt returns an empty failoverTrail", async () => {
    const link = new FakeLink();
    const linkFactory = vi.fn((): Link => link);
    const resolveRobotAddress = vi.fn<ResolveRobotAddressFn>(async () => ({
      channel: 41,
      group: 6,
      outcome: "registry",
    }));
    const scheduler = controllableScheduler();
    const coordinator = new RelayConnectionCoordinator({ linkFactory, resolveRobotAddress, scheduler });

    const pending = coordinator.connect([relayRadioCandidate()]);
    await flush();
    link.emitPong();
    const result = await pending;

    expect(result).toEqual({
      outcome: "connected",
      link,
      classification: { type: "unknown", role: null, commonName: null, dialect: null, evidence: "none", program: null, version: null },
      name: "zuzuv",
      addressSource: "registry",
      failoverTrail: [],
    });
    expect(resolveRobotAddress).toHaveBeenCalledTimes(1);
    expect(linkFactory).toHaveBeenCalledTimes(1);
  });

  it("the first two candidates never answer within their retry budget; the third does, with a two-entry failoverTrail", async () => {
    const deadLinkA = new FakeLink();
    const deadLinkB = new FakeLink();
    const liveLink = new FakeLink();
    const links = [deadLinkA, deadLinkB, liveLink];
    let callIndex = 0;
    const linkFactory = vi.fn((): Link => links[callIndex++]!);
    const resolveRobotAddress = vi.fn<ResolveRobotAddressFn>(async (name) => ({
      channel: 1,
      group: 1,
      outcome: name === "candidateC" ? "config" : "derived",
    }));
    const scheduler = controllableScheduler();
    const coordinator = new RelayConnectionCoordinator({
      linkFactory,
      resolveRobotAddress,
      scheduler,
      probeAttempts: 2,
    });

    const candidates: ConnectionCandidate[] = [
      relayRadioCandidate({ name: "candidateA" }),
      relayRadioCandidate({ name: "candidateB" }),
      relayRadioCandidate({ name: "candidateC" }),
    ];

    const pending = coordinator.connect(candidates);

    // candidateA: 2 probe attempts, neither answered -> exhausted.
    await flush();
    scheduler.fireAll();
    await flush();
    scheduler.fireAll();
    await flush();

    // candidateB: same.
    scheduler.fireAll();
    await flush();
    scheduler.fireAll();
    await flush();

    // candidateC: answers on its first probe.
    liveLink.emitPong();
    const result = await pending;

    expect(result.outcome).toBe("connected");
    expect(result.failoverTrail).toHaveLength(2);
    expect(result.failoverTrail.map((entry) => entry.name)).toEqual(["candidateA", "candidateB"]);
    if (result.outcome === "connected") {
      expect(result.name).toBe("candidateC");
      expect(result.addressSource).toBe("config");
    }
    expect(deadLinkA.closeCalls).toBe(1);
    expect(deadLinkB.closeCalls).toBe(1);
    expect(liveLink.closeCalls).toBe(0);
    expect(deadLinkA.checkLivenessCalls).toBe(2);
    expect(deadLinkB.checkLivenessCalls).toBe(2);
  });

  it("checkLiveness() -- never identify()/HELLO -- is the only liveness call this module makes", async () => {
    const link = new FakeLink();
    const linkFactory = () => link;
    const resolveRobotAddress = vi.fn<ResolveRobotAddressFn>(async () => ({
      channel: 1,
      group: 1,
      outcome: "derived",
    }));
    const scheduler = controllableScheduler();
    const coordinator = new RelayConnectionCoordinator({ linkFactory, resolveRobotAddress, scheduler });

    const pending = coordinator.connect([relayRadioCandidate()]);
    await flush();
    expect(link.checkLivenessCalls).toBe(1);
    expect(link.identifyCalls).toBe(0);
    link.emitPong();
    await pending;

    // identify() is called exactly once, only after the probe succeeds.
    expect(link.identifyCalls).toBe(1);
    expect(link.checkLivenessCalls).toBe(1);
  });

  it("a candidate list that exhausts entirely resolves with a failure result carrying the full trail -- never throws, never hangs", async () => {
    const linkA = new FakeLink();
    const linkB = new FakeLink();
    let callIndex = 0;
    const links = [linkA, linkB];
    const linkFactory = () => links[callIndex++]!;
    const resolveRobotAddress = vi.fn<ResolveRobotAddressFn>(async () => ({
      channel: 1,
      group: 1,
      outcome: "local-derived",
    }));
    const scheduler = controllableScheduler();
    const coordinator = new RelayConnectionCoordinator({
      linkFactory,
      resolveRobotAddress,
      scheduler,
      probeAttempts: 1,
    });

    const pending = coordinator.connect([
      relayRadioCandidate({ name: "candidateA" }),
      relayRadioCandidate({ name: "candidateB" }),
    ]);

    await flush();
    scheduler.fireAll(); // candidateA's one probe attempt times out
    await flush();
    scheduler.fireAll(); // candidateB's one probe attempt times out
    await flush();

    const result = await pending;

    expect(result.outcome).toBe("exhausted");
    expect(result.failoverTrail).toHaveLength(2);
    expect(result.failoverTrail.map((entry) => entry.name)).toEqual(["candidateA", "candidateB"]);
    expect(linkA.closeCalls).toBe(1);
    expect(linkB.closeCalls).toBe(1);
  });

  it("resolveRobotAddress is called exactly once per relay-radio/mbrelay candidate attempt, and its outcome reaches addressSource", async () => {
    const link = new FakeLink();
    const linkFactory = () => link;
    const resolveRobotAddress = vi.fn<ResolveRobotAddressFn>(async () => ({
      channel: 41,
      group: 6,
      outcome: "derived",
    }));
    const scheduler = controllableScheduler();
    const coordinator = new RelayConnectionCoordinator({ linkFactory, resolveRobotAddress, scheduler });

    const pending = coordinator.connect([relayRadioCandidate()]);
    await flush();
    link.emitPong();
    const result = await pending;

    expect(resolveRobotAddress).toHaveBeenCalledTimes(1);
    expect(resolveRobotAddress).toHaveBeenCalledWith("zuzuv", undefined);
    expect(result.outcome).toBe("connected");
    if (result.outcome === "connected") {
      expect(result.addressSource).toBe("derived");
    }
  });

  it("an explicit address override bypasses resolution entirely and is reported as addressSource: explicit", async () => {
    const link = new FakeLink();
    const linkFactory = vi.fn((spec: LinkSpec): Link => {
      expect(spec).toMatchObject({ transport: "relay-radio", channel: 55, group: 114 });
      return link;
    });
    const resolveRobotAddress = vi.fn<ResolveRobotAddressFn>(neverResolvingResolve());
    const scheduler = controllableScheduler();
    const coordinator = new RelayConnectionCoordinator({ linkFactory, resolveRobotAddress, scheduler });

    const pending = coordinator.connect([relayRadioCandidate({ address: { channel: 55, group: 114 } })]);
    await flush();
    link.emitPong();
    const result = await pending;

    expect(resolveRobotAddress).not.toHaveBeenCalled();
    expect(result.outcome).toBe("connected");
    if (result.outcome === "connected") {
      expect(result.addressSource).toBe("explicit");
    }
  });

  it("an mbserial candidate never calls resolveRobotAddress, and addressSource is absent from the result", async () => {
    const link = new FakeLink();
    const linkFactory = vi.fn((spec: LinkSpec): Link => {
      expect(spec).toEqual({
        transport: "mbserial",
        resourceKey: "mbserial-gopiv.local:9000",
        host: "gopiv.local",
        port: 9000,
      });
      return link;
    });
    const resolveRobotAddress = vi.fn<ResolveRobotAddressFn>(neverResolvingResolve());
    const scheduler = controllableScheduler();
    const coordinator = new RelayConnectionCoordinator({ linkFactory, resolveRobotAddress, scheduler });

    const pending = coordinator.connect([mbserialCandidate()]);
    await flush();
    link.emitPong();
    const result = await pending;

    expect(resolveRobotAddress).not.toHaveBeenCalled();
    expect(result.outcome).toBe("connected");
    if (result.outcome === "connected") {
      expect(result).not.toHaveProperty("addressSource");
    }
  });

  it("a transport opened for a candidate that ultimately fails is closed before the next candidate is tried", async () => {
    const failedLink = new FakeLink();
    const successLink = new FakeLink();
    let callIndex = 0;
    const links = [failedLink, successLink];
    const linkFactory = () => links[callIndex++]!;
    const resolveRobotAddress = vi.fn<ResolveRobotAddressFn>(async () => ({
      channel: 1,
      group: 1,
      outcome: "derived",
    }));
    const scheduler = controllableScheduler();
    const coordinator = new RelayConnectionCoordinator({
      linkFactory,
      resolveRobotAddress,
      scheduler,
      probeAttempts: 1,
    });

    const pending = coordinator.connect([
      relayRadioCandidate({ name: "candidateA" }),
      relayRadioCandidate({ name: "candidateB" }),
    ]);

    await flush();
    expect(failedLink.closeCalls).toBe(0); // not yet closed -- still probing
    scheduler.fireAll();
    await flush();
    expect(failedLink.closeCalls).toBe(1); // closed before candidateB is tried

    successLink.emitPong();
    const result = await pending;
    expect(result.outcome).toBe("connected");
    expect(successLink.closeCalls).toBe(0);
  });

  it("a connect() transport failure is treated as a failed attempt, closes the link, and advances to the next candidate", async () => {
    const failingLink = new FakeLink(() => Promise.reject(new Error("port busy")));
    const successLink = new FakeLink();
    let callIndex = 0;
    const links = [failingLink, successLink];
    const linkFactory = () => links[callIndex++]!;
    const resolveRobotAddress = vi.fn<ResolveRobotAddressFn>(async () => ({
      channel: 1,
      group: 1,
      outcome: "derived",
    }));
    const scheduler = controllableScheduler();
    const coordinator = new RelayConnectionCoordinator({ linkFactory, resolveRobotAddress, scheduler });

    const pending = coordinator.connect([
      relayRadioCandidate({ name: "candidateA" }),
      relayRadioCandidate({ name: "candidateB" }),
    ]);
    await flush();
    successLink.emitPong();
    const result = await pending;

    expect(result.outcome).toBe("connected");
    expect(result.failoverTrail).toHaveLength(1);
    expect(result.failoverTrail[0]?.reason).toMatch(/connect failed/);
    expect(failingLink.closeCalls).toBe(1);
    expect(failingLink.checkLivenessCalls).toBe(0);
  });

  it(`defaults to ${DEFAULT_PROBE_ATTEMPTS} probe attempts when probeAttempts is not supplied`, async () => {
    const link = new FakeLink();
    const linkFactory = () => link;
    const resolveRobotAddress = vi.fn<ResolveRobotAddressFn>(async () => ({
      channel: 1,
      group: 1,
      outcome: "derived",
    }));
    const scheduler = controllableScheduler();
    const coordinator = new RelayConnectionCoordinator({ linkFactory, resolveRobotAddress, scheduler });

    const pending = coordinator.connect([relayRadioCandidate()]);
    for (let i = 0; i < DEFAULT_PROBE_ATTEMPTS; i++) {
      await flush();
      scheduler.fireAll();
    }
    await flush();
    const result = await pending;

    expect(result.outcome).toBe("exhausted");
    expect(link.checkLivenessCalls).toBe(DEFAULT_PROBE_ATTEMPTS);
  });
});

describe("RelayConnectionCoordinator module boundary", () => {
  it("has no import of anything from deviceRegistry.ts", () => {
    // Scoped to actual `import` statement lines (`^import...`), not the
    // module doc comment's own prose -- which legitimately explains this
    // class's relationship to `DeviceRegistry` (ticket 004's caller) by
    // name several times. Mirrors `RobotPage.transportBlind.test.ts`'s
    // own precision (a quoted literal / specific reference, never a
    // bare-substring match that would also trip over descriptive text).
    const sourcePath = fileURLToPath(new URL("./RelayConnectionCoordinator.ts", import.meta.url));
    const source = readFileSync(sourcePath, "utf8");
    expect(source).not.toMatch(/^import[^\n]*deviceRegistry/im);
  });
});
