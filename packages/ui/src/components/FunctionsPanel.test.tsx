// @vitest-environment jsdom
/**
 * FunctionsPanel.test.tsx — component tests (added out-of-process,
 * 2026-09-09).
 *
 * Proves: the three list states (undefined/empty/populated); one row
 * per function; Run with no args sends just `[name]`; the free-form
 * field splits on whitespace; a `signature` renders one labelled input
 * per parameter name and sends their values in order; Refresh sends
 * `FUNCS`; everything disables with no open session.
 */
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { EndpointListEntry, RobotFunction } from "@robot-console/host/src/wsMessages.js";
import { FunctionsPanel } from "./FunctionsPanel";
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
});

function baseDevice(
  functions: RobotFunction[] | undefined,
  overrides: Partial<EndpointListEntry> = {},
): EndpointListEntry {
  return {
    endpointId: "usb-ROBOT-A",
    transport: "usb",
    resourceKey: "usb-ROBOT-A",
    classification: { type: "robot", role: "NEZHA2", commonName: "robot", dialect: "space", evidence: "role" },
    name: "zavaz",
    role: "NEZHA2",
    sessionOpen: true,
    usb: { serialNumber: "ROBOT-A-FULL", displaySerial: "0004", port: "/dev/cu.usbmodemC" },
    // `exactOptionalPropertyTypes` forbids `functions: undefined` --
    // the key must be entirely absent to represent "no FUNCS sent yet",
    // not present-with-undefined.
    ...(functions !== undefined ? { functions } : {}),
    ...overrides,
  };
}

function mountPanel(device: EndpointListEntry): { el: HTMLDivElement; socket: FakeSocket } {
  let socket: FakeSocket | null = null;
  const el = mount(
    <WsProvider url="ws://test/" socketFactory={() => (socket = new FakeSocket())}>
      <FunctionsPanel device={device} />
    </WsProvider>,
  );
  act(() => {
    socket!.emitOpen();
  });
  return { el, socket: socket! };
}

describe("FunctionsPanel list states", () => {
  it("shows a hint to press FUNCS when functions is undefined", () => {
    const { el } = mountPanel(baseDevice(undefined));
    expect(el.textContent).toContain("No function list yet");
    expect(el.querySelectorAll('[data-testid^="function-row-"]').length).toBe(0);
  });

  it("shows a 'no functions' message when functions is an empty array", () => {
    const { el } = mountPanel(baseDevice([]));
    expect(el.textContent).toContain("The robot reported no functions.");
  });

  it("renders one row per function", () => {
    const { el } = mountPanel(baseDevice([{ name: "beep" }, { name: "spin" }]));
    expect(el.querySelector('[data-testid="function-row-beep"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="function-row-spin"]')).not.toBeNull();
  });
});

describe("FunctionsPanel refresh", () => {
  it("sends FUNCS on Refresh", () => {
    const { el, socket } = mountPanel(baseDevice(undefined));
    socket.sent.length = 0;
    act(() => {
      el.querySelector<HTMLButtonElement>('[data-testid="functions-panel-refresh"]')!.click();
    });
    expect(socket.sent).toEqual([
      JSON.stringify({ type: "send-command", endpointId: "usb-ROBOT-A", verb: "FUNCS" }),
    ]);
  });

  it("disables Refresh when there is no open session", () => {
    const { el } = mountPanel(baseDevice(undefined, { sessionOpen: false }));
    expect(
      el.querySelector<HTMLButtonElement>('[data-testid="functions-panel-refresh"]')!.disabled,
    ).toBe(true);
  });
});

describe("FunctionsPanel free-form args (no signature)", () => {
  it("runs with no args, sending just [name]", () => {
    const { el, socket } = mountPanel(baseDevice([{ name: "beep" }]));
    socket.sent.length = 0;
    act(() => {
      el.querySelector<HTMLButtonElement>('[data-testid="function-run-beep"]')!.click();
    });
    expect(socket.sent).toEqual([
      JSON.stringify({ type: "send-command", endpointId: "usb-ROBOT-A", verb: "RUN", fields: ["beep"] }),
    ]);
  });

  it("splits a free-form '10 20' into two args", () => {
    const { el, socket } = mountPanel(baseDevice([{ name: "move" }]));
    const input = el.querySelector<HTMLInputElement>('[data-testid="function-args-move"]')!;
    act(() => {
      typeInto(input, "10 20");
    });
    socket.sent.length = 0;
    act(() => {
      el.querySelector<HTMLButtonElement>('[data-testid="function-run-move"]')!.click();
    });
    expect(socket.sent).toEqual([
      JSON.stringify({
        type: "send-command",
        endpointId: "usb-ROBOT-A",
        verb: "RUN",
        fields: ["move", "10", "20"],
      }),
    ]);
  });

  it("disables the free-form input and Run when there is no open session", () => {
    const { el } = mountPanel(baseDevice([{ name: "beep" }], { sessionOpen: false }));
    expect(el.querySelector<HTMLInputElement>('[data-testid="function-args-beep"]')!.disabled).toBe(
      true,
    );
    expect(el.querySelector<HTMLButtonElement>('[data-testid="function-run-beep"]')!.disabled).toBe(
      true,
    );
  });
});

describe("FunctionsPanel signature-driven args", () => {
  it("renders one labelled input per parameter name and sends their values in order", () => {
    const { el, socket } = mountPanel(baseDevice([{ name: "move", signature: "dist speed" }]));
    const distInput = el.querySelector<HTMLInputElement>('[data-testid="function-arg-move-0"]')!;
    const speedInput = el.querySelector<HTMLInputElement>('[data-testid="function-arg-move-1"]')!;
    expect(distInput).not.toBeNull();
    expect(speedInput).not.toBeNull();
    expect(el.querySelector('[data-testid="function-args-move"]')).toBeNull();

    act(() => {
      typeInto(distInput, "100");
      typeInto(speedInput, "50");
    });
    socket.sent.length = 0;
    act(() => {
      el.querySelector<HTMLButtonElement>('[data-testid="function-run-move"]')!.click();
    });
    expect(socket.sent).toEqual([
      JSON.stringify({
        type: "send-command",
        endpointId: "usb-ROBOT-A",
        verb: "RUN",
        fields: ["move", "100", "50"],
      }),
    ]);
  });

  it("trims and drops empty per-parameter values", () => {
    const { el, socket } = mountPanel(baseDevice([{ name: "move", signature: "dist speed" }]));
    const distInput = el.querySelector<HTMLInputElement>('[data-testid="function-arg-move-0"]')!;
    act(() => {
      typeInto(distInput, "  100  ");
    });
    socket.sent.length = 0;
    act(() => {
      el.querySelector<HTMLButtonElement>('[data-testid="function-run-move"]')!.click();
    });
    expect(socket.sent).toEqual([
      JSON.stringify({
        type: "send-command",
        endpointId: "usb-ROBOT-A",
        verb: "RUN",
        fields: ["move", "100"],
      }),
    ]);
  });
});
