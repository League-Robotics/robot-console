// @vitest-environment jsdom
/**
 * WsProvider.test.tsx — store-level tests for ticket 006's ref-backed
 * store, exercised directly through `WsProvider` and its selector
 * hooks rather than through `DevicesTab`/`ConsoleTab` (which have
 * their own component-level tests already, unchanged in behavior by
 * this ticket).
 *
 * Covers exactly the properties this ticket exists to guarantee:
 *  - render-count isolation between endpoints, for both `useEndpoint`
 *    and `useEndpointLog` -- verified via explicit render-count
 *    assertions, per `sprint.md`'s Success Criteria, not by inspection.
 *  - the `hasSnapshot` transition (false -> true -> stays true across
 *    a reconnect).
 *  - the hoisted log buffer's append order, `MAX_LINES_PER_DEVICE`
 *    cap, and per-endpoint independence, plus the LRU bound on how
 *    many distinct endpoints' logs are kept at all.
 *  - `useFlashProgress` picking up live `flash-progress` events for
 *    both a release and a local-hex source, and clearing on the
 *    terminal `flash-result` (ticket 005's flagged gap).
 */
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EndpointListEntry, RememberedRobotEntry } from "@robot-console/host/src/wsMessages.js";
import { FakeSocket } from "../testing/FakeSocket";
import {
  MAX_LINES_PER_DEVICE,
  MAX_TRACKED_ENDPOINT_LOGS,
  WsProvider,
  useEndpoint,
  useEndpointLog,
  useFlashProgress,
  useHasSnapshot,
  useRememberedRobots,
  type LogEntry,
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

/** Minimal fixture -- these tests only ever assert on `endpointId` and
 * whichever single field a test overrides, so there is no need for
 * `DevicesTab.test.tsx`'s fuller `BaseDeviceOverrides` translation
 * layer here. */
function endpointFixture(id: string, overrides: { sessionOpen?: boolean; role?: string | null } = {}): EndpointListEntry {
  return {
    endpointId: `usb-${id}`,
    transport: "usb",
    resourceKey: `usb-${id}`,
    classification: { type: "unknown", role: null, commonName: null, dialect: null, evidence: "none" },
    name: `name-${id}`,
    role: overrides.role ?? null,
    sessionOpen: overrides.sessionOpen ?? false,
    usb: { serialNumber: `${id}-FULL`, displaySerial: "0002", port: "/dev/cu.usbmodemA" },
  };
}

const NO_FIRMWARE_STATUS = {
  relay: { configured: false as const },
  robot: { configured: false as const },
};

function rememberedRobotFixture(name: string, overrides: Partial<RememberedRobotEntry> = {}): RememberedRobotEntry {
  return {
    name,
    lastSeenAt: "2026-01-01T00:00:00.000Z",
    lastSeenVia: "usb",
    lastRole: overrides.lastRole ?? null,
    lastUsbSerial: overrides.lastUsbSerial ?? `${name}-SERIAL`,
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
  it("useEndpoint(A) does not re-render when a line arrives for B, or when B's state changes", () => {
    const renders = { a: 0, b: 0 };

    function ProbeA() {
      useEndpoint("usb-A");
      renders.a += 1;
      return null;
    }
    function ProbeB() {
      useEndpoint("usb-B");
      renders.b += 1;
      return null;
    }

    const { getSocket } = mountWithSocket(
      <>
        <ProbeA />
        <ProbeB />
      </>,
    );
    // Initial mount render, before any snapshot has arrived.
    expect(renders.a).toBe(1);
    expect(renders.b).toBe(1);

    act(() => {
      getSocket().emitMessage({
        type: "endpoints",
        endpoints: [endpointFixture("A"), endpointFixture("B")],
        firmwareStatus: NO_FIRMWARE_STATUS,
      });
    });
    // Both endpoints appeared for the first time -- both re-render once.
    expect(renders.a).toBe(2);
    expect(renders.b).toBe(2);

    act(() => {
      getSocket().emitMessage({
        type: "endpoints",
        // B's `sessionOpen` flips; A is byte-for-byte identical to the
        // previous snapshot.
        endpoints: [endpointFixture("A"), endpointFixture("B", { sessionOpen: true })],
        firmwareStatus: NO_FIRMWARE_STATUS,
      });
    });
    expect(renders.b).toBe(3);
    // A's entry is reused (structural sharing), so useEndpoint("A")'s
    // cached snapshot is unchanged -- no re-render.
    expect(renders.a).toBe(2);

    act(() => {
      getSocket().emitMessage({ type: "line", endpointId: "usb-B", direction: "rx", line: "hi" });
    });
    // A `line` message never touches `endpointsById` at all.
    expect(renders.a).toBe(2);
    expect(renders.b).toBe(3);
  });

  it("useEndpointLog(A) does not re-render on an endpoints snapshot update that leaves A's log untouched", () => {
    const renders = { a: 0 };

    function LogProbeA() {
      useEndpointLog("usb-A");
      renders.a += 1;
      return null;
    }

    const { getSocket } = mountWithSocket(<LogProbeA />);
    expect(renders.a).toBe(1);

    act(() => {
      getSocket().emitMessage({
        type: "endpoints",
        endpoints: [endpointFixture("A"), endpointFixture("B")],
        firmwareStatus: NO_FIRMWARE_STATUS,
      });
    });
    // The snapshot never writes to `logsByEndpoint` -- the cached empty
    // log reference is unchanged.
    expect(renders.a).toBe(1);

    act(() => {
      getSocket().emitMessage({
        type: "endpoints",
        endpoints: [endpointFixture("A", { sessionOpen: true }), endpointFixture("B")],
        firmwareStatus: NO_FIRMWARE_STATUS,
      });
    });
    expect(renders.a).toBe(1);

    act(() => {
      getSocket().emitMessage({ type: "line", endpointId: "usb-A", direction: "rx", line: "hello" });
    });
    // A line for A itself is the one thing that should cause a re-render.
    expect(renders.a).toBe(2);
  });
});

describe("hasSnapshot", () => {
  it("is false before the first endpoints message, true after, and stays true across a reconnect", () => {
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
      socket!.emitMessage({ type: "endpoints", endpoints: [], firmwareStatus: NO_FIRMWARE_STATUS });
    });
    expect(holder.value).toBe(true);

    // Simulate an unexpected drop: the fixed 1500ms reconnect timer
    // fires and a brand-new socket is constructed.
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
    // No new `endpoints` message has arrived on the reconnected socket
    // yet -- `hasSnapshot` must not have been reset by the close/retry.
    expect(holder.value).toBe(true);
  });
});

