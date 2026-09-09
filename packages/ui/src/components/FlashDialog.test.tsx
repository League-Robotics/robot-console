// @vitest-environment jsdom
/**
 * FlashDialog.test.tsx — component-level tests for the popup-modal
 * wrapper around `FlashControls` (out-of-process work, 2026-09-08).
 *
 * Four groups:
 *  - Trigger gating: `canBeFlashed` decides whether a trigger renders
 *    at all, including the ticket 012-001 regression (a silent,
 *    unflashed board -- `role: null`, no `sessionError` -- must still
 *    get a trigger) now pinned at this layer instead of inside
 *    `FlashControls`, and `forceShow` bypassing the gate for an
 *    identified device.
 *  - Open/close roundtrip: clicking the trigger opens the dialog and
 *    moves focus into it; the "Close" button (and, when not
 *    in-progress, Escape/backdrop) closes it and returns focus to the
 *    trigger.
 *  - The in-flight dismissal decision: Escape and a backdrop click are
 *    suppressed while a flash is actively writing (`useFlashProgress`
 *    reports progress for this endpoint), and re-enabled the moment a
 *    `flash-result` arrives; the "Close" button always works regardless.
 *  - A basic Tab-cycling check for the focus trap.
 *
 * `FlashControls`' own release/local-hex/progress/navigation behavior
 * is exercised in `FlashControls.test.tsx`, not duplicated here.
 */
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { EndpointListEntry } from "@robot-console/host/src/wsMessages.js";
import { FlashDialog } from "./FlashDialog";
import { WsProvider } from "../ws/WsProvider";
import { FakeSocket } from "../testing/FakeSocket";
import { withRouter } from "../testing/renderWithRouter";

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

function baseDevice(overrides: Partial<EndpointListEntry> = {}): EndpointListEntry {
  return {
    endpointId: "usb-SERIAL-A",
    transport: "usb",
    resourceKey: "usb-SERIAL-A",
    classification: { type: "unknown", role: null, commonName: null, dialect: null, evidence: "none" },
    name: "zeguz",
    role: null,
    sessionOpen: false,
    usb: { serialNumber: "SERIAL-A-FULL", displaySerial: "0002", port: "/dev/cu.usbmodemA" },
    ...overrides,
  };
}

function mountFlashDialog(
  endpoint: EndpointListEntry,
  props: { forceShow?: boolean } = {},
): { el: HTMLDivElement; socket: () => FakeSocket } {
  let socket: FakeSocket | null = null;
  const el = mount(
    withRouter(
      <WsProvider url="ws://test/" socketFactory={() => (socket = new FakeSocket())}>
        <FlashDialog endpoint={endpoint} forceShow={props.forceShow ?? false} />
      </WsProvider>,
      { initialEntries: [`/d/${endpoint.endpointId}`] },
    ),
  );
  act(() => {
    socket!.emitOpen();
  });
  return { el, socket: () => socket! };
}

function trigger(el: HTMLDivElement): HTMLButtonElement | null {
  return Array.from(el.querySelectorAll("button")).find((b) => b.textContent === "Flash") ?? null;
}

function closeButton(el: HTMLDivElement): HTMLButtonElement | null {
  return Array.from(el.querySelectorAll("button")).find((b) => b.textContent === "Close") ?? null;
}

function dialog(el: HTMLDivElement): HTMLDialogElement | null {
  return el.querySelector("dialog");
}

