// @vitest-environment jsdom
/**
 * ConsoleDock.test.tsx — sprint 022 ticket 002 (relocation) and ticket
 * 003 (collapse/toggle chrome, persistence, quiet indicator).
 *
 * Ticket 002's property still holds and is still covered here:
 * `ConsoleDock` mounts `DeviceConsole` and `CommandStrip` for the given
 * link, unchanged, in one place — their own behavior (send box, log
 * classification, HELLO/ID/VER/STATUS/FUNCS dispatch, field discovery)
 * is covered by `DeviceConsole.test.tsx`/`CommandStrip.test.tsx` and is
 * not re-asserted here. Ticket 003 adds: the bar renders unconditionally
 * and content only renders once toggled open, the toggle round-trips
 * through `localStorage` (`useDockPersistence`'s fixed key), and the
 * collapsed bar's quiet indicator lights up only for a `warn`/`error`
 * `LinkNotice` on *this* link.
 */
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { SnapshotLink } from "@robot-console/host/src/wsMessages.js";
import { ConsoleDock } from "./ConsoleDock";
import { WsProvider } from "../../ws/WsProvider";
import { FakeSocket } from "../../testing/FakeSocket";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

const link: SnapshotLink = {
  id: "usb-A",
  transport: "usb",
  label: "USB · /dev/cu.usbmodemA",
  state: "connected",
  reason: null,
  since: 0,
  lastSeen: 0,
  nextRetryAt: null,
  capabilities: { open: false, close: true, flash: true, provisionWifi: true },
  session: { seq: 0, pending: 0, lastDone: null, lastDoneReason: null, robotStatus: null, functions: null },
};

function mount(node: ReactElement): HTMLDivElement {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(node);
  });
  return container;
}

function mountDock(overrides: Partial<SnapshotLink> = {}): { el: HTMLDivElement; socket: FakeSocket } {
  let socket: FakeSocket | null = null;
  const el = mount(
    <WsProvider url="ws://test/" socketFactory={() => (socket = new FakeSocket())}>
      <ConsoleDock link={{ ...link, ...overrides }} name="tigez" />
    </WsProvider>,
  );
  return { el, socket: socket! };
}

function toggle(el: HTMLDivElement): void {
  const button = el.querySelector<HTMLButtonElement>('[data-testid="console-dock-toggle"]');
  expect(button).not.toBeNull();
  act(() => {
    button!.click();
  });
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
  // `useDockPersistence` writes to a single fixed key -- clear it
  // between tests the same way `FrontPage.test.tsx` already does for
  // its own localStorage-backed state, so a later test never inherits
  // an earlier test's toggled-open choice.
  window.localStorage.clear();
});

describe("ConsoleDock", () => {
  it("renders as a single labeled dock region", () => {
    const { el } = mountDock();
    expect(el.querySelector('[data-testid="console-dock"]')).not.toBeNull();
  });

  it("mounts DeviceConsole (log, toolbar, send box) for the given link, unchanged, once opened", () => {
    const { el } = mountDock();
    toggle(el);
    expect(el.querySelector('[aria-label="Console"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="console-log"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="console-send-input"]')).not.toBeNull();
  });

  it("mounts CommandStrip's verb buttons for the given link, unchanged, once opened", () => {
    const { el } = mountDock();
    toggle(el);
    expect(el.querySelector('[aria-label="Command strip"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="command-strip-hello"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="command-strip-get"]')).not.toBeNull();
  });

  it("passes the given name through to DeviceConsole's 'no link open' hint, once opened", () => {
    const { session: _unusedSession, ...linkWithoutSession } = link;
    const closedLink: SnapshotLink = { ...linkWithoutSession, state: "closed_by_user" };
    let socket: FakeSocket | null = null;
    const el = mount(
      <WsProvider url="ws://test/" socketFactory={() => (socket = new FakeSocket())}>
        <ConsoleDock link={closedLink} name="vevov" />
      </WsProvider>,
    );
    void socket;
    toggle(el);
    expect(el.textContent).toContain("No link open to vevov");
  });
});

