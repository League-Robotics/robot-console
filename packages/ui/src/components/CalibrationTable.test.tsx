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

  describe("ticket 018-013: 'Wheel track' vs 'Measured track width (robot-reported)', and the robot-reported slip", () => {
    it("calibration variant: the ruler-measured input row is now labelled 'Wheel track', freeing 'Measured track width' for the robot-reported row", () => {
      const el = mount(<CalibrationTable variant="calibration" state={{}} derived={{}} onPatch={vi.fn()} />);
      const rowLabels = Array.from(el.querySelectorAll("th")).map((th) => th.textContent);
      expect(rowLabels).toEqual([
        "Wheel diameter",
        "Wheel track",
        "Measured track width",
        "Effective track width",
        "Robot's own track width",
        "Rotational slip",
      ]);
      expect(el.querySelector('label[for="calibration-track-width"]')?.textContent).toBe("Wheel track");
    });

    it("calibration variant: the robot-reported track width shows the value, its source, and the not-yet-measured copy when absent", () => {
      const withValue = mount(
        <CalibrationTable
          variant="calibration"
          state={{ reportedTrackWidthCm: 8.84, reportedWithDiameterMm: 90.28 }}
          derived={{}}
          onPatch={vi.fn()}
        />,
      );
      const cell = withValue.querySelector('[data-testid="calibration-reported-track-width"]');
      expect(cell?.textContent).toContain("8.84 cm");
      expect(cell?.textContent).toContain("robot-reported, from rotation calibration");

      const empty = mount(<CalibrationTable variant="calibration" state={{}} derived={{}} onPatch={vi.fn()} />);
      expect(empty.querySelector('[data-testid="calibration-reported-track-width"]')?.textContent).toBe(
        "not measured yet — run the rotation calibration",
      );
    });

    it("configuration variant: the robot-reported track width row shows the bare value with no source annotation", () => {
      const el = mount(
        <CalibrationTable variant="configuration" state={{ reportedTrackWidthCm: 8.84 }} derived={{}} onPatch={vi.fn()} />,
      );
      expect(el.querySelector('[data-testid="configuration-reported-track-width"]')?.textContent).toBe("8.84 cm");
    });

    it("calibration variant: the firmware's own calturn.result slip shows alongside the computed slip, only when known", () => {
      const withoutFirmwareSlip = mount(
        <CalibrationTable variant="calibration" state={{ measuredTrackWidthCm: 11.5 }} derived={{ rotationalSlip: 1.301 }} onPatch={vi.fn()} />,
      );
      expect(withoutFirmwareSlip.querySelector('[data-testid="calibration-firmware-slip"]')).toBeNull();

      const withFirmwareSlip = mount(
        <CalibrationTable
          variant="calibration"
          state={{ measuredTrackWidthCm: 11.5, firmwareSlip: 1.008 }}
          derived={{ rotationalSlip: 1.301 }}
          onPatch={vi.fn()}
        />,
      );
      const slipCell = withFirmwareSlip.querySelector('[data-testid="calibration-slip"]');
      expect(slipCell?.textContent).toContain("1.301");
      expect(slipCell?.textContent).toContain("firmware computed 1.008");
    });

    it("OOP 2026-09-18: the robot's own boot-record track width (tw) shows with its provenance, and 'not reported yet' when absent", () => {
      const withValue = mount(
        <CalibrationTable variant="calibration" state={{ robotTrackWidthCm: 11.16 }} derived={{}} onPatch={vi.fn()} />,
      );
      const cell = withValue.querySelector('[data-testid="calibration-robot-track-width"]');
      expect(cell?.textContent).toContain("11.16 cm");
      expect(cell?.textContent).toContain("boot record");

      const empty = mount(<CalibrationTable variant="calibration" state={{}} derived={{}} onPatch={vi.fn()} />);
      expect(empty.querySelector('[data-testid="calibration-robot-track-width"]')?.textContent).toContain("not reported yet");
    });
  });
});
