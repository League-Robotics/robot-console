// @vitest-environment jsdom
/**
 * AppHeader.test.tsx — component-level tests for the route-aware app
 * header (ticket 012-004, SUC-003/SUC-004; Flash entry reworked into a
 * popup-modal trigger by out-of-process work, 2026-09-08).
 *
 * Covers the back-to-devices link across `/` and all five
 * `/d/:endpointId` states (loading, not-connected, relay, robot,
 * unknown), and the Flash trigger's presence and (for an identified
 * device) the in-dialog reflash warning that replaced the old
 * `window.confirm()` step. `FlashControls`' own release/local-hex/
 * progress behavior is exercised in `FlashControls.test.tsx`, and
 * `FlashDialog`'s own gating/dismissal/focus behavior in
 * `FlashDialog.test.tsx` -- neither is duplicated here. This file only
 * proves `AppHeader` decides *when* to offer the trigger, and passes
 * `forceShow` so it's offered for an identified device too.
 */
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EndpointListEntry } from "@robot-console/host/src/wsMessages.js";
import { AppHeader } from "./AppHeader";
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
  vi.restoreAllMocks();
});

function endpoint(overrides: Partial<EndpointListEntry> = {}): EndpointListEntry {
  return {
    endpointId: "usb-SERIAL-A",
    transport: "usb",
    resourceKey: "usb-SERIAL-A",
    classification: { type: "unknown", role: null, commonName: null, dialect: null, evidence: "none", program: null, version: null },
    name: "zeguz",
    role: null,
    sessionOpen: false,
    usb: { serialNumber: "SERIAL-A-FULL", displaySerial: "0002", port: "/dev/cu.usbmodemA" },
    ...overrides,
  };
}

function mountAt(
  initialPath: string,
  options: { snapshot?: EndpointListEntry[] } = {},
): { el: HTMLDivElement; socket: () => FakeSocket } {
  let socket: FakeSocket | null = null;
  const el = mount(
    withRouter(
      <WsProvider url="ws://test/" socketFactory={() => (socket = new FakeSocket())}>
        <AppHeader />
      </WsProvider>,
      { initialEntries: [initialPath] },
    ),
  );
  act(() => {
    socket!.emitOpen();
  });
  if (options.snapshot) {
    act(() => {
      socket!.emitMessage({ type: "endpoints", endpoints: options.snapshot });
    });
  }
  return { el, socket: () => socket! };
}

function backLink(el: HTMLDivElement): HTMLAnchorElement | null {
  return el.querySelector("a");
}

function flashButton(el: HTMLDivElement): HTMLButtonElement | null {
  return Array.from(el.querySelectorAll("button")).find((b) => b.textContent === "Flash") ?? null;
}

describe("AppHeader back-to-devices link", () => {
  it("renders no back link on /", () => {
    const { el } = mountAt("/");
    expect(backLink(el)).toBeNull();
  });

  it("renders exactly one back link, with an accessible name, in the loading state (!hasSnapshot)", () => {
    const { el } = mountAt("/d/usb-SERIAL-A");
    const links = el.querySelectorAll("a");
    expect(links).toHaveLength(1);
    expect(links[0]?.getAttribute("href")).toBe("/");
    expect(links[0]?.textContent).toBe("Back to devices");
  });

  it("renders exactly one back link in the not-connected state", () => {
    const { el } = mountAt("/d/usb-MISSING", { snapshot: [endpoint()] });
    const links = el.querySelectorAll("a");
    expect(links).toHaveLength(1);
    expect(links[0]?.getAttribute("href")).toBe("/");
  });

  it("renders exactly one back link on a relay device page", () => {
    const { el } = mountAt("/d/usb-RELAY-A", {
      snapshot: [
        endpoint({
          endpointId: "usb-RELAY-A",
          resourceKey: "usb-RELAY-A",
          classification: { type: "relay", role: "RADIORELAY", commonName: "relay", dialect: "space", evidence: "role", program: null, version: null },
          role: "RADIORELAY",
          sessionOpen: true,
        }),
      ],
    });
    const links = el.querySelectorAll("a");
    expect(links).toHaveLength(1);
    expect(links[0]?.getAttribute("href")).toBe("/");
  });

  it("renders exactly one back link on a robot device page", () => {
    const { el } = mountAt("/d/usb-ROBOT-A", {
      snapshot: [
        endpoint({
          endpointId: "usb-ROBOT-A",
          resourceKey: "usb-ROBOT-A",
          classification: { type: "robot", role: "NEZHA2", commonName: "robot", dialect: "space", evidence: "role", program: null, version: null },
          role: "NEZHA2",
          sessionOpen: true,
        }),
      ],
    });
    const links = el.querySelectorAll("a");
    expect(links).toHaveLength(1);
    expect(links[0]?.getAttribute("href")).toBe("/");
  });

  it("renders exactly one back link on an unknown device page", () => {
    const { el } = mountAt("/d/usb-SERIAL-A", { snapshot: [endpoint()] });
    const links = el.querySelectorAll("a");
    expect(links).toHaveLength(1);
    expect(links[0]?.getAttribute("href")).toBe("/");
  });
});

