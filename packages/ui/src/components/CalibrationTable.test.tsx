// @vitest-environment jsdom
/**
 * CalibrationTable.test.tsx — the shared calibration table's own
 * rendering coverage.
 *
 * ## The four-row model (stakeholder, 2026-09-19)
 *
 * The table carries exactly four things, two of them enterable:
 *
 *   Wheel diameter        entered, or filled by the wheel calibration
 *   Measured track width  entered -- a caliper across the wheel centres
 *   Effective track width what the spin measured, scaled to the wheel
 *   Rotational slip       measured / effective, or 1
 *
 * What it no longer carries is the reason these tests were rewritten.
 * There used to be a row labelled "Measured track width" holding
 * `calturn`'s raw `b`, directly above a row labelled "Effective track
 * width" holding the same number after a wheel rescale -- one
 * measurement printed twice, the first under a name belonging to a
 * different quantity. Beneath both sat "Rotational slip: 1 (no measured
 * track width...)", contradicting the row three lines above it. There
 * was also a "Robot's own track width" row showing a baked boot record
 * that is not a measurement at all.
 *
 * A spin measures ONE thing. These tests pin that the table says so.
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
  const FULL: CalibrationState = { wheelDiameterMm: 81.37, measuredTrackWidthCm: 12.85 };
  const DERIVED: DerivedCalibration = { effectiveTrackWidthCm: 12.88, trackWidthCm: 12.85, rotationalSlip: 0.998 };

  it("renders exactly the four rows, and none of the retired ones", () => {
    const el = mount(<CalibrationTable variant="calibration" state={FULL} derived={DERIVED} onPatch={vi.fn()} />);
    const headers = [...el.querySelectorAll("th")].map((th) => th.textContent?.trim());
    expect(headers).toEqual([
      "Wheel diameter",
      "Measured track width",
      "Effective track width",
      "Rotational slip",
    ]);
    // The row that showed a baked boot record as though it were a
    // measurement is gone.
    expect(el.textContent).not.toMatch(/Robot's own track width/);
    expect(el.querySelector('[data-testid="calibration-robot-track-width"]')).toBeNull();
    // As is the duplicate of the effective width under a wrong name.
    expect(el.querySelector('[data-testid="calibration-reported-track-width"]')).toBeNull();
  });

  it("Measured track width is the caliper input, not a robot-reported value", () => {
    const onPatch = vi.fn();
    const el = mount(<CalibrationTable variant="calibration" state={{}} derived={{}} onPatch={onPatch} />);
    const input = el.querySelector<HTMLInputElement>("#calibration-track-width")!;
    expect(input.placeholder).toBe("optional");
    expect(el.textContent).toMatch(/wheel centre to wheel centre, measured with a caliper/);
    expect(el.textContent).not.toMatch(/robot-reported/);
    type(el, "calibration-track-width", "12.85");
    expect(onPatch).toHaveBeenCalledWith({ measuredTrackWidthCm: 12.85 });
  });

  it("wheel diameter is enterable and reports its source when the calibration filled it", () => {
    const onPatch = vi.fn();
    const el = mount(
      <CalibrationTable
        variant="calibration"
        state={{ wheelDiameterMm: 81.45, wheelDiameterSource: "distance-calibration" }}
        derived={{}}
        onPatch={onPatch}
      />,
    );
    expect(el.textContent).toMatch(/from distance calibration/);
    type(el, "calibration-wheel-diameter", "81.37");
    expect(onPatch).toHaveBeenCalledWith({ wheelDiameterMm: 81.37, wheelDiameterSource: "entered" });
  });

  it("effective track width says it is the spin, scaled to the wheel above", () => {
    const el = mount(<CalibrationTable variant="calibration" state={FULL} derived={DERIVED} onPatch={vi.fn()} />);
    const cell = el.querySelector('[data-testid="calibration-effective-track"]')!;
    expect(cell.textContent).toMatch(/12\.88 cm/);
    expect(cell.textContent).toMatch(/what the spin measured, scaled to the wheel above/);
  });

  describe("rotational slip -- the three cases, which is the whole point of the row", () => {
    it("no effective width: says so, rather than showing a slip nobody could have computed", () => {
      const el = mount(
        <CalibrationTable variant="calibration" state={{ measuredTrackWidthCm: 12.85 }} derived={{}} onPatch={vi.fn()} />,
      );
      const cell = el.querySelector('[data-testid="calibration-slip"]')!;
      expect(cell.textContent).toMatch(/needs the effective track width, so run the turn calibration/);
      expect(cell.textContent).not.toMatch(/\b1\b/);
    });

    it("effective but no caliper: 1, and says the effective width is being used as the track", () => {
      const el = mount(
        <CalibrationTable
          variant="calibration"
          state={{ wheelDiameterMm: 81.37 }}
          derived={{ effectiveTrackWidthCm: 12.88, trackWidthCm: 12.88, rotationalSlip: 1 }}
          onPatch={vi.fn()}
        />,
      );
      const cell = el.querySelector('[data-testid="calibration-slip"]')!;
      expect(cell.textContent).toMatch(/^1 — no measured track width, so the effective width is used as the track/);
    });

    it("both present: the ratio, and shows the division it came from", () => {
      const el = mount(<CalibrationTable variant="calibration" state={FULL} derived={DERIVED} onPatch={vi.fn()} />);
      const cell = el.querySelector('[data-testid="calibration-slip"]')!;
      expect(cell.textContent).toMatch(/0\.998/);
      expect(cell.textContent).toMatch(/12\.85 ÷ 12\.88/);
    });
  });

  describe("configuration variant: same rows, no prose", () => {
    it("uses its own ids and drops the calibration-only annotations", () => {
      const el = mount(<CalibrationTable variant="configuration" state={FULL} derived={DERIVED} onPatch={vi.fn()} />);
      expect(el.querySelector('[data-testid="configuration-calibration"]')).not.toBeNull();
      expect(el.querySelector("#configuration-wheel-diameter")).not.toBeNull();
      expect(el.querySelector("#configuration-track-width")).not.toBeNull();
      expect(el.textContent).not.toMatch(/measured with a caliper/);
      expect(el.textContent).not.toMatch(/scaled to the wheel above/);
    });

    it("renders a bare 1 for the no-caliper slip, without the explanation", () => {
      const el = mount(
        <CalibrationTable
          variant="configuration"
          state={{}}
          derived={{ effectiveTrackWidthCm: 12.88, trackWidthCm: 12.88, rotationalSlip: 1 }}
          onPatch={vi.fn()}
        />,
      );
      expect(el.querySelector('[data-testid="configuration-slip"]')!.textContent).toBe("1");
    });

    it("says to run the turn calibration when there is no effective width yet", () => {
      const el = mount(<CalibrationTable variant="configuration" state={{}} derived={{}} onPatch={vi.fn()} />);
      const cell = el.querySelector('[data-testid="configuration-effective-track"]')!;
      expect(cell.textContent).toBe("run the turn calibration");
      expect(cell.textContent).not.toMatch(/not measured yet/);
    });
  });
});
