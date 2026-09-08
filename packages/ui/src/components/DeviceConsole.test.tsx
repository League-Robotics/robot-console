// @vitest-environment jsdom
/**
 * DeviceConsole.test.tsx — component-level tests for the per-device
 * console (ticket 008 / SUC-002, SUC-007).
 *
 * Ported from `ConsoleTab.test.tsx` (sprint 1's flat Console tab),
 * dropped down to a single fixed `device` prop instead of a
 * device-picker dropdown -- so there is no device-switching test here
 * (nothing to switch between); every other behavior in the ticket's
 * "preserves" list is re-verified against the new component: line
 * classification/rendering, autoscroll toggle, clear log, send-box
 * submission and cooldown, the no-open-link send-disabled state, and
 * the per-device line cap.
 */
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EndpointListEntry } from "@robot-console/host/src/wsMessages.js";
import { DeviceConsole, classifyLine } from "./DeviceConsole";
import { MAX_LINES_PER_DEVICE, WsProvider } from "../ws/WsProvider";
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

/** See `ConsoleTab.test.tsx`'s own doc comment for why the native
 * setter is needed to drive a controlled input without a DOM-testing-
 * library helper. */
const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
  window.HTMLInputElement.prototype,
  "value",
)!.set!;

function typeInto(input: HTMLInputElement, value: string): void {
  nativeInputValueSetter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
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

function baseDevice(overrides: Partial<EndpointListEntry> = {}): EndpointListEntry {
  return {
    endpointId: "usb-SERIAL-A",
    transport: "usb",
    resourceKey: "usb-SERIAL-A",
    classification: { type: "robot", role: "NEZHA2", commonName: "robot", dialect: "space", evidence: "role" },
    name: "zeguz",
    role: "NEZHA2",
    sessionOpen: true,
    usb: { serialNumber: "SERIAL-A-FULL", displaySerial: "0002", port: "/dev/cu.usbmodemA" },
    ...overrides,
  };
}

function mountConsole(device: EndpointListEntry): { el: HTMLDivElement; socket: FakeSocket } {
  let socket: FakeSocket | null = null;
  const el = mount(
    <WsProvider url="ws://test/" socketFactory={() => (socket = new FakeSocket())}>
      <DeviceConsole device={device} />
    </WsProvider>,
  );
  act(() => {
    socket!.emitOpen();
  });
  return { el, socket: socket! };
}

describe("classifyLine", () => {
  it("classifies a relay comment/status line", () => {
    expect(classifyLine("# link opened")).toBe("comment");
  });

  it("classifies a firmware debug line", () => {
    expect(classifyLine("DBG: loop=12")).toBe("debug");
  });

  it("classifies err and nack lines as errors", () => {
    expect(classifyLine("err 3 bad-arg")).toBe("error");
    expect(classifyLine("nack unknown-command")).toBe("error");
  });

  it("classifies ack as routine, not error or data", () => {
    expect(classifyLine("ack HELLO")).toBe("ack");
  });

  it("classifies everything else as ordinary data", () => {
    expect(classifyLine("STATUS ok battery=98")).toBe("data");
  });
});

describe("DeviceConsole", () => {
  it("shows this device's log, with no device picker", () => {
    const { el } = mountConsole(baseDevice({ name: "zeguz" }));

    expect(el.querySelector('[data-testid="console-device-select"]')).toBeNull();
    expect(el.textContent).toContain("No traffic yet for this device");
  });

  it("shows both tx and rx lines the host forwards, marked by direction", () => {
    const { el, socket } = mountConsole(baseDevice());

    act(() => {
      socket.emitMessage({ type: "line", endpointId: "usb-SERIAL-A", direction: "tx", line: "HELLO" });
      socket.emitMessage({ type: "line", endpointId: "usb-SERIAL-A", direction: "rx", line: "ack HELLO" });
    });

    const txLine = el.querySelector('[data-testid="console-line-tx"]');
    const rxLine = el.querySelector('[data-testid="console-line-rx"]');
    expect(txLine?.textContent).toContain("HELLO");
    expect(rxLine?.textContent).toContain("ack HELLO");
    expect(rxLine?.className).toContain("console-line-kind-ack");
  });

  it("ignores a line for a different endpoint", () => {
    const { el, socket } = mountConsole(baseDevice());

    act(() => {
      socket.emitMessage({ type: "line", endpointId: "usb-OTHER", direction: "rx", line: "not mine" });
    });

    expect(el.textContent).not.toContain("not mine");
    expect(el.textContent).toContain("No traffic yet for this device");
  });

  it("submits a typed line as an outbound tx WebSocket message for this device", () => {
    const { el, socket } = mountConsole(baseDevice({ sessionOpen: true }));

    const input = el.querySelector<HTMLInputElement>('[data-testid="console-send-input"]')!;
    const button = el.querySelector<HTMLButtonElement>('[data-testid="console-send-button"]')!;

    act(() => {
      typeInto(input, "STATUS");
    });
    act(() => {
      button.click();
    });

    expect(socket.sent).toHaveLength(1);
    expect(JSON.parse(socket.sent[0]!)).toEqual({
      type: "line",
      endpointId: "usb-SERIAL-A",
      direction: "tx",
      line: "STATUS",
    });
    // The tx line only appears in the log once the host echoes it back
    // -- not echoed locally on submit.
    expect(el.querySelector('[data-testid="console-line-tx"]')).toBeNull();

    act(() => {
      socket.emitMessage({ type: "line", endpointId: "usb-SERIAL-A", direction: "tx", line: "STATUS" });
    });
    expect(el.querySelector('[data-testid="console-line-tx"]')?.textContent).toContain("STATUS");
  });

  it("throttles rapid repeated submission client-side instead of firing unpaced writes", () => {
    vi.useFakeTimers();
    const { el, socket } = mountConsole(baseDevice({ sessionOpen: true }));

    const input = el.querySelector<HTMLInputElement>('[data-testid="console-send-input"]')!;
    const button = el.querySelector<HTMLButtonElement>('[data-testid="console-send-button"]')!;

    act(() => {
      typeInto(input, "HELLO");
    });
    act(() => {
      button.click();
    });
    expect(socket.sent).toHaveLength(1);
    expect(input.disabled).toBe(true);

    act(() => {
      button.click();
    });
    expect(socket.sent).toHaveLength(1);

    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(input.disabled).toBe(false);

    act(() => {
      typeInto(input, "STATUS");
    });
    act(() => {
      button.click();
    });
    expect(socket.sent).toHaveLength(2);
  });

  it("disables sending with a clear reason when this device has no open link", () => {
    const { el } = mountConsole(baseDevice({ sessionOpen: false }));

    const input = el.querySelector<HTMLInputElement>('[data-testid="console-send-input"]')!;
    const button = el.querySelector<HTMLButtonElement>('[data-testid="console-send-button"]')!;

    expect(input.disabled).toBe(true);
    expect(button.disabled).toBe(true);
    expect(el.textContent).toContain("No link open to zeguz");
    expect(el.querySelector(".console-link-button")).not.toBeNull();
  });

  it("sends session-open when the 'open a link' hint is clicked", () => {
    const { el, socket } = mountConsole(baseDevice({ sessionOpen: false }));

    const openButton = el.querySelector<HTMLButtonElement>(".console-link-button")!;
    act(() => {
      openButton.click();
    });

    expect(socket.sent).toEqual([
      JSON.stringify({ type: "session-open", endpointId: "usb-SERIAL-A" }),
    ]);
  });

  it("clears this device's log", () => {
    const { el, socket } = mountConsole(baseDevice());

    act(() => {
      socket.emitMessage({ type: "line", endpointId: "usb-SERIAL-A", direction: "rx", line: "line-a" });
    });
    expect(el.textContent).toContain("line-a");

    const clearButton = Array.from(el.querySelectorAll("button")).find(
      (b) => b.textContent === "Clear log",
    )!;
    act(() => {
      clearButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(el.textContent).not.toContain("line-a");
  });

  it("caps retained lines per device at MAX_LINES_PER_DEVICE, dropping the oldest", () => {
    const { el, socket } = mountConsole(baseDevice());

    act(() => {
      for (let i = 0; i < MAX_LINES_PER_DEVICE + 5; i++) {
        socket.emitMessage({ type: "line", endpointId: "usb-SERIAL-A", direction: "rx", line: `n${i}` });
      }
    });

    const lines = el.querySelectorAll('[data-testid="console-line-rx"]');
    expect(lines.length).toBe(MAX_LINES_PER_DEVICE);
    expect(lines[0]?.textContent).toContain("n5");
    expect(lines[0]?.textContent).not.toContain("n0");
    expect(lines[lines.length - 1]?.textContent).toContain(`n${MAX_LINES_PER_DEVICE + 4}`);
  });

  it("toggles the autoscroll pause control", () => {
    const { el } = mountConsole(baseDevice());

    const toggle = Array.from(el.querySelectorAll("button")).find(
      (b) => b.textContent === "Pause autoscroll",
    )!;
    expect(toggle).toBeDefined();
    act(() => {
      toggle.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(el.textContent).toContain("Resume autoscroll");
  });

  it("shows no drive-specific motor/wheel controls", () => {
    const { el } = mountConsole(baseDevice());
    expect(el.textContent).not.toMatch(/WHEELS_X|WHEELS_V/);
  });
});
