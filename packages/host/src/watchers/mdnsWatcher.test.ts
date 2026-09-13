import { EventEmitter } from "node:events";
import os from "node:os";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { deviceIdToName, nameToValue } from "@robot-console/protocol";
import { openStoreDb } from "../store/db.js";
import { Store } from "../store/index.js";
import type { MdnsBackend, MdnsBrowser, MdnsFindOptions, MdnsService } from "../discovery/mdnsDiscovery.js";
import {
  startMdnsWatcher,
  DEFAULT_REQUERY_INTERVAL_MS,
  DEFAULT_WIFI_TTL_MS,
  DEFAULT_MBSERIAL_TTL_MS,
  DEFAULT_MBRELAY_TTL_MS,
  DEFAULT_MBFLASH_TTL_MS,
  DEFAULT_RADIO_TTL_MS,
  type MdnsWatcherDeps,
  type MdnsWatcherOptions,
} from "./mdnsWatcher.js";

// Ticket 014-008: `mdnsWatcher.ts`'s own suite. No real multicast
// socket and no real wall-clock wait anywhere here -- every seam
// (backend, browser, clock) is a fake or vitest's fake timers, per the
// ticket's own testing note.

/** A fresh in-memory, fully-migrated store for one test. */
function freshStore(): Store {
  return new Store(openStoreDb({ filePath: ":memory:" }));
}

/**
 * Fully synthetic fake browse session -- a bare `EventEmitter` plus
 * `stop()`/`update()` spies, structurally satisfying {@link MdnsBrowser}.
 * Mirrors `discovery/mdnsDiscovery.test.ts`'s own `fakeBrowser()`
 * fixture, extended with `update()` (re-query) and `onServiceChange()`
 * (SRV/TXT change on an already-known instance, ticket 014-008's own
 * addition to the seam).
 */
function fakeBrowser() {
  const emitter = new EventEmitter();
  let changeListener: ((service: MdnsService) => void) | undefined;
  const browser: MdnsBrowser & {
    emitUp: (service: MdnsService) => void;
    emitDown: (service: MdnsService) => void;
    emitServiceChange: (service: MdnsService) => void;
    stop: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  } = {
    on(event, listener) {
      emitter.on(event, listener);
    },
    stop: vi.fn(),
    update: vi.fn(),
    onServiceChange(listener) {
      changeListener = listener;
    },
    emitUp(service: MdnsService) {
      emitter.emit("up", service);
    },
    emitDown(service: MdnsService) {
      emitter.emit("down", service);
    },
    emitServiceChange(service: MdnsService) {
      changeListener?.(service);
    },
  };
  return browser;
}

/**
 * Fully synthetic fake {@link MdnsBackend} routing each of the five
 * service types (`specification.md` §4.4) to its own fake browser, kept
 * separate so a test can drive each independently -- mirrors
 * `discovery/mdnsDiscovery.test.ts`'s own `fakeBackend()` fixture,
 * extended to the two additional types (`mbflash`, and `robotlink` split
 * `tcp`/`udp` was already there).
 */
function fakeBackend() {
  const relay = fakeBrowser();
  const serial = fakeBrowser();
  const flash = fakeBrowser();
  const robotlinkTcp = fakeBrowser();
  const robotlinkUdp = fakeBrowser();
  const findCalls: MdnsFindOptions[] = [];
  /** Bench defect 1's own seam: raw PTR-answer listeners, keyed by
   * nothing (every listener hears every fqdn, exactly like the real
   * `createBonjourBackend().onAnnounce` -- filtering by fqdn is
   * `mdnsWatcher.ts`'s own job, not the backend's). */
  const announceListeners = new Set<(fqdn: string, receivedAt: number) => void>();
  const backend: MdnsBackend & {
    relay: typeof relay;
    serial: typeof serial;
    flash: typeof flash;
    robotlinkTcp: typeof robotlinkTcp;
    robotlinkUdp: typeof robotlinkUdp;
    findCalls: MdnsFindOptions[];
    emitAnnounce: (fqdn: string, receivedAt?: number) => void;
  } = {
    relay,
    serial,
    flash,
    robotlinkTcp,
    robotlinkUdp,
    findCalls,
    find(options: MdnsFindOptions): MdnsBrowser {
      findCalls.push(options);
      if (options.type === "mbrelay") return relay;
      if (options.type === "mbserial") return serial;
      if (options.type === "mbflash") return flash;
      return options.protocol === "udp" ? robotlinkUdp : robotlinkTcp;
    },
    onAnnounce(listener: (fqdn: string, receivedAt: number) => void): () => void {
      announceListeners.add(listener);
      return () => {
        announceListeners.delete(listener);
      };
    },
    emitAnnounce(fqdn: string, receivedAt = Date.now()) {
      for (const listener of announceListeners) {
        listener(fqdn, receivedAt);
      }
    },
    destroy: vi.fn(),
  };
  return backend;
}

