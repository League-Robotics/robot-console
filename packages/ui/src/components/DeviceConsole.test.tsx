// @vitest-environment jsdom
/**
 * DeviceConsole.test.tsx — component-level tests for the per-device
 * console (ticket 008 / SUC-002, SUC-007; rewritten against the
 * `Snapshot` contract).
 *
 * Ported from `ConsoleTab.test.tsx` (sprint 1's flat Console tab),
 * dropped down to a single fixed `link` prop instead of a device-picker
 * dropdown -- so there is no device-switching test here (nothing to
 * switch between); every other behavior in the ticket's "preserves"
 * list is re-verified against the new component: line
 * classification/rendering, autoscroll toggle, clear log, send-box
 * submission and cooldown, the no-open-link send-disabled state, and
 * the per-link line cap.
 */
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SnapshotLink } from "@robot-console/host/src/wsMessages.js";
import { DeviceConsole } from "./DeviceConsole";
import { MAX_LINES_PER_LINK, WsProvider } from "../ws/WsProvider";
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

/** See `ConsoleTab.test.tsx`'s own doc comment for why the native
 * setter is needed to drive a controlled input without a DOM-testing-
 * library helper. */
const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
  window.HTMLInputElement.prototype,
  "value",
)!.set!;

function typeInto(input: HTMLInputElement, value: string): void {
  nativeInputValueSetter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
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
  vi.useRealTimers();
});

/** Open by default (mirrors the retired fixture's `sessionOpen: true`).
 * Pass `{ session: undefined }` for the no-open-session variant --
 * `exactOptionalPropertyTypes` forbids that key existing with an
 * explicit `undefined` value on the returned object, so it is deleted
 * outright rather than spread in, exactly as `wsMessages.ts`'s own
 * present-only-when-relevant fields are handled elsewhere in this
 * codebase. */
function baseLink(
  overrides: Partial<Omit<SnapshotLink, "session">> & { session?: SnapshotLink["session"] | undefined } = {},
): SnapshotLink {
  const { session, ...rest } = overrides;
  const link: SnapshotLink = {
    id: "usb-SERIAL-A",
    transport: "usb",
    label: "USB · /dev/cu.usbmodemA",
    state: "connected",
    reason: null,
    since: 0,
    lastSeen: 0,
    nextRetryAt: null,
    session: { seq: 0, pending: 0, lastDone: null, lastDoneReason: null, robotStatus: null, functions: null },
    capabilities: { open: false, close: true, flash: true, provisionWifi: true },
    ...rest,
  };
  if ("session" in overrides) {
    if (session === undefined) {
      delete (link as { session?: unknown }).session;
    } else {
      link.session = session;
    }
  }
  return link;
}

function mountConsole(link: SnapshotLink, name = "zeguz"): { el: HTMLDivElement; socket: FakeSocket } {
  let socket: FakeSocket | null = null;
  const el = mount(
    <WsProvider url="ws://test/" socketFactory={() => (socket = new FakeSocket())}>
      <DeviceConsole link={link} name={name} />
    </WsProvider>,
  );
  act(() => {
    socket!.emitOpen();
  });
  return { el, socket: socket! };
}

// `classifyLine`'s own classification cases live in `lib/lineClass.test.ts`
// (ticket 017-007 -- moved there along with the classifier itself, out of
// `DeviceConsole.tsx`'s former local copy). Not re-tested here.

