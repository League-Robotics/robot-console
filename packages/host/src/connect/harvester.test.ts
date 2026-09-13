import { describe, expect, it, vi } from "vitest";
import { openStoreDb } from "../store/db.js";
import { Store } from "../store/index.js";
import { LineLink } from "../link/LineLink.js";
import { FakeByteStream } from "../link/__fixtures__/FakeByteStream.js";
import type { ConnectedSession } from "./connector.js";
import { createHarvester, type HarvesterTelemetryEvent } from "./harvester.js";

// Sprint 015 ticket 003's own suite: one test per acceptance criterion
// (status/funcs/thdr+t update the store or the telemetry sink; stream
// close and the missed-poll watchdog each mark `unresponsive` exactly
// once), plus the resync-notice coverage salvaged from the old
// registry's own `reportDesyncIfNeeded` tests. No real serial/TCP I/O --
// every raw line is pushed straight through a `FakeByteStream`.

/** A fresh in-memory, fully-migrated store, with `link-1`/`device-1`
 * already wired up as a connected USB session -- the shape
 * `connect/connector.ts` itself would have already written by the time
 * `HarvesterAttach.attach()` is ever called. */
function seededStore(): Store {
  const store = new Store(openStoreDb({ filePath: ":memory:" }));
  store.upsertDevice({ id: 1198504156, name: "vevov", kind: "robot", at: 0 });
  store.upsertLink({ id: "link-1", transport: "usb", address: { path: "/dev/x" }, deviceId: 1198504156, at: 0 });
  store.openSession("link-1", 0);
  return store;
}

/** A connected `LineLink` over a fresh `FakeByteStream`, resolved past
 * `connect()` -- mirrors `connector.test.ts`'s own `flush()`-then-
 * `resolveOpen()` two-step, needed because `LineLink.connect()` awaits
 * `stream.open()` before attaching its own data listeners. */
async function connectedLink(): Promise<{ link: LineLink; stream: FakeByteStream }> {
  const stream = new FakeByteStream();
  const link = new LineLink(stream, { connectTimeoutMs: 5000 });
  const promise = link.connect({});
  await new Promise((resolve) => setTimeout(resolve, 0));
  stream.resolveOpen();
  await promise;
  return { link, stream };
}

