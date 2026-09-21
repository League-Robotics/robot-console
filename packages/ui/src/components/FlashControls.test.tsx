// @vitest-environment jsdom
/**
 * FlashControls.test.tsx — component-level tests for the shared flash
 * component (ticket 012-002 / SUC-002, SUC-003, SUC-004), migrated from
 * `UnknownDevicePage.test.tsx` now that the flash UI itself lives here
 * rather than trapped inside that page. Rewritten sprint 015 ticket 008
 * against the `Snapshot` contract: a `SnapshotLink` in place of an
 * `EndpointListEntry`, `linkId` in place of `endpointId` on every
 * message, `type: "snapshot"` in place of `type: "endpoints"`.
 *
 * **Out-of-process modal work (2026-09-08):** `FlashControls` no longer
 * gates itself on `canBeFlashed`, and dropped its `forceShow` escape
 * hatch -- that gating now lives on `FlashDialog`'s trigger button (see
 * `FlashDialog.test.tsx`). This file exercises `FlashControls` mounted
 * directly (as `FlashDialog` mounts it once its dialog is open), always
 * rendering its full UI regardless of the link's own capabilities.
 *
 * Three groups:
 *  - Release-flash button/progress rendering (firmware availability
 *    gating, flash-progress rendering for both source kinds).
 *  - The local-hex upload handshake against a fake socket, capturing
 *    both JSON messages (`sent`) and the one binary frame
 *    (`sentBinary`) `FakeSocket` records separately.
 *  - Post-flash navigation: `ok` navigates to `/`, a different link's
 *    result does not, and `reidentify: "timeout"` renders the required
 *    wording without navigating.
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
import type { FirmwareAvailability, FirmwareKind, SnapshotLink } from "@robot-console/host/src/wsMessages.js";
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

function baseLink(overrides: Partial<SnapshotLink> = {}): SnapshotLink {
  return {
    id: "usb-SERIAL-UNRESPONSIVE",
    transport: "usb",
    label: "USB · /dev/cu.usbmodemA",
    state: "failed",
    reason: "HELLO reply timed out after 2000ms",
    since: 0,
    lastSeen: 0,
    nextRetryAt: null,
    capabilities: { open: true, close: false, flash: true, provisionWifi: false },
    ...overrides,
  };
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
      checkedAt: 1000,
    },
    robot: {
      configured: true,
      repoUrl: "https://github.com/League-Robotics/pxt-nezha-diffdrive",
      tag: "latest",
      available: false,
      checkedAt: 1000,
      reason: "no-releases",
    },
    // Joystick's real .env value is deliberately unset until ticket 007
    // (the joystick repo's release is missing the MICROBIT.hex assets
    // releases.ts requires) -- not-configured is the honest default here.
    joystick: { configured: false },
    ...overrides,
  };
}

function mountFlashControls(
  link: SnapshotLink,
  options: { firmwareStatus?: Record<FirmwareKind, FirmwareAvailability>; initialEntries?: string[] } = {},
): { el: HTMLDivElement; socket: () => FakeSocket } {
  let socket: FakeSocket | null = null;
  const el = mount(
    withRouter(
      <WsProvider url="ws://test/" socketFactory={() => (socket = new FakeSocket())}>
        <FlashControls link={link} />
      </WsProvider>,
      { initialEntries: options.initialEntries ?? [`/d/${link.id}`] },
    ),
  );
  act(() => {
    socket!.emitOpen();
  });
  if (options.firmwareStatus) {
    act(() => {
      socket!.emitMessage({
        type: "snapshot",
        seq: 1,
        at: 0,
        devices: [],
        unassigned: [link],
        relays: [],
        firmware: options.firmwareStatus,
        wifi: { ssid: null, source: null },
        tasks: [],
      });
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

describe("FlashControls release-flash rendering", () => {
  // The `canBeFlashed`-gated "renders nothing for an identified device"
  // case (and the ticket 012-001 regression it must not break) now
  // lives at `FlashDialog`'s trigger -- see `FlashDialog.test.tsx`.
  // `FlashControls` itself always renders its full UI once mounted.
  it("shows both flash buttons for an unprobed link", () => {
    const { el } = mountFlashControls(baseLink({ state: "connectable", reason: null }), { firmwareStatus: firmwareStatusFixture() });
    expect(el.textContent).toContain("Flash relay firmware");
    expect(el.textContent).toContain("Flash robot firmware");
  });

  it("shows both flash buttons for a failed-identify link", () => {
    const { el } = mountFlashControls(baseLink(), { firmwareStatus: firmwareStatusFixture() });
    expect(el.textContent).toContain("Flash relay firmware");
    expect(el.textContent).toContain("Flash robot firmware");
  });

  it("disables the robot button with a readable reason on the zero-release fixture", () => {
    const { el } = mountFlashControls(baseLink(), { firmwareStatus: firmwareStatusFixture() });
    const buttons = Array.from(el.querySelectorAll("button"));
    const robotButton = buttons.find((b) => b.textContent === "Flash robot firmware");
    expect(robotButton?.disabled).toBe(true);
    expect(el.textContent).toContain("No build has been published yet");
  });

  it("enables the relay button when its release is available", () => {
    const { el } = mountFlashControls(baseLink(), { firmwareStatus: firmwareStatusFixture() });
    const buttons = Array.from(el.querySelectorAll("button"));
    const relayButton = buttons.find((b) => b.textContent === "Flash relay firmware");
    expect(relayButton?.disabled).toBe(false);
  });

  it("flips the robot button to enabled with no code change when availability flips", () => {
    const { el } = mountFlashControls(baseLink(), {
      firmwareStatus: firmwareStatusFixture({
        robot: {
          configured: true,
          repoUrl: "https://github.com/League-Robotics/pxt-nezha-diffdrive",
          tag: "latest",
          available: true,
          checkedAt: 1000,
        },
      }),
    });
    const buttons = Array.from(el.querySelectorAll("button"));
    const robotButton = buttons.find((b) => b.textContent === "Flash robot firmware");
    expect(robotButton?.disabled).toBe(false);
  });

  it("surfaces the host's specific 'no-asset' diagnostic in a details disclosure, while the calm student-facing summary is unchanged -- the wire-detail fix", () => {
    const { el } = mountFlashControls(baseLink(), {
      firmwareStatus: firmwareStatusFixture({
        robot: {
          configured: true,
          repoUrl: "https://github.com/League-Robotics/pxt-nezha-diffdrive",
          tag: "v0.20260909.1",
          available: false,
          checkedAt: 1000,
          reason: "no-asset",
          message: "release v0.20260909.1 is missing MICROBIT.hex",
        },
      }),
    });

    // The student-facing summary text is exactly what it was before this
    // fix -- no raw diagnostic string replaces it.
    expect(el.textContent).toContain(
      "The configured build can't be found — ask your instructor to check the setup.",
    );

    // The detail is present in the DOM (a collapsed <details>, so an
    // instructor can find it without anyone reading source or querying
    // the GitHub API), naming the missing asset and the checked repo/tag.
    const detail = el.querySelector("details.device-flash-detail");
    expect(detail).not.toBeNull();
    expect(detail!.textContent).toContain("MICROBIT.hex");
    expect(detail!.textContent).toContain("https://github.com/League-Robotics/pxt-nezha-diffdrive");
    expect(detail!.textContent).toContain("v0.20260909.1");
  });

  it("shows a not-broken message before the first availability poll completes", () => {
    const { el } = mountFlashControls(baseLink(), {
      firmwareStatus: firmwareStatusFixture({
        robot: {
          configured: true,
          repoUrl: "https://github.com/League-Robotics/pxt-nezha-diffdrive",
          tag: "latest",
          available: false,
          checkedAt: null,
          reason: "not-yet-checked",
        },
      }),
    });
    expect(el.textContent).toContain("Checking whether this firmware is available");
  });

  it("sends a well-formed flash-start message when Flash relay firmware is clicked", () => {
    const { el, socket } = mountFlashControls(baseLink(), { firmwareStatus: firmwareStatusFixture() });
    const relayButton = Array.from(el.querySelectorAll("button")).find(
      (b) => b.textContent === "Flash relay firmware",
    );
    act(() => {
      relayButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(socket().sent).toEqual([
      JSON.stringify({
        type: "flash-start",
        linkId: "usb-SERIAL-UNRESPONSIVE",
        source: { kind: "release", firmware: "relay" },
      }),
    ]);
  });

  it("hides the flash buttons and shows phase-derived progress once flash-progress arrives", () => {
    const { el, socket } = mountFlashControls(baseLink(), { firmwareStatus: firmwareStatusFixture() });
    act(() => {
      socket().emitMessage({
        type: "flash-progress",
        linkId: "usb-SERIAL-UNRESPONSIVE",
        source: { kind: "release", firmware: "relay" },
        phase: "writing",
        seq: 1,
      });
    });

    expect(el.textContent).not.toContain("Flash relay firmware");
    expect(el.textContent).not.toContain("Flash robot firmware");
    // Ticket 018-017: named by the configured release's own repo+tag,
    // not the generic "relay"/"robot" word.
    expect(el.textContent).toContain("Flashing microbit-radio-relay v0.20260831.1: writing…");
  });

  it("018-017: falls back to the generic firmware word when the release isn't (or isn't yet) configured", () => {
    const { el, socket } = mountFlashControls(baseLink(), {
      firmwareStatus: { relay: { configured: false }, robot: { configured: false }, joystick: { configured: false } },
    });
    act(() => {
      socket().emitMessage({
        type: "flash-progress",
        linkId: "usb-SERIAL-UNRESPONSIVE",
        source: { kind: "release", firmware: "relay" },
        phase: "writing",
        seq: 1,
      });
    });
    expect(el.textContent).toContain("Flashing relay: writing…");
  });

  it("shows progress for a local-hex flash the same way as a release flash", () => {
    const { el, socket } = mountFlashControls(baseLink(), { firmwareStatus: firmwareStatusFixture() });
    act(() => {
      socket().emitMessage({
        type: "flash-progress",
        linkId: "usb-SERIAL-UNRESPONSIVE",
        source: { kind: "local-hex", uploadId: "u-1", fileName: "custom.hex", sha256: "abc" },
        phase: "erasing",
        seq: 1,
      });
    });

    // Ticket 018-017: a local file is named by its own file name.
    expect(el.textContent).toContain("Flashing custom.hex: erasing…");
  });

  it("surfaces a terminal flash-result error's message", () => {
    const { el, socket } = mountFlashControls(baseLink(), { firmwareStatus: firmwareStatusFixture() });
    act(() => {
      socket().emitMessage({
        type: "flash-result",
        linkId: "usb-SERIAL-UNRESPONSIVE",
        source: { kind: "release", firmware: "relay" },
        status: "error",
        message: "sha256 mismatch on downloaded hex",
        seq: 1,
      });
    });
    expect(el.textContent).toContain("sha256 mismatch on downloaded hex");
  });
});

describe("FlashControls local-hex flow", () => {
  it("computes fileName/byteLength/sha256 and sends flash-local-begin", async () => {
    const { el, socket } = mountFlashControls(baseLink(), { firmwareStatus: firmwareStatusFixture() });
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
    const { el, socket } = mountFlashControls(baseLink(), { firmwareStatus: firmwareStatusFixture() });
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
      socket().emitMessage({ type: "flash-local-ready", uploadId, seq: 1 });
    });

    expect(socket().sentBinary).toHaveLength(1);
    const frame = socket().sentBinary[0]!;
    expect(frame.length).toBe(UPLOAD_ID_BYTE_LENGTH + content.length);
    expect(new TextDecoder().decode(frame.subarray(0, UPLOAD_ID_BYTE_LENGTH))).toBe(uploadId);
    expect(new TextDecoder().decode(frame.subarray(UPLOAD_ID_BYTE_LENGTH))).toBe(content);

    // Ticket 018-017: file name and size (KB) shown before confirming.
    expect(el.textContent).toContain(`Ready to flash "custom.hex" (${Math.ceil(content.length / 1024)}KB).`);

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
      linkId: "usb-SERIAL-UNRESPONSIVE",
      source: { kind: "local-hex", uploadId, fileName: "custom.hex", sha256: expectedSha256 },
    });
  });

  it("rejects an oversized file client-side, sending nothing", () => {
    const { el, socket } = mountFlashControls(baseLink(), { firmwareStatus: firmwareStatusFixture() });
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
  it("navigates to / when flash-result arrives ok for this link", () => {
    const { el, socket } = mountFlashControls(baseLink());
    act(() => {
      socket().emitMessage({
        type: "flash-result",
        linkId: "usb-SERIAL-UNRESPONSIVE",
        source: { kind: "release", firmware: "relay" },
        status: "ok",
        role: "RADIORELAY",
        name: "zeguz",
        seq: 1,
      });
    });

    expect(location(el)).toBe("/");
    // Opened from the front page, navigating to "/" leaves the dialog
    // mounted -- it must confirm the flash rather than silently fall
    // back to the firmware choices.
    expect(el.querySelector('[data-testid="flash-success"]')?.textContent).toBe("Flashed relay.");
  });

  it("does not navigate for a flash-result on a different link", () => {
    const { el, socket } = mountFlashControls(baseLink());
    act(() => {
      socket().emitMessage({
        type: "flash-result",
        linkId: "usb-SOME-OTHER-DEVICE",
        source: { kind: "release", firmware: "relay" },
        status: "ok",
        seq: 1,
      });
    });

    expect(location(el)).toBe("/d/usb-SERIAL-UNRESPONSIVE");
  });

  it("renders 'Flashed <generic word>. Waiting for the board to come back…' and does not navigate when reidentify times out (no firmwareStatus configured, so no repo/tag to name)", () => {
    const { el, socket } = mountFlashControls(baseLink());
    act(() => {
      socket().emitMessage({
        type: "flash-result",
        linkId: "usb-SERIAL-UNRESPONSIVE",
        source: { kind: "release", firmware: "relay" },
        status: "ok",
        reidentify: "timeout",
        seq: 1,
      });
    });

    expect(el.textContent).toContain("Flashed relay. Waiting for the board to come back…");
    expect(el.textContent).not.toMatch(/failed/i);
    expect(location(el)).toBe("/d/usb-SERIAL-UNRESPONSIVE");
  });

  it("018-017: names the configured release's own repo+tag in the reidentify-timeout result line", () => {
    const { el, socket } = mountFlashControls(baseLink(), { firmwareStatus: firmwareStatusFixture() });
    act(() => {
      socket().emitMessage({
        type: "flash-result",
        linkId: "usb-SERIAL-UNRESPONSIVE",
        source: { kind: "release", firmware: "relay" },
        status: "ok",
        reidentify: "timeout",
        seq: 1,
      });
    });

    expect(el.textContent).toContain("Flashed microbit-radio-relay v0.20260831.1. Waiting for the board to come back…");
  });

  it("018-017: names the local file itself in the reidentify-timeout result line for a local-hex flash", () => {
    const { el, socket } = mountFlashControls(baseLink(), { firmwareStatus: firmwareStatusFixture() });
    act(() => {
      socket().emitMessage({
        type: "flash-result",
        linkId: "usb-SERIAL-UNRESPONSIVE",
        source: { kind: "local-hex", uploadId: "u-1", fileName: "custom.hex", sha256: "abc" },
        status: "ok",
        reidentify: "timeout",
        seq: 1,
      });
    });

    expect(el.textContent).toContain("Flashed custom.hex. Waiting for the board to come back…");
  });
});

describe("FlashControls: flash-overlay attribution (sprint 019 ticket 006, SUC-007)", () => {
  // `useFlashProgress` falls back to the snapshot's own `link.flash` when
  // no live `flash-progress` event has arrived yet -- exercised here via
  // `mountFlashControls`'s `firmwareStatus` snapshot, which carries this
  // exact `link` (flash field included) as `unassigned: [link]`. This is
  // also the same `link` object `FlashControls` reads `flash.origin`/
  // `flash.caller` off directly, so no live `flash-progress` message is
  // needed at all for this test.
  it("shows 'Agent: <caller>' alongside the progress text for an MCP-attributed flash", () => {
    const { el } = mountFlashControls(
      baseLink({ flash: { source: { kind: "release", firmware: "robot" }, phase: "writing", origin: "mcp", caller: "agent-smith" } }),
      { firmwareStatus: firmwareStatusFixture() },
    );
    expect(el.textContent).toContain("writing");
    const agent = el.querySelector('[data-testid="flash-agent-usb-SERIAL-UNRESPONSIVE"]');
    expect(agent).not.toBeNull();
    expect(agent!.textContent).toBe("Agent: agent-smith");
  });

  it("falls back to 'unknown' when an mcp-origin flash carries no caller name", () => {
    const { el } = mountFlashControls(
      baseLink({ flash: { source: { kind: "release", firmware: "robot" }, phase: "writing", origin: "mcp" } }),
      { firmwareStatus: firmwareStatusFixture() },
    );
    expect(el.querySelector('[data-testid="flash-agent-usb-SERIAL-UNRESPONSIVE"]')?.textContent).toBe("Agent: unknown");
  });

  it("shows no agent attribution for a browser-triggered (origin 'ui') flash", () => {
    const { el } = mountFlashControls(
      baseLink({ flash: { source: { kind: "release", firmware: "robot" }, phase: "writing", origin: "ui" } }),
      { firmwareStatus: firmwareStatusFixture() },
    );
    expect(el.textContent).toContain("writing");
    expect(el.querySelector('[data-testid="flash-agent-usb-SERIAL-UNRESPONSIVE"]')).toBeNull();
  });

  it("shows no agent attribution when the flash overlay carries neither origin nor caller (pre-ticket-006 fixture shape)", () => {
    const { el } = mountFlashControls(
      baseLink({ flash: { source: { kind: "release", firmware: "robot" }, phase: "writing" } }),
      { firmwareStatus: firmwareStatusFixture() },
    );
    expect(el.querySelector('[data-testid="flash-agent-usb-SERIAL-UNRESPONSIVE"]')).toBeNull();
  });
});

describe("018-017: firmware source line (repo link, tag, checked-at)", () => {
  it("shows a linked repo name, tag, and 'checked ...' text under an available release's button", () => {
    const { el } = mountFlashControls(baseLink({ state: "connectable", reason: null }), { firmwareStatus: firmwareStatusFixture() });
    const relaySource = el.querySelector('[data-testid="flash-source-relay"]')!;
    expect(relaySource).not.toBeNull();
    const link = relaySource.querySelector("a")!;
    expect(link.getAttribute("href")).toBe("https://github.com/League-Robotics/microbit-radio-relay/releases/tag/v0.20260831.1");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.textContent).toBe("microbit-radio-relay");
    expect(relaySource.textContent).toContain("v0.20260831.1");
    expect(relaySource.textContent).toContain("checked");
  });

  it("shows the plain disabled reason instead of the source line for an unavailable release", () => {
    const { el } = mountFlashControls(baseLink(), { firmwareStatus: firmwareStatusFixture() });
    expect(el.querySelector('[data-testid="flash-source-robot"]')).toBeNull();
    expect(el.textContent).toContain("No build has been published yet");
  });

  it("shows no source line at all when nothing is configured for this classroom", () => {
    const { el } = mountFlashControls(baseLink(), {
      firmwareStatus: { relay: { configured: false }, robot: { configured: false }, joystick: { configured: false } },
    });
    expect(el.querySelector('[data-testid="flash-source-relay"]')).toBeNull();
    expect(el.querySelector('[data-testid="flash-source-robot"]')).toBeNull();
  });
});
