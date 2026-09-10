// @vitest-environment jsdom
/**
 * FunctionsPanel.test.tsx — component tests (added out-of-process,
 * 2026-09-09; rewritten out-of-process, same day, for the single-line
 * select + Go layout).
 *
 * Proves: the three list states (undefined/empty/populated) and the
 * select's placeholder/disabled behavior; selecting a function shows
 * the right inputs for each of the three signature shapes
 * (params/free-form/`()`); Go sends the right `RUN` fields for each
 * shape, including the positional-default fallback; Refresh sends
 * `FUNCS`; everything disables with no open session; per-function
 * argument memory (in-memory and round-tripped through localStorage);
 * and the selection resetting to the placeholder when the selected
 * function drops out of a refreshed list.
 */
import { act, useState as useReactState, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { EndpointListEntry, RobotFunction } from "@robot-console/host/src/wsMessages.js";
import { FunctionsPanel, parseSignature, positionalArgs } from "./FunctionsPanel";
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

function unmount(): void {
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
}

const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
  window.HTMLInputElement.prototype,
  "value",
)!.set!;

function typeInto(input: HTMLInputElement, value: string): void {
  nativeInputValueSetter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function select(el: HTMLDivElement, name: string): void {
  const dropdown = el.querySelector<HTMLSelectElement>('[data-testid="functions-panel-select"]')!;
  const nativeSelectValueSetter = Object.getOwnPropertyDescriptor(
    window.HTMLSelectElement.prototype,
    "value",
  )!.set!;
  act(() => {
    nativeSelectValueSetter.call(dropdown, name);
    dropdown.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function clickGo(el: HTMLDivElement): void {
  act(() => {
    el.querySelector<HTMLButtonElement>('[data-testid="functions-panel-go"]')!.click();
  });
}

afterEach(() => {
  unmount();
  try {
    window.localStorage.clear();
  } catch {
    // no-op if unavailable
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
  it("shows a hint and a disabled, empty-of-options select when functions is undefined", () => {
    const { el } = mountPanel(baseDevice(undefined));
    expect(el.textContent).toContain("No function list yet");
    const dropdown = el.querySelector<HTMLSelectElement>('[data-testid="functions-panel-select"]')!;
    expect(dropdown.disabled).toBe(true);
    expect(dropdown.querySelectorAll("option").length).toBe(1); // placeholder only
  });

  it("shows a 'no functions' message and a disabled select when functions is an empty array", () => {
    const { el } = mountPanel(baseDevice([]));
    expect(el.textContent).toContain("The robot reported no functions.");
    expect(el.querySelector<HTMLSelectElement>('[data-testid="functions-panel-select"]')!.disabled).toBe(true);
  });

  it("lists every function name, in reported order, with a leading placeholder", () => {
    const { el } = mountPanel(baseDevice([{ name: "beep" }, { name: "spin" }]));
    const dropdown = el.querySelector<HTMLSelectElement>('[data-testid="functions-panel-select"]')!;
    const options = Array.from(dropdown.querySelectorAll("option"));
    expect(options.map((o) => o.value)).toEqual(["", "beep", "spin"]);
    expect(options[0]!.disabled).toBe(true);
    expect(dropdown.value).toBe("");
    expect(dropdown.disabled).toBe(false);
  });

  it("labels each option with the whole declaration so the list says what each function takes", () => {
    const { el } = mountPanel(
      baseDevice([
        { name: "sense" },
        { name: "cala", signature: "()" },
        { name: "line", signature: "(speed:number=25,max_speed:number=60,kp:number=120)" },
        { name: "push", signature: "(mm:number)" },
      ]),
    );
    const dropdown = el.querySelector<HTMLSelectElement>('[data-testid="functions-panel-select"]')!;
    const labels = Array.from(dropdown.querySelectorAll("option")).slice(1).map((o) => o.textContent);
    expect(labels).toEqual([
      "sense",
      "cala()",
      "line(speed: number = 25, max_speed: number = 60, kp: number = 120)",
      "push(mm: number)",
    ]);
    // Values stay the bare names -- that is what RUN sends.
    expect(Array.from(dropdown.querySelectorAll("option")).slice(1).map((o) => o.value)).toEqual(["sense", "cala", "line", "push"]);
  });

  it("disables the select when there is no open session, even with functions present", () => {
    const { el } = mountPanel(baseDevice([{ name: "beep" }], { sessionOpen: false }));
    expect(el.querySelector<HTMLSelectElement>('[data-testid="functions-panel-select"]')!.disabled).toBe(true);
  });

  it("disables Go when nothing is selected", () => {
    const { el } = mountPanel(baseDevice([{ name: "beep" }]));
    expect(el.querySelector<HTMLButtonElement>('[data-testid="functions-panel-go"]')!.disabled).toBe(true);
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
  it("shows a free-form input once selected, and Go with it blank sends just [name]", () => {
    const { el, socket } = mountPanel(baseDevice([{ name: "beep" }]));
    select(el, "beep");
    expect(el.querySelector('[data-testid="function-args-beep"]')).not.toBeNull();
    socket.sent.length = 0;
    clickGo(el);
    expect(socket.sent).toEqual([
      JSON.stringify({ type: "send-command", endpointId: "usb-ROBOT-A", verb: "RUN", fields: ["beep"] }),
    ]);
  });

  it("splits a free-form '10 20' into two args", () => {
    const { el, socket } = mountPanel(baseDevice([{ name: "move" }]));
    select(el, "move");
    const input = el.querySelector<HTMLInputElement>('[data-testid="function-args-move"]')!;
    act(() => {
      typeInto(input, "10 20");
    });
    socket.sent.length = 0;
    clickGo(el);
    expect(socket.sent).toEqual([
      JSON.stringify({
        type: "send-command",
        endpointId: "usb-ROBOT-A",
        verb: "RUN",
        fields: ["move", "10", "20"],
      }),
    ]);
  });

  it("disables the free-form input and Go when there is no open session", () => {
    const { el } = mountPanel(baseDevice([{ name: "beep" }], { sessionOpen: false }));
    // Select is disabled with no session, so nothing can be chosen --
    // Go stays disabled with nothing selected.
    expect(el.querySelector<HTMLSelectElement>('[data-testid="functions-panel-select"]')!.disabled).toBe(true);
    expect(el.querySelector<HTMLButtonElement>('[data-testid="functions-panel-go"]')!.disabled).toBe(true);
  });
});

describe("FunctionsPanel signature-driven args", () => {
  it("renders one labelled input per parameter name and sends their values in order", () => {
    const { el, socket } = mountPanel(baseDevice([{ name: "move", signature: "dist speed" }]));
    select(el, "move");
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
    clickGo(el);
    expect(socket.sent).toEqual([
      JSON.stringify({
        type: "send-command",
        endpointId: "usb-ROBOT-A",
        verb: "RUN",
        fields: ["move", "100", "50"],
      }),
    ]);
  });

  it("keeps positions: a skipped middle parameter falls back to its default (or 0), trailing empties are dropped", () => {
    const { el, socket } = mountPanel(
      baseDevice([{ name: "move", signature: "(dist:number, speed:number=60, turn:number)" }]),
    );
    select(el, "move");
    const distInput = el.querySelector<HTMLInputElement>('[data-testid="function-arg-move-0"]')!;
    const turnInput = el.querySelector<HTMLInputElement>('[data-testid="function-arg-move-2"]')!;
    expect(el.querySelector<HTMLInputElement>('[data-testid="function-arg-move-1"]')!.placeholder).toBe("60");
    act(() => {
      typeInto(distInput, "  100  ");
      typeInto(turnInput, "90");
    });
    socket.sent.length = 0;
    clickGo(el);
    expect(socket.sent).toEqual([
      JSON.stringify({
        type: "send-command",
        endpointId: "usb-ROBOT-A",
        verb: "RUN",
        fields: ["move", "100", "60", "90"],
      }),
    ]);
  });

  it("a declared empty signature '()' renders no inputs, a 'no parameters' note, and sends just the name", () => {
    const { el, socket } = mountPanel(baseDevice([{ name: "abort", signature: "()" }]));
    select(el, "abort");
    expect(el.querySelector('[data-testid="function-args-abort"]')).toBeNull();
    expect(el.querySelector('[data-testid="function-arg-abort-0"]')).toBeNull();
    expect(el.textContent).toContain("no parameters");
    socket.sent.length = 0;
    clickGo(el);
    expect(socket.sent).toEqual([
      JSON.stringify({ type: "send-command", endpointId: "usb-ROBOT-A", verb: "RUN", fields: ["abort"] }),
    ]);
  });
});

describe("FunctionsPanel per-function argument memory", () => {
  it("remembers values sent at Go time, gives a never-used function a blank input, and resets on selection switch", () => {
    const { el, socket } = mountPanel(
      baseDevice([
        { name: "square", signature: "side" },
        { name: "cala", signature: "()" },
        { name: "unused", signature: "x" },
      ]),
    );

    select(el, "square");
    const sideInput = el.querySelector<HTMLInputElement>('[data-testid="function-arg-square-0"]')!;
    act(() => {
      typeInto(sideInput, "40");
    });
    socket.sent.length = 0;
    clickGo(el);
    expect(socket.sent).toEqual([
      JSON.stringify({ type: "send-command", endpointId: "usb-ROBOT-A", verb: "RUN", fields: ["square", "40"] }),
    ]);

    select(el, "cala");
    expect(el.querySelector('[data-testid="function-arg-cala-0"]')).toBeNull();
    socket.sent.length = 0;
    clickGo(el);
    expect(socket.sent).toEqual([
      JSON.stringify({ type: "send-command", endpointId: "usb-ROBOT-A", verb: "RUN", fields: ["cala"] }),
    ]);

    select(el, "square");
    expect(el.querySelector<HTMLInputElement>('[data-testid="function-arg-square-0"]')!.value).toBe("40");

    select(el, "unused");
    expect(el.querySelector<HTMLInputElement>('[data-testid="function-arg-unused-0"]')!.value).toBe("");
  });

  it("does not remember a value that was typed but never sent with Go", () => {
    const { el } = mountPanel(baseDevice([{ name: "square", signature: "side" }, { name: "cala" }]));
    select(el, "square");
    const sideInput = el.querySelector<HTMLInputElement>('[data-testid="function-arg-square-0"]')!;
    act(() => {
      typeInto(sideInput, "99");
    });
    select(el, "cala");
    select(el, "square");
    expect(el.querySelector<HTMLInputElement>('[data-testid="function-arg-square-0"]')!.value).toBe("");
  });

  it("resets the selection to the placeholder when the selected function drops out of a refreshed list", () => {
    const device = baseDevice([{ name: "beep" }, { name: "spin" }]);
    let socket: FakeSocket | null = null;
    const el = mount(
      <WsProvider url="ws://test/" socketFactory={() => (socket = new FakeSocket())}>
        <FunctionsPanelHarness device={device} />
      </WsProvider>,
    );
    act(() => {
      socket!.emitOpen();
    });
    select(el, "beep");
    expect(el.querySelector<HTMLSelectElement>('[data-testid="functions-panel-select"]')!.value).toBe("beep");

    act(() => {
      rerenderWithFunctions(el, [{ name: "spin" }]);
    });
    expect(el.querySelector<HTMLSelectElement>('[data-testid="functions-panel-select"]')!.value).toBe("");
  });

  it("round-trips remembered arguments through localStorage across a remount", () => {
    const device = baseDevice([{ name: "square", signature: "side" }]);
    const { el } = mountPanel(device);
    select(el, "square");
    act(() => {
      typeInto(el.querySelector<HTMLInputElement>('[data-testid="function-arg-square-0"]')!, "77");
    });
    clickGo(el);
    unmount();

    const { el: el2 } = mountPanel(device);
    select(el2, "square");
    expect(el2.querySelector<HTMLInputElement>('[data-testid="function-arg-square-0"]')!.value).toBe("77");
  });
});

// A tiny harness that lets a test swap the `functions` prop on an
// already-mounted panel, to exercise the "selection drops out of a
// refreshed list" reset without remounting (which would also reset
// selection trivially and prove nothing).
let currentSetFunctions: ((fns: RobotFunction[]) => void) | null = null;

function FunctionsPanelHarness({ device }: { device: EndpointListEntry }) {
  const [functions, setFunctions] = useReactState<RobotFunction[] | undefined>(device.functions);
  currentSetFunctions = setFunctions;
  const merged: EndpointListEntry = { ...device, ...(functions !== undefined ? { functions } : {}) };
  return <FunctionsPanel device={merged} />;
}

function rerenderWithFunctions(_el: HTMLDivElement, fns: RobotFunction[]): void {
  currentSetFunctions!(fns);
}

describe("parseSignature", () => {
  it("accepts the declaration-shaped grammar with types and defaults", () => {
    expect(parseSignature("(side_mm:number, speed:number=60)")).toEqual([
      { name: "side_mm", type: "number" },
      { name: "speed", type: "number", defaultValue: "60" },
    ]);
    expect(parseSignature("(side_mm,speed=60)")).toEqual([{ name: "side_mm" }, { name: "speed", defaultValue: "60" }]);
  });

  it("accepts the bare whitespace form and mixed forms", () => {
    expect(parseSignature("dist speed")).toEqual([{ name: "dist" }, { name: "speed" }]);
    expect(parseSignature("dist:number speed=5")).toEqual([{ name: "dist", type: "number" }, { name: "speed", defaultValue: "5" }]);
  });

  it("distinguishes unknown (undefined / blank) from explicitly none '()'", () => {
    expect(parseSignature(undefined)).toBeUndefined();
    expect(parseSignature("   ")).toBeUndefined();
    expect(parseSignature("()")).toEqual([]);
  });

  it("positionalArgs fills skipped middles with default or 0 and drops trailing empties", () => {
    const params = parseSignature("(a, b=7, c)")!;
    expect(positionalArgs(params, ["1", "", "3"])).toEqual(["1", "7", "3"]);
    expect(positionalArgs(params, ["", "", "3"])).toEqual(["0", "7", "3"]);
    expect(positionalArgs(params, ["1", "", ""])).toEqual(["1"]);
    expect(positionalArgs(params, ["", "", ""])).toEqual([]);
  });
});