describe("DeviceConsole", () => {
  it("shows this link's log, with no device picker", () => {
    const { el } = mountConsole(baseLink(), "zeguz");

    expect(el.querySelector('[data-testid="console-device-select"]')).toBeNull();
    expect(el.textContent).toContain("No traffic yet for this device");
  });

  it("shows both tx and rx lines the host forwards, marked by direction", () => {
    const { el, socket } = mountConsole(baseLink());

    act(() => {
      socket.emitMessage({ type: "line", linkId: "usb-SERIAL-A", direction: "tx", line: "HELLO" });
      socket.emitMessage({ type: "line", linkId: "usb-SERIAL-A", direction: "rx", line: "ack HELLO" });
    });

    const txLine = el.querySelector('[data-testid="console-line-tx"]');
    const rxLine = el.querySelector('[data-testid="console-line-rx"]');
    expect(txLine?.textContent).toContain("HELLO");
    expect(rxLine?.textContent).toContain("ack HELLO");
    expect(rxLine?.className).toContain("console-line-kind-ack");
  });

  it("ignores a line for a different link", () => {
    const { el, socket } = mountConsole(baseLink());

    act(() => {
      socket.emitMessage({ type: "line", linkId: "usb-OTHER", direction: "rx", line: "not mine" });
    });

    expect(el.textContent).not.toContain("not mine");
    expect(el.textContent).toContain("No traffic yet for this device");
  });

  it("submits a typed line as an outbound tx WebSocket message for this link", () => {
    const { el, socket } = mountConsole(baseLink());

    const input = el.querySelector<HTMLInputElement>('[data-testid="console-send-input"]')!;
    const button = el.querySelector<HTMLButtonElement>('[data-testid="console-send-button"]')!;

    act(() => {
      typeInto(input, "STATUS");
    });
    act(() => {
      button.click();
    });

    expect(socket.sent).toHaveLength(1);
    expect(JSON.parse(socket.sent[0]!)).toEqual({
      type: "line",
      linkId: "usb-SERIAL-A",
      direction: "tx",
      line: "STATUS",
    });
    // The tx line only appears in the log once the host echoes it back
    // -- not echoed locally on submit.
    expect(el.querySelector('[data-testid="console-line-tx"]')).toBeNull();

    act(() => {
      socket.emitMessage({ type: "line", linkId: "usb-SERIAL-A", direction: "tx", line: "STATUS" });
    });
    expect(el.querySelector('[data-testid="console-line-tx"]')?.textContent).toContain("STATUS");
  });

  it("throttles rapid repeated submission client-side instead of firing unpaced writes", () => {
    vi.useFakeTimers();
    const { el, socket } = mountConsole(baseLink());

    const input = el.querySelector<HTMLInputElement>('[data-testid="console-send-input"]')!;
    const button = el.querySelector<HTMLButtonElement>('[data-testid="console-send-button"]')!;

    act(() => {
      typeInto(input, "HELLO");
    });
    act(() => {
      button.click();
    });
    expect(socket.sent).toHaveLength(1);
    expect(input.disabled).toBe(true);

    act(() => {
      button.click();
    });
    expect(socket.sent).toHaveLength(1);

    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(input.disabled).toBe(false);

    act(() => {
      typeInto(input, "STATUS");
    });
    act(() => {
      button.click();
    });
    expect(socket.sent).toHaveLength(2);
  });

  it("disables sending with a clear reason when this link has no open session", () => {
    const { el } = mountConsole(baseLink({ session: undefined }), "zeguz");

    const input = el.querySelector<HTMLInputElement>('[data-testid="console-send-input"]')!;
    const button = el.querySelector<HTMLButtonElement>('[data-testid="console-send-button"]')!;

    expect(input.disabled).toBe(true);
    expect(button.disabled).toBe(true);
    expect(el.textContent).toContain("No link open to zeguz");
    expect(el.querySelector(".console-link-button")).not.toBeNull();
  });

  it("sends session-open when the 'open a link' hint is clicked", () => {
    const { el, socket } = mountConsole(baseLink({ session: undefined }));

    const openButton = el.querySelector<HTMLButtonElement>(".console-link-button")!;
    act(() => {
      openButton.click();
    });

    expect(socket.sent).toEqual([
      JSON.stringify({ type: "session-open", linkId: "usb-SERIAL-A" }),
    ]);
  });

  it("clears this link's log", () => {
    const { el, socket } = mountConsole(baseLink());

    act(() => {
      socket.emitMessage({ type: "line", linkId: "usb-SERIAL-A", direction: "rx", line: "line-a" });
    });
    expect(el.textContent).toContain("line-a");

    const clearButton = Array.from(el.querySelectorAll("button")).find(
      (b) => b.textContent === "Clear log",
    )!;
    act(() => {
      clearButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(el.textContent).not.toContain("line-a");
  });

  it("caps retained lines per link at MAX_LINES_PER_LINK, dropping the oldest", () => {
    const { el, socket } = mountConsole(baseLink());

    act(() => {
      for (let i = 0; i < MAX_LINES_PER_LINK + 5; i++) {
        socket.emitMessage({ type: "line", linkId: "usb-SERIAL-A", direction: "rx", line: `n${i}` });
      }
    });

    const lines = el.querySelectorAll('[data-testid="console-line-rx"]');
    expect(lines.length).toBe(MAX_LINES_PER_LINK);
    expect(lines[0]?.textContent).toContain("n5");
    expect(lines[0]?.textContent).not.toContain("n0");
    expect(lines[lines.length - 1]?.textContent).toContain(`n${MAX_LINES_PER_LINK + 4}`);
  });

  it("toggles the autoscroll pause control", () => {
    const { el } = mountConsole(baseLink());

    const toggle = Array.from(el.querySelectorAll("button")).find(
      (b) => b.textContent === "Pause autoscroll",
    )!;
    expect(toggle).toBeDefined();
    act(() => {
      toggle.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(el.textContent).toContain("Resume autoscroll");
  });

  it("shows no drive-specific motor/wheel controls", () => {
    const { el } = mountConsole(baseLink());
    expect(el.textContent).not.toMatch(/WHEELS_X|WHEELS_V/);
  });

  describe("status-poll traffic hidden by default (added out-of-process, 2026-09-09)", () => {
    it("hides a poll-origin line by default while still showing ordinary traffic", () => {
      const { el, socket } = mountConsole(baseLink());

      act(() => {
        socket.emitMessage({
          type: "line",
          linkId: "usb-SERIAL-A",
          direction: "rx",
          line: "status ready=1",
          origin: "poll",
        });
        socket.emitMessage({
          type: "line",
          linkId: "usb-SERIAL-A",
          direction: "rx",
          line: "ack HELLO",
        });
      });

      expect(el.textContent).not.toContain("status ready=1");
      expect(el.textContent).toContain("ack HELLO");
      expect(el.querySelectorAll('[data-testid="console-line-rx"]').length).toBe(1);
    });

    it("shows poll-origin lines, muted, once the toggle is checked", () => {
      const { el, socket } = mountConsole(baseLink());

      act(() => {
        socket.emitMessage({
          type: "line",
          linkId: "usb-SERIAL-A",
          direction: "rx",
          line: "status ready=1",
          origin: "poll",
        });
      });
      expect(el.textContent).not.toContain("status ready=1");

      const toggle = el.querySelector<HTMLInputElement>('[data-testid="console-show-polls"]')!;
      act(() => {
        toggle.click();
      });

      expect(el.textContent).toContain("status ready=1");
      const pollLine = el.querySelector('[data-origin-poll="true"]');
      expect(pollLine).not.toBeNull();
      expect(pollLine!.className).toContain("console-line-origin-poll");

      // Toggling back off hides it again -- the entry is never removed
      // from the underlying log, only from this render pass.
      act(() => {
        toggle.click();
      });
      expect(el.textContent).not.toContain("status ready=1");
    });

    it("leaves non-poll lines completely unaffected by the toggle", () => {
      const { el, socket } = mountConsole(baseLink());

      act(() => {
        socket.emitMessage({ type: "line", linkId: "usb-SERIAL-A", direction: "rx", line: "ack HELLO" });
      });
      const toggle = el.querySelector<HTMLInputElement>('[data-testid="console-show-polls"]')!;

      expect(el.textContent).toContain("ack HELLO");
      act(() => {
        toggle.click();
      });
      expect(el.textContent).toContain("ack HELLO");
      const line = el.querySelector('[data-testid="console-line-rx"]')!;
      expect(line.className).not.toContain("console-line-origin-poll");
    });
  });

  describe("host notice messages (ticket 012-003)", () => {
    it("renders a link-scoped host notice in this link's log with the error kind styling, distinct from ordinary rx traffic", () => {
      const { el, socket } = mountConsole(baseLink());

      act(() => {
        // Plain text with no "err"/"nack" prefix -- `classifyLine` alone
        // would classify this as ordinary `data`, indistinguishable from
        // a device reply. The point of this ticket is that it isn't.
        socket.emitMessage({
          type: "notice",
          level: "error",
          linkId: "usb-SERIAL-A",
          text: "device usb-SERIAL-A has no open link",
          at: 0,
          seq: 1,
        });
      });

      const rxLines = el.querySelectorAll('[data-testid="console-line-rx"]');
      expect(rxLines).toHaveLength(1);
      const errorLine = rxLines[0]!;
      expect(errorLine.textContent).toContain("device usb-SERIAL-A has no open link");
      expect(errorLine.className).toContain("console-line-kind-error");
      expect(errorLine.getAttribute("data-host-error")).toBe("true");
    });

    it("does not attach a host notice meant for a different link to this link's log", () => {
      const { el, socket } = mountConsole(baseLink());

      act(() => {
        socket.emitMessage({ type: "notice", level: "warn", linkId: "usb-OTHER", text: "not mine", at: 0, seq: 1 });
      });

      expect(el.textContent).not.toContain("not mine");
      expect(el.textContent).toContain("No traffic yet for this device");
    });

    it("distinguishes a host notice from a device-classified err/nack line: both get error styling, only the host one is flagged data-host-error", () => {
      const { el, socket } = mountConsole(baseLink());

      act(() => {
        socket.emitMessage({ type: "line", linkId: "usb-SERIAL-A", direction: "rx", line: "err 3 bad-arg" });
        socket.emitMessage({
          type: "notice",
          level: "error",
          linkId: "usb-SERIAL-A",
          text: '"HELLO" cannot be sent as a live command',
          at: 0,
          seq: 1,
        });
      });

      const rxLines = el.querySelectorAll('[data-testid="console-line-rx"]');
      expect(rxLines).toHaveLength(2);
      for (const line of rxLines) {
        expect(line.className).toContain("console-line-kind-error");
      }
      expect(rxLines[0]!.getAttribute("data-host-error")).toBeNull();
      expect(rxLines[1]!.getAttribute("data-host-error")).toBe("true");
    });
  });

  describe("ticket 018-018: the log is the only flexible row, floored at 8rem, so the send row never gets squeezed off screen", () => {
    it("renders the log and the send form as the elements RobotPage.css's/DeviceConsole.css's viewport-bound column rules target, send last so nothing renders after it that could push it down", () => {
      const { el } = mountConsole(baseLink());
      const log = el.querySelector('[data-testid="console-log"]')!;
      expect(log.classList.contains("console-log")).toBe(true);
      const send = el.querySelector('[data-testid="console-send-input"]')!.closest("form")!;
      expect(send.classList.contains("console-send")).toBe(true);
      expect(el.querySelector(".device-console")!.lastElementChild).toBe(send);
      // The log precedes the send form -- `.console-log`'s `flex: 1`
      // fills whatever room is left above the (flex: none) send row,
      // rather than the two competing in the other order.
      expect(log.compareDocumentPosition(send) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });
  });
});