function wifiService(name: string, host: string, port: number, addresses?: string[]): MdnsService {
  return {
    name: `${name} robot link`,
    host,
    port,
    txt: { name, role: "robot", link: "v6" },
    fqdn: `${name}.local`,
    ...(addresses !== undefined ? { addresses } : {}),
  };
}

function mbserialService(name: string, host: string, port: number, addresses?: string[]): MdnsService {
  return { name, host, port, fqdn: `${name}.local`, ...(addresses !== undefined ? { addresses } : {}) };
}

function mbrelayService(name: string, host: string, port: number, registryPort: number, addresses?: string[]): MdnsService {
  return {
    name,
    host,
    port,
    txt: { registry: String(registryPort) },
    fqdn: `${name}.local`,
    ...(addresses !== undefined ? { addresses } : {}),
  };
}

function mbflashService(name: string, host: string, port: number): MdnsService {
  return { name, host, port, fqdn: `${name}.local` };
}

/** A `devices` row's id/name pair, derived from `deviceIdToName` itself
 * (never hand-picked) so this suite never risks the
 * `DeviceNameMismatchError` `upsertDevice` throws on a mismatched pair. */
function namedDevice(id: number): { id: number; name: string } {
  return { id, name: deviceIdToName(id) };
}

const start = (
  store: Store,
  backend: ReturnType<typeof fakeBackend>,
  opts?: MdnsWatcherOptions,
  deps?: Partial<MdnsWatcherDeps>,
) => startMdnsWatcher(store, { backend, ...deps }, opts);

