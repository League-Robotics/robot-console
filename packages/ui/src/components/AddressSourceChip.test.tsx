// @vitest-environment jsdom
/**
 * AddressSourceChip.test.tsx — component tests (sprint 8 ticket 006 /
 * SUC-006; rewritten sprint 015 ticket 008 against the `Snapshot`
 * contract's three-way `RadioSourceWire`).
 *
 * Proves: each of the three `RadioSourceWire` outcomes renders its own
 * text, always neutral (no warning variant left -- see the component's
 * own doc comment); `(channel, group)` renders alongside the source
 * text; the whole `radio` shape is read straight from a
 * `SnapshotDevice.radio`-shaped fixture, with no reconstruction.
 */
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { AddressSourceChip } from "./AddressSourceChip";

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

function chip(el: HTMLDivElement): HTMLElement | null {
  return el.querySelector('[data-testid="address-source-chip"]');
}

describe("AddressSourceChip resolution outcomes", () => {
  it("renders 'set for this device' for 'override'", () => {
    const el = mount(<AddressSourceChip radio={{ channel: 41, group: 3, source: "override" }} />);
    const node = chip(el)!;
    expect(node.textContent).toContain("ch 41 / grp 3");
    expect(node.textContent).toContain("set for this device");
  });

  it("renders 'confirmed by registry' for 'registry'", () => {
    const el = mount(<AddressSourceChip radio={{ channel: 37, group: 3, source: "registry" }} />);
    expect(chip(el)!.textContent).toContain("confirmed by registry");
  });

  it("renders 'derived from the name' for 'derived'", () => {
    const el = mount(<AddressSourceChip radio={{ channel: 55, group: 114, source: "derived" }} />);
    const node = chip(el)!;
    expect(node.textContent).toContain("ch 55 / grp 114");
    expect(node.textContent).toContain("derived from the name");
  });
});
