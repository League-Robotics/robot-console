// @vitest-environment jsdom
/**
 * RobotPage.test.tsx — integration-level rendering tests for the robot
 * page (ticket 012-005 / SUC-001, SUC-003, SUC-004, SUC-006, SUC-007;
 * migrated to the `Snapshot` contract, sprint 015 ticket 009).
 *
 * This ticket replaced the sprint 006 single-column shell (three
 * separate response areas reading the same rx log, one of them -- the
 * retired Get/Set panel -- with a real `-1`-watermark bug) with a
 * two-column Main tab: left column `DriveControls` + `SequencingIndicator`
 * + a stubbed charts placeholder; right column exactly one
 * `DeviceConsole` with `CommandStrip` beneath it. STOP/E-STOP
 * (out-of-process, 2026-09-10) no longer have a separate sticky
 * `EstopControl` sibling -- they render inside `DriveControls`'s own pad
 * in the left column; see `DriveControls.test.tsx` for their behavior.
 *
 * **Sprint 022 ticket 007: the right column (and its console) is gone.**
 * `ConsoleDock` (mounted once per device page by `DevicePage.tsx`,
 * tickets 002-006) is the one place a student watches a robot's log now,
 * so this page's own `ConsolePane`/`CommandStrip` mount -- kept
 * alongside the dock for four tickets on purpose, per sprint.md's
 * Migration Concerns, so the dock could be proven live before its
 * predecessor was deleted -- is gone. The Main tab is single-column;
 * every test below that used to assert a console/`CommandStrip`
 * *present* in the right column now asserts one is *absent* everywhere
 * on this page instead -- coverage moved to `ConsoleDock.test.tsx`
 * (mounting/toggling/notice-indicator behavior) and `CommandStrip.test.tsx`
 * (HELLO/ID/VER/STATUS/GET/SET dispatch), neither of which needs
 * `RobotPage` at all to exercise `CommandStrip`'s own behavior.
 *
 * Focused per-component behavior lives in each component's own test
 * file (`DriveControls.test.tsx`, `SequencingIndicator.test.tsx`,
 * `CommandStrip.test.tsx`); this file proves the page assembles what it
 * still owns correctly, that the layout's structural constraints hold
 * (no console/`CommandStrip` mount of its own anywhere on the page,
 * `EstopControl` not nested inside either column's scroll container),
 * and that a host `notice` routed by ticket 012-003 (now `type:
 * "notice"`, ticket 004) is no longer this page's concern to surface
 * (there is no console here to surface it in -- see
 * `ConsoleDock.test.tsx`'s own notice-indicator suite instead).
 * `RobotPage.transportBlind.test.ts` separately enforces the
 * transport-blindness property with a source scan.
 */
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Snapshot, SnapshotDevice, SnapshotLink } from "@robot-console/host/src/wsMessages.js";
import { RobotPage } from "./RobotPage";
import { AppHeader } from "../components/AppHeader";
import { WsProvider } from "../ws/WsProvider";
import { FakeSocket } from "../testing/FakeSocket";
import { withRouter } from "../testing/renderWithRouter";
import robotPageCssSource from "./RobotPage.css?raw";

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

function robotLink(overrides: Partial<SnapshotLink> = {}): SnapshotLink {
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
    session: { seq: 0, pending: 0, lastDone: null, lastDoneReason: null, robotStatus: null, functions: null },
    ...overrides,
  };
}

function robotDevice(overrides: Partial<Omit<SnapshotDevice, "links">> = {}): SnapshotDevice {
  return {
    id: 1,
    name: "vevav",
    kind: "robot",
    role: "NEZHA2",
    commonName: null,
    program: null,
    version: null,
    owned: true,
    radio: { channel: 1, group: 1, source: "derived" },
    lastSeen: 0,
    lastChecked: null,
    links: [robotLink()],
    ...overrides,
  };
}

function snapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    type: "snapshot",
    seq: 1,
    at: 0,
    devices: [],
    unassigned: [],
    relays: [],
    firmware: { relay: { configured: false }, robot: { configured: false } },
    wifi: { ssid: null, source: null },
    tasks: [],
    ...overrides,
  };
}

function mountRobotPage(
  device: SnapshotDevice = robotDevice(),
  onActiveTargetChange: (target: { link: SnapshotLink; name: string }) => void = () => {},
): { el: HTMLDivElement; socket: FakeSocket } {
  let socket: FakeSocket | null = null;
  const el = mount(
    <WsProvider url="ws://test/" socketFactory={() => (socket = new FakeSocket())}>
      <RobotPage device={device} link={device.links[0]!} onActiveTargetChange={onActiveTargetChange} />
    </WsProvider>,
  );
  act(() => {
    socket!.emitOpen();
  });
  return { el, socket: socket! };
}

describe("RobotPage", () => {
  it("renders a header with the device's name", () => {
    const { el } = mountRobotPage(robotDevice());
    expect(el.textContent).toContain("vevav");
  });

  it("OOP 2026-09-10: the Main tab shows status and drive in a single column", () => {
    const { el } = mountRobotPage();
    const left = el.querySelector(".robot-page-column-left");
    expect(left).not.toBeNull();
    expect(left!.querySelector('[aria-label="Robot status"]')).not.toBeNull();
    expect(left!.querySelector('[aria-label="Drive controls"]')).not.toBeNull();
    expect(Array.from(left!.querySelectorAll("h3")).map((h) => h.textContent)).toEqual(["Status", "Drive"]);
    // Nothing from the other tabs is mounted.
    expect(el.querySelector('[aria-label="Functions"]')).toBeNull();
    expect(el.querySelector('[aria-label="Charts"]')).toBeNull();
    expect(el.querySelector('[aria-label="Distance calibration"]')).toBeNull();
    expect(el.textContent).not.toContain("Showing up to");
    expect(el.textContent).not.toContain("Hold a direction");
  });

  it("sprint 022 ticket 007: the Main tab has no right column any more -- the console/CommandStrip it used to hold moved to ConsoleDock, which this page doesn't mount", () => {
    const { el } = mountRobotPage();
    expect(el.querySelector(".robot-page-column-right")).toBeNull();
    expect(el.querySelector('[aria-label="Console"]')).toBeNull();
    expect(el.querySelector('[aria-label="Command strip"]')).toBeNull();
    expect(el.querySelector('[data-testid="console-log"]')).toBeNull();
  });

  it("ticket 018-013: tabs sit beside the name; every robot (including a plain, non-calibration one) gets Main, Drive, Calibration, Configuration and Diagnostics", () => {
    const { el } = mountRobotPage();
    const row = el.querySelector(".robot-page-title-row")!;
    expect(row.querySelector("h2")?.textContent).toBe("vevav");
    expect(Array.from(row.querySelectorAll('[role="tab"]')).map((t) => t.textContent)).toEqual([
      "Main",
      "Drive",
      "Calibration",
      "Configuration",
      "Diagnostics",
    ]);
    expect(el.querySelector('[data-testid="robot-tab-main"]')?.getAttribute("aria-selected")).toBe("true");
  });

  it("OOP 2026-09-14: the Drive tab (Functions & charts folded in) has the pad, keyboard/gamepad aids and Functions on the left, and a viewport-bound Charts/path-trace column on the right", () => {
    const { el } = mountRobotPage();
    act(() => {
      el.querySelector<HTMLButtonElement>('[data-testid="robot-tab-drive"]')!.click();
    });
    expect(el.querySelector('[data-testid="robot-tab-panel-main"]')).toBeNull();
    const left = el.querySelector(".robot-page-column-left")!;
    const right = el.querySelector(".robot-page-column-right")!;
    expect(left.querySelector('[aria-label="Drive controls"]')).not.toBeNull();
    expect(left.querySelector('[data-testid="drive-tab-keyboard"]')).not.toBeNull();
    expect(left.querySelector('[aria-label="Functions"]')).not.toBeNull();
    expect(right.classList.contains("robot-page-column-console")).toBe(true);
    expect(right.querySelector('[aria-label="Charts"]')).not.toBeNull();
    expect(right.querySelector('[aria-label="Path trace"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="robot-tab-drive"]')?.getAttribute("aria-selected")).toBe("true");
  });

  it("sprint 022 ticket 007: the Drive tab's left column no longer carries the viewport-bound console class, and no console/CommandStrip renders anywhere on the page", () => {
    const { el } = mountRobotPage();
    act(() => {
      el.querySelector<HTMLButtonElement>('[data-testid="robot-tab-drive"]')!.click();
    });
    const left = el.querySelector(".robot-page-column-left")!;
    expect(left.classList.contains("robot-page-column-console")).toBe(false);
    expect(el.querySelector('[aria-label="Console"]')).toBeNull();
    expect(el.querySelector('[aria-label="Command strip"]')).toBeNull();
  });

  it("the Calibration tab (offered for any robot) shows the flow on the left, the values right -- no console on either side (sprint 022 ticket 007)", () => {
    const { el } = mountRobotPage(robotDevice({ program: "calibration-1", version: "1" }));
    expect(Array.from(el.querySelectorAll('[role="tab"]')).map((t) => t.textContent)).toEqual(["Main", "Drive", "Calibration", "Configuration", "Diagnostics"]);
    act(() => {
      el.querySelector<HTMLButtonElement>('[data-testid="robot-tab-calibration"]')!.click();
    });
    // Stakeholder, 2026-09-19: the firmware panel and the guided run sit
    // on the left, over what used to be the console it feeds -- and the
    // values and the code you paste are on the right. The two standalone
    // wizard panels are gone, replaced by the flow. Ticket 007 deleted
    // the console itself (superseded by ConsoleDock): neither column
    // renders one any more.
    expect(el.querySelector('.robot-page-column-left [aria-label="New calibration"]')).not.toBeNull();
    expect(el.querySelector('.robot-page-column-right [aria-label="Current calibration"]')).not.toBeNull();
    expect(el.querySelector('.robot-page-column-right [aria-label="Calibration code"]')).not.toBeNull();
    expect(el.querySelector('[aria-label="Console"]')).toBeNull();
    expect(el.querySelector('[aria-label="Distance calibration"]')).toBeNull();
    expect(el.querySelector('[aria-label="Rotation calibration"]')).toBeNull();
  });

  it("stakeholder correction 2026-09-13: a plain, non-calibration robot's Calibration tab shows the Calibration firmware block (flash button, program/version text)", () => {
    const { el } = mountRobotPage(robotDevice({ program: null, version: null }));
    act(() => {
      el.querySelector<HTMLButtonElement>('[data-testid="robot-tab-calibration"]')!.click();
    });
    expect(el.querySelector('[data-testid="robot-tab-panel-calibration"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="calibration-firmware-not-running"]')?.textContent).toBe("Program: unknown");
    const flashButton = Array.from(el.querySelectorAll("button")).find((b) => b.textContent === "Flash calibration firmware");
    expect(flashButton).not.toBeUndefined();
  });

  it("stakeholder correction 2026-09-13: the Configuration tab no longer shows the Calibration firmware block", () => {
    const { el } = mountRobotPage(robotDevice({ program: null, version: null }));
    act(() => {
      el.querySelector<HTMLButtonElement>('[data-testid="robot-tab-configuration"]')!.click();
    });
    expect(el.querySelector('[data-testid="robot-tab-panel-configuration"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="calibration-firmware-not-running"]')).toBeNull();
    expect(Array.from(el.querySelectorAll("button")).find((b) => b.textContent === "Flash calibration firmware")).toBeUndefined();
  });

  it("renders STOP/E-STOP inside DriveControls' pad in the left column, not as a page-level sibling (out-of-process, 2026-09-10)", () => {
    const { el } = mountRobotPage();
    const stop = el.querySelector('[data-testid="stop-button"]');
    const estop = el.querySelector('[aria-label="Emergency stop"]');
    expect(stop).not.toBeNull();
    expect(estop).not.toBeNull();

    const left = el.querySelector(".robot-page-column-left");
    const driveControls = left!.querySelector('[aria-label="Drive controls"]');
    expect(driveControls).not.toBeNull();
    expect(driveControls!.contains(stop)).toBe(true);
    expect(driveControls!.contains(estop)).toBe(true);

    // No separate top-level e-stop control sitting outside the left
    // column either -- sprint 022 ticket 007 removed the Main tab's
    // right column outright (`.robot-page`'s only children are the
    // heading and the single left column), so there is no longer a
    // second column to check for a stray copy at all.
    expect(el.querySelector(".robot-page-column-right")).toBeNull();
  });

  it("removes the old single-column max-width from RobotPage.css", () => {
    expect(robotPageCssSource).not.toMatch(/max-width:\s*46rem/);
  });

  it("renders no rx log echo anywhere on the page for a populated rx log with nothing sent (retired Get/Set panel bug regression; sprint 022 ticket 007 update)", () => {
    // Originally: the retired Get/Set panel's bug (a `-1` watermark
    // matching the entire rx history) echoed every rx line a second
    // time in its own reply area, alongside `ConsolePane`'s single
    // legitimate copy -- this test pinned "exactly one copy of each
    // line, in the console." Sprint 022 ticket 007 deletes that
    // page-level console entirely (superseded by `ConsoleDock`, which
    // this test does not mount), so the correct count on THIS page is
    // now zero, not one -- `ConsoleDock.test.tsx` covers the log
    // actually rendering exactly once wherever it does mount.
    const { el, socket } = mountRobotPage();

    act(() => {
      socket.emitMessage({ type: "line", linkId: LINK_ID, direction: "rx", line: "status a=1" });
      socket.emitMessage({ type: "line", linkId: LINK_ID, direction: "rx", line: "get name value" });
      socket.emitMessage({ type: "line", linkId: LINK_ID, direction: "rx", line: "ack 1 0 none" });
    });

    expect(el.querySelectorAll('[data-testid="console-line-rx"]').length).toBe(0);
    expect(el.querySelectorAll('[data-testid="get-set-replies"]').length).toBe(0);
    expect(el.querySelector(".get-set-panel")).toBeNull();
    expect(el.querySelector(".status-panel")).toBeNull();
  });

  it("ticket 022-001 (regression fix): does not request get-wifi-credentials for a session that never opens Calibration or Configuration", () => {
    // See RobotPage.tsx's own "Regression fix, same day" doc comment:
    // the first cut of this effect fired unconditionally as soon as the
    // session opened, regardless of `tab` -- which broke `App.test.tsx`'s
    // disconnected-banner suite (a Main-tab-only session that asserts
    // nothing at all has been sent). This pins the corrected contract:
    // Main/Drive/Diagnostics-only sessions never send this.
    const { socket } = mountRobotPage();
    act(() => {
      socket.emitMessage({ type: "line", linkId: LINK_ID, direction: "rx", line: "status a=1" });
    });
    expect(socket.sent.filter((raw) => raw.includes('"get-wifi-credentials"'))).toHaveLength(0);
  });

  it("ticket 022-001: requests get-wifi-credentials once the Calibration tab is opened, so it sees WiFi without ever opening Configuration first", () => {
    const { el, socket } = mountRobotPage();
    const sent = () => socket.sent.map((raw) => JSON.parse(raw));
    // Nothing sent yet -- Main is the default tab and Calibration has
    // not been opened.
    expect(sent()).not.toContainEqual({ type: "get-wifi-credentials", reveal: true });

    // Calibration tab opened directly -- Configuration was never
    // visited this session -- and it still ends up showing the real
    // password, because the request now fires from this page, latched
    // on to `tab` becoming "calibration", not from ConfigurationPage.tsx.
    act(() => {
      el.querySelector<HTMLButtonElement>('[data-testid="robot-tab-calibration"]')!.click();
    });
    expect(sent()).toContainEqual({ type: "get-wifi-credentials", reveal: true });
    expect(socket.sent.filter((raw) => raw.includes('"get-wifi-credentials"'))).toHaveLength(1);

    act(() => {
      socket.emitMessage({ type: "wifi-credentials", ssid: "Busboom_Garage", hasPassword: true, source: "stored", password: "hunter2" });
    });
    const code = el.querySelector('[data-testid="calibration-code"]')?.textContent ?? "";
    expect(code).toContain('diffDrive.setupWifi("Busboom_Garage", "hunter2")');

    // Switching back to Main and re-opening Calibration must not
    // re-send -- the latch is sticky for the life of this mount.
    act(() => {
      el.querySelector<HTMLButtonElement>('[data-testid="robot-tab-main"]')!.click();
    });
    act(() => {
      el.querySelector<HTMLButtonElement>('[data-testid="robot-tab-calibration"]')!.click();
    });
    expect(socket.sent.filter((raw) => raw.includes('"get-wifi-credentials"'))).toHaveLength(1);
  });

  it("sprint 022 ticket 007: no command-strip-* controls render on this page any more -- CommandStrip's HELLO/ID/VER/STATUS dispatch is CommandStrip.test.tsx's own coverage now", () => {
    // Originally: "command strip's HELLO/ID/VER/STATUS buttons send
    // their bare verb via sendCommand," clicking `command-strip-hello`/
    // `-id`/`-ver`/`-status` on this page and asserting the exact
    // `sendCommand` payload. `CommandStrip` is deleted from this page
    // (its one remaining mount site is `ConsoleDock`), so that behavior
    // is no longer this page's to prove -- `CommandStrip.test.tsx`
    // already covers HELLO/ID/VER/STATUS/GET/SET dispatch directly
    // against the component, with no `RobotPage` needed to exercise it.
    const { el } = mountRobotPage();
    for (const testId of ["command-strip-hello", "command-strip-id", "command-strip-ver", "command-strip-status"]) {
      expect(el.querySelector(`[data-testid="${testId}"]`)).toBeNull();
    }
  });

  it("sprint 022 ticket 007: a HELLO-refusal notice has nowhere to surface on this page any more -- there is no console here to show it in", () => {
    // Originally: "shows the host's notice text in the single console
    // when a HELLO resync gets no reply" -- clicked `command-strip-hello`
    // (this page's own `CommandStrip` mount) and asserted the resulting
    // `notice` message rendered in this page's own console log. Both the
    // button and the console are gone from this page; `ConsoleDock`'s
    // notice-indicator suite (`ConsoleDock.test.tsx`, "sprint 022 ticket
    // 003, sprint.md Design Rationale") covers a notice actually
    // surfacing wherever the console does mount now.
    const { el, socket } = mountRobotPage();

    const refusal =
      '"HELLO" cannot be sent as a live command -- it resets the robot\'s sequence state ' +
      "(protocol.md S8.3); close and reopen the session instead of resending HELLO";
    act(() => {
      socket.emitMessage({ type: "notice", level: "error", linkId: LINK_ID, text: refusal, at: 0, seq: 1 });
    });

    expect(el.querySelector('[data-testid="console-log"]')).toBeNull();
    expect(el.textContent).not.toContain(refusal);
  });
});

