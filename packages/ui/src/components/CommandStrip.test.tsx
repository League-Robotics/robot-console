// @vitest-environment jsdom
/**
 * CommandStrip.test.tsx — component tests (ticket 005 / SUC-006,
 * SUC-007; ticket 006 / SUC-007 adds the discovery tests below).
 *
 * Proves: HELLO/ID/VER/STATUS each send their bare verb via
 * `sendCommand` with no fields (unsequenced dispatch is a host-side
 * concern, not asserted here); GET/SET dispatch the same way sprint
 * 006's retired Get/Set panel did (bare `GET` when the name is empty,
 * `GET <name>` when entered, `SET <name> <value>` requiring both); the
 * strip renders no reply area of its own (no watermark-style local
 * state to have a bug in); all controls are disabled with a hint when
 * no session is open. Because mounting with an already-open session now
 * auto-fires a discovery `GET` (see below), every test below that
 * asserts an exact `socket.sent` shape for a *subsequent* action clears
 * `socket.sent` right after mount so that assertion is unaffected by
 * the discovery probe.
 *
 * Ticket 006 discovery tests: a bare `GET` fires on mount when a
 * session is already open, does not fire when no session is open, and
 * fires again on a false->true reopen transition; `get <name> <value>`
 * reply lines populate the name field's `<datalist>` options; a reply
 * line that does not match the `get <name> ...` shape (host error or
 * unrecognized text) is harvested as nothing, never as an error, and
 * never blocks the free-text fallback -- a name the device never
 * reported (including when it never answers at all) is still typeable
 * and sendable via GET or SET, exactly as ticket 005 already proved for
 * the plain free-text field.
 */
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { EndpointListEntry } from "@robot-console/host/src/wsMessages.js";
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

function baseDevice(overrides: Partial<EndpointListEntry> = {}): EndpointListEntry {
  return {
    endpointId: "usb-ROBOT-A",
    transport: "usb",
    resourceKey: "usb-ROBOT-A",
    classification: { type: "robot", role: "NEZHA2", commonName: "robot", dialect: "space", evidence: "role", program: null, version: null },
    name: "zavaz",
    role: "NEZHA2",
    sessionOpen: true,
    usb: { serialNumber: "ROBOT-A-FULL", displaySerial: "0004", port: "/dev/cu.usbmodemC" },
    ...overrides,
  };
}

function mountStrip(device: EndpointListEntry): { el: HTMLDivElement; socket: FakeSocket } {
  let socket: FakeSocket | null = null;
  const el = mount(
    <WsProvider url="ws://test/" socketFactory={() => (socket = new FakeSocket())}>
      <CommandStrip device={device} />
    </WsProvider>,
  );
  act(() => {
    socket!.emitOpen();
  });
  return { el, socket: socket! };
}

/**
 * Mounts `WsProvider` with its socket already open *before* `CommandStrip`
 * ever renders, then swaps `CommandStrip` in as a child of that same
 * provider instance (same `url`/`socketFactory` references, so
 * `WsProvider`'s connect effect does not re-run and the socket
 * persists). This models what "a session already open at mount" means
 * in real usage: `WsProvider` sits at the app root and is long-since
 * connected by the time a per-device page like `RobotPage` (and the
 * `CommandStrip` it mounts) ever renders -- unlike `mountStrip` above,
 * which mounts the provider and the strip in one commit and is right
 * for every other test here (they only assert behavior *after* an
 * explicit user action, once the socket is already known-open).
 * `rerender` swaps in a new `device` prop against that same mounted
 * `CommandStrip` instance, for exercising a `sessionOpen` transition
 * without remounting the component (`RobotPage` never remounts
 * `CommandStrip` just because an endpoint's `sessionOpen` flag flips).
 */
function mountReady(device: EndpointListEntry): {
  el: HTMLDivElement;
  socket: FakeSocket;
  rerender: (next: EndpointListEntry) => void;
} {
  let socket: FakeSocket | null = null;
  const socketFactory = () => (socket = new FakeSocket());
  const url = "ws://test/";
  const el = mount(
    <WsProvider url={url} socketFactory={socketFactory}>
      <div />
    </WsProvider>,
  );
  act(() => {
    socket!.emitOpen();
  });
  const render = (next: EndpointListEntry) => {
    act(() => {
      root!.render(
        <WsProvider url={url} socketFactory={socketFactory}>
          <CommandStrip device={next} />
        </WsProvider>,
      );
    });
  };
  render(device);
  return { el, socket: socket!, rerender: render };
}