describe("FlashDialog trigger gating", () => {
  it("offers no trigger for an identified device", () => {
    const { el } = mountFlashDialog(baseDevice({ role: "NEZHA2", sessionOpen: true }));
    expect(trigger(el)).toBeNull();
  });

  // Regression test for the bug ticket 012-001 fixed, now pinned at the
  // trigger layer: a silent, unflashed board's session opens fine and
  // `identify()` resolves `null` without throwing, so `sessionError` is
  // never set. This must still get a Flash trigger -- `canBeFlashed`
  // depends only on `role`, not `sessionError`.
  it("offers a trigger for an unprobed device (no role, no sessionError)", () => {
    const { el } = mountFlashDialog(baseDevice({ role: null }));
    expect(trigger(el)).not.toBeNull();
  });

  it("offers a trigger for a failed-identify device", () => {
    const { el } = mountFlashDialog(
      baseDevice({ role: null, sessionError: "HELLO reply timed out after 2000ms" }),
    );
    expect(trigger(el)).not.toBeNull();
  });

  it("offers no trigger for an identified device when forceShow is explicitly false", () => {
    const { el } = mountFlashDialog(baseDevice({ role: "NEZHA2", sessionOpen: true }), { forceShow: false });
    expect(trigger(el)).toBeNull();
  });

  it("offers a trigger for an identified device when forceShow is true", () => {
    const { el } = mountFlashDialog(baseDevice({ role: "NEZHA2", sessionOpen: true }), { forceShow: true });
    expect(trigger(el)).not.toBeNull();
  });

  it("shows a reflash warning inside the dialog for an identified device opened via forceShow", () => {
    const { el } = mountFlashDialog(baseDevice({ role: "NEZHA2", sessionOpen: true, name: "kivon" }), {
      forceShow: true,
    });
    act(() => {
      trigger(el)?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(el.textContent).toContain('Reflashing "kivon" will interrupt whatever it\'s currently running.');
  });

  it("shows no reflash warning for a canBeFlashed device", () => {
    const { el } = mountFlashDialog(baseDevice({ role: null }));
    act(() => {
      trigger(el)?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(el.textContent).not.toContain("will interrupt");
  });
});

describe("FlashDialog open/close roundtrip", () => {
  it("is closed initially, with no FlashControls content mounted", () => {
    const { el } = mountFlashDialog(baseDevice({ role: null }));
    expect(dialog(el)).toBeNull();
    expect(el.querySelector(".flash-controls")).toBeNull();
  });

  it("opens the dialog and mounts FlashControls when the trigger is clicked", () => {
    const { el } = mountFlashDialog(baseDevice({ role: null }));
    act(() => {
      trigger(el)?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(dialog(el)).not.toBeNull();
    expect(el.querySelector(".flash-controls")).not.toBeNull();
    expect(el.textContent).toContain("Flash relay firmware");
  });

  it("moves focus into the dialog on open", () => {
    const { el } = mountFlashDialog(baseDevice({ role: null }));
    act(() => {
      trigger(el)?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(document.activeElement).toBe(dialog(el));
  });

  it("closes the dialog and returns focus to the trigger when Close is clicked", () => {
    const { el } = mountFlashDialog(baseDevice({ role: null }));
    const triggerButton = trigger(el)!;
    act(() => {
      triggerButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    act(() => {
      closeButton(el)?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(dialog(el)).toBeNull();
    expect(el.querySelector(".flash-controls")).toBeNull();
    expect(document.activeElement).toBe(triggerButton);
  });

  it("resets to closed if the matched endpoint's id changes (AppHeader carry-over guard)", () => {
    let socket: FakeSocket | null = null;
    const deviceA = baseDevice({ endpointId: "usb-A", resourceKey: "usb-A", role: "NEZHA2", sessionOpen: true });
    const el = mount(
      withRouter(
        <WsProvider url="ws://test/" socketFactory={() => (socket = new FakeSocket())}>
          <FlashDialog endpoint={deviceA} forceShow />
        </WsProvider>,
        { initialEntries: ["/d/usb-A"] },
      ),
    );
    act(() => {
      socket!.emitOpen();
    });
    act(() => {
      trigger(el)?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(dialog(el)).not.toBeNull();

    const deviceB = baseDevice({ endpointId: "usb-B", resourceKey: "usb-B", role: "NEZHA2", sessionOpen: true });
    act(() => {
      root!.render(
        withRouter(
          <WsProvider url="ws://test/" socketFactory={() => socket!}>
            <FlashDialog endpoint={deviceB} forceShow />
          </WsProvider>,
          { initialEntries: ["/d/usb-A"] },
        ),
      );
    });

    expect(dialog(el)).toBeNull();
  });
});

describe("FlashDialog dismissal while a flash is in progress", () => {
  function openAndStartFlash(el: HTMLDivElement, socket: () => FakeSocket, endpointId: string) {
    act(() => {
      trigger(el)?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    act(() => {
      socket().emitMessage({
        type: "flash-progress",
        endpointId,
        source: { kind: "release", firmware: "relay" },
        phase: "writing",
      });
    });
  }

  it("suppresses Escape (the dialog's cancel event) while a flash is in progress", () => {
    const { el, socket } = mountFlashDialog(baseDevice({ role: null }));
    openAndStartFlash(el, socket, "usb-SERIAL-A");

    act(() => {
      dialog(el)!.dispatchEvent(new Event("cancel", { cancelable: true }));
    });
    expect(dialog(el)).not.toBeNull();
  });

  it("suppresses a backdrop click while a flash is in progress", () => {
    const { el, socket } = mountFlashDialog(baseDevice({ role: null }));
    openAndStartFlash(el, socket, "usb-SERIAL-A");

    act(() => {
      dialog(el)!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(dialog(el)).not.toBeNull();
  });

  it("still closes on an explicit Close-button click while a flash is in progress", () => {
    const { el, socket } = mountFlashDialog(baseDevice({ role: null }));
    const triggerButton = trigger(el)!;
    openAndStartFlash(el, socket, "usb-SERIAL-A");

    act(() => {
      closeButton(el)?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(dialog(el)).toBeNull();
    expect(document.activeElement).toBe(triggerButton);
  });

  it("re-enables Escape once flash-result arrives and progress clears", () => {
    const { el, socket } = mountFlashDialog(baseDevice({ role: null }));
    openAndStartFlash(el, socket, "usb-SERIAL-A");

    act(() => {
      socket().emitMessage({
        type: "flash-result",
        endpointId: "usb-SERIAL-A",
        source: { kind: "release", firmware: "relay" },
        status: "ok",
        classification: { type: "unknown", role: null, commonName: null, dialect: null, evidence: "none" },
        reidentify: "timeout",
      });
    });

    act(() => {
      dialog(el)!.dispatchEvent(new Event("cancel", { cancelable: true }));
    });
    expect(dialog(el)).toBeNull();
  });

  it("re-enables a backdrop click once flash-result arrives and progress clears", () => {
    const { el, socket } = mountFlashDialog(baseDevice({ role: null }));
    openAndStartFlash(el, socket, "usb-SERIAL-A");

    act(() => {
      socket().emitMessage({
        type: "flash-result",
        endpointId: "usb-SERIAL-A",
        source: { kind: "release", firmware: "relay" },
        status: "ok",
        classification: { type: "unknown", role: null, commonName: null, dialect: null, evidence: "none" },
        reidentify: "timeout",
      });
    });

    act(() => {
      dialog(el)!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(dialog(el)).toBeNull();
  });

  it("closes on Escape when no flash is in progress at all", () => {
    const { el } = mountFlashDialog(baseDevice({ role: null }));
    act(() => {
      trigger(el)?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    act(() => {
      dialog(el)!.dispatchEvent(new Event("cancel", { cancelable: true }));
    });
    expect(dialog(el)).toBeNull();
  });

  it("closes on a backdrop click when no flash is in progress at all", () => {
    const { el } = mountFlashDialog(baseDevice({ role: null }));
    act(() => {
      trigger(el)?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    act(() => {
      dialog(el)!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(dialog(el)).toBeNull();
  });

  it("does not close on a click that lands on dialog content, not the backdrop", () => {
    const { el } = mountFlashDialog(baseDevice({ role: null }));
    act(() => {
      trigger(el)?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const panel = el.querySelector(".flash-dialog-panel")!;
    act(() => {
      panel.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(dialog(el)).not.toBeNull();
  });
});

describe("FlashDialog focus trap", () => {
  it("cycles Tab from the last focusable element back to the first", () => {
    const { el } = mountFlashDialog(baseDevice({ role: null }));
    act(() => {
      trigger(el)?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const dialogEl = dialog(el)!;
    const focusable = Array.from(dialogEl.querySelectorAll<HTMLElement>("button, input"));
    expect(focusable.length).toBeGreaterThan(1);
    const last = focusable[focusable.length - 1]!;
    const first = focusable[0]!;
    last.focus();
    expect(document.activeElement).toBe(last);

    act(() => {
      dialogEl.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
    });
    expect(document.activeElement).toBe(first);
  });

  it("cycles Shift+Tab from the first focusable element back to the last", () => {
    const { el } = mountFlashDialog(baseDevice({ role: null }));
    act(() => {
      trigger(el)?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const dialogEl = dialog(el)!;
    const focusable = Array.from(dialogEl.querySelectorAll<HTMLElement>("button, input"));
    const last = focusable[focusable.length - 1]!;
    const first = focusable[0]!;
    first.focus();
    expect(document.activeElement).toBe(first);

    act(() => {
      dialogEl.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true }),
      );
    });
    expect(document.activeElement).toBe(last);
  });
});
