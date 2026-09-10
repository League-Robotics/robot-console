// @vitest-environment jsdom
/**
 * ChartsPanel.test.tsx — sprint 9 ticket 004.
 *
 * Covers: the mode buttons send the exact `TLM` wire command; a
 * header-less mount renders the explicit "waiting for header" state; a
 * header carrying this repo's own `vl`/`vr` wheel-speed columns plus a
 * burst of frames drives a visible bar/chart update after an rAF tick
 * (`requestAnimationFrame` stubbed, per the ticket's Testing section);
 * a header missing any known wheel-speed pair renders the explicit
 * fallback text instead of guessing; and unmounting mid-flight cancels
 * the pending rAF callback rather than leaking it.
 */
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChartsPanel } from "./ChartsPanel";
import { WsProvider } from "../ws/WsProvider";
import { FakeSocket } from "../testing/FakeSocket";

const ENDPOINT_ID = "usb-ROBOT-A";

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

function unmount(): void {
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
}

afterEach(() => {
  unmount();
});

function mountPanel(): { el: HTMLDivElement; socket: FakeSocket } {
  let socket: FakeSocket | null = null;
  const el = mount(
    <WsProvider url="ws://test/" socketFactory={() => (socket = new FakeSocket())}>
      <ChartsPanel endpointId={ENDPOINT_ID} />
    </WsProvider>,
  );
  act(() => {
    socket!.emitOpen();
  });
  return { el, socket: socket! };
}

function emitHeader(socket: FakeSocket, header: string[]): void {
  act(() => {
    socket.emitMessage({ type: "telemetry", endpointId: ENDPOINT_ID, header });
  });
}

function emitFrame(socket: FakeSocket, fields: Record<string, string>): void {
  act(() => {
    socket.emitMessage({ type: "telemetry", endpointId: ENDPOINT_ID, frame: fields });
  });
}

// --- requestAnimationFrame stub -----------------------------------
// `ChartsPanel` schedules a draw only once a frame has actually
// arrived (arrival-driven, not a perpetual per-frame timer -- see its
// own doc comment), so tests need full control over when a queued
// callback actually runs. `rafQueue` holds pending {id, callback}
// pairs in registration order; `flushRaf` runs and clears all of them,
// mirroring one real animation frame.
let rafQueue: Array<{ id: number; callback: FrameRequestCallback }> = [];
let nextRafId = 0;
let cancelledRafIds: Set<number> = new Set();

