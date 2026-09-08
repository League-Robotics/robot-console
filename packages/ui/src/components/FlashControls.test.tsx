// @vitest-environment jsdom
/**
 * FlashControls.test.tsx — component-level tests for the shared flash
 * component (ticket 012-002 / SUC-002, SUC-003, SUC-004), migrated from
 * `UnknownDevicePage.test.tsx` now that the flash UI itself lives here
 * rather than trapped inside that page.
 *
 * Four groups:
 *  - Release-flash gating (including the `canBeFlashed`-gated "renders
 *    nothing" case now owned by this component itself, not just by a
 *    caller choosing not to mount it).
 *  - The local-hex upload handshake against a fake socket, capturing
 *    both JSON messages (`sent`) and the one binary frame
 *    (`sentBinary`) `FakeSocket` records separately.
 *  - Post-flash navigation: `ok` navigates to `/`, a different
 *    endpoint's result does not, and `reidentify: "timeout"` renders
 *    the required wording without navigating.
 *
 * **The flake, root-caused (not just relocated):** the pre-existing
 * `UnknownDevicePage.test.tsx` intermittently failed under full-suite
 * parallelism, reliably passing alone. Its local-hex tests used
 * `flushAsync()` -- a *single* `await new Promise(r => setTimeout(r,
 * 0))` -- to wait for `handleFileSelected`'s async chain
 * (`file.arrayBuffer()` then `crypto.subtle.digest()`, two real awaits)
 * to finish before asserting on `socket().sent`. That wait assumed the
 * whole chain always completes within exactly one macrotask tick. It
 * usually does when a file runs alone, but nothing about `Promise`/
 * `setTimeout` scheduling *guarantees* it: under full-suite parallelism
 * many worker processes compete for the same CPU cores (and, for
 * `crypto.subtle.digest`, the same libuv threadpool), so the real
 * wall-clock time for that chain to settle can exceed one tick even
 * though it never does when the file is the only thing running. A
 * fixed-count wait racing a chain of unbounded/variable length is
 * exactly the shape of an intermittent, load-dependent failure -- not
 * flaky because the *code* is wrong, but because the *test* assumed a
 * timing guarantee neither `Promise` nor `setTimeout` semantics
 * actually give it.
 *
 * The fix below is `waitUntil` (a condition-based poll, one tick at a
 * time, bounded by a generous timeout) in place of `flushAsync`
 * (a fixed one-tick wait): it waits for the actual effect (a message
 * landing in `socket().sent`) rather than assuming a tick count, so it
 * is correct regardless of how many ticks the real chain needs. This is
 * a fix to the test's synchronization, not a timeout bump on the same
 * fixed-count wait and not a retry/skip -- see the stability check this
 * ticket ran (reported in the ticket's own commit) before this was
 * considered done.
 */
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type {
  EndpointListEntry,
  FirmwareAvailability,
  FirmwareKind,
} from "@robot-console/host/src/wsMessages.js";
import { UPLOAD_ID_BYTE_LENGTH } from "@robot-console/host/src/wsMessages.js";
import { FlashControls, MAX_LOCAL_HEX_BYTES } from "./FlashControls";
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

/** A failed-identify device -- `role: null`, `sessionError` set -- one
 * of the two states `canBeFlashed` covers (mirrors
 * `DevicesTab.test.tsx`'s own helper of the same name, carried forward
 * through `UnknownDevicePage.test.tsx`). */
function failedIdentifyDevice(overrides: Partial<EndpointListEntry> = {}): EndpointListEntry {
  return baseDevice({
    endpointId: "usb-SERIAL-UNRESPONSIVE",
    resourceKey: "usb-SERIAL-UNRESPONSIVE",
    sessionOpen: false,
    sessionError: "HELLO reply timed out after 2000ms",
    ...overrides,
  });
}

function firmwareStatusFixture(
  overrides: Partial<Record<FirmwareKind, FirmwareAvailability>> = {},
): Record<FirmwareKind, FirmwareAvailability> {
  return {
    relay: {
      configured: true,
      repoUrl: "https://github.com/League-Robotics/microbit-radio-relay",
      tag: "v0.20260831.1",
      available: true,
    },
    robot: {
      configured: true,
      repoUrl: "https://github.com/League-Robotics/pxt-nezha-diffdrive",
      tag: "latest",
      available: false,
      reason: "no-releases",
    },
    ...overrides,
  };
}

