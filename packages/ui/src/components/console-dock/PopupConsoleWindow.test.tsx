// @vitest-environment jsdom
/**
 * PopupConsoleWindow.test.tsx — sprint 022 ticket 005, SUC-003.
 *
 * `PopupConsoleWindow` is the one piece of this ticket that genuinely
 * cannot be exercised against a real browser window under jsdom (no
 * real `window.open`, per this ticket's own Testability note), so every
 * test here substitutes {@link createFakePopupWindow}'s plain,
 * `Window`-shaped fake object -- never a real popup, never the
 * `lib/popupWindow.ts` seam itself (that module's own
 * `popupWindow.test.ts` covers it in isolation; `ConsoleDock.test.tsx`
 * mocks it to prove the click handler wires the two together
 * correctly). This file exercises `PopupConsoleWindow` directly, one
 * level below `ConsoleDock`, so a failure here points straight at
 * portal/stylesheet/lifecycle mechanics rather than dock-chrome wiring.
 */
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SnapshotLink } from "@robot-console/host/src/wsMessages.js";
import { PopupConsoleWindow, copyParentStylesheets } from "./PopupConsoleWindow";
import { WsProvider } from "../../ws/WsProvider";
import { FakeSocket } from "../../testing/FakeSocket";
import { createFakePopupWindow, type FakePopupWindow } from "../../testing/FakePopupWindow";

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

function mountPopup(
  popupWindow: FakePopupWindow,
  onClose: () => void,
  overrides: { name?: string; commandsOpen?: boolean; onToggleCommands?: () => void } = {},
): void {
  let socket: FakeSocket | null = null;
  mount(
    <WsProvider url="ws://test/" socketFactory={() => (socket = new FakeSocket())}>
      <PopupConsoleWindow
        popupWindow={popupWindow as unknown as Window}
        link={link}
        name={overrides.name ?? "tigez"}
        onClose={onClose}
        commandsOpen={overrides.commandsOpen ?? false}
        onToggleCommands={overrides.onToggleCommands ?? (() => {})}
      />
    </WsProvider>,
  );
  void socket;
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
  // A leftover `<style>`/`<link>` this file appended to the *real*
  // document's own head (to give `copyParentStylesheets` something to
  // copy) must not bleed into a later test file's own head-copy
  // assertions.
  document.querySelectorAll("[data-popup-test-stylesheet]").forEach((node) => node.remove());
  vi.useRealTimers();
});

describe("copyParentStylesheets", () => {
  it("clones every <style> and <link rel='stylesheet'> from the real document.head into the target document", () => {
    const style = document.createElement("style");
    style.setAttribute("data-popup-test-stylesheet", "");
    style.textContent = ".probe { color: red; }";
    document.head.appendChild(style);

    const link2 = document.createElement("link");
    link2.setAttribute("data-popup-test-stylesheet", "");
    link2.rel = "stylesheet";
    link2.href = "https://example.test/app.css";
    document.head.appendChild(link2);

    const target = document.implementation.createHTMLDocument("target");
    copyParentStylesheets(target);

    expect(target.head.querySelector("style[data-popup-test-stylesheet]")?.textContent).toBe(".probe { color: red; }");
    expect(target.head.querySelector("link[data-popup-test-stylesheet]")?.getAttribute("href")).toBe("https://example.test/app.css");
  });

  it("does not copy non-stylesheet head elements (e.g. <meta>, <script>)", () => {
    const meta = document.createElement("meta");
    meta.setAttribute("data-popup-test-stylesheet", "");
    meta.setAttribute("charset", "utf-8");
    document.head.appendChild(meta);

    const target = document.implementation.createHTMLDocument("target");
    copyParentStylesheets(target);

    expect(target.head.querySelector("meta[data-popup-test-stylesheet]")).toBeNull();
  });
});