describe("startMdnsWatcher", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("browses all five service types on start", () => {
    const store = freshStore();
    const backend = fakeBackend();
    const handle = start(store, backend);
    try {
      expect(backend.findCalls).toEqual([
        { type: "mbrelay", protocol: "tcp" },
        { type: "mbserial", protocol: "tcp" },
        { type: "mbflash", protocol: "tcp" },
        { type: "robotlink", protocol: "tcp" },
        { type: "robotlink", protocol: "udp" },
      ]);
    } finally {
      handle.stop();
      store.close();
    }
  });

  it(
    "a robot answering immediately and a second robot answering only the periodic re-query both end with links(wifi) rows",
    () => {
      const store = freshStore();
      const backend = fakeBackend();
      const handle = start(store, backend);
      try {
        backend.robotlinkTcp.emitUp(wifiService("aaaaa", "aaaaa.local", 7654));
        expect(store.snapshotRows().links.map((l) => l.id)).toContain("wifi-aaaaa");

        // The second robot's own announcement was missed; it only
        // answers once `browser.update()` re-issues the query on the
        // periodic tick below (no separate up/down call here -- the
        // fake's `update()` is what a real re-query "answering" looks
        // like, scripted directly, since driving an actual PTR
        // round-trip has no place in a unit test).
        backend.robotlinkTcp.update.mockImplementationOnce(() => {
          backend.robotlinkTcp.emitUp(wifiService("bbbbb", "bbbbb.local", 7654));
        });

        expect(store.snapshotRows().links.map((l) => l.id)).not.toContain("wifi-bbbbb");
        vi.advanceTimersByTime(DEFAULT_REQUERY_INTERVAL_MS);

        const linkIds = store.snapshotRows().links.map((l) => l.id);
        expect(linkIds).toContain("wifi-aaaaa");
        expect(linkIds).toContain("wifi-bbbbb");
        expect(backend.robotlinkTcp.update).toHaveBeenCalled();
        expect(backend.robotlinkUdp.update).toHaveBeenCalled();
      } finally {
        handle.stop();
        store.close();
      }
    },
  );

  it(
    "a SRV host change with no down/up event updates the link's address and marks an open session unresponsive",
    () => {
      const store = freshStore();
      const backend = fakeBackend();
      const handle = start(store, backend);
      try {
        backend.robotlinkTcp.emitUp(wifiService("ccccc", "10.0.0.5", 7654));
        const linkId = "wifi-ccccc";
        expect(store.snapshotRows().links.find((l) => l.id === linkId)).toMatchObject({
          address: JSON.stringify({ host: "10.0.0.5", port: 7654 }),
        });

        store.openSession(linkId, Date.now());

        backend.robotlinkTcp.emitServiceChange(wifiService("ccccc", "10.0.0.99", 7654));

        const row = store.snapshotRows().links.find((l) => l.id === linkId);
        expect(row?.address).toBe(JSON.stringify({ host: "10.0.0.99", port: 7654 }));
        expect(row?.state).toBe("unresponsive");
        expect(row?.state_reason).toBe("address changed");
      } finally {
        handle.stop();
        store.close();
      }
    },
  );

  it(
    "a SRV change with no open session updates the address without touching link state",
    () => {
      const store = freshStore();
      const backend = fakeBackend();
      const handle = start(store, backend);
      try {
        backend.robotlinkTcp.emitUp(wifiService("ddddd", "10.0.0.5", 7654));
        const before = store.snapshotRows().links.find((l) => l.id === "wifi-ddddd");
        expect(before?.state).toBe("discovered");

        backend.robotlinkTcp.emitServiceChange(wifiService("ddddd", "10.0.0.6", 7654));

        const after = store.snapshotRows().links.find((l) => l.id === "wifi-ddddd");
        expect(after?.address).toBe(JSON.stringify({ host: "10.0.0.6", port: 7654 }));
        expect(after?.state).toBe("discovered");
      } finally {
        handle.stop();
        store.close();
      }
    },
  );

  // 018-007: mdnsWatcher.ts stores the resolved IPv4 address (`ip`)
  // alongside `host`/`port`, picked out of the A/AAAA answers
  // `bonjour-service` itself already parses (`MdnsService.addresses`) --
  // this is the address `tcpStream.ts` dials directly instead of ever
  // resolving the `.local` hostname itself.
  describe("018-007: resolved IPv4 address (ip) storage", () => {
    it("stores the resolved ip alongside host/port for a wifi link's first observation", () => {
      const store = freshStore();
      const backend = fakeBackend();
      const handle = start(store, backend);
      try {
        backend.robotlinkTcp.emitUp(wifiService("eeeee", "eeeee.local", 7654, ["fe80::1", "192.168.1.193"]));
        const row = store.snapshotRows().links.find((l) => l.id === "wifi-eeeee");
        expect(row?.address).toBe(JSON.stringify({ host: "eeeee.local", port: 7654, ip: "192.168.1.193" }));
      } finally {
        handle.stop();
        store.close();
      }
    });

    it("stores the resolved ip for a mbserial link", () => {
      const store = freshStore();
      const backend = fakeBackend();
      const handle = start(store, backend);
      try {
        backend.serial.emitUp(mbserialService("fffff", "fffff.local", 37317, ["192.168.1.148"]));
        const row = store.snapshotRows().links.find((l) => l.id === "mbserial-fffff");
        expect(row?.address).toBe(JSON.stringify({ host: "fffff.local", port: 37317, ip: "192.168.1.148" }));
      } finally {
        handle.stop();
        store.close();
      }
    });

    it("stores the resolved ip for a mbrelay link, alongside registryPort", () => {
      const store = freshStore();
      const backend = fakeBackend();
      const handle = start(store, backend);
      try {
        backend.relay.emitUp(mbrelayService("torture", "torture.local", 12345, 8080, ["192.168.1.12"]));
        const row = store.snapshotRows().links.find((l) => l.id === "mbrelay-torture");
        expect(row?.address).toBe(JSON.stringify({ host: "torture.local", port: 12345, ip: "192.168.1.12", registryPort: 8080 }));
      } finally {
        handle.stop();
        store.close();
      }
    });

    it("omits ip entirely (never stores it as null/undefined) when the observation carries no IPv4 address", () => {
      const store = freshStore();
      const backend = fakeBackend();
      const handle = start(store, backend);
      try {
        backend.robotlinkTcp.emitUp(wifiService("ggggg", "ggggg.local", 7654, ["fe80::2"]));
        const row = store.snapshotRows().links.find((l) => l.id === "wifi-ggggg");
        expect(row?.address).toBe(JSON.stringify({ host: "ggggg.local", port: 7654 }));

        backend.robotlinkTcp.emitUp(wifiService("hhhhh", "hhhhh.local", 7654));
        const rowNoAddresses = store.snapshotRows().links.find((l) => l.id === "wifi-hhhhh");
        expect(rowNoAddresses?.address).toBe(JSON.stringify({ host: "hhhhh.local", port: 7654 }));
      } finally {
        handle.stop();
        store.close();
      }
    });

    it("an ip-only change (host/port unchanged) still marks an open session unresponsive, same as a host/port change", () => {
      const store = freshStore();
      const backend = fakeBackend();
      const handle = start(store, backend);
      try {
        backend.robotlinkTcp.emitUp(wifiService("iiiii", "iiiii.local", 7654, ["192.168.1.10"]));
        const linkId = "wifi-iiiii";
        store.openSession(linkId, Date.now());

        backend.robotlinkTcp.emitServiceChange(wifiService("iiiii", "iiiii.local", 7654, ["192.168.1.11"]));

        const row = store.snapshotRows().links.find((l) => l.id === linkId);
        expect(row?.address).toBe(JSON.stringify({ host: "iiiii.local", port: 7654, ip: "192.168.1.11" }));
        expect(row?.state).toBe("unresponsive");
        expect(row?.state_reason).toBe("address changed");
      } finally {
        handle.stop();
        store.close();
      }
    });

    it("re-announcing the same ip on an unchanged instance does not mark an open session unresponsive", () => {
      const store = freshStore();
      const backend = fakeBackend();
      const handle = start(store, backend);
      try {
        backend.robotlinkTcp.emitUp(wifiService("jjjjj", "jjjjj.local", 7654, ["192.168.1.20"]));
        const linkId = "wifi-jjjjj";
        store.openSession(linkId, Date.now());

        backend.robotlinkTcp.emitServiceChange(wifiService("jjjjj", "jjjjj.local", 7654, ["192.168.1.20"]));

        const row = store.snapshotRows().links.find((l) => l.id === linkId);
        expect(row?.state).not.toBe("unresponsive");
      } finally {
        handle.stop();
        store.close();
      }
    });
  });

  it(
    "advancing the fake clock past each TTL with no further traffic ages links(wifi|mbserial|mbrelay) stale and deletes their services rows",
    () => {
      const store = freshStore();
      const backend = fakeBackend();
      const handle = start(store, backend);
      try {
        backend.robotlinkTcp.emitUp(wifiService("eeeee", "eeeee.local", 7654));
        backend.serial.emitUp(mbserialService("fffff", "fffff.local", 9000));
        // "gopoz" -- a well-formed five-letter name, takes the fast path
        // (`nameToValue`). "torture" -- not a well-formed name (ticket
        // 016-008's bench finding), takes ticket 017-005's negative-hash
        // fallback. Both age off `last_seen`/TTL identically -- aging
        // never distinguishes a relay device row by how its id was
        // minted, only by transport/TTL (module doc comment).
        backend.relay.emitUp(mbrelayService("gopoz", "gopoz.local", 8760, 8761));
        backend.relay.emitUp(mbrelayService("torture", "torture.local", 8762, 8763));
        backend.flash.emitUp(mbflashService("hhhhh", "hhhhh.local", 8000));

        const before = store.snapshotRows();
        expect(before.links).toHaveLength(4);
        expect(before.services).toHaveLength(5);

        // Past every TTL, no further traffic. Fake timers replay every
        // elapsed interval tick, so the aging pass below runs several
        // times as the clock advances.
        vi.advanceTimersByTime(DEFAULT_WIFI_TTL_MS + DEFAULT_REQUERY_INTERVAL_MS);

        const after = store.snapshotRows();
        expect(after.links.filter((l) => l.state === "stale")).toHaveLength(4);
        expect(after.services).toHaveLength(0);
      } finally {
        handle.stop();
        store.close();
      }
    },
  );

  it(
    "018-005: the same aging tick also ages radio links past their ttl (relay gone), even though this module never creates radio rows itself",
    () => {
      const store = freshStore();
      const backend = fakeBackend();
      // A radio link whose relay no longer exists -- `ageRadioLinks`'s
      // own store-level unit tests (`store/index.test.ts`) cover the
      // full aging rule; this test's only job is proving the wiring:
      // this watcher's tick calls it at all, with no sweeper involved.
      store.upsertDevice({ id: 1198504156, name: "vevov", kind: "robot", at: 0 });
      store.upsertLink({
        id: "radio-gopiv-via-usb-gone",
        transport: "radio",
        address: { relayLinkId: "usb-gone", channel: 1, group: 1 },
        deviceId: 1198504156,
        at: 0,
      });
      const handle = start(store, backend);
      try {
        expect(store.snapshotRows().links.find((l) => l.id === "radio-gopiv-via-usb-gone")?.state).toBe("discovered");

        vi.advanceTimersByTime(DEFAULT_REQUERY_INTERVAL_MS);

        expect(store.snapshotRows().links.find((l) => l.id === "radio-gopiv-via-usb-gone")?.state).toBe("stale");
      } finally {
        handle.stop();
        store.close();
      }
    },
  );

  it(
    "a continuously-present service survives past its TTL when the backend keeps reporting announce packets for it (bench defect 1: presence refresh)",
    () => {
      const store = freshStore();
      const backend = fakeBackend();
      const handle = start(store, backend);
      try {
        const service = wifiService("kkkkk", "kkkkk.local", 7654);
        backend.robotlinkTcp.emitUp(service);
        const linkId = "wifi-kkkkk";
        expect(store.snapshotRows().links.find((l) => l.id === linkId)?.state).toBe("discovered");

        // Every re-query tick, the backend reports a fresh PTR answer for
        // the same, unchanged instance -- exactly what a continuously
        // advertised, idle service looks like on the wire (no up/down,
        // no SRV/TXT change, just periodic re-query answers). Enough
        // iterations to run well past DEFAULT_WIFI_TTL_MS, matching the
        // companion "no further traffic" test below.
        const iterations = Math.ceil((DEFAULT_WIFI_TTL_MS + DEFAULT_REQUERY_INTERVAL_MS) / DEFAULT_REQUERY_INTERVAL_MS) + 1;
        for (let i = 0; i < iterations; i++) {
          vi.advanceTimersByTime(DEFAULT_REQUERY_INTERVAL_MS);
          backend.emitAnnounce(service.fqdn!);
        }

        expect(store.snapshotRows().links.find((l) => l.id === linkId)?.state).not.toBe("stale");
      } finally {
        handle.stop();
        store.close();
      }
    },
  );

  it(
    "the same continuously-present service goes stale anyway once announce packets stop arriving too (regression guard: presence refresh is not a permanent exemption)",
    () => {
      const store = freshStore();
      const backend = fakeBackend();
      const handle = start(store, backend);
      try {
        const service = wifiService("lllll", "lllll.local", 7654);
        backend.robotlinkTcp.emitUp(service);
        const linkId = "wifi-lllll";

        // Announce packets keep it alive for a while...
        vi.advanceTimersByTime(DEFAULT_REQUERY_INTERVAL_MS);
        backend.emitAnnounce(service.fqdn!);
        expect(store.snapshotRows().links.find((l) => l.id === linkId)?.state).not.toBe("stale");

        // ...but once they stop (the robot actually left, or the relay
        // pool actually went away), the link still ages to stale after
        // its TTL, same as the "no further traffic" case above -- this
        // fix only refreshes presence that is real, never a permanent
        // once-seen-always-alive exemption.
        vi.advanceTimersByTime(DEFAULT_WIFI_TTL_MS + DEFAULT_REQUERY_INTERVAL_MS);
        expect(store.snapshotRows().links.find((l) => l.id === linkId)?.state).toBe("stale");
      } finally {
        handle.stop();
        store.close();
      }
    },
  );

  it("stop()/start() round trip stops every browser and leaves no timer or in-memory state behind", () => {
    const store = freshStore();
    const backend = fakeBackend();
    const handle = start(store, backend);

    backend.robotlinkTcp.emitUp(wifiService("iiiii", "iiiii.local", 7654));
    vi.advanceTimersByTime(DEFAULT_REQUERY_INTERVAL_MS);
    const heartbeatAfterFirstCycle = store.snapshotRows().tasks.find((t) => t.name === "mdnsWatcher")?.heartbeat_at;
    expect(heartbeatAfterFirstCycle).toBeDefined();

    handle.stop();
    for (const browser of [backend.relay, backend.serial, backend.flash, backend.robotlinkTcp, backend.robotlinkUdp]) {
      expect(browser.stop).toHaveBeenCalledTimes(1);
    }

    // No further browse cycles after stop() -- the heartbeat never
    // advances again, proving the interval was actually cleared rather
    // than merely unreferenced.
    vi.advanceTimersByTime(DEFAULT_REQUERY_INTERVAL_MS * 5);
    expect(store.snapshotRows().tasks.find((t) => t.name === "mdnsWatcher")?.heartbeat_at).toBe(
      heartbeatAfterFirstCycle,
    );

    // A fresh start (a brand-new call, its own closures -- no class
    // instance/private field carries anything from the stopped run)
    // works cleanly against a brand-new backend.
    const backend2 = fakeBackend();
    const handle2 = start(store, backend2);
    try {
      backend2.robotlinkTcp.emitUp(wifiService("iiiii", "iiiii.local", 7999));
      // The restarted watcher's very first observation of this link is
      // never treated as a "change" (nothing in memory says otherwise
      // -- only the store's own prior row would, and here it legitimately
      // did change), so this just confirms the fresh run behaves
      // normally, not that change-detection is suppressed.
      expect(store.snapshotRows().links.find((l) => l.id === "wifi-iiiii")?.address).toBe(
        JSON.stringify({ host: "iiiii.local", port: 7999 }),
      );
    } finally {
      handle2.stop();
      store.close();
    }
  });

  it("a wifi advertisement for a name that is not owned produces a services row and an unassigned link", () => {
    const store = freshStore();
    const backend = fakeBackend();
    const handle = start(store, backend);
    try {
      backend.robotlinkTcp.emitUp(wifiService("jjjjj", "jjjjj.local", 7654));

      const rows = store.snapshotRows();
      expect(rows.services.some((s) => s.instance === "jjjjj robot link")).toBe(true);
      const link = rows.links.find((l) => l.id === "wifi-jjjjj");
      expect(link).toBeDefined();
      expect(link?.device_id).toBeNull();
    } finally {
      handle.stop();
      store.close();
    }
  });

  it("an mbserial advertisement for a name that is not owned produces a services row and an unassigned link (sprint 016 ticket 006 regression guard: uniqueOwnedDeviceIdByName is shared with handleWifi)", () => {
    const store = freshStore();
    const backend = fakeBackend();
    const handle = start(store, backend);
    try {
      backend.serial.emitUp(mbserialService("jjjjj", "jjjjj.local", 4795));

      const rows = store.snapshotRows();
      expect(rows.services.some((s) => s.instance === "jjjjj")).toBe(true);
      const link = rows.links.find((l) => l.id === "mbserial-jjjjj");
      expect(link).toBeDefined();
      expect(link?.device_id).toBeNull();
    } finally {
      handle.stop();
      store.close();
    }
  });

  it("attaches a wifi link to a devices row only when exactly one owned device shares its name", () => {
    const store = freshStore();
    const backend = fakeBackend();
    const owned = namedDevice(1198504156); // "vevov" -- same fixture pair usbWatcher.test.ts uses.
    store.upsertDevice({ id: owned.id, name: owned.name, kind: "robot", at: Date.now() });
    store.setOwned(owned.id, true, Date.now());

    const handle = start(store, backend);
    try {
      backend.robotlinkTcp.emitUp(wifiService(owned.name, `${owned.name}.local`, 7654));
      const link = store.snapshotRows().links.find((l) => l.id === `wifi-${owned.name}`);
      expect(link?.device_id).toBe(owned.id);
    } finally {
      handle.stop();
      store.close();
    }
  });

  // ---------------------------------------------------------------------
  // Ticket 016-008 (carried from ticket 006): a freshly mDNS-discovered
  // wifi/mbserial link attached to an owned device is promoted
  // `discovered` -> `connectable`, mirroring usbWatcher.ts's own
  // naming->connectable promotion, so the reconciler's auto-connect for
  // owned robots actually fires. An un-owned link stays `discovered`.
  // ---------------------------------------------------------------------
  it.each([
    [
      "wifi",
      (backend: ReturnType<typeof fakeBackend>, name: string) =>
        backend.robotlinkTcp.emitUp(wifiService(name, `${name}.local`, 7654)),
      (name: string) => `wifi-${name}`,
    ],
    [
      "mbserial",
      (backend: ReturnType<typeof fakeBackend>, name: string) =>
        backend.serial.emitUp(mbserialService(name, `${name}.local`, 4795)),
      (name: string) => `mbserial-${name}`,
    ],
  ] as const)(
    "promotes a freshly-discovered owned %s link to connectable, but leaves an un-owned one discovered (ticket 016-008)",
    (_transport, emit, linkIdFor) => {
      const store = freshStore();
      const backend = fakeBackend();
      const owned = namedDevice(1198504156); // "vevov"
      const unowned = namedDevice(2); // no devices row at all -- unowned by construction
      store.upsertDevice({ id: owned.id, name: owned.name, kind: "robot", at: Date.now() });
      store.setOwned(owned.id, true, Date.now());

      const handle = start(store, backend);
      try {
        emit(backend, owned.name);
        const ownedLink = store.snapshotRows().links.find((l) => l.id === linkIdFor(owned.name));
        expect(ownedLink?.device_id).toBe(owned.id);
        expect(ownedLink?.state).toBe("connectable");

        emit(backend, unowned.name);
        const unownedLink = store.snapshotRows().links.find((l) => l.id === linkIdFor(unowned.name));
        expect(unownedLink?.device_id).toBeNull();
        expect(unownedLink?.state).toBe("discovered");
      } finally {
        handle.stop();
        store.close();
      }
    },
  );

  it("does not demote an owned wifi link's state once it has moved past discovered (e.g. already connected) on a later re-observation", () => {
    const store = freshStore();
    const backend = fakeBackend();
    const owned = namedDevice(1198504156);
    store.upsertDevice({ id: owned.id, name: owned.name, kind: "robot", at: Date.now() });
    store.setOwned(owned.id, true, Date.now());

    const handle = start(store, backend);
    try {
      backend.robotlinkTcp.emitUp(wifiService(owned.name, `${owned.name}.local`, 7654));
      const linkId = `wifi-${owned.name}`;
      expect(store.snapshotRows().links.find((l) => l.id === linkId)?.state).toBe("connectable");

      // Simulate the reconciler having since connected it.
      store.setLinkState({ id: linkId, state: "connected", at: Date.now() });

      // A later re-observation (e.g. a TXT/SRV re-announce with the
      // exact same address) must never demote it back to connectable.
      backend.robotlinkTcp.emitServiceChange(wifiService(owned.name, `${owned.name}.local`, 7654));
      expect(store.snapshotRows().links.find((l) => l.id === linkId)?.state).toBe("connected");
    } finally {
      handle.stop();
      store.close();
    }
  });

  // ---------------------------------------------------------------------
  // Ticket 016-005's device-creation fallback, extended by ticket 017-005
  // (2026-09-12 architecture revision) to cover a name that isn't a
  // well-formed micro:bit name: rather than leaving the link unassigned
  // (016-008's original bench-finding fix), `createRelayDeviceIfAbsent`
  // now mints a stable negative-id row for it too. Table test: fast path
  // (grammar name -> `nameToValue`, non-negative id) and fallback
  // (non-grammar name, e.g. the real bench relay "torture" -- seven
  // letters, not that shape at all -- -> negative hash id), side by side.
  // ---------------------------------------------------------------------
  it.each([
    ["tovez", "grammar name (fast path, nameToValue)", "grammar" as const],
    ["torture", "non-grammar name (fallback, negative hash -- ticket 016-008 bench finding)", "non-grammar" as const],
  ] as const)(
    "creates a synthetic devices(kind='relay') row for a %s when no existing relay device matches the mDNS instance name",
    (name, _desc, shape) => {
      const store = freshStore();
      const backend = fakeBackend();
      const handle = start(store, backend);
      try {
        expect(() => {
          backend.relay.emitUp(mbrelayService(name, `${name}.local`, 8760, 8761));
        }).not.toThrow();

        const rows = store.snapshotRows();
        const link = rows.links.find((l) => l.id === `mbrelay-${name}`);
        expect(link).toBeDefined();
        expect(link?.device_id).not.toBeNull();

        const syntheticId = Number(link?.device_id);
        if (shape === "grammar") {
          expect(syntheticId).toBe(nameToValue(name));
        } else {
          // Non-grammar names get a negative id -- never in
          // nameToValue's [0, 3124] range, and never a real chip id
          // either (store/index.ts's own narrowed invariant convention).
          expect(syntheticId).toBeLessThan(0);
        }
        const device = rows.devices.find((d) => d.id === syntheticId);
        expect(device).toMatchObject({ name, kind: "relay" });
      } finally {
        handle.stop();
        store.close();
      }
    },
  );

  it("mints the same negative id for the same non-grammar relay name on a repeat observation (idempotent, stable hash)", () => {
    const store = freshStore();
    const backend = fakeBackend();
    const handle = start(store, backend);
    try {
      backend.relay.emitUp(mbrelayService("torture", "torture.local", 8760, 8761));
      const firstId = store.snapshotRows().links.find((l) => l.id === "mbrelay-torture")?.device_id;

      // A re-announce with a changed address (SRV/TXT change, not a
      // fresh `up`) re-observes the same name -- the fast path
      // (`uniqueRelayDeviceIdByName`) now finds the row minted above and
      // reattaches to it, rather than createRelayDeviceIfAbsent minting
      // (or re-hashing) a second one -- same overall guarantee
      // `upsertDevice`'s own idempotency gives the fast path today.
      backend.relay.emitServiceChange(mbrelayService("torture", "torture.local", 9000, 9001));
      const secondId = store.snapshotRows().links.find((l) => l.id === "mbrelay-torture")?.device_id;

      expect(secondId).toBe(firstId);
      expect(store.snapshotRows().devices.filter((d) => d.kind === "relay")).toHaveLength(1);
    } finally {
      handle.stop();
      store.close();
    }
  });

  it(
    "attaches an mbrelay link to an already-identified local relay device by name (fast path, unchanged -- regression guard)",
    () => {
      const store = freshStore();
      const backend = fakeBackend();
      const relay = namedDevice(2); // arbitrary distinct id from the synthetic-id test's own "tovez" name
      store.upsertDevice({ id: relay.id, name: relay.name, kind: "relay", at: 1 });

      const handle = start(store, backend);
      try {
        backend.relay.emitUp(mbrelayService(relay.name, `${relay.name}.local`, 8760, 8761));

        const link = store.snapshotRows().links.find((l) => l.id === `mbrelay-${relay.name}`);
        expect(link?.device_id).toBe(relay.id);
        // No second relay device was minted -- only the one seeded above.
        expect(store.snapshotRows().devices.filter((d) => d.kind === "relay")).toHaveLength(1);
      } finally {
        handle.stop();
        store.close();
      }
    },
  );

  it(
    "leaves an mbrelay link unassigned when more than one relay device already shares its name, without minting a third",
    () => {
      const store = freshStore();
      const backend = fakeBackend();
      const name = "gopoz";
      // Two distinct ids that both happen to decode to the same name is
      // not representable via upsertDevice's own name/id consistency
      // check, so this ambiguity is seeded the same way
      // `uniqueRelayDeviceIdByName`'s own doc comment describes it in
      // production -- two independently-seeded rows sharing one `name`
      // column value (a real possibility per architecture.md §4's
      // collision math), written directly here since the store's public
      // API has no other way to construct this state.
      store.upsertDevice({ id: nameToValue(name), name, kind: "relay", at: 1 });
      store.upsertDevice({ id: nameToValue(name) + 3125, name, kind: "relay", at: 1 });

      const handle = start(store, backend);
      try {
        backend.relay.emitUp(mbrelayService(name, `${name}.local`, 8760, 8761));

        const link = store.snapshotRows().links.find((l) => l.id === `mbrelay-${name}`);
        expect(link?.device_id).toBeNull();
        expect(store.snapshotRows().devices.filter((d) => d.kind === "relay")).toHaveLength(2);
      } finally {
        handle.stop();
        store.close();
      }
    },
  );

  // ---------------------------------------------------------------------
  // 018-010, item 2: this very machine must never mint (or even
  // observe) itself as a relay/serial-bridge device -- the stakeholder's
  // own front page showed a card named after his Mac's own hostname
  // ("gala") with "No role announced" once something local advertised
  // an `_mbrelay._tcp`/`_mbserial._tcp` service whose SRV host resolved
  // back to that same machine. `os.hostname()` (never a hardcoded
  // stand-in for "gala") is used here so this suite proves the real
  // rule against whatever machine actually runs it, in CI included.
  // ---------------------------------------------------------------------
  it("018-010: never mints a relay device for an mbrelay service whose host is this very machine", () => {
    const store = freshStore();
    const backend = fakeBackend();
    const handle = start(store, backend);
    try {
      backend.relay.emitUp(mbrelayService(os.hostname(), `${os.hostname()}.local`, 8760, 8761));

      expect(store.snapshotRows().links.find((l) => l.id === `mbrelay-${os.hostname()}`)).toBeUndefined();
      expect(store.snapshotRows().devices.filter((d) => d.kind === "relay")).toHaveLength(0);
    } finally {
      handle.stop();
      store.close();
    }
  });

  it("018-010: never mints a relay device for an mbrelay service resolved to one of this machine's own addresses, even when the host label doesn't textually match", () => {
    const store = freshStore();
    const backend = fakeBackend();
    const handle = start(store, backend);
    try {
      backend.relay.emitUp(mbrelayService("someOtherLabel", "some-other-label.local", 8760, 8761, ["127.0.0.1"]));

      expect(store.snapshotRows().links.find((l) => l.id === "mbrelay-someOtherLabel")).toBeUndefined();
      expect(store.snapshotRows().devices.filter((d) => d.kind === "relay")).toHaveLength(0);
    } finally {
      handle.stop();
      store.close();
    }
  });

  it("018-010: still mints a relay device for a different machine's mbrelay service (regression guard -- the filter is not over-broad)", () => {
    const store = freshStore();
    const backend = fakeBackend();
    const handle = start(store, backend);
    try {
      backend.relay.emitUp(mbrelayService("torture", "torture.local", 8760, 8761, ["192.168.1.12"]));

      expect(store.snapshotRows().links.find((l) => l.id === "mbrelay-torture")).toBeDefined();
      expect(store.snapshotRows().devices.filter((d) => d.kind === "relay")).toHaveLength(1);
    } finally {
      handle.stop();
      store.close();
    }
  });

  it("018-010: never observes an mbserial service whose host is this very machine (defensive symmetry with handleMbrelay)", () => {
    const store = freshStore();
    const backend = fakeBackend();
    const owned = namedDevice(3);
    // Coincidentally-matching name isn't the point here -- this proves
    // the guard runs before any owned-device attachment would even be
    // attempted, using this machine's own hostname as the mbserial
    // instance name (the shape a locally-running bridge would actually
    // advertise under).
    store.upsertDevice({ id: owned.id, name: owned.name, kind: "robot", owned: true, at: 1 });
    const handle = start(store, backend);
    try {
      backend.serial.emitUp(mbserialService(os.hostname(), `${os.hostname()}.local`, 8760));

      expect(store.snapshotRows().links.find((l) => l.id === `mbserial-${os.hostname()}`)).toBeUndefined();
    } finally {
      handle.stop();
      store.close();
    }
  });

  it("heartbeats a tasks row every browse cycle", () => {
    const store = freshStore();
    const backend = fakeBackend();
    const handle = start(store, backend);
    try {
      vi.advanceTimersByTime(DEFAULT_REQUERY_INTERVAL_MS);
      const task = store.snapshotRows().tasks.find((t) => t.name === "mdnsWatcher");
      expect(task).toMatchObject({ state: "running" });
      expect(task?.heartbeat_at).toBeTypeOf("number");
    } finally {
      handle.stop();
      store.close();
    }
  });
});

