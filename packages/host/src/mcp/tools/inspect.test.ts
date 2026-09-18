/**
 * inspect.test.ts — sprint 019 ticket 004's own suite for `list_devices`/
 * `get_device_status` (SUC-004). Exercises the real MCP protocol
 * machinery (Zod input validation, tool dispatch, `CallToolResult`
 * shaping) via the SDK's own `InMemoryTransport.createLinkedPair()` and a
 * real `Client` -- no socket, no HTTP, no `mcp/server.ts` involved at
 * all, which is exactly what makes this the right place (rather than
 * `mcp/server.test.ts`) to prove the tools themselves behave correctly,
 * including against the harness's documented empty-argument bug
 * (`.claude/rules/tool-call-empty-args.md`).
 *
 * The golden-comparison test seeds a real, `:memory:` `Store` (never a
 * hand-built `ProjectionRows` object) and asserts both tools agree with
 * `buildSnapshot`'s own output for that exact state -- mirroring
 * `projection.test.ts`'s own golden-fixture discipline, per this
 * ticket's acceptance criterion.
 *
 * The "never writes" tests use the real `Store` class (not a fake) with
 * `vi.spyOn` on every write method that touches `links`/`sessions`/
 * `board_owner`/`relay_leases` -- the four tables this ticket's own
 * acceptance criterion names -- so "neither tool writes" is asserted
 * against production code, not merely against a fake that happens not to
 * expose a write method.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerInspectTools, type InspectStore } from "./inspect.js";
import { buildSnapshot } from "../../projection.js";
import { openStore, Store } from "../../store/index.js";

// ---------------------------------------------------------------------
// Harness: a real McpServer with the inspect tools registered, talking
// to a real Client over an in-memory transport pair.
// ---------------------------------------------------------------------

interface Harness {
  client: Client;
  close(): Promise<void>;
}

async function connect(store: InspectStore): Promise<Harness> {
  const server = new McpServer({ name: "inspect-test-server", version: "0.0.0" });
  registerInspectTools(server, store);

  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "inspect-test-client", version: "0.0.0" });

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return {
    client,
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

async function harness(store: InspectStore): Promise<Harness> {
  const h = await connect(store);
  harnesses.push(h);
  return h;
}

// ---------------------------------------------------------------------
// Golden comparison against a real Store + buildSnapshot
// ---------------------------------------------------------------------

/** A small scenario covering an owned robot with an open USB session
 * (robotStatus/functions populated) plus an unassigned USB board --
 * enough to exercise both tools' full shape without duplicating
 * `projection.test.ts`'s own larger golden fixture. */
function seedScenario(store: Store): void {
  store.upsertDevice({ id: 1198504156, name: "vevov", kind: "robot", role: "NEZHA2", program: "diffdrive", version: "1.0.0", usbSerial: "SERIAL-VEVOV", at: 100 });
  store.setOwned(1198504156, true, 100);
  store.upsertLink({ id: "usb-vevov", transport: "usb", address: { path: "/dev/tty.usbmodem-vevov" }, deviceId: 1198504156, at: 100 });
  store.setLinkState({ id: "usb-vevov", state: "connected", at: 110 });
  store.openSession("usb-vevov", 110);
  store.updateSession("usb-vevov", {
    seq: 2,
    pending: 0,
    lastDone: 2,
    lastDoneReason: "ok",
    robotStatus: JSON.stringify({ receivedAt: 120, fields: { flags: "1" }, ready: true, active: true, estopped: false, stallHalted: false, leaseExpired: false }),
    functions: [{ name: "drive", signature: "n n" }],
  });
  store.upsertLink({ id: "usb-unknown-1", transport: "usb", address: { path: "/dev/tty.usbmodem-unknown" }, at: 97 });
}

describe("list_devices / get_device_status: golden comparison against buildSnapshot", () => {
  it("list_devices agrees field-for-field with buildSnapshot's own devices/unassigned for the same store state", async () => {
    const store = openStore({ filePath: ":memory:" });
    try {
      seedScenario(store);
      const h = await harness(store);

      const result = await h.client.callTool({ name: "list_devices", arguments: {} });
      expect(result.isError).toBeFalsy();
      const payload = parseToolText(result as { content: Array<{ type: string; text?: string }> }) as { devices: unknown; unassigned: unknown };

      const expected = buildSnapshot(store, 0, 0);
      expect(payload.devices).toEqual(expected.devices);
      expect(payload.unassigned).toEqual(expected.unassigned);
    } finally {
      store.close();
    }
  });

  it("get_device_status {name} returns exactly the same device entry buildSnapshot produces, including session robotStatus/functions", async () => {
    const store = openStore({ filePath: ":memory:" });
    try {
      seedScenario(store);
      const h = await harness(store);

      const result = await h.client.callTool({ name: "get_device_status", arguments: { name: "vevov" } });
      expect(result.isError).toBeFalsy();
      const device = parseToolText(result as { content: Array<{ type: string; text?: string }> });

      const expected = buildSnapshot(store, 0, 0).devices.find((d) => d.name === "vevov");
      expect(expected).toBeDefined();
      expect(device).toEqual(expected);
    } finally {
      store.close();
    }
  });
});

