// @vitest-environment jsdom
/**
 * RobotPage.test.tsx — shell-rendering tests for the robot page
 * (ticket 008 / SUC-006). Only a fixture is used -- no attached board
 * classifies as `robot` this sprint (Success Criteria's hardware
 * deferral), so end-to-end verification against a real robot banner is
 * out of scope here.
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

function robotFixture(): EndpointListEntry {
  return {
    endpointId: "usb-ROBOT-A",
    transport: "usb",
    resourceKey: "usb-ROBOT-A",
    classification: { type: "robot", role: "NEZHA2", commonName: "robot", dialect: "space", evidence: "role" },
    name: "vevav",
    role: "NEZHA2",
    sessionOpen: true,
    usb: { serialNumber: "ROBOT-A-FULL", displaySerial: "0004", port: "/dev/cu.usbmodemC" },
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

  it("states what's coming rather than faking drive/telemetry controls", () => {
    const el = mountRobotPage(robotFixture());
    expect(el.textContent).toMatch(/coming in a later sprint/i);
    expect(el.textContent).not.toMatch(/WHEELS_X|WHEELS_V/);
    expect(el.querySelectorAll("input[type=range], progress")).toHaveLength(0);
  });

  it("embeds the device console for this endpoint", () => {
    const el = mountRobotPage(robotFixture());
    expect(el.querySelector('[aria-label="Console"]')).not.toBeNull();
  });
});
