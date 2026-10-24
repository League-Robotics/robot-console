// @vitest-environment jsdom
/**
 * RobotSelect.test.tsx — the robot-name picker's own focused test
 * (ticket 017-007; moved out of `RelayPage.tsx`'s former inline
 * definition along with the component itself). `RelayPage.test.tsx`
 * still exercises it through the page (sorted option list, disabled
 * placeholder); this file pins the component's own contract directly.
 */
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RobotSelect } from "./RobotSelect";
import { RAW_RADIO_OPTION_VALUE } from "../lib/radioConnect";

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

describe("RobotSelect", () => {
  it("renders a disabled placeholder option and a hint when there are no options", () => {
    const el = mount(<RobotSelect options={[]} value="" onChange={() => {}} />);
    const select = el.querySelector<HTMLSelectElement>('[data-testid="relay-robot-select"]')!;
    expect(select.disabled).toBe(true);
    expect(select.options).toHaveLength(1);
    expect(select.options[0]!.disabled).toBe(true);
    expect(select.options[0]!.textContent).toContain("No robots known yet");
  });

  it("renders a Choose-a-robot placeholder plus every option when non-empty", () => {
    const el = mount(<RobotSelect options={["gopiv", "vevav"]} value="" onChange={() => {}} />);
    const select = el.querySelector<HTMLSelectElement>('[data-testid="relay-robot-select"]')!;
    expect(select.disabled).toBe(false);
    const values = Array.from(select.options).map((o) => o.value);
    expect(values).toEqual(["", "gopiv", "vevav"]);
    expect(select.options[0]!.textContent).toBe("Choose a robot…");
  });

  // Ticket 017-010 (team-lead bench evidence, 2026-09-13): "the same
  // robot appears twice" -- a repeated name (e.g. an unmerged
  // known-robots.json placeholder sharing a name with its real,
  // currently-linked device) must not be offered twice in this picker.
  it("de-duplicates a repeated name in options", () => {
    const el = mount(<RobotSelect options={["gopiv", "tovez", "tovez", "vevav"]} value="" onChange={() => {}} />);
    const select = el.querySelector<HTMLSelectElement>('[data-testid="relay-robot-select"]')!;
    const values = Array.from(select.options).map((o) => o.value);
    expect(values).toEqual(["", "gopiv", "tovez", "vevav"]);
  });

  it("reflects the given value and calls onChange with the newly picked name", () => {
    const onChange = vi.fn();
    const el = mount(<RobotSelect options={["gopiv", "vevav"]} value="vevav" onChange={onChange} />);
    const select = el.querySelector<HTMLSelectElement>('[data-testid="relay-robot-select"]')!;
    expect(select.value).toBe("vevav");

    act(() => {
      select.value = "gopiv";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledWith("gopiv");
  });

  describe("Channel/group option", () => {
    const raw = { channel: "", group: "" };

    it("is the first option after the placeholder and reveals no inputs until chosen", () => {
      const el = mount(<RobotSelect options={["gopiv"]} value="" onChange={() => {}} rawAddress={raw} onRawAddressChange={() => {}} />);
      const select = el.querySelector<HTMLSelectElement>('[data-testid="relay-robot-select"]')!;
      expect(Array.from(select.options).map((o) => o.textContent)).toEqual(["Choose a robot…", "Channel/group", "gopiv"]);
      expect(select.options[1]!.value).toBe(RAW_RADIO_OPTION_VALUE);
      expect(el.querySelector('[data-testid="relay-raw-address"]')).toBeNull();
    });

    it("is still offered (and the select enabled) with no known robots", () => {
      const el = mount(<RobotSelect options={[]} value="" onChange={() => {}} rawAddress={raw} onRawAddressChange={() => {}} />);
      const select = el.querySelector<HTMLSelectElement>('[data-testid="relay-robot-select"]')!;
      expect(select.disabled).toBe(false);
      expect(Array.from(select.options).map((o) => o.textContent)).toEqual(["Choose a robot…", "Channel/group"]);
    });

    it("shows channel and group inputs with range limits once chosen, and reports edits", () => {
      const onRaw = vi.fn();
      const el = mount(
        <RobotSelect options={[]} value={RAW_RADIO_OPTION_VALUE} onChange={() => {}} rawAddress={raw} onRawAddressChange={onRaw} />,
      );
      const channel = el.querySelector<HTMLInputElement>('[data-testid="relay-raw-channel"]')!;
      const group = el.querySelector<HTMLInputElement>('[data-testid="relay-raw-group"]')!;
      expect(channel.max).toBe("83");
      expect(group.max).toBe("255");
      expect(el.querySelector('[data-testid="relay-raw-invalid"]')).not.toBeNull();
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      act(() => {
        setter.call(channel, "12");
        channel.dispatchEvent(new Event("input", { bubbles: true }));
      });
      expect(onRaw).toHaveBeenCalledWith({ channel: "12", group: "" });
    });

    it("flags out-of-range values and clears the hint when valid", () => {
      const bad = mount(
        <RobotSelect options={[]} value={RAW_RADIO_OPTION_VALUE} onChange={() => {}} rawAddress={{ channel: "84", group: "1" }} onRawAddressChange={() => {}} />,
      );
      expect(bad.querySelector('[data-testid="relay-raw-invalid"]')).not.toBeNull();
      act(() => {
        root!.render(
          <RobotSelect options={[]} value={RAW_RADIO_OPTION_VALUE} onChange={() => {}} rawAddress={{ channel: "83", group: "255" }} onRawAddressChange={() => {}} />,
        );
      });
      expect(bad.querySelector('[data-testid="relay-raw-invalid"]')).toBeNull();
    });
  });
});
