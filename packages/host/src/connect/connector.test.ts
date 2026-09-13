import { describe, expect, it } from "vitest";
import { openStoreDb } from "../store/db.js";
import { Store } from "../store/index.js";
import type { ByteStream } from "../link/LineLink.js";
import { FakeByteStream } from "../link/__fixtures__/FakeByteStream.js";
import { realScheduler, type Scheduler } from "../link/pacing.js";
import { deviceIdToName } from "@robot-console/protocol";
import { createConnector, type ConnectorDeps, type LinkRow } from "./connector.js";

// Sprint 015 ticket 001's own suite: one test per acceptance criterion,
// plus the boot-window retry / reset-between-candidates coverage the
// ticket asks be salvaged from the old registry's own tests. Every
// transport is driven against the shared fake `ByteStream` harness
// (`link/__fixtures__/FakeByteStream.js`) -- no real serial/TCP I/O
// anywhere in this file.
//
// Note on timing: `connectAndIdentify` for a usb/radio/mbrelay link
// (anything with board_owner/relay_leases exclusivity) runs through
// `KeyedMutex.run()`, which always defers its task by one microtask via
// `previous.then(task)` -- even the very first call under a fresh key,
// since `.then()` on an already-resolved promise still yields once. So,
// unlike `LineLink.test.ts`'s own `connectedLink()` helper (which calls
// `stream.resolveOpen()` synchronously right after `connect()`), every
// test below awaits one `flush()` after starting `connectAndIdentify()`
// before touching the stream -- otherwise `resolveOpen()`/`rejectOpen()`
// would run before `LineLink.connect()` (and therefore `stream.open()`)
// has even been called. wifi/mbserial links have no exclusivity and so
// no mutex indirection, but the same `await flush()` first is harmless
// there too and keeps every test's shape uniform.

/** A fresh in-memory, fully-migrated store for one test. */
function freshStore(): Store {
  return new Store(openStoreDb({ filePath: ":memory:" }));
}

/** Seed `link`'s row into the store, exactly as a watcher would before
 * the reconciler ever schedules a connect against it -- `connectAndIdentify`
 * operates on an existing `links` row (the module doc comment, and
 * SUC-001's own precondition: "a `links` row exists in `discovered` or
 * `connectable` state"), so a failure-path test needs the row to
 * already exist for `setLinkState`'s `UPDATE` to have anything to
 * affect. */
function seedLink(store: Store, link: LinkRow): void {
  store.upsertLink({ id: link.id, transport: link.transport, address: link.address, at: 0 });
}

/** Scheduler whose `delay()` resolves on the next microtask -- same
 * convention as `LineLink.test.ts`'s own `immediateScheduler`. Drives
 * the boot-window resend schedule, the relay preamble's write pacing,
 * and `RelayCommandPlane`'s own step timeouts, all instantly. */
const immediateScheduler: Scheduler = { delay: () => Promise.resolve() };

/** The relay-preamble tests below use the real scheduler (`realScheduler`,
 * `setTimeout` honoring `ms`), not `immediateScheduler`. `RelayCommandPlane`'s
 * own per-step wait races a reply (delivered synchronously, inside this
 * suite's scripted `write()` overrides) against `scheduler.delay(timeoutMs)`;
 * with an `immediateScheduler` (every delay resolving after exactly one
 * microtask regardless of `ms`), a *later* preamble step's write --
 * chained behind the *previous* step's own pacing delay in the shared
 * `WritePacer` -- can end up needing one more "instant" hop than a
 * freshly-started "instant" timeout does, so the timeout wins the race
 * even though a reply is always available synchronously. Honoring the
 * real relative magnitudes (a ~10ms pacing gap vs. a ~3000ms step
 * timeout) removes the ambiguity: the scripted reply is always many
 * orders of magnitude faster than its own step's timeout, so it always
 * wins, at the cost of a handful of real (but tiny) milliseconds per
 * test. See `realScheduler`, imported above from `link/pacing.js`.
 *
 * A scheduler whose `delay()` never resolves on its own -- a test
 * drives it deterministically via `resolveAll()`. Mirrors
 * `RelayCommandPlane.test.ts`'s own `controllableScheduler` exactly,
 * needed wherever a test must pause mid-retry to assert on that exact
 * moment (the cancellation test below) rather than let an
 * `immediateScheduler` race every delay to completion before the test
 * gets a chance to act. */
function controllableScheduler(): Scheduler & { resolveAll: () => void } {
  const resolvers: Array<() => void> = [];
  return {
    delay: () =>
      new Promise<void>((resolve) => {
        resolvers.push(resolve);
      }),
    resolveAll: () => {
      const pending = resolvers.splice(0, resolvers.length);
      for (const resolve of pending) {
        resolve();
      }
    },
  };
}