function session(link: LineLink, overrides: Partial<ConnectedSession> = {}): ConnectedSession {
  return {
    linkId: "link-1",
    deviceId: 1198504156,
    transport: "usb",
    link,
    classification: { type: "robot", role: "NEZHA2", commonName: null, dialect: "space", evidence: "common-name", program: null, version: null },
    ...overrides,
  } as ConnectedSession;
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("createHarvester -- status/funcs/thdr+t", () => {
  it("status updates sessions.robot_status and resets the poll-miss counter", async () => {
    const store = seededStore();
    const { link, stream } = await connectedLink();
    const harvester = createHarvester(store, { statusPollIntervalMs: 0 });
    harvester.attach(session(link));

    stream.emitData("status flags=01 active=1\n");
    await flush();

    const row = store.snapshotRows().sessions.find((s) => s.link_id === "link-1");
    expect(row?.robot_status).toBeTruthy();
    const parsed = JSON.parse(row?.robot_status as string) as { ready: boolean; active: boolean };
    expect(parsed.ready).toBe(true);
    expect(parsed.active).toBe(true);
    store.close();
  });

  it("estop flips robotStatus.estopped immediately, ahead of the next status poll", async () => {
    const store = seededStore();
    const { link, stream } = await connectedLink();
    const harvester = createHarvester(store, { statusPollIntervalMs: 0 });
    harvester.attach(session(link));

    stream.emitData("estop\n");
    await flush();

    const row = store.snapshotRows().sessions.find((s) => s.link_id === "link-1");
    const parsed = JSON.parse(row?.robot_status as string) as { estopped: boolean };
    expect(parsed.estopped).toBe(true);
    store.close();
  });

  it("funcs accumulates RobotFunction entries onto sessions.functions", async () => {
    const store = seededStore();
    const { link, stream } = await connectedLink();
    const harvester = createHarvester(store, { statusPollIntervalMs: 0 });
    harvester.attach(session(link));

    stream.emitData("funcs drive x y\n");
    stream.emitData("funcs stop\n");
    await flush();

    const row = store.snapshotRows().sessions.find((s) => s.link_id === "link-1");
    const functions = JSON.parse(row?.functions as string) as Array<{ name: string; signature?: string }>;
    expect(functions).toEqual([{ name: "drive", signature: "x y" }, { name: "stop" }]);
    store.close();
  });

  it("thdr/t forward to the telemetry sink and never touch the sessions row", async () => {
    const store = seededStore();
    const { link, stream } = await connectedLink();
    const events: Array<[string, HarvesterTelemetryEvent]> = [];
    const harvester = createHarvester(store, {
      statusPollIntervalMs: 0,
      onTelemetry: (linkId, event) => events.push([linkId, event]),
    });
    harvester.attach(session(link));

    stream.emitData("thdr ox oy oh\n");
    stream.emitData("t 1 2 3\n");
    await flush();

    expect(events).toEqual([
      ["link-1", { header: ["ox", "oy", "oh"] }],
      ["link-1", { frame: { ox: "1", oy: "2", oh: "3" } }],
    ]);
    const row = store.snapshotRows().sessions.find((s) => s.link_id === "link-1");
    expect(row?.robot_status).toBeNull();
    expect(row?.functions).toBeNull();
    store.close();
  });

  it("a t line with no header held yet is dropped silently -- no telemetry event, no crash", async () => {
    const store = seededStore();
    const { link, stream } = await connectedLink();
    const onTelemetry = vi.fn();
    const harvester = createHarvester(store, { statusPollIntervalMs: 0, onTelemetry });
    harvester.attach(session(link));

    stream.emitData("t 1 2 3\n");
    await flush();

    expect(onTelemetry).not.toHaveBeenCalled();
    store.close();
  });
});

describe("createHarvester -- unresponsive, exactly once", () => {
  it("the underlying link closing marks the link unresponsive exactly once and stops polling", async () => {
    const store = seededStore();
    const setLinkState = vi.spyOn(store, "setLinkState");
    const { link, stream } = await connectedLink();
    const harvester = createHarvester(store, { statusPollIntervalMs: 5 });
    harvester.attach(session(link));

    stream.emitClose();
    await flush();
    await new Promise((resolve) => setTimeout(resolve, 20));

    const unresponsiveCalls = setLinkState.mock.calls.filter(([input]) => input.state === "unresponsive");
    expect(unresponsiveCalls).toHaveLength(1);
    expect(store.snapshotRows().links.find((l) => l.id === "link-1")?.state).toBe("unresponsive");
    store.close();
  });

  it("three missed STATUS polls (a usb link, not just wifi) marks unresponsive exactly once and stops polling", async () => {
    const store = seededStore();
    const setLinkState = vi.spyOn(store, "setLinkState");
    const { link } = await connectedLink(); // never answers STATUS
    const harvester = createHarvester(store, { statusPollIntervalMs: 5, missedPollLimit: 3 });
    harvester.attach(session(link));

    await new Promise((resolve) => setTimeout(resolve, 120));

    const unresponsiveCalls = setLinkState.mock.calls.filter(([input]) => input.state === "unresponsive");
    expect(unresponsiveCalls).toHaveLength(1);
    expect(store.snapshotRows().links.find((l) => l.id === "link-1")?.state).toBe("unresponsive");
    store.close();
  });

  it(
    "bench defect 010 addendum (2026-09-13): a missed-poll-detected death also closes the LineLink itself, " +
      "not just the store row -- so connect/reconciler.ts's own onClose-based session teardown still runs " +
      "even though the transport never closed on its own",
    async () => {
      const store = seededStore();
      const { link, stream } = await connectedLink(); // never answers STATUS
      let closed: Error | undefined;
      let closeFired = false;
      link.onClose((reason) => {
        closeFired = true;
        closed = reason;
      });
      const harvester = createHarvester(store, { statusPollIntervalMs: 5, missedPollLimit: 3 });
      harvester.attach(session(link));

      await new Promise((resolve) => setTimeout(resolve, 120));

      // The watchdog branch alone never touches the transport (module
      // doc comment, pre-fix) -- confirming this ticket's own fix: `fail()`
      // now also closes it, so `stream.close()` was actually called and
      // the link's own `onClose` (the seam `connect/reconciler.ts` reacts
      // to) fired, with no separate transport-level close/error needed.
      expect(stream.closeCallCount).toBeGreaterThanOrEqual(1);
      expect(link.isOpen).toBe(false);
      expect(closeFired).toBe(true);
      expect(closed).toBeUndefined(); // no ByteStream "error" was ever emitted
      store.close();
    },
  );
});

describe("createHarvester -- resync notice (reportDesyncIfNeeded)", () => {
  it("a desynced nack reports once per episode, not once per send", async () => {
    const store = seededStore();
    const { link, stream } = await connectedLink();
    const notices: string[] = [];
    const harvester = createHarvester(store, { statusPollIntervalMs: 0, onNotice: (_id, message) => notices.push(message) });
    harvester.attach(session(link));

    link.sendCommand("WHEELS_V", [100, 100, 1000]); // #1
    stream.emitData("ack 1 0 none\n");
    link.sendCommand("WHEELS_V", [100, 100, 1000]); // #2
    link.sendCommand("WHEELS_V", [100, 100, 1000]); // #3
    await flush();

    // The robot's own sequence reset below everything pending -- a
    // desync, not a lost frame (protocol's own `AckNackEvent.desynced`).
    stream.emitData("nack 1 0 none\n");
    await flush();
    // A second identical nack in the same episode must not re-notify.
    stream.emitData("nack 1 0 none\n");
    await flush();

    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("resynced automatically");
    store.close();
  });

  it("classification other than robot never sends ID or polls STATUS", async () => {
    const store = seededStore();
    const { link, stream } = await connectedLink();
    const harvester = createHarvester(store, { statusPollIntervalMs: 5 });
    harvester.attach(
      session(link, {
        classification: { type: "relay", role: "RADIOBRIDGE", commonName: "relay", dialect: "colon", evidence: "common-name", program: null, version: null },
      } as Partial<ConnectedSession>),
    );

    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(stream.writes.some((w) => w.bytes.startsWith("ID"))).toBe(false);
    expect(stream.writes.some((w) => w.bytes.startsWith("STATUS"))).toBe(false);
    store.close();
  });
});
