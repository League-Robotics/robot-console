// @vitest-environment jsdom
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { ForgetDeviceDialog } from "./ForgetDeviceDialog";
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
  container?.remove();
  container = null;
});

function Where() {
  return <p data-testid="where">{useLocation().pathname}</p>;
}

function mountDialog(): { el: HTMLDivElement; socket: FakeSocket } {
  let socket: FakeSocket | null = null;
  const el = mount(
    <MemoryRouter initialEntries={["/d/usb-A"]}>
      <WsProvider url="ws://test/" socketFactory={() => (socket = new FakeSocket())}>
        <Routes>
          <Route path="*" element={<ForgetDeviceDialog deviceId={42} name="zapig" />} />
        </Routes>
        <Where />
      </WsProvider>
    </MemoryRouter>,
  );
  act(() => {
    socket!.emitOpen();
  });
  return { el, socket: socket! };
}

function click(el: HTMLDivElement, testId: string): void {
  act(() => {
    el.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)!.click();
  });
}

describe("ForgetDeviceDialog", () => {
  it("asks first, then forgets the device and goes back to the list", () => {
    const { el, socket } = mountDialog();
    click(el, "forget-device-trigger");
    expect(socket.sent.map((text) => JSON.parse(text))).not.toContainEqual({ type: "forget-device", deviceId: 42 });

    click(el, "forget-device-confirm");
    expect(socket.sent.map((text) => JSON.parse(text))).toContainEqual({ type: "forget-device", deviceId: 42 });
    expect(el.querySelector('[data-testid="where"]')!.textContent).toBe("/");
  });

  it("Cancel sends nothing and stays on the page", () => {
    const { el, socket } = mountDialog();
    click(el, "forget-device-trigger");
    click(el, "forget-device-cancel");
    expect(socket.sent.some((text) => text.includes("forget-device"))).toBe(false);
    expect(el.querySelector('[data-testid="where"]')!.textContent).toBe("/d/usb-A");
  });
});
