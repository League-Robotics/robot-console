// @vitest-environment jsdom
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { WifiCredentialsDialog, validateWifiInput } from "./WifiCredentialsDialog";
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
  window.localStorage.clear();
});

function mountWifi(
  props: { linkId?: string; linkOpen?: boolean; name?: string } = {},
): { el: HTMLDivElement; socket: FakeSocket } {
  let socket: FakeSocket | null = null;
  const el = mount(
    <WsProvider url="ws://test/" socketFactory={() => (socket = new FakeSocket())}>
      <WifiCredentialsDialog
        linkId={props.linkId ?? "usb-ROBOT-A"}
        linkOpen={props.linkOpen ?? true}
        name={props.name ?? "tigez"}
      />
    </WsProvider>,
  );
  act(() => {
    socket!.emitOpen();
  });
  return { el, socket: socket! };
}

function type(el: HTMLDivElement, selector: string, value: string): void {
  const input = el.querySelector<HTMLInputElement>(selector)!;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function sent(socket: FakeSocket): unknown[] {
  return socket.sent.map((raw) => JSON.parse(raw));
}

describe("validateWifiInput", () => {
  it("refuses spaces, empties, and over-long values; accepts a blank password only when one is stored", () => {
    expect(validateWifiInput("Busboom Mesh", "pw", false)).toContain("spaces");
    expect(validateWifiInput("", "pw", false)).toContain("network name");
    expect(validateWifiInput("Net", "", false)).toContain("password");
    expect(validateWifiInput("Net", "", true)).toBeNull();
    expect(validateWifiInput("x".repeat(33), "pw", false)).toContain("too long");
    expect(validateWifiInput("Net", "p".repeat(64), false)).toContain("too long");
    expect(validateWifiInput("Busboom_Garage", "hunter2", false)).toBeNull();
  });
});

describe("WifiCredentialsDialog", () => {
  it("asks the host for the stored network on open, prefills the name, and on submit saves then provisions this endpoint", () => {
    const { el, socket } = mountWifi();
    act(() => {
      el.querySelector<HTMLButtonElement>('[data-testid="wifi-credentials-trigger"]')!.click();
    });
    expect(sent(socket)).toEqual([{ type: "get-wifi-credentials" }]);
    act(() => {
      socket.emitMessage({ type: "wifi-credentials", ssid: "Busboom_Garage", hasPassword: true, source: "env", seq: 1 });
    });
    expect(el.querySelector<HTMLInputElement>('[data-testid="wifi-ssid"]')!.value).toBe("Busboom_Garage");
    expect(el.querySelector<HTMLInputElement>('[data-testid="wifi-password"]')!.placeholder).toContain("leave blank");

    act(() => {
      el.querySelector<HTMLButtonElement>('[data-testid="wifi-write"]')!.click();
    });
    expect(sent(socket).slice(1)).toEqual([
      { type: "set-wifi-credentials", ssid: "Busboom_Garage", password: "" },
      { type: "provision-wifi", linkId: "usb-ROBOT-A", slot: 0 },
    ]);
    expect(el.querySelector('[data-testid="wifi-write"]')?.textContent).toBe("Writing…");

    act(() => {
      socket.emitMessage({
        type: "wifi-provision-result",
        linkId: "usb-ROBOT-A",
        ok: true,
        message: "wrote Busboom_Garage to slot 0 -- power-cycle the robot and it will join",
        seq: 2,
      });
    });
    expect(el.querySelector('[data-testid="wifi-result"]')?.textContent).toContain("power-cycle");
    expect(el.querySelector('[data-testid="wifi-write"]')?.textContent).toBe("Save and write to robot");
  });

  it("refuses a network name with a space before sending anything, and never echoes the password anywhere", () => {
    const { el, socket } = mountWifi();
    act(() => {
      el.querySelector<HTMLButtonElement>('[data-testid="wifi-credentials-trigger"]')!.click();
    });
    act(() => {
      socket.emitMessage({ type: "wifi-credentials", ssid: null, hasPassword: false, source: "none", seq: 1 });
    });
    type(el, '[data-testid="wifi-ssid"]', "Busboom Mesh");
    type(el, '[data-testid="wifi-password"]', "topsecret");
    act(() => {
      el.querySelector<HTMLButtonElement>('[data-testid="wifi-write"]')!.click();
    });
    expect(el.querySelector('[data-testid="wifi-error"]')?.textContent).toContain("spaces");
    expect(sent(socket)).toEqual([{ type: "get-wifi-credentials" }]);
    expect(el.textContent).not.toContain("topsecret");
  });

  it("disables the write button without an open link", () => {
    const { el } = mountWifi({ linkOpen: false });
    act(() => {
      el.querySelector<HTMLButtonElement>('[data-testid="wifi-credentials-trigger"]')!.click();
    });
    expect(el.querySelector<HTMLButtonElement>('[data-testid="wifi-write"]')!.disabled).toBe(true);
  });
});