describe("RobotPage program/version diagnostics (sprint 011 ticket 002)", () => {
  it("renders no diagnostics line when program/version are both null (a robot that never answered ID) -- regression", () => {
    const { el } = mountRobotPage(robotDevice());

    expect(el.querySelector('[data-testid="robot-page-diagnostics"]')).toBeNull();
  });

  it("shows the raw program/version strings for a robot device that answered ID", () => {
    const { el } = mountRobotPage(robotDevice({ program: "tovez", version: "0.20260901.1" }));

    const diagnostics = el.querySelector('[data-testid="robot-page-diagnostics"]');
    expect(diagnostics).not.toBeNull();
    expect(diagnostics!.textContent).toContain("tovez");
    expect(diagnostics!.textContent).toContain("0.20260901.1");
  });

  it("shows the raw program/version strings for a calibration-program device", () => {
    const { el } = mountRobotPage(robotDevice({ program: "calibration-0.20260907.2", version: "0.20260907.2" }));

    const diagnostics = el.querySelector('[data-testid="robot-page-diagnostics"]');
    expect(diagnostics).not.toBeNull();
    expect(diagnostics!.textContent).toContain("calibration-0.20260907.2");
    expect(diagnostics!.textContent).toContain("0.20260907.2");
  });
});

describe("RobotPage reports the active console target (sprint 022 ticket 006)", () => {
  it("calls onActiveTargetChange once with its own link/name on mount", () => {
    const onActiveTargetChange = vi.fn();
    const robot = robotDevice({ name: "kivon" });
    mountRobotPage(robot, onActiveTargetChange);

    expect(onActiveTargetChange).toHaveBeenCalledTimes(1);
    expect(onActiveTargetChange).toHaveBeenCalledWith({ link: robot.links[0], name: "kivon" });
  });

  it("switching tabs (Main -> Drive -> Calibration -> Configuration) never reports again -- SUC-004's own acceptance criterion", () => {
    const onActiveTargetChange = vi.fn();
    const { el } = mountRobotPage(robotDevice(), onActiveTargetChange);
    expect(onActiveTargetChange).toHaveBeenCalledTimes(1);

    for (const tabId of ["drive", "calibration", "configuration", "diagnostics", "main"]) {
      act(() => {
        el.querySelector<HTMLButtonElement>(`[data-testid="robot-tab-${tabId}"]`)!.click();
      });
    }

    // A popup/dock target derived from this call must never retarget or
    // close purely because the student tabbed around within one device
    // -- tab switches carry no `link`/`device.name` change at all, so
    // this effect's dependency array never re-fires for them.
    expect(onActiveTargetChange).toHaveBeenCalledTimes(1);
  });
});