/** Flush pending microtasks so scheduled work has settled before
 * assertions run -- same technique as `LineLink.test.ts`'s own
 * `flush()`. A macrotask boundary drains the whole microtask queue
 * first, however many hops deep. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** `device NEZHA2 robot vevov 1198504156` -- `banner.test.ts`'s own
 * space-form robot fixture; `deviceIdToName(1198504156) === "vevov"`. */
const ROBOT_BANNER = "device NEZHA2 robot vevov 1198504156";
const ROBOT_SERIAL = 1198504156;
/** `DEVICE:RADIOBRIDGE:relay:getez:1779042365` -- `banner.test.ts`'s own
 * colon-form relay fixture; `deviceIdToName(1779042365) === "getez"`. */
const RELAY_BANNER = "DEVICE:RADIOBRIDGE:relay:getez:1779042365";

/** A `FakeByteStream` that answers `HELLO` with `bannerLine` -- the
 * plain (non-relay) transports' own scripted fixture. */
class BannerByteStream extends FakeByteStream {
  constructor(private readonly bannerLine: string | undefined) {
    super();
  }

  override write(bytes: string, callback: (err?: Error | null) => void): void {
    super.write(bytes, callback);
    if (this.bannerLine !== undefined && bytes.startsWith("HELLO")) {
      this.emitData(`${this.bannerLine}\n`);
    }
  }
}

/** A `FakeByteStream` standing in for a relay's own physical port: it
 * answers every command-plane preamble step exactly as relay `vitut`
 * did (per `RelayCommandPlane.ts`'s own captured-reply table), then
 * answers `HELLO` once `!GO` has been confirmed -- proving the data
 * plane really did open only after the full handshake. Answers
 * synchronously, inside `write()` itself, so a reply always settles
 * `RelayCommandPlane`'s own per-step wait before that step's `timeoutMs`
 * (raced via the same `immediateScheduler`) gets a chance to expire it.
 */
class RelayByteStream extends FakeByteStream {
  constructor(private readonly bannerLine: string | undefined) {
    super();
  }

  override write(bytes: string, callback: (err?: Error | null) => void): void {
    super.write(bytes, callback);
    const line = bytes.trim();
    if (line === "?") {
      this.emitData("# channel: 1 group: 1 mode: RAW250 power: 7\n");
    } else if (line === "!ECHO OFF") {
      this.emitData("# echo: OFF\n");
    } else if (line === "!MODE RAW250") {
      this.emitData("# mode: RAW250\n");
    } else if (/^!CG \d+ \d+$/.test(line)) {
      const match = /^!CG (\d+) (\d+)$/.exec(line);
      const channel = match?.[1];
      const group = match?.[2];
      this.emitData(`# channel: ${channel} group: ${group} mode: RAW250 power: 7\n`);
    } else if (line === "!P 7") {
      this.emitData("# channel: 47 group: 60 mode: RAW250 power: 7\n");
    } else if (line === "!GO") {
      this.emitData("# entering data plane\n");
    } else if (this.bannerLine !== undefined && line.startsWith("HELLO")) {
      this.emitData(`${this.bannerLine}\n`);
    }
  }
}

function usbLink(id = "usb-SERIAL1", path = "/dev/cu.usbmodemXYZ"): LinkRow {
  return { id, transport: "usb", address: { path } };
}
function wifiLink(id = "wifi-vevov"): LinkRow {
  return { id, transport: "wifi", address: { host: "10.0.0.5", port: 4000 } };
}
function mbserialLink(id = "mbserial-vevov"): LinkRow {
  return { id, transport: "mbserial", address: { host: "10.0.0.6", port: 4001 } };
}
function radioLink(relayLinkId: string, id = "radio-vevov-via-relay"): LinkRow {
  return { id, transport: "radio", address: { relayLinkId, channel: 47, group: 60 } };
}
function mbrelayLink(relayLinkId: string, id = "mbrelay-vevov-via-relay"): LinkRow {
  return { id, transport: "mbrelay", address: { relayLinkId, channel: 47, group: 60 } };
}

function baseDeps(stream: ByteStream, scheduler: Scheduler = immediateScheduler): ConnectorDeps {
  return {
    createSerialStream: () => stream,
    createTcpStream: () => stream,
    scheduler,
    now: () => 1_000_000,
  };
}

// ---------------------------------------------------------------------
// AC: connectAndIdentify covers all five transports, parameterized only
// by transport/address; success path writes devices/sessions/connected.
// ---------------------------------------------------------------------