function mountFlashControls(
  endpoint: EndpointListEntry,
  options: { firmwareStatus?: Record<FirmwareKind, FirmwareAvailability>; initialEntries?: string[] } = {},
): { el: HTMLDivElement; socket: () => FakeSocket } {
  let socket: FakeSocket | null = null;
  const el = mount(
    withRouter(
      <WsProvider url="ws://test/" socketFactory={() => (socket = new FakeSocket())}>
        <FlashControls endpoint={endpoint} />
      </WsProvider>,
      { initialEntries: options.initialEntries ?? [`/d/${endpoint.endpointId}`] },
    ),
  );
  act(() => {
    socket!.emitOpen();
  });
  if (options.firmwareStatus) {
    act(() => {
      socket!.emitMessage({ type: "endpoints", endpoints: [endpoint], firmwareStatus: options.firmwareStatus });
    });
  }
  return { el, socket: () => socket! };
}

function location(el: HTMLDivElement): string | null | undefined {
  return el.querySelector('[data-testid="location"]')?.textContent;
}

/** Poll one macrotask tick at a time until `condition()` is true, up to
 * `timeoutMs`. Used in place of a fixed single-tick wait (`flushAsync`,
 * this file's predecessor's approach) specifically because
 * `handleFileSelected`'s async chain (`file.arrayBuffer()` then
 * `crypto.subtle.digest()`) has no guaranteed tick count -- see this
 * module's doc comment for the flake this replaces. Always called from
 * inside an outer `act(async () => { ... })` so state updates that
 * happen mid-poll are still flushed under React's `act` tracking. */
