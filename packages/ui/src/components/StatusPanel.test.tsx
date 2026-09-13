// @vitest-environment jsdom
/**
 * StatusPanel.test.tsx — component tests (added out-of-process,
 * 2026-09-09; migrated to the `Snapshot` contract, sprint 015 ticket
 * 009).
 *
 * Proves: the headline state word for every `robotStatus` combination
 * (including the no-`robotStatus` "Unknown" case and estopped's
 * priority over every other flag); the raw `fields` render verbatim;
 * Clear E-STOP sends `SET estop_clear 1` then `STATUS`, in that order,
 * and only appears while `estopped` is `true`; every button disables
 * with no session open.
 *
 * Sprint 015 ticket 009: `link.session?.robotStatus` replaces
 * `device.robotStatus`; the panel's own on-open `STATUS` probe is
 * deleted outright (the harvester already polls `STATUS` on its own),
 * so the "asks for STATUS itself on mount / on reopen" pinned test case
 * this file used to carry is deleted too, not adapted.
 */
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { RobotStatus, SnapshotLink } from "@robot-console/host/src/wsMessages.js";
import { StatusPanel, describeStatusValue, statusRows } from "./StatusPanel";
import { WsProvider } from "../ws/WsProvider";
import { FakeSocket } from "../testing/FakeSocket";

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

function baseStatus(overrides: Partial<RobotStatus> = {}): RobotStatus {
  return {
    receivedAt: 2000,
    fields: { ready: "1", active: "0", flags: "1" },
    ready: true,
    active: false,
    estopped: false,
    stallHalted: false,
    leaseExpired: false,
    ...overrides,
  };
}

/** A link with an open session, optionally carrying a `robotStatus` --
 * `undefined` (the default) means "session open, no status reply yet". */
function openLink(status?: RobotStatus, overrides: Partial<SnapshotLink> = {}): SnapshotLink {
  return {
    id: "usb-ROBOT-A",
    transport: "usb",
    label: "USB · /dev/cu.usbmodemC",
    state: "connected",
    reason: null,
    since: 0,
    lastSeen: 0,
    nextRetryAt: null,
    capabilities: { open: false, close: true, flash: true, provisionWifi: true },
    session: { seq: 0, pending: 0, lastDone: null, lastDoneReason: null, robotStatus: status ?? null, functions: null },
    ...overrides,
  };
}

/** A link with no open session at all -- "No link open". */
function closedLink(overrides: Partial<Omit<SnapshotLink, "session">> = {}): SnapshotLink {
  return {
    id: "usb-ROBOT-A",
    transport: "usb",
    label: "USB · /dev/cu.usbmodemC",
    state: "connectable",
    reason: null,
    since: 0,
    lastSeen: 0,
    nextRetryAt: null,
    capabilities: { open: true, close: false, flash: true, provisionWifi: false },
    ...overrides,
  };
}

function mountPanel(link: SnapshotLink): { el: HTMLDivElement; socket: FakeSocket } {
  let socket: FakeSocket | null = null;
  const el = mount(
    <WsProvider url="ws://test/" socketFactory={() => (socket = new FakeSocket())}>
      <StatusPanel link={link} />
    </WsProvider>,
  );
  act(() => {
    socket!.emitOpen();
  });
  return { el, socket: socket! };
}

function stateText(el: HTMLDivElement): string | null {
  return el.querySelector('[data-testid="status-panel-state"]')?.textContent ?? null;
}

describe("StatusPanel state word", () => {
  it("shows a waiting note (not a state word) while there is no robotStatus yet", () => {
    const { el } = mountPanel(openLink());
    expect(stateText(el)).toContain("Waiting for the robot");
  });

  it("shows E-STOPPED on the heading line when estopped", () => {
    const { el } = mountPanel(openLink(baseStatus({ estopped: true, active: true, ready: true })));
    expect(stateText(el)).toBe("E-STOPPED");
  });

  it("OOP 2026-09-10 (stakeholder): shows no Ready/Moving word on the heading line -- the table carries both", () => {
    for (const status of [baseStatus(), baseStatus({ active: true }), baseStatus({ ready: false }), baseStatus({ stallHalted: true })]) {
      const { el } = mountPanel(openLink(status));
      expect(stateText(el)).toBeNull();
      expect(el.querySelector(".status-panel-heading")?.textContent).toBe("Status");
    }
  });
});

