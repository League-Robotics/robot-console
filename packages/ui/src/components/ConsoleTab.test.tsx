// @vitest-environment jsdom
/**
 * ConsoleTab.test.tsx — component-level tests for the Console tab
 * (ticket 011 / SUC-002).
 *
 * Per the ticket's testing note, these drive the real `WsProvider`
 * against a fully synthetic fake socket (mirroring
 * `DevicesTab.test.tsx`'s `FakeSocket`) and push actual `type: 'line'`
 * / `type: 'devices'` JSON messages through it, covering: line-stream
 * rendering (both directions, filtered per device), send-box
 * submission producing an outbound WebSocket message, and the
 * client-side send throttle. Real end-to-end behavior against live
 * hardware is verified manually, not here.
 */
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EndpointListEntry } from "@robot-console/host/src/wsMessages.js";
import { ConsoleTab, MAX_LINES_PER_DEVICE, classifyLine } from "./ConsoleTab";
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

/** React tracks a controlled input's "last known value" on the DOM
 * node itself (to decide whether to fire the synthetic `onChange`).
 * Setting `.value` directly goes through React's patched setter,
 * which updates that tracker too -- so a plain `input.value = x`
 * followed by an `input` event looks like a no-op change and React
 * never calls the handler. Using the *native* setter (bypassing
 * React's patch) leaves the tracker stale, so the following `input`
 * event is seen as a real change. This is the standard workaround for
 * driving a controlled input without a DOM-testing-library helper. */
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

/** Convenience shape for fixture construction: a flatter, pre-sprint-4
 * -like set of fields (`id`/`linkOpen`) that {@link baseDevice}
 * translates into the real, reshaped {@link EndpointListEntry} --
 * mirrors `DevicesTab.test.tsx`'s own `BaseDeviceOverrides`. */
interface BaseDeviceOverrides {
  id?: string;
  name?: string | null;
  linkOpen?: boolean;
}

function baseDevice(overrides: BaseDeviceOverrides = {}): EndpointListEntry {
  const id = overrides.id ?? "SERIAL-A";
  return {
    endpointId: `usb-${id}`,
    transport: "usb",
    resourceKey: `usb-${id}`,
    classification: { type: "robot", role: "NEZHA2", commonName: "robot", dialect: "space", evidence: "role" },
    name: overrides.name ?? "zeguz",
    role: "NEZHA2",
    sessionOpen: overrides.linkOpen ?? true,
    usb: { serialNumber: `${id}-FULL`, displaySerial: "0002", port: "/dev/cu.usbmodemA" },
  };
}