describe("hoisted log buffer", () => {
  it("appends in order, caps at MAX_LINES_PER_DEVICE dropping the oldest, independently per endpoint", () => {
    const logsA: LogEntry[][] = [];
    const logsB: LogEntry[][] = [];

    function ProbeA() {
      logsA.push(useEndpointLog("usb-A"));
      return null;
    }
    function ProbeB() {
      logsB.push(useEndpointLog("usb-B"));
      return null;
    }

    const { getSocket } = mountWithSocket(
      <>
        <ProbeA />
        <ProbeB />
      </>,
    );

    act(() => {
      for (let i = 0; i < MAX_LINES_PER_DEVICE + 5; i++) {
        getSocket().emitMessage({ type: "line", endpointId: "usb-A", direction: "rx", line: `n${i}` });
      }
      getSocket().emitMessage({ type: "line", endpointId: "usb-B", direction: "rx", line: "only-b" });
    });

    const finalA = logsA[logsA.length - 1]!;
    const finalB = logsB[logsB.length - 1]!;

    expect(finalA).toHaveLength(MAX_LINES_PER_DEVICE);
    // Oldest 5 (n0..n4) dropped from the front; newest is the last one
    // pushed.
    expect(finalA[0]!.line).toBe("n5");
    expect(finalA[finalA.length - 1]!.line).toBe(`n${MAX_LINES_PER_DEVICE + 4}`);
    expect(finalA.map((e) => e.direction)).toEqual(finalA.map(() => "rx"));

    // B's buffer is untouched by A's traffic.
    expect(finalB).toHaveLength(1);
    expect(finalB[0]!.line).toBe("only-b");
  });

  it("keeps only the MAX_TRACKED_ENDPOINT_LOGS most recently active endpoints' logs", () => {
    const results: Record<string, LogEntry[]> = {};

    function Probe({ id }: { id: string }) {
      results[id] = useEndpointLog(`usb-${id}`);
      return null;
    }

    const ids = Array.from({ length: MAX_TRACKED_ENDPOINT_LOGS + 1 }, (_, i) => `E${i}`);
    const { getSocket } = mountWithSocket(
      <>
        {ids.map((id) => (
          <Probe key={id} id={id} />
        ))}
      </>,
    );

    act(() => {
      for (const id of ids) {
        getSocket().emitMessage({ type: "line", endpointId: `usb-${id}`, direction: "rx", line: "hi" });
      }
    });

    // The least-recently-touched endpoint (the first one logged) was
    // evicted entirely once the (MAX_TRACKED_ENDPOINT_LOGS + 1)th
    // distinct endpoint logged a line.
    expect(results["E0"]).toEqual([]);
    // Every endpoint touched since then survives.
    for (let i = 1; i <= MAX_TRACKED_ENDPOINT_LOGS; i++) {
      expect(results[`E${i}`]).toHaveLength(1);
    }
  });
});

