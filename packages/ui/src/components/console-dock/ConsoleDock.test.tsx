// @vitest-environment jsdom
/**
 * ConsoleDock.test.tsx — sprint 022 ticket 002 (relocation), ticket 003
 * (collapse/toggle chrome, persistence, quiet indicator), and ticket 004
 * (drag-to-resize, persisted height).
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
 * `LinkNotice` on *this* link. Ticket 004 adds the resize handle: drag
 * mechanics, min/max clamping, and `heightPx` persistence.
 *
 * ## Simulating a pointer drag in jsdom
 *
 * `ConsoleDock.tsx`'s own doc comment covers this in full, but the short
 * version for these tests: jsdom (this suite's `@vitest-environment`)
 * implements the `PointerEvent` constructor but not the Pointer Capture
 * API, and `useDragResize` was deliberately written to track drags via
 * `window`-level listeners rather than element capture for exactly this
 * reason. `firePointer` below dispatches a real `PointerEvent` at a
 * given target (the handle for `pointerdown`, `window` for
 * `pointermove`/`pointerup`, matching how the component itself listens)
 * so these tests exercise the same code path a real browser would.
 */
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SnapshotLink } from "@robot-console/host/src/wsMessages.js";
import { ConsoleDock, MIN_DOCK_HEIGHT_PX, MAX_DOCK_HEIGHT_PX } from "./ConsoleDock";
import { DEFAULT_DOCK_HEIGHT_PX } from "./useDockPersistence";
import { WsProvider } from "../../ws/WsProvider";
import { FakeSocket } from "../../testing/FakeSocket";
import { createFakePopupWindow } from "../../testing/FakePopupWindow";
import { openPopupWindow } from "../../lib/popupWindow";

/**
 * Ticket 005: `lib/popupWindow.ts` is mocked wholesale so these tests
 * never depend on jsdom's own nonexistent `window.open` (this ticket's
 * own Testability note) — `openPopupWindow` becomes a `vi.fn()` each
 * pop-out test points at a fresh `createFakePopupWindow()` fake (the
 * same fake `PopupConsoleWindow.test.tsx` uses to exercise that
 * component's own mechanics directly). This file's own pop-out tests
 * are about `ConsoleDock`'s *wiring* — does the click handler call the
 * seam synchronously, does the dock collapse, does reopening the dock
 * close the popup — not `PopupConsoleWindow`'s portal/stylesheet/
 * lifecycle internals, which that component's own suite already covers.
 */
vi.mock("../../lib/popupWindow", () => ({
  openPopupWindow: vi.fn(),
}));

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

/** Dispatch a real `PointerEvent` at `target`, matching how
 * `useDragResize` itself listens (`pointerdown` on the handle element,
 * `pointermove`/`pointerup`/`pointercancel` on `window`) -- see this
 * file's own doc comment for why a constructed `PointerEvent` rather
 * than a higher-level testing-library helper is used here. */
function firePointer(target: EventTarget, type: "pointerdown" | "pointermove" | "pointerup" | "pointercancel", clientY: number): void {
  act(() => {
    target.dispatchEvent(
      new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, pointerType: "mouse", button: 0, clientY }),
    );
  });
}

function getHandle(el: HTMLDivElement): HTMLDivElement {
  const handle = el.querySelector<HTMLDivElement>('[data-testid="console-dock-resize-handle"]');
  expect(handle).not.toBeNull();
  return handle!;
}

function getPane(el: HTMLDivElement): HTMLDivElement {
  const pane = el.querySelector<HTMLDivElement>('[data-testid="console-dock-pane"]');
  expect(pane).not.toBeNull();
  return pane!;
}

/** Run one full drag gesture (`pointerdown` on the handle, one
 * `pointermove` on `window`, then `pointerup` on `window`) and return
 * the pane's height (in px, as a number) immediately after. `startY` is
 * the handle's `pointerdown` `clientY`; `moveY` is the single
 * `pointermove`'s `clientY` -- per this ticket's Description ("drag up
 * to grow, down to shrink"), `moveY < startY` grows the dock. */
