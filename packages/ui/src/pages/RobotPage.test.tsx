// @vitest-environment jsdom
/**
 * RobotPage.test.tsx — integration-level rendering tests for the robot
 * page (ticket 012-005 / SUC-001, SUC-003, SUC-004, SUC-006, SUC-007).
 *
 * This ticket replaces the sprint 006 single-column shell (three
 * separate response areas reading the same rx log, one of them -- the
 * retired Get/Set panel -- with a real `-1`-watermark bug) with a two-column
 * layout: left column `DriveControls` + `SequencingIndicator` + a
 * stubbed charts placeholder; right column exactly one `DeviceConsole`
 * with `CommandStrip` beneath it. `EstopControl` stays a sibling of the
 * two-column grid.
 *
 * Focused per-component behavior lives in each component's own test
 * file (`DriveControls.test.tsx`, `SequencingIndicator.test.tsx`,
 * `CommandStrip.test.tsx`); this file proves the page assembles them
 * correctly, that the layout's structural constraints hold (no second
 * console/reply region anywhere on the page, `EstopControl` not nested
 * inside either column's scroll container), and that a `HELLO` refusal
 * routed by ticket 012-003 actually surfaces here.
 * `RobotPage.transportBlind.test.ts` separately enforces the
 * transport-blindness property with a source scan.
 */
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { EndpointListEntry } from "@robot-console/host/src/wsMessages.js";
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

function robotFixture(overrides: Partial<EndpointListEntry> = {}): EndpointListEntry {
  return {
    endpointId: "usb-ROBOT-A",
    transport: "usb",
    resourceKey: "usb-ROBOT-A",
    classification: { type: "robot", role: "NEZHA2", commonName: "robot", dialect: "space", evidence: "role" },
    name: "vevav",
    role: "NEZHA2",
    sessionOpen: true,
    usb: { serialNumber: "ROBOT-A-FULL", displaySerial: "0004", port: "/dev/cu.usbmodemC" },
    ...overrides,
  };
}

function mountRobotPage(endpoint: EndpointListEntry): { el: HTMLDivElement; socket: FakeSocket } {
  let socket: FakeSocket | null = null;
  const el = mount(
    <WsProvider url="ws://test/" socketFactory={() => (socket = new FakeSocket())}>
      <RobotPage endpoint={endpoint} />
    </WsProvider>,
  );
  act(() => {
    socket!.emitOpen();
  });
  return { el, socket: socket! };
}

