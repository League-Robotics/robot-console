// @vitest-environment jsdom
/**
 * RobotPage.test.tsx — integration-level rendering tests for the robot
 * page (ticket 012-005 / SUC-001, SUC-003, SUC-004, SUC-006, SUC-007;
 * migrated to the `Snapshot` contract, sprint 015 ticket 009).
 *
 * This ticket replaces the sprint 006 single-column shell (three
 * separate response areas reading the same rx log, one of them -- the
 * retired Get/Set panel -- with a real `-1`-watermark bug) with a two-column
 * layout: left column `DriveControls` + `SequencingIndicator` + a
 * stubbed charts placeholder; right column exactly one `DeviceConsole`
 * with `CommandStrip` beneath it. STOP/E-STOP (out-of-process,
 * 2026-09-10) no longer have a separate sticky `EstopControl` sibling --
 * they render inside `DriveControls`'s own pad in the left column; see
 * `DriveControls.test.tsx` for their behavior.
 *
 * Focused per-component behavior lives in each component's own test
 * file (`DriveControls.test.tsx`, `SequencingIndicator.test.tsx`,
 * `CommandStrip.test.tsx`); this file proves the page assembles them
 * correctly, that the layout's structural constraints hold (no second
 * console/reply region anywhere on the page, `EstopControl` not nested
 * inside either column's scroll container), and that a host `notice`
 * routed by ticket 012-003 (now `type: "notice"`, ticket 004) actually
 * surfaces here. `RobotPage.transportBlind.test.ts` separately enforces
 * the transport-blindness property with a source scan.
 */
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { Snapshot, SnapshotDevice, SnapshotLink } from "@robot-console/host/src/wsMessages.js";
import { RobotPage } from "./RobotPage";
import { AppHeader } from "../components/AppHeader";
import { WsProvider } from "../ws/WsProvider";
import { FakeSocket } from "../testing/FakeSocket";
import { withRouter } from "../testing/renderWithRouter";
import robotPageCssSource from "./RobotPage.css?raw";

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

function robotLink(overrides: Partial<SnapshotLink> = {}): SnapshotLink {
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
    session: { seq: 0, pending: 0, lastDone: null, lastDoneReason: null, robotStatus: null, functions: null },
    ...overrides,
  };
}

function robotDevice(overrides: Partial<Omit<SnapshotDevice, "links">> = {}): SnapshotDevice {
  return {
    id: 1,
    name: "vevav",
    kind: "robot",
    role: "NEZHA2",
    commonName: null,
    program: null,
    version: null,
    owned: true,
    radio: { channel: 1, group: 1, source: "derived" },
    lastSeen: 0,
    lastChecked: null,
    links: [robotLink()],
    ...overrides,
  };
}

function snapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    type: "snapshot",
    seq: 1,
    at: 0,
    devices: [],
    unassigned: [],
    relays: [],
    firmware: { relay: { configured: false }, robot: { configured: false } },
    wifi: { ssid: null, source: null },
    tasks: [],
    ...overrides,
  };
}

function mountRobotPage(device: SnapshotDevice = robotDevice()): { el: HTMLDivElement; socket: FakeSocket } {
  let socket: FakeSocket | null = null;
  const el = mount(
    <WsProvider url="ws://test/" socketFactory={() => (socket = new FakeSocket())}>
      <RobotPage device={device} link={device.links[0]!} />
    </WsProvider>,
  );
  act(() => {
    socket!.emitOpen();
  });
  return { el, socket: socket! };
}