function drag(el: HTMLDivElement, startY: number, moveY: number): number {
  const handle = getHandle(el);
  firePointer(handle, "pointerdown", startY);
  firePointer(window, "pointermove", moveY);
  firePointer(window, "pointerup", moveY);
  return Number.parseInt(getPane(el).style.height, 10);
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
  vi.mocked(openPopupWindow).mockReset();
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

describe("ConsoleDock resize handle (sprint 022 ticket 004, SUC-002)", () => {
  it("renders no resize handle while collapsed", () => {
    const { el } = mountDock();
    expect(el.querySelector('[data-testid="console-dock-resize-handle"]')).toBeNull();
  });

  it("renders a resize handle at the top of the pane once opened", () => {
    const { el } = mountDock();
    toggle(el);
    const handle = getHandle(el);
    expect(handle.getAttribute("role")).toBe("separator");
    // The handle must be the pane's first child -- "the top edge of the
    // open dock" per this ticket's Acceptance Criteria, not just
    // somewhere inside the pane.
    expect(getPane(el).firstElementChild).toBe(handle);
  });

  it("starts at the default height (DEFAULT_DOCK_HEIGHT_PX) on a never-before-visited browser", () => {
    const { el } = mountDock();
    toggle(el);
    expect(getPane(el).style.height).toBe(`${DEFAULT_DOCK_HEIGHT_PX}px`);
  });

  it("dragging the handle up grows the dock height live, during the drag itself", () => {
    const { el } = mountDock();
    toggle(el);
    const handle = getHandle(el);
    firePointer(handle, "pointerdown", 500);
    // Dragged up 50px (500 -> 450) -- before pointerup, so this asserts
    // the live-feedback path, not just the post-commit value.
    firePointer(window, "pointermove", 450);
    expect(getPane(el).style.height).toBe(`${DEFAULT_DOCK_HEIGHT_PX + 50}px`);
    firePointer(window, "pointerup", 450);
  });

  it("dragging the handle down shrinks the dock height", () => {
    const { el } = mountDock();
    toggle(el);
    const finalHeight = drag(el, 500, 560);
    expect(finalHeight).toBe(DEFAULT_DOCK_HEIGHT_PX - 60);
  });

  it("stays pinned full width and to the bottom of .console-dock while resizing (no width/position change)", () => {
    const { el } = mountDock();
    toggle(el);
    const pane = getPane(el);
    firePointer(getHandle(el), "pointerdown", 500);
    firePointer(window, "pointermove", 300);
    // Only `height` is ever written by the drag -- no inline
    // width/left/top/position styling is introduced, so the pane keeps
    // whatever full-width/bottom-pinned layout its CSS already gives it.
    expect(pane.style.width).toBe("");
    expect(pane.style.position).toBe("");
    firePointer(window, "pointerup", 300);
  });

  it("clamps growth at MAX_DOCK_HEIGHT_PX", () => {
    const { el } = mountDock();
    toggle(el);
    const finalHeight = drag(el, 1000, -5000);
    expect(finalHeight).toBe(MAX_DOCK_HEIGHT_PX);
  });

  it("clamps shrinkage at MIN_DOCK_HEIGHT_PX", () => {
    const { el } = mountDock();
    toggle(el);
    const finalHeight = drag(el, 500, 6000);
    expect(finalHeight).toBe(MIN_DOCK_HEIGHT_PX);
  });

  it("does not write to localStorage on pointermove -- only on pointerup", () => {
    const { el } = mountDock();
    toggle(el);
    firePointer(getHandle(el), "pointerdown", 500);
    firePointer(window, "pointermove", 400);
    const midDragStored = JSON.parse(window.localStorage.getItem("robot-console:console-dock")!);
    expect(midDragStored.heightPx).toBe(DEFAULT_DOCK_HEIGHT_PX);
    firePointer(window, "pointerup", 400);
    const afterUpStored = JSON.parse(window.localStorage.getItem("robot-console:console-dock")!);
    expect(afterUpStored.heightPx).toBe(DEFAULT_DOCK_HEIGHT_PX + 100);
  });

  it("persists the resized height across a remount (a page reload, in effect)", () => {
    const { el } = mountDock();
    toggle(el);
    const finalHeight = drag(el, 500, 420);
    expect(finalHeight).toBe(DEFAULT_DOCK_HEIGHT_PX + 80);

    act(() => {
      root!.unmount();
    });
    container!.remove();

    const { el: reloaded } = mountDock();
    // `open` was persisted `true` by the `toggle(el)` above, so the
    // reloaded dock comes back open already, at the dragged height.
    expect(getPane(reloaded).style.height).toBe(`${DEFAULT_DOCK_HEIGHT_PX + 80}px`);
  });

  it("collapsing and reopening within the same session preserves the last chosen height", () => {
    const { el } = mountDock();
    toggle(el);
    const finalHeight = drag(el, 500, 380);
    expect(finalHeight).toBe(DEFAULT_DOCK_HEIGHT_PX + 120);

    toggle(el); // collapse
    expect(el.querySelector('[data-testid="console-dock-pane"]')).toBeNull();

    toggle(el); // reopen, same session -- no remount
    expect(getPane(el).style.height).toBe(`${DEFAULT_DOCK_HEIGHT_PX + 120}px`);
  });

  it("cleans up window listeners on unmount mid-drag, without throwing on a stray move/up afterward", () => {
    const { el } = mountDock();
    toggle(el);
    firePointer(getHandle(el), "pointerdown", 500);
    firePointer(window, "pointermove", 460);

    act(() => {
      root!.unmount();
    });
    container!.remove();
    root = null;
    container = null;

    // If the effect cleanup failed to remove the window listeners, this
    // would throw (React attempting to update an unmounted tree) or, at
    // minimum, leak a listener that outlives the component -- either way
    // this call must be a silent no-op.
    expect(() => {
      firePointer(window, "pointermove", 300);
      firePointer(window, "pointerup", 300);
    }).not.toThrow();
  });
});

function getPopOutButton(el: HTMLDivElement): HTMLButtonElement {
  const button = el.querySelector<HTMLButtonElement>('[data-testid="console-dock-popout"]');
  expect(button).not.toBeNull();
  return button!;
}

describe("ConsoleDock pop-out window (sprint 022 ticket 005, SUC-003)", () => {
  it("calls openPopupWindow synchronously, exactly once, when the pop-out button is clicked", () => {
    const fakePopup = createFakePopupWindow();
    vi.mocked(openPopupWindow).mockReturnValue(fakePopup as unknown as Window);
    const { el } = mountDock();

    act(() => {
      getPopOutButton(el).click();
    });

    expect(openPopupWindow).toHaveBeenCalledTimes(1);
  });

  it("collapses the docked console once popped out, even if it was open beforehand", () => {
    const fakePopup = createFakePopupWindow();
    vi.mocked(openPopupWindow).mockReturnValue(fakePopup as unknown as Window);
    const { el } = mountDock();
    toggle(el); // open it first
    expect(el.querySelector('[data-testid="console-dock-pane"]')).not.toBeNull();

    act(() => {
      getPopOutButton(el).click();
    });

    expect(el.querySelector('[data-testid="console-dock-pane"]')).toBeNull();
    expect(el.querySelector('[data-testid="console-dock-toggle"]')?.getAttribute("aria-expanded")).toBe("false");
  });

  it("renders the console content inside the popup's own document, not the main window", () => {
    const fakePopup = createFakePopupWindow();
    vi.mocked(openPopupWindow).mockReturnValue(fakePopup as unknown as Window);
    const { el } = mountDock();

    act(() => {
      getPopOutButton(el).click();
    });

    expect(fakePopup.document.body.querySelector('[data-testid="popup-console-window"]')).not.toBeNull();
    expect(fakePopup.document.body.querySelector('[data-testid="console-log"]')).not.toBeNull();
    // The main window's own dock never gets a second copy of the log --
    // SUC-003's postcondition is exactly one visible console at a time.
    expect(el.querySelector('[data-testid="console-log"]')).toBeNull();
  });

  it("replaces the pop-out button with a quiet hint while popped out", () => {
    const fakePopup = createFakePopupWindow();
    vi.mocked(openPopupWindow).mockReturnValue(fakePopup as unknown as Window);
    const { el } = mountDock();

    expect(el.querySelector('[data-testid="console-dock-popped-out-hint"]')).toBeNull();
    act(() => {
      getPopOutButton(el).click();
    });
    expect(el.querySelector('[data-testid="console-dock-popout"]')).toBeNull();
    expect(el.querySelector('[data-testid="console-dock-popped-out-hint"]')).not.toBeNull();
  });

  it("does nothing to the dock when openPopupWindow returns null (a blocked popup)", () => {
    vi.mocked(openPopupWindow).mockReturnValue(null);
    const { el } = mountDock();
    toggle(el); // open it first
    expect(el.querySelector('[data-testid="console-dock-pane"]')).not.toBeNull();

    act(() => {
      getPopOutButton(el).click();
    });

    // Still open, still showing the pop-out button (not the hint) --
    // nothing opened, so nothing about the dock's own state changes.
    expect(el.querySelector('[data-testid="console-dock-pane"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="console-dock-popout"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="console-dock-popped-out-hint"]')).toBeNull();
  });

  it("reopening the docked console (the toggle) while popped out closes the popup", () => {
    const fakePopup = createFakePopupWindow();
    vi.mocked(openPopupWindow).mockReturnValue(fakePopup as unknown as Window);
    const { el } = mountDock();

    act(() => {
      getPopOutButton(el).click();
    });
    expect(fakePopup.closed).toBe(false);

    toggle(el);

    // The stakeholder's own words for this exact case: "if I do that,
    // it closes the window, and now I'm seeing the console at the
    // bottom of the screen."
    expect(fakePopup.closed).toBe(true);
    expect(el.querySelector('[data-testid="console-dock-pane"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="console-dock-toggle"]')?.getAttribute("aria-expanded")).toBe("true");
    expect(el.querySelector('[data-testid="console-dock-popout"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="console-dock-popped-out-hint"]')).toBeNull();
  });

  it("the popup's own 'put it back' button reopens the docked console (open, not collapsed)", () => {
    const fakePopup = createFakePopupWindow();
    vi.mocked(openPopupWindow).mockReturnValue(fakePopup as unknown as Window);
    const { el } = mountDock();

    act(() => {
      getPopOutButton(el).click();
    });
    const restoreButton = fakePopup.document.body.querySelector<HTMLButtonElement>('[data-testid="popup-console-restore"]');
    expect(restoreButton).not.toBeNull();

    act(() => {
      restoreButton!.click();
    });

    expect(fakePopup.closed).toBe(true);
    expect(el.querySelector('[data-testid="console-dock-pane"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="console-dock-toggle"]')?.getAttribute("aria-expanded")).toBe("true");
    expect(el.querySelector('[data-testid="console-dock-popout"]')).not.toBeNull();
  });

  it("closing the popup window directly (simulated via pagehide) reopens the docked console", () => {
    const fakePopup = createFakePopupWindow();
    vi.mocked(openPopupWindow).mockReturnValue(fakePopup as unknown as Window);
    const { el } = mountDock();

    act(() => {
      getPopOutButton(el).click();
    });

    act(() => {
      fakePopup.firePagehide();
    });

    // Restored to *open*, never collapsed -- SUC-003's Alternate Flow:
    // closing the popup by hand is the student asking for the console
    // back, not asking for it to disappear.
    expect(el.querySelector('[data-testid="console-dock-pane"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="console-dock-toggle"]')?.getAttribute("aria-expanded")).toBe("true");
    expect(el.querySelector('[data-testid="console-dock-popped-out-hint"]')).toBeNull();
  });

  it("the parent window's unload closes an open popup", () => {
    const fakePopup = createFakePopupWindow();
    vi.mocked(openPopupWindow).mockReturnValue(fakePopup as unknown as Window);
    const { el } = mountDock();

    act(() => {
      getPopOutButton(el).click();
    });
    expect(fakePopup.closed).toBe(false);

    act(() => {
      window.dispatchEvent(new Event("unload"));
    });

    expect(fakePopup.closed).toBe(true);
  });
});
