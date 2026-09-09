// @vitest-environment jsdom
/**
 * AddressSourceChip.test.tsx — component tests (sprint 8 ticket 006 /
 * SUC-006).
 *
 * Proves: every `addressSource` outcome renders the correct text and
 * neutral/warning `data-variant`; the `"local-derived"` outcome's two
 * different input shapes (`registryWasConsidered` false vs. true) drive
 * two different variants; `(channel, group)` renders alongside the
 * source text; no `addressSource` (or an `mbserial` transport) renders
 * nothing; a non-empty `failoverTrail` renders as plain visible text.
 * Fixture props only -- no live registry, no `WsProvider` dependency,
 * per the ticket.
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
  it("renders neutral for 'config'", () => {
    const el = mount(<AddressSourceChip addressSource="config" viaRelay={{ channel: 37, group: 3 }} />);
    const node = chip(el)!;
    expect(node.getAttribute("data-variant")).toBe("neutral");
    expect(node.textContent).toContain("ch 37 / grp 3");
    expect(node.textContent).toContain("from config");
  });

  it("renders neutral for 'registry'", () => {
    const el = mount(<AddressSourceChip addressSource="registry" viaRelay={{ channel: 37, group: 3 }} />);
    const node = chip(el)!;
    expect(node.getAttribute("data-variant")).toBe("neutral");
    expect(node.textContent).toContain("confirmed by registry");
  });

  it("renders neutral for 'explicit', stating it was entered by the user", () => {
    const el = mount(<AddressSourceChip addressSource="explicit" viaRelay={{ channel: 55, group: 114 }} />);
    const node = chip(el)!;
    expect(node.getAttribute("data-variant")).toBe("neutral");
    expect(node.textContent).toContain("ch 55 / grp 114");
    expect(node.textContent).toContain("entered by you");
  });

  it("renders warning for 'derived' (registry echoed its own guess)", () => {
    const el = mount(<AddressSourceChip addressSource="derived" viaRelay={{ channel: 37, group: 3 }} />);
    const node = chip(el)!;
    expect(node.getAttribute("data-variant")).toBe("warning");
    expect(node.textContent).toContain("derived");
  });

  it("renders neutral for 'local-derived' when no registry was ever discovered (the ordinary classroom path)", () => {
    const el = mount(
      <AddressSourceChip
        addressSource="local-derived"
        viaRelay={{ channel: 37, group: 3 }}
        registryWasConsidered={false}
      />,
    );
    const node = chip(el)!;
    expect(node.getAttribute("data-variant")).toBe("neutral");
    expect(node.textContent).toContain("derived (no registry)");
  });

  it("defaults registryWasConsidered to false when omitted, matching the ordinary classroom path", () => {
    const el = mount(<AddressSourceChip addressSource="local-derived" viaRelay={{ channel: 37, group: 3 }} />);
    expect(chip(el)!.getAttribute("data-variant")).toBe("neutral");
  });

  it("renders warning for 'local-derived' when a registry was discovered but the resolution still fell back", () => {
    const el = mount(
      <AddressSourceChip
        addressSource="local-derived"
        viaRelay={{ channel: 37, group: 3 }}
        registryWasConsidered={true}
      />,
    );
    const node = chip(el)!;
    expect(node.getAttribute("data-variant")).toBe("warning");
  });
});

describe("AddressSourceChip not-applicable cases", () => {
  it("renders nothing when addressSource is undefined", () => {
    const el = mount(<AddressSourceChip />);
    expect(chip(el)).toBeNull();
    expect(el.textContent).toBe("");
  });

  it("renders nothing for an mbserial transport even if addressSource were somehow present", () => {
    const el = mount(
      <AddressSourceChip
        addressSource="config"
        viaRelay={{ channel: 37, group: 3 }}
        transport="mbserial"
      />,
    );
    expect(chip(el)).toBeNull();
  });
});

describe("AddressSourceChip failover trail", () => {
  it("renders nothing extra when the trail is empty", () => {
    const el = mount(<AddressSourceChip addressSource="registry" viaRelay={{ channel: 37, group: 3 }} />);
    expect(el.querySelector('[data-testid="address-source-chip-trail"]')).toBeNull();
  });

  it("renders a single abandoned candidate as visible text, not behind a disclosure", () => {
    const el = mount(
      <AddressSourceChip
        addressSource="local-derived"
        viaRelay={{ channel: 37, group: 3 }}
        registryWasConsidered={true}
        failoverTrail={[{ name: "zavaz", transport: "relay-radio", reason: "no reply" }]}
      />,
    );
    const trail = el.querySelector('[data-testid="address-source-chip-trail"]')!;
    expect(trail.textContent).toBe("gave up on zavaz (no reply)");
    // Not a <details>/<summary> or any other disclosure control.
    expect(el.querySelector("details")).toBeNull();
  });

  it("chains multiple abandoned candidates into one readable line", () => {
    const el = mount(
      <AddressSourceChip
        addressSource="local-derived"
        viaRelay={{ channel: 37, group: 3 }}
        registryWasConsidered={true}
        failoverTrail={[
          { name: "zavaz", transport: "relay-radio", reason: "no reply" },
          { name: "kivex", transport: "relay-radio", reason: "timeout" },
        ]}
      />,
    );
    const trail = el.querySelector('[data-testid="address-source-chip-trail"]')!;
    expect(trail.textContent).toBe("gave up on zavaz (no reply), tried kivex (timeout)");
  });
});
