// @vitest-environment jsdom
/**
 * RelayPage.test.tsx — shell-rendering tests for the relay page
 * (ticket 008 / SUC-006). Only a fixture is used -- no attached board
 * classifies as `relay` this sprint (Success Criteria's hardware
 * deferral), so end-to-end verification against a real relay banner is
 * out of scope here.
 */
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { EndpointListEntry } from "@robot-console/host/src/wsMessages.js";
import { RelayPage } from "./RelayPage";
import { AppHeader } from "../components/AppHeader";
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

function relayFixture(): EndpointListEntry {
  return {
    endpointId: "usb-RELAY-A",
    transport: "usb",
    resourceKey: "usb-RELAY-A",
    classification: { type: "relay", role: "RADIORELAY", commonName: "relay", dialect: "space", evidence: "role" },
    name: "gopiv",
    role: "RADIORELAY",
    sessionOpen: true,
    usb: { serialNumber: "RELAY-A-FULL", displaySerial: "0003", port: "/dev/cu.usbmodemB" },
  };
}

function mountRelayPage(endpoint: EndpointListEntry): HTMLDivElement {
  let socket: FakeSocket | null = null;
  return mount(
    <WsProvider url="ws://test/" socketFactory={() => (socket = new FakeSocket())}>
      <RelayPage endpoint={endpoint} />
    </WsProvider>,
  );
}

describe("RelayPage", () => {
  it("renders a header with the endpoint's name", () => {
    const el = mountRelayPage(relayFixture());
    expect(el.textContent).toContain("gopiv");
  });

  it("renders the robot dropdown present but empty, not hidden and not an error", () => {
    const el = mountRelayPage(relayFixture());

    const select = el.querySelector<HTMLSelectElement>('[data-testid="relay-robot-select"]');
    expect(select).not.toBeNull();
    expect(select?.disabled).toBe(true);
    expect(select?.options).toHaveLength(1);
    expect(select?.textContent).toContain("No robots set up yet");
    expect(el.textContent).not.toMatch(/error/i);
  });

  it("embeds the device console for this endpoint", () => {
    const el = mountRelayPage(relayFixture());
    expect(el.querySelector('[aria-label="Console"]')).not.toBeNull();
  });
});

describe("RelayPage under AppHeader (ticket 012-004)", () => {
  // AppHeader owns the back-to-devices link and the Flash menu entry
  // (see AppHeader.test.tsx for the full behavior matrix); this is a
  // cheap per-page smoke test proving both actually show up on a real
  // relay device page's route, not just in AppHeader's own isolated
  // tests.
  it("shows a back-to-devices link and an enabled Flash entry alongside the relay page", () => {
    const relay = relayFixture();
    let socket: FakeSocket | null = null;
    const el = mount(
      withRouter(
        <WsProvider url="ws://test/" socketFactory={() => (socket = new FakeSocket())}>
          <AppHeader />
          <RelayPage endpoint={relay} />
        </WsProvider>,
        { initialEntries: [`/d/${relay.endpointId}`] },
      ),
    );
    act(() => {
      socket!.emitOpen();
    });
    act(() => {
      socket!.emitMessage({ type: "endpoints", endpoints: [relay] });
    });

    const backLink = el.querySelector("a");
    expect(backLink?.getAttribute("href")).toBe("/");
    const flashButton = Array.from(el.querySelectorAll("button")).find((b) => b.textContent === "Flash");
    expect(flashButton).not.toBeUndefined();
    expect(flashButton?.disabled).toBe(false);
  });
});
