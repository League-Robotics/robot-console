import { EventEmitter } from "node:events";
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
  const backend: MdnsBackend & {
    relay: typeof relay;
    serial: typeof serial;
    flash: typeof flash;
    robotlinkTcp: typeof robotlinkTcp;
    robotlinkUdp: typeof robotlinkUdp;
    findCalls: MdnsFindOptions[];
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
    destroy: vi.fn(),
  };
  return backend;
}

function wifiService(name: string, host: string, port: number): MdnsService {
  return { name: `${name} robot link`, host, port, txt: { name, role: "robot", link: "v6" }, fqdn: `${name}.local` };
}

function mbserialService(name: string, host: string, port: number): MdnsService {
  return { name, host, port, fqdn: `${name}.local` };
}

function mbrelayService(name: string, host: string, port: number, registryPort: number): MdnsService {
  return { name, host, port, txt: { registry: String(registryPort) }, fqdn: `${name}.local` };
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

  it(
    "advancing the fake clock past each TTL with no further traffic ages links(wifi|mbserial|mbrelay) stale and deletes their services rows",
    () => {
      const store = freshStore();
      const backend = fakeBackend();
      const handle = start(store, backend);
      try {
        backend.robotlinkTcp.emitUp(wifiService("eeeee", "eeeee.local", 7654));
        backend.serial.emitUp(mbserialService("fffff", "fffff.local", 9000));
        // "gopoz" -- a well-formed five-letter name (ticket 016-005's
        // device-creation fallback now calls `nameToValue` on every
        // mbrelay instance name, which throws on a malformed one; a
        // real mbrelay pool's own mDNS instance name is always
        // well-formed, being generated by the same CODAL naming scheme
        // -- see naming.ts's own doc comment).
        backend.relay.emitUp(mbrelayService("gopoz", "gopoz.local", 8760, 8761));
        backend.flash.emitUp(mbflashService("hhhhh", "hhhhh.local", 8000));

        const before = store.snapshotRows();
        expect(before.links).toHaveLength(3);
        expect(before.services).toHaveLength(4);

        // Past every TTL, no further traffic. Fake timers replay every
        // elapsed interval tick, so the aging pass below runs several
        // times as the clock advances.
        vi.advanceTimersByTime(DEFAULT_WIFI_TTL_MS + DEFAULT_REQUERY_INTERVAL_MS);

        const after = store.snapshotRows();
        expect(after.links.filter((l) => l.state === "stale")).toHaveLength(3);
        expect(after.services).toHaveLength(0);
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

  it(
    "creates a synthetic devices(kind='relay') row when no existing relay device matches the mDNS instance name (ticket 016-005)",
    () => {
      const store = freshStore();
      const backend = fakeBackend();
      const handle = start(store, backend);
      try {
        // "tovez" -- naming.ts's own worked example (a well-formed
        // five-letter name; nameToValue() rejects anything else).
        backend.relay.emitUp(mbrelayService("tovez", "tovez.local", 8760, 8761));

        const rows = store.snapshotRows();
        const link = rows.links.find((l) => l.id === "mbrelay-tovez");
        expect(link).toBeDefined();
        expect(link?.device_id).not.toBeNull();

        const syntheticId = Number(link?.device_id);
        const device = rows.devices.find((d) => d.id === syntheticId);
        expect(device).toMatchObject({ name: "tovez", kind: "relay" });
      } finally {
        handle.stop();
        store.close();
      }
    },
  );

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
    ]) {
      expect(value).toBeGreaterThan(0);
    }
    // Re-querying less often than a TTL would mean the aging pass could
    // never observe fresh traffic before declaring something stale.
    expect(DEFAULT_REQUERY_INTERVAL_MS).toBeLessThan(DEFAULT_WIFI_TTL_MS);
    expect(DEFAULT_REQUERY_INTERVAL_MS).toBeLessThan(DEFAULT_MBSERIAL_TTL_MS);
    expect(DEFAULT_REQUERY_INTERVAL_MS).toBeLessThan(DEFAULT_MBRELAY_TTL_MS);
    expect(DEFAULT_REQUERY_INTERVAL_MS).toBeLessThan(DEFAULT_MBFLASH_TTL_MS);
  });
});