describe("AppHeader Flash trigger", () => {
  it("shows no Flash trigger on /", () => {
    const { el } = mountAt("/");
    expect(flashButton(el)).toBeNull();
  });

  it("shows no Flash trigger in the loading state (no resolvable endpoint yet)", () => {
    const { el } = mountAt("/d/usb-SERIAL-A");
    expect(flashButton(el)).toBeNull();
  });

  it("shows no Flash trigger in the not-connected state (no matching endpoint in the snapshot)", () => {
    const { el } = mountAt("/d/usb-MISSING", { snapshot: [endpoint()] });
    expect(flashButton(el)).toBeNull();
  });

  it("shows an enabled Flash trigger for an unknown device and opens the dialog directly, with no reflash warning", () => {
    const { el } = mountAt("/d/usb-SERIAL-A", { snapshot: [endpoint({ role: null })] });

    const button = flashButton(el);
    expect(button).not.toBeNull();
    expect(button?.disabled).toBe(false);

    act(() => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(el.querySelector(".flash-controls")).not.toBeNull();
    expect(el.textContent).not.toContain("will interrupt");
  });

  it("shows an enabled Flash trigger for a relay device and opens the dialog with a reflash warning, no window.confirm", () => {
    const confirmSpy = vi.spyOn(window, "confirm");
    const relay = endpoint({
      endpointId: "usb-RELAY-A",
      resourceKey: "usb-RELAY-A",
      classification: { type: "relay", role: "RADIORELAY", commonName: "relay", dialect: "space", evidence: "role", program: null, version: null },
      role: "RADIORELAY",
      sessionOpen: true,
    });
    const { el } = mountAt("/d/usb-RELAY-A", { snapshot: [relay] });

    const button = flashButton(el);
    expect(button).not.toBeNull();
    expect(button?.disabled).toBe(false);
    expect(el.querySelector(".flash-controls")).toBeNull();

    act(() => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(confirmSpy).not.toHaveBeenCalled();
    expect(el.querySelector(".flash-controls")).not.toBeNull();
    expect(el.textContent).toContain("will interrupt");
  });

  it("shows an enabled Flash trigger for a robot device and opens the dialog with a reflash warning, no window.confirm", () => {
    const confirmSpy = vi.spyOn(window, "confirm");
    const robot = endpoint({
      endpointId: "usb-ROBOT-A",
      resourceKey: "usb-ROBOT-A",
      classification: { type: "robot", role: "NEZHA2", commonName: "robot", dialect: "space", evidence: "role", program: null, version: null },
      role: "NEZHA2",
      sessionOpen: true,
    });
    const { el } = mountAt("/d/usb-ROBOT-A", { snapshot: [robot] });

    const button = flashButton(el);
    act(() => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(confirmSpy).not.toHaveBeenCalled();
    expect(el.querySelector(".flash-controls")).not.toBeNull();
    expect(el.textContent).toContain("will interrupt");
  });
});
