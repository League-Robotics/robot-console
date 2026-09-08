// @vitest-environment jsdom
/**
 * RobotPage.test.tsx — integration-level rendering tests for the robot
 * page (ticket 005 / SUC-001, SUC-003, SUC-004, SUC-006).
 *
 * This ticket replaces sprint 4's placeholder shell with the real
 * control surface. Focused behavior for each child component (send
 * payloads, the drive hold/resend/release lease discipline, the
 * GET/SET error display, sequencing states) lives in that component's
 * own test file (`DriveControls.test.tsx`, `StatusPanel.test.tsx`,
 * `GetSetPanel.test.tsx`, `SequencingIndicator.test.tsx`); this file
 * only proves the page assembles them correctly and keeps
 * `DeviceConsole` embedded, exactly as `sprint.md`'s Acceptance
 * Criteria require. `RobotPage.transportBlind.test.ts` separately
 * enforces the transport-blindness property with a source scan.
 */
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { EndpointListEntry } from "@robot-console/host/src/wsMessages.js";
import { RobotPage } from "./RobotPage";
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

function mountRobotPage(endpoint: EndpointListEntry): HTMLDivElement {
  let socket: FakeSocket | null = null;
  return mount(
    <WsProvider url="ws://test/" socketFactory={() => (socket = new FakeSocket())}>
      <RobotPage endpoint={endpoint} />
    </WsProvider>,
  );
}

describe("RobotPage", () => {
  it("renders a header with the endpoint's name", () => {
    const el = mountRobotPage(robotFixture());
    expect(el.textContent).toContain("vevav");
  });

  it("renders drive controls, status, get/set, and a sequencing indicator", () => {
    const el = mountRobotPage(robotFixture());

    expect(el.querySelector('[aria-label="Drive controls"]')).not.toBeNull();
    expect(el.querySelector('[aria-label="Status"]')).not.toBeNull();
    expect(el.querySelector('[aria-label="Get/Set"]')).not.toBeNull();
    expect(el.querySelector('[aria-label="Sequencing state"]')).not.toBeNull();
  });

  it("embeds the device console for this endpoint, unchanged", () => {
    const el = mountRobotPage(robotFixture());
    expect(el.querySelector('[aria-label="Console"]')).not.toBeNull();
  });
});
