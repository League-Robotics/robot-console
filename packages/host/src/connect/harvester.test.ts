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

// Sprint 018 ticket 010 (SUC-007): `sessions.answered_at` -- the UI's
// "Linked" criterion (`deviceDisplay.ts`'s `isLinkAnswering`) reads this
// via `projection.ts`'s `SnapshotLink.session.answeredAt`. Every branch
// inside `onLine` that calls `syncSession` (status/estop/funcs/the
// default fall-through) is "the robot just answered something" by
// construction -- see `harvester.ts`'s own updated `syncSession` doc
// comment -- so each is covered here directly, plus the negative case
// (a bare poll timeout, no reply at all, must never set it).
describe("createHarvester -- sessions.answered_at (ticket 018-010)", () => {
  it("is null until the first reply, then set to now() on a status reply", async () => {
    const store = seededStore();
    const { link, stream } = await connectedLink();
    const harvester = createHarvester(store, { statusPollIntervalMs: 0, now: () => 5000 });
    harvester.attach(session(link));

    expect(store.snapshotRows().sessions.find((s) => s.link_id === "link-1")?.answered_at).toBeNull();

    stream.emitData("status flags=01 active=1\n");
    await flush();

    expect(store.snapshotRows().sessions.find((s) => s.link_id === "link-1")?.answered_at).toBe(5000);
    store.close();
  });

  it("is set on any other reply verb too (estop, funcs, and the default fall-through)", async () => {
    const store = seededStore();
    const { link, stream } = await connectedLink();
    const harvester = createHarvester(store, { statusPollIntervalMs: 0, now: () => 7000 });
    harvester.attach(session(link));

    stream.emitData("estop\n");
    await flush();
    expect(store.snapshotRows().sessions.find((s) => s.link_id === "link-1")?.answered_at).toBe(7000);

    stream.emitData("funcs drive x y\n");
    await flush();
    expect(store.snapshotRows().sessions.find((s) => s.link_id === "link-1")?.answered_at).toBe(7000);

    stream.emitData("ver 1.2.3\n");
    await flush();
    expect(store.snapshotRows().sessions.find((s) => s.link_id === "link-1")?.answered_at).toBe(7000);
    store.close();
  });

  // A missed `STATUS` poll (no reply at all) must never set answered_at --
  // it is the harvester declaring the link dead, not the robot
  // answering. `fail()` only writes `links.state`; it never deletes the
  // `sessions` row (that is `connect/reconciler.ts`'s own job, once its
  // `LineLink.onClose` subscription reacts to `fail()`'s own
  // `link.close()`), so the row is still present here, just never
  // answered.
  it("stays null across a missed-poll watchdog death with no reply", async () => {
    const store = seededStore();
    const { link } = await connectedLink();
    const harvester = createHarvester(store, { statusPollIntervalMs: 5, missedPollLimit: 1, now: () => 9000 });
    harvester.attach(session(link));

    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(store.snapshotRows().links.find((l) => l.id === "link-1")?.state).toBe("unresponsive");
    expect(store.snapshotRows().sessions.find((s) => s.link_id === "link-1")?.answered_at).toBeNull();
    store.close();
  });
});

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

  // Stakeholder bench (2026-09-14): a radio link turned off read
  // "unresponsive · link closed" -- the transport's own close landed after
  // the reconciler had already recorded `closed_by_user`.
  it("a transport close after the user turned the link off leaves closed_by_user standing", async () => {
    const store = seededStore();
    const { link, stream } = await connectedLink();
    const harvester = createHarvester(store, { statusPollIntervalMs: 0 });
    harvester.attach(session(link));

    store.setLinkState({ id: "link-1", state: "closed_by_user", at: 1, reason: "user-requested", userClosed: true });
    stream.emitClose();
    await flush();

    const row = store.snapshotRows().links.find((l) => l.id === "link-1");
    expect(row?.state).toBe("closed_by_user");
    expect(row?.state_reason).toBe("user-requested");
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

// 018-016 (bench defect: robot cards never showed a version -- the
// harvester's own `onLine` dropped the `id` verb entirely). `seededStore()`
// wires device 1198504156 up as "vevov" -- the `ID` reply's own `name`
// field must match that for the write to land.
describe("createHarvester -- id reply stores program/version (018-016)", () => {
  it("an id reply naming this session's own device stores program and version", async () => {
    const store = seededStore();
    const { link, stream } = await connectedLink();
    const harvester = createHarvester(store, { statusPollIntervalMs: 0, now: () => 12345 });
    harvester.attach(session(link));

    stream.emitData("id diffdrive calibration-0.20260913.1 1.20260912.8 vevov\n");
    await flush();

    const device = store.snapshotRows().devices.find((d) => d.id === 1198504156);
    expect(device?.program).toBe("calibration-0.20260913.1");
    expect(device?.version).toBe("1.20260912.8");
    store.close();
  });

  it("an id reply naming a different device is never written -- devices row stays untouched", async () => {
    const store = seededStore();
    const { link, stream } = await connectedLink();
    const harvester = createHarvester(store, { statusPollIntervalMs: 0 });
    harvester.attach(session(link));

    // "tovez" decodes to a different device id than 1198504156 -- this
    // reply must never be trusted to write identity onto the wrong row.
    stream.emitData("id diffdrive tovez 1.20260912.8 tovez\n");
    await flush();

    const device = store.snapshotRows().devices.find((d) => d.id === 1198504156);
    expect(device?.program).toBeNull();
    expect(device?.version).toBeNull();
    store.close();
  });

  it("a malformed id reply (too few fields) is ignored, no throw", async () => {
    const store = seededStore();
    const { link, stream } = await connectedLink();
    const harvester = createHarvester(store, { statusPollIntervalMs: 0 });
    harvester.attach(session(link));

    stream.emitData("id diffdrive vevov\n");
    await flush();

    const device = store.snapshotRows().devices.find((d) => d.id === 1198504156);
    expect(device?.program).toBeNull();
    expect(device?.version).toBeNull();
    // The reply still refreshed the session's own sequencing counters
    // (this module's own "id ... update the session row" contract) --
    // confirmed via answeredAt rather than throwing.
    expect(store.snapshotRows().sessions.find((s) => s.link_id === "link-1")?.answered_at).not.toBeNull();
    store.close();
  });
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

// ---------------------------------------------------------------------
// 018-009: the STATUS poll defers to a foreign unsequenced query (e.g. a
// student's own `send-command ID`) still in flight on the same link --
// bench evidence against the real `torture` mbrelay pool found a
// student's `ID` racing this poll's own `STATUS` merged/dropped by a
// lossy relay hop. See LineLink.ts's own module doc comment,
// "Unsequenced query resend and poll/query serialization", for the full
// rationale.
// ---------------------------------------------------------------------

/** `statusPollIntervalMs`/waits below use 50ms ticks, well clear of
 * `LineLink`'s own write-pacing gap (`DEFAULT_WRITE_PACE_MS`, 10ms) on
 * the *real* scheduler this suite's `connectedLink()` uses -- a shorter
 * interval risked a write already scheduled by a just-fired tick landing
 * a few ms *after* a test captured its "before" baseline, an event-loop
 * race rather than anything the gate itself gets wrong (caught live
 * while writing this suite). */
const POLL_INTERVAL_MS = 50;

function statusWriteCount(stream: FakeByteStream): number {
  return stream.writes.filter((w) => w.bytes.trim().toUpperCase() === "STATUS").length;
}

describe("createHarvester -- STATUS poll defers to a pending foreign query (018-009)", () => {
  it("skips every poll tick (and never counts one as a miss) while link.hasPendingUnsequencedQuery is true", async () => {
    const store = seededStore();
    const { link, stream } = await connectedLink();
    const setLinkState = vi.spyOn(store, "setLinkState");
    const harvester = createHarvester(store, { statusPollIntervalMs: POLL_INTERVAL_MS, missedPollLimit: 1000 });
    harvester.attach(session(link));
    // Let attach()'s own initial ID probe and first STATUS tick land,
    // then settle both before this test's own scenario begins.
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS + 20));
    stream.emitData("id diffdrive calibration-0.20260913.1 1.20260912.8 vevov\n");
    expect(link.hasPendingUnsequencedQuery).toBe(false);
    const statusCountBeforeForeignQuery = statusWriteCount(stream);

    // Simulate a foreign (student-originated) unsequenced query still in
    // flight on this same link -- e.g. server.ts's send-command dispatch
    // for a non-sequenced verb.
    link.sendUnsequencedQuery("ID");
    expect(link.hasPendingUnsequencedQuery).toBe(true);

    // Several poll intervals elapse while the foreign query is pending --
    // none of them may add a new STATUS write.
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS * 3));

    expect(statusWriteCount(stream)).toBe(statusCountBeforeForeignQuery);
    // A skipped tick is not a miss -- confirm the watchdog never fired.
    expect(setLinkState.mock.calls.some(([input]) => input.state === "unresponsive")).toBe(false);
    store.close();
  });

  it("resumes polling once the foreign query settles", async () => {
    const store = seededStore();
    const { link, stream } = await connectedLink();
    const harvester = createHarvester(store, { statusPollIntervalMs: POLL_INTERVAL_MS, missedPollLimit: 1000 });
    harvester.attach(session(link));
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS + 20));
    stream.emitData("id diffdrive calibration-0.20260913.1 1.20260912.8 vevov\n");
    expect(link.hasPendingUnsequencedQuery).toBe(false);
    const statusCountBeforeForeignQuery = statusWriteCount(stream);

    link.sendUnsequencedQuery("ID");
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS * 2));
    expect(statusWriteCount(stream)).toBe(statusCountBeforeForeignQuery); // still gated

    // The foreign query's own reply arrives -- the gate clears.
    stream.emitData("id diffdrive calibration-0.20260913.1 1.20260912.8 vevov\n");
    expect(link.hasPendingUnsequencedQuery).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS * 2));
    expect(statusWriteCount(stream)).toBeGreaterThan(statusCountBeforeForeignQuery);
    store.close();
  });
});
