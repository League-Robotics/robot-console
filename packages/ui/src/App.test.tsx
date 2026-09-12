// @vitest-environment jsdom
/**
 * App.test.tsx — app-shell integration tests for the disconnected-from-
 * host banner and the send-capable-control disable/no-silent-drop
 * behavior (sprint 015 ticket 009, UC-020;
 * `no-disconnected-from-host-banner-in-the-ui.md`).
 *
 * `AppHeader.test.tsx` already covers the banner's own text/visibility
 * in isolation; this file proves the same connection state actually
 * reaches a mounted `RobotPage` route (disabling its send-capable
 * controls, and routing a send attempted anyway into the link's own
 * console log instead of a silent drop) -- the two acceptance criteria
 * this ticket's own Description calls "every send-capable control
 * disabled" and "send() reports a host-style console line".
 *
 * Mounts `AppHeader` + `AppRoutes` under `WsProvider`/`MemoryRouter`
 * exactly as `App.tsx` composes them (its own `<BrowserRouter>` has no
 * seam for a test to inject an initial path or a `FakeSocket`, so this
 * file reproduces the same tree with `withRouter` instead of rendering
 * `App` itself).
 */
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Snapshot, SnapshotDevice, SnapshotLink } from "@robot-console/host/src/wsMessages.js";
import { AppHeader } from "./components/AppHeader";
import { AppRoutes } from "./router";
import { WsProvider, useWsActions } from "./ws/WsProvider";
import { FakeSocket } from "./testing/FakeSocket";
import { withRouter } from "./testing/renderWithRouter";

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
  vi.useRealTimers();
});

const ROBOT_LINK_ID = "usb-ROBOT-A";

