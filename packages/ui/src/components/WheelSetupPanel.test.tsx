// @vitest-environment jsdom
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WheelSetupPanel, type WheelSetup } from "./WheelSetupPanel";

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

function setValue(el: HTMLDivElement, id: string, value: string): void {
  const control = el.querySelector<HTMLInputElement | HTMLSelectElement>(`#${id}`)!;
  const proto = control instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")!.set!;
  act(() => {
    setter.call(control, value);
    control.dispatchEvent(new Event(control instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  });
}

function writeButton(el: HTMLDivElement): HTMLButtonElement {
  return el.querySelector<HTMLButtonElement>('[data-testid="wheel-setup-write"]')!;
}

const STOCK: WheelSetup = { scaleLeft: 1, scaleRight: 1, portLeft: 1, portRight: 2 };

describe("WheelSetupPanel", () => {
  it("shows what the robot reports", () => {
    const el = mount(<WheelSetupPanel current={{ ...STOCK, scaleLeft: -1 }} canWrite onWrite={() => {}} />);
    expect(el.querySelector<HTMLInputElement>("#wheel-setup-scaleLeft")!.value).toBe("-1");
    expect(el.querySelector<HTMLSelectElement>("#wheel-setup-portRight")!.value).toBe("2");
  });

  it("puts both multipliers on one row and both ports on another", () => {
    const el = mount(<WheelSetupPanel current={STOCK} canWrite onWrite={() => {}} />);
    expect(el.querySelectorAll('[data-testid="wheel-setup-scales"] input')).toHaveLength(2);
    expect(el.querySelectorAll('[data-testid="wheel-setup-ports"] select')).toHaveLength(2);
    expect(el.querySelectorAll('[data-testid="wheel-setup-table"] tr')).toHaveLength(2);
  });

  it("writes the edited multipliers and ports", () => {
    const onWrite = vi.fn();
    const el = mount(<WheelSetupPanel current={STOCK} canWrite onWrite={onWrite} />);
    setValue(el, "wheel-setup-scaleRight", "0.97");
    setValue(el, "wheel-setup-portLeft", "2");
    setValue(el, "wheel-setup-portRight", "1");
    act(() => writeButton(el).click());
    expect(onWrite).toHaveBeenCalledWith({ scaleLeft: 1, scaleRight: 0.97, portLeft: 2, portRight: 1 });
  });

  it("reports each valid edit as it is made, before anything is written", () => {
    const onEdit = vi.fn();
    const el = mount(<WheelSetupPanel current={STOCK} canWrite onWrite={() => {}} onEdit={onEdit} />);
    setValue(el, "wheel-setup-scaleLeft", "-1");
    expect(onEdit).toHaveBeenLastCalledWith({ scaleLeft: -1, scaleRight: 1, portLeft: 1, portRight: 2 });
    setValue(el, "wheel-setup-portLeft", "2");
    expect(onEdit).toHaveBeenCalledTimes(1);
    setValue(el, "wheel-setup-portRight", "1");
    expect(onEdit).toHaveBeenLastCalledWith({ scaleLeft: -1, scaleRight: 1, portLeft: 2, portRight: 1 });
  });

  it("refuses two wheels on one port, and a zero multiplier", () => {
    const el = mount(<WheelSetupPanel current={STOCK} canWrite onWrite={() => {}} />);
    setValue(el, "wheel-setup-portLeft", "2");
    expect(writeButton(el).disabled).toBe(true);
    expect(el.querySelector('[data-testid="wheel-setup-same-port"]')).not.toBeNull();
    setValue(el, "wheel-setup-portLeft", "1");
    setValue(el, "wheel-setup-scaleLeft", "0");
    expect(writeButton(el).disabled).toBe(true);
  });

  it("cannot write without an open link", () => {
    const el = mount(<WheelSetupPanel current={STOCK} canWrite={false} onWrite={() => {}} />);
    expect(writeButton(el).disabled).toBe(true);
  });

  it("says so when the robot has not reported its settings", () => {
    const el = mount(<WheelSetupPanel current={undefined} canWrite onWrite={() => {}} />);
    expect(el.querySelector('[data-testid="wheel-setup-unknown"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="wheel-setup-write"]')).toBeNull();
  });
});