describe("RobotPage", () => {
  it("renders a header with the endpoint's name", () => {
    const { el } = mountRobotPage(robotFixture());
    expect(el.textContent).toContain("vevav");
  });

  it("renders the left column with drive controls, a sequencing indicator, and a charts placeholder", () => {
    const { el } = mountRobotPage(robotFixture());
    const left = el.querySelector(".robot-page-column-left");
    expect(left).not.toBeNull();
    expect(left!.querySelector('[aria-label="Drive controls"]')).not.toBeNull();
    expect(left!.querySelector('[aria-label="Sequencing state"]')).not.toBeNull();
    expect(left!.querySelector('[aria-label="Charts"]')).not.toBeNull();
  });

  it("renders exactly one console and a command strip in the right column", () => {
    const { el } = mountRobotPage(robotFixture());
    const right = el.querySelector(".robot-page-column-right");
    expect(right).not.toBeNull();
    expect(right!.querySelector('[aria-label="Console"]')).not.toBeNull();
    expect(right!.querySelector('[aria-label="Command strip"]')).not.toBeNull();

    // Exactly one console/log region anywhere on the page -- no
    // component still renders its own reply area alongside it.
    expect(el.querySelectorAll('[aria-label="Console"]').length).toBe(1);
    expect(el.querySelectorAll('[data-testid="console-log"]').length).toBe(1);
  });

  it("mounts EstopControl as a sibling of the two-column grid, not nested inside either column", () => {
    const { el } = mountRobotPage(robotFixture());
    const estop = el.querySelector('[aria-label="Emergency stop"]');
    expect(estop).not.toBeNull();

    const columns = el.querySelector(".robot-page-columns");
    expect(columns).not.toBeNull();
    expect(columns!.contains(estop)).toBe(false);

    const left = el.querySelector(".robot-page-column-left");
    const right = el.querySelector(".robot-page-column-right");
    expect(left!.contains(estop)).toBe(false);
    expect(right!.contains(estop)).toBe(false);

    // `.robot-page` (EstopControl's parent) is EstopControl's own
    // nearest ancestor with any layout say over it; `.robot-page-columns`
    // is a sibling subtree, never an ancestor of EstopControl.
    expect(el.querySelector(".robot-page")!.contains(estop)).toBe(true);
  });

  it("removes the old single-column max-width from RobotPage.css", () => {
    expect(robotPageCssSource).not.toMatch(/max-width:\s*46rem/);
  });

  it("has no second echoed region anywhere on the page for a populated rx log with nothing sent (retired Get/Set panel bug regression)", () => {
    const { el, socket } = mountRobotPage(robotFixture());

    act(() => {
      socket.emitMessage({ type: "line", endpointId: "usb-ROBOT-A", direction: "rx", line: "status a=1" });
      socket.emitMessage({ type: "line", endpointId: "usb-ROBOT-A", direction: "rx", line: "get name value" });
      socket.emitMessage({ type: "line", endpointId: "usb-ROBOT-A", direction: "rx", line: "ack 1 0 none" });
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
    const { el, socket } = mountRobotPage(robotFixture());

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
      expect(socket.sent).toEqual([
        JSON.stringify({ type: "send-command", endpointId: "usb-ROBOT-A", verb }),
      ]);
    }
  });

  it("shows the host's HELLO rejection text in the single console when pressed against an open session", () => {
    const { el, socket } = mountRobotPage(robotFixture());

    act(() => {
      el.querySelector<HTMLButtonElement>('[data-testid="command-strip-hello"]')!.click();
    });

    const refusal =
      '"HELLO" cannot be sent as a live command -- it resets the robot\'s sequence state ' +
      "(protocol.md S8.3); close and reopen the session instead of resending HELLO";
    act(() => {
      socket.emitMessage({ type: "error", endpointId: "usb-ROBOT-A", message: refusal });
    });

    const log = el.querySelector('[data-testid="console-log"]')!;
    expect(log.textContent).toContain(refusal);
    expect(log.querySelector('[data-host-error="true"]')).not.toBeNull();

    // Still exactly one console region -- the rejection lands in the
    // same log, not a second surface.
    expect(el.querySelectorAll('[aria-label="Console"]').length).toBe(1);
  });
});

describe("RobotPage under AppHeader (ticket 012-004)", () => {
  // AppHeader owns the back-to-devices link and the Flash menu entry
  // (see AppHeader.test.tsx for the full behavior matrix); this is a
  // cheap per-page smoke test proving both actually show up on a real
  // robot device page's route, not just in AppHeader's own isolated
  // tests.
  it("shows a back-to-devices link and an enabled Flash entry alongside the robot page", () => {
    const robot = robotFixture();
    let socket: FakeSocket | null = null;
    const el = mount(
      withRouter(
        <WsProvider url="ws://test/" socketFactory={() => (socket = new FakeSocket())}>
          <AppHeader />
          <RobotPage endpoint={robot} />
        </WsProvider>,
        { initialEntries: [`/d/${robot.endpointId}`] },
      ),
    );
    act(() => {
      socket!.emitOpen();
    });
    act(() => {
      socket!.emitMessage({ type: "endpoints", endpoints: [robot] });
    });

    const backLink = el.querySelector("a");
    expect(backLink?.getAttribute("href")).toBe("/");
    const flashButton = Array.from(el.querySelectorAll("button")).find((b) => b.textContent === "Flash");
    expect(flashButton).not.toBeUndefined();
    expect(flashButton?.disabled).toBe(false);
  });
});