function mountConsole(devices: EndpointListEntry[]): { el: HTMLDivElement; socket: FakeSocket } {
  let socket: FakeSocket | null = null;
  const el = mount(
    <WsProvider url="ws://test/" socketFactory={() => (socket = new FakeSocket())}>
      <ConsoleTab />
    </WsProvider>,
  );
  act(() => {
    socket!.emitOpen();
  });
  act(() => {
    socket!.emitMessage({ type: "endpoints", endpoints: devices });
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

describe("ConsoleTab", () => {
  it("lets the student pick a device by its five-letter name and shows that device's log only", () => {
    const { el, socket } = mountConsole([
      baseDevice({ id: "SERIAL-A", name: "zeguz" }),
      baseDevice({ id: "SERIAL-B", name: "kivon" }),
    ]);

    const select = el.querySelector<HTMLSelectElement>('[data-testid="console-device-select"]')!;
    expect(select.value).toBe("usb-SERIAL-A");
    expect(el.textContent).toContain("zeguz");
    expect(el.textContent).toContain("kivon");

    act(() => {
      socket.emitMessage({ type: "line", endpointId: "usb-SERIAL-A", direction: "rx", line: "hello from A" });
      socket.emitMessage({ type: "line", endpointId: "usb-SERIAL-B", direction: "rx", line: "hello from B" });
    });

    // Device A is selected by default -- only its line shows.
    expect(el.textContent).toContain("hello from A");
    expect(el.textContent).not.toContain("hello from B");

    // Switching devices reveals B's log and hides A's, without losing
    // either device's history.
    act(() => {
      select.value = "usb-SERIAL-B";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(el.textContent).toContain("hello from B");
    expect(el.textContent).not.toContain("hello from A");
  });

  it("shows both tx and rx lines the host forwards, marked by direction", () => {
    const { el, socket } = mountConsole([baseDevice()]);

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

  it("submits a typed line as an outbound tx WebSocket message for the selected device", () => {
    const { el, socket } = mountConsole([baseDevice({ linkOpen: true })]);

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
    // -- not echoed locally on submit (that's what the host's own
    // tx-echo, per `deviceRegistry.ts`, is for).
    expect(el.querySelector('[data-testid="console-line-tx"]')).toBeNull();

    act(() => {
      socket.emitMessage({ type: "line", endpointId: "usb-SERIAL-A", direction: "tx", line: "STATUS" });
    });
    expect(el.querySelector('[data-testid="console-line-tx"]')?.textContent).toContain("STATUS");
  });

  it("throttles rapid repeated submission client-side instead of firing unpaced writes", () => {
    vi.useFakeTimers();
    const { el, socket } = mountConsole([baseDevice({ linkOpen: true })]);

    const input = el.querySelector<HTMLInputElement>('[data-testid="console-send-input"]')!;
    const button = el.querySelector<HTMLButtonElement>('[data-testid="console-send-button"]')!;

    act(() => {
      typeInto(input, "HELLO");
    });
    act(() => {
      button.click();
    });
    expect(socket.sent).toHaveLength(1);
    // Disabled while the send is pending -- a second Enter/click does
    // nothing until the cooldown elapses. The submit was cleared to
    // an empty draft, so check `input.disabled` (gated only by the
    // pending cooldown) rather than the button (also gated on the
    // draft being non-empty).
    expect(input.disabled).toBe(true);

    act(() => {
      button.click();
    });
    expect(socket.sent).toHaveLength(1);

    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(input.disabled).toBe(false);

    // And the cooldown really did lift the throttle -- a second line
    // now goes through.
    act(() => {
      typeInto(input, "STATUS");
    });
    act(() => {
      button.click();
    });
    expect(socket.sent).toHaveLength(2);
  });

  it("disables sending with a clear reason when the selected device has no open link", () => {
    const { el } = mountConsole([baseDevice({ linkOpen: false })]);

    const input = el.querySelector<HTMLInputElement>('[data-testid="console-send-input"]')!;
    const button = el.querySelector<HTMLButtonElement>('[data-testid="console-send-button"]')!;

    expect(input.disabled).toBe(true);
    expect(button.disabled).toBe(true);
    expect(el.textContent).toContain("No link open to zeguz");
    expect(el.querySelector(".console-link-button")).not.toBeNull();
  });

  it("clears the log for the selected device only", () => {
    const { el, socket } = mountConsole([
      baseDevice({ id: "SERIAL-A", name: "zeguz" }),
      baseDevice({ id: "SERIAL-B", name: "kivon" }),
    ]);

    act(() => {
      socket.emitMessage({ type: "line", endpointId: "usb-SERIAL-A", direction: "rx", line: "line-a" });
      socket.emitMessage({ type: "line", endpointId: "usb-SERIAL-B", direction: "rx", line: "line-b" });
    });
    expect(el.textContent).toContain("line-a");

    const clearButton = Array.from(el.querySelectorAll("button")).find(
      (b) => b.textContent === "Clear log",
    )!;
    act(() => {
      clearButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(el.textContent).not.toContain("line-a");

    const select = el.querySelector<HTMLSelectElement>('[data-testid="console-device-select"]')!;
    act(() => {
      select.value = "usb-SERIAL-B";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(el.textContent).toContain("line-b");
  });

  it("caps retained lines per device at MAX_LINES_PER_DEVICE, dropping the oldest", () => {
    const { el, socket } = mountConsole([baseDevice()]);

    act(() => {
      for (let i = 0; i < MAX_LINES_PER_DEVICE + 5; i++) {
        socket.emitMessage({ type: "line", endpointId: "usb-SERIAL-A", direction: "rx", line: `n${i}` });
      }
    });

    const lines = el.querySelectorAll('[data-testid="console-line-rx"]');
    expect(lines.length).toBe(MAX_LINES_PER_DEVICE);
    // The oldest 5 lines (n0..n4) were dropped to stay at the cap; the
    // oldest surviving line is n5, the newest is the last one pushed.
    expect(lines[0]?.textContent).toContain("n5");
    expect(lines[0]?.textContent).not.toContain("n0");
    expect(lines[lines.length - 1]?.textContent).toContain(`n${MAX_LINES_PER_DEVICE + 4}`);
  });

  it("toggles the autoscroll pause control", () => {
    const { el } = mountConsole([baseDevice()]);

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
    const { el } = mountConsole([baseDevice()]);
    expect(el.textContent).not.toMatch(/WHEELS_X|WHEELS_V/);
  });
});