function robotLink(overrides: Partial<SnapshotLink> = {}): SnapshotLink {
  return {
    id: ROBOT_LINK_ID,
    transport: "usb",
    label: "USB · /dev/cu.usbmodemA",
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

/** A tiny harness mounted alongside the app shell so a test can invoke
 * `useWsActions().send`/`sendCommand` directly -- exercising "what
 * happens when a send is attempted while disconnected" without relying
 * on clicking a UI control that this same ticket disables (a real
 * browser, and jsdom, both refuse to dispatch a click on a `disabled`
 * button, so a disabled control can never be the thing that proves this
 * path fires). Mirrors `RotationCalibrationWizard.test.tsx`'s identical
 * `ClearLogButton` harness pattern. */
function RawSendButton({ linkId }: { linkId: string }) {
  const { sendCommand } = useWsActions();
  return (
    <button type="button" data-testid="test-raw-send" onClick={() => sendCommand(linkId, "STATUS")}>
      raw send
    </button>
  );
}

function mountApp(initialPath: string): { el: HTMLDivElement; socket: () => FakeSocket } {
  let socket: FakeSocket | null = null;
  const el = mount(
    withRouter(
      <WsProvider url="ws://test/" socketFactory={() => (socket = new FakeSocket())}>
        <AppHeader />
        <AppRoutes />
        <RawSendButton linkId={ROBOT_LINK_ID} />
      </WsProvider>,
      { initialEntries: [initialPath] },
    ),
  );
  return { el, socket: () => socket! };
}

function banner(el: HTMLDivElement): string | null {
  return el.querySelector('[data-testid="disconnected-banner"]')?.textContent ?? null;
}

describe("App shell: disconnected-from-host banner reaches a mounted RobotPage route", () => {
  it("shows the connecting banner before the socket ever opens", () => {
    const { el } = mountApp(`/d/${ROBOT_LINK_ID}`);
    expect(banner(el)).toBe("Connecting to the host…");
  });

  it("hides the banner as soon as the socket opens on a first-ever connect (never 'stale' with nothing closed yet)", () => {
    const { el, socket } = mountApp(`/d/${ROBOT_LINK_ID}`);
    act(() => {
      socket().emitOpen();
    });
    // No snapshot needed to clear it here -- `stale` only ever flips
    // true on a close (`WsProvider`'s own doc comment), and this
    // connection has never dropped, so `status === "open"` alone is
    // enough. `DevicePage.tsx`'s own "Looking for this device…" state
    // covers the separate "no snapshot yet" gap.
    expect(banner(el)).toBeNull();
  });

  it("re-shows the banner and disables RobotPage's send-capable controls when the socket closes", () => {
    const { el, socket } = mountApp(`/d/${ROBOT_LINK_ID}`);
    act(() => {
      socket().emitOpen();
    });
    act(() => {
      socket().emitMessage(snapshot({ devices: [robotDevice()] }));
    });
    expect(banner(el)).toBeNull();
    // Enabled while connected with an open session.
    expect(el.querySelector<HTMLButtonElement>('[data-testid="drive-forward"]')!.disabled).toBe(false);
    expect(el.querySelector<HTMLButtonElement>('[data-testid="command-strip-hello"]')!.disabled).toBe(false);

    act(() => {
      socket().close();
    });

    expect(banner(el)).toBe("Disconnected from the host — reconnecting…");
    // Every send-capable control this ticket touches disables, even
    // though the link's own `session` field is untouched by a socket
    // drop (WsProvider deliberately never clears it) -- see
    // `useSendable`'s own doc comment.
    expect(el.querySelector<HTMLButtonElement>('[data-testid="drive-forward"]')!.disabled).toBe(true);
    expect(el.querySelector<HTMLButtonElement>('[data-testid="command-strip-hello"]')!.disabled).toBe(true);
    expect(el.querySelector<HTMLButtonElement>('[data-testid="command-strip-status"]')!.disabled).toBe(true);
    expect(el.querySelector<HTMLInputElement>('[data-testid="console-send-input"]')!.disabled).toBe(true);
  });

  it("re-enables controls only once the socket has actually reconnected and a fresh snapshot confirms the link is still connected", () => {
    vi.useFakeTimers();
    const { el, socket } = mountApp(`/d/${ROBOT_LINK_ID}`);
    act(() => {
      socket().emitOpen();
    });
    act(() => {
      socket().emitMessage(snapshot({ devices: [robotDevice()] }));
    });
    act(() => {
      socket().close();
    });
    expect(el.querySelector<HTMLButtonElement>('[data-testid="drive-forward"]')!.disabled).toBe(true);

    // WsProvider's own reconnect timer (RECONNECT_DELAY_MS) fires, minting
    // a fresh socket -- `socket()` re-reads the outer variable the
    // `socketFactory` closure reassigned. The reconnect's own "open"
    // event lands before a fresh snapshot does -- `stale` alone must
    // keep controls disabled through that gap.
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    act(() => {
      socket().emitOpen();
    });
    expect(banner(el)).toBe("Reconnected — waiting for the latest state…");
    expect(el.querySelector<HTMLButtonElement>('[data-testid="drive-forward"]')!.disabled).toBe(true);

    act(() => {
      socket().emitMessage(snapshot({ devices: [robotDevice()] }));
    });
    expect(banner(el)).toBeNull();
    expect(el.querySelector<HTMLButtonElement>('[data-testid="drive-forward"]')!.disabled).toBe(false);
  });

  it("a send attempted while disconnected reports a host-style console line instead of dropping silently", () => {
    const { el, socket } = mountApp(`/d/${ROBOT_LINK_ID}`);
    act(() => {
      socket().emitOpen();
    });
    act(() => {
      socket().emitMessage(snapshot({ devices: [robotDevice()] }));
    });
    act(() => {
      socket().close();
    });
    expect(socket().sent).toEqual([]);

    act(() => {
      el.querySelector<HTMLButtonElement>('[data-testid="test-raw-send"]')!.click();
    });

    expect(socket().sent).toEqual([]);
    const log = el.querySelector('[data-testid="console-log"]')!;
    expect(log.textContent).toContain("Not sent -- no connection to the host.");
    expect(log.querySelector('[data-host-error="true"]')).not.toBeNull();
  });
});
