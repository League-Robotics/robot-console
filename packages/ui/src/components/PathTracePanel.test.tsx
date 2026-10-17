// @vitest-environment jsdom
/**
 * PathTracePanel.test.tsx — sprint 9 ticket 005.
 *
 * Covers: a header-less mount renders the explicit "waiting for header"
 * state; a header missing `ox`/`oy` (e.g. radio-robot-lib's own POSE
 * column set) renders the explicit "not available on this firmware"
 * fallback instead of plotting garbage; a header carrying `ox`/`oy`/`oh`
 * plus a burst of frames drives the trail polyline and current-pose
 * marker after an rAF tick (`requestAnimationFrame` stubbed, mirroring
 * `ChartsPanel.test.tsx`), with the plotted points exactly equal to the
 * raw wire values (no scaling); Clear empties the trail and the
 * current-pose marker synchronously (no rAF flush needed) and sends no
 * wire command; and unmounting mid-flight cancels the pending rAF
 * callback rather than leaking it.
 */
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PathTracePanel } from "./PathTracePanel";
import { WsProvider } from "../ws/WsProvider";
import { FakeSocket } from "../testing/FakeSocket";

const LINK_ID = "usb-ROBOT-A";

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
      <PathTracePanel linkId={LINK_ID} />
    </WsProvider>,
  );
  act(() => {
    socket!.emitOpen();
  });
  return { el, socket: socket! };
}

function emitHeader(socket: FakeSocket, header: string[]): void {
  act(() => {
    socket.emitMessage({ type: "telemetry", linkId: LINK_ID, header });
  });
}

function emitFrame(socket: FakeSocket, fields: Record<string, string>): void {
  act(() => {
    socket.emitMessage({ type: "telemetry", linkId: LINK_ID, frame: fields });
  });
}

// --- requestAnimationFrame stub, mirroring ChartsPanel.test.tsx --------
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

/** Parse a `<polyline points="...">` attribute back into `{x, y}` pairs,
 * for asserting the plotted coordinates equal the raw wire values. */
function parsePoints(pointsAttr: string): Array<{ x: number; y: number }> {
  if (pointsAttr.trim() === "") {
    return [];
  }
  return pointsAttr
    .trim()
    .split(/\s+/)
    .map((pair) => {
      const [x, y] = pair.split(",").map(Number);
      return { x: x!, y: y! };
    });
}

describe("PathTracePanel — waiting for header", () => {
  it("renders an explicit waiting state before any header has arrived, with no plot", () => {
    const { el } = mountPanel();
    expect(el.querySelector('[data-testid="path-trace-panel-waiting"]')).not.toBeNull();
    expect(el.textContent).toMatch(/waiting/i);
    expect(el.querySelector('[data-testid="path-trace-plot"]')).toBeNull();
    expect(el.querySelector('[data-testid="trace-clear"]')).toBeNull();
  });
});

describe("PathTracePanel — header missing ox/oy", () => {
  it("renders the explicit 'not available on this firmware' fallback for a radio-robot-lib POSE header", () => {
    const { el, socket } = mountPanel();
    emitHeader(socket, ["seq", "now", "flags", "posl", "posr", "vell", "velr"]);

    expect(el.querySelector('[data-testid="path-trace-unavailable"]')).not.toBeNull();
    expect(el.textContent).toMatch(/not available on this firmware/i);
    expect(el.querySelector('[data-testid="path-trace-plot"]')).toBeNull();
    expect(el.querySelector('[data-testid="path-trace-panel-waiting"]')).toBeNull();
  });
});

