// @vitest-environment jsdom
/**
 * ConsoleDock.test.tsx — sprint 022 ticket 002.
 *
 * This ticket is relocation only: the property under test is that
 * `ConsoleDock` mounts `DeviceConsole` and `CommandStrip` for the given
 * link, unchanged, in one place. Their own behavior (send box, log
 * classification, HELLO/ID/VER/STATUS/FUNCS dispatch, field discovery)
 * is already covered by `DeviceConsole.test.tsx`/`CommandStrip.test.tsx`
 * and is not re-asserted here.
 */
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { SnapshotLink } from "@robot-console/host/src/wsMessages.js";
import { ConsoleDock } from "./ConsoleDock";
import { WsProvider } from "../../ws/WsProvider";
import { FakeSocket } from "../../testing/FakeSocket";

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

describe("ConsoleDock", () => {
  it("renders as a single labeled dock region", () => {
    const el = mount(
      <WsProvider url="ws://test/" socketFactory={() => new FakeSocket()}>
        <ConsoleDock link={link} name="tigez" />
      </WsProvider>,
    );
    expect(el.querySelector('[data-testid="console-dock"]')).not.toBeNull();
  });

  it("mounts DeviceConsole (log, toolbar, send box) for the given link, unchanged", () => {
    const el = mount(
      <WsProvider url="ws://test/" socketFactory={() => new FakeSocket()}>
        <ConsoleDock link={link} name="tigez" />
      </WsProvider>,
    );
    expect(el.querySelector('[aria-label="Console"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="console-log"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="console-send-input"]')).not.toBeNull();
  });

  it("mounts CommandStrip's verb buttons for the given link, unchanged", () => {
    const el = mount(
      <WsProvider url="ws://test/" socketFactory={() => new FakeSocket()}>
        <ConsoleDock link={link} name="tigez" />
      </WsProvider>,
    );
    expect(el.querySelector('[aria-label="Command strip"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="command-strip-hello"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="command-strip-get"]')).not.toBeNull();
  });

  it("passes the given name through to DeviceConsole's 'no link open' hint", () => {
    const { session: _unusedSession, ...linkWithoutSession } = link;
    const closedLink: SnapshotLink = { ...linkWithoutSession, state: "closed_by_user" };
    const el = mount(
      <WsProvider url="ws://test/" socketFactory={() => new FakeSocket()}>
        <ConsoleDock link={closedLink} name="vevov" />
      </WsProvider>,
    );
    expect(el.textContent).toContain("No link open to vevov");
  });
});
