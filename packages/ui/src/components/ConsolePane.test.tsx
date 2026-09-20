// @vitest-environment jsdom
/**
 * ConsolePane.test.tsx — the console never grows the page.
 *
 * The property under test is arithmetic, not appearance: the pane caps
 * itself at whatever is left between its own top edge and the bottom of
 * the window. That is what makes it correct on a page it has never seen
 * and under panels that were added after it, which the constants in
 * `RobotPage.css` could not be.
 */
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConsolePane } from "./ConsolePane";
import { WsProvider } from "../ws/WsProvider";
import { FakeSocket } from "../testing/FakeSocket";
import type { SnapshotLink } from "@robot-console/host/src/wsMessages.js";

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

/** jsdom gives every element a zero rect, so the pane's own top edge is
 * stubbed to put it part-way down a window of a known height. */
function placeTopAt(px: number): void {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    top: px,
    bottom: 0,
    left: 0,
    right: 0,
    width: 0,
    height: 0,
    x: 0,
    y: px,
    toJSON: () => ({}),
  } as DOMRect);
}

beforeEach(() => {
  window.innerHeight = 800;
});

afterEach(() => {
  vi.restoreAllMocks();
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

function paneOf(el: HTMLDivElement): HTMLElement {
  return el.querySelector<HTMLElement>('[data-testid="console-pane"]')!;
}

describe("ConsolePane", () => {
  it("takes the space between its own top edge and the bottom of the window", () => {
    placeTopAt(300);
    const el = mount(
      <WsProvider url="ws://test/" socketFactory={() => new FakeSocket()}>
        <ConsolePane link={link} name="tigez" />
      </WsProvider>,
    );
    // 800 viewport - 300 top - 16 bottom gap.
    expect(paneOf(el).style.maxHeight).toBe("484px");
  });

  it("starts lower on the page when panels sit above it, and takes correspondingly less", () => {
    // The Calibration tab's own case: a firmware panel and the guided
    // run now sit above the console, so it begins further down. No rule
    // anywhere had to be told this.
    placeTopAt(520);
    const el = mount(
      <WsProvider url="ws://test/" socketFactory={() => new FakeSocket()}>
        <ConsolePane link={link} name="tigez" />
      </WsProvider>,
    );
    expect(paneOf(el).style.maxHeight).toBe("264px");
  });

  it("never collapses below its floor, even when there is no room left at all", () => {
    // A short window, or a column so full that nothing is left. The
    // page scrolls instead of leaving an unreadable console with an
    // unreachable send line.
    placeTopAt(790);
    const el = mount(
      <WsProvider url="ws://test/" socketFactory={() => new FakeSocket()}>
        <ConsolePane link={link} name="tigez" />
      </WsProvider>,
    );
    expect(paneOf(el).style.maxHeight).toBe("220px");
  });

  it("re-measures when the window is resized", () => {
    placeTopAt(300);
    const el = mount(
      <WsProvider url="ws://test/" socketFactory={() => new FakeSocket()}>
        <ConsolePane link={link} name="tigez" />
      </WsProvider>,
    );
    expect(paneOf(el).style.maxHeight).toBe("484px");

    act(() => {
      window.innerHeight = 600;
      window.dispatchEvent(new Event("resize"));
    });
    expect(paneOf(el).style.maxHeight).toBe("284px");
  });

  it("still mounts the console itself", () => {
    placeTopAt(300);
    const el = mount(
      <WsProvider url="ws://test/" socketFactory={() => new FakeSocket()}>
        <ConsolePane link={link} name="tigez" />
      </WsProvider>,
    );
    expect(el.querySelector('[aria-label="Console"]')).not.toBeNull();
  });
});