describe("connectAndIdentify -- success path, every transport", () => {
  it("usb: writes devices (owned=1), sessions, and links.state=connected", async () => {
    const store = freshStore();
    const stream = new BannerByteStream(ROBOT_BANNER);
    const connector = createConnector(store, baseDeps(stream));
    const link = usbLink();
    seedLink(store, link);

    const promise = connector.connectAndIdentify(link, new AbortController().signal);
    await flush(); // let the mutex-queued attempt reach stream.open()
    stream.resolveOpen();
    const session = await promise;

    expect(session.deviceId).toBe(ROBOT_SERIAL);
    expect(session.transport).toBe("usb");

    const rows = store.snapshotRows();
    const device = rows.devices.find((d) => d.id === ROBOT_SERIAL);
    expect(device?.owned).toBe(1);
    expect(device?.kind).toBe("robot");
    const linkRow = rows.links.find((l) => l.id === link.id);
    expect(linkRow?.state).toBe("connected");
    expect(linkRow?.device_id).toBe(ROBOT_SERIAL);
    const sessionRow = rows.sessions.find((s) => s.link_id === link.id);
    expect(sessionRow).toBeDefined();
    store.close();
  });

  it("wifi: connects directly over tcp, no relay preamble, owned left untouched", async () => {
    const store = freshStore();
    const stream = new BannerByteStream(ROBOT_BANNER);
    const connector = createConnector(store, baseDeps(stream));
    const link = wifiLink();
    seedLink(store, link);

    const promise = connector.connectAndIdentify(link, new AbortController().signal);
    await flush();
    stream.resolveOpen();
    await promise;

    // First write must be HELLO itself -- no relay command-plane lines.
    expect(stream.writes[0]?.bytes.startsWith("HELLO")).toBe(true);
    const device = store.snapshotRows().devices.find((d) => d.id === ROBOT_SERIAL);
    // wifi never sets owned -- only a usb identify does (architecture.md
    // §4: "It is set by the USB watcher's identify and never by any
    // network observation").
    expect(device?.owned).toBe(0);
    store.close();
  });

  it("mbserial: connects directly over tcp, no relay preamble", async () => {
    const store = freshStore();
    const stream = new BannerByteStream(ROBOT_BANNER);
    const connector = createConnector(store, baseDeps(stream));
    const link = mbserialLink();
    seedLink(store, link);

    const promise = connector.connectAndIdentify(link, new AbortController().signal);
    await flush();
    stream.resolveOpen();
    await promise;

    expect(stream.writes[0]?.bytes.startsWith("HELLO")).toBe(true);
    expect(store.snapshotRows().links.find((l) => l.id === link.id)?.state).toBe("connected");
    store.close();
  });

  it("radio: rides a local usb relay, running the RelayCommandPlane preamble before HELLO", async () => {
    const store = freshStore();
    const relayLinkId = "usb-RELAY-SERIAL";
    store.upsertLink({ id: relayLinkId, transport: "usb", address: { path: "/dev/cu.relay" }, at: 1 });

    const stream = new RelayByteStream(ROBOT_BANNER);
    const connector = createConnector(store, baseDeps(stream, realScheduler));
    const link = radioLink(relayLinkId);
    seedLink(store, link);

    const promise = connector.connectAndIdentify(link, new AbortController().signal);
    await flush();
    stream.resolveOpen();
    const session = await promise;

    expect(session.deviceId).toBe(ROBOT_SERIAL);
    const bytesWritten = stream.writes.map((w) => w.bytes.trim());
    // The full handshake ran, in order, before HELLO.
    expect(bytesWritten).toEqual(["?", "!ECHO OFF", "!MODE RAW250", "!CG 47 60", "!P 7", "!GO", "HELLO"]);
    expect(store.snapshotRows().links.find((l) => l.id === link.id)?.state).toBe("connected");
    store.close();
  });

  it("mbrelay: rides a remote tcp relay pool, running the same preamble before HELLO", async () => {
    const store = freshStore();
    const relayLinkId = "mbrelay-POOL";
    store.upsertLink({ id: relayLinkId, transport: "mbrelay", address: { host: "10.0.0.9", port: 5000 }, at: 1 });

    const stream = new RelayByteStream(ROBOT_BANNER);
    const connector = createConnector(store, baseDeps(stream, realScheduler));
    const link = mbrelayLink(relayLinkId);
    seedLink(store, link);

    const promise = connector.connectAndIdentify(link, new AbortController().signal);
    await flush();
    stream.resolveOpen();
    const session = await promise;

    expect(session.deviceId).toBe(ROBOT_SERIAL);
    const bytesWritten = stream.writes.map((w) => w.bytes.trim());
    expect(bytesWritten).toEqual(["?", "!ECHO OFF", "!MODE RAW250", "!CG 47 60", "!P 7", "!GO", "HELLO"]);
    store.close();
  });

  it("a device identified as a relay over usb is never marked owned", async () => {
    const store = freshStore();
    const stream = new BannerByteStream(RELAY_BANNER);
    const connector = createConnector(store, baseDeps(stream));
    const link = usbLink();
    seedLink(store, link);

    const promise = connector.connectAndIdentify(link, new AbortController().signal);
    await flush();
    stream.resolveOpen();
    await promise;

    const device = store.snapshotRows().devices.find((d) => d.kind === "relay");
    expect(device?.owned).toBe(0);
    expect(device?.kind).toBe("relay");
    store.close();
  });
});

