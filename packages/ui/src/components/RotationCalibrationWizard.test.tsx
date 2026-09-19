// @vitest-environment jsdom
/**
 * RotationCalibrationWizard.test.tsx — component tests for the
 * rotation/track-width calibration wizard (rewritten OOP 2026-09-18 for
 * the current `calturn` firmware; see `RotationCalibrationWizard.tsx`'s
 * own doc comment). The old four-stage CW/CCW/re-verify narration is
 * gone along with the prose it was bucketed from -- `calturn` reports
 * JSON lines and ends the run on the first `.result`/`.fail`, with no
 * re-verification pass of its own.
 *
 * Covers: `calturn`-known-missing shows a non-blocking hint but never
 * disables Go, the edges select (10/18/26, default 10), the `RUN
 * calturn <edges>` dispatch on Go, drop-tolerant progress rendering, the
 * terminal `.result` line's Apply button sending `SET rotational_slip`,
 * a `.fail` line's distinct failure state, a malformed `.result`'s
 * distinct "unreadable" state, a `RUN` `err 1` reply's own distinct
 * state, the `calturn.restored` geometry surfaced on both the success
 * and the failure path (and the "couldn't confirm" fallback when it
 * never arrives), and the regression check that no nudge/beam-pointer UI
 * ever appears in this panel.
 */
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { RobotFunction, SnapshotLink } from "@robot-console/host/src/wsMessages.js";
import { RotationCalibrationWizard, deriveTurnCalibrationRun } from "./RotationCalibrationWizard";
import { WsProvider, useWsActions } from "../ws/WsProvider";
import { FakeSocket } from "../testing/FakeSocket";

/** A minimal stand-in for `DeviceConsole`'s own "Clear log" button --
 * mounted alongside the wizard under the same `WsProvider` so a click
 * here exercises the exact `clearLinkLog` action a real "Clear log"
 * press would fire, without pulling in the whole console. */
function ClearLogButton({ linkId }: { linkId: string }) {
  const { clearLinkLog } = useWsActions();
  return (
    <button type="button" data-testid="test-clear-log" onClick={() => clearLinkLog(linkId)}>
      Clear log
    </button>
  );
}

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

const LINK_ID = "usb-ROBOT-A";

function linkWithFunctions(functions: RobotFunction[] | undefined, overrides: Partial<SnapshotLink> = {}): SnapshotLink {
  return {
    id: LINK_ID,
    transport: "usb",
    label: "USB · /dev/cu.usbmodemC",
    state: "connected",
    reason: null,
    since: 0,
    lastSeen: 0,
    nextRetryAt: null,
    capabilities: { open: false, close: true, flash: true, provisionWifi: true },
    session: { seq: 0, pending: 0, lastDone: null, lastDoneReason: null, robotStatus: null, functions: functions ?? null },
    ...overrides,
  };
}

function closedLink(): SnapshotLink {
  return {
    id: LINK_ID,
    transport: "usb",
    label: "USB · /dev/cu.usbmodemC",
    state: "connectable",
    reason: null,
    since: 0,
    lastSeen: 0,
    nextRetryAt: null,
    capabilities: { open: true, close: false, flash: true, provisionWifi: false },
  };
}

function mountWizard(link: SnapshotLink): { el: HTMLDivElement; socket: FakeSocket } {
  let socket: FakeSocket | null = null;
  const el = mount(
    <WsProvider url="ws://test/" socketFactory={() => (socket = new FakeSocket())}>
      <RotationCalibrationWizard link={link} />
    </WsProvider>,
  );
  act(() => {
    socket!.emitOpen();
  });
  return { el, socket: socket! };
}

function mountWizardWithClear(link: SnapshotLink): { el: HTMLDivElement; socket: FakeSocket } {
  let socket: FakeSocket | null = null;
  const el = mount(
    <WsProvider url="ws://test/" socketFactory={() => (socket = new FakeSocket())}>
      <RotationCalibrationWizard link={link} />
      <ClearLogButton linkId={link.id} />
    </WsProvider>,
  );
  act(() => {
    socket!.emitOpen();
  });
  return { el, socket: socket! };
}