describe("mdnsWatcher TTL/interval constants block", () => {
  it("every default is a positive number, and the re-query interval is smaller than every TTL", () => {
    for (const value of [
      DEFAULT_REQUERY_INTERVAL_MS,
      DEFAULT_WIFI_TTL_MS,
      DEFAULT_MBSERIAL_TTL_MS,
      DEFAULT_MBRELAY_TTL_MS,
      DEFAULT_MBFLASH_TTL_MS,
      DEFAULT_RADIO_TTL_MS,
    ]) {
      expect(value).toBeGreaterThan(0);
    }
    // Re-querying less often than a TTL would mean the aging pass could
    // never observe fresh traffic before declaring something stale.
    expect(DEFAULT_REQUERY_INTERVAL_MS).toBeLessThan(DEFAULT_WIFI_TTL_MS);
    expect(DEFAULT_REQUERY_INTERVAL_MS).toBeLessThan(DEFAULT_MBSERIAL_TTL_MS);
    expect(DEFAULT_REQUERY_INTERVAL_MS).toBeLessThan(DEFAULT_MBRELAY_TTL_MS);
    expect(DEFAULT_REQUERY_INTERVAL_MS).toBeLessThan(DEFAULT_MBFLASH_TTL_MS);
    expect(DEFAULT_REQUERY_INTERVAL_MS).toBeLessThan(DEFAULT_RADIO_TTL_MS);
  });
});