// ---------------------------------------------------------------------
// Sprint 015 ticket 003: known-robots placeholder-device merge
// (SUC-003/SUC-004). `importKnownRobots` (sprint 014) seeds a `devices`
// row keyed by a synthetic name-derived id; once the same physical board
// identifies for real over USB, its rows must collapse into one, keyed
// by `usb_serial` -- not `name`, since a legacy naming disagreement can
// (and, on the bench, did) leave the two rows under different names.
// ---------------------------------------------------------------------

describe("connectAndIdentify -- known-robots placeholder-device merge (SUC-003/SUC-004)", () => {
  it("a placeholder seeded under a different name collapses into the real usb-identified row, keyed by usb_serial", async () => {
    const store = freshStore();
    // The bench scenario this ticket's own Description cites verbatim:
    // known-robots.json seeded "vevov" (nameToValue("vevov") === 1031)
    // against usb_serial "SERIAL1"; the real board on that same USB
    // serial identifies over HELLO as chip id 536019796, whose name is
    // the *different* "vevav" -- exactly why this merge keys on
    // usb_serial, never name.
    store.upsertDevice({ id: 1031, name: "vevov", kind: "robot", usbSerial: "SERIAL1", at: 100 });
    store.setOwned(1031, true, 100);

    const stream = new BannerByteStream("device NEZHA2 robot vevav 536019796");
    const connector = createConnector(store, baseDeps(stream));
    const link = usbLink(); // id "usb-SERIAL1" -- see usbLink()'s own default
    seedLink(store, link);

    const promise = connector.connectAndIdentify(link, new AbortController().signal);
    await flush();
    stream.resolveOpen();
    const session = await promise;

    expect(session.deviceId).toBe(536019796);
    const rows = store.snapshotRows();
    expect(rows.devices).toHaveLength(1);
    expect(rows.devices[0]).toMatchObject({ id: 536019796, name: "vevav", owned: 1, usb_serial: "SERIAL1" });
    expect(rows.links.find((l) => l.id === link.id)?.device_id).toBe(536019796);
    store.close();
  });

  it("never merges across a different usb_serial, even when the name happens to match", async () => {
    const store = freshStore();
    // id 4156 (not 1031 = nameToValue("vevov")) -- congruent to 1031 mod
    // 3125, so `deviceIdToName(4156) === "vevov"` still holds (a legal
    // "vevov"-named row), but it is deliberately *not* the name's own
    // synthetic placeholder id, so this row is scoped to testing
    // `mergeUsbPlaceholderIfAny` in isolation -- `mergeNamePlaceholderIfAny`
    // (a separate, additive merge; see its own tests below) only ever
    // matches a row at exactly `nameToValue(name)`, never a merely
    // same-named congruent id, so it is not a candidate here either.
    store.upsertDevice({ id: 4156, name: "vevov", kind: "robot", usbSerial: "OTHER-SERIAL", at: 100 });

    const stream = new BannerByteStream(ROBOT_BANNER); // decodes to "vevov"/1198504156
    const connector = createConnector(store, baseDeps(stream));
    const link = usbLink(); // id "usb-SERIAL1" -- a different usb_serial
    seedLink(store, link);

    const promise = connector.connectAndIdentify(link, new AbortController().signal);
    await flush();
    stream.resolveOpen();
    await promise;

    // Both rows survive -- the placeholder's usb_serial never matched,
    // even though its name coincides with the newly-identified device.
    expect(store.snapshotRows().devices).toHaveLength(2);
    store.close();
  });

  it("is a no-op for a non-usb identify, even if a placeholder shares that device's own usb_serial", async () => {
    const store = freshStore();
    // Same non-synthetic-id choice as the test above, and for the same
    // reason -- see its own comment.
    store.upsertDevice({ id: 4156, name: "vevov", kind: "robot", usbSerial: "SERIAL1", at: 100 });

    const stream = new BannerByteStream(ROBOT_BANNER);
    const connector = createConnector(store, baseDeps(stream));
    const link = wifiLink();
    seedLink(store, link);

    const promise = connector.connectAndIdentify(link, new AbortController().signal);
    await flush();
    stream.resolveOpen();
    await promise;

    // wifi never computes a usb_serial to correlate against, and this
    // placeholder is not at its name's synthetic id either -- untouched
    // by either merge path.
    expect(store.snapshotRows().devices).toHaveLength(2);
    store.close();
  });
});

// ---------------------------------------------------------------------
// Sprint 017 ticket 006: generalizes the merge above to any transport's
// first identification (SUC-006; issue
// `placeholder-merge-for-non-usb-transports.md`). A robot first
// identified over `mbserial`/`wifi` has no USB serial to correlate
// against at all -- the bench-observed `gopiv` case (placeholder
// 1461, `nameToValue("gopiv")`, vs. real chip id 2175407711, sprint 016
// ticket 008) never merged before this ticket.
// ---------------------------------------------------------------------

