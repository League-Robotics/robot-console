// @vitest-environment jsdom
/**
 * DistanceCalibrationWizard.test.tsx — component tests for ticket 003's
 * distance-calibration wizard (SUC-003).
 *
 * Covers every acceptance criterion: the one-shot `FUNCS` probe on
 * mount, the `calx`-gated availability split into two distinct
 * "not asked yet" / "answered without calx" messages, the setup
 * instructions, the `RUN calx` dispatch on Go, progressive rendering of
 * `CALX:` lines via `CalibrationReport`, the terminal `apply` line
 * rendered verbatim as the snippet, a `CALX:fail` line's distinct
 * failure state (never a snippet), a `RUN` `err 1` reply's own distinct
 * state, and the regression check that no nudge/beam-pointer UI ever
 * appears in this panel.
 */
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { EndpointListEntry, RobotFunction } from "@robot-console/host/src/wsMessages.js";
import { DistanceCalibrationWizard, deriveBaselineDiameterMm, deriveWheelDiameterMm, wheelDiameterSnippet } from "./DistanceCalibrationWizard";
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

function baseDevice(
  functions: RobotFunction[] | undefined,
  overrides: Partial<EndpointListEntry> = {},
): EndpointListEntry {
  return {
    endpointId: "usb-ROBOT-A",
    transport: "usb",
    resourceKey: "usb-ROBOT-A",
    classification: { type: "robot", role: "NEZHA2", commonName: "robot", dialect: "space", evidence: "role", program: null, version: null },
    name: "zavaz",
    role: "NEZHA2",
    sessionOpen: true,
    usb: { serialNumber: "ROBOT-A-FULL", displaySerial: "0004", port: "/dev/cu.usbmodemC" },
    // `exactOptionalPropertyTypes` forbids `functions: undefined` -- the
    // key must be entirely absent to represent "no FUNCS sent yet".
    ...(functions !== undefined ? { functions } : {}),
    ...overrides,
  };
}

function mountWizard(device: EndpointListEntry): { el: HTMLDivElement; socket: FakeSocket } {
  let socket: FakeSocket | null = null;
  const el = mount(
    <WsProvider url="ws://test/" socketFactory={() => (socket = new FakeSocket())}>
      <DistanceCalibrationWizard device={device} />
    </WsProvider>,
  );
  act(() => {
    socket!.emitOpen();
  });
  return { el, socket: socket! };
}

/**
 * Mounts `WsProvider` with its socket already open *before* the wizard
 * ever renders, mirroring `CommandStrip.test.tsx`'s `mountReady` --
 * `sendCommand` only actually writes to the socket once it is open, so
 * a "fires on mount" assertion needs the socket open *before* the
 * mount effect runs, not mounted-then-opened (`mountWizard` above,
 * right for every other test here, which only asserts behavior *after*
 * an explicit action once the socket is already known-open).
 */
function mountReady(device: EndpointListEntry): { el: HTMLDivElement; socket: FakeSocket } {
  let socket: FakeSocket | null = null;
  const socketFactory = () => (socket = new FakeSocket());
  const url = "ws://test/";
  const el = mount(
    <WsProvider url={url} socketFactory={socketFactory}>
      <div />
    </WsProvider>,
  );
  act(() => {
    socket!.emitOpen();
  });
  // Re-render the *same* root/provider instance (same url/socketFactory
  // references) so WsProvider's connect effect does not re-run and the
  // now-open socket persists -- swapping in the real child only now.
  act(() => {
    root!.render(
      <WsProvider url={url} socketFactory={socketFactory}>
        <DistanceCalibrationWizard device={device} />
      </WsProvider>,
    );
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
    socket.emitMessage({ type: "line", endpointId: "usb-ROBOT-A", direction: "rx", line });
  });
}