describe("RobotPage under AppHeader (ticket 012-004)", () => {
  // AppHeader owns the back-to-devices link and the Flash menu entry
  // (see AppHeader.test.tsx for the full behavior matrix); this is a
  // cheap per-page smoke test proving both actually show up on a real
  // robot device page's route, not just in AppHeader's own isolated
  // tests.
  it("shows a back-to-devices link and an enabled Flash entry alongside the robot page", () => {
    const robot = robotDevice();
    let socket: FakeSocket | null = null;
    const el = mount(
      withRouter(
        <WsProvider url="ws://test/" socketFactory={() => (socket = new FakeSocket())}>
          <AppHeader />
          <RobotPage device={robot} link={robot.links[0]!} onActiveTargetChange={() => {}} />
        </WsProvider>,
        { initialEntries: [`/d/${robot.links[0]!.id}`] },
      ),
    );
    act(() => {
      socket!.emitOpen();
    });
    act(() => {
      socket!.emitMessage(snapshot({ devices: [robot] }));
    });

    const backLink = el.querySelector("a");
    expect(backLink?.getAttribute("href")).toBe("/");
    const flashButton = Array.from(el.querySelectorAll("button")).find((b) => b.textContent === "Flash");
    expect(flashButton).not.toBeUndefined();
    expect(flashButton?.disabled).toBe(false);
  });
});
