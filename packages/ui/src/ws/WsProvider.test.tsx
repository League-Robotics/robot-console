// @vitest-environment jsdom
/**
 * WsProvider.test.tsx — store-level tests for ticket 007's `Snapshot`-
 * backed store, exercised directly through `WsProvider` and its
 * selector hooks.
 *
 * Covers exactly the properties this ticket exists to guarantee:
 *  - render-count isolation between links/devices, for `useDevice`,
 *    `useLink`, and `useLinkLog` -- verified via explicit render-count
 *    assertions, not by inspection.
 *  - the `hasSnapshot`/`stale` transitions (false -> true -> stays true
 *    across a reconnect; `stale` flips on close, clears on the next
 *    snapshot).
 *  - the hoisted log buffer's append order, `MAX_LINES_PER_LINK` cap,
 *    and per-link independence, plus the LRU bound.
 *  - `useFlashProgress` picking up live `flash-progress` events for
 *    both a release and a local-hex source, clearing on `flash-result`,
 *    and falling back to the snapshot's own `SnapshotLink.flash` once
 *    the overlay has nothing (the reconnect self-heal ticket 006
 *    flagged as a gap for local-hex).
 *  - a link-scoped `notice` lands in that link's log; a connection-level
 *    one (no `linkId`) is dropped.
 *  - `useRelays`/`useFirmware`/`useWifiSetting`/`useTasks` mirror the
 *    snapshot's own fields, with sensible defaults before the first one.
 *  - `useDeviceForLink` resolves the owning device for an owned link,
 *    and is `undefined` for an unassigned one.
 *
 * Test 434-483 of the pre-ticket-007 file (contract-drift tests pinned
 * to the retired `EndpointListEntry`/`EndpointsMessage` shape) has no
 * equivalent here -- there is no old shape left to drift against.
 */
import { act, useEffect, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Snapshot, SnapshotDevice, SnapshotLink } from "@robot-console/host/src/wsMessages.js";
import { FakeSocket } from "../testing/FakeSocket";
import {
  MAX_LINES_PER_LINK,
  MAX_TRACKED_LINK_LOGS,
  TELEMETRY_RING_CAPACITY,
  WsProvider,
  useDevice,
  useDeviceForLink,
  useFirmware,
  useFlashProgress,
  useHasSnapshot,
  useHostConnection,
  useLink,
  useLinkLog,
  useRelays,
  useTasks,
  useTelemetry,
  useTelemetryHeader,
  useWifiSetting,
  useWsActions,
  type LogEntry,
  type TelemetryFrame,
  type TelemetryHandle,
} from "./WsProvider";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function mount(node: ReactElement): HTMLDivElement {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(node);
  });
  return container;
}

afterEach(() => {
  if (root) {
    act(() => {
      root!.unmount();
    });
    root = null;
  }
  if (container) {
    container.remove();
    container = null;
  }
  vi.useRealTimers();
});

const NO_FIRMWARE: Snapshot["firmware"] = {
  relay: { configured: false },
  robot: { configured: false },
};

/** Minimal link fixture -- these tests only ever assert on `id` and
 * whichever single field a test overrides. */
function linkFixture(id: string, overrides: Partial<SnapshotLink> = {}): SnapshotLink {
  return {
    id,
    transport: "usb",
    label: `USB · /dev/cu.usbmodem-${id}`,
    state: "connected",
    reason: null,
    since: 0,
    lastSeen: 0,
    nextRetryAt: null,
    capabilities: { open: false, close: true, flash: true, provisionWifi: true },
    ...overrides,
  };
}

/** Minimal device fixture, one link by default (`usb-<id>`). */
function deviceFixture(
  id: number,
  overrides: Partial<Omit<SnapshotDevice, "links">> & { links?: SnapshotLink[] } = {},
): SnapshotDevice {
  const { links, ...rest } = overrides;
  return {
    id,
    name: `name-${id}`,
    kind: "robot",
    role: null,
    commonName: null,
    program: null,
    version: null,
    owned: true,
    radio: { channel: 1, group: 1, source: "derived" },
    lastSeen: 0,
    lastChecked: null,
    links: links ?? [linkFixture(`usb-${id}`)],
    ...rest,
  };
}