describe("DistanceCalibrationWizard availability", () => {
  it("fires a one-shot FUNCS probe on mount when a session is already open", () => {
    const { socket } = mountReady(baseDevice(undefined));
    expect(socket.sent).toEqual([
      JSON.stringify({ type: "send-command", endpointId: "usb-ROBOT-A", verb: "FUNCS" }),
    ]);
  });

  it("shows an idle 'checking' message and disables Go before any FUNCS reply", () => {
    const { el } = mountWizard(baseDevice(undefined));
    expect(el.querySelector('[data-testid="distance-calibration-idle"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="distance-calibration-unavailable"]')).toBeNull();
    expect(el.querySelector<HTMLButtonElement>('[data-testid="distance-calibration-go"]')!.disabled).toBe(true);
  });

  it("shows the non-alarming unavailable message and keeps Go disabled when FUNCS answers without calx", () => {
    const { el } = mountWizard(baseDevice([{ name: "abort" }, { name: "sense" }]));
    const hint = el.querySelector('[data-testid="distance-calibration-unavailable"]');
    expect(hint).not.toBeNull();
    expect(hint!.textContent).toContain("doesn't support calibration yet");
    expect(el.querySelector('[data-testid="distance-calibration-idle"]')).toBeNull();
    expect(el.querySelector<HTMLButtonElement>('[data-testid="distance-calibration-go"]')!.disabled).toBe(true);
    // Never a spinner -- this is a plain status paragraph, not a
    // loading/progress element.
    expect(el.querySelector('[role="progressbar"]')).toBeNull();
  });

  it("shows the 90cm setup instructions and enables Go once calx is present", () => {
    const { el } = mountWizard(baseDevice([{ name: "calx" }, { name: "cala" }]));
    const setup = el.querySelector('[data-testid="distance-calibration-setup"]');
    expect(setup).not.toBeNull();
    expect(setup!.textContent).toContain("90 cm");
    expect(el.querySelector<HTMLButtonElement>('[data-testid="distance-calibration-go"]')!.disabled).toBe(false);
  });

  it("disables Go when there is no open session even with calx available", () => {
    const { el } = mountWizard(baseDevice([{ name: "calx" }], { sessionOpen: false }));
    expect(el.querySelector<HTMLButtonElement>('[data-testid="distance-calibration-go"]')!.disabled).toBe(true);
  });
});

describe("DistanceCalibrationWizard run dispatch", () => {
  it("sends RUN calx via sendCommand when Go is pressed", () => {
    const { el, socket } = mountWizard(baseDevice([{ name: "calx" }]));
    socket.sent.length = 0;
    clickGo(el);
    expect(socket.sent).toEqual([
      JSON.stringify({ type: "send-command", endpointId: "usb-ROBOT-A", verb: "RUN", fields: ["calx"] }),
    ]);
  });

  it("hides the setup instructions and disables Go once a run is in flight", () => {
    const { el } = mountWizard(baseDevice([{ name: "calx" }]));
    clickGo(el);
    expect(el.querySelector('[data-testid="distance-calibration-setup"]')).toBeNull();
    expect(el.querySelector<HTMLButtonElement>('[data-testid="distance-calibration-go"]')!.disabled).toBe(true);
  });
});

describe("DistanceCalibrationWizard progress rendering", () => {
  it("renders distinct, visible progress states as CALX: lines stream in -- not one generic spinner", () => {
    const { el, socket } = mountWizard(baseDevice([{ name: "calx" }]));
    clickGo(el);

    emitLine(socket, "CALX:begin true=90cm baseline=0.7878mm/deg");
    let progress = el.querySelector('[data-testid="distance-calibration-progress"]')!;
    expect(progress.textContent).toContain("begin true=90cm baseline=0.7878mm/deg");

    emitLine(socket, "CALX:start line found");
    progress = el.querySelector('[data-testid="distance-calibration-progress"]')!;
    expect(progress.textContent).toContain("start line found");
    // Both distinct lines are visible at once, not collapsed into one
    // generic "running" word.
    expect(progress.textContent).toContain("begin true=90cm baseline=0.7878mm/deg");
  });

  it("tolerates interleaved noise (acks, unrelated debug lines) without disturbing progress", () => {
    const { el, socket } = mountWizard(baseDevice([{ name: "calx" }]));
    clickGo(el);
    emitLine(socket, "ack 5 0 none");
    emitLine(socket, "CALX:begin true=90cm baseline=0.7878mm/deg");
    emitLine(socket, "DBG: loop=12");
    emitLine(socket, "CALX:start line found");

    const progress = el.querySelector('[data-testid="distance-calibration-progress"]')!;
    expect(progress.textContent).toContain("begin true=90cm baseline=0.7878mm/deg");
    expect(progress.textContent).toContain("start line found");
    expect(el.querySelector('[data-testid="distance-calibration-run-error"]')).toBeNull();
    expect(el.querySelector('[data-testid="distance-calibration-failed"]')).toBeNull();
  });
});

