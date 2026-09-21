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
import {
  ConsoleDock,
  MIN_DOCK_HEIGHT_PX,
  MAX_DOCK_HEIGHT_PX,
  COLLAPSED_DOCK_HEIGHT_PX,
  OPEN_PANE_BORDER_PX,
  CONSOLE_DOCK_HEIGHT_PROPERTY,
} from "./ConsoleDock";
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

/** Reads back the `--console-dock-height` custom property `ConsoleDock`
 * writes to `document.documentElement.style` (sprint 022 ticket 008) --
 * jsdom does support `CSSStyleDeclaration.getPropertyValue`/
 * `setProperty` on a real element, even though it has no layout engine
 * to back a *measured* size with (see `ConsoleDock.tsx`'s own doc
 * comment, "Ticket 008," for why the value written is a computed
 * formula rather than a DOM measurement -- exactly so this assertion is
 * meaningful in this environment). */
function getDockHeightProperty(): string {
  return document.documentElement.style.getPropertyValue(CONSOLE_DOCK_HEIGHT_PROPERTY);
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

  it("keeps CommandStrip OUT of the open pane until the Commands rail is asked for", () => {
    // Stakeholder, 2026-09-20, on the HELLO/ID/VER/STATUS/FUNCS and
    // GET/SET controls sitting under every open console: "We don't need
    // that most of the time. Let's move that off to a side menu... try
    // to get it out of the way." So opening the dock now gets the log
    // and nothing else; the rail is opt-in.
    const { el } = mountDock();
    toggle(el);
    expect(el.querySelector('[data-testid="console-body"]')).not.toBeNull();
    expect(el.querySelector('[aria-label="Command strip"]')).toBeNull();
    expect(el.querySelector('[data-testid="command-strip-hello"]')).toBeNull();
  });

  it("mounts CommandStrip's verb buttons, unchanged, in the rail once Commands is toggled on", () => {
    const { el } = mountDock();
    toggle(el);
    const commands = el.querySelector<HTMLButtonElement>('[data-testid="console-dock-commands-toggle"]')!;
    expect(commands.getAttribute("aria-expanded")).toBe("false");
    act(() => {
      commands.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(commands.getAttribute("aria-expanded")).toBe("true");
    // The rail is a distinct region beside the log, not a second
    // stacked block under it.
    expect(el.querySelector('[data-testid="console-body-commands"]')).not.toBeNull();
    expect(el.querySelector('[aria-label="Command strip"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="command-strip-hello"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="command-strip-get"]')).not.toBeNull();
  });

  it("offers no Commands toggle while the dock is collapsed -- the rail lives inside the pane", () => {
    const { el } = mountDock();
    expect(el.querySelector('[data-testid="console-dock-commands-toggle"]')).toBeNull();
    toggle(el);
    expect(el.querySelector('[data-testid="console-dock-commands-toggle"]')).not.toBeNull();
  });

  it("remembers the rail across a collapse/reopen, and across a remount", () => {
    // Independent of `open`: collapsing the console must not quietly
    // discard a rail the student deliberately turned on.
    const first = mountDock();
    toggle(first.el);
    act(() => {
      first.el
        .querySelector('[data-testid="console-dock-commands-toggle"]')!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    toggle(first.el);
    toggle(first.el);
    expect(first.el.querySelector('[data-testid="console-body-commands"]')).not.toBeNull();

    const second = mountDock();
    expect(second.el.querySelector('[data-testid="console-body-commands"]')).not.toBeNull();
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

  // Sprint 022 ticket 006: the fifth close path, and the one that did
  // not exist before this ticket -- see this file's own doc comment
  // ("Ticket 006") for why it is safe to add here (an unconditional
  // close in this component's own unmount cleanup) when the identical-
  // looking thing was rejected as unsafe inside `PopupConsoleWindow`
  // itself. In the real app this fires when `DevicePage` unmounts on
  // navigation back to `/` (covered end-to-end, with a real route
  // change, in `DevicePage.test.tsx`); this test isolates the same
  // mechanism at `ConsoleDock`'s own level, closer to the code that
  // actually performs the close.
  it("closes an open popup when this component itself unmounts, leaving no orphan window", () => {
    const fakePopup = createFakePopupWindow();
    vi.mocked(openPopupWindow).mockReturnValue(fakePopup as unknown as Window);
    const { el } = mountDock();

    act(() => {
      getPopOutButton(el).click();
    });
    expect(fakePopup.closed).toBe(false);

    act(() => {
      root!.unmount();
    });
    root = null;
    container!.remove();
    container = null;

    expect(fakePopup.closed).toBe(true);
  });

  it("does NOT close anything on unmount when no popup was ever opened (StrictMode's synthetic mount/cleanup/mount right after this component's own mount must be a no-op)", () => {
    // This is the scenario this file's own doc comment describes as the
    // one moment this ticket's unmount effect could possibly observe a
    // StrictMode double-invoke: immediately after mount, before any
    // click. `openPopupWindow` is never even called in this test, so
    // there is nothing for a wrongly-implemented cleanup to have closed
    // -- this test exists to document that expectation, not because
    // this project's test environment can simulate StrictMode's replay
    // directly (React DOM's `createRoot`, used throughout this file,
    // does not enable `<StrictMode>` on its own).
    const { el } = mountDock();
    expect(el.querySelector('[data-testid="console-dock"]')).not.toBeNull();

    act(() => {
      root!.unmount();
    });
    root = null;
    container!.remove();
    container = null;

    expect(openPopupWindow).not.toHaveBeenCalled();
  });
});

/**
 * Sprint 022 ticket 008: `--console-dock-height`.
 *
 * Per this ticket's own Verification note, this is what jsdom *can*
 * meaningfully check about the viewport-pinning work: that `ConsoleDock`
 * writes the expected numeric value to the shared custom property on
 * mount, toggle, and live during a drag. What it deliberately does not
 * and cannot check -- actual `position: fixed` pinning against a real
 * viewport, the collapsed-vs-open visual difference, or non-overlap with
 * a page's bottom controls -- is a live-Chromium-only concern (this
 * file's own header comment already establishes the same split for
 * pointer-drag mechanics vs. real cursor affordances).
 */
describe("ConsoleDock --console-dock-height (sprint 022 ticket 008)", () => {
  it("writes just the collapsed height on a never-before-visited (collapsed-by-default) mount", () => {
    mountDock();
    expect(getDockHeightProperty()).toBe(`${COLLAPSED_DOCK_HEIGHT_PX}px`);
  });

  it("writes the collapsed height again after toggling closed", () => {
    const { el } = mountDock();
    toggle(el); // open
    toggle(el); // collapse
    expect(getDockHeightProperty()).toBe(`${COLLAPSED_DOCK_HEIGHT_PX}px`);
  });

  it("writes bar height plus the default pane height once toggled open", () => {
    const { el } = mountDock();
    toggle(el);
    expect(getDockHeightProperty()).toBe(`${COLLAPSED_DOCK_HEIGHT_PX + OPEN_PANE_BORDER_PX + DEFAULT_DOCK_HEIGHT_PX}px`);
  });

  it("mounts already reflecting a persisted open+dragged height, with no separate 'fix it up later' step", () => {
    window.localStorage.setItem("robot-console:console-dock", JSON.stringify({ open: true, heightPx: 400 }));
    mountDock();
    expect(getDockHeightProperty()).toBe(`${COLLAPSED_DOCK_HEIGHT_PX + OPEN_PANE_BORDER_PX + 400}px`);
  });

  it("updates live during a drag, before pointerup commits the final value", () => {
    const { el } = mountDock();
    toggle(el);
    const handle = getHandle(el);
    firePointer(handle, "pointerdown", 500);
    // Dragged up 50px -- see this file's own `drag`/`firePointer` doc
    // comments for the "drag up grows" sign convention.
    firePointer(window, "pointermove", 450);
    expect(getDockHeightProperty()).toBe(`${COLLAPSED_DOCK_HEIGHT_PX + OPEN_PANE_BORDER_PX + DEFAULT_DOCK_HEIGHT_PX + 50}px`);
    firePointer(window, "pointerup", 450);
    // Settles back to the same value post-commit -- committing to
    // `localStorage` does not itself change the live height, only where
    // it will be read from on the next mount.
    expect(getDockHeightProperty()).toBe(`${COLLAPSED_DOCK_HEIGHT_PX + OPEN_PANE_BORDER_PX + DEFAULT_DOCK_HEIGHT_PX + 50}px`);
  });

  it("tracks a clamped drag (MAX_DOCK_HEIGHT_PX) the same way the pane's own height does", () => {
    const { el } = mountDock();
    toggle(el);
    const finalHeight = drag(el, 1000, -5000);
    expect(finalHeight).toBe(MAX_DOCK_HEIGHT_PX);
    expect(getDockHeightProperty()).toBe(`${COLLAPSED_DOCK_HEIGHT_PX + OPEN_PANE_BORDER_PX + MAX_DOCK_HEIGHT_PX}px`);
  });

  it("collapsing while a popup is open (pop-out always collapses the dock) writes the collapsed height", () => {
    const fakePopup = createFakePopupWindow();
    vi.mocked(openPopupWindow).mockReturnValue(fakePopup as unknown as Window);
    const { el } = mountDock();
    toggle(el); // open first
    expect(getDockHeightProperty()).not.toBe(`${COLLAPSED_DOCK_HEIGHT_PX}px`);

    act(() => {
      getPopOutButton(el).click();
    });

    expect(getDockHeightProperty()).toBe(`${COLLAPSED_DOCK_HEIGHT_PX}px`);
  });

  it("removes the property on unmount, leaving no stale reservation for whatever mounts next", () => {
    mountDock();
    expect(getDockHeightProperty()).not.toBe("");

    act(() => {
      root!.unmount();
    });
    root = null;
    container!.remove();
    container = null;

    expect(getDockHeightProperty()).toBe("");
  });
});
