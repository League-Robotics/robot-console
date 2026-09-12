// @vitest-environment jsdom
/**
 * CommandStrip.test.tsx — component tests (ticket 005 / SUC-006,
 * SUC-007; ticket 006 / SUC-007 adds the discovery tests below; sprint
 * 015 ticket 009 migrates this file to the `Snapshot` contract and
 * drops the on-open discovery probe).
 *
 * Proves: HELLO/ID/VER/STATUS each send their bare verb via
 * `sendCommand` with no fields (unsequenced dispatch is a host-side
 * concern, not asserted here); GET/SET dispatch the same way sprint
 * 006's retired Get/Set panel did (bare `GET` when the name is empty,
 * `GET <name>` when entered, `SET <name> <value>` requiring both); the
 * strip renders no reply area of its own (no watermark-style local
 * state to have a bug in); all controls are disabled with a hint when
 * no session is open.
 *
 * Ticket 006 discovery tests, narrowed by ticket 009: `get <name>
 * <value>` reply lines already in the link's log populate the name
 * field's `<datalist>`; a reply line that does not match the `get
 * <name> ...` shape (host error or unrecognized text) is harvested as
 * nothing, never as an error, and never blocks the free-text fallback --
 * a name the device never reported (including when it never answers at
 * all) is still typeable and sendable via GET or SET. The "fires a bare
 * GET on mount / on reopen" pinned test cases this file used to carry
 * are deleted, not adapted (ticket 009's own Description: this
 * component no longer probes on open at all).
 */
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { SnapshotLink } from "@robot-console/host/src/wsMessages.js";
import { CommandStrip } from "./CommandStrip";
import { WsProvider } from "../ws/WsProvider";
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
});

const LINK_ID = "usb-ROBOT-A";