describe("DistanceCalibrationWizard terminal states", () => {
  it("OOP 2026-09-10: reports the wheel diameter from CALX:diameter and hands out code written in terms of that diameter", () => {
    const { el, socket } = mountWizard(baseDevice([{ name: "calx" }]));
    clickGo(el);
    emitLine(socket, "CALX:begin true=90cm baseline=0.7878mm/deg");
    emitLine(socket, "CALX:start line found");
    emitLine(socket, "CALX:measured=89.61cm true=90cm error=-0.39cm");
    emitLine(socket, "CALX:calib=0.7912 mm/deg  (was 0.7878)");
    emitLine(socket, "CALX:diameter=90.68 mm");
    emitLine(socket, "CALX:apply diffDrive.setWheelCalibration(0.7912)");

    const diameter = el.querySelector('[data-testid="distance-calibration-diameter"]')!;
    expect(diameter.textContent).toBe("Wheel diameter: 90.68 mm (was 90.28 mm)");
    const snippet = el.querySelector('[data-testid="distance-calibration-snippet"]')!;
    expect(snippet.textContent).toBe("diffDrive.setWheelCalibration(90.68 * Math.PI / 360)");
    expect(el.querySelector('[data-testid="distance-calibration-failed"]')).toBeNull();
    expect(el.querySelector('[data-testid="distance-calibration-run-error"]')).toBeNull();
    // Go re-enables so the student can run again if they want to.
    expect(el.querySelector<HTMLButtonElement>('[data-testid="distance-calibration-go"]')!.disabled).toBe(false);
  });

  it("renders a distinct failure state on a CALX:fail line, never a snippet", () => {
    const { el, socket } = mountWizard(baseDevice([{ name: "calx" }]));
    clickGo(el);
    emitLine(socket, "CALX:begin true=90cm baseline=0.7878mm/deg");
    emitLine(socket, "CALX:fail no start line within 60cm");

    const failed = el.querySelector('[data-testid="distance-calibration-failed"]')!;
    expect(failed).not.toBeNull();
    expect(failed.textContent).toContain("no start line within 60cm");
    expect(el.querySelector('[data-testid="distance-calibration-snippet"]')).toBeNull();
    expect(el.querySelector('[data-testid="distance-calibration-run-error"]')).toBeNull();
  });

  it("renders a distinct 'run rejected' state on a RUN err 1 reply, never confused with CALX:fail or unavailable", () => {
    const { el, socket } = mountWizard(baseDevice([{ name: "calx" }]));
    clickGo(el);
    emitLine(socket, "err 1 #1");

    const runError = el.querySelector('[data-testid="distance-calibration-run-error"]')!;
    expect(runError).not.toBeNull();
    expect(el.querySelector('[data-testid="distance-calibration-failed"]')).toBeNull();
    expect(el.querySelector('[data-testid="distance-calibration-unavailable"]')).toBeNull();
    expect(el.querySelector('[data-testid="distance-calibration-snippet"]')).toBeNull();
  });

  it("offers a Copy button alongside the snippet in the succeeded state", () => {
    const { el, socket } = mountWizard(baseDevice([{ name: "calx" }]));
    clickGo(el);
    emitLine(socket, "CALX:apply diffDrive.setWheelCalibration(0.8)");
    const copyButton = el.querySelector<HTMLButtonElement>('[data-testid="distance-calibration-copy"]');
    expect(copyButton).not.toBeNull();
    // Clicking must not throw even without a real Clipboard API in jsdom.
    expect(() => act(() => copyButton!.click())).not.toThrow();
  });
});