describe("StatusPanel 'last known' staleness label (extended scope, team-lead 2026-09-13, item A)", () => {
  it("labels the table 'last known' once the link is no longer usable (session survives, state dropped)", () => {
    const { el } = mountPanel(openLink(baseStatus(), { state: "unresponsive", reason: "no reply to 3 STATUS polls -- link presumed dead" }));
    expect(el.querySelector('[data-testid="status-panel-stale"]')?.textContent).toBe("last known");
    // The table itself is still rendered -- a pure display read, per
    // `isLinkUsable`'s own doc comment, not hidden outright.
    expect(el.querySelector('[data-testid="status-panel-fields"]')).not.toBeNull();
  });

  it("shows no 'last known' label while the link is actually usable", () => {
    const { el } = mountPanel(openLink(baseStatus()));
    expect(el.querySelector('[data-testid="status-panel-stale"]')).toBeNull();
  });

  it("shows no 'last known' label when there is no status at all to be stale", () => {
    const { el } = mountPanel(closedLink());
    expect(el.querySelector('[data-testid="status-panel-stale"]')).toBeNull();
  });
});

describe("StatusPanel fields (OOP 2026-09-10: a named table, no refresh, no counter)", () => {
  it("renders the firmware's keys as labelled rows with decoded values, unknown keys raw", () => {
    const { el } = mountPanel(
      openLink(
        baseStatus({
          fields: { ready: "1", connL: "1", connR: "0", otos: "1", flags: "5", cyc: "1234", tlm: "off", reason: "stop", zzz: "7" },
        }),
      ),
    );
    const table = el.querySelector('[data-testid="status-panel-fields"]')!;
    expect(table.tagName).toBe("TABLE");
    const rows = Array.from(table.querySelectorAll("tr")).map((tr) => [tr.querySelector("th")?.textContent, tr.querySelector("td")?.textContent]);
    expect(rows).toEqual([
      ["Ready", "Yes"],
      ["Left motor", "Connected"],
      ["Right motor", "Not seen moving yet"],
      ["Odometry sensor", "Detected"],
      ["Flags", "Ready, Stall halted (0x5)"],
      ["Control cycles", "1234"],
      ["Telemetry", "OFF"],
      ["Last completion", "stop"],
      ["zzz", "7"],
    ]);
  });

  it("statusRows/describeStatusValue: e-stop flag bit and a no-flags word", () => {
    expect(describeStatusValue("flags", "2")).toBe("E-stop (0x2)");
    expect(describeStatusValue("flags", "0")).toBe("none (0x0)");
    expect(statusRows({ wedge: "0" })).toEqual([{ key: "wedge", label: "Bus wedged", value: "No" }]);
  });

  it("shows just the Status heading, with no Refresh button or last-updated counter", () => {
    const { el } = mountPanel(openLink(baseStatus({ receivedAt: 2000 })));
    const heading = el.querySelector(".status-panel-heading")!;
    expect(heading.querySelector("h3")?.textContent).toBe("Status");
    expect(heading.querySelector('[data-testid="status-panel-state"]')).toBeNull();
    expect(el.querySelector('[data-testid="status-panel-refresh"]')).toBeNull();
    expect(el.textContent).not.toContain("Last updated");
    expect(el.textContent).not.toContain("Refresh");
  });

  it("says so when no link is open instead of pretending to wait", () => {
    const { el, socket } = mountPanel(closedLink());
    expect(socket.sent).toEqual([]);
    expect(stateText(el)).toBe("No link open");
  });
});

describe("StatusPanel Clear E-STOP", () => {
  it("is absent when not estopped", () => {
    const { el } = mountPanel(openLink(baseStatus()));
    expect(el.querySelector('[data-testid="status-panel-clear-estop"]')).toBeNull();
  });

  it("appears and sends SET estop_clear 1 then STATUS, in order, when estopped", () => {
    const { el, socket } = mountPanel(openLink(baseStatus({ estopped: true })));
    const button = el.querySelector<HTMLButtonElement>('[data-testid="status-panel-clear-estop"]')!;
    socket.sent.length = 0;
    act(() => {
      button.click();
    });
    expect(socket.sent).toEqual([
      JSON.stringify({
        type: "send-command",
        linkId: "usb-ROBOT-A",
        verb: "SET",
        fields: ["estop_clear", "1"],
      }),
      JSON.stringify({ type: "send-command", linkId: "usb-ROBOT-A", verb: "STATUS" }),
    ]);
  });

  it("never shows Clear E-STOP for a closed link -- a closed link's session (and its robotStatus) no longer exist under the Snapshot contract", () => {
    // Under `EndpointListEntry`, `robotStatus` and `sessionOpen` were
    // independent flat fields, so a stale "estopped" status could
    // outlive a session close. `SnapshotLink.session` (and everything
    // inside it, including `robotStatus`) is now present only *while a
    // session is open* (`wsMessages.ts`'s own doc comment) -- a closed
    // link structurally has no status to be estopped from, so this
    // replaces the old "estopped but closed, disabled" case with the
    // one that is actually reachable now.
    const { el } = mountPanel(closedLink());
    expect(el.querySelector('[data-testid="status-panel-clear-estop"]')).toBeNull();
  });
});