beforeEach(() => {
  rafQueue = [];
  nextRafId = 0;
  cancelledRafIds = new Set();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback): number => {
    nextRafId += 1;
    rafQueue.push({ id: nextRafId, callback });
    return nextRafId;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number): void => {
    cancelledRafIds.add(id);
    rafQueue = rafQueue.filter((entry) => entry.id !== id);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function flushRaf(): void {
  const pending = rafQueue;
  rafQueue = [];
  for (const entry of pending) {
    act(() => {
      entry.callback(0);
    });
  }
}

describe("ChartsPanel — subscribe control", () => {
  it("sends the exact TLM command for each mode button, and does not auto-subscribe on mount", () => {
    const { socket } = mountPanel();
    expect(socket.sent).toEqual([]);

    const el = container!;
    act(() => {
      el.querySelector<HTMLButtonElement>('[data-testid="telemetry-mode-pose"]')!.click();
    });
    expect(socket.sent).toEqual([
      JSON.stringify({ type: "send-command", endpointId: ENDPOINT_ID, verb: "TLM", fields: ["POSE"] }),
    ]);

    act(() => {
      el.querySelector<HTMLButtonElement>('[data-testid="telemetry-mode-full"]')!.click();
    });
    expect(socket.sent[1]).toEqual(
      JSON.stringify({ type: "send-command", endpointId: ENDPOINT_ID, verb: "TLM", fields: ["FULL"] }),
    );

    act(() => {
      el.querySelector<HTMLButtonElement>('[data-testid="telemetry-mode-off"]')!.click();
    });
    expect(socket.sent[2]).toEqual(
      JSON.stringify({ type: "send-command", endpointId: ENDPOINT_ID, verb: "TLM", fields: ["OFF"] }),
    );
  });
});

describe("ChartsPanel — waiting for header", () => {
  it("renders an explicit waiting state before any header has arrived, with no bars or chart", () => {
    const { el } = mountPanel();
    expect(el.querySelector('[data-testid="charts-panel-waiting"]')).not.toBeNull();
    expect(el.textContent).toMatch(/waiting/i);
    expect(el.querySelector('[data-testid="wheel-speed-bars"]')).toBeNull();
    expect(el.querySelector('[data-testid="telemetry-chart"]')).toBeNull();
  });
});

describe("ChartsPanel — wheel-speed bars and chart with a known header", () => {
  it("shows the wheel-speed bars and reflects the latest frame's values after an rAF tick", () => {
    const { el, socket } = mountPanel();
    emitHeader(socket, ["seq", "now", "flags", "x", "y", "h", "ox", "oy", "oh", "vl", "vr", "i2cf"]);

    expect(el.querySelector('[data-testid="charts-panel-waiting"]')).toBeNull();
    expect(el.querySelector('[data-testid="wheel-speed-bars"]')).not.toBeNull();

    emitFrame(socket, {
      seq: "1",
      now: "1000",
      flags: "1",
      x: "0",
      y: "0",
      h: "0",
      ox: "0",
      oy: "0",
      oh: "0",
      vl: "250",
      vr: "-120",
      i2cf: "0",
    });

    // Before the queued rAF callback runs, the DOM must not yet reflect
    // the new frame (no per-frame React state, no synchronous DOM
    // write outside the draw loop).
    expect(el.querySelector('[data-testid="wheel-speed-left-value"]')!.textContent).toBe("—");

    flushRaf();

    expect(el.querySelector('[data-testid="wheel-speed-left-value"]')!.textContent).toBe("250 mm/s");
    expect(el.querySelector('[data-testid="wheel-speed-right-value"]')!.textContent).toBe("-120 mm/s");

    const chart = el.querySelector('[data-testid="telemetry-chart"]');
    expect(chart).not.toBeNull();
    const linePaths = chart!.querySelectorAll("path.charts-panel-chart-line");
    expect(linePaths.length).toBeGreaterThan(0);
    // At least one plotted series must have produced a non-empty path.
    const anyDrawn = Array.from(linePaths).some((path) => (path.getAttribute("d") ?? "").length > 0);
    expect(anyDrawn).toBe(true);
  });

  it("a burst of several frames still leaves the bars reflecting only the latest one after a single rAF tick", () => {
    const { el, socket } = mountPanel();
    emitHeader(socket, ["seq", "vl", "vr"]);

    emitFrame(socket, { seq: "1", vl: "10", vr: "10" });
    emitFrame(socket, { seq: "2", vl: "20", vr: "20" });
    emitFrame(socket, { seq: "3", vl: "99", vr: "-42" });

    flushRaf();

    expect(el.querySelector('[data-testid="wheel-speed-left-value"]')!.textContent).toBe("99 mm/s");
    expect(el.querySelector('[data-testid="wheel-speed-right-value"]')!.textContent).toBe("-42 mm/s");
  });
});

describe("ChartsPanel — header missing wheel-speed columns", () => {
  it("renders the explicit fallback text instead of guessing a column", () => {
    const { el, socket } = mountPanel();
    emitHeader(socket, ["seq", "now", "flags", "x", "y", "h"]);

    expect(el.querySelector('[data-testid="wheel-speed-unavailable"]')).not.toBeNull();
    expect(el.textContent).toMatch(/no wheel-speed columns/i);
    expect(el.querySelector('[data-testid="wheel-speed-bars"]')).toBeNull();
  });

  it("still charts the time series from the header's own columns even without a wheel-speed pair", () => {
    const { el, socket } = mountPanel();
    emitHeader(socket, ["seq", "now", "flags", "x", "y", "h"]);
    expect(el.querySelector('[data-testid="telemetry-chart"]')).not.toBeNull();
  });
});

describe("ChartsPanel — unmount cancels the rAF loop", () => {
  it("cancels a pending rAF callback on unmount instead of leaking it", () => {
    const { socket } = mountPanel();
    emitHeader(socket, ["seq", "vl", "vr"]);
    emitFrame(socket, { seq: "1", vl: "10", vr: "10" });

    expect(rafQueue.length).toBe(1);
    const pendingId = rafQueue[0]!.id;

    unmount();

    expect(cancelledRafIds.has(pendingId)).toBe(true);
    expect(rafQueue.length).toBe(0);

    // Flushing after unmount must be a no-op (nothing left to call) --
    // proves no dangling callback survives to run against a torn-down
    // component.
    expect(() => flushRaf()).not.toThrow();
  });
});
