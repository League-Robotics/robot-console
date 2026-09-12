import { describe, expect, it, vi } from "vitest";
import { openStoreDb } from "../store/db.js";
import { Store } from "../store/index.js";
import type { DaplinkDevice } from "../devices.js";
import { LineLink, type ByteStream, type LineLinkOptions } from "../link/LineLink.js";
import { FakeByteStream } from "../link/__fixtures__/FakeByteStream.js";
import type { Scheduler } from "../link/pacing.js";
import type { SwdNameResult } from "../swdName.js";
import { startUsbWatcher, type UsbWatcherDeps, type UsbWatcherOptions } from "./usbWatcher.js";

// Ticket 014-007: `usbWatcher.ts`'s own suite. No real serialport/
// node-hid/SWD I/O anywhere here -- every seam (enumerator, SWD namer,
// port factory, clock) is injected, per the ticket's own testing note.

/** A fresh in-memory, fully-migrated store for one test. */
function freshStore(): Store {
  return new Store(openStoreDb({ filePath: ":memory:" }));
}

/** Whether nothing (`'naming'` included) currently holds `usbSerial`'s
 * `board_owner` row -- probed through {@link Store.acquireBoardOwner}'s
 * own typed contract (a claim under a throwaway owner name succeeds iff
 * no other owner holds it, and is released immediately after) rather
 * than a raw SQL read: `board_owner` is deliberately not one of
 * `Store.snapshotRows()`'s exposed tables, and this file lives outside
 * `store/`, where the "no SQL outside store/" rule
 * (`noRawSqlOutsideStore.test.ts`) forbids a direct raw-SQL statement. */
function boardOwnerIsFree(store: Store, usbSerial: string): boolean {
  const acquired = store.acquireBoardOwner(usbSerial, "test-probe", Date.now());
  if (acquired) {
    store.releaseBoardOwner(usbSerial, "test-probe");
  }
  return acquired;
}

/** Scheduler whose `delay()` resolves immediately -- same convention as
 * `LineLink.test.ts`'s `immediateScheduler`/`pacing.test.ts`'s
 * `recordingScheduler`. The boot-window resend schedule and the
 * connect-retry backoff are both driven through this seam, so tests
 * never wait on real wall-clock ms regardless of the configured
 * offsets/backoff. */
const immediateScheduler: Scheduler = { delay: () => Promise.resolve() };

/** A `FakeByteStream` that can answer `HELLO` with a banner line after
 * a configurable number of `HELLO`-shaped writes -- stands in for "the
 * board was still booting and dropped the first N `HELLO`s" (the
 * boot-window scenario this ticket's retry schedule exists for). The
 * reply is emitted on a real macrotask (`setTimeout(..., 0)`), which is
 * always ordered after `LineLink.connect()`'s own synchronous
 * `stream.open()` call has already registered its listeners -- see
 * `LineLink.test.ts`'s own `connectedLink()` helper for the same
 * ordering fact (`stream.resolveOpen()` called synchronously right
 * after `connect()` is invoked, and it already works). */
class ScriptedByteStream extends FakeByteStream {
  private helloWrites = 0;

  constructor(
    private readonly bannerLine: string | undefined,
    private readonly answerAfterWrites: number,
  ) {
    super();
  }

  override write(bytes: string, callback: (err?: Error | null) => void): void {
    super.write(bytes, callback);
    if (this.bannerLine !== undefined && bytes.startsWith("HELLO")) {
      this.helloWrites++;
      if (this.helloWrites >= this.answerAfterWrites) {
        setTimeout(() => this.emitData(`${this.bannerLine}\n`), 0);
      }
    }
  }
}

/** Builds a `createByteStream` port-factory: attempt `n` (1-based)
 * opens per `openOutcomes[n-1]` (the last entry repeats once
 * exhausted), and every stream it hands out auto-answers `HELLO` per
 * `answerAfterWrites` if `bannerLine` is given. */
function makeConnectFactory(params: {
  openOutcomes?: readonly ("resolve" | "reject")[];
  bannerLine?: string;
  answerAfterWrites?: number;
}): { createByteStream: (device: DaplinkDevice) => ByteStream; streams: ScriptedByteStream[] } {
  const openOutcomes = params.openOutcomes ?? (["resolve"] as const);
  let attempt = 0;
  const streams: ScriptedByteStream[] = [];
  const createByteStream = (): ByteStream => {
    const outcome = openOutcomes[Math.min(attempt, openOutcomes.length - 1)] ?? "resolve";
    attempt++;
    const stream = new ScriptedByteStream(params.bannerLine, params.answerAfterWrites ?? 1);
    streams.push(stream);
    setTimeout(() => {
      if (outcome === "resolve") {
        stream.resolveOpen();
      } else {
        stream.rejectOpen(new Error("simulated open failure"));
      }
    }, 0);
    return stream;
  };
  return { createByteStream, streams };
}

