// @vitest-environment jsdom
/**
 * GetSetPanel.test.tsx — component tests (ticket 005 / SUC-001, SUC-004).
 *
 * Proves: bare `GET` (no name entered) sends `GET` with no fields;
 * `GET <name>` sends `GET` with one field; `SET <name> <value>` sends
 * `SET` with two fields; an `err` reply for an unknown name is shown to
 * the operator, not swallowed.
 */
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { EndpointListEntry } from "@robot-console/host/src/wsMessages.js";
import { GetSetPanel } from "./GetSetPanel";
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

function baseDevice(overrides: Partial<EndpointListEntry> = {}): EndpointListEntry {
  return {
    endpointId: "usb-ROBOT-A",
    transport: "usb",
    resourceKey: "usb-ROBOT-A",
    classification: { type: "robot", role: "NEZHA2", commonName: "robot", dialect: "space", evidence: "role" },
    name: "zavaz",
    role: "NEZHA2",
    sessionOpen: true,
    usb: { serialNumber: "ROBOT-A-FULL", displaySerial: "0004", port: "/dev/cu.usbmodemC" },
    ...overrides,
  };
}

function mountPanel(device: EndpointListEntry): { el: HTMLDivElement; socket: FakeSocket } {
  let socket: FakeSocket | null = null;
  const el = mount(
    <WsProvider url="ws://test/" socketFactory={() => (socket = new FakeSocket())}>
      <GetSetPanel device={device} />
    </WsProvider>,
  );
  act(() => {
    socket!.emitOpen();
  });
  return { el, socket: socket! };
}

describe("GetSetPanel", () => {
  it("sends bare GET (no fields) when the name field is empty", () => {
    const { el, socket } = mountPanel(baseDevice());
    const getButton = el.querySelector<HTMLButtonElement>('[data-testid="get-set-get-button"]')!;

    act(() => {
      getButton.click();
    });

    expect(socket.sent).toEqual([
      JSON.stringify({ type: "send-command", endpointId: "usb-ROBOT-A", verb: "GET" }),
    ]);
  });

  it("sends GET <name> when a name is entered", () => {
    const { el, socket } = mountPanel(baseDevice());
    const nameInput = el.querySelector<HTMLInputElement>('[data-testid="get-set-name"]')!;
    const getButton = el.querySelector<HTMLButtonElement>('[data-testid="get-set-get-button"]')!;

    act(() => {
      typeInto(nameInput, "trackwidth");
    });
    act(() => {
      getButton.click();
    });

    expect(socket.sent).toEqual([
      JSON.stringify({
        type: "send-command",
        endpointId: "usb-ROBOT-A",
        verb: "GET",
        fields: ["trackwidth"],
      }),
    ]);
  });

  it("sends SET <name> <value>", () => {
    const { el, socket } = mountPanel(baseDevice());
    const nameInput = el.querySelector<HTMLInputElement>('[data-testid="get-set-name"]')!;
    const valueInput = el.querySelector<HTMLInputElement>('[data-testid="get-set-value"]')!;
    const setButton = el.querySelector<HTMLButtonElement>('[data-testid="get-set-set-button"]')!;

    act(() => {
      typeInto(nameInput, "trackwidth");
      typeInto(valueInput, "128");
    });
    act(() => {
      setButton.click();
    });

    expect(socket.sent).toEqual([
      JSON.stringify({
        type: "send-command",
        endpointId: "usb-ROBOT-A",
        verb: "SET",
        fields: ["trackwidth", "128"],
      }),
    ]);
  });

  it("disables SET until both name and value are entered", () => {
    const { el } = mountPanel(baseDevice());
    const nameInput = el.querySelector<HTMLInputElement>('[data-testid="get-set-name"]')!;
    const setButton = el.querySelector<HTMLButtonElement>('[data-testid="get-set-set-button"]')!;

    expect(setButton.disabled).toBe(true);

    act(() => {
      typeInto(nameInput, "trackwidth");
    });
    expect(setButton.disabled).toBe(true);
  });

  it("shows an err reply for an unknown name, not swallowed", () => {
    const { el, socket } = mountPanel(baseDevice());
    const nameInput = el.querySelector<HTMLInputElement>('[data-testid="get-set-name"]')!;
    const getButton = el.querySelector<HTMLButtonElement>('[data-testid="get-set-get-button"]')!;

    act(() => {
      typeInto(nameInput, "nonexistent");
    });
    act(() => {
      getButton.click();
    });
    act(() => {
      socket.emitMessage({
        type: "line",
        endpointId: "usb-ROBOT-A",
        direction: "rx",
        line: "err 4 unknown-field",
      });
    });

    const replies = el.querySelector('[data-testid="get-set-replies"]')!;
    expect(replies.textContent).toContain("err 4 unknown-field");
    expect(replies.querySelector(".get-set-panel-reply-error")).not.toBeNull();
  });

  it("shows GET reply lines that arrive after the send, ignoring earlier traffic", () => {
    const { el, socket } = mountPanel(baseDevice());

    act(() => {
      // Traffic that predates this panel's own send must not appear as
      // "the reply".
      socket.emitMessage({ type: "line", endpointId: "usb-ROBOT-A", direction: "rx", line: "status a=1" });
    });

    const getButton = el.querySelector<HTMLButtonElement>('[data-testid="get-set-get-button"]')!;
    act(() => {
      getButton.click();
    });
    act(() => {
      socket.emitMessage({ type: "line", endpointId: "usb-ROBOT-A", direction: "rx", line: "get name value" });
      socket.emitMessage({ type: "line", endpointId: "usb-ROBOT-A", direction: "rx", line: "ack 1 0 none" });
    });

    const replies = el.querySelector('[data-testid="get-set-replies"]')!;
    expect(replies.textContent).not.toContain("status a=1");
    expect(replies.textContent).toContain("get name value");
    expect(replies.textContent).toContain("ack 1 0 none");
  });

  it("disables inputs and buttons with a hint when no session is open", () => {
    const { el } = mountPanel(baseDevice({ sessionOpen: false }));

    expect(el.querySelector<HTMLInputElement>('[data-testid="get-set-name"]')!.disabled).toBe(true);
    expect(el.querySelector<HTMLButtonElement>('[data-testid="get-set-get-button"]')!.disabled).toBe(true);
    expect(el.querySelector<HTMLButtonElement>('[data-testid="get-set-set-button"]')!.disabled).toBe(true);
    expect(el.textContent).toContain("No link open");
  });
});