describe("ConsoleDock collapse/toggle chrome (sprint 022 ticket 003, SUC-001)", () => {
  it("shows the 'Debug Console' bar and toggle unconditionally", () => {
    const { el } = mountDock();
    expect(el.querySelector('[data-testid="console-dock"]')?.textContent).toContain("Debug Console");
    expect(el.querySelector('[data-testid="console-dock-toggle"]')).not.toBeNull();
  });

  it("is collapsed by default -- no log, toolbar, or send box on a never-before-visited browser", () => {
    const { el } = mountDock();
    expect(el.querySelector('[data-testid="console-dock-pane"]')).toBeNull();
    expect(el.querySelector('[data-testid="console-log"]')).toBeNull();
    expect(el.querySelector('[data-testid="console-send-input"]')).toBeNull();
    expect(el.querySelector('[aria-label="Command strip"]')).toBeNull();
    expect(el.querySelector('[data-testid="console-dock-toggle"]')?.getAttribute("aria-expanded")).toBe("false");
  });

  it("toggling open reveals the pane; toggling again collapses it, without unmounting the dock itself", () => {
    const { el } = mountDock();

    toggle(el);
    expect(el.querySelector('[data-testid="console-dock-pane"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="console-dock-toggle"]')?.getAttribute("aria-expanded")).toBe("true");

    toggle(el);
    expect(el.querySelector('[data-testid="console-dock-pane"]')).toBeNull();
    // The bar itself never disappears, collapsed or open.
    expect(el.querySelector('[data-testid="console-dock"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="console-dock-toggle"]')?.getAttribute("aria-expanded")).toBe("false");
  });

  it("persists the open choice across a remount (a page reload, in effect)", () => {
    const { el } = mountDock();
    toggle(el);
    expect(el.querySelector('[data-testid="console-dock-pane"]')).not.toBeNull();

    act(() => {
      root!.unmount();
    });
    container!.remove();

    // A fresh mount -- new container, new root, same `localStorage` --
    // stands in for a reload of the same browser.
    const { el: reloaded } = mountDock();
    expect(reloaded.querySelector('[data-testid="console-dock-pane"]')).not.toBeNull();
    expect(reloaded.querySelector('[data-testid="console-dock-toggle"]')?.getAttribute("aria-expanded")).toBe("true");
  });

  it("a fresh/cleared browser (no stored preference) defaults to collapsed", () => {
    window.localStorage.clear();
    const { el } = mountDock();
    expect(el.querySelector('[data-testid="console-dock-pane"]')).toBeNull();
  });
});

describe("ConsoleDock quiet indicator (sprint 022 ticket 003, sprint.md Design Rationale)", () => {
  it("shows no indicator when there is no notice for this link", () => {
    const { el } = mountDock();
    expect(el.querySelector('[data-testid="console-dock-indicator"]')).toBeNull();
  });

  it("shows the indicator for a warn-level notice on the active link", () => {
    const { el, socket } = mountDock();
    act(() => {
      socket.emitMessage({ type: "notice", level: "warn", linkId: link.id, text: "connect refused: already open", at: 1, seq: 1 });
    });
    const indicator = el.querySelector('[data-testid="console-dock-indicator"]');
    expect(indicator).not.toBeNull();
    expect(indicator!.className).toContain("console-dock-indicator-warn");
  });

  it("shows the indicator for an error-level notice on the active link", () => {
    const { el, socket } = mountDock();
    act(() => {
      socket.emitMessage({ type: "notice", level: "error", linkId: link.id, text: "link failed", at: 1, seq: 1 });
    });
    const indicator = el.querySelector('[data-testid="console-dock-indicator"]');
    expect(indicator).not.toBeNull();
    expect(indicator!.className).toContain("console-dock-indicator-error");
  });

  it("shows no indicator for an info-level notice -- info is not worth surfacing while collapsed", () => {
    const { el, socket } = mountDock();
    act(() => {
      socket.emitMessage({ type: "notice", level: "info", linkId: link.id, text: "reconnected", at: 1, seq: 1 });
    });
    expect(el.querySelector('[data-testid="console-dock-indicator"]')).toBeNull();
  });

  it("shows no indicator for a warn notice scoped to a different link", () => {
    const { el, socket } = mountDock();
    act(() => {
      socket.emitMessage({ type: "notice", level: "warn", linkId: "usb-OTHER", text: "unrelated", at: 1, seq: 1 });
    });
    expect(el.querySelector('[data-testid="console-dock-indicator"]')).toBeNull();
  });

  it("keeps the indicator visible while the dock is open, not just while collapsed", () => {
    const { el, socket } = mountDock();
    act(() => {
      socket.emitMessage({ type: "notice", level: "error", linkId: link.id, text: "link failed", at: 1, seq: 1 });
    });
    toggle(el);
    expect(el.querySelector('[data-testid="console-dock-indicator"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="console-dock-pane"]')).not.toBeNull();
  });
});
