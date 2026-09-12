// @vitest-environment jsdom
/**
 * RadioAddressDialog.test.tsx — sprint 015 ticket 006's own suite:
 * submitting sends `set-radio-override` over the socket (never
 * `localStorage`), prefills from the `radio` prop when present, falls
 * back to the name-derived default otherwise, and validates the same
 * `0-83`/`0-255` integer range the host itself enforces.
 */
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { nameToRadioAddress } from "@robot-console/protocol";
import { RadioAddressDialog } from "./RadioAddressDialog";
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
  try {
    window.localStorage.clear();
  } catch {
    // jsdom always has localStorage; mirrors this suite's own
    // best-effort convention elsewhere in the codebase.
  }
});

function mountDialog(props: Partial<Parameters<typeof RadioAddressDialog>[0]> = {}): { el: HTMLDivElement; socket: FakeSocket } {
  let socket: FakeSocket | null = null;
  const el = mount(
    <WsProvider url="ws://test/" socketFactory={() => (socket = new FakeSocket())}>
      <RadioAddressDialog deviceId={1198504156} name="tigez" {...props} />
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

function open(el: HTMLDivElement): void {
  act(() => {
    el.querySelector<HTMLButtonElement>('[data-testid="radio-address-trigger"]')!.click();
  });
}

describe("RadioAddressDialog", () => {
  it("prefills the name-derived default when no radio prop is given", () => {
    const { el } = mountDialog();
    open(el);
    const derived = nameToRadioAddress("tigez");
    expect(el.querySelector<HTMLInputElement>('[data-testid="radio-channel"]')!.value).toBe(String(derived.channel));
    expect(el.querySelector<HTMLInputElement>('[data-testid="radio-group"]')!.value).toBe(String(derived.group));
  });

  it("prefills from the radio prop (the snapshot's resolved address) when present, ahead of the name-derived default", () => {
    const { el } = mountDialog({ radio: { channel: 41, group: 3, source: "override" } });
    open(el);
    expect(el.querySelector<HTMLInputElement>('[data-testid="radio-channel"]')!.value).toBe("41");
    expect(el.querySelector<HTMLInputElement>('[data-testid="radio-group"]')!.value).toBe("3");
  });

  it("submitting sends set-radio-override with the numeric deviceId, not localStorage", () => {
    const { el, socket } = mountDialog();
    open(el);
    type(el, '[data-testid="radio-channel"]', "55");
    type(el, '[data-testid="radio-group"]', "114");
    act(() => {
      el.querySelector<HTMLButtonElement>('[data-testid="radio-save"]')!.click();
    });

    expect(sent(socket)).toEqual([{ type: "set-radio-override", deviceId: 1198504156, channel: 55, group: 114 }]);
    expect(el.querySelector('[data-testid="radio-saved"]')?.textContent).toContain("channel 55, group 114");
    expect(window.localStorage.length).toBe(0);
  });

  it("validates the channel range client-side before sending anything", () => {
    const { el, socket } = mountDialog();
    open(el);
    type(el, '[data-testid="radio-channel"]', "99");
    act(() => {
      el.querySelector<HTMLButtonElement>('[data-testid="radio-save"]')!.click();
    });
    expect(el.querySelector('[data-testid="radio-error"]')?.textContent).toContain("0 to 83");
    expect(socket.sent).toEqual([]);
  });

  it("validates the group range client-side before sending anything", () => {
    const { el, socket } = mountDialog();
    open(el);
    type(el, '[data-testid="radio-group"]', "999");
    act(() => {
      el.querySelector<HTMLButtonElement>('[data-testid="radio-save"]')!.click();
    });
    expect(el.querySelector('[data-testid="radio-error"]')?.textContent).toContain("0 to 255");
    expect(socket.sent).toEqual([]);
  });
});