function snapshotFixture(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    type: "snapshot",
    seq: 1,
    at: 0,
    devices: [],
    unassigned: [],
    relays: [],
    firmware: NO_FIRMWARE,
    wifi: { ssid: null, source: null },
    tasks: [],
    ...overrides,
  };
}

function mountWithSocket(children: ReactElement): { el: HTMLDivElement; getSocket: () => FakeSocket } {
  let socket: FakeSocket | null = null;
  const el = mount(
    <WsProvider url="ws://test/" socketFactory={() => (socket = new FakeSocket())}>
      {children}
    </WsProvider>,
  );
  act(() => {
    socket!.emitOpen();
  });
  return { el, getSocket: () => socket! };
}

describe("render-count isolation", () => {
  it("useDevice(A) does not re-render when device B changes, or when a line arrives for a different link", () => {
    const renders = { a: 0, b: 0 };

    function ProbeA() {
      useDevice(1);
      renders.a += 1;
      return null;
    }
    function ProbeB() {
      useDevice(2);
      renders.b += 1;
      return null;
    }

    const { getSocket } = mountWithSocket(
      <>
        <ProbeA />
        <ProbeB />
      </>,
    );
    expect(renders.a).toBe(1);
    expect(renders.b).toBe(1);

    act(() => {
      getSocket().emitMessage(snapshotFixture({ devices: [deviceFixture(1), deviceFixture(2)] }));
    });
    expect(renders.a).toBe(2);
    expect(renders.b).toBe(2);

    act(() => {
      getSocket().emitMessage(
        snapshotFixture({ devices: [deviceFixture(1), deviceFixture(2, { role: "NEZHA2" })] }),
      );
    });
    // B changed; A is byte-for-byte identical -- structural sharing
    // reuses A's previous object, so useDevice(1) doesn't re-render.
    expect(renders.b).toBe(3);
    expect(renders.a).toBe(2);

    act(() => {
      getSocket().emitMessage({ type: "line", linkId: "usb-2", direction: "rx", line: "hi" });
    });
    // A `line` message never touches devicesById at all.
    expect(renders.a).toBe(2);
    expect(renders.b).toBe(3);
  });

  it("useLink(A) does not re-render when a sibling link on the same device changes", () => {
    const renders = { a: 0 };
    function ProbeLinkA() {
      useLink("usb-1");
      renders.a += 1;
      return null;
    }

    const { getSocket } = mountWithSocket(<ProbeLinkA />);
    expect(renders.a).toBe(1);

    const bothLinks = [linkFixture("usb-1"), linkFixture("wifi-1", { transport: "wifi" })];
    act(() => {
      getSocket().emitMessage(snapshotFixture({ devices: [deviceFixture(1, { links: bothLinks })] }));
    });
    expect(renders.a).toBe(2);

    act(() => {
      getSocket().emitMessage(
        snapshotFixture({
          devices: [
            deviceFixture(1, {
              links: [linkFixture("usb-1"), linkFixture("wifi-1", { transport: "wifi", state: "connecting" })],
            }),
          ],
        }),
      );
    });
    // Only the wifi sibling changed; usb-1 is unchanged -- no re-render.
    expect(renders.a).toBe(2);
  });

  it("useLinkLog(A) does not re-render on a snapshot update that leaves A's log untouched", () => {
    const renders = { a: 0 };
    function LogProbeA() {
      useLinkLog("usb-1");
      renders.a += 1;
      return null;
    }

    const { getSocket } = mountWithSocket(<LogProbeA />);
    expect(renders.a).toBe(1);

    act(() => {
      getSocket().emitMessage(snapshotFixture({ devices: [deviceFixture(1), deviceFixture(2)] }));
    });
    expect(renders.a).toBe(1);

    act(() => {
      getSocket().emitMessage({ type: "line", linkId: "usb-1", direction: "rx", line: "hello" });
    });
    expect(renders.a).toBe(2);
  });
});

