import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  MdnsDiscovery,
  type MdnsBackend,
  type MdnsBrowser,
  type MdnsFindOptions,
  type MdnsService,
} from "./mdnsDiscovery.js";

/**
 * Fully synthetic fake browse session -- a bare `EventEmitter` plus a
 * `stop()` spy, structurally satisfying {@link MdnsBrowser}. Tests drive
 * scripted `up`/`down` events directly via `emitUp`/`emitDown` rather
 * than through any real mDNS mechanism, so no test in this file ever
 * opens a real multicast socket.
 */
function fakeBrowser() {
  const emitter = new EventEmitter();
  const browser: MdnsBrowser & {
    emitUp: (service: MdnsService) => void;
    emitDown: (service: MdnsService) => void;
    stop: ReturnType<typeof vi.fn>;
  } = {
    on(event, listener) {
      emitter.on(event, listener);
    },
    stop: vi.fn(),
    emitUp(service: MdnsService) {
      emitter.emit("up", service);
    },
    emitDown(service: MdnsService) {
      emitter.emit("down", service);
    },
  };
  return browser;
}

/**
 * Fully synthetic fake {@link MdnsBackend}: routes `find({ type: "mbrelay" })`
 * to one fake browser, `find({ type: "mbserial" })` to another, and
 * `find({ type: "robotlink", protocol: "tcp" | "udp" })` to two more
 * (kept separate so a test can independently drive `_robotlink._tcp`
 * and `_robotlink._udp` events, including both simultaneously for the
 * same robot). Records every `find()` call so tests can assert which
 * service types/protocols were browsed.
 */
function fakeBackend() {
  const relay = fakeBrowser();
  const robot = fakeBrowser();
  const robotlinkTcp = fakeBrowser();
  const robotlinkUdp = fakeBrowser();
  const findCalls: MdnsFindOptions[] = [];
  const backend: MdnsBackend & {
    relay: typeof relay;
    robot: typeof robot;
    robotlinkTcp: typeof robotlinkTcp;
    robotlinkUdp: typeof robotlinkUdp;
    findCalls: MdnsFindOptions[];
  } = {
    relay,
    robot,
    robotlinkTcp,
    robotlinkUdp,
    findCalls,
    find(options: MdnsFindOptions): MdnsBrowser {
      findCalls.push(options);
      if (options.type === "mbrelay") {
        return relay;
      }
      if (options.type === "mbserial") {
        return robot;
      }
      return options.protocol === "udp" ? robotlinkUdp : robotlinkTcp;
    },
    destroy: vi.fn(),
  };
  return backend;
}

