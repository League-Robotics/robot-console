// @vitest-environment jsdom
/**
 * CalibrationTable.test.tsx — the shared calibration table's own
 * rendering coverage (ticket 017-008), collapsing what used to be
 * near-duplicate assertions across `CalibrationPage.test.tsx` and
 * `ConfigurationPage.test.tsx` into one place: both variants' ids/
 * `data-testid`s, the `calibration`-only annotations, and the two
 * pages' differing not-yet-measured/unmeasured-slip copy.
 */
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CalibrationTable } from "./CalibrationTable";
import type { CalibrationState, DerivedCalibration } from "../lib/calibration";

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

function type(el: HTMLDivElement, id: string, value: string): void {
  const input = el.querySelector<HTMLInputElement>(`#${id}`)!;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("CalibrationTable", () => {
  it("calibration variant: ids/testids, the distance-calibration and measured-width notes, and the explanatory unmeasured-slip text", () => {
    const state: CalibrationState = { wheelDiameterMm: 90.68, wheelDiameterSource: "distance-calibration" };
    const derived: DerivedCalibration = { effectiveTrackWidthCm: 8.84, trackWidthCm: 8.84, rotationalSlip: 1 };
    const onPatch = vi.fn();
    const el = mount(<CalibrationTable variant="calibration" state={state} derived={derived} onPatch={onPatch} />);

    expect(el.querySelector('[data-testid="calibration-table"]')).not.toBeNull();
    expect(el.querySelector<HTMLInputElement>("#calibration-wheel-diameter")!.value).toBe("90.68");
    expect(el.textContent).toContain("from distance calibration");
    expect(el.textContent).toContain("wheel centre to wheel centre, if you measured it");
    expect(el.querySelector('[data-testid="calibration-effective-track"]')?.textContent).toBe("8.84 cm");
    expect(el.querySelector('[data-testid="calibration-slip"]')?.textContent).toBe(
      "1 (no measured track width, so the effective width is used directly)",
    );

    type(el, "calibration-wheel-diameter", "91");
    expect(onPatch).toHaveBeenCalledWith({ wheelDiameterMm: 91, wheelDiameterSource: "entered" });
  });

  it("calibration variant: unmeasured effective track and no-run slip read their own not-yet-measured copy", () => {
    const el = mount(<CalibrationTable variant="calibration" state={{}} derived={{}} onPatch={vi.fn()} />);
    expect(el.querySelector('[data-testid="calibration-effective-track"]')?.textContent).toBe(
      "not measured yet — run the rotation calibration",
    );
    expect(el.querySelector('[data-testid="calibration-slip"]')?.textContent).toBe("—");
  });

  it("configuration variant: ids/testids, no distance/measured-width notes, and the plain not-yet-measured/slip copy", () => {
    const state: CalibrationState = { wheelDiameterMm: 90.68, wheelDiameterSource: "distance-calibration" };
    const derived: DerivedCalibration = { effectiveTrackWidthCm: 8.84, trackWidthCm: 8.84, rotationalSlip: 1 };
    const onPatch = vi.fn();
    const el = mount(<CalibrationTable variant="configuration" state={state} derived={derived} onPatch={onPatch} />);

    expect(el.querySelector('[data-testid="configuration-calibration"]')).not.toBeNull();
    expect(el.querySelector<HTMLInputElement>("#configuration-wheel-diameter")!.value).toBe("90.68");
    expect(el.textContent).not.toContain("from distance calibration");
    expect(el.textContent).not.toContain("wheel centre to wheel centre");
    expect(el.querySelector('[data-testid="configuration-effective-track"]')?.textContent).toBe("8.84 cm");
    // Unlike the calibration variant, the configuration table shows the
    // bare slip number even when it was never actually measured.
    expect(el.querySelector('[data-testid="configuration-slip"]')?.textContent).toBe("1");

    type(el, "configuration-track-width", "11.5");
    expect(onPatch).toHaveBeenCalledWith({ measuredTrackWidthCm: 11.5 });
  });

  it("configuration variant: unmeasured effective track reads 'run the rotation calibration' with no 'not measured yet' prefix", () => {
    const el = mount(<CalibrationTable variant="configuration" state={{}} derived={{}} onPatch={vi.fn()} />);
    expect(el.querySelector('[data-testid="configuration-effective-track"]')?.textContent).toBe("run the rotation calibration");
    expect(el.querySelector('[data-testid="configuration-slip"]')?.textContent).toBe("—");
  });
});