describe("connectAndIdentify -- generalized known-robots placeholder merge, any transport (ticket 017-006, SUC-006)", () => {
  /** `device NEZHA2 robot gopiv 2175407711` -- `deviceIdToName(2175407711)
   * === "gopiv"`, the real bench chip id from sprint 016 ticket 008. The
   * banner's own literal `name` token is never read by the connector
   * (it always recomputes `name` from `deviceIdToName(banner.serial)` --
   * see connector.ts line ~731), so this is for readability only. */
  const GOPIV_BANNER = "device NEZHA2 robot gopiv 2175407711";
  const GOPIV_REAL_ID = 2175407711;
  /** `nameToValue("gopiv")` -- the synthetic placeholder id
   * `importKnownRobots` would have minted, matching the bench evidence's
   * own "placeholder 1461 vs. real 2175407711". */
  const GOPIV_PLACEHOLDER_ID = 1461;

  /** Seeds a known-robots-style placeholder: synthetic id
   * (`nameToValue("gopiv")`), `owned = 1` -- exactly the shape this
   * ticket's merge targets. `usbSerial` is left to each test to set (or
   * not) explicitly -- bench defect 2 (2026-09-12) was specifically that
   * a placeholder *with* a `usb_serial` (the common, real-import case)
   * never merged, so both shapes need their own coverage below rather
   * than one fixture silently picking one. */
  function seedGopivPlaceholder(store: Store, usbSerial?: string): void {
    store.upsertDevice({ id: GOPIV_PLACEHOLDER_ID, name: "gopiv", kind: "robot", ...(usbSerial !== undefined ? { usbSerial } : {}), at: 100 });
    store.setOwned(GOPIV_PLACEHOLDER_ID, true, 100);
  }

  it.each([
    ["usb", () => usbLink()] as const,
    ["mbserial", () => mbserialLink()] as const,
    ["wifi", () => wifiLink()] as const,
  ])("%s: merges the placeholder sharing the identified robot's synthetic id (no usb_serial)", async (_transport, buildLink) => {
    const store = freshStore();
    seedGopivPlaceholder(store);

    const stream = new BannerByteStream(GOPIV_BANNER);
    const connector = createConnector(store, baseDeps(stream));
    const link = buildLink();
    seedLink(store, link);

    const promise = connector.connectAndIdentify(link, new AbortController().signal);
    await flush();
    stream.resolveOpen();
    const session = await promise;

    expect(session.deviceId).toBe(GOPIV_REAL_ID);
    const rows = store.snapshotRows();
    // One row, not two -- no orphaned placeholder, no orphaned links.
    expect(rows.devices).toHaveLength(1);
    expect(rows.devices[0]).toMatchObject({ id: GOPIV_REAL_ID, name: "gopiv", owned: 1 });
    expect(rows.links.find((l) => l.id === link.id)?.device_id).toBe(GOPIV_REAL_ID);
    store.close();
  });

  it(
    "bench defect 2 (2026-09-12): merges a placeholder that DOES carry a usb_serial, mirroring a real known-robots.json import -- the original usb_serial IS NULL filter never matched this shape",
    async () => {
      const store = freshStore();
      // `store/importers/knownRobots.ts` writes the JSON's own
      // `lastUsbSerial` into every imported placeholder unconditionally
      // (it is a required field on `KnownRobotRecord`, not optional) --
      // so a real placeholder almost always carries a usb_serial. This
      // is the live bench shape (gopiv 1461, owned=1, imported) that
      // never merged with the real row (2175407711) before this fix.
      seedGopivPlaceholder(store, "0099887766");

      const stream = new BannerByteStream(GOPIV_BANNER);
      const connector = createConnector(store, baseDeps(stream));
      const link = mbserialLink();
      seedLink(store, link);

      const promise = connector.connectAndIdentify(link, new AbortController().signal);
      await flush();
      stream.resolveOpen();
      const session = await promise;

      expect(session.deviceId).toBe(GOPIV_REAL_ID);
      const rows = store.snapshotRows();
      expect(rows.devices).toHaveLength(1);
      expect(rows.devices[0]).toMatchObject({ id: GOPIV_REAL_ID, name: "gopiv", owned: 1, usb_serial: "0099887766" });
      store.close();
    },
  );

  it("a name mismatch (vevov/vevav-style) is a no-op -- both rows remain", async () => {
    const store = freshStore();
    seedGopivPlaceholder(store);

    // Identifies as "vevov" (ROBOT_SERIAL), not "gopiv" -- names differ,
    // so no merge, even though this placeholder is otherwise mergeable
    // (no usb_serial, kind='robot').
    const stream = new BannerByteStream(ROBOT_BANNER);
    const connector = createConnector(store, baseDeps(stream));
    const link = wifiLink();
    seedLink(store, link);

    const promise = connector.connectAndIdentify(link, new AbortController().signal);
    await flush();
    stream.resolveOpen();
    await promise;

    expect(store.snapshotRows().devices).toHaveLength(2);
    store.close();
  });

  it(
    "bench defect 2 fix: two ROBOT rows sharing the identified robot's name where NEITHER has id === nameToValue(name) is a no-op -- no guessed merge",
    async () => {
      const store = freshStore();
      // Neither row is "the" placeholder by construction (id ===
      // nameToValue("gopiv") === 1461) -- both merely decode to the same
      // name (any id congruent to 1461 mod 3125 does), the real
      // `architecture.md` §4 collision case this function still declines
      // to guess at. This replaces the old "two placeholders, both
      // usb_serial IS NULL" ambiguity case, which cannot arise any more
      // now that a placeholder is identified by its own unique id, not a
      // shared-name query that could ever return more than one row.
      store.upsertDevice({ id: 4586, name: "gopiv", kind: "robot", at: 100 });
      store.upsertDevice({ id: 7711, name: "gopiv", kind: "robot", at: 100 });

      const stream = new BannerByteStream(GOPIV_BANNER);
      const connector = createConnector(store, baseDeps(stream));
      const link = wifiLink();
      seedLink(store, link);

      const promise = connector.connectAndIdentify(link, new AbortController().signal);
      await flush();
      stream.resolveOpen();
      await promise;

      // All three rows survive: neither same-name row was touched, and
      // the real identify wrote its own row.
      expect(store.snapshotRows().devices).toHaveLength(3);
      store.close();
    },
  );

  it("a kind='relay' row that happens to share the placeholder's own synthetic id is never treated as a candidate", async () => {
    const store = freshStore();
    // `watchers/mdnsWatcher.ts`'s `createRelayDeviceIfAbsent` mints a
    // well-formed relay name's id the *same* way a robot placeholder's
    // id is minted -- `nameToValue(name)` -- so this collision is a real
    // one to guard against, not a hypothetical: a relay row can
    // legitimately sit at exactly `GOPIV_PLACEHOLDER_ID`. Must never be
    // picked up by the placeholder lookup, which is scoped to
    // `kind === 'robot'`.
    store.upsertDevice({ id: GOPIV_PLACEHOLDER_ID, name: "gopiv", kind: "relay", at: 100 });

    const stream = new BannerByteStream(GOPIV_BANNER);
    const connector = createConnector(store, baseDeps(stream));
    const link = wifiLink();
    seedLink(store, link);

    const promise = connector.connectAndIdentify(link, new AbortController().signal);
    await flush();
    stream.resolveOpen();
    await promise;

    // Both rows survive -- the relay row was never a mergeable candidate.
    const rows = store.snapshotRows();
    expect(rows.devices).toHaveLength(2);
    expect(rows.devices.find((d) => d.id === GOPIV_PLACEHOLDER_ID)).toMatchObject({ kind: "relay", name: "gopiv" });
    expect(rows.devices.find((d) => d.id === GOPIV_REAL_ID)).toMatchObject({ kind: "robot", name: "gopiv" });
    store.close();
  });
});