function clickGo(el: HTMLDivElement): void {
  act(() => {
    el.querySelector<HTMLButtonElement>('[data-testid="rotation-calibration-go"]')!.click();
  });
}

function emitLine(socket: FakeSocket, line: string): void {
  act(() => {
    socket.emitMessage({ type: "line", linkId: LINK_ID, direction: "rx", line });
  });
}

const RESULT_LINE = '{"ev":"calturn.result","b":11.071,"tw":11.16,"slip":1.008,"anchor_tw":11.42,"slip_at_anchor":1.0315,"slope":0.9229,"gaps":32,"anchor_b":11.996}';
const RESTORED_LINE = '{"ev":"calturn.restored","tw":11.16,"slip":0.969}';
const FAIL_LINE = '{"ev":"calturn.fail","gaps":2,"why":"too few usable gaps; centre the robot on the cross"}';

describe("RotationCalibrationWizard availability", () => {
  it("before any FUNCS reply the Go button is present and enabled", () => {
    const { el } = mountWizard(linkWithFunctions(undefined));
    expect(el.querySelector('[data-testid="rotation-calibration-idle"]')).toBeNull();
    expect(el.querySelector('[data-testid="rotation-calibration-unavailable"]')).toBeNull();
    const go = el.querySelector<HTMLButtonElement>('[data-testid="rotation-calibration-go"]')!;
    expect(go.textContent).toBe("Calibrate turn");
    expect(go.disabled).toBe(false);
  });

  it("a FUNCS reply missing calturn shows a non-blocking hint and leaves Go enabled", () => {
    const { el } = mountWizard(linkWithFunctions([{ name: "calwheels" }, { name: "abort" }]));
    const hint = el.querySelector('[data-testid="rotation-calibration-unavailable"]');
    expect(hint).not.toBeNull();
    expect(hint!.textContent).toContain("didn't include calturn");
    expect(el.querySelector<HTMLButtonElement>('[data-testid="rotation-calibration-go"]')!.disabled).toBe(false);
    expect(el.querySelector('[role="progressbar"]')).toBeNull();
  });

  it("shows the edges select defaulting to 10, and the setup instructions, enabling Go once calturn is present", () => {
    const { el } = mountWizard(linkWithFunctions([{ name: "calwheels" }, { name: "calturn" }]));
    expect(el.querySelector<HTMLSelectElement>('[data-testid="rotation-calibration-edges"]')!.value).toBe("10");
    expect(el.querySelector('[data-testid="rotation-calibration-setup"]')).not.toBeNull();
    expect(el.querySelector<HTMLButtonElement>('[data-testid="rotation-calibration-go"]')!.disabled).toBe(false);
  });

  it("disables Go when there is no open session even with calturn available", () => {
    const { el } = mountWizard(closedLink());
    expect(el.querySelector<HTMLButtonElement>('[data-testid="rotation-calibration-go"]')!.disabled).toBe(true);
  });
});