describe("DistanceCalibrationWizard wheel diameter derivation (OOP 2026-09-10)", () => {
  it("derives the diameter from an older build's apply line when no CALX:diameter line was sent", () => {
    expect(deriveWheelDiameterMm([], "diffDrive.setWheelCalibration(0.7912)")).toBe(90.66);
    expect(deriveWheelDiameterMm(["diameter=91.5 mm"], "diffDrive.setWheelCalibration(0.7912)")).toBe(91.5);
    expect(deriveWheelDiameterMm(["start line found"], "something else entirely")).toBeUndefined();
    expect(deriveBaselineDiameterMm(["begin true=90cm baseline=0.7878mm/deg"])).toBe(90.28);
    expect(wheelDiameterSnippet(90.68)).toBe("diffDrive.setWheelCalibration(90.68 * Math.PI / 360)");
  });

  it("falls back to the firmware's raw snippet, with no diameter line, when nothing derivable was sent", () => {
    const { el, socket } = mountWizard(baseDevice([{ name: "calx" }]));
    clickGo(el);
    emitLine(socket, "CALX:apply diffDrive.somethingNew(42)");
    expect(el.querySelector('[data-testid="distance-calibration-diameter"]')).toBeNull();
    expect(el.querySelector('[data-testid="distance-calibration-snippet"]')!.textContent).toBe("diffDrive.somethingNew(42)");
  });
});

describe("DistanceCalibrationWizard with the apply line dropped over WiFi (OOP 2026-09-10)", () => {
  it("reaches the result from CALX:calib + CALX:diameter when CALX:apply never arrives", () => {
    const { el, socket } = mountWizard(baseDevice([{ name: "calx" }]));
    clickGo(el);
    emitLine(socket, "CALX:begin true=90cm baseline=0.7878mm/deg");
    emitLine(socket, "CALX:measured=89.61cm true=90cm error=-0.39cm");
    emitLine(socket, "CALX:calib=0.7912 mm/deg  (was 0.7878)");
    expect(el.querySelector('[data-testid="distance-calibration-snippet"]')).toBeNull();
    emitLine(socket, "CALX:diameter=90.68 mm");
    expect(el.querySelector('[data-testid="distance-calibration-diameter"]')?.textContent).toBe("Wheel diameter: 90.68 mm (was 90.28 mm)");
    expect(el.querySelector('[data-testid="distance-calibration-snippet"]')?.textContent).toBe(
      "diffDrive.setWheelCalibration(90.68 * Math.PI / 360)",
    );
  });
});

describe("DistanceCalibrationWizard in a long-lived tab (OOP 2026-09-10 regression)", () => {
  it("still reaches the result when the log ring was already full at Go", () => {
    const { el, socket } = mountWizard(baseDevice([{ name: "calx" }]));
    act(() => {
      for (let i = 0; i < 520; i += 1) {
        socket.emitMessage({ type: "line", endpointId: "usb-ROBOT-A", direction: "rx", line: `status ready=1 cyc=${i}` });
      }
    });
    clickGo(el);
    emitLine(socket, "CALX:begin true=90cm baseline=0.7878mm/deg");
    emitLine(socket, "CALX:diameter=90.68 mm");
    emitLine(socket, "CALX:apply diffDrive.setWheelCalibration(0.7912)");
    expect(el.querySelector('[data-testid="distance-calibration-snippet"]')?.textContent).toBe(
      "diffDrive.setWheelCalibration(90.68 * Math.PI / 360)",
    );
  });
});

describe("DistanceCalibrationWizard regression: no nudge/beam-pointer UI", () => {
  it("never renders a nudge control or beam-pointer affordance in any state", () => {
    const { el, socket } = mountWizard(baseDevice([{ name: "calx" }]));
    expect(el.textContent).not.toMatch(/nudge/i);
    expect(el.textContent).not.toMatch(/beam/i);

    clickGo(el);
    emitLine(socket, "CALX:begin true=90cm baseline=0.7878mm/deg");
    expect(el.textContent).not.toMatch(/nudge/i);
    expect(el.textContent).not.toMatch(/beam/i);

    emitLine(socket, "CALX:apply diffDrive.setWheelCalibration(0.79)");
    expect(el.textContent).not.toMatch(/nudge/i);
    expect(el.textContent).not.toMatch(/beam/i);
  });
});
