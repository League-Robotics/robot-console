// @vitest-environment jsdom
/**
 * CommandStrip.test.tsx — component tests (ticket 005 / SUC-006,
 * SUC-007).
 *
 * Proves: HELLO/ID/VER/STATUS each send their bare verb via
 * `sendCommand` with no fields (unsequenced dispatch is a host-side
 * concern, not asserted here); GET/SET dispatch the same way sprint
 * 006's retired Get/Set panel did (bare `GET` when the name is empty,
 * `GET <name>` when entered, `SET <name> <value>` requiring both); the
 * strip renders no reply area of its own (no watermark-style local
 * state to have a bug in); all controls are disabled with a hint when
 * no session is open.
 */
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { EndpointListEntry } from "@robot-console/host/src/wsMessages.js";
import { CommandStrip } from "./CommandStrip";
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

function mountStrip(device: EndpointListEntry): { el: HTMLDivElement; socket: FakeSocket } {
  let socket: FakeSocket | null = null;
  const el = mount(
    <WsProvider url="ws://test/" socketFactory={() => (socket = new FakeSocket())}>
      <CommandStrip device={device} />
    </WsProvider>,
  );
  act(() => {
    socket!.emitOpen();
  });
  return { el, socket: socket! };
}

describe("CommandStrip", () => {
  it("sends bare HELLO with no fields", () => {
    const { el, socket } = mountStrip(baseDevice());
    act(() => {
      el.querySelector<HTMLButtonElement>('[data-testid="command-strip-hello"]')!.click();
    });
    expect(socket.sent).toEqual([
      JSON.stringify({ type: "send-command", endpointId: "usb-ROBOT-A", verb: "HELLO" }),
    ]);
  });

  it("sends bare ID with no fields", () => {
    const { el, socket } = mountStrip(baseDevice());
    act(() => {
      el.querySelector<HTMLButtonElement>('[data-testid="command-strip-id"]')!.click();
    });
    expect(socket.sent).toEqual([
      JSON.stringify({ type: "send-command", endpointId: "usb-ROBOT-A", verb: "ID" }),
    ]);
  });

  it("sends bare VER with no fields", () => {
    const { el, socket } = mountStrip(baseDevice());
    act(() => {
      el.querySelector<HTMLButtonElement>('[data-testid="command-strip-ver"]')!.click();
    });
    expect(socket.sent).toEqual([
      JSON.stringify({ type: "send-command", endpointId: "usb-ROBOT-A", verb: "VER" }),
    ]);
  });

  it("sends bare STATUS with no fields", () => {
    const { el, socket } = mountStrip(baseDevice());
    act(() => {
      el.querySelector<HTMLButtonElement>('[data-testid="command-strip-status"]')!.click();
    });
    expect(socket.sent).toEqual([
      JSON.stringify({ type: "send-command", endpointId: "usb-ROBOT-A", verb: "STATUS" }),
    ]);
  });

  it("sends bare GET (no fields) when the name field is empty", () => {
    const { el, socket } = mountStrip(baseDevice());
    act(() => {
      el.querySelector<HTMLButtonElement>('[data-testid="command-strip-get"]')!.click();
    });
    expect(socket.sent).toEqual([
      JSON.stringify({ type: "send-command", endpointId: "usb-ROBOT-A", verb: "GET" }),
    ]);
  });

  it("sends GET <name> when a name is entered", () => {
    const { el, socket } = mountStrip(baseDevice());
    const nameInput = el.querySelector<HTMLInputElement>('[data-testid="command-strip-name"]')!;
    act(() => {
      typeInto(nameInput, "trackwidth");
    });
    act(() => {
      el.querySelector<HTMLButtonElement>('[data-testid="command-strip-get"]')!.click();
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
    const { el, socket } = mountStrip(baseDevice());
    const nameInput = el.querySelector<HTMLInputElement>('[data-testid="command-strip-name"]')!;
    const valueInput = el.querySelector<HTMLInputElement>('[data-testid="command-strip-value"]')!;
    act(() => {
      typeInto(nameInput, "trackwidth");
      typeInto(valueInput, "128");
    });
    act(() => {
      el.querySelector<HTMLButtonElement>('[data-testid="command-strip-set"]')!.click();
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
    const { el } = mountStrip(baseDevice());
    const nameInput = el.querySelector<HTMLInputElement>('[data-testid="command-strip-name"]')!;
    const setButton = el.querySelector<HTMLButtonElement>('[data-testid="command-strip-set"]')!;

    expect(setButton.disabled).toBe(true);

    act(() => {
      typeInto(nameInput, "trackwidth");
    });
    expect(setButton.disabled).toBe(true);
  });

  it("renders no reply area of its own -- replies are DeviceConsole's job", () => {
    const { el, socket } = mountStrip(baseDevice());
    act(() => {
      socket.emitMessage({
        type: "line",
        endpointId: "usb-ROBOT-A",
        direction: "rx",
        line: "get trackwidth 128",
      });
    });
    // No reply region like the retired Get/Set panel's exists on this component at all.
    expect(el.querySelector('[data-testid="get-set-replies"]')).toBeNull();
    expect(el.textContent).not.toContain("trackwidth 128");
  });

  it("disables every control and shows a hint when no session is open", () => {
    const { el } = mountStrip(baseDevice({ sessionOpen: false }));

    for (const testId of [
      "command-strip-hello",
      "command-strip-id",
      "command-strip-ver",
      "command-strip-status",
      "command-strip-get",
      "command-strip-set",
    ]) {
      expect(el.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)!.disabled).toBe(true);
    }
    expect(el.querySelector<HTMLInputElement>('[data-testid="command-strip-name"]')!.disabled).toBe(true);
    expect(el.querySelector<HTMLInputElement>('[data-testid="command-strip-value"]')!.disabled).toBe(true);
    expect(el.textContent).toContain("No link open");
  });
});
