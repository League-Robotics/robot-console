// @vitest-environment jsdom
/**
 * DistanceCalibrationWizard.test.tsx — component tests for the
 * wheel-travel-calibration wizard (rewritten OOP 2026-09-18 for the
 * current `calwheels` firmware; see `DistanceCalibrationWizard.tsx`'s
 * own doc comment).
 *
 * Covers: `calwheels`-known-missing shows a non-blocking hint but never
 * disables Go, the editable tape-measured `cm` argument (default 90.5),
 * the `RUN calwheels <cm>` dispatch on Go, progressive rendering of
 * non-terminal JSON events, the terminal `.result` line rendered as a
 * diameter with no Apply control anywhere, a `.fail` line's distinct
 * failure state, a malformed `.result` line's distinct "unreadable"
 * state (never a confident wrong number), a `RUN` `err 1` reply's own
 * distinct state, drop-tolerance (missing `.quality`/`.span` never
 * blocks `.result`), and the regression check that no nudge/beam-pointer
 * UI ever appears in this panel.
 */
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { RobotFunction, SnapshotLink } from "@robot-console/host/src/wsMessages.js";
import { DistanceCalibrationWizard, deriveWheelsCalibrationRun, wheelDiameterSnippet } from "./DistanceCalibrationWizard";
import { WsProvider } from "../ws/WsProvider";
import { FakeSocket } from "../testing/FakeSocket";

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
});

const LINK_ID = "usb-ROBOT-A";

function linkWithFunctions(functions: RobotFunction[] | undefined, overrides: Partial<SnapshotLink> = {}): SnapshotLink {
  return {
    id: LINK_ID,
    transport: "usb",
    label: "USB · /dev/cu.usbmodemC",
    state: "connected",
    reason: null,
    since: 0,
    lastSeen: 0,
    nextRetryAt: null,
    capabilities: { open: false, close: true, flash: true, provisionWifi: true },
    session: { seq: 0, pending: 0, lastDone: null, lastDoneReason: null, robotStatus: null, functions: functions ?? null },
    ...overrides,
  };
}

function closedLink(): SnapshotLink {
  return {
    id: LINK_ID,
    transport: "usb",
    label: "USB · /dev/cu.usbmodemC",
    state: "connectable",
    reason: null,
    since: 0,
    lastSeen: 0,
    nextRetryAt: null,
    capabilities: { open: true, close: false, flash: true, provisionWifi: false },
  };
}

function mountWizard(link: SnapshotLink): { el: HTMLDivElement; socket: FakeSocket } {
  let socket: FakeSocket | null = null;
  const el = mount(
    <WsProvider url="ws://test/" socketFactory={() => (socket = new FakeSocket())}>
      <DistanceCalibrationWizard link={link} />
    </WsProvider>,
  );
  act(() => {
    socket!.emitOpen();
  });
  return { el, socket: socket! };
}

function clickGo(el: HTMLDivElement): void {
  act(() => {
    el.querySelector<HTMLButtonElement>('[data-testid="distance-calibration-go"]')!.click();
  });
}

function emitLine(socket: FakeSocket, line: string): void {
  act(() => {
    socket.emitMessage({ type: "line", linkId: LINK_ID, direction: "rx", line });
  });
}