describe("PathTracePanel — trail and current-pose marker with a known header", () => {
  it("accumulates ox/oy points unscaled and shows the current-pose marker after an rAF tick", () => {
    const { el, socket } = mountPanel();
    emitHeader(socket, ["seq", "now", "flags", "ox", "oy", "oh"]);

    expect(el.querySelector('[data-testid="path-trace-panel-waiting"]')).toBeNull();
    expect(el.querySelector('[data-testid="path-trace-unavailable"]')).toBeNull();
    expect(el.querySelector('[data-testid="path-trace-plot"]')).not.toBeNull();

    emitFrame(socket, { seq: "1", now: "1000", flags: "1", ox: "0", oy: "0", oh: "0" });
    emitFrame(socket, { seq: "2", now: "1010", flags: "1", ox: "15", oy: "-8", oh: "9000" });
    emitFrame(socket, { seq: "3", now: "1020", flags: "1", ox: "42", oy: "-3", oh: "18000" });

    // Before the queued rAF callback runs, the trail must not yet
    // reflect the new frames (no per-frame DOM write outside the draw
    // loop).
    const trail = el.querySelector('[data-testid="path-trace-trail"]')!;
    expect(trail.getAttribute("points")).toBe("");

    flushRaf();

    const points = parsePoints(trail.getAttribute("points") ?? "");
    expect(points).toEqual([
      { x: 0, y: 0 },
      { x: 15, y: -8 },
      { x: 42, y: -3 },
    ]);

    const currentPose = el.querySelector('[data-testid="path-trace-current-pose"]')!;
    expect((currentPose as HTMLElement).style.visibility).toBe("visible");
    expect(currentPose.getAttribute("cx")).toBe("42");
    expect(currentPose.getAttribute("cy")).toBe("-3");

    const headingTick = el.querySelector('[data-testid="path-trace-heading-tick"]')!;
    expect((headingTick as HTMLElement).style.visibility).toBe("visible");
    // oh=18000 centidegrees -> 180 degrees -> a tick pointing in -x from
    // the current pose; just assert it actually extends somewhere away
    // from the pose rather than collapsing to a zero-length segment.
    const x1 = Number(headingTick.getAttribute("x1"));
    const x2 = Number(headingTick.getAttribute("x2"));
    const y1 = Number(headingTick.getAttribute("y1"));
    const y2 = Number(headingTick.getAttribute("y2"));
    expect(x1 !== x2 || y1 !== y2).toBe(true);
  });

  it("plots the firmware pose (x/y/h) rather than the OTOS columns, which read 0 0 0 on a robot without the sensor", () => {
    const { el, socket } = mountPanel();
    emitHeader(socket, ["seq", "now", "flags", "x", "y", "h", "ox", "oy", "oh", "vl", "vr", "i2cf"]);
    const base = { seq: "1", now: "1000", flags: "1f", ox: "0", oy: "0", oh: "0", vl: "0", vr: "0", i2cf: "0" };
    emitFrame(socket, { ...base, x: "0", y: "0", h: "0" });
    emitFrame(socket, { ...base, x: "120", y: "35", h: "9000" });
    // The firmware's periodic re-announce of the same header must not
    // interrupt the trail.
    emitHeader(socket, ["seq", "now", "flags", "x", "y", "h", "ox", "oy", "oh", "vl", "vr", "i2cf"]);
    emitFrame(socket, { ...base, x: "130", y: "90", h: "9000" });
    flushRaf();

    const trail = el.querySelector('[data-testid="path-trace-trail"]')!;
    expect(parsePoints(trail.getAttribute("points") ?? "")).toEqual([
      { x: 0, y: 0 },
      { x: 120, y: 35 },
      { x: 130, y: 90 },
    ]);
    const currentPose = el.querySelector('[data-testid="path-trace-current-pose"]')!;
    expect(currentPose.getAttribute("cx")).toBe("130");
    expect(currentPose.getAttribute("cy")).toBe("90");
  });

  it("a burst of several frames still leaves the current pose reflecting only the latest one after a single rAF tick", () => {
    const { el, socket } = mountPanel();
    emitHeader(socket, ["seq", "ox", "oy"]);

    emitFrame(socket, { seq: "1", ox: "1", oy: "1" });
    emitFrame(socket, { seq: "2", ox: "2", oy: "2" });
    emitFrame(socket, { seq: "3", ox: "99", oy: "-42" });

    flushRaf();

    const currentPose = el.querySelector('[data-testid="path-trace-current-pose"]')!;
    expect(currentPose.getAttribute("cx")).toBe("99");
    expect(currentPose.getAttribute("cy")).toBe("-42");

    const trail = el.querySelector('[data-testid="path-trace-trail"]')!;
    expect(parsePoints(trail.getAttribute("points") ?? "").length).toBe(3);
  });
});

describe("PathTracePanel — Clear", () => {
  it("empties the trail and current-pose marker synchronously and sends no wire command", () => {
    const { el, socket } = mountPanel();
    emitHeader(socket, ["seq", "ox", "oy"]);
    emitFrame(socket, { seq: "1", ox: "10", oy: "20" });
    emitFrame(socket, { seq: "2", ox: "30", oy: "40" });
    flushRaf();

    const trail = el.querySelector('[data-testid="path-trace-trail"]')!;
    expect(parsePoints(trail.getAttribute("points") ?? "").length).toBe(2);

    expect(socket.sent).toEqual([]);

    act(() => {
      el.querySelector<HTMLButtonElement>('[data-testid="trace-clear"]')!.click();
    });

    // Emptied immediately -- no rAF flush needed for Clear's own effect.
    expect(trail.getAttribute("points")).toBe("");
    const currentPose = el.querySelector('[data-testid="path-trace-current-pose"]')!;
    expect((currentPose as HTMLElement).style.visibility).toBe("hidden");

    // Client-side reset only -- the robot has no notion of "clear", so
    // nothing is ever sent over the wire for this button.
    expect(socket.sent).toEqual([]);
  });
});

