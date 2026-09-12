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
});