describe("hasSnapshot / useHostConnection staleness", () => {
  it("hasSnapshot is false before the first snapshot, true after, and stays true across a reconnect", () => {
    vi.useFakeTimers();
    const holder: { value: boolean | undefined } = { value: undefined };

    function Probe() {
      holder.value = useHasSnapshot();
      return null;
    }

    let socket: FakeSocket | null = null;
    mount(
      <WsProvider url="ws://test/" socketFactory={() => (socket = new FakeSocket())}>
        <Probe />
      </WsProvider>,
    );
    expect(holder.value).toBe(false);

    act(() => {
      socket!.emitOpen();
    });
    expect(holder.value).toBe(false);

    act(() => {
      socket!.emitMessage(snapshotFixture());
    });
    expect(holder.value).toBe(true);

    act(() => {
      socket!.close();
    });
    expect(holder.value).toBe(true);

    act(() => {
      vi.advanceTimersByTime(1500);
    });
    act(() => {
      socket!.emitOpen();
    });
    expect(holder.value).toBe(true);
  });

  it("useHostConnection.stale flips true on close and clears on the next snapshot, without changing status semantics", () => {
    vi.useFakeTimers();
    const values: Array<{ status: string; stale: boolean }> = [];
    function Probe() {
      values.push(useHostConnection());
      return null;
    }

    let socket: FakeSocket | null = null;
    mount(
      <WsProvider url="ws://test/" socketFactory={() => (socket = new FakeSocket())}>
        <Probe />
      </WsProvider>,
    );
    expect(values.at(-1)).toEqual({ status: "connecting", stale: false });

    act(() => {
      socket!.emitOpen();
    });
    expect(values.at(-1)).toEqual({ status: "open", stale: false });

    act(() => {
      socket!.emitMessage(snapshotFixture());
    });
    expect(values.at(-1)).toEqual({ status: "open", stale: false });

    act(() => {
      socket!.close();
    });
    expect(values.at(-1)).toEqual({ status: "closed", stale: true });

    act(() => {
      vi.advanceTimersByTime(1500);
      socket!.emitOpen();
    });
    // Reconnected, but no fresh snapshot has landed yet -- still stale.
    expect(values.at(-1)).toEqual({ status: "open", stale: true });

    act(() => {
      socket!.emitMessage(snapshotFixture({ seq: 2 }));
    });
    expect(values.at(-1)).toEqual({ status: "open", stale: false });
  });
});

describe("hoisted log buffer", () => {
  it("appends in order, caps at MAX_LINES_PER_LINK dropping the oldest, independently per link", () => {
    const logsA: LogEntry[][] = [];
    const logsB: LogEntry[][] = [];

    function ProbeA() {
      logsA.push(useLinkLog("usb-1"));
      return null;
    }
    function ProbeB() {
      logsB.push(useLinkLog("usb-2"));
      return null;
    }

    const { getSocket } = mountWithSocket(
      <>
        <ProbeA />
        <ProbeB />
      </>,
    );

    act(() => {
      for (let i = 0; i < MAX_LINES_PER_LINK + 5; i++) {
        getSocket().emitMessage({ type: "line", linkId: "usb-1", direction: "rx", line: `n${i}` });
      }
      getSocket().emitMessage({ type: "line", linkId: "usb-2", direction: "rx", line: "only-b" });
    });

    const finalA = logsA[logsA.length - 1]!;
    const finalB = logsB[logsB.length - 1]!;

    expect(finalA).toHaveLength(MAX_LINES_PER_LINK);
    expect(finalA[0]!.line).toBe("n5");
    expect(finalA[finalA.length - 1]!.line).toBe(`n${MAX_LINES_PER_LINK + 4}`);

    expect(finalB).toHaveLength(1);
    expect(finalB[0]!.line).toBe("only-b");
  });

  it("keeps only the MAX_TRACKED_LINK_LOGS most recently active links' logs", () => {
    const results: Record<string, LogEntry[]> = {};

    function Probe({ id }: { id: string }) {
      results[id] = useLinkLog(`usb-${id}`);
      return null;
    }

    const ids = Array.from({ length: MAX_TRACKED_LINK_LOGS + 1 }, (_, i) => `E${i}`);
    const { getSocket } = mountWithSocket(
      <>
        {ids.map((id) => (
          <Probe key={id} id={id} />
        ))}
      </>,
    );

    act(() => {
      for (const id of ids) {
        getSocket().emitMessage({ type: "line", linkId: `usb-${id}`, direction: "rx", line: "hi" });
      }
    });

    expect(results["E0"]).toEqual([]);
    for (let i = 1; i <= MAX_TRACKED_LINK_LOGS; i++) {
      expect(results[`E${i}`]).toHaveLength(1);
    }
  });
});

