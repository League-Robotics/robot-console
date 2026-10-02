// @vitest-environment jsdom
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CollapsibleGroup } from "./CollapsibleGroup";

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

beforeEach(() => {
  window.localStorage.clear();
});

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

describe("CollapsibleGroup", () => {
  it("starts collapsed with the count beside the title, and opens on the toggle", () => {
    const el = mount(
      <CollapsibleGroup id="bridges" title="Radio bridges" count={2}>
        <p>cards</p>
      </CollapsibleGroup>,
    );
    const toggle = el.querySelector<HTMLButtonElement>('[data-testid="devices-group-toggle-bridges"]')!;
    const content = el.querySelector<HTMLDivElement>('[data-testid="devices-group-bridges-content"]')!;
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.textContent).toContain("Radio bridges");
    expect(toggle.textContent).toContain("(2)");
    expect(content.hidden).toBe(true);

    act(() => toggle.click());
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(toggle.textContent).not.toContain("(2)");
    expect(content.hidden).toBe(false);
  });

  it("remembers the choice for the same group in this browser", () => {
    const first = mount(
      <CollapsibleGroup id="joysticks" title="Joysticks">
        <p>cards</p>
      </CollapsibleGroup>,
    );
    act(() => first.querySelector<HTMLButtonElement>('[data-testid="devices-group-toggle-joysticks"]')!.click());
    act(() => root!.unmount());
    root = null;
    first.remove();

    const again = mount(
      <CollapsibleGroup id="joysticks" title="Joysticks">
        <p>cards</p>
      </CollapsibleGroup>,
    );
    expect(again.querySelector<HTMLDivElement>('[data-testid="devices-group-joysticks-content"]')!.hidden).toBe(false);
  });
});
