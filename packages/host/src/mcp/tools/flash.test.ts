/**
 * flash.test.ts — sprint 019 ticket 008's own suite for `request_flash`
 * (SUC-007). Exercises the real MCP protocol machinery (Zod validation,
 * tool dispatch, `CallToolResult` shaping) via the SDK's own
 * `InMemoryTransport.createLinkedPair()` and a real `Client`, mirroring
 * `mcp/tools/drive.test.ts`'s own harness shape and rationale.
 *
 * A real, `:memory:` `Store` backs every test (never a hand-built fake)
 * so the precondition check ({@link resolveFlashLinkTarget}, imported
 * from `server.ts`) runs against real `devices`/`links`/`services` rows
 * and `agentActionLog.record()`'s own write/read discipline is exercised
 * against the real schema. `startFlash` itself is always a fake here —
 * this file's own job is proving `request_flash`'s wiring (precondition,
 * await, audit write, response shape), not re-testing `runFlashTask`
 * itself (that is `server.test.ts`'s job, unchanged by this ticket
 * except for the "mcp origin/caller" case it adds there).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { deviceIdToName } from "@robot-console/protocol";
import { registerFlashTools, type FlashToolsDeps } from "./flash.js";
import { registerInspectTools } from "./inspect.js";
import { record } from "../agentActionLog.js";
import type { FlashResultLike } from "../../server.js";
import { MBFLASH_SERVICE_TYPE, openStore, Store } from "../../store/index.js";
import type { DaplinkDevice } from "../../devices.js";

// ---------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------

interface Harness {
  client: Client;
  startFlash: ReturnType<typeof vi.fn>;
  close(): Promise<void>;
}

function fakeStartFlash(outcome: FlashResultLike = { status: "ok" }): ReturnType<typeof vi.fn> {
  return vi.fn(async () => outcome);
}

async function harness(
  store: Store,
  options: { startFlash?: ReturnType<typeof vi.fn>; enumerateDaplinkDevices?: ReturnType<typeof vi.fn>; clientName?: string } = {},
): Promise<Harness> {
  const startFlash = options.startFlash ?? fakeStartFlash();
  const enumerateDaplinkDevices = options.enumerateDaplinkDevices ?? vi.fn(async () => []);
  const deps: FlashToolsDeps = { store, startFlash, enumerateDaplinkDevices } as unknown as FlashToolsDeps;
  const server = new McpServer({ name: "flash-test-server", version: "0.0.0" });
  registerFlashTools(server, deps);

  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: options.clientName ?? "agent-smith", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return {
    client,
    startFlash,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

function parseToolText(result: { content: Array<{ type: string; text?: string }> }): unknown {
  const first = result.content[0];
  expect(first?.type).toBe("text");
  return JSON.parse(first?.text ?? "");
}

const harnesses: Harness[] = [];
afterEach(async () => {
  while (harnesses.length > 0) {
    const h = harnesses.pop();
    if (h) await h.close();
  }
});

async function makeHarness(store: Store, options: Parameters<typeof harness>[1] = {}): Promise<Harness> {
  const h = await harness(store, options);
  harnesses.push(h);
  return h;
}

// ---------------------------------------------------------------------
// Fixtures -- a USB-flashable device and a network (mbserial)-flashable
// device, mirroring server.test.ts's own gopiv fixture (device id
// 1198504156) for readability/consistency across the two suites.
// ---------------------------------------------------------------------

const DEVICE_ID = 1198504156;
const DEVICE_NAME = deviceIdToName(DEVICE_ID);
const FAKE_USB_DEVICE: DaplinkDevice = { serialNumber: "SERIAL123", displaySerial: "IAL1" } as unknown as DaplinkDevice;

function seedUsbFlashableDevice(store: Store): void {
  store.upsertDevice({ id: DEVICE_ID, name: DEVICE_NAME, kind: "robot", at: 1 });
  store.upsertLink({ id: "usb-SERIAL123", transport: "usb", address: { path: "/dev/x" }, deviceId: DEVICE_ID, at: 1 });
}

function seedNetworkFlashableDevice(store: Store): void {
  store.upsertDevice({ id: DEVICE_ID, name: DEVICE_NAME, kind: "robot", at: 1 });
  store.upsertLink({ id: "mbserial-gopiv", transport: "mbserial", address: { host: "gopiv.local", port: 4000 }, deviceId: DEVICE_ID, at: 1 });
  store.upsertService({ instance: DEVICE_NAME, type: MBFLASH_SERVICE_TYPE, host: "gopiv.local", port: 34567, txt: null, at: 1 });
}

// ---------------------------------------------------------------------
// Valid target: calls startFlash immediately, awaits it, records once
// ---------------------------------------------------------------------

describe("request_flash: a valid target calls startFlash immediately and awaits its terminal outcome", () => {
  it("resolves deviceId to the device's own flashable link and calls startFlash with the resolved linkId/source/identity", async () => {
    const store = openStore({ filePath: ":memory:" });
    try {
      seedUsbFlashableDevice(store);
      const startFlash = fakeStartFlash({ status: "ok" });
      const h = await makeHarness(store, { startFlash, enumerateDaplinkDevices: vi.fn(async () => [FAKE_USB_DEVICE]) });

      const result = await h.client.callTool({ name: "request_flash", arguments: { deviceId: DEVICE_ID, firmwareRef: "robot" } });

      expect(result.isError).toBeFalsy();
      expect(startFlash).toHaveBeenCalledTimes(1);
      expect(startFlash).toHaveBeenCalledWith("usb-SERIAL123", { kind: "release", firmware: "robot" }, { origin: "mcp", caller: "agent-smith" });
    } finally {
      store.close();
    }
  });

  it("also resolves a network (mbserial) flashable device, not only USB", async () => {
    const store = openStore({ filePath: ":memory:" });
    try {
      seedNetworkFlashableDevice(store);
      const startFlash = fakeStartFlash({ status: "ok" });
      const h = await makeHarness(store, { startFlash });

      const result = await h.client.callTool({ name: "request_flash", arguments: { deviceId: DEVICE_ID, firmwareRef: "relay" } });

      expect(result.isError).toBeFalsy();
      expect(startFlash).toHaveBeenCalledWith("mbserial-gopiv", { kind: "release", firmware: "relay" }, { origin: "mcp", caller: "agent-smith" });
    } finally {
      store.close();
    }
  });

  it("on a fake startFlash that resolves {status: 'ok'}, reports success and writes exactly one successful agent_actions row", async () => {
    const store = openStore({ filePath: ":memory:" });
    try {
      seedUsbFlashableDevice(store);
      const h = await makeHarness(store, { enumerateDaplinkDevices: vi.fn(async () => [FAKE_USB_DEVICE]) });

      const result = await h.client.callTool({ name: "request_flash", arguments: { deviceId: DEVICE_ID, firmwareRef: "robot" } });

      expect(result.isError).toBeFalsy();
      const payload = parseToolText(result as { content: Array<{ type: string; text?: string }> }) as { ok: boolean };
      expect(payload.ok).toBe(true);

      const rows = store.recentAgentActions({ deviceId: DEVICE_ID }, 10);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        kind: "flash",
        deviceId: DEVICE_ID,
        linkId: null,
        caller: "agent-smith",
        result: "sent",
        resultReason: null,
        params: { firmwareRef: "robot" },
      });
    } finally {
      store.close();
    }
  });

  it("on a fake startFlash that resolves {status: 'error', error}, reports the failure (including the message) and writes exactly one failed agent_actions row -- never throws", async () => {
    const store = openStore({ filePath: ":memory:" });
    try {
      seedUsbFlashableDevice(store);
      const startFlash = fakeStartFlash({ status: "error", error: "DAPLink write timeout" });
      const h = await makeHarness(store, { startFlash, enumerateDaplinkDevices: vi.fn(async () => [FAKE_USB_DEVICE]) });

      const result = await h.client.callTool({ name: "request_flash", arguments: { deviceId: DEVICE_ID, firmwareRef: "robot" } });

      expect(result.isError).toBe(true);
      const text = ((result.content as Array<{ type: string; text?: string }>)[0]?.text) ?? "";
      expect(text).toContain("DAPLink write timeout");

      const rows = store.recentAgentActions({ deviceId: DEVICE_ID }, 10);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ result: "failed", resultReason: "DAPLink write timeout" });
    } finally {
      store.close();
    }
  });

  it("does not resolve until the fake startFlash promise resolves (a controllable/deferred fake, not a real timer) -- proves the await", async () => {
    const store = openStore({ filePath: ":memory:" });
    try {
      seedUsbFlashableDevice(store);
      let resolveFlash!: (outcome: FlashResultLike) => void;
      const deferred = new Promise<FlashResultLike>((resolve) => {
        resolveFlash = resolve;
      });
      const startFlash = vi.fn(() => deferred);
      const h = await makeHarness(store, { startFlash, enumerateDaplinkDevices: vi.fn(async () => [FAKE_USB_DEVICE]) });

      let settled = false;
      const callPromise = h.client.callTool({ name: "request_flash", arguments: { deviceId: DEVICE_ID, firmwareRef: "robot" } }).then((r) => {
        settled = true;
        return r;
      });

      // Flush pending microtasks (no real timer) without ever resolving
      // `deferred` -- the call must still be pending.
      for (let i = 0; i < 10; i += 1) {
        await Promise.resolve();
      }
      expect(settled).toBe(false);
      expect(startFlash).toHaveBeenCalledTimes(1);

      resolveFlash({ status: "ok" });
      const result = await callPromise;

      expect(settled).toBe(true);
      expect(result.isError).toBeFalsy();
    } finally {
      store.close();
    }
  });

  it("falls back to a placeholder caller when this MCP server/transport pair never processed an initialize handshake -- never null/undefined in the NOT NULL column", async () => {
    // Mirrors drive.test.ts's own identical case: captures the tool's
    // own handler directly off registerTool and invokes it with no
    // transport ever connected, so server.server.getClientVersion() is
    // genuinely undefined.
    const store = openStore({ filePath: ":memory:" });
    try {
      seedUsbFlashableDevice(store);
      const startFlash = fakeStartFlash({ status: "ok" });
      const server = new McpServer({ name: "flash-test-server", version: "0.0.0" });
      let handler: ((args: { deviceId: number; firmwareRef: string }) => Promise<{ isError?: boolean }>) | undefined;
      const originalRegisterTool = server.registerTool.bind(server);
      vi.spyOn(server, "registerTool").mockImplementation((name: string, config: unknown, cb: unknown) => {
        handler = cb as typeof handler;
        return originalRegisterTool(name, config as never, cb as never);
      });
      registerFlashTools(server, { store, startFlash, enumerateDaplinkDevices: vi.fn(async () => [FAKE_USB_DEVICE]) } as unknown as FlashToolsDeps);
      expect(handler).toBeDefined();

      const result = await handler!({ deviceId: DEVICE_ID, firmwareRef: "robot" });

      expect(result.isError).toBeFalsy();
      const rows = store.recentAgentActions({ deviceId: DEVICE_ID }, 10);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.caller).toBe("unknown");
    } finally {
      store.close();
    }
  });
});

// ---------------------------------------------------------------------
// Rejected preconditions: never touches startFlash, never writes a row
// ---------------------------------------------------------------------

describe("request_flash: an invalid or unavailable target is rejected before anything happens", () => {
  it("an unknown deviceId is rejected, calls startFlash never, and writes no agent_actions row", async () => {
    const store = openStore({ filePath: ":memory:" });
    try {
      const startFlash = fakeStartFlash();
      const h = await makeHarness(store, { startFlash });

      const result = await h.client.callTool({ name: "request_flash", arguments: { deviceId: 999999, firmwareRef: "robot" } });

      expect(result.isError).toBe(true);
      const text = ((result.content as Array<{ type: string; text?: string }>)[0]?.text) ?? "";
      expect(text).toContain("999999");
      expect(startFlash).not.toHaveBeenCalled();
      expect(store.recentAgentActions({ deviceId: 999999 }, 10)).toHaveLength(0);
    } finally {
      store.close();
    }
  });

  it("a device with no USB/mbserial/wifi link at all (e.g. only a radio link) is rejected, calls startFlash never, and writes no row", async () => {
    const store = openStore({ filePath: ":memory:" });
    try {
      store.upsertDevice({ id: DEVICE_ID, name: DEVICE_NAME, kind: "robot", at: 1 });
      store.upsertLink({ id: "radio-1", transport: "radio", address: { channel: 1, group: 1 }, deviceId: DEVICE_ID, at: 1 });
      const startFlash = fakeStartFlash();
      const h = await makeHarness(store, { startFlash });

      const result = await h.client.callTool({ name: "request_flash", arguments: { deviceId: DEVICE_ID, firmwareRef: "robot" } });

      expect(result.isError).toBe(true);
      const text = ((result.content as Array<{ type: string; text?: string }>)[0]?.text) ?? "";
      expect(text).toContain("no USB or network-flashable link");
      expect(startFlash).not.toHaveBeenCalled();
      expect(store.recentAgentActions({ deviceId: DEVICE_ID }, 10)).toHaveLength(0);
    } finally {
      store.close();
    }
  });

  it("a USB link with no USB device currently enumerated is rejected with the same reason runFlashTask itself would give -- same precondition, not a new one", async () => {
    const store = openStore({ filePath: ":memory:" });
    try {
      seedUsbFlashableDevice(store);
      const startFlash = fakeStartFlash();
      // enumerateDaplinkDevices returns no matching device -- mirrors
      // server.test.ts's own "no USB device is currently enumerated"
      // flash-start test, same underlying resolveFlashLinkTarget check.
      const h = await makeHarness(store, { startFlash, enumerateDaplinkDevices: vi.fn(async () => []) });

      const result = await h.client.callTool({ name: "request_flash", arguments: { deviceId: DEVICE_ID, firmwareRef: "robot" } });

      expect(result.isError).toBe(true);
      const text = ((result.content as Array<{ type: string; text?: string }>)[0]?.text) ?? "";
      expect(text).toContain("no USB device is currently enumerated");
      expect(startFlash).not.toHaveBeenCalled();
      expect(store.recentAgentActions({ deviceId: DEVICE_ID }, 10)).toHaveLength(0);
    } finally {
      store.close();
    }
  });

  it("a mbserial/wifi device with no current _mbflash._tcp service is rejected, calls startFlash never, and writes no row", async () => {
    const store = openStore({ filePath: ":memory:" });
    try {
      store.upsertDevice({ id: DEVICE_ID, name: DEVICE_NAME, kind: "robot", at: 1 });
      store.upsertLink({ id: "mbserial-gopiv", transport: "mbserial", address: { host: "gopiv.local", port: 4000 }, deviceId: DEVICE_ID, at: 1 });
      // No upsertService call -- no _mbflash._tcp service currently
      // advertised for this device.
      const startFlash = fakeStartFlash();
      const h = await makeHarness(store, { startFlash });

      const result = await h.client.callTool({ name: "request_flash", arguments: { deviceId: DEVICE_ID, firmwareRef: "robot" } });

      expect(result.isError).toBe(true);
      const text = ((result.content as Array<{ type: string; text?: string }>)[0]?.text) ?? "";
      expect(text).toContain("no _mbflash._tcp service is currently advertised");
      expect(startFlash).not.toHaveBeenCalled();
      expect(store.recentAgentActions({ deviceId: DEVICE_ID }, 10)).toHaveLength(0);
    } finally {
      store.close();
    }
  });
});

// ---------------------------------------------------------------------
// tool-call-empty-args.md survivability
// ---------------------------------------------------------------------

describe("request_flash: tool-call-empty-args.md survivability", () => {
  it("{} fails cleanly as a tool error (Zod: deviceId/firmwareRef required), never reaching startFlash", async () => {
    const store = openStore({ filePath: ":memory:" });
    try {
      const startFlash = fakeStartFlash();
      const h = await makeHarness(store, { startFlash });

      const result = await h.client.callTool({ name: "request_flash", arguments: {} });

      expect(result.isError).toBe(true);
      expect(startFlash).not.toHaveBeenCalled();
    } finally {
      store.close();
    }
  });

  it("a firmwareRef outside the two-member enum is rejected by Zod validation", async () => {
    const store = openStore({ filePath: ":memory:" });
    try {
      seedUsbFlashableDevice(store);
      const startFlash = fakeStartFlash();
      const h = await makeHarness(store, { startFlash });

      const result = await h.client.callTool({ name: "request_flash", arguments: { deviceId: DEVICE_ID, firmwareRef: "bogus" } });

      expect(result.isError).toBe(true);
      expect(startFlash).not.toHaveBeenCalled();
    } finally {
      store.close();
    }
  });
});

// ---------------------------------------------------------------------
// Ticket 021-004: outliving a client timeout / surviving a dropped
// connection -- crash-safety, and the durable recovery path.
// ---------------------------------------------------------------------

describe("request_flash: survives a client disconnect while startFlash is still pending (crash-safety, ticket 021-004)", () => {
  it(
    "a send-after-disconnect failure while delivering the settled outcome is caught internally by the SDK -- " +
      "the handler still runs to completion, still writes exactly one agent_actions row, and no exception or " +
      "unhandled rejection ever escapes",
    async () => {
      const store = openStore({ filePath: ":memory:" });
      try {
        seedUsbFlashableDevice(store);
        let resolveFlash!: (outcome: FlashResultLike) => void;
        const deferred = new Promise<FlashResultLike>((resolve) => {
          resolveFlash = resolve;
        });
        const startFlash = vi.fn(() => deferred);
        const deps: FlashToolsDeps = {
          store,
          startFlash,
          enumerateDaplinkDevices: vi.fn(async () => [FAKE_USB_DEVICE]),
        } as unknown as FlashToolsDeps;

        const server = new McpServer({ name: "flash-disconnect-test-server", version: "0.0.0" });
        registerFlashTools(server, deps);

        // The low-level Server's onerror -- exactly the callback the
        // SDK's `Protocol._onrequest` (shared/protocol.js) invokes via
        // `.catch(error => this._onerror(...))` once `capturedTransport
        // .send(response)` rejects. Never an uncaught throw, never an
        // unhandled rejection -- see the assertions below.
        const sdkErrors: unknown[] = [];
        server.server.onerror = (error: unknown) => {
          sdkErrors.push(error);
        };

        const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
        const client = new Client({ name: "agent-smith", version: "0.0.0" });

        const unhandled: unknown[] = [];
        const onUnhandledRejection = (reason: unknown): void => {
          unhandled.push(reason);
        };
        process.on("unhandledRejection", onUnhandledRejection);

        try {
          await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

          // Break delivery on the server's own transport from here on --
          // this is what a real StreamableHTTPServerTransport does once
          // the caller's own SSE stream/connection is gone (its `send()`
          // throws "No connection established for request ID: ...", see
          // `@modelcontextprotocol/sdk`'s `webStandardStreamableHttp.js`).
          // The session/transport itself stays connected throughout --
          // exactly like a real MCP session surviving one caller giving
          // up on one call -- only *this* delivery fails; nothing here
          // calls transport.close() or fires onclose, which would (via
          // Protocol._onclose's abortController.abort()) short-circuit
          // the very send() call this test needs to exercise.
          const originalSend = serverTransport.send.bind(serverTransport);
          let breakDelivery = false;
          serverTransport.send = vi.fn(async (message: unknown, options?: unknown) => {
            if (breakDelivery) {
              throw new Error("write after close: the client's own connection is gone");
            }
            return originalSend(message as never, options as never);
          });

          // Not awaited to completion -- once `breakDelivery` flips, the
          // server can never deliver a response to this call, so the
          // client's own promise only ever settles (rejects, on its own
          // 60s request timeout) once `client.close()` tears the session
          // down in the `finally` below. `.catch()` here just keeps that
          // eventual rejection from ever surfacing as unhandled -- this
          // test's job is the *server's* behavior, not the client's.
          const callPromise = client
            .callTool({ name: "request_flash", arguments: { deviceId: DEVICE_ID, firmwareRef: "robot" } })
            .catch((error: unknown) => error);
          void callPromise;

          // Let startFlash actually get invoked before "disconnecting" --
          // waitFor rather than a fixed microtask-flush count since the
          // precondition check's own resolveFlashLinkTarget call is
          // genuinely async (enumerateDaplinkDevices).
          await vi.waitFor(() => expect(startFlash).toHaveBeenCalledTimes(1));

          breakDelivery = true;

          // The flash itself settles well after the simulated disconnect
          // -- server-side execution is unconditional and keeps going
          // regardless (this file's own module doc comment).
          resolveFlash({ status: "ok" });

          // (a) + (b): the handler ran to completion and wrote exactly
          // one agent_actions row with the real outcome, regardless of
          // whether the caller was still there to receive it. waitFor
          // rather than a fixed microtask-flush count for the same
          // genuinely-async reason as above.
          await vi.waitFor(() => {
            expect(store.recentAgentActions({ deviceId: DEVICE_ID }, 10)).toHaveLength(1);
          });
          const rows = store.recentAgentActions({ deviceId: DEVICE_ID }, 10);
          expect(rows[0]).toMatchObject({ kind: "flash", deviceId: DEVICE_ID, result: "sent" });

          // The undeliverable-response failure did happen -- proving this
          // test actually exercised the risky path, not a no-op.
          await vi.waitFor(() => expect(sdkErrors.length).toBeGreaterThan(0));

          // (c): but it never escaped as an uncaught exception or an
          // unhandled promise rejection -- the SDK's own
          // `.catch(error => this._onerror(...))` swallowed it. This is
          // the process-crash risk this ticket asks to verify; it does
          // not happen.
          expect(unhandled).toEqual([]);
        } finally {
          process.off("unhandledRejection", onUnhandledRejection);
          await client.close().catch(() => {});
          await server.close().catch(() => {});
        }
      } finally {
        store.close();
      }
    },
  );
});

describe("request_flash: the durable recovery path a timed-out caller is told to use (ticket 021-004)", () => {
  it("get_device_status's recentAgentActions[0] surfaces a recorded flash outcome's kind/caller/result/resultReason correctly", async () => {
    const store = openStore({ filePath: ":memory:" });
    try {
      seedUsbFlashableDevice(store);
      // Written the same way the disconnect test above proves happens
      // even once the caller can no longer hear it -- record() itself
      // doesn't know or care whether anyone is still listening.
      record(store, {
        kind: "flash",
        deviceId: DEVICE_ID,
        params: { firmwareRef: "robot" },
        caller: "agent-smith",
        executedAt: Date.now(),
        result: "failed",
        resultReason: "DAPLink write timeout",
      });

      const server = new McpServer({ name: "flash-recovery-test-server", version: "0.0.0" });
      registerInspectTools(server, store);
      const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "agent-smith", version: "0.0.0" });
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      try {
        const result = await client.callTool({ name: "get_device_status", arguments: { name: DEVICE_NAME } });
        expect(result.isError).toBeFalsy();
        const payload = parseToolText(result as { content: Array<{ type: string; text?: string }> }) as {
          recentAgentActions: Array<{ kind: string; caller: string; summary: string }>;
        };
        expect(payload.recentAgentActions[0]).toMatchObject({ kind: "flash", caller: "agent-smith" });
        expect(payload.recentAgentActions[0]!.summary).toContain("failed: DAPLink write timeout");
      } finally {
        await client.close();
        await server.close();
      }
    } finally {
      store.close();
    }
  });
});

// ---------------------------------------------------------------------
// No gate, ever: this ticket's own negative-space guarantee
// ---------------------------------------------------------------------

describe("request_flash: no approval/lifecycle vocabulary (negative-space test)", () => {
  const FORBIDDEN = [/\bapprove/i, /\bdeny\b/i, /\bdenied\b/i, /\bpending\b/i, /\bdecided_at\b/i, /\bdecided_reason\b/i, /\bTTL\b/, /\bqueue\b/i];

  it("flash.ts's own code (comments stripped) contains none of the superseded pending_actions design's vocabulary", async () => {
    const { readFileSync } = await import("node:fs");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const thisDir = path.dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(path.join(thisDir, "flash.ts"), "utf8");
    const stripped = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    for (const pattern of FORBIDDEN) {
      expect(stripped).not.toMatch(pattern);
    }
  });
});