describe("useFlashProgress", () => {
  it("tracks live flash-progress events for a release source, and clears on flash-result", () => {
    const values: Array<ReturnType<typeof useFlashProgress>> = [];
    function Probe() {
      values.push(useFlashProgress("usb-1"));
      return null;
    }

    const { getSocket } = mountWithSocket(<Probe />);
    expect(values.at(-1)).toBeUndefined();

    act(() => {
      getSocket().emitMessage({
        type: "flash-progress",
        linkId: "usb-1",
        source: { kind: "release", firmware: "relay" },
        phase: "writing",
        seq: 1,
      });
    });
    expect(values.at(-1)).toEqual({ source: { kind: "release", firmware: "relay" }, phase: "writing" });

    act(() => {
      getSocket().emitMessage({
        type: "flash-result",
        linkId: "usb-1",
        source: { kind: "release", firmware: "relay" },
        status: "ok",
        seq: 2,
      });
    });
    expect(values.at(-1)).toBeUndefined();
  });

  it("tracks live flash-progress events for a local-hex source", () => {
    const values: Array<ReturnType<typeof useFlashProgress>> = [];
    function Probe() {
      values.push(useFlashProgress("usb-1"));
      return null;
    }

    const { getSocket } = mountWithSocket(<Probe />);
    act(() => {
      getSocket().emitMessage({
        type: "flash-progress",
        linkId: "usb-1",
        source: { kind: "local-hex", uploadId: "u1", fileName: "custom.hex", sha256: "abc" },
        phase: "erasing",
        seq: 1,
      });
    });
    expect(values.at(-1)).toEqual({
      source: { kind: "local-hex", uploadId: "u1", fileName: "custom.hex", sha256: "abc" },
      phase: "erasing",
    });
  });

  it("falls back to the snapshot's own SnapshotLink.flash once the live overlay has nothing (reconnect self-heal)", () => {
    const values: Array<ReturnType<typeof useFlashProgress>> = [];
    function Probe() {
      values.push(useFlashProgress("usb-1"));
      return null;
    }

    const { getSocket } = mountWithSocket(<Probe />);
    expect(values.at(-1)).toBeUndefined();

    act(() => {
      getSocket().emitMessage(
        snapshotFixture({
          devices: [
            deviceFixture(1, {
              links: [
                linkFixture("usb-1", {
                  flash: { source: { kind: "local-hex", uploadId: "u1", fileName: "custom.hex", sha256: "abc" }, phase: "writing" },
                }),
              ],
            }),
          ],
        }),
      );
    });
    expect(values.at(-1)).toEqual({
      source: { kind: "local-hex", uploadId: "u1", fileName: "custom.hex", sha256: "abc" },
      phase: "writing",
    });
  });
});