describe("DistanceCalibrationWizard availability", () => {
  it("before any FUNCS reply the Go button is present and enabled (an unanswered FUNCS never blocks the run)", () => {
    const { el } = mountWizard(linkWithFunctions(undefined));
    expect(el.querySelector('[data-testid="distance-calibration-idle"]')).toBeNull();
    expect(el.querySelector('[data-testid="distance-calibration-unavailable"]')).toBeNull();
    const go = el.querySelector<HTMLButtonElement>('[data-testid="distance-calibration-go"]')!;
    expect(go.textContent).toBe("Calibrate wheels");
    expect(go.disabled).toBe(false);
  });

  it("a FUNCS reply missing calwheels shows a non-blocking hint and leaves Go enabled", () => {
    const { el } = mountWizard(linkWithFunctions([{ name: "abort" }, { name: "sense" }]));
    const hint = el.querySelector('[data-testid="distance-calibration-unavailable"]');
    expect(hint).not.toBeNull();
    expect(hint!.textContent).toContain("didn't include calwheels");
    expect(el.querySelector<HTMLButtonElement>('[data-testid="distance-calibration-go"]')!.disabled).toBe(false);
    expect(el.querySelector('[role="progressbar"]')).toBeNull();
  });

  it("shows the setup instructions and a cm input defaulting to 90.5, and enables Go once calwheels is present", () => {
    const { el } = mountWizard(linkWithFunctions([{ name: "calwheels" }, { name: "calturn" }]));
    expect(el.querySelector('[data-testid="distance-calibration-setup"]')).not.toBeNull();
    expect(el.querySelector<HTMLInputElement>('[data-testid="distance-calibration-cm"]')!.value).toBe("90.5");
    expect(el.querySelector<HTMLButtonElement>('[data-testid="distance-calibration-go"]')!.disabled).toBe(false);
  });

  it("disables Go when there is no open session even with calwheels available", () => {
    const { el } = mountWizard(closedLink());
    expect(el.querySelector<HTMLButtonElement>('[data-testid="distance-calibration-go"]')!.disabled).toBe(true);
  });

  it("disables Go when the cm field is blanked -- the tape measurement must be right, not silently defaulted", () => {
    const { el } = mountWizard(linkWithFunctions([{ name: "calwheels" }]));
    const input = el.querySelector<HTMLInputElement>('[data-testid="distance-calibration-cm"]')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    act(() => {
      setter.call(input, "");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(el.querySelector<HTMLButtonElement>('[data-testid="distance-calibration-go"]')!.disabled).toBe(true);
  });
});

describe("DistanceCalibrationWizard run dispatch", () => {
  it("sends RUN calwheels with the default 90.5 cm when Go is pressed without changing the input", () => {
    const { el, socket } = mountWizard(linkWithFunctions([{ name: "calwheels" }]));
    socket.sent.length = 0;
    clickGo(el);
    // The trailing "0" is the wheel argument: 0 means "unknown", which
    // is the default and the normal case (calibration-0.20260919.2).
    expect(socket.sent).toEqual([
      JSON.stringify({ type: "send-command", linkId: LINK_ID, verb: "RUN", fields: ["calwheels", "90.5", "0"] }),
    ]);
  });

  it("sends the edited cm value when Go is pressed", () => {
    const { el, socket } = mountWizard(linkWithFunctions([{ name: "calwheels" }]));
    const input = el.querySelector<HTMLInputElement>('[data-testid="distance-calibration-cm"]')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    act(() => {
      setter.call(input, "120");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    socket.sent.length = 0;
    clickGo(el);
    expect(socket.sent).toEqual([
      JSON.stringify({ type: "send-command", linkId: LINK_ID, verb: "RUN", fields: ["calwheels", "120", "0"] }),
    ]);
  });

  it("hides the setup instructions and disables Go once a run is in flight", () => {
    const { el } = mountWizard(linkWithFunctions([{ name: "calwheels" }]));
    clickGo(el);
    expect(el.querySelector('[data-testid="distance-calibration-setup"]')).toBeNull();
    expect(el.querySelector<HTMLButtonElement>('[data-testid="distance-calibration-go"]')!.disabled).toBe(true);
  });
});

describe("DistanceCalibrationWizard progress rendering and drop tolerance", () => {
  it("renders non-terminal JSON events as they stream in", () => {
    const { el, socket } = mountWizard(linkWithFunctions([{ name: "calwheels" }]));
    clickGo(el);
    emitLine(socket, '{"ev":"calwheels.span","start":1,"finish":2}');
    const progress = el.querySelector('[data-testid="distance-calibration-progress"]')!;
    expect(progress.textContent).toContain("calwheels.span");
  });

  it("tolerates interleaved noise (acks, unrelated debug lines, a different verb's own lines) without disturbing progress", () => {
    const { el, socket } = mountWizard(linkWithFunctions([{ name: "calwheels" }]));
    clickGo(el);
    emitLine(socket, "ack 5 0 none");
    emitLine(socket, "DBG: loop=12");
    emitLine(socket, '{"ev":"calturn.ch","i":0,"n":10}');
    emitLine(socket, '{"ev":"calwheels.span","start":1,"finish":2}');
    const progress = el.querySelector('[data-testid="distance-calibration-progress"]')!;
    expect(progress.textContent).toContain("calwheels.span");
    expect(el.querySelector('[data-testid="distance-calibration-run-error"]')).toBeNull();
    expect(el.querySelector('[data-testid="distance-calibration-failed"]')).toBeNull();
  });

  it("reaches .result even when .quality/.span never arrived (dropped over Wi-Fi) -- never requires an expected line", () => {
    const { el, socket } = mountWizard(linkWithFunctions([{ name: "calwheels" }]));
    clickGo(el);
    emitLine(socket, '{"ev":"calwheels.result","calib":0.7912,"diameter":90.68,"measured":89.61,"true":90,"error":-0.39,"was":0.7878}');
    expect(el.querySelector('[data-testid="distance-calibration-diameter"]')?.textContent).toBe("Wheel diameter: 90.68 mm (was 90.28 mm)");
  });
});

describe("DistanceCalibrationWizard terminal states", () => {
  it("reports the wheel diameter from calwheels.result, with no Apply control anywhere on the panel", () => {
    const { el, socket } = mountWizard(linkWithFunctions([{ name: "calwheels" }]));
    clickGo(el);
    emitLine(socket, '{"ev":"calwheels.span","start":1,"finish":2}');
    emitLine(socket, '{"ev":"calwheels.result","calib":0.7912,"diameter":90.68,"measured":89.61,"true":90,"error":-0.39,"was":0.7878}');

    expect(el.querySelector('[data-testid="distance-calibration-diameter"]')!.textContent).toBe("Wheel diameter: 90.68 mm (was 90.28 mm)");
    expect(el.querySelector('[data-testid="distance-calibration-snippet"]')!.textContent).toBe(
      "diffDrive.setWheelCalibration(90.68 * Math.PI / 360)",
    );
    expect(el.querySelector('[data-testid="distance-calibration-no-apply"]')).not.toBeNull();
    // No Apply control of any kind -- not a disabled one, not one that errors.
    expect(el.textContent).not.toMatch(/apply/i);
    expect(el.querySelector('[data-testid="distance-calibration-failed"]')).toBeNull();
    expect(el.querySelector('[data-testid="distance-calibration-run-error"]')).toBeNull();
    expect(el.querySelector('[data-testid="distance-calibration-unreadable"]')).toBeNull();
    // Go re-enables so the student can run again if they want to.
    expect(el.querySelector<HTMLButtonElement>('[data-testid="distance-calibration-go"]')!.disabled).toBe(false);
  });

  it("profile calibration-0.20260919.4: stored:1 says the robot is already running this, still with no Apply control", () => {
    const { el, socket } = mountWizard(linkWithFunctions([{ name: "calwheels" }]));
    clickGo(el);
    emitLine(
      socket,
      '{"ev":"calwheels.result","calib":0.7912,"diameter":90.68,"measured":89.61,"true":90,"error":-0.39,"was":0.7878,"stored":1}',
    );
    expect(el.querySelector('[data-testid="distance-calibration-stored"]')?.textContent).toContain("power cycle");
    expect(el.querySelector('[data-testid="distance-calibration-no-apply"]')).toBeNull();
    expect(el.textContent).not.toMatch(/apply/i);
  });

  it("stored absent (older firmware) keeps the original 'can't be applied live' text, never a fabricated stored claim", () => {
    const { el, socket } = mountWizard(linkWithFunctions([{ name: "calwheels" }]));
    clickGo(el);
    emitLine(socket, '{"ev":"calwheels.result","calib":0.7912,"diameter":90.68,"measured":89.61,"true":90,"error":-0.39,"was":0.7878}');
    expect(el.querySelector('[data-testid="distance-calibration-no-apply"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="distance-calibration-stored"]')).toBeNull();
  });

  it("renders a distinct failure state on a calwheels.fail line, never a snippet", () => {
    const { el, socket } = mountWizard(linkWithFunctions([{ name: "calwheels" }]));
    clickGo(el);
    emitLine(socket, '{"ev":"calwheels.fail","why":"no start line within 60cm","measured":10.5,"true":90.2}');

    const failed = el.querySelector('[data-testid="distance-calibration-failed"]')!;
    expect(failed).not.toBeNull();
    expect(failed.textContent).toContain("no start line within 60cm");
    expect(el.querySelector('[data-testid="distance-calibration-snippet"]')).toBeNull();
    expect(el.querySelector('[data-testid="distance-calibration-run-error"]')).toBeNull();
  });

  it("a bare fail with no why text still fails cleanly with a generic reason, never crashing or fabricating one", () => {
    const { el, socket } = mountWizard(linkWithFunctions([{ name: "calwheels" }]));
    clickGo(el);
    emitLine(socket, '{"ev":"calwheels.fail"}');
    expect(el.querySelector('[data-testid="distance-calibration-failed"]')?.textContent).toContain("no reason given");
  });

  it("renders a distinct 'unreadable' state -- never a confident wrong number -- when .result's fields don't validate", () => {
    const { el, socket } = mountWizard(linkWithFunctions([{ name: "calwheels" }]));
    clickGo(el);
    emitLine(socket, '{"ev":"calwheels.result","calib":0.7912,"diameter":"ninety"}');
    expect(el.querySelector('[data-testid="distance-calibration-unreadable"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="distance-calibration-diameter"]')).toBeNull();
    expect(el.querySelector('[data-testid="distance-calibration-failed"]')).toBeNull();
  });

  it("renders a distinct 'run rejected' state on a RUN err 1 reply, never confused with .fail or unavailable", () => {
    const { el, socket } = mountWizard(linkWithFunctions([{ name: "calwheels" }]));
    clickGo(el);
    emitLine(socket, "err 1 #1");

    const runError = el.querySelector('[data-testid="distance-calibration-run-error"]')!;
    expect(runError).not.toBeNull();
    expect(el.querySelector('[data-testid="distance-calibration-failed"]')).toBeNull();
    expect(el.querySelector('[data-testid="distance-calibration-unavailable"]')).toBeNull();
    expect(el.querySelector('[data-testid="distance-calibration-snippet"]')).toBeNull();
  });
});

describe("DistanceCalibrationWizard in a long-lived tab (log ring regression)", () => {
  it("still reaches the result when the log ring was already full at Go", () => {
    const { el, socket } = mountWizard(linkWithFunctions([{ name: "calwheels" }]));
    act(() => {
      for (let i = 0; i < 520; i += 1) {
        socket.emitMessage({ type: "line", linkId: LINK_ID, direction: "rx", line: `status ready=1 cyc=${i}` });
      }
    });
    clickGo(el);
    emitLine(socket, '{"ev":"calwheels.result","calib":0.7912,"diameter":90.68,"measured":89.61,"true":90,"error":-0.39,"was":0.7878}');
    expect(el.querySelector('[data-testid="distance-calibration-diameter"]')?.textContent).toBe("Wheel diameter: 90.68 mm (was 90.28 mm)");
  });
});

describe("DistanceCalibrationWizard regression: no nudge/beam-pointer UI", () => {
  it("never renders a nudge control or beam-pointer affordance in any state", () => {
    const { el, socket } = mountWizard(linkWithFunctions([{ name: "calwheels" }]));
    expect(el.textContent).not.toMatch(/nudge/i);
    expect(el.textContent).not.toMatch(/beam/i);

    clickGo(el);
    emitLine(socket, '{"ev":"calwheels.span","start":1,"finish":2}');
    expect(el.textContent).not.toMatch(/nudge/i);
    expect(el.textContent).not.toMatch(/beam/i);

    emitLine(socket, '{"ev":"calwheels.result","calib":0.7912,"diameter":90.68,"measured":89.61,"true":90,"error":-0.39,"was":0.7878}');
    expect(el.textContent).not.toMatch(/nudge/i);
    expect(el.textContent).not.toMatch(/beam/i);
  });
});

describe("deriveWheelsCalibrationRun (pure derivation)", () => {
  it("tolerates an empty slice without throwing, falling back to an empty running state", () => {
    expect(deriveWheelsCalibrationRun([])).toEqual({ kind: "running", events: [] });
  });

  it("wheelDiameterSnippet writes the literal π·D/360 conversion, not a pre-multiplied constant", () => {
    expect(wheelDiameterSnippet(90.68)).toBe("diffDrive.setWheelCalibration(90.68 * Math.PI / 360)");
  });

  it("ignores a different verb's own result/fail lines entirely", () => {
    const run = deriveWheelsCalibrationRun([
      { direction: "rx", line: '{"ev":"calturn.result","b":1,"tw":1,"slip":1}' },
      { direction: "rx", line: '{"ev":"calturn.fail","why":"nope"}' },
    ]);
    expect(run).toEqual({ kind: "running", events: [] });
  });
});

describe("calwheels.fail diagnostics (nezha-robot-template efa5a6f)", () => {
  // The firmware's old guard refused any result more than 10% from the
  // stock 90 mm wheel, so a robot with swapped wheels was refused for
  // being RIGHT -- which is the red banner the stakeholder hit. The new
  // guard checks the answer's plausibility instead, and reports the
  // wheel diameter the run's own endpoints imply. That number is the
  // diagnostic: a bad start once implied 778 mm.
  it("shows the implied wheel diameter and accepted span when the firmware reports them", () => {
    const run = deriveWheelsCalibrationRun([
      {
        direction: "rx",
        line: '{"ev":"calwheels.fail","why":"no wheel that fits this chassis could have driven that","implied":778,"lo":40.2,"hi":120.6,"wheel":"unknown"}',
      },
    ]);
    expect(run.kind).toBe("failed");
    if (run.kind !== "failed") return;
    expect(run.why).toBe("no wheel that fits this chassis could have driven that");
    expect(run.implied).toBe(778);
    expect(run.lo).toBe(40.2);
    expect(run.hi).toBe(120.6);
  });

  it("still fails cleanly when the firmware sends no diagnostics at all", () => {
    // Older firmware -- and the release the Flash button currently
    // fetches is still the old one, so this path is live today.
    const run = deriveWheelsCalibrationRun([
      { direction: "rx", line: '{"ev":"calwheels.fail","why":"measured distance is nowhere near true"}' },
    ]);
    expect(run.kind).toBe("failed");
    if (run.kind !== "failed") return;
    expect(run.why).toBe("measured distance is nowhere near true");
    expect(run.implied).toBeUndefined();
  });

  it("ignores a non-numeric implied rather than rendering it", () => {
    const run = deriveWheelsCalibrationRun([
      { direction: "rx", line: '{"ev":"calwheels.fail","why":"bad","implied":"lots"}' },
    ]);
    expect(run.kind).toBe("failed");
    if (run.kind !== "failed") return;
    expect(run.implied).toBeUndefined();
  });
});

function typeInto(el: HTMLDivElement, testid: string, value: string): void {
  const input = el.querySelector<HTMLInputElement>(`[data-testid="${testid}"]`)!;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("wheel declaration (calibration-0.20260919.2)", () => {
  // `calwheels (cm, wheel)` -- wheel in mm, 0 meaning unknown. Unknown
  // is the default and the normal case: the firmware's old guard
  // refused any answer more than 10% from the stock 90 mm wheel, so a
  // swapped-wheel robot was refused for measuring correctly.
  function sentFields(socket: { sent: string[] }): unknown {
    return JSON.parse(socket.sent.at(-1)!).fields;
  }

  it("sends 0 for the wheel when the field is left blank", () => {
    const { el, socket } = mountWizard(linkWithFunctions([{ name: "calwheels" }]));
    socket.sent.length = 0;
    clickGo(el);
    expect(sentFields(socket)).toEqual(["calwheels", "90.5", "0"]);
  });

  it("sends the declared wheel diameter when one is typed", () => {
    const { el, socket } = mountWizard(linkWithFunctions([{ name: "calwheels" }]));
    typeInto(el, "distance-calibration-wheel", "64");
    socket.sent.length = 0;
    clickGo(el);
    expect(sentFields(socket)).toEqual(["calwheels", "90.5", "64"]);
  });

  it("treats a junk wheel entry as unknown rather than sending it", () => {
    const { el, socket } = mountWizard(linkWithFunctions([{ name: "calwheels" }]));
    typeInto(el, "distance-calibration-wheel", "abc");
    socket.sent.length = 0;
    clickGo(el);
    expect(sentFields(socket)).toEqual(["calwheels", "90.5", "0"]);
  });
});