function openLink(overrides: Partial<SnapshotLink> = {}): SnapshotLink {
  return {
    id: LINK_ID,
    transport: "usb",
    label: "USB · /dev/cu.usbmodemC",
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

function closedLink(overrides: Partial<Omit<SnapshotLink, "session">> = {}): SnapshotLink {
  return {
    id: LINK_ID,
    transport: "usb",
    label: "USB · /dev/cu.usbmodemC",
    state: "connectable",
    reason: null,
    since: 0,
    lastSeen: 0,
    nextRetryAt: null,
    capabilities: { open: true, close: false, flash: true, provisionWifi: false },
    ...overrides,
  };
}

function mountStrip(link: SnapshotLink): { el: HTMLDivElement; socket: FakeSocket } {
  let socket: FakeSocket | null = null;
  const el = mount(
    <WsProvider url="ws://test/" socketFactory={() => (socket = new FakeSocket())}>
      <CommandStrip link={link} />
    </WsProvider>,
  );
  act(() => {
    socket!.emitOpen();
  });
  return { el, socket: socket! };
}

function emitLine(socket: FakeSocket, line: string): void {
  act(() => {
    socket.emitMessage({ type: "line", linkId: LINK_ID, direction: "rx", line });
  });
}

function emitHostNotice(socket: FakeSocket, text: string): void {
  act(() => {
    socket.emitMessage({ type: "notice", level: "error", linkId: LINK_ID, text, at: 0, seq: 1 });
  });
}

describe("CommandStrip", () => {
  it("sends bare HELLO with no fields", () => {
    const { el, socket } = mountStrip(openLink());
    socket.sent.length = 0;
    act(() => {
      el.querySelector<HTMLButtonElement>('[data-testid="command-strip-hello"]')!.click();
    });
    expect(socket.sent).toEqual([JSON.stringify({ type: "send-command", linkId: LINK_ID, verb: "HELLO" })]);
  });

  it("sends bare ID with no fields", () => {
    const { el, socket } = mountStrip(openLink());
    socket.sent.length = 0;
    act(() => {
      el.querySelector<HTMLButtonElement>('[data-testid="command-strip-id"]')!.click();
    });
    expect(socket.sent).toEqual([JSON.stringify({ type: "send-command", linkId: LINK_ID, verb: "ID" })]);
  });

  it("sends bare VER with no fields", () => {
    const { el, socket } = mountStrip(openLink());
    socket.sent.length = 0;
    act(() => {
      el.querySelector<HTMLButtonElement>('[data-testid="command-strip-ver"]')!.click();
    });
    expect(socket.sent).toEqual([JSON.stringify({ type: "send-command", linkId: LINK_ID, verb: "VER" })]);
  });

  it("sends bare STATUS with no fields", () => {
    const { el, socket } = mountStrip(openLink());
    socket.sent.length = 0;
    act(() => {
      el.querySelector<HTMLButtonElement>('[data-testid="command-strip-status"]')!.click();
    });
    expect(socket.sent).toEqual([JSON.stringify({ type: "send-command", linkId: LINK_ID, verb: "STATUS" })]);
  });

  it("sends bare FUNCS with no fields", () => {
    const { el, socket } = mountStrip(openLink());
    socket.sent.length = 0;
    act(() => {
      el.querySelector<HTMLButtonElement>('[data-testid="command-strip-funcs"]')!.click();
    });
    expect(socket.sent).toEqual([JSON.stringify({ type: "send-command", linkId: LINK_ID, verb: "FUNCS" })]);
  });

  it("sends bare GET (no fields) when the name field is empty", () => {
    const { el, socket } = mountStrip(openLink());
    socket.sent.length = 0;
    act(() => {
      el.querySelector<HTMLButtonElement>('[data-testid="command-strip-get"]')!.click();
    });
    expect(socket.sent).toEqual([JSON.stringify({ type: "send-command", linkId: LINK_ID, verb: "GET" })]);
  });

  it("sends GET <name> when a name is entered", () => {
    const { el, socket } = mountStrip(openLink());
    socket.sent.length = 0;
    const nameInput = el.querySelector<HTMLInputElement>('[data-testid="command-strip-name"]')!;
    act(() => {
      typeInto(nameInput, "trackwidth");
    });
    act(() => {
      el.querySelector<HTMLButtonElement>('[data-testid="command-strip-get"]')!.click();
    });
    expect(socket.sent).toEqual([
      JSON.stringify({
        type: "send-command",
        linkId: LINK_ID,
        verb: "GET",
        fields: ["trackwidth"],
      }),
    ]);
  });

  it("sends SET <name> <value>", () => {
    const { el, socket } = mountStrip(openLink());
    socket.sent.length = 0;
    const nameInput = el.querySelector<HTMLInputElement>('[data-testid="command-strip-name"]')!;
    const valueInput = el.querySelector<HTMLInputElement>('[data-testid="command-strip-value"]')!;
    act(() => {
      typeInto(nameInput, "trackwidth");
      typeInto(valueInput, "128");
    });
    act(() => {
      el.querySelector<HTMLButtonElement>('[data-testid="command-strip-set"]')!.click();
    });
    expect(socket.sent).toEqual([
      JSON.stringify({
        type: "send-command",
        linkId: LINK_ID,
        verb: "SET",
        fields: ["trackwidth", "128"],
      }),
    ]);
  });

  it("disables SET until both name and value are entered", () => {
    const { el } = mountStrip(openLink());
    const nameInput = el.querySelector<HTMLInputElement>('[data-testid="command-strip-name"]')!;
    const setButton = el.querySelector<HTMLButtonElement>('[data-testid="command-strip-set"]')!;

    expect(setButton.disabled).toBe(true);

    act(() => {
      typeInto(nameInput, "trackwidth");
    });
    expect(setButton.disabled).toBe(true);
  });

  it("renders no reply area of its own -- replies are DeviceConsole's job", () => {
    const { el, socket } = mountStrip(openLink());
    emitLine(socket, "get trackwidth 128");
    // No reply region like the retired Get/Set panel's exists on this component at all.
    expect(el.querySelector('[data-testid="get-set-replies"]')).toBeNull();
    expect(el.textContent).not.toContain("trackwidth 128");
  });

  it("disables every control and shows a hint when no session is open", () => {
    const { el } = mountStrip(closedLink());

    for (const testId of [
      "command-strip-hello",
      "command-strip-id",
      "command-strip-ver",
      "command-strip-status",
      "command-strip-funcs",
      "command-strip-get",
      "command-strip-set",
    ]) {
      expect(el.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)!.disabled).toBe(true);
    }
    expect(el.querySelector<HTMLInputElement>('[data-testid="command-strip-name"]')!.disabled).toBe(true);
    expect(el.querySelector<HTMLInputElement>('[data-testid="command-strip-value"]')!.disabled).toBe(true);
    expect(el.textContent).toContain("No link open");
  });
});

describe("CommandStrip field-name discovery from the link's own log (ticket 006 / SUC-007, narrowed by ticket 009)", () => {
  function optionValues(el: HTMLDivElement): string[] {
    return Array.from(
      el.querySelectorAll<HTMLOptionElement>('[data-testid="command-strip-name-options"] option'),
    ).map((option) => option.value);
  }

  it("harvests <name> from get <name> <value> reply lines into the combo box's options", () => {
    const { el, socket } = mountStrip(openLink());
    emitLine(socket, "get trackwidth 128");
    emitLine(socket, "get wheel_diameter 42");
    expect(optionValues(el)).toEqual(["trackwidth", "wheel_diameter"]);

    // The combo box is editable, not a closed select -- the underlying
    // <input> still accepts and sends an arbitrary name.
    const nameInput = el.querySelector<HTMLInputElement>('[data-testid="command-strip-name"]')!;
    expect(nameInput.tagName).toBe("INPUT");
    expect(nameInput.hasAttribute("list")).toBe(true);
  });

  it("treats a duplicate get reply line as one option, not two", () => {
    const { el, socket } = mountStrip(openLink());
    emitLine(socket, "get trackwidth 128");
    emitLine(socket, "get trackwidth 130");
    expect(optionValues(el)).toEqual(["trackwidth"]);
  });

  it("ignores a host notice log entry and any non-get reply line -- unrecognized shapes are harvested as nothing, never an error", () => {
    const { el, socket } = mountStrip(openLink());
    emitLine(socket, "err 3 unknown field");
    emitLine(socket, "ack 1 0 none");
    emitHostNotice(socket, "get pretend field -- not a real device reply");
    expect(optionValues(el)).toEqual([]);

    // A field name the device never reported -- because it either has
    // none of this shape, or never answered discovery at all -- is
    // still typeable and sendable via GET/SET (the free-text fallback
    // ticket 005 already proved; asserted again here in the discovery
    // context so this degraded path is explicitly covered).
    const nameInput = el.querySelector<HTMLInputElement>('[data-testid="command-strip-name"]')!;
    act(() => {
      typeInto(nameInput, "undiscovered_field");
    });
    socket.sent.length = 0;
    act(() => {
      el.querySelector<HTMLButtonElement>('[data-testid="command-strip-get"]')!.click();
    });
    expect(socket.sent).toEqual([
      JSON.stringify({
        type: "send-command",
        linkId: LINK_ID,
        verb: "GET",
        fields: ["undiscovered_field"],
      }),
    ]);
  });

  it("a device that never answers discovery leaves the combo box empty without blocking free-text GET/SET", () => {
    const { el, socket } = mountStrip(openLink());
    // No `get ...` reply ever arrives, and this component no longer
    // fires one of its own on mount (ticket 009) -- the combo box just
    // stays empty; no spinner or loading state exists here to get
    // stuck (see CommandStrip.tsx's doc comment).
    expect(optionValues(el)).toEqual([]);

    const nameInput = el.querySelector<HTMLInputElement>('[data-testid="command-strip-name"]')!;
    const valueInput = el.querySelector<HTMLInputElement>('[data-testid="command-strip-value"]')!;
    act(() => {
      typeInto(nameInput, "trackwidth");
      typeInto(valueInput, "128");
    });
    socket.sent.length = 0;
    act(() => {
      el.querySelector<HTMLButtonElement>('[data-testid="command-strip-set"]')!.click();
    });
    expect(socket.sent).toEqual([
      JSON.stringify({
        type: "send-command",
        linkId: LINK_ID,
        verb: "SET",
        fields: ["trackwidth", "128"],
      }),
    ]);
  });
});