// ---------------------------------------------------------------------
// AC: failure path writes failed with next_retry_at/fail_count and
// releases the owner/lease.
// ---------------------------------------------------------------------

describe("connectAndIdentify -- failure path", () => {
  it("a transport-level connect() failure marks the link failed with backoff and releases the board_owner", async () => {
    const store = freshStore();
    const stream = new FakeByteStream();
    const connector = createConnector(store, baseDeps(stream));
    const link = usbLink();
    seedLink(store, link);

    const promise = connector.connectAndIdentify(link, new AbortController().signal);
    await flush();
    stream.rejectOpen(new Error("ENOENT: no such device"));
    await expect(promise).rejects.toThrow(/ENOENT/);

    const linkRow = store.snapshotRows().links.find((l) => l.id === link.id);
    expect(linkRow?.state).toBe("failed");
    expect(linkRow?.fail_count).toBe(1);
    expect(typeof linkRow?.next_retry_at).toBe("number");
    expect(Number(linkRow?.next_retry_at)).toBeGreaterThan(0);

    // The board_owner this attempt acquired was released -- a fresh
    // claim under a different owner now succeeds.
    expect(store.acquireBoardOwner("SERIAL1", "someone-else", 2)).toBe(true);
    store.close();
  });

  it("increments fail_count and grows next_retry_at across repeated failed attempts on the same link", async () => {
    const store = freshStore();
    const link = usbLink();
    seedLink(store, link);

    // A fresh connector/stream per attempt -- a `LineLink` connects at
    // most once (see the module doc comment's "one attempt" note), so
    // each simulated retry gets its own stream, exactly as the
    // reconciler (ticket 002) would call the connector again later.
    const stream1 = new FakeByteStream();
    const connector1 = createConnector(store, baseDeps(stream1));
    const attempt1 = connector1.connectAndIdentify(link, new AbortController().signal);
    await flush();
    stream1.rejectOpen(new Error("boom 1"));
    await expect(attempt1).rejects.toThrow();
    const afterFirst = store.snapshotRows().links.find((l) => l.id === link.id);
    expect(afterFirst?.fail_count).toBe(1);

    const stream2 = new FakeByteStream();
    const connector2 = createConnector(store, baseDeps(stream2));
    const attempt2 = connector2.connectAndIdentify(link, new AbortController().signal);
    await flush();
    stream2.rejectOpen(new Error("boom 2"));
    await expect(attempt2).rejects.toThrow();
    const afterSecond = store.snapshotRows().links.find((l) => l.id === link.id);
    expect(afterSecond?.fail_count).toBe(2);
    expect(Number(afterSecond?.next_retry_at)).toBeGreaterThan(Number(afterFirst?.next_retry_at));
    store.close();
  });

  it("an already-held board_owner fails the attempt without disturbing the existing owner", async () => {
    const store = freshStore();
    const link = usbLink("usb-HELD-SERIAL");
    seedLink(store, link);
    store.acquireBoardOwner("HELD-SERIAL", "someone-else", 1);

    const stream = new FakeByteStream();
    const connector = createConnector(store, baseDeps(stream));
    await expect(connector.connectAndIdentify(link, new AbortController().signal)).rejects.toThrow(/could not acquire/i);

    // Never opened the transport at all.
    expect(stream.openCallCount).toBe(0);
    const linkRow = store.snapshotRows().links.find((l) => l.id === link.id);
    expect(linkRow?.state).toBe("failed");
    // The pre-existing owner is untouched -- this attempt never
    // acquired it, so it must never release it either.
    expect(store.releaseBoardOwner("HELD-SERIAL", "someone-else")).toBe(true);
    store.close();
  });

  it("a closed stream during identify yields failed, never a thrown or unhandled rejection", async () => {
    const store = freshStore();
    const stream = new FakeByteStream(); // never answers HELLO
    const connector = createConnector(store, baseDeps(stream), { identifyBudgetMs: 50 });
    const link = usbLink();
    seedLink(store, link);

    const promise = connector.connectAndIdentify(link, new AbortController().signal);
    await flush();
    stream.resolveOpen();
    await flush();
    // Identify is now pending on a banner that will never arrive --
    // simulate the underlying transport dropping.
    stream.emitClose();

    await expect(promise).rejects.toThrow(/no banner/i);
    const linkRow = store.snapshotRows().links.find((l) => l.id === link.id);
    expect(linkRow?.state).toBe("failed");
    store.close();
  });

  // -------------------------------------------------------------------
  // Item E (team-lead, 2026-09-13): bench defect -- a bad USB
  // cable/connector produced a corrupted serial banner that got upserted
  // as a brand-new device with owned=true and no cross-check at all
  // (`zapuz`/`tigez`/`tovez` were all the same physical board, one flaky
  // cable). Both a self-inconsistent banner and a banner disagreeing
  // with a link's own SWD-named deviceId must fail closed instead.
  // -------------------------------------------------------------------

  it("rejects a banner whose own name disagrees with its own serial (protocol bannerNameMatchesSerial) -- no device upserted, link failed with the cable reason", async () => {
    const store = freshStore();
    // deviceIdToName(1198504156) === "vevov" (see ROBOT_BANNER's own
    // comment above) -- "notreal" is deliberately a different name for
    // the same serial, exactly the self-inconsistency
    // `bannerNameMatchesSerial` exists to catch.
    const stream = new BannerByteStream("device NEZHA2 robot notreal 1198504156");
    const connector = createConnector(store, baseDeps(stream));
    const link = usbLink();
    seedLink(store, link);

    const promise = connector.connectAndIdentify(link, new AbortController().signal);
    await flush();
    stream.resolveOpen();
    await expect(promise).rejects.toThrow(/does not match its own serial.*check the USB cable/i);

    const rows = store.snapshotRows();
    expect(rows.devices.find((d) => d.id === ROBOT_SERIAL)).toBeUndefined();
    const linkRow = rows.links.find((l) => l.id === link.id);
    expect(linkRow?.state).toBe("failed");
    expect(linkRow?.state_reason).toMatch(/does not match its own serial/);
    store.close();
  });

  it("a usb link already carrying a deviceId from SWD naming rejects a banner reporting a different serial -- no device upsert, owned never set, link failed with the cable reason", async () => {
    const store = freshStore();
    const SWD_DEVICE_ID = 2665; // deviceIdToName(2665) === "tovez" -- any id distinct from ROBOT_SERIAL
    const swdName = deviceIdToName(SWD_DEVICE_ID);
    const link = usbLink();
    // Seed exactly what `watchers/usbWatcher.ts`'s SWD naming pass would
    // have already written before the connector ever sees this link.
    store.upsertDevice({ id: SWD_DEVICE_ID, name: swdName, kind: "robot", at: 0 });
    store.upsertLink({ id: link.id, transport: link.transport, address: link.address, deviceId: SWD_DEVICE_ID, at: 0 });

    // The banner read over the (flaky) serial connection reports a
    // DIFFERENT board entirely -- ROBOT_SERIAL/"vevov", not SWD_DEVICE_ID.
    const stream = new BannerByteStream(ROBOT_BANNER);
    const connector = createConnector(store, baseDeps(stream));
    const linkWithDeviceId: LinkRow = { ...link, deviceId: SWD_DEVICE_ID };

    const promise = connector.connectAndIdentify(linkWithDeviceId, new AbortController().signal);
    await flush();
    stream.resolveOpen();
    await expect(promise).rejects.toThrow(/banner identity vevov disagrees with SWD name tovez.*check the USB cable/i);

    const rows = store.snapshotRows();
    // No new device row for the banner's own (corrupted) serial.
    expect(rows.devices.find((d) => d.id === ROBOT_SERIAL)).toBeUndefined();
    // The SWD-named device is untouched -- never marked owned by this
    // rejected attempt.
    const swdDevice = rows.devices.find((d) => d.id === SWD_DEVICE_ID);
    expect(swdDevice?.owned).toBe(0);
    const linkRow = rows.links.find((l) => l.id === link.id);
    expect(linkRow?.state).toBe("failed");
    expect(linkRow?.state_reason).toMatch(/banner identity vevov disagrees with SWD name tovez/);
    store.close();
  });

  it("a usb link with a matching SWD deviceId (the ordinary case) still connects normally -- the cross-check is not a false positive", async () => {
    const store = freshStore();
    const link = usbLink();
    store.upsertDevice({ id: ROBOT_SERIAL, name: deviceIdToName(ROBOT_SERIAL), kind: "robot", at: 0 });
    store.upsertLink({ id: link.id, transport: link.transport, address: link.address, deviceId: ROBOT_SERIAL, at: 0 });

    const stream = new BannerByteStream(ROBOT_BANNER); // banner.serial === ROBOT_SERIAL -- agrees
    const connector = createConnector(store, baseDeps(stream));
    const linkWithDeviceId: LinkRow = { ...link, deviceId: ROBOT_SERIAL };

    const promise = connector.connectAndIdentify(linkWithDeviceId, new AbortController().signal);
    await flush();
    stream.resolveOpen();
    const session = await promise;

    expect(session.deviceId).toBe(ROBOT_SERIAL);
    const linkRow = store.snapshotRows().links.find((l) => l.id === link.id);
    expect(linkRow?.state).toBe("connected");
    store.close();
  });
});