// ---------------------------------------------------------------------
// The harness's documented empty-argument bug: any call arriving as `{}`
// must behave *correctly*, not degrade silently.
// ---------------------------------------------------------------------

describe("tool-call-empty-args.md survivability", () => {
  it("list_devices takes no arguments at all -- a call arriving as {} (the bug's own worst case) IS the tool's only valid input, and succeeds", async () => {
    const store = openStore({ filePath: ":memory:" });
    try {
      const h = await harness(store);
      const result = await h.client.callTool({ name: "list_devices", arguments: {} });
      expect(result.isError).toBeFalsy();
      expect(parseToolText(result as { content: Array<{ type: string; text?: string }> })).toEqual({ devices: [], unassigned: [] });
    } finally {
      store.close();
    }
  });

  it("get_device_status called with {} (name silently dropped, as the harness bug would produce) fails cleanly as a tool error, not a crash or a wrong-device answer", async () => {
    const store = openStore({ filePath: ":memory:" });
    try {
      seedScenario(store);
      const h = await harness(store);
      const result = await h.client.callTool({ name: "get_device_status", arguments: {} });
      // The SDK's own validateToolInput -> createToolError path: a Zod
      // validation failure becomes an ordinary CallToolResult with
      // isError: true, never a thrown/rejected client-side exception --
      // exactly the "well-defined absent representation" this ticket's
      // acceptance criterion asks for.
      expect(result.isError).toBe(true);
    } finally {
      store.close();
    }
  });

  it("get_device_status called with an empty-string name is rejected by validation, not treated as a valid (if odd) lookup", async () => {
    const store = openStore({ filePath: ":memory:" });
    try {
      const h = await harness(store);
      const result = await h.client.callTool({ name: "get_device_status", arguments: { name: "" } });
      expect(result.isError).toBe(true);
    } finally {
      store.close();
    }
  });

  it("get_device_status for an unknown name returns a plain tool error naming the device, not a thrown exception", async () => {
    const store = openStore({ filePath: ":memory:" });
    try {
      const h = await harness(store);
      const result = await h.client.callTool({ name: "get_device_status", arguments: { name: "zzzzz" } });
      expect(result.isError).toBe(true);
      const text = ((result.content as Array<{ type: string; text?: string }>)[0]?.text) ?? "";
      expect(text).toContain("zzzzz");
    } finally {
      store.close();
    }
  });
});

// ---------------------------------------------------------------------
// No side effects, under any input, on the real Store class.
// ---------------------------------------------------------------------

describe("no writes under any input (SUC-004 acceptance criterion)", () => {
  function spyOnWrites(store: Store) {
    return {
      links: [vi.spyOn(store, "upsertLink"), vi.spyOn(store, "setLinkState"), vi.spyOn(store, "deleteLink")],
      sessions: [vi.spyOn(store, "openSession"), vi.spyOn(store, "updateSession"), vi.spyOn(store, "closeSession")],
      boardOwner: [vi.spyOn(store, "acquireBoardOwner"), vi.spyOn(store, "releaseBoardOwner")],
      relayLeases: [vi.spyOn(store, "acquireRelayLease"), vi.spyOn(store, "releaseRelayLease")],
    };
  }

  function assertNoneCalled(spies: ReturnType<typeof spyOnWrites>): void {
    for (const group of Object.values(spies)) {
      for (const spy of group) {
        expect(spy).not.toHaveBeenCalled();
      }
    }
  }

  it("list_devices never writes to links/sessions/board_owner/relay_leases", async () => {
    const store = openStore({ filePath: ":memory:" });
    try {
      seedScenario(store);
      const spies = spyOnWrites(store);
      const h = await harness(store);

      await h.client.callTool({ name: "list_devices", arguments: {} });

      assertNoneCalled(spies);
    } finally {
      store.close();
    }
  });

  it("get_device_status never writes -- valid lookup, unknown name, empty string, and missing key alike", async () => {
    const store = openStore({ filePath: ":memory:" });
    try {
      seedScenario(store);
      const spies = spyOnWrites(store);
      const h = await harness(store);

      await h.client.callTool({ name: "get_device_status", arguments: { name: "vevov" } });
      await h.client.callTool({ name: "get_device_status", arguments: { name: "zzzzz" } });
      await h.client.callTool({ name: "get_device_status", arguments: { name: "" } });
      await h.client.callTool({ name: "get_device_status", arguments: {} });

      assertNoneCalled(spies);
    } finally {
      store.close();
    }
  });
});