describe("CommandStrip", () => {
  it("sends bare HELLO with no fields", () => {
    const { el, socket } = mountStrip(baseDevice());
    socket.sent.length = 0;
    act(() => {
      el.querySelector<HTMLButtonElement>('[data-testid="command-strip-hello"]')!.click();
    });
    expect(socket.sent).toEqual([
      JSON.stringify({ type: "send-command", endpointId: "usb-ROBOT-A", verb: "HELLO" }),
    ]);
  });

  it("sends bare ID with no fields", () => {
    const { el, socket } = mountStrip(baseDevice());
    socket.sent.length = 0;
    act(() => {
      el.querySelector<HTMLButtonElement>('[data-testid="command-strip-id"]')!.click();
    });
    expect(socket.sent).toEqual([
      JSON.stringify({ type: "send-command", endpointId: "usb-ROBOT-A", verb: "ID" }),
    ]);
  });

  it("sends bare VER with no fields", () => {
    const { el, socket } = mountStrip(baseDevice());
    socket.sent.length = 0;
    act(() => {
      el.querySelector<HTMLButtonElement>('[data-testid="command-strip-ver"]')!.click();
    });
    expect(socket.sent).toEqual([
      JSON.stringify({ type: "send-command", endpointId: "usb-ROBOT-A", verb: "VER" }),
    ]);
  });

  it("sends bare STATUS with no fields", () => {
    const { el, socket } = mountStrip(baseDevice());
    socket.sent.length = 0;
    act(() => {
      el.querySelector<HTMLButtonElement>('[data-testid="command-strip-status"]')!.click();
    });
    expect(socket.sent).toEqual([
      JSON.stringify({ type: "send-command", endpointId: "usb-ROBOT-A", verb: "STATUS" }),
    ]);
  });

  it("sends bare FUNCS with no fields", () => {
    const { el, socket } = mountStrip(baseDevice());
    socket.sent.length = 0;
    act(() => {
      el.querySelector<HTMLButtonElement>('[data-testid="command-strip-funcs"]')!.click();
    });
    expect(socket.sent).toEqual([
      JSON.stringify({ type: "send-command", endpointId: "usb-ROBOT-A", verb: "FUNCS" }),
    ]);
  });

  it("sends bare GET (no fields) when the name field is empty", () => {
    const { el, socket } = mountStrip(baseDevice());
    socket.sent.length = 0;
    act(() => {
      el.querySelector<HTMLButtonElement>('[data-testid="command-strip-get"]')!.click();
    });
    expect(socket.sent).toEqual([
      JSON.stringify({ type: "send-command", endpointId: "usb-ROBOT-A", verb: "GET" }),
    ]);
  });

  it("sends GET <name> when a name is entered", () => {
    const { el, socket } = mountStrip(baseDevice());
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
        endpointId: "usb-ROBOT-A",
        verb: "GET",
        fields: ["trackwidth"],
      }),
    ]);
  });

  it("sends SET <name> <value>", () => {
    const { el, socket } = mountStrip(baseDevice());
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
        endpointId: "usb-ROBOT-A",
        verb: "SET",
        fields: ["trackwidth", "128"],
      }),
    ]);
  });

  it("disables SET until both name and value are entered", () => {
    const { el } = mountStrip(baseDevice());
    const nameInput = el.querySelector<HTMLInputElement>('[data-testid="command-strip-name"]')!;
    const setButton = el.querySelector<HTMLButtonElement>('[data-testid="command-strip-set"]')!;

    expect(setButton.disabled).toBe(true);

    act(() => {
      typeInto(nameInput, "trackwidth");
    });
    expect(setButton.disabled).toBe(true);
  });

  it("renders no reply area of its own -- replies are DeviceConsole's job", () => {
    const { el, socket } = mountStrip(baseDevice());
    act(() => {
      socket.emitMessage({
        type: "line",
        endpointId: "usb-ROBOT-A",
        direction: "rx",
        line: "get trackwidth 128",
      });
    });
    // No reply region like the retired Get/Set panel's exists on this component at all.
    expect(el.querySelector('[data-testid="get-set-replies"]')).toBeNull();
    expect(el.textContent).not.toContain("trackwidth 128");
  });

  it("disables every control and shows a hint when no session is open", () => {
    const { el } = mountStrip(baseDevice({ sessionOpen: false }));

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

describe("CommandStrip field-name auto-discovery (ticket 006 / SUC-007)", () => {
  function optionValues(el: HTMLDivElement): string[] {
    return Array.from(
      el.querySelectorAll<HTMLOptionElement>('[data-testid="command-strip-name-options"] option'),
    ).map((option) => option.value);
  }

  it("fires a bare GET when the session is already open at mount", () => {
    const { socket } = mountReady(baseDevice());
    expect(socket.sent).toEqual([
      JSON.stringify({ type: "send-command", endpointId: "usb-ROBOT-A", verb: "GET" }),
    ]);
  });

  it("does not fire discovery when mounted with no session open", () => {
    const { socket } = mountReady(baseDevice({ sessionOpen: false }));
    expect(socket.sent).toEqual([]);
  });

  it("re-fires discovery on a false->true sessionOpen transition (session reopened)", () => {
    const { socket, rerender } = mountReady(baseDevice({ sessionOpen: false }));
    expect(socket.sent).toEqual([]);

    rerender(baseDevice({ sessionOpen: true }));
    expect(socket.sent).toEqual([
      JSON.stringify({ type: "send-command", endpointId: "usb-ROBOT-A", verb: "GET" }),
    ]);

    // Re-rendering again with sessionOpen still true is not a new
    // transition -- no second bare GET.
    socket.sent.length = 0;
    rerender(baseDevice({ sessionOpen: true }));
    expect(socket.sent).toEqual([]);

    // Closing then reopening fires again.
    rerender(baseDevice({ sessionOpen: false }));
    socket.sent.length = 0;
    rerender(baseDevice({ sessionOpen: true }));
    expect(socket.sent).toEqual([
      JSON.stringify({ type: "send-command", endpointId: "usb-ROBOT-A", verb: "GET" }),
    ]);
  });

  it("harvests <name> from get <name> <value> reply lines into the combo box's options", () => {
    const { el, socket } = mountStrip(baseDevice());
    act(() => {
      socket.emitMessage({
        type: "line",
        endpointId: "usb-ROBOT-A",
        direction: "rx",
        line: "get trackwidth 128",
      });
      socket.emitMessage({
        type: "line",
        endpointId: "usb-ROBOT-A",
        direction: "rx",
        line: "get wheel_diameter 42",
      });
    });
    expect(optionValues(el)).toEqual(["trackwidth", "wheel_diameter"]);

    // The combo box is editable, not a closed select -- the underlying
    // <input> still accepts and sends an arbitrary name.
    const nameInput = el.querySelector<HTMLInputElement>('[data-testid="command-strip-name"]')!;
    expect(nameInput.tagName).toBe("INPUT");
    expect(nameInput.hasAttribute("list")).toBe(true);
  });

  it("treats a duplicate get reply line as one option, not two", () => {
    const { el, socket } = mountStrip(baseDevice());
    act(() => {
      socket.emitMessage({
        type: "line",
        endpointId: "usb-ROBOT-A",
        direction: "rx",
        line: "get trackwidth 128",
      });
      socket.emitMessage({
        type: "line",
        endpointId: "usb-ROBOT-A",
        direction: "rx",
        line: "get trackwidth 130",
      });
    });
    expect(optionValues(el)).toEqual(["trackwidth"]);
  });

  it("ignores a host error log entry and any non-get reply line -- unrecognized shapes are harvested as nothing, never an error", () => {
    const { el, socket } = mountStrip(baseDevice());
    act(() => {
      socket.emitMessage({
        type: "line",
        endpointId: "usb-ROBOT-A",
        direction: "rx",
        line: "err 3 unknown field",
      });
      socket.emitMessage({
        type: "line",
        endpointId: "usb-ROBOT-A",
        direction: "rx",
        line: "ack 1 0 none",
      });
      socket.emitMessage({
        type: "error",
        endpointId: "usb-ROBOT-A",
        message: "get pretend field -- not a real device reply",
      });
    });
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
        endpointId: "usb-ROBOT-A",
        verb: "GET",
        fields: ["undiscovered_field"],
      }),
    ]);
  });

  it("a device that never answers discovery leaves the combo box empty without blocking free-text GET/SET", () => {
    const { el, socket } = mountStrip(baseDevice());
    // No `get ...` reply ever arrives -- discovery's bare GET (fired on
    // mount) simply goes unanswered, same as any other unsequenced or
    // sequenced verb this strip sends. No spinner or loading state
    // exists here to get stuck (see CommandStrip.tsx's doc comment).
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
        endpointId: "usb-ROBOT-A",
        verb: "SET",
        fields: ["trackwidth", "128"],
      }),
    ]);
  });
});
