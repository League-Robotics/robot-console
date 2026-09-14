// @vitest-environment jsdom
/**
 * CalibrationFirmwarePanel.test.tsx — component tests for the
 * "Calibration firmware" flash/verify block extracted from
 * `ConfigurationPage.tsx` (ticket 018-013) and relocated to the
 * Calibration tab (stakeholder correction, 2026-09-13). Mounts the
 * component directly (not through `CalibrationPage`) to exercise its own
 * contract in isolation; `CalibrationPage.test.tsx` covers the same
 * behavior again at the mounted-page level.
 */
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { SnapshotDevice, SnapshotLink } from "@robot-console/host/src/wsMessages.js";
import { CalibrationFirmwarePanel } from "./CalibrationFirmwarePanel";
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

function link(overrides: Partial<SnapshotLink> = {}): SnapshotLink {
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

function device(theLink: SnapshotLink, overrides: Partial<Omit<SnapshotDevice, "links">> = {}): SnapshotDevice {
  return {
    id: 1,
    name: "gopiv",
    kind: "robot",
    role: "NEZHA2",
    commonName: null,
    program: null,
    version: null,
    owned: true,
    radio: { channel: 1, group: 1, source: "derived" },
    lastSeen: 0,
    lastChecked: null,
    links: [theLink],
    ...overrides,
  };
}

function mountPanel(
  opts: { linkOverrides?: Partial<SnapshotLink>; deviceOverrides?: Partial<Omit<SnapshotDevice, "links">> } = {},
): { el: HTMLDivElement; socket: FakeSocket } {
  let socket: FakeSocket | null = null;
  const theLink = link(opts.linkOverrides);
  const theDevice = device(theLink, opts.deviceOverrides);
  const el = mount(
    <WsProvider url="ws://test/" socketFactory={() => (socket = new FakeSocket())}>
      <CalibrationFirmwarePanel device={theDevice} link={theLink} />
    </WsProvider>,
  );
  act(() => {
    socket!.emitOpen();
  });
  return { el, socket: socket! };
}

function markRobotFirmwareAvailable(socket: FakeSocket): void {
  act(() => {
    socket.emitMessage({
      type: "snapshot",
      seq: 1,
      at: 0,
      devices: [],
      unassigned: [],
      relays: [],
      firmware: {
        relay: { configured: false },
        robot: {
          configured: true,
          repoUrl: "https://github.com/League-Robotics/nezha-robot-template",
          tag: "v0.20260913.1",
          available: true,
          checkedAt: 1000,
        },
      },
      wifi: { ssid: null, source: null },
      tasks: [],
    });
  });
}

describe("CalibrationFirmwarePanel", () => {
  it("shows the current program and a Flash trigger for a USB-flashable link", () => {
    const { el } = mountPanel({ deviceOverrides: { program: null, version: null } });
    expect(el.querySelector('[data-testid="calibration-firmware-not-running"]')?.textContent).toBe("Program: unknown");
    expect(el.querySelector('[data-testid="calibration-flash-firmware"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="calibration-firmware-usb-required"]')).toBeNull();
  });

  it("says the running calibration build's release version (from program) when the current program is one -- never device.version, the library version (018-017)", () => {
    const { el } = mountPanel({ deviceOverrides: { program: "calibration-0.20260913.1", version: "1.20260912.8" } });
    expect(el.querySelector('[data-testid="calibration-firmware-running"]')?.textContent).toBe(
      "Calibration firmware 0.20260913.1 is running.",
    );
  });

  it("with no flashable link on the device, names both ways to get one instead of showing a Flash trigger", () => {
    const { el } = mountPanel({
      linkOverrides: { transport: "radio", capabilities: { open: false, close: true, flash: false, provisionWifi: false } },
    });
    expect(el.querySelector('[data-testid="calibration-firmware-usb-required"]')?.textContent).toBe(
      "Plug the robot in over USB, or put it on a farm host, to flash.",
    );
    expect(el.querySelector('[data-testid="calibration-flash-firmware"]')).toBeNull();
  });

  it("clicking Flash sends flash-start for the robot release firmware, once firmware is configured/available", () => {
    const { el, socket } = mountPanel();
    markRobotFirmwareAvailable(socket);
    act(() => {
      el.querySelector<HTMLButtonElement>('[data-testid="calibration-flash-firmware"]')!.click();
    });
    expect(socket.sent).toContainEqual(
      JSON.stringify({ type: "flash-start", linkId: LINK_ID, source: { kind: "release", firmware: "robot" } }),
    );
  });

  it("the Flash button is disabled (and clicking it sends nothing) until firmware is configured for this classroom", () => {
    const { el, socket } = mountPanel();
    const button = el.querySelector<HTMLButtonElement>('[data-testid="calibration-flash-firmware"]')!;
    expect(button.disabled).toBe(true);
    act(() => {
      button.click();
    });
    expect(socket.sent).toEqual([]);
  });

  it("shows inline phase progress while a flash is in flight, hiding the Flash button meanwhile", () => {
    const { el, socket } = mountPanel();
    act(() => {
      socket.emitMessage({ type: "flash-progress", linkId: LINK_ID, source: { kind: "release", firmware: "robot" }, phase: "writing", seq: 1 });
    });
    expect(el.querySelector('[data-testid="calibration-flash-progress"]')?.textContent).toContain("writing");
    expect(el.querySelector('[data-testid="calibration-flash-firmware"]')).toBeNull();
  });

  it("confirms the calibration build once the fresh post-flash snapshot actually reports one, using the program's release version -- never device.version, the library version (018-017)", () => {
    const { el, socket } = mountPanel({ deviceOverrides: { program: "calibration-0.20260913.1", version: "1.20260912.8" } });
    act(() => {
      socket.emitMessage({ type: "flash-result", linkId: LINK_ID, source: { kind: "release", firmware: "robot" }, status: "ok", seq: 1 });
    });
    expect(el.querySelector('[data-testid="calibration-flash-result"]')?.textContent).toBe(
      "Calibration firmware 0.20260913.1 confirmed.",
    );
  });

  it("018-017: appends the flashed release's own repo+tag to the confirmed text when it's known", () => {
    const { el, socket } = mountPanel({ deviceOverrides: { program: "calibration-0.20260913.1", version: "1.20260912.8" } });
    markRobotFirmwareAvailable(socket);
    act(() => {
      socket.emitMessage({ type: "flash-result", linkId: LINK_ID, source: { kind: "release", firmware: "robot" }, status: "ok", seq: 1 });
    });
    expect(el.querySelector('[data-testid="calibration-flash-result"]')?.textContent).toBe(
      "Calibration firmware 0.20260913.1 confirmed (nezha-robot-template v0.20260913.1).",
    );
  });

  it("reports the actual (non-calibration) program when a flash succeeds but the fresh snapshot isn't a calibration build -- never assumes success", () => {
    const { el, socket } = mountPanel({ deviceOverrides: { program: "some-other-build", version: "9" } });
    act(() => {
      socket.emitMessage({ type: "flash-result", linkId: LINK_ID, source: { kind: "release", firmware: "robot" }, status: "ok", seq: 1 });
    });
    expect(el.querySelector('[data-testid="calibration-flash-result"]')?.textContent).toBe(
      "Flashed, but the robot reports program some-other-build — not the calibration build.",
    );
  });

  it("surfaces a flash-result error's message instead of any confirmation text", () => {
    const { el, socket } = mountPanel();
    act(() => {
      socket.emitMessage({
        type: "flash-result",
        linkId: LINK_ID,
        source: { kind: "release", firmware: "robot" },
        status: "error",
        message: "sha256 mismatch on downloaded hex",
        seq: 1,
      });
    });
    expect(el.querySelector('[data-testid="calibration-flash-result"]')?.textContent).toBe("sha256 mismatch on downloaded hex");
  });

  it("shows a waiting note, not a false confirmation, when the post-flash reidentify times out", () => {
    const { el, socket } = mountPanel();
    act(() => {
      socket.emitMessage({
        type: "flash-result",
        linkId: LINK_ID,
        source: { kind: "release", firmware: "robot" },
        status: "ok",
        reidentify: "timeout",
        seq: 1,
      });
    });
    expect(el.querySelector('[data-testid="calibration-flash-result"]')?.textContent).toBe(
      "Flashed robot. Waiting for the board to come back…",
    );
  });

  it("018-017: shows a linked repo name, tag, and 'checked ...' text under the Flash button once the release is available", () => {
    const { el, socket } = mountPanel();
    markRobotFirmwareAvailable(socket);
    const source = el.querySelector('[data-testid="calibration-flash-source"]')!;
    expect(source).not.toBeNull();
    const link = source.querySelector("a")!;
    expect(link.getAttribute("href")).toBe("https://github.com/League-Robotics/nezha-robot-template/releases/tag/v0.20260913.1");
    expect(link.textContent).toBe("nezha-robot-template");
    expect(source.textContent).toContain("v0.20260913.1");
    expect(source.textContent).toContain("checked");
  });

  it("018-017: shows the plain disabled reason instead of the source line while firmware isn't configured yet", () => {
    const { el } = mountPanel();
    expect(el.querySelector('[data-testid="calibration-flash-source"]')).toBeNull();
  });

  it("018-017: names the configured release's own repo+tag in the flash progress line", () => {
    const { el, socket } = mountPanel();
    markRobotFirmwareAvailable(socket);
    act(() => {
      socket.emitMessage({ type: "flash-progress", linkId: LINK_ID, source: { kind: "release", firmware: "robot" }, phase: "writing", seq: 1 });
    });
    expect(el.querySelector('[data-testid="calibration-flash-progress"]')?.textContent).toBe(
      "Flashing nezha-robot-template v0.20260913.1: writing…",
    );
  });

  it("018-017: names the configured release's own repo+tag in the reidentify-timeout result line", () => {
    const { el, socket } = mountPanel();
    markRobotFirmwareAvailable(socket);
    act(() => {
      socket.emitMessage({
        type: "flash-result",
        linkId: LINK_ID,
        source: { kind: "release", firmware: "robot" },
        status: "ok",
        reidentify: "timeout",
        seq: 1,
      });
    });
    expect(el.querySelector('[data-testid="calibration-flash-result"]')?.textContent).toBe(
      "Flashed nezha-robot-template v0.20260913.1. Waiting for the board to come back…",
    );
  });
});