// ---------------------------------------------------------------------
// AC: cancellation mid-HELLO releases the owner/lease and leaves no
// listeners on the fake stream.
// ---------------------------------------------------------------------

describe("connectAndIdentify -- cancellation", () => {
  it("cancellation mid-HELLO closes the stream, releases the board_owner, and stops writing", async () => {
    const store = freshStore();
    const stream = new FakeByteStream();
    const scheduler = controllableScheduler();
    const connector = createConnector(store, baseDeps(stream, scheduler));
    const link = usbLink();
    seedLink(store, link);

    const controller = new AbortController();
    const promise = connector.connectAndIdentify(link, controller.signal);
    await flush(); // let the mutex-queued attempt reach stream.open()
    stream.resolveOpen();
    await flush(); // connect() resolves; identify() sends the first HELLO and
    // arms its boot-window resend loop, now parked on `scheduler.delay()`
    // (which never resolves on its own -- see `controllableScheduler`).

    const writesBeforeAbort = stream.writes.length;
    expect(writesBeforeAbort).toBeGreaterThanOrEqual(1); // the initial HELLO

    controller.abort(new Error("cancelled by test"));
    await expect(promise).rejects.toThrow(/cancelled by test/);

    // The link was closed (no dangling open transport) ...
    expect(stream.closeCallCount).toBeGreaterThanOrEqual(1);
    // ... and the board_owner this attempt held was released.
    expect(store.acquireBoardOwner("SERIAL1", "someone-else", 2)).toBe(true);

    // Nothing further gets written even if the (never-resolving)
    // resend-loop delay were somehow released after the fact.
    scheduler.resolveAll();
    await flush();
    expect(stream.writes.length).toBe(writesBeforeAbort);
    store.close();
  });
});

// ---------------------------------------------------------------------
// AC: relay/mbrelay run the RelayCommandPlane preamble before HELLO;
// usb/wifi/mbserial do not (covered per-transport above; this section
// asserts the negative directly for clarity).
// ---------------------------------------------------------------------

describe("connectAndIdentify -- preamble gating", () => {
  it("usb never sends any relay command-plane line", async () => {
    const store = freshStore();
    const stream = new BannerByteStream(ROBOT_BANNER);
    const connector = createConnector(store, baseDeps(stream));
    const link = usbLink();
    seedLink(store, link);

    const promise = connector.connectAndIdentify(link, new AbortController().signal);
    await flush();
    stream.resolveOpen();
    await promise;
    expect(stream.writes.some((w) => w.bytes.startsWith("!"))).toBe(false);
    store.close();
  });
});