describe("useDeviceForLink", () => {
  it("resolves the owning device for a link inside devices[], and is undefined for an unassigned link", () => {
    // Two separate results, not one shared array: the unassigned-link
    // probe's value stays `undefined` across the update (no owner
    // before or after), so `useSyncExternalStore` legitimately skips
    // re-rendering it -- a shared "last push wins" array would flake on
    // exactly that render-count optimization.
    const results: { owned?: SnapshotDevice | undefined; unassigned?: SnapshotDevice | undefined } = {};
    function Probe({ linkId, resultKey }: { linkId: string; resultKey: "owned" | "unassigned" }) {
      results[resultKey] = useDeviceForLink(linkId);
      return null;
    }

    const { getSocket } = mountWithSocket(
      <>
        <Probe linkId="usb-1" resultKey="owned" />
        <Probe linkId="usb-unknown-1" resultKey="unassigned" />
      </>,
    );
    act(() => {
      getSocket().emitMessage(
        snapshotFixture({
          devices: [deviceFixture(1)],
          unassigned: [linkFixture("usb-unknown-1", { state: "discovered" })],
        }),
      );
    });

    expect(results.owned?.id).toBe(1);
    expect(results.unassigned).toBeUndefined();
  });
});

describe("useRelays / useFirmware / useWifiSetting / useTasks", () => {
  it("mirror the snapshot's own fields, with sensible defaults before the first one", () => {
    const seen: { relays: unknown; firmware: unknown; wifi: unknown; tasks: unknown }[] = [];
    function Probe() {
      seen.push({ relays: useRelays(), firmware: useFirmware(), wifi: useWifiSetting(), tasks: useTasks() });
      return null;
    }

    const { getSocket } = mountWithSocket(<Probe />);
    expect(seen[0]).toEqual({ relays: [], firmware: NO_FIRMWARE, wifi: { ssid: null, source: null }, tasks: [] });

    act(() => {
      getSocket().emitMessage(
        snapshotFixture({
          relays: [{ linkId: "usb-relay-1", lease: "sweep" }],
          firmware: { relay: { configured: false }, robot: { configured: true, repoUrl: "r", tag: "t", available: true, checkedAt: null } },
          wifi: { ssid: "classroom-net", source: "stored" },
          tasks: [{ name: "usbWatcher", state: "running", heartbeatAt: 1 }],
        }),
      );
    });

    const last = seen.at(-1)!;
    expect(last.relays).toEqual([{ linkId: "usb-relay-1", lease: "sweep" }]);
    expect(last.wifi).toEqual({ ssid: "classroom-net", source: "stored" });
    expect(last.tasks).toEqual([{ name: "usbWatcher", state: "running", heartbeatAt: 1 }]);
  });
});

describe("notice messages (replaces type: 'error')", () => {
  it("appends a linkId-scoped notice to that link's log, not any other link's", () => {
    const logsA: LogEntry[][] = [];
    const logsB: LogEntry[][] = [];
    function ProbeA() {
      logsA.push(useLinkLog("usb-1"));
      return null;
    }
    function ProbeB() {
      logsB.push(useLinkLog("usb-2"));
      return null;
    }

    const { getSocket } = mountWithSocket(
      <>
        <ProbeA />
        <ProbeB />
      </>,
    );

    act(() => {
      getSocket().emitMessage({ type: "notice", level: "warn", linkId: "usb-1", text: "no open link", at: 0, seq: 1 });
    });

    const finalA = logsA[logsA.length - 1]!;
    const finalB = logsB[logsB.length - 1]!;
    expect(finalA).toHaveLength(1);
    expect(finalA[0]).toMatchObject({ direction: "rx", line: "no open link", origin: "host" });
    expect(finalB).toEqual([]);
  });

  it("drops a connection-level notice (no linkId) rather than attaching it to any link's log", () => {
    const logsA: LogEntry[][] = [];
    function ProbeA() {
      logsA.push(useLinkLog("usb-1"));
      return null;
    }

    const { getSocket } = mountWithSocket(<ProbeA />);
    act(() => {
      getSocket().emitMessage({ type: "notice", level: "error", text: "malformed message", at: 0, seq: 1 });
    });
    expect(logsA.at(-1)).toEqual([]);
  });
});