describe("PathTracePanel — Reset pose", () => {
  function mountWithLink(linkOpen: boolean): { el: HTMLDivElement; socket: FakeSocket } {
    let socket: FakeSocket | null = null;
    const el = mount(
      <WsProvider url="ws://test/" socketFactory={() => (socket = new FakeSocket())}>
        <PathTracePanel linkId={LINK_ID} linkOpen={linkOpen} />
      </WsProvider>,
    );
    act(() => {
      socket!.emitOpen();
    });
    return { el, socket: socket! };
  }

  it("sends SET rebase 1 and empties the trail; disabled without an open link", () => {
    const closed = mountWithLink(false);
    emitHeader(closed.socket, ["seq", "x", "y", "h"]);
    expect(closed.el.querySelector<HTMLButtonElement>('[data-testid="trace-reset-pose"]')!.disabled).toBe(true);
    unmount();

    const { el, socket } = mountWithLink(true);
    emitHeader(socket, ["seq", "x", "y", "h"]);
    emitFrame(socket, { seq: "1", x: "10", y: "20", h: "100" });
    flushRaf();
    const trail = el.querySelector('[data-testid="path-trace-trail"]')!;
    expect(parsePoints(trail.getAttribute("points") ?? "").length).toBe(1);

    act(() => {
      el.querySelector<HTMLButtonElement>('[data-testid="trace-reset-pose"]')!.click();
    });
    expect(socket.sent.map((raw) => JSON.parse(raw))).toEqual([
      { type: "send-command", linkId: LINK_ID, verb: "SET", fields: ["rebase", "1"] },
    ]);
    expect(trail.getAttribute("points")).toBe("");
    expect(el.querySelector('[data-testid="path-trace-pose-readout"]')!.textContent).toBe("x — · y — · heading —");
  });
});

describe("PathTracePanel — unmount cancels the rAF loop", () => {
  it("cancels a pending rAF callback on unmount instead of leaking it", () => {
    const { socket } = mountPanel();
    emitHeader(socket, ["seq", "ox", "oy"]);
    emitFrame(socket, { seq: "1", ox: "1", oy: "1" });

    expect(rafQueue.length).toBe(1);
    const pendingId = rafQueue[0]!.id;

    unmount();

    expect(cancelledRafIds.has(pendingId)).toBe(true);
    expect(rafQueue.length).toBe(0);

    expect(() => flushRaf()).not.toThrow();
  });
});

describe("PathTracePanel — waypoints and the pose readout", () => {
  function mountWithWaypoints(
    waypoints: Array<{ id: number; n: number; xMm: number; yMm: number; headingCentideg: number | undefined }>,
    selectedWaypointId: number | null,
    onSelectWaypoint: (id: number) => void,
  ): { el: HTMLDivElement; socket: FakeSocket } {
    let socket: FakeSocket | null = null;
    const el = mount(
      <WsProvider url="ws://test/" socketFactory={() => (socket = new FakeSocket())}>
        <PathTracePanel linkId={LINK_ID} waypoints={waypoints} selectedWaypointId={selectedWaypointId} onSelectWaypoint={onSelectWaypoint} />
      </WsProvider>,
    );
    act(() => {
      socket!.emitOpen();
    });
    return { el, socket: socket! };
  }

  it("draws each waypoint at its exact mm coordinates with a numbered cm label, marks the selected one, and clicking selects", () => {
    const onSelect = vi.fn();
    const { el, socket } = mountWithWaypoints(
      [
        { id: 1, n: 1, xMm: 300, yMm: -45, headingCentideg: 9000 },
        { id: 3, n: 3, xMm: -1234, yMm: 0, headingCentideg: undefined },
      ],
      3,
      onSelect,
    );
    emitHeader(socket, ["seq", "x", "y", "h"]);

    const first = el.querySelector('[data-testid="path-trace-waypoint-1"]')!;
    expect(first.querySelector("circle")!.getAttribute("cx")).toBe("300");
    expect(first.querySelector("circle")!.getAttribute("cy")).toBe("-45");
    expect(first.querySelector("text")!.textContent).toBe("1 (30.0, -4.5)");
    expect(first.getAttribute("data-selected")).toBe("false");

    const third = el.querySelector('[data-testid="path-trace-waypoint-3"]')!;
    expect(third.querySelector("text")!.textContent).toBe("3 (-123.4, 0.0)");
    expect(third.getAttribute("data-selected")).toBe("true");

    act(() => {
      (first as unknown as HTMLElement).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onSelect).toHaveBeenCalledWith(1);
  });

  it("reads out the current pose in cm and degrees after an rAF tick, and a dash before any frame", () => {
    const { el, socket } = mountWithWaypoints([], null, () => {});
    emitHeader(socket, ["seq", "x", "y", "h"]);
    const readout = el.querySelector('[data-testid="path-trace-pose-readout"]')!;
    expect(readout.textContent).toBe("x — · y — · heading —");

    emitFrame(socket, { seq: "1", x: "123", y: "-4", h: "8950" });
    flushRaf();
    expect(readout.textContent).toBe("x 12.3 cm · y -0.4 cm · heading 90°");
  });
});