describe("useFlashProgress", () => {
  it("tracks live flash-progress events for a release source, and clears on flash-result", () => {
    const values: Array<ReturnType<typeof useFlashProgress>> = [];

    function Probe() {
      values.push(useFlashProgress("usb-A"));
      return null;
    }

    const { getSocket } = mountWithSocket(<Probe />);
    expect(values[values.length - 1]).toBeUndefined();

    act(() => {
      getSocket().emitMessage({
        type: "flash-progress",
        endpointId: "usb-A",
        source: { kind: "release", firmware: "relay" },
        phase: "writing",
      });
    });
    expect(values[values.length - 1]).toEqual({
      source: { kind: "release", firmware: "relay" },
      phase: "writing",
    });

    act(() => {
      getSocket().emitMessage({
        type: "flash-result",
        endpointId: "usb-A",
        source: { kind: "release", firmware: "relay" },
        status: "ok",
      });
    });
    expect(values[values.length - 1]).toBeUndefined();
  });

  it("tracks live flash-progress events for a local-hex source, which flashStatus cannot represent", () => {
    const values: Array<ReturnType<typeof useFlashProgress>> = [];

    function Probe() {
      values.push(useFlashProgress("usb-A"));
      return null;
    }

    const { getSocket } = mountWithSocket(<Probe />);

    act(() => {
      getSocket().emitMessage({
        type: "flash-progress",
        endpointId: "usb-A",
        source: { kind: "local-hex", uploadId: "u1", fileName: "custom.hex", sha256: "abc" },
        phase: "erasing",
      });
    });
    expect(values[values.length - 1]).toEqual({
      source: { kind: "local-hex", uploadId: "u1", fileName: "custom.hex", sha256: "abc" },
      phase: "erasing",
    });
  });
});

describe("useRememberedRobots", () => {
  it("is [] before any endpoints message, and the parsed rememberedRobots array after one", () => {
    const values: RememberedRobotEntry[][] = [];

    function Probe() {
      values.push(useRememberedRobots());
      return null;
    }

    const { getSocket } = mountWithSocket(<Probe />);
    expect(values[values.length - 1]).toEqual([]);

    const roster = [rememberedRobotFixture("alpha"), rememberedRobotFixture("bravo")];
    act(() => {
      getSocket().emitMessage({
        type: "endpoints",
        endpoints: [],
        firmwareStatus: NO_FIRMWARE_STATUS,
        rememberedRobots: roster,
      });
    });
    expect(values[values.length - 1]).toEqual(roster);
  });

  it("stays at the [] default (never undefined) when the very first endpoints message omits rememberedRobots", () => {
    const values: RememberedRobotEntry[][] = [];

    function Probe() {
      values.push(useRememberedRobots());
      return null;
    }

    const { getSocket } = mountWithSocket(<Probe />);
    act(() => {
      getSocket().emitMessage({ type: "endpoints", endpoints: [], firmwareStatus: NO_FIRMWARE_STATUS });
    });
    expect(values[values.length - 1]).toEqual([]);
  });

  it("keeps the previous value when a later endpoints message omits rememberedRobots entirely (an old-shaped host)", () => {
    const values: RememberedRobotEntry[][] = [];

    function Probe() {
      values.push(useRememberedRobots());
      return null;
    }

    const { getSocket } = mountWithSocket(<Probe />);

    const roster = [rememberedRobotFixture("alpha")];
    act(() => {
      getSocket().emitMessage({
        type: "endpoints",
        endpoints: [],
        firmwareStatus: NO_FIRMWARE_STATUS,
        rememberedRobots: roster,
      });
    });
    expect(values[values.length - 1]).toEqual(roster);

    // Simulate an old host (or a bare test fixture) that never sends
    // this field at all -- must not clobber the previous value with
    // `undefined`, and must not throw.
    act(() => {
      getSocket().emitMessage({
        type: "endpoints",
        endpoints: [],
        firmwareStatus: NO_FIRMWARE_STATUS,
      });
    });
    expect(values[values.length - 1]).toEqual(roster);
  });
});