describe("sendCommand", () => {
  it("sends a correctly-shaped send-command message with fields", () => {
    let actions: ReturnType<typeof useWsActions> | undefined;
    function Probe() {
      actions = useWsActions();
      return null;
    }

    const { getSocket } = mountWithSocket(<Probe />);
    act(() => {
      actions!.sendCommand("usb-1", "SET", [1, "left", { wireType: "flags", value: 3 }]);
    });

    expect(getSocket().sent).toHaveLength(1);
    expect(JSON.parse(getSocket().sent[0]!)).toEqual({
      type: "send-command",
      linkId: "usb-1",
      verb: "SET",
      fields: [1, "left", { wireType: "flags", value: 3 }],
    });
  });

  it("sends a correctly-shaped send-command message with fields omitted", () => {
    let actions: ReturnType<typeof useWsActions> | undefined;
    function Probe() {
      actions = useWsActions();
      return null;
    }

    const { getSocket } = mountWithSocket(<Probe />);
    act(() => {
      actions!.sendCommand("usb-1", "STATUS");
    });

    expect(JSON.parse(getSocket().sent[0]!)).toEqual({ type: "send-command", linkId: "usb-1", verb: "STATUS" });
  });

  it("is silently dropped when the socket is not open, same as every other action", () => {
    let actions: ReturnType<typeof useWsActions> | undefined;
    function Probe() {
      actions = useWsActions();
      return null;
    }

    let socket: FakeSocket | null = null;
    mount(
      <WsProvider url="ws://test/" socketFactory={() => (socket = new FakeSocket())}>
        <Probe />
      </WsProvider>,
    );
    act(() => {
      actions!.sendCommand("usb-1", "STATUS");
    });
    expect(socket!.sent).toHaveLength(0);
  });
});