/** Wraps `createLineLink` to count every `LineLink.identify()` call
 * across every link it builds -- the "probe counter" the ticket's own
 * acceptance criterion names ("exactly one HELLO sequence"). One call
 * to `identify()` covers the whole boot-window retry (multiple
 * `HELLO` resends inside it are not separate "sequences" -- see
 * `usbWatcher.ts`'s own doc comment). */
function countingLineLinkFactory(): {
  createLineLink: (stream: ByteStream, options: LineLinkOptions) => LineLink;
  identifyCallCount: () => number;
} {
  let count = 0;
  const createLineLink = (stream: ByteStream, options: LineLinkOptions): LineLink => {
    const link = new LineLink(stream, options);
    const originalIdentify = link.identify.bind(link);
    link.identify = () => {
      count++;
      return originalIdentify();
    };
    return link;
  };
  return { createLineLink, identifyCallCount: () => count };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("waitFor: timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const SERIAL_A = "9900000031864e451111111111111111000000000000001";
const VEVOV_BANNER = "device NEZHA2 robot vevov 1198504156";
const VEVOV_ID = 1198504156;

function serialOnlyDevice(serialNumber: string, path: string): DaplinkDevice {
  return {
    serialNumber,
    displaySerial: serialNumber.slice(-8),
    availability: "serial-only",
    serialPort: { path },
  };
}

function fullDevice(serialNumber: string, path: string, hidPath: string): DaplinkDevice {
  return {
    serialNumber,
    displaySerial: serialNumber.slice(-8),
    availability: "full",
    serialPort: { path },
    hid: { path: hidPath },
  };
}

const NEVER_NAMED: SwdNameResult = { status: "unnamed", reason: "no-hid-path", error: "no HID path" };

describe("startUsbWatcher", () => {
  it(
    "an update (serial then HID one poll apart) yields one devices row, one links row, and exactly one identify() call",
    async () => {
      const store = freshStore();
      const { createByteStream } = makeConnectFactory({ bannerLine: VEVOV_BANNER, answerAfterWrites: 1 });
      const { createLineLink, identifyCallCount } = countingLineLinkFactory();

      let poll = 0;
      const listDevices = vi.fn(async () => {
        poll++;
        return poll === 1
          ? [serialOnlyDevice(SERIAL_A, "/dev/cu.usbmodemA")]
          : [fullDevice(SERIAL_A, "/dev/cu.usbmodemA", "IOHIDDevice@A")];
      });

      const deps: UsbWatcherDeps = {
        listDevices,
        readSwdName: async () => NEVER_NAMED,
        createByteStream,
        createLineLink,
        scheduler: immediateScheduler,
        now: () => Date.now(),
      };
      const opts: UsbWatcherOptions = { pollIntervalMs: 10, identifyBudgetMs: 200 };
      const handle = startUsbWatcher(store, deps, opts);
      try {
        await waitFor(() => store.snapshotRows().links[0]?.state === "connected");
        // Let a couple more polls happen (the HID-arrival "updated"
        // event) without disturbing the already-settled row.
        await new Promise((resolve) => setTimeout(resolve, 60));

        const rows = store.snapshotRows();
        expect(rows.devices).toHaveLength(1);
        expect(rows.devices[0]).toMatchObject({ id: VEVOV_ID, name: "vevov", kind: "robot", owned: 1 });
        expect(rows.links).toHaveLength(1);
        expect(rows.links[0]).toMatchObject({ id: `usb-${SERIAL_A}`, state: "connected" });
        expect(identifyCallCount()).toBe(1);
        expect(boardOwnerIsFree(store, SERIAL_A)).toBe(true);
      } finally {
        handle.stop();
        store.close();
      }
    },
  );

  it("a fake port whose open rejects twice then succeeds ends connected with fail_count = 2", async () => {
    const store = freshStore();
    const { createByteStream } = makeConnectFactory({
      openOutcomes: ["reject", "reject", "resolve"],
      bannerLine: VEVOV_BANNER,
      answerAfterWrites: 1,
    });

    const listDevices = vi.fn(async () => [serialOnlyDevice(SERIAL_A, "/dev/cu.usbmodemA")]);
    const deps: UsbWatcherDeps = {
      listDevices,
      readSwdName: async (): Promise<SwdNameResult> => ({ status: "named", name: "vevov", deviceId: VEVOV_ID }),
      createByteStream,
      createLineLink: (stream, options) => new LineLink(stream, options),
      scheduler: immediateScheduler,
    };
    const handle = startUsbWatcher(store, deps, { pollIntervalMs: 10, identifyBudgetMs: 200 });
    try {
      await waitFor(() => store.snapshotRows().links[0]?.state === "connected");
      const link = store.snapshotRows().links[0];
      expect(link).toMatchObject({ state: "connected", fail_count: 2 });
    } finally {
      handle.stop();
      store.close();
    }
  });

  it("a fake port that only answers HELLO after two dropped sends still ends identified (boot-window retry)", async () => {
    const store = freshStore();
    // Simulates a HELLO sent into the macOS boot window being dropped
    // outright: the first two HELLO writes get no reply at all, only
    // the third (a resend past the boot window) does.
    const { createByteStream } = makeConnectFactory({ bannerLine: VEVOV_BANNER, answerAfterWrites: 3 });

    const listDevices = vi.fn(async () => [serialOnlyDevice(SERIAL_A, "/dev/cu.usbmodemA")]);
    const deps: UsbWatcherDeps = {
      listDevices,
      readSwdName: async () => NEVER_NAMED,
      createByteStream,
      createLineLink: (stream, options) => new LineLink(stream, options),
      scheduler: immediateScheduler,
    };
    const handle = startUsbWatcher(store, deps, {
      pollIntervalMs: 10,
      identifyBudgetMs: 500,
      identifySchedule: [0, 10, 20, 30],
    });
    try {
      await waitFor(() => store.snapshotRows().links[0]?.state === "connected");
      const rows = store.snapshotRows();
      expect(rows.links[0]).toMatchObject({ state: "connected" });
      expect(rows.devices[0]).toMatchObject({ id: VEVOV_ID, name: "vevov", owned: 1 });
    } finally {
      handle.stop();
      store.close();
    }
  });

  it("SWD naming failure with a working banner still sets devices.owned = 1, keyed by the banner's own serial", async () => {
    const store = freshStore();
    const { createByteStream } = makeConnectFactory({ bannerLine: VEVOV_BANNER, answerAfterWrites: 1 });

    const listDevices = vi.fn(async () => [serialOnlyDevice(SERIAL_A, "/dev/cu.usbmodemA")]);
    const deps: UsbWatcherDeps = {
      listDevices,
      readSwdName: async (): Promise<SwdNameResult> => ({
        status: "unnamed",
        reason: "attach-failed",
        error: "simulated SWD attach failure",
      }),
      createByteStream,
      createLineLink: (stream, options) => new LineLink(stream, options),
      scheduler: immediateScheduler,
    };
    const handle = startUsbWatcher(store, deps, { pollIntervalMs: 10, identifyBudgetMs: 200 });
    try {
      await waitFor(() => store.snapshotRows().devices.length > 0);
      const rows = store.snapshotRows();
      expect(rows.devices).toHaveLength(1);
      expect(rows.devices[0]).toMatchObject({ id: VEVOV_ID, name: "vevov", owned: 1 });
      expect(rows.links[0]).toMatchObject({ device_id: VEVOV_ID });
    } finally {
      handle.stop();
      store.close();
    }
  });

  it("removed ages the link to stale within one poll and releases any board_owner row", async () => {
    const store = freshStore();
    const { createByteStream } = makeConnectFactory({ bannerLine: VEVOV_BANNER, answerAfterWrites: 1 });

    let poll = 0;
    const listDevices = vi.fn(async () => {
      poll++;
      return poll === 1 ? [serialOnlyDevice(SERIAL_A, "/dev/cu.usbmodemA")] : [];
    });
    const deps: UsbWatcherDeps = {
      listDevices,
      readSwdName: async () => NEVER_NAMED,
      createByteStream,
      createLineLink: (stream, options) => new LineLink(stream, options),
      scheduler: immediateScheduler,
    };
    const handle = startUsbWatcher(store, deps, { pollIntervalMs: 10, identifyBudgetMs: 200 });
    try {
      // Fully attach and identify first -- board_owner('naming') is
      // acquired and released entirely within that flow, well before
      // any removal.
      await waitFor(() => store.snapshotRows().links[0]?.state === "connected");
      expect(boardOwnerIsFree(store, SERIAL_A)).toBe(true);

      // The next poll (poll >= 2) reports the board gone.
      await waitFor(() => store.snapshotRows().links[0]?.state === "stale");

      expect(boardOwnerIsFree(store, SERIAL_A)).toBe(true);
    } finally {
      handle.stop();
      store.close();
    }
  });

  it("heartbeats a tasks row on every poll", async () => {
    const store = freshStore();
    const listDevices = vi.fn(async () => []);
    const deps: UsbWatcherDeps = { listDevices, scheduler: immediateScheduler };
    const handle = startUsbWatcher(store, deps, { pollIntervalMs: 10 });
    try {
      await waitFor(() => store.snapshotRows().tasks.length > 0);
      const task = store.snapshotRows().tasks.find((row) => row.name === "usbWatcher");
      expect(task).toMatchObject({ name: "usbWatcher", state: "running" });
    } finally {
      handle.stop();
      store.close();
    }
  });
});