describe("RotationCalibrationWizard run dispatch", () => {
  it("sends RUN calturn with the default 10 edges when Go is pressed", () => {
    const { el, socket } = mountWizard(linkWithFunctions([{ name: "calturn" }]));
    socket.sent.length = 0;
    clickGo(el);
    expect(socket.sent).toEqual([JSON.stringify({ type: "send-command", linkId: LINK_ID, verb: "RUN", fields: ["calturn", "10"] })]);
  });

  it("sends the selected edges value when a different option is chosen", () => {
    const { el, socket } = mountWizard(linkWithFunctions([{ name: "calturn" }]));
    const select = el.querySelector<HTMLSelectElement>('[data-testid="rotation-calibration-edges"]')!;
    act(() => {
      select.value = "26";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    socket.sent.length = 0;
    clickGo(el);
    expect(socket.sent).toEqual([JSON.stringify({ type: "send-command", linkId: LINK_ID, verb: "RUN", fields: ["calturn", "26"] })]);
  });

  it("hides the setup instructions and disables Go once a run is in flight", () => {
    const { el } = mountWizard(linkWithFunctions([{ name: "calturn" }]));
    clickGo(el);
    expect(el.querySelector('[data-testid="rotation-calibration-setup"]')).toBeNull();
    expect(el.querySelector<HTMLButtonElement>('[data-testid="rotation-calibration-go"]')!.disabled).toBe(true);
  });
});

describe("RotationCalibrationWizard progress rendering and drop tolerance", () => {
  it("renders non-terminal JSON events as they stream in", () => {
    const { el, socket } = mountWizard(linkWithFunctions([{ name: "calturn" }]));
    clickGo(el);
    emitLine(socket, '{"ev":"calturn.ch","i":0,"n":10,"gap":41.553,"sd":2.755,"slope":0.9234}');
    const progress = el.querySelector('[data-testid="rotation-calibration-progress"]')!;
    expect(progress.textContent).toContain("calturn.ch");
  });

  it("tolerates interleaved noise (acks, unrelated debug lines, a different verb's own lines) without disturbing progress", () => {
    const { el, socket } = mountWizard(linkWithFunctions([{ name: "calturn" }]));
    clickGo(el);
    emitLine(socket, "ack 5 0 none");
    emitLine(socket, "DBG: loop=12");
    emitLine(socket, '{"ev":"calwheels.span","start":1,"finish":2}');
    emitLine(socket, '{"ev":"calturn.quality","sd":3.706,"spread":0.051,"ch":4}');
    const progress = el.querySelector('[data-testid="rotation-calibration-progress"]')!;
    expect(progress.textContent).toContain("calturn.quality");
    expect(el.querySelector('[data-testid="rotation-calibration-run-error"]')).toBeNull();
    expect(el.querySelector('[data-testid="rotation-calibration-failed"]')).toBeNull();
  });

  it("reaches .result even when .quality/.ch never arrived (dropped over Wi-Fi) -- never requires an expected line", () => {
    const { el, socket } = mountWizard(linkWithFunctions([{ name: "calturn" }]));
    clickGo(el);
    emitLine(socket, RESULT_LINE);
    expect(el.querySelector('[data-testid="rotation-calibration-result"]')).not.toBeNull();
  });
});

describe("RotationCalibrationWizard terminal states", () => {
  it("renders the measured width and firmware slip from calturn.result, and Apply sends SET rotational_slip", () => {
    const { el, socket } = mountWizard(linkWithFunctions([{ name: "calturn" }]));
    clickGo(el);
    emitLine(socket, '{"ev":"calturn.ch","i":0,"n":10}');
    emitLine(socket, RESULT_LINE);

    expect(el.querySelector('[data-testid="rotation-calibration-track"]')!.textContent).toContain("11.071 cm");
    expect(el.querySelector('[data-testid="rotation-calibration-slip"]')!.textContent).toContain("1.008");
    // The trap: slip_at_anchor (1.0315) must never be shown as the slip.
    expect(el.querySelector('[data-testid="rotation-calibration-slip"]')!.textContent).not.toContain("1.0315");
    expect(el.querySelector('[data-testid="rotation-calibration-failed"]')).toBeNull();
    expect(el.querySelector('[data-testid="rotation-calibration-run-error"]')).toBeNull();
    expect(el.querySelector<HTMLButtonElement>('[data-testid="rotation-calibration-go"]')!.disabled).toBe(false);

    socket.sent.length = 0;
    act(() => {
      el.querySelector<HTMLButtonElement>('[data-testid="rotation-calibration-apply"]')!.click();
    });
    expect(socket.sent).toEqual([
      JSON.stringify({ type: "send-command", linkId: LINK_ID, verb: "SET", fields: ["rotational_slip", "1.008"] }),
    ]);
    expect(el.querySelector('[data-testid="rotation-calibration-applied"]')?.textContent).toContain("1.008");
  });

  it("surfaces the robot's restored geometry after a successful run", () => {
    const { el, socket } = mountWizard(linkWithFunctions([{ name: "calturn" }]));
    clickGo(el);
    emitLine(socket, RESULT_LINE);
    emitLine(socket, RESTORED_LINE);
    const restored = el.querySelector('[data-testid="rotation-calibration-restored"]')!;
    expect(restored.textContent).toContain("11.16 cm");
    expect(restored.textContent).toContain("0.969");
    expect(el.querySelector('[data-testid="rotation-calibration-restored-unknown"]')).toBeNull();
  });

  it("says it couldn't confirm the robot's geometry when calturn.restored never arrives, rather than assuming", () => {
    const { el, socket } = mountWizard(linkWithFunctions([{ name: "calturn" }]));
    clickGo(el);
    emitLine(socket, RESULT_LINE);
    expect(el.querySelector('[data-testid="rotation-calibration-restored-unknown"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="rotation-calibration-restored"]')).toBeNull();
  });

  it("renders a distinct failure state on a calturn.fail line, never a result or Apply button, and still surfaces the restore", () => {
    const { el, socket } = mountWizard(linkWithFunctions([{ name: "calturn" }]));
    clickGo(el);
    emitLine(socket, FAIL_LINE);
    emitLine(socket, RESTORED_LINE);

    const failed = el.querySelector('[data-testid="rotation-calibration-failed"]')!;
    expect(failed).not.toBeNull();
    expect(failed.textContent).toContain("too few usable gaps");
    expect(el.querySelector('[data-testid="rotation-calibration-result"]')).toBeNull();
    expect(el.querySelector('[data-testid="rotation-calibration-apply"]')).toBeNull();
    expect(el.querySelector('[data-testid="rotation-calibration-restored"]')?.textContent).toContain("11.16 cm");
  });

  describe("profile calibration-0.20260919.4: the failure-path restore is now asserted from calturn.restored's own stored field, not from documentation", () => {
    const RESTORED_STORED_0 = '{"ev":"calturn.restored","tw":11.42,"slip":1.0,"stored":0}';
    const RESTORED_STORED_1 = '{"ev":"calturn.restored","tw":11.16,"slip":1.008,"stored":1}';

    it("on failure, stored:0 lets the text claim the restore is confirmed by the robot, not merely documented", () => {
      const { el, socket } = mountWizard(linkWithFunctions([{ name: "calturn" }]));
      clickGo(el);
      emitLine(socket, FAIL_LINE);
      emitLine(socket, RESTORED_STORED_0);
      const restored = el.querySelector('[data-testid="rotation-calibration-restored"]')!;
      expect(restored.textContent).toContain("confirmed by the robot");
      expect(restored.textContent).toContain("11.42 cm");
      // The old, unconditional documentation-sourced claim is gone.
      expect(restored.textContent).not.toContain("calturn restores this after every run");
    });

    it("on failure with no stored field at all (older firmware), states the numbers without claiming a confirmed restore", () => {
      const { el, socket } = mountWizard(linkWithFunctions([{ name: "calturn" }]));
      clickGo(el);
      emitLine(socket, FAIL_LINE);
      emitLine(socket, RESTORED_LINE);
      const restored = el.querySelector('[data-testid="rotation-calibration-restored"]')!;
      expect(restored.textContent).toContain("11.16 cm");
      expect(restored.textContent).not.toContain("confirmed");
      expect(restored.textContent).not.toContain("calturn restores this after every run");
    });

    it("on success, stored:1 notes the geometry survives a power cycle", () => {
      const { el, socket } = mountWizard(linkWithFunctions([{ name: "calturn" }]));
      clickGo(el);
      emitLine(socket, RESULT_LINE);
      emitLine(socket, RESTORED_STORED_1);
      const restored = el.querySelector('[data-testid="rotation-calibration-restored"]')!;
      expect(restored.textContent).toContain("survives a power cycle");
    });
  });

  it("a bare fail with no why text still fails cleanly with a generic reason", () => {
    const { el, socket } = mountWizard(linkWithFunctions([{ name: "calturn" }]));
    clickGo(el);
    emitLine(socket, '{"ev":"calturn.fail"}');
    expect(el.querySelector('[data-testid="rotation-calibration-failed"]')?.textContent).toContain("no reason given");
  });

  it("renders a distinct 'unreadable' state -- never a confident wrong number -- when .result's required fields don't validate", () => {
    const { el, socket } = mountWizard(linkWithFunctions([{ name: "calturn" }]));
    clickGo(el);
    emitLine(socket, '{"ev":"calturn.result","b":11.071,"tw":"not a number","slip":1.008}');
    expect(el.querySelector('[data-testid="rotation-calibration-unreadable"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="rotation-calibration-result"]')).toBeNull();
    expect(el.querySelector('[data-testid="rotation-calibration-failed"]')).toBeNull();
  });

  it("renders a distinct 'run rejected' state on a RUN err 1 reply, never confused with .fail or unavailable", () => {
    const { el, socket } = mountWizard(linkWithFunctions([{ name: "calturn" }]));
    clickGo(el);
    emitLine(socket, "err 1 #1");

    const runError = el.querySelector('[data-testid="rotation-calibration-run-error"]')!;
    expect(runError).not.toBeNull();
    expect(el.querySelector('[data-testid="rotation-calibration-failed"]')).toBeNull();
    expect(el.querySelector('[data-testid="rotation-calibration-unavailable"]')).toBeNull();
    expect(el.querySelector('[data-testid="rotation-calibration-result"]')).toBeNull();
  });

  it("starts a fresh run on a second Go press, with no stale result, Apply confirmation, or restore info from the first run", () => {
    const { el, socket } = mountWizard(linkWithFunctions([{ name: "calturn" }]));
    clickGo(el);
    emitLine(socket, RESULT_LINE);
    act(() => {
      el.querySelector<HTMLButtonElement>('[data-testid="rotation-calibration-apply"]')!.click();
    });
    expect(el.querySelector('[data-testid="rotation-calibration-applied"]')).not.toBeNull();

    socket.sent.length = 0;
    clickGo(el);
    expect(socket.sent).toEqual([JSON.stringify({ type: "send-command", linkId: LINK_ID, verb: "RUN", fields: ["calturn", "10"] })]);
    expect(el.querySelector('[data-testid="rotation-calibration-result"]')).toBeNull();
    expect(el.querySelector('[data-testid="rotation-calibration-applied"]')).toBeNull();
    expect(el.querySelector<HTMLButtonElement>('[data-testid="rotation-calibration-go"]')!.disabled).toBe(true);
  });

  it("tolerates the link's log being cleared mid-run without throwing or showing stale progress", () => {
    const { el, socket } = mountWizardWithClear(linkWithFunctions([{ name: "calturn" }]));
    clickGo(el);
    emitLine(socket, '{"ev":"calturn.ch","i":0,"n":10}');
    expect(el.querySelector('[data-testid="rotation-calibration-progress"]')).not.toBeNull();

    expect(() => {
      act(() => {
        el.querySelector<HTMLButtonElement>('[data-testid="test-clear-log"]')!.click();
      });
    }).not.toThrow();

    expect(el.querySelector('[data-testid="rotation-calibration-result"]')).toBeNull();
    expect(el.querySelector('[data-testid="rotation-calibration-failed"]')).toBeNull();
    expect(el.querySelector('[data-testid="rotation-calibration-run-error"]')).toBeNull();
  });
});

describe("RotationCalibrationWizard as CalibrationPage drives it", () => {
  it("is blocked, with the reason shown and Go disabled, until the page says a wheel diameter is known", () => {
    let socket: FakeSocket | null = null;
    const el = mount(
      <WsProvider url="ws://test/" socketFactory={() => (socket = new FakeSocket())}>
        <RotationCalibrationWizard link={linkWithFunctions([{ name: "calturn" }])} disabled disabledReason="Run the wheel calibration first." />
      </WsProvider>,
    );
    act(() => {
      socket!.emitOpen();
    });
    expect(el.querySelector('[data-testid="rotation-calibration-blocked"]')?.textContent).toBe("Run the wheel calibration first.");
    expect(el.querySelector<HTMLButtonElement>('[data-testid="rotation-calibration-go"]')!.disabled).toBe(true);
    expect(el.querySelector('[data-testid="rotation-calibration-setup"]')).toBeNull();
  });

  it("reports the run to onRun", () => {
    const runs: string[] = [];
    let socket: FakeSocket | null = null;
    const el = mount(
      <WsProvider url="ws://test/" socketFactory={() => (socket = new FakeSocket())}>
        <RotationCalibrationWizard link={linkWithFunctions([{ name: "calturn" }])} onRun={(run) => runs.push(run ? run.kind : "none")} />
      </WsProvider>,
    );
    act(() => {
      socket!.emitOpen();
    });
    clickGo(el);
    emitLine(socket!, RESULT_LINE);
    expect(runs.at(-1)).toBe("succeeded");
  });
});

describe("RotationCalibrationWizard regression: no nudge/beam-pointer UI", () => {
  it("never renders a nudge control or beam-pointer affordance in any state", () => {
    const { el, socket } = mountWizard(linkWithFunctions([{ name: "calturn" }]));
    expect(el.textContent).not.toMatch(/nudge/i);
    expect(el.textContent).not.toMatch(/beam/i);

    clickGo(el);
    emitLine(socket, '{"ev":"calturn.ch","i":0,"n":10}');
    expect(el.textContent).not.toMatch(/nudge/i);
    expect(el.textContent).not.toMatch(/beam/i);

    emitLine(socket, RESULT_LINE);
    expect(el.textContent).not.toMatch(/nudge/i);
    expect(el.textContent).not.toMatch(/beam/i);
  });
});

describe("deriveTurnCalibrationRun (pure derivation)", () => {
  it("tolerates an empty slice without throwing, falling back to an empty running state", () => {
    expect(deriveTurnCalibrationRun([])).toEqual({ kind: "running", events: [], restored: undefined });
  });

  it("keeps listening for calturn.restored after the run is already terminal (the real wire emits it after .result/.fail)", () => {
    const run = deriveTurnCalibrationRun([
      { direction: "rx", line: RESULT_LINE },
      { direction: "rx", line: RESTORED_LINE },
    ]);
    expect(run).toMatchObject({ kind: "succeeded", restored: { trackWidthCm: 11.16, slip: 0.969 } });
  });

  it("ignores a different verb's own result/fail lines entirely", () => {
    const run = deriveTurnCalibrationRun([
      { direction: "rx", line: '{"ev":"calwheels.result","calib":1,"diameter":1,"measured":1,"true":1,"error":0,"was":1}' },
      { direction: "rx", line: '{"ev":"calwheels.fail","why":"nope"}' },
    ]);
    expect(run).toEqual({ kind: "running", events: [], restored: undefined });
  });

  it("does not re-open a terminal run on a stray duplicate .result/.fail, but still adopts a later valid .restored", () => {
    const run = deriveTurnCalibrationRun([
      { direction: "rx", line: FAIL_LINE },
      { direction: "rx", line: RESULT_LINE },
      { direction: "rx", line: RESTORED_LINE },
    ]);
    expect(run.kind).toBe("failed");
    expect(run).toMatchObject({ restored: { trackWidthCm: 11.16, slip: 0.969 } });
  });
});