describe("MdnsDiscovery", () => {
  it("browses _mbrelay._tcp, _mbserial._tcp, and _robotlink._tcp/._udp via the injected backend", () => {
    const backend = fakeBackend();
    const discovery = new MdnsDiscovery({ backend });

    discovery.start();

    expect(backend.findCalls).toEqual([
      { type: "mbrelay", protocol: "tcp" },
      { type: "mbserial", protocol: "tcp" },
      { type: "robotlink", protocol: "tcp" },
      { type: "robotlink", protocol: "udp" },
    ]);
  });

  it("start() is idempotent -- a second call does not browse again", () => {
    const backend = fakeBackend();
    const discovery = new MdnsDiscovery({ backend });

    discovery.start();
    discovery.start();

    expect(backend.findCalls).toHaveLength(4);
  });

  it("parses a _mbrelay._tcp record with TXT registry=8761 into registryPort: 8761", () => {
    const backend = fakeBackend();
    const discovery = new MdnsDiscovery({ backend });
    discovery.start();

    backend.relay.emitUp({
      name: "torture",
      host: "torture.local.",
      port: 8760,
      txt: { registry: "8761" },
    });

    expect(discovery.current().relays).toEqual([
      { instanceName: "torture", host: "torture.local.", port: 8760, registryPort: 8761 },
    ]);
  });

  it("parses a relay record with no registry TXT field as registryPort: undefined, never throwing", () => {
    const backend = fakeBackend();
    const discovery = new MdnsDiscovery({ backend });
    discovery.start();

    expect(() =>
      backend.relay.emitUp({ name: "torture", host: "torture.local.", port: 8760 }),
    ).not.toThrow();

    expect(discovery.current().relays).toEqual([
      { instanceName: "torture", host: "torture.local.", port: 8760, registryPort: undefined },
    ]);
  });

  it("parses a relay record with an unparseable registry TXT field as registryPort: undefined, never throwing, never guessing", () => {
    const backend = fakeBackend();
    const discovery = new MdnsDiscovery({ backend });
    discovery.start();

    expect(() =>
      backend.relay.emitUp({
        name: "torture",
        host: "torture.local.",
        port: 8760,
        txt: { registry: "not-a-port" },
      }),
    ).not.toThrow();

    expect(discovery.current().relays[0]?.registryPort).toBeUndefined();
  });

  it("treats an out-of-range registry TXT value as unparseable rather than clamping or guessing", () => {
    const backend = fakeBackend();
    const discovery = new MdnsDiscovery({ backend });
    discovery.start();

    backend.relay.emitUp({
      name: "torture",
      host: "torture.local.",
      port: 8760,
      txt: { registry: "0" },
    });

    expect(discovery.current().relays[0]?.registryPort).toBeUndefined();
  });

  it("parses a _mbserial._tcp record's instance name directly as the target robot's name", () => {
    const backend = fakeBackend();
    const discovery = new MdnsDiscovery({ backend });
    discovery.start();

    backend.robot.emitUp({ name: "zuzuv", host: "zuzuv.local.", port: 7654 });

    expect(discovery.current().robots).toEqual([
      { instanceName: "zuzuv", host: "zuzuv.local.", port: 7654 },
    ]);
  });

  it("removes a relay from the exposed list on a down event", () => {
    const backend = fakeBackend();
    const discovery = new MdnsDiscovery({ backend });
    discovery.start();
    backend.relay.emitUp({
      name: "torture",
      host: "torture.local.",
      port: 8760,
      txt: { registry: "8761" },
    });
    expect(discovery.current().relays).toHaveLength(1);

    backend.relay.emitDown({ name: "torture", host: "torture.local.", port: 8760 });

    expect(discovery.current().relays).toEqual([]);
  });

  it("removes a robot from the exposed list on a down event", () => {
    const backend = fakeBackend();
    const discovery = new MdnsDiscovery({ backend });
    discovery.start();
    backend.robot.emitUp({ name: "zuzuv", host: "zuzuv.local.", port: 7654 });
    expect(discovery.current().robots).toHaveLength(1);

    backend.robot.emitDown({ name: "zuzuv", host: "zuzuv.local.", port: 7654 });

    expect(discovery.current().robots).toEqual([]);
  });

  it("notifies onChange listeners with the full current snapshot on an up event", () => {
    const backend = fakeBackend();
    const discovery = new MdnsDiscovery({ backend });
    discovery.start();
    const listener = vi.fn();
    discovery.onChange(listener);

    backend.robot.emitUp({ name: "zuzuv", host: "zuzuv.local.", port: 7654 });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(discovery.current());
  });

  it("stops notifying an unsubscribed listener", () => {
    const backend = fakeBackend();
    const discovery = new MdnsDiscovery({ backend });
    discovery.start();
    const listener = vi.fn();
    const unsubscribe = discovery.onChange(listener);
    unsubscribe();

    backend.robot.emitUp({ name: "zuzuv", host: "zuzuv.local.", port: 7654 });

    expect(listener).not.toHaveBeenCalled();
  });

  it("stops all underlying browse sessions on stop()", () => {
    const backend = fakeBackend();
    const discovery = new MdnsDiscovery({ backend });
    discovery.start();

    discovery.stop();

    expect(backend.relay.stop).toHaveBeenCalledTimes(1);
    expect(backend.robot.stop).toHaveBeenCalledTimes(1);
    expect(backend.robotlinkTcp.stop).toHaveBeenCalledTimes(1);
    expect(backend.robotlinkUdp.stop).toHaveBeenCalledTimes(1);
    // The backend's own destroy() is never called by stop() -- the
    // backend may be injected/shared and re-start() must not need to
    // reconstruct it.
    expect(backend.destroy).not.toHaveBeenCalled();
  });

  it("can be started again after stop(), re-browsing all service types", () => {
    const backend = fakeBackend();
    const discovery = new MdnsDiscovery({ backend });
    discovery.start();
    discovery.stop();

    discovery.start();

    expect(backend.findCalls).toHaveLength(8);
  });

  describe("_robotlink._tcp/._udp (WiFi robots)", () => {
    /** The live-verified `gopiv` fixture from this ticket's acceptance
     * criteria: instance `gopiv robot link`, SRV `gopiv.local.:7654`,
     * TXT `name=gopiv role=robot link=v6 port=7654`. */
    function gopivFixture(): MdnsService {
      return {
        name: "gopiv robot link",
        host: "gopiv.local.",
        port: 7654,
        txt: { name: "gopiv", role: "robot", link: "v6", port: "7654" },
      };
    }

    const expectedGopiv = {
      name: "gopiv",
      host: "gopiv.local.",
      port: 7654,
      role: "robot",
      link: "v6",
    };

    it("parses a _robotlink._tcp record by TXT name, not the instance string", () => {
      const backend = fakeBackend();
      const discovery = new MdnsDiscovery({ backend });
      discovery.start();

      backend.robotlinkTcp.emitUp(gopivFixture());

      expect(discovery.current().wifiRobots).toEqual([expectedGopiv]);
    });

    it("parses an identical fixture advertised on _robotlink._udp identically", () => {
      const backend = fakeBackend();
      const discovery = new MdnsDiscovery({ backend });
      discovery.start();

      backend.robotlinkUdp.emitUp(gopivFixture());

      expect(discovery.current().wifiRobots).toEqual([expectedGopiv]);
    });

    it("deduplicates a robot advertising on both _robotlink._tcp and _robotlink._udp into one entry", () => {
      const backend = fakeBackend();
      const discovery = new MdnsDiscovery({ backend });
      discovery.start();

      backend.robotlinkTcp.emitUp(gopivFixture());
      backend.robotlinkUdp.emitUp(gopivFixture());

      expect(discovery.current().wifiRobots).toEqual([expectedGopiv]);
    });

    it("removes the entry on a down event from _robotlink._tcp", () => {
      const backend = fakeBackend();
      const discovery = new MdnsDiscovery({ backend });
      discovery.start();
      backend.robotlinkTcp.emitUp(gopivFixture());
      backend.robotlinkUdp.emitUp(gopivFixture());
      expect(discovery.current().wifiRobots).toHaveLength(1);

      backend.robotlinkTcp.emitDown(gopivFixture());

      expect(discovery.current().wifiRobots).toEqual([]);
    });

    it("removes the entry on a down event from _robotlink._udp", () => {
      const backend = fakeBackend();
      const discovery = new MdnsDiscovery({ backend });
      discovery.start();
      backend.robotlinkUdp.emitUp(gopivFixture());
      expect(discovery.current().wifiRobots).toHaveLength(1);

      backend.robotlinkUdp.emitDown(gopivFixture());

      expect(discovery.current().wifiRobots).toEqual([]);
    });

    it("parses role/link as undefined, never throwing, when the TXT record omits them", () => {
      const backend = fakeBackend();
      const discovery = new MdnsDiscovery({ backend });
      discovery.start();

      expect(() =>
        backend.robotlinkTcp.emitUp({
          name: "gopiv robot link",
          host: "gopiv.local.",
          port: 7654,
          txt: { name: "gopiv" },
        }),
      ).not.toThrow();

      expect(discovery.current().wifiRobots).toEqual([
        { name: "gopiv", host: "gopiv.local.", port: 7654, role: undefined, link: undefined },
      ]);
    });

    it("does not affect the relays/robots lists", () => {
      const backend = fakeBackend();
      const discovery = new MdnsDiscovery({ backend });
      discovery.start();

      backend.robotlinkTcp.emitUp(gopivFixture());

      const snapshot = discovery.current();
      expect(snapshot.relays).toEqual([]);
      expect(snapshot.robots).toEqual([]);
    });
  });
});