describe("PopupConsoleWindow rendering (sprint 022 ticket 005, SUC-003)", () => {
  it("copies every current parent stylesheet into the popup document's head at mount", () => {
    const style = document.createElement("style");
    style.setAttribute("data-popup-test-stylesheet", "");
    style.textContent = ".probe-two { color: blue; }";
    document.head.appendChild(style);

    const popup = createFakePopupWindow();
    mountPopup(popup, () => {});

    expect(popup.document.head.querySelector("style[data-popup-test-stylesheet]")?.textContent).toBe(".probe-two { color: blue; }");
  });

  it("portals DeviceConsole/CommandStrip content into a container appended to the popup's document.body", () => {
    const popup = createFakePopupWindow();
    mountPopup(popup, () => {});

    expect(popup.document.body.querySelector('[data-testid="popup-console-window"]')).not.toBeNull();
    expect(popup.document.body.querySelector('[aria-label="Console"]')).not.toBeNull();
    expect(popup.document.body.querySelector('[data-testid="console-log"]')).not.toBeNull();
    // The command rail is opt-in here exactly as it is in the dock
    // (2026-09-20), and `mountPopup` defaults `commandsOpen` to false.
    expect(popup.document.body.querySelector('[aria-label="Command strip"]')).toBeNull();
    // Nothing is portaled into the *real* test document -- the whole
    // point of the portal is that this content lives in the popup's
    // own document instead.
    expect(container!.querySelector('[data-testid="popup-console-window"]')).toBeNull();
  });

  it("shows the command rail in the popup when the dock says it is on", () => {
    // The flag is owned by ConsoleDock and passed down, so that a rail
    // toggled in one view is the same rail in the other -- see
    // PopupConsoleWindowProps' own comment on why this component does
    // not read the persisted state itself.
    const popup = createFakePopupWindow();
    mountPopup(popup, () => {}, { commandsOpen: true });
    expect(popup.document.body.querySelector('[data-testid="console-body-commands"]')).not.toBeNull();
    expect(popup.document.body.querySelector('[data-testid="command-strip-hello"]')).not.toBeNull();
  });

  it("asks its owner to flip the rail rather than writing the state itself", () => {
    const popup = createFakePopupWindow();
    let toggles = 0;
    mountPopup(popup, () => {}, { onToggleCommands: () => (toggles += 1) });
    const button = popup.document.body.querySelector<HTMLButtonElement>(
      '[data-testid="popup-console-commands-toggle"]',
    )!;
    expect(button.getAttribute("aria-expanded")).toBe("false");
    act(() => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(toggles).toBe(1);
  });

  it("sets the popup document's title from the active device name", () => {
    const popup = createFakePopupWindow();
    mountPopup(popup, () => {}, { name: "vevov" });
    expect(popup.document.title).toBe("Debug Console — vevov");
  });

  it("renders a 'put it back' control inside the popup", () => {
    const popup = createFakePopupWindow();
    mountPopup(popup, () => {});
    const restoreButton = popup.document.body.querySelector<HTMLButtonElement>('[data-testid="popup-console-restore"]');
    expect(restoreButton).not.toBeNull();
    expect(restoreButton!.textContent).toContain("Put it back");
  });
});

describe("PopupConsoleWindow lifecycle (sprint 022 ticket 005, SUC-003)", () => {
  it("'put it back' closes the popup window and calls onClose exactly once", () => {
    const popup = createFakePopupWindow();
    const onClose = vi.fn();
    mountPopup(popup, onClose);

    const restoreButton = popup.document.body.querySelector<HTMLButtonElement>('[data-testid="popup-console-restore"]');
    act(() => {
      restoreButton!.click();
    });

    expect(popup.closed).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("a native close (simulated via pagehide) calls onClose", () => {
    const popup = createFakePopupWindow();
    const onClose = vi.fn();
    mountPopup(popup, onClose);

    act(() => {
      popup.firePagehide();
    });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("falls back to polling popup.closed when pagehide never fires (e.g. an OS-level force close)", () => {
    vi.useFakeTimers();
    const popup = createFakePopupWindow();
    const onClose = vi.fn();
    mountPopup(popup, onClose);

    // Simulate the window vanishing without ever dispatching pagehide --
    // this is exactly the gap this ticket's Description calls out
    // ("a window force-closed by the OS may not fire pagehide at all").
    popup.closed = true;
    expect(onClose).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("calls onClose at most once even when pagehide and the closed-poll both observe the same close", () => {
    vi.useFakeTimers();
    const popup = createFakePopupWindow();
    const onClose = vi.fn();
    mountPopup(popup, onClose);

    act(() => {
      popup.firePagehide();
    });
    popup.closed = true;
    act(() => {
      vi.advanceTimersByTime(1000);
    });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("the parent window's unload closes an open popup", () => {
    const popup = createFakePopupWindow();
    mountPopup(popup, () => {});

    expect(popup.closed).toBe(false);
    act(() => {
      window.dispatchEvent(new Event("unload"));
    });
    expect(popup.closed).toBe(true);
  });

  it("does not close the popup merely because this component unmounts", () => {
    // This is the StrictMode-safety property this module's own doc
    // comment explains at length: an unconditional `popupWindow.close()`
    // in the effect's cleanup would close a just-opened popup the
    // instant React's development-mode double-invoke ran it once. A
    // plain unmount (this test, and — until ticket 006 wires its own
    // explicit close call — a route change) must leave the popup open.
    const popup = createFakePopupWindow();
    mountPopup(popup, () => {});

    act(() => {
      root!.unmount();
    });
    root = null;

    expect(popup.closed).toBe(false);
  });

  it("stops polling after unmount, without throwing on a stray timer tick", () => {
    vi.useFakeTimers();
    const popup = createFakePopupWindow();
    const onClose = vi.fn();
    mountPopup(popup, onClose);

    act(() => {
      root!.unmount();
    });
    root = null;

    popup.closed = true;
    expect(() => {
      act(() => {
        vi.advanceTimersByTime(5000);
      });
    }).not.toThrow();
    // The poll interval was cleared on unmount -- there is no live
    // component left to notify, so `onClose` (still referencing the
    // unmounted instance's callback) must not fire after the fact.
    expect(onClose).not.toHaveBeenCalled();
  });
});