async function waitUntil(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error("waitUntil: condition not met within timeout");
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/** Expected-value helper mirroring `FlashControls.tsx`'s own
 * `sha256Hex` (Web Crypto, not `node:crypto` -- this is a browser
 * package's test, with no Node types configured for its `tsconfig`). */
async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

describe("FlashControls release-flash gating", () => {
  it("renders nothing for an identified device", () => {
    const { el } = mountFlashControls(
      baseDevice({ role: "NEZHA2", sessionOpen: true }),
      { firmwareStatus: firmwareStatusFixture() },
    );
    expect(el.textContent).not.toContain("Flash relay firmware");
    expect(el.textContent).not.toContain("Flash robot firmware");
    // Not just "no flash buttons" -- the component's own `canBeFlashed`
    // gate (see its doc comment's "no knowledge of caller" contract)
    // means it renders no markup at all (`null`) for a non-flashable
    // device, so a caller mounting it unconditionally never gets a
    // stray empty wrapper.
    expect(el.querySelector(".flash-controls")).toBeNull();
  });

  // Regression test for the bug ticket 012-001 fixed: a silent,
  // unflashed board's session opens fine and `identify()` resolves
  // `null` without throwing, so `sessionError` is never set. This is
  // the most common bench state, and it must still get flash controls
  // -- `canBeFlashed` depends only on `role`, not `sessionError`.
  it("shows both flash buttons for an unprobed device (no role, no sessionError)", () => {
    const { el } = mountFlashControls(baseDevice({ role: null }), { firmwareStatus: firmwareStatusFixture() });
    expect(el.textContent).toContain("Flash relay firmware");
    expect(el.textContent).toContain("Flash robot firmware");
  });

  it("shows both flash buttons for a failed-identify device", () => {
    const { el } = mountFlashControls(failedIdentifyDevice(), { firmwareStatus: firmwareStatusFixture() });
    expect(el.textContent).toContain("Flash relay firmware");
    expect(el.textContent).toContain("Flash robot firmware");
  });

  it("disables the robot button with a readable reason on the zero-release fixture", () => {
    const { el } = mountFlashControls(failedIdentifyDevice(), { firmwareStatus: firmwareStatusFixture() });
    const buttons = Array.from(el.querySelectorAll("button"));
    const robotButton = buttons.find((b) => b.textContent === "Flash robot firmware");
    expect(robotButton?.disabled).toBe(true);
    expect(el.textContent).toContain("No build has been published yet");
  });

  it("enables the relay button when its release is available", () => {
    const { el } = mountFlashControls(failedIdentifyDevice(), { firmwareStatus: firmwareStatusFixture() });
    const buttons = Array.from(el.querySelectorAll("button"));
    const relayButton = buttons.find((b) => b.textContent === "Flash relay firmware");
    expect(relayButton?.disabled).toBe(false);
  });

  it("flips the robot button to enabled with no code change when availability flips", () => {
    const { el } = mountFlashControls(failedIdentifyDevice(), {
      firmwareStatus: firmwareStatusFixture({
        robot: {
          configured: true,
          repoUrl: "https://github.com/League-Robotics/pxt-nezha-diffdrive",
          tag: "latest",
          available: true,
        },
      }),
    });
    const buttons = Array.from(el.querySelectorAll("button"));
    const robotButton = buttons.find((b) => b.textContent === "Flash robot firmware");
    expect(robotButton?.disabled).toBe(false);
  });

  it("shows a not-broken message before the first availability poll completes", () => {
    const { el } = mountFlashControls(failedIdentifyDevice(), {
      firmwareStatus: firmwareStatusFixture({
        robot: {
          configured: true,
          repoUrl: "https://github.com/League-Robotics/pxt-nezha-diffdrive",
          tag: "latest",
          available: false,
          reason: "not-yet-checked",
        },
      }),
    });
    expect(el.textContent).toContain("Checking whether this firmware is available");
  });

  it("sends a well-formed flash-start message when Flash relay firmware is clicked", () => {
    const { el, socket } = mountFlashControls(failedIdentifyDevice(), { firmwareStatus: firmwareStatusFixture() });
    const relayButton = Array.from(el.querySelectorAll("button")).find(
      (b) => b.textContent === "Flash relay firmware",
    );
    act(() => {
      relayButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(socket().sent).toEqual([
      JSON.stringify({
        type: "flash-start",
        endpointId: "usb-SERIAL-UNRESPONSIVE",
        source: { kind: "release", firmware: "relay" },
      }),
    ]);
  });

  it("hides the flash buttons and shows phase-derived progress once flash-progress arrives", () => {
    const { el, socket } = mountFlashControls(failedIdentifyDevice(), { firmwareStatus: firmwareStatusFixture() });
    act(() => {
      socket().emitMessage({
        type: "flash-progress",
        endpointId: "usb-SERIAL-UNRESPONSIVE",
        source: { kind: "release", firmware: "relay" },
        phase: "writing",
      });
    });

    expect(el.textContent).not.toContain("Flash relay firmware");
    expect(el.textContent).not.toContain("Flash robot firmware");
    expect(el.textContent).toContain("Flashing relay: writing…");
  });

  it("shows progress for a local-hex flash the same way as a release flash", () => {
    const { el, socket } = mountFlashControls(failedIdentifyDevice(), { firmwareStatus: firmwareStatusFixture() });
    act(() => {
      socket().emitMessage({
        type: "flash-progress",
        endpointId: "usb-SERIAL-UNRESPONSIVE",
        source: { kind: "local-hex", uploadId: "u-1", fileName: "custom.hex", sha256: "abc" },
        phase: "erasing",
      });
    });

    expect(el.textContent).toContain('Flashing "custom.hex": erasing…');
  });

  it("surfaces a terminal flash-result error's message", () => {
    const { el, socket } = mountFlashControls(failedIdentifyDevice(), { firmwareStatus: firmwareStatusFixture() });
    act(() => {
      socket().emitMessage({
        type: "flash-result",
        endpointId: "usb-SERIAL-UNRESPONSIVE",
        source: { kind: "release", firmware: "relay" },
        status: "error",
        message: "sha256 mismatch on downloaded hex",
      });
    });
    expect(el.textContent).toContain("sha256 mismatch on downloaded hex");
  });
});

describe("FlashControls local-hex flow", () => {
  it("computes fileName/byteLength/sha256 and sends flash-local-begin", async () => {
    const { el, socket } = mountFlashControls(failedIdentifyDevice(), { firmwareStatus: firmwareStatusFixture() });
    const input = el.querySelector<HTMLInputElement>('[data-testid="local-hex-file-input"]')!;
    const content = ":020000040000FA\n:00000001FF\n";
    const file = new File([content], "custom.hex");
    Object.defineProperty(input, "files", { value: [file], configurable: true });

    await act(async () => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
      await waitUntil(() => socket().sent.length >= 1);
    });

    const expectedSha256 = await sha256Hex(content);
    expect(socket().sent).toHaveLength(1);
    expect(JSON.parse(socket().sent[0]!)).toEqual({
      type: "flash-local-begin",
      fileName: "custom.hex",
      byteLength: content.length,
      sha256: expectedSha256,
    });
  });

  it("sends one binary frame (uploadId prefix + payload) on flash-local-ready, then flash-start on 'Flash this file'", async () => {
    const { el, socket } = mountFlashControls(failedIdentifyDevice(), { firmwareStatus: firmwareStatusFixture() });
    const input = el.querySelector<HTMLInputElement>('[data-testid="local-hex-file-input"]')!;
    const content = ":020000040000FA\n:00000001FF\n";
    const file = new File([content], "custom.hex");
    Object.defineProperty(input, "files", { value: [file], configurable: true });

    await act(async () => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
      await waitUntil(() => socket().sent.length >= 1);
    });

    const expectedSha256 = await sha256Hex(content);
    const uploadId = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
    expect(uploadId.length).toBe(UPLOAD_ID_BYTE_LENGTH);

    act(() => {
      socket().emitMessage({ type: "flash-local-ready", uploadId });
    });

    expect(socket().sentBinary).toHaveLength(1);
    const frame = socket().sentBinary[0]!;
    expect(frame.length).toBe(UPLOAD_ID_BYTE_LENGTH + content.length);
    expect(new TextDecoder().decode(frame.subarray(0, UPLOAD_ID_BYTE_LENGTH))).toBe(uploadId);
    expect(new TextDecoder().decode(frame.subarray(UPLOAD_ID_BYTE_LENGTH))).toBe(content);

    const flashButton = Array.from(el.querySelectorAll("button")).find(
      (b) => b.textContent === "Flash this file",
    );
    expect(flashButton).toBeDefined();
    act(() => {
      flashButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(socket().sent).toHaveLength(2);
    expect(JSON.parse(socket().sent[1]!)).toEqual({
      type: "flash-start",
      endpointId: "usb-SERIAL-UNRESPONSIVE",
      source: { kind: "local-hex", uploadId, fileName: "custom.hex", sha256: expectedSha256 },
    });
  });

  it("rejects an oversized file client-side, sending nothing", () => {
    const { el, socket } = mountFlashControls(failedIdentifyDevice(), { firmwareStatus: firmwareStatusFixture() });
    const input = el.querySelector<HTMLInputElement>('[data-testid="local-hex-file-input"]')!;
    const oversizedFile = new File([new Uint8Array(MAX_LOCAL_HEX_BYTES + 1)], "too-big.hex");
    Object.defineProperty(input, "files", { value: [oversizedFile], configurable: true });

    act(() => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });

    expect(socket().sent).toHaveLength(0);
    expect(socket().sentBinary).toHaveLength(0);
    expect(el.textContent).toContain("too large");
  });
});

describe("FlashControls post-flash navigation", () => {
  it("navigates to / when flash-result arrives ok for this endpoint", () => {
    const { el, socket } = mountFlashControls(failedIdentifyDevice());
    act(() => {
      socket().emitMessage({
        type: "flash-result",
        endpointId: "usb-SERIAL-UNRESPONSIVE",
        source: { kind: "release", firmware: "relay" },
        status: "ok",
        classification: { type: "relay", role: "RADIORELAY", commonName: "relay", dialect: "space", evidence: "role" },
        name: "zeguz",
      });
    });

    expect(location(el)).toBe("/");
  });

  it("does not navigate for a flash-result on a different endpoint", () => {
    const { el, socket } = mountFlashControls(failedIdentifyDevice());
    act(() => {
      socket().emitMessage({
        type: "flash-result",
        endpointId: "usb-SOME-OTHER-DEVICE",
        source: { kind: "release", firmware: "relay" },
        status: "ok",
      });
    });

    expect(location(el)).toBe("/d/usb-SERIAL-UNRESPONSIVE");
  });

  it("renders 'Flashed. Waiting for the board to come back…' and does not navigate when reidentify times out", () => {
    const { el, socket } = mountFlashControls(failedIdentifyDevice());
    act(() => {
      socket().emitMessage({
        type: "flash-result",
        endpointId: "usb-SERIAL-UNRESPONSIVE",
        source: { kind: "release", firmware: "relay" },
        status: "ok",
        classification: { type: "unknown", role: null, commonName: null, dialect: null, evidence: "none" },
        reidentify: "timeout",
      });
    });

    expect(el.textContent).toContain("Flashed. Waiting for the board to come back…");
    expect(el.textContent).not.toMatch(/failed/i);
    expect(location(el)).toBe("/d/usb-SERIAL-UNRESPONSIVE");
  });
});
