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
import { act, type ReactElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { FirmwareKind, SnapshotLink } from "@robot-console/host/src/wsMessages.js";
import { FlashDialog } from "./FlashDialog";
import { ALL_FLASHABLE_FIRMWARE } from "../deviceDisplay";
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

function baseLink(overrides: Partial<SnapshotLink> = {}): SnapshotLink {
  return {
    id: "usb-SERIAL-A",
    transport: "usb",
    label: "USB · /dev/cu.usbmodemA",
    state: "connectable",
    reason: null,
    since: 0,
    lastSeen: 0,
    nextRetryAt: null,
    capabilities: { open: true, close: false, flash: true, provisionWifi: false },
    ...overrides,
  };
}

function mountFlashDialog(
  link: SnapshotLink,
  props: {
    forceShow?: boolean;
    name?: string;
    triggerIcon?: ReactNode;
    allowedFirmware?: readonly FirmwareKind[];
    allowLocalHex?: boolean;
  } = {},
): { el: HTMLDivElement; socket: () => FakeSocket } {
  let socket: FakeSocket | null = null;
  const el = mount(
    withRouter(
      <WsProvider url="ws://test/" socketFactory={() => (socket = new FakeSocket())}>
        <FlashDialog
          link={link}
          name={props.name ?? "zeguz"}
          forceShow={props.forceShow ?? false}
          triggerIcon={props.triggerIcon}
          allowedFirmware={props.allowedFirmware ?? ALL_FLASHABLE_FIRMWARE}
          allowLocalHex={props.allowLocalHex ?? true}
        />
      </WsProvider>,
      { initialEntries: [`/d/${link.id}`] },
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
  it("offers no trigger for an identified device (link.capabilities.flash false)", () => {
    const { el } = mountFlashDialog(baseLink({ state: "connected", capabilities: { open: false, close: true, flash: false, provisionWifi: true } }));
    expect(trigger(el)).toBeNull();
  });

  // Regression test for the bug ticket 012-001 fixed, now pinned at the
  // trigger layer: a silent, unflashed board's session opens fine and
  // `identify()` resolves `null` without throwing, so no failure state
  // is ever set. This must still get a Flash trigger --
  // `canBeFlashed` depends only on `link.capabilities.flash`, not on
  // whether the link failed.
  it("offers a trigger for an unprobed link (connectable, capabilities.flash true)", () => {
    const { el } = mountFlashDialog(baseLink());
    expect(trigger(el)).not.toBeNull();
  });

  it("offers a trigger for a failed-identify link", () => {
    const { el } = mountFlashDialog(baseLink({ state: "failed", reason: "HELLO reply timed out after 2000ms" }));
    expect(trigger(el)).not.toBeNull();
  });

  it("offers no trigger for an identified device when forceShow is explicitly false", () => {
    const { el } = mountFlashDialog(
      baseLink({ state: "connected", capabilities: { open: false, close: true, flash: false, provisionWifi: true } }),
      { forceShow: false },
    );
    expect(trigger(el)).toBeNull();
  });

  it("offers a trigger for an identified device when forceShow is true", () => {
    const { el } = mountFlashDialog(
      baseLink({ state: "connected", capabilities: { open: false, close: true, flash: false, provisionWifi: true } }),
      { forceShow: true },
    );
    expect(trigger(el)).not.toBeNull();
  });

  it("shows a reflash warning inside the dialog for an identified device opened via forceShow", () => {
    const { el } = mountFlashDialog(
      baseLink({ state: "connected", capabilities: { open: false, close: true, flash: false, provisionWifi: true } }),
      { forceShow: true, name: "kivon" },
    );
    act(() => {
      trigger(el)?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(el.textContent).toContain('Reflashing "kivon" will interrupt whatever it\'s currently running.');
  });

  it("shows no reflash warning for a canBeFlashed device", () => {
    const { el } = mountFlashDialog(baseLink());
    act(() => {
      trigger(el)?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(el.textContent).not.toContain("will interrupt");
  });
});

// Ticket 018-015: the front-page lightning Flash button passes
// `triggerIcon` instead of relying on the default text label -- these
// pin that the icon replaces the text, the accessible name/tooltip
// switch to "Flash <name>" (an icon has no text of its own to
// announce), and the dialog still opens normally.
describe("FlashDialog icon trigger (triggerIcon, ticket 018-015)", () => {
  function iconTrigger(el: HTMLDivElement): HTMLButtonElement | null {
    return el.querySelector("button[aria-haspopup='dialog']");
  }

  it("renders the icon instead of the text label, with an accessible 'Flash <name>' name and matching title", () => {
    const { el } = mountFlashDialog(baseLink(), { name: "vevov", triggerIcon: <svg data-testid="bolt" /> });
    const button = iconTrigger(el)!;
    expect(button.textContent).toBe("");
    expect(button.querySelector('[data-testid="bolt"]')).not.toBeNull();
    expect(button.getAttribute("aria-label")).toBe("Flash vevov");
    expect(button.getAttribute("title")).toBe("Flash vevov");
  });

  it("still gates on canBeFlashed and useSendable exactly like the text trigger", () => {
    const { el } = mountFlashDialog(
      baseLink({ capabilities: { open: false, close: true, flash: false, provisionWifi: true } }),
      { triggerIcon: <svg /> },
    );
    expect(iconTrigger(el)).toBeNull();
  });

  it("opens the same dialog (relay/robot/local-hex sources) when the icon trigger is clicked", () => {
    const { el } = mountFlashDialog(baseLink(), { name: "vevov", triggerIcon: <svg /> });
    act(() => {
      iconTrigger(el)?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(el.textContent).toContain("Flash vevov");
    expect(el.textContent).toContain("Flash relay firmware");
    expect(el.textContent).toContain("Flash robot firmware");
    expect(el.textContent).toContain("Flash a hex file from disk");
  });

  it("disables the icon trigger once the socket closes, same as the text trigger", () => {
    const { el, socket } = mountFlashDialog(baseLink(), { triggerIcon: <svg /> });
    expect(iconTrigger(el)!.disabled).toBe(false);
    act(() => {
      socket().close();
    });
    expect(iconTrigger(el)!.disabled).toBe(true);
    expect(iconTrigger(el)!.getAttribute("title")).toBe("Disconnected from the host");
  });
});

// Sprint 023 ticket 004: `FlashDialog` has no opinion of its own about
// which firmware/local-hex options to offer -- it forwards both props
// straight through to `FlashControls`, which is exercised in more
// detail in `FlashControls.test.tsx`. These pin only the pass-through.
describe("FlashDialog allowedFirmware/allowLocalHex pass-through (sprint 023 ticket 004)", () => {
  it("forwards a narrowed allowedFirmware to FlashControls (exactly one button)", () => {
    const { el } = mountFlashDialog(baseLink(), { allowedFirmware: ["robot"], allowLocalHex: false });
    act(() => {
      trigger(el)?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(el.textContent).toContain("Flash robot firmware");
    expect(el.textContent).not.toContain("Flash relay firmware");
    expect(el.textContent).not.toContain("Flash joystick firmware");
    expect(el.textContent).not.toContain("Flash a hex file from disk");
  });

  it("forwards allowLocalHex=false so no local-hex section renders", () => {
    const { el } = mountFlashDialog(baseLink(), { allowedFirmware: ["relay"], allowLocalHex: false });
    act(() => {
      trigger(el)?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(el.querySelector('[data-testid="local-hex-file-input"]')).toBeNull();
  });

  it("forwards the full permissive set with allowLocalHex=true (today's default call sites)", () => {
    const { el } = mountFlashDialog(baseLink());
    act(() => {
      trigger(el)?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(el.textContent).toContain("Flash relay firmware");
    expect(el.textContent).toContain("Flash robot firmware");
    expect(el.textContent).toContain("Flash joystick firmware");
    expect(el.textContent).toContain("Flash a hex file from disk");
  });
});

describe("FlashDialog open/close roundtrip", () => {
  it("is closed initially, with no FlashControls content mounted", () => {
    const { el } = mountFlashDialog(baseLink());
    expect(dialog(el)).toBeNull();
    expect(el.querySelector(".flash-controls")).toBeNull();
  });

  it("opens the dialog and mounts FlashControls when the trigger is clicked", () => {
    const { el } = mountFlashDialog(baseLink());
    act(() => {
      trigger(el)?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(dialog(el)).not.toBeNull();
    expect(el.querySelector(".flash-controls")).not.toBeNull();
    expect(el.textContent).toContain("Flash relay firmware");
  });

  it("moves focus into the dialog on open", () => {
    const { el } = mountFlashDialog(baseLink());
    act(() => {
      trigger(el)?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(document.activeElement).toBe(dialog(el));
  });

  it("closes the dialog and returns focus to the trigger when Close is clicked", () => {
    const { el } = mountFlashDialog(baseLink());
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

  it("resets to closed if the matched link's id changes (AppHeader carry-over guard)", () => {
    let socket: FakeSocket | null = null;
    const identified = { open: false, close: true, flash: false, provisionWifi: true };
    const linkA = baseLink({ id: "usb-A", state: "connected", capabilities: identified });
    const el = mount(
      withRouter(
        <WsProvider url="ws://test/" socketFactory={() => (socket = new FakeSocket())}>
          <FlashDialog link={linkA} name="zeguz" forceShow allowedFirmware={ALL_FLASHABLE_FIRMWARE} allowLocalHex={true} />
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

    const linkB = baseLink({ id: "usb-B", state: "connected", capabilities: identified });
    act(() => {
      root!.render(
        withRouter(
          <WsProvider url="ws://test/" socketFactory={() => socket!}>
            <FlashDialog link={linkB} name="zeguz" forceShow allowedFirmware={ALL_FLASHABLE_FIRMWARE} allowLocalHex={true} />
          </WsProvider>,
          { initialEntries: ["/d/usb-A"] },
        ),
      );
    });

    expect(dialog(el)).toBeNull();
  });
});

describe("FlashDialog dismissal while a flash is in progress", () => {
  function openAndStartFlash(el: HTMLDivElement, socket: () => FakeSocket, linkId: string) {
    act(() => {
      trigger(el)?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    act(() => {
      socket().emitMessage({
        type: "flash-progress",
        linkId,
        source: { kind: "release", firmware: "relay" },
        phase: "writing",
        seq: 1,
      });
    });
  }

  it("suppresses Escape (the dialog's cancel event) while a flash is in progress", () => {
    const { el, socket } = mountFlashDialog(baseLink());
    openAndStartFlash(el, socket, "usb-SERIAL-A");

    act(() => {
      dialog(el)!.dispatchEvent(new Event("cancel", { cancelable: true }));
    });
    expect(dialog(el)).not.toBeNull();
  });

  it("suppresses a backdrop click while a flash is in progress", () => {
    const { el, socket } = mountFlashDialog(baseLink());
    openAndStartFlash(el, socket, "usb-SERIAL-A");

    act(() => {
      dialog(el)!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(dialog(el)).not.toBeNull();
  });

  it("still closes on an explicit Close-button click while a flash is in progress", () => {
    const { el, socket } = mountFlashDialog(baseLink());
    const triggerButton = trigger(el)!;
    openAndStartFlash(el, socket, "usb-SERIAL-A");

    act(() => {
      closeButton(el)?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(dialog(el)).toBeNull();
    expect(document.activeElement).toBe(triggerButton);
  });

  it("re-enables Escape once flash-result arrives and progress clears", () => {
    const { el, socket } = mountFlashDialog(baseLink());
    openAndStartFlash(el, socket, "usb-SERIAL-A");

    act(() => {
      socket().emitMessage({
        type: "flash-result",
        linkId: "usb-SERIAL-A",
        source: { kind: "release", firmware: "relay" },
        status: "ok",
        reidentify: "timeout",
        seq: 2,
      });
    });

    act(() => {
      dialog(el)!.dispatchEvent(new Event("cancel", { cancelable: true }));
    });
    expect(dialog(el)).toBeNull();
  });

  it("re-enables a backdrop click once flash-result arrives and progress clears", () => {
    const { el, socket } = mountFlashDialog(baseLink());
    openAndStartFlash(el, socket, "usb-SERIAL-A");

    act(() => {
      socket().emitMessage({
        type: "flash-result",
        linkId: "usb-SERIAL-A",
        source: { kind: "release", firmware: "relay" },
        status: "ok",
        reidentify: "timeout",
        seq: 2,
      });
    });

    act(() => {
      dialog(el)!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(dialog(el)).toBeNull();
  });

  it("closes on Escape when no flash is in progress at all", () => {
    const { el } = mountFlashDialog(baseLink());
    act(() => {
      trigger(el)?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    act(() => {
      dialog(el)!.dispatchEvent(new Event("cancel", { cancelable: true }));
    });
    expect(dialog(el)).toBeNull();
  });

  it("closes on a backdrop click when no flash is in progress at all", () => {
    const { el } = mountFlashDialog(baseLink());
    act(() => {
      trigger(el)?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    act(() => {
      dialog(el)!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(dialog(el)).toBeNull();
  });

  it("does not close on a click that lands on dialog content, not the backdrop", () => {
    const { el } = mountFlashDialog(baseLink());
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
    const { el } = mountFlashDialog(baseLink());
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
    const { el } = mountFlashDialog(baseLink());
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