describe("RobotPage", () => {
  it("renders a header with the device's name", () => {
    const { el } = mountRobotPage(robotDevice());
    expect(el.textContent).toContain("vevav");
  });

  it("OOP 2026-09-10: the Main tab shows status and drive on the left, console (with sequencing at its top) and command strip on the right", () => {
    const { el } = mountRobotPage();
    const left = el.querySelector(".robot-page-column-left");
    expect(left).not.toBeNull();
    expect(left!.querySelector('[aria-label="Robot status"]')).not.toBeNull();
    expect(left!.querySelector('[aria-label="Drive controls"]')).not.toBeNull();
    expect(Array.from(left!.querySelectorAll("h3")).map((h) => h.textContent)).toEqual(["Status", "Drive"]);
    const consoleEl = el.querySelector('[aria-label="Console"]')!;
    expect(consoleEl.querySelector('[aria-label="Sequencing state"]')).not.toBeNull();
    // Sequencing precedes the log inside the console.
    const seq = consoleEl.querySelector('[aria-label="Sequencing state"]')!;
    const log = consoleEl.querySelector('[data-testid="console-log"]')!;
    expect(seq.compareDocumentPosition(log) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Nothing from the other tabs is mounted.
    expect(el.querySelector('[aria-label="Functions"]')).toBeNull();
    expect(el.querySelector('[aria-label="Charts"]')).toBeNull();
    expect(el.querySelector('[aria-label="Distance calibration"]')).toBeNull();
    expect(el.textContent).not.toContain("Showing up to");
    expect(el.textContent).not.toContain("Hold a direction");
  });

  it("ticket 018-013: tabs sit beside the name; every robot (including a plain, non-calibration one) gets Main, Drive, Calibration, Configuration and Diagnostics", () => {
    const { el } = mountRobotPage();
    const row = el.querySelector(".robot-page-title-row")!;
    expect(row.querySelector("h2")?.textContent).toBe("vevav");
    expect(Array.from(row.querySelectorAll('[role="tab"]')).map((t) => t.textContent)).toEqual([
      "Main",
      "Drive",
      "Calibration",
      "Configuration",
      "Diagnostics",
    ]);
    expect(el.querySelector('[data-testid="robot-tab-main"]')?.getAttribute("aria-selected")).toBe("true");
  });

  it("OOP 2026-09-14: the Drive tab (Functions & charts folded in) has the pad, keyboard/gamepad aids and a viewport-bound console on the left, and functions, charts and path trace on the right", () => {
    const { el } = mountRobotPage();
    act(() => {
      el.querySelector<HTMLButtonElement>('[data-testid="robot-tab-drive"]')!.click();
    });
    expect(el.querySelector('[data-testid="robot-tab-panel-main"]')).toBeNull();
    const left = el.querySelector(".robot-page-column-left")!;
    const right = el.querySelector(".robot-page-column-right")!;
    expect(left.classList.contains("robot-page-column-console")).toBe(true);
    expect(left.querySelector('[aria-label="Drive controls"]')).not.toBeNull();
    expect(left.querySelector('[data-testid="drive-tab-keyboard"]')).not.toBeNull();
    expect(left.querySelector('[aria-label="Console"]')).not.toBeNull();
    expect(el.querySelectorAll('[aria-label="Console"]')).toHaveLength(1);
    expect(left.querySelector('[aria-label="Functions"]')).not.toBeNull();
    expect(right.classList.contains("robot-page-column-console")).toBe(true);
    expect(right.querySelector('[aria-label="Charts"]')).not.toBeNull();
    expect(right.querySelector('[aria-label="Path trace"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="robot-tab-drive"]')?.getAttribute("aria-selected")).toBe("true");
  });

  it("ticket 018-013: the Calibration tab (offered for any robot) shows both wizards, the code block, and the current calibration", () => {
    const { el } = mountRobotPage(robotDevice({ program: "calibration-1", version: "1" }));
    expect(Array.from(el.querySelectorAll('[role="tab"]')).map((t) => t.textContent)).toEqual(["Main", "Drive", "Calibration", "Configuration", "Diagnostics"]);
    act(() => {
      el.querySelector<HTMLButtonElement>('[data-testid="robot-tab-calibration"]')!.click();
    });
    // CalibrationPage: both wizards and the code block on the left, the
    // current-calibration table on the right.
    expect(el.querySelector(".robot-page-column-left [aria-label=\"Distance calibration\"]")).not.toBeNull();
    expect(el.querySelector(".robot-page-column-left [aria-label=\"Rotation calibration\"]")).not.toBeNull();
    expect(el.querySelector(".robot-page-column-left [aria-label=\"Calibration code\"]")).not.toBeNull();
    expect(el.querySelector(".robot-page-column-right [aria-label=\"Current calibration\"]")).not.toBeNull();
  });

  it("stakeholder correction 2026-09-13: a plain, non-calibration robot's Calibration tab shows the Calibration firmware block (flash button, program/version text)", () => {
    const { el } = mountRobotPage(robotDevice({ program: null, version: null }));
    act(() => {
      el.querySelector<HTMLButtonElement>('[data-testid="robot-tab-calibration"]')!.click();
    });
    expect(el.querySelector('[data-testid="robot-tab-panel-calibration"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="calibration-firmware-not-running"]')?.textContent).toBe("Program: unknown");
    const flashButton = Array.from(el.querySelectorAll("button")).find((b) => b.textContent === "Flash calibration firmware");
    expect(flashButton).not.toBeUndefined();
  });

  it("stakeholder correction 2026-09-13: the Configuration tab no longer shows the Calibration firmware block", () => {
    const { el } = mountRobotPage(robotDevice({ program: null, version: null }));
    act(() => {
      el.querySelector<HTMLButtonElement>('[data-testid="robot-tab-configuration"]')!.click();
    });
    expect(el.querySelector('[data-testid="robot-tab-panel-configuration"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="calibration-firmware-not-running"]')).toBeNull();
    expect(Array.from(el.querySelectorAll("button")).find((b) => b.textContent === "Flash calibration firmware")).toBeUndefined();
  });

  it("renders exactly one console and a command strip in the right column", () => {
    const { el } = mountRobotPage();
    const right = el.querySelector(".robot-page-column-right");
    expect(right).not.toBeNull();
    expect(right!.querySelector('[aria-label="Console"]')).not.toBeNull();
    expect(right!.querySelector('[aria-label="Command strip"]')).not.toBeNull();

    // Exactly one console/log region anywhere on the page -- no
    // component still renders its own reply area alongside it.
    expect(el.querySelectorAll('[aria-label="Console"]').length).toBe(1);
    expect(el.querySelectorAll('[data-testid="console-log"]').length).toBe(1);
  });

  it("ticket 018-018: the Main tab's right column carries the shared viewport-bound class, with CommandStrip directly under the console", () => {
    const { el } = mountRobotPage();
    const right = el.querySelector(".robot-page-column-right")!;
    expect(right.classList.contains("robot-page-column-console")).toBe(true);

    const consoleEl = right.querySelector('[aria-label="Console"]')!;
    const strip = right.querySelector('[aria-label="Command strip"]')!;
    expect(consoleEl.compareDocumentPosition(strip) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });


  it("renders STOP/E-STOP inside DriveControls' pad in the left column, not as a page-level sibling (out-of-process, 2026-09-10)", () => {
    const { el } = mountRobotPage();
    const stop = el.querySelector('[data-testid="stop-button"]');
    const estop = el.querySelector('[aria-label="Emergency stop"]');
    expect(stop).not.toBeNull();
    expect(estop).not.toBeNull();

    const left = el.querySelector(".robot-page-column-left");
    const driveControls = left!.querySelector('[aria-label="Drive controls"]');
    expect(driveControls).not.toBeNull();
    expect(driveControls!.contains(stop)).toBe(true);
    expect(driveControls!.contains(estop)).toBe(true);

    // No separate top-level e-stop control sitting outside the columns
    // any more -- `.robot-page`'s only children are the heading and the
    // two-column grid.
    const right = el.querySelector(".robot-page-column-right");
    expect(right!.contains(stop)).toBe(false);
    expect(right!.contains(estop)).toBe(false);
  });

  it("removes the old single-column max-width from RobotPage.css", () => {
    expect(robotPageCssSource).not.toMatch(/max-width:\s*46rem/);
  });

  it("has no second echoed region anywhere on the page for a populated rx log with nothing sent (retired Get/Set panel bug regression)", () => {
    const { el, socket } = mountRobotPage();

    act(() => {
      socket.emitMessage({ type: "line", linkId: LINK_ID, direction: "rx", line: "status a=1" });
      socket.emitMessage({ type: "line", linkId: LINK_ID, direction: "rx", line: "get name value" });
      socket.emitMessage({ type: "line", linkId: LINK_ID, direction: "rx", line: "ack 1 0 none" });
    });

    // Each rx line appears exactly once on the whole page -- the
    // retired Get/Set panel's bug (a `-1` watermark matching the entire
    // rx history) would have echoed these a second time in a separate
    // reply area.
    const rxLines = el.querySelectorAll('[data-testid="console-line-rx"]');
    expect(rxLines.length).toBe(3);
    expect(el.querySelectorAll('[data-testid="get-set-replies"]').length).toBe(0);
    expect(el.querySelector(".get-set-panel")).toBeNull();
    expect(el.querySelector(".status-panel")).toBeNull();
  });

  it("command strip's HELLO/ID/VER/STATUS buttons send their bare verb via sendCommand", () => {
    const { el, socket } = mountRobotPage();

    for (const [testId, verb] of [
      ["command-strip-hello", "HELLO"],
      ["command-strip-id", "ID"],
      ["command-strip-ver", "VER"],
      ["command-strip-status", "STATUS"],
    ] as const) {
      socket.sent.length = 0;
      act(() => {
        el.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)!.click();
      });
      expect(socket.sent).toEqual([JSON.stringify({ type: "send-command", linkId: LINK_ID, verb })]);
    }
  });

  it("shows the host's notice text in the single console when a HELLO resync gets no reply", () => {
    const { el, socket } = mountRobotPage();

    act(() => {
      el.querySelector<HTMLButtonElement>('[data-testid="command-strip-hello"]')!.click();
    });

    const refusal =
      '"HELLO" cannot be sent as a live command -- it resets the robot\'s sequence state ' +
      "(protocol.md S8.3); close and reopen the session instead of resending HELLO";
    act(() => {
      socket.emitMessage({ type: "notice", level: "error", linkId: LINK_ID, text: refusal, at: 0, seq: 1 });
    });

    const log = el.querySelector('[data-testid="console-log"]')!;
    expect(log.textContent).toContain(refusal);
    expect(log.querySelector('[data-host-error="true"]')).not.toBeNull();

    // Still exactly one console region -- the rejection lands in the
    // same log, not a second surface.
    expect(el.querySelectorAll('[aria-label="Console"]').length).toBe(1);
  });
});

describe("RobotPage program/version diagnostics (sprint 011 ticket 002)", () => {
  it("renders no diagnostics line when program/version are both null (a robot that never answered ID) -- regression", () => {
    const { el } = mountRobotPage(robotDevice());

    expect(el.querySelector('[data-testid="robot-page-diagnostics"]')).toBeNull();
  });

  it("shows the raw program/version strings for a robot device that answered ID", () => {
    const { el } = mountRobotPage(robotDevice({ program: "tovez", version: "0.20260901.1" }));

    const diagnostics = el.querySelector('[data-testid="robot-page-diagnostics"]');
    expect(diagnostics).not.toBeNull();
    expect(diagnostics!.textContent).toContain("tovez");
    expect(diagnostics!.textContent).toContain("0.20260901.1");
  });

  it("shows the raw program/version strings for a calibration-program device", () => {
    const { el } = mountRobotPage(robotDevice({ program: "calibration-0.20260907.2", version: "0.20260907.2" }));

    const diagnostics = el.querySelector('[data-testid="robot-page-diagnostics"]');
    expect(diagnostics).not.toBeNull();
    expect(diagnostics!.textContent).toContain("calibration-0.20260907.2");
    expect(diagnostics!.textContent).toContain("0.20260907.2");
  });
});

describe("RobotPage under AppHeader (ticket 012-004)", () => {
  // AppHeader owns the back-to-devices link and the Flash menu entry
  // (see AppHeader.test.tsx for the full behavior matrix); this is a
  // cheap per-page smoke test proving both actually show up on a real
  // robot device page's route, not just in AppHeader's own isolated
  // tests.
  it("shows a back-to-devices link and an enabled Flash entry alongside the robot page", () => {
    const robot = robotDevice();
    let socket: FakeSocket | null = null;
    const el = mount(
      withRouter(
        <WsProvider url="ws://test/" socketFactory={() => (socket = new FakeSocket())}>
          <AppHeader />
          <RobotPage device={robot} link={robot.links[0]!} />
        </WsProvider>,
        { initialEntries: [`/d/${robot.links[0]!.id}`] },
      ),
    );
    act(() => {
      socket!.emitOpen();
    });
    act(() => {
      socket!.emitMessage(snapshot({ devices: [robot] }));
    });

    const backLink = el.querySelector("a");
    expect(backLink?.getAttribute("href")).toBe("/");
    const flashButton = Array.from(el.querySelectorAll("button")).find((b) => b.textContent === "Flash");
    expect(flashButton).not.toBeUndefined();
    expect(flashButton?.disabled).toBe(false);
  });
});