describe("useTelemetry / useTelemetryHeader", () => {
  it("a header then frames populate the ring, in order, with the header parsed and each frame's values numeric", () => {
    let handle: TelemetryHandle | undefined;
    function Probe() {
      handle = useTelemetry("usb-1");
      return null;
    }

    const { getSocket } = mountWithSocket(<Probe />);
    expect(handle!.header).toBeUndefined();

    act(() => {
      getSocket().emitMessage({ type: "telemetry", linkId: "usb-1", header: ["ox", "oy"] });
    });
    expect(handle!.header).toEqual(["ox", "oy"]);

    act(() => {
      getSocket().emitMessage({ type: "telemetry", linkId: "usb-1", frame: { ox: "1", oy: "2" } });
    });
    act(() => {
      getSocket().emitMessage({ type: "telemetry", linkId: "usb-1", frame: { ox: "3", oy: "4" } });
    });

    const frames = handle!.snapshot();
    expect(frames).toHaveLength(2);
    expect(frames[0]!.values).toEqual({ ox: 1, oy: 2 });
    expect(frames[1]!.values).toEqual({ ox: 3, oy: 4 });
    expect(handle!.latest).toEqual(frames[1]);
  });

  it(`capacity wraps oldest-first once TELEMETRY_RING_CAPACITY (${TELEMETRY_RING_CAPACITY}) is exceeded`, () => {
    let handle: TelemetryHandle | undefined;
    function Probe() {
      handle = useTelemetry("usb-1");
      return null;
    }

    const { getSocket } = mountWithSocket(<Probe />);
    act(() => {
      getSocket().emitMessage({ type: "telemetry", linkId: "usb-1", header: ["x"] });
    });

    const total = TELEMETRY_RING_CAPACITY + 5;
    act(() => {
      for (let i = 0; i < total; i++) {
        getSocket().emitMessage({ type: "telemetry", linkId: "usb-1", frame: { x: String(i) } });
      }
    });

    const frames = handle!.snapshot();
    expect(frames).toHaveLength(TELEMETRY_RING_CAPACITY);
    expect(frames[0]!.values.x).toBe(5);
    expect(frames[frames.length - 1]!.values.x).toBe(total - 1);
  });

  it("resets the ring when the link's session closes (session present -> absent across snapshots)", () => {
    let handle: TelemetryHandle | undefined;
    function Probe() {
      handle = useTelemetry("usb-1");
      return null;
    }

    const { getSocket } = mountWithSocket(<Probe />);
    act(() => {
      getSocket().emitMessage(
        snapshotFixture({
          devices: [
            deviceFixture(1, {
              links: [linkFixture("usb-1", { session: { seq: 0, pending: 0, lastDone: null, lastDoneReason: null, robotStatus: null, functions: null } })],
            }),
          ],
        }),
      );
    });
    act(() => {
      getSocket().emitMessage({ type: "telemetry", linkId: "usb-1", header: ["x"] });
    });
    act(() => {
      getSocket().emitMessage({ type: "telemetry", linkId: "usb-1", frame: { x: "1" } });
    });
    expect(handle!.snapshot()).toHaveLength(1);

    act(() => {
      getSocket().emitMessage(snapshotFixture({ devices: [deviceFixture(1, { links: [linkFixture("usb-1")] })] }));
    });
    expect(handle!.snapshot()).toEqual([]);
    expect(handle!.header).toEqual(["x"]);
  });

  it("useTelemetryHeader reflects the current header once one arrives", () => {
    const values: Array<readonly string[] | undefined> = [];
    function Probe() {
      values.push(useTelemetryHeader("usb-1"));
      return null;
    }

    const { getSocket } = mountWithSocket(<Probe />);
    expect(values.at(-1)).toBeUndefined();

    act(() => {
      getSocket().emitMessage({ type: "telemetry", linkId: "usb-1", header: ["ox", "oy"] });
    });
    expect(values.at(-1)).toEqual(["ox", "oy"]);
  });

  it("telemetrySubscribe sends the exact send-command TLM message", () => {
    let actions: ReturnType<typeof useWsActions> | undefined;
    function Probe() {
      actions = useWsActions();
      return null;
    }

    const { getSocket } = mountWithSocket(<Probe />);
    act(() => {
      actions!.telemetrySubscribe("usb-1", "POSE");
    });
    expect(JSON.parse(getSocket().sent[0]!)).toEqual({ type: "send-command", linkId: "usb-1", verb: "TLM", fields: ["POSE"] });
  });

  describe("render-count isolation", () => {
    it("frame arrivals for A fire subscribers directly, without re-rendering the useTelemetry(A) component or an unrelated useDevice(B) selector", () => {
      const renders = { telemetry: 0, other: 0 };
      const receivedFrames: TelemetryFrame[] = [];

      function TelemetryProbe() {
        const handle = useTelemetry("usb-1");
        renders.telemetry += 1;
        useEffect(() => handle.subscribe((frame) => receivedFrames.push(frame)), [handle]);
        return null;
      }
      function OtherProbe() {
        useDevice(2);
        renders.other += 1;
        return null;
      }

      const { getSocket } = mountWithSocket(
        <>
          <TelemetryProbe />
          <OtherProbe />
        </>,
      );
      expect(renders.telemetry).toBe(1);
      expect(renders.other).toBe(1);

      act(() => {
        getSocket().emitMessage({ type: "telemetry", linkId: "usb-1", header: ["x"] });
      });
      expect(renders.telemetry).toBe(1);
      expect(renders.other).toBe(1);

      act(() => {
        for (let i = 0; i < 20; i++) {
          getSocket().emitMessage({ type: "telemetry", linkId: "usb-1", frame: { x: String(i) } });
        }
      });
      expect(receivedFrames).toHaveLength(20);
      expect(renders.telemetry).toBe(1);
      expect(renders.other).toBe(1);
    });
  });
});
