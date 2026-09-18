/**
 * connect.test.ts — sprint 019 ticket 005's own suite for `open_session`/
 * `close_session`/`send_command` (SUC-005). Exercises the real MCP
 * protocol machinery (Zod validation, tool dispatch, `CallToolResult`
 * shaping) via the SDK's own `InMemoryTransport.createLinkedPair()` and a
 * real `Client` -- the same harness shape `mcp/tools/inspect.test.ts`
 * uses, and for the same reason: this is the right place to prove the
 * *tools themselves* behave correctly (including against the harness's
 * documented empty-argument bug), independent of `mcp/server.ts`'s own
 * Express/session-continuity plumbing (covered by `mcp/server.test.ts`).
 *
 * A single persistent `Client`/`Server` connection (not a fresh pair per
 * call) is used throughout, matching how a real MCP session actually
 * behaves once `mcp/server.ts`'s own session continuity (this ticket)
 * keeps one pair alive for a session's lifetime -- so `client.connect()`
 * here really does perform the same `initialize` handshake
 * `getClientVersion()` reads from, exactly as it would in production
 * once a real client's session is established.
 *
 * A real, `:memory:` `Store` backs every test (never a hand-built fake)
 * so `setSessionIdentity`'s own conditional-change/reset behavior is
 * exercised against the real schema -- only the reconciler (an
 * inherently async, timer-driven collaborator with no in-memory-SQLite
 * equivalent) is faked, mirroring `connect/sessionOps.test.ts`'s own
 * `fakeReconciler` convention.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerConnectTools, GATED_MOTION_VERBS, type ConnectToolsDeps, type ConnectToolsReconciler } from "./connect.js";
import { openStore, Store } from "../../store/index.js";
import type { ConnectedSession } from "../../connect/connector.js";

// ---------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------

interface Harness {
  client: Client;
  reconciler: ConnectToolsReconciler & {
    requestOpen: ReturnType<typeof vi.fn>;
    requestClose: ReturnType<typeof vi.fn>;
    sessions: { get: ReturnType<typeof vi.fn> };
  };
  close(): Promise<void>;
}

function fakeReconciler(overrides: { requestOpen?: ReturnType<typeof vi.fn>; sessionsGet?: ReturnType<typeof vi.fn> } = {}) {
  return {
    requestOpen: overrides.requestOpen ?? vi.fn(async () => ({})),
    requestClose: vi.fn(async () => undefined),
    sessions: { get: overrides.sessionsGet ?? vi.fn(() => undefined) },
  };
}

async function harness(
  store: Store,
  options: { reconciler?: ReturnType<typeof fakeReconciler>; clientName?: string } = {},
): Promise<Harness> {
  const reconciler = options.reconciler ?? fakeReconciler();
  const deps: ConnectToolsDeps = { store, reconciler };
  const server = new McpServer({ name: "connect-test-server", version: "0.0.0" });
  registerConnectTools(server, deps);

  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: options.clientName ?? "agent-smith", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return {
    client,
    reconciler,
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
// open_session
// ---------------------------------------------------------------------

describe("open_session", () => {
  it("{linkId}: opens through the reconciler, tags the session origin 'mcp'/caller from clientInfo.name, and reports ok", async () => {
    const store = openStore({ filePath: ":memory:" });
    try {
      store.upsertLink({ id: "link-1", transport: "usb", address: {}, at: 1 });
      const requestOpen = vi.fn(async (linkId: string) => {
        // The real open path (connector.ts) writes the sessions row
        // before requestOpen resolves -- fake that here.
        store.openSession(linkId, Date.now());
        return {};
      });
      const h = await makeHarness(store, { reconciler: fakeReconciler({ requestOpen }), clientName: "agent-smith" });

      const result = await h.client.callTool({ name: "open_session", arguments: { linkId: "link-1" } });

      expect(result.isError).toBeFalsy();
      expect(requestOpen).toHaveBeenCalledWith("link-1");
      const payload = parseToolText(result as { content: Array<{ type: string; text?: string }> }) as { ok: boolean; linkId: string; caller: string | null };
      expect(payload).toEqual({ ok: true, linkId: "link-1", caller: "agent-smith" });

      const row = store.projectionRows().sessions.find((s) => s.linkId === "link-1");
      expect(row).toMatchObject({ origin: "mcp", caller: "agent-smith" });
    } finally {
      store.close();
    }
  });

  it("{relayLinkId, name}: derives the child link id and returns it", async () => {
    const store = openStore({ filePath: ":memory:" });
    try {
      const requestOpen = vi.fn(async (linkId: string) => {
        store.openSession(linkId, Date.now());
        return {};
      });
      const h = await makeHarness(store, { reconciler: fakeReconciler({ requestOpen }) });

      const result = await h.client.callTool({ name: "open_session", arguments: { relayLinkId: "usb-relay1", name: "vevov" } });

      expect(result.isError).toBeFalsy();
      expect(requestOpen).toHaveBeenCalledWith("radio-vevov-via-usb-relay1");
      const payload = parseToolText(result as { content: Array<{ type: string; text?: string }> }) as { linkId: string };
      expect(payload.linkId).toBe("radio-vevov-via-usb-relay1");
    } finally {
      store.close();
    }
  });

  it("a refused open (e.g. already held) is a plain-language tool error, not a crash -- and never overwrites the existing session's identity", async () => {
    const store = openStore({ filePath: ":memory:" });
    try {
      store.upsertLink({ id: "link-1", transport: "usb", address: {}, at: 1 });
      store.openSession("link-1", 1); // someone else already holds it
      const requestOpen = vi.fn(async () => ({ refusedReason: "already connected" }));
      const h = await makeHarness(store, { reconciler: fakeReconciler({ requestOpen }) });

      const result = await h.client.callTool({ name: "open_session", arguments: { linkId: "link-1" } });

      expect(result.isError).toBe(true);
      const text = ((result.content as Array<{ type: string; text?: string }>)[0]?.text) ?? "";
      expect(text).toContain("already connected");
      const row = store.projectionRows().sessions.find((s) => s.linkId === "link-1");
      expect(row).toMatchObject({ origin: "ui", caller: null });
    } finally {
      store.close();
    }
  });

  it("a dispatched job that fails to connect (contention, no refusedReason) is reported as a plain-language error naming the link's own failure reason", async () => {
    const store = openStore({ filePath: ":memory:" });
    try {
      store.upsertLink({ id: "link-1", transport: "usb", address: {}, at: 1 });
      store.setLinkState({ id: "link-1", state: "failed", at: 2, reason: "ERR busy" });
      // No session row is ever created -- the dispatched job failed.
      const requestOpen = vi.fn(async () => ({}));
      const h = await makeHarness(store, { reconciler: fakeReconciler({ requestOpen }) });

      const result = await h.client.callTool({ name: "open_session", arguments: { linkId: "link-1" } });

      expect(result.isError).toBe(true);
      const text = ((result.content as Array<{ type: string; text?: string }>)[0]?.text) ?? "";
      expect(text).toContain("ERR busy");
    } finally {
      store.close();
    }
  });

  describe("tool-call-empty-args.md survivability", () => {
    it("{} is rejected with a plain-language error naming both accepted shapes, not silently misinterpreted", async () => {
      const store = openStore({ filePath: ":memory:" });
      try {
        const h = await makeHarness(store);
        const result = await h.client.callTool({ name: "open_session", arguments: {} });
        expect(result.isError).toBe(true);
        const text = ((result.content as Array<{ type: string; text?: string }>)[0]?.text) ?? "";
        expect(text).toContain("linkId");
        expect(text).toContain("relayLinkId");
        expect(h.reconciler.requestOpen).not.toHaveBeenCalled();
      } finally {
        store.close();
      }
    });

    it("a relayLinkId with no name (as the harness bug would produce) is rejected, not treated as a bare linkId", async () => {
      const store = openStore({ filePath: ":memory:" });
      try {
        const h = await makeHarness(store);
        const result = await h.client.callTool({ name: "open_session", arguments: { relayLinkId: "usb-relay1" } });
        expect(result.isError).toBe(true);
        expect(h.reconciler.requestOpen).not.toHaveBeenCalled();
      } finally {
        store.close();
      }
    });

    it("linkId AND relayLinkId+name together (ambiguous) is rejected", async () => {
      const store = openStore({ filePath: ":memory:" });
      try {
        const h = await makeHarness(store);
        const result = await h.client.callTool({ name: "open_session", arguments: { linkId: "link-1", relayLinkId: "usb-relay1", name: "vevov" } });
        expect(result.isError).toBe(true);
        expect(h.reconciler.requestOpen).not.toHaveBeenCalled();
      } finally {
        store.close();
      }
    });

    it("an empty-string linkId is rejected by Zod validation, not treated as a valid (if odd) open", async () => {
      const store = openStore({ filePath: ":memory:" });
      try {
        const h = await makeHarness(store);
        const result = await h.client.callTool({ name: "open_session", arguments: { linkId: "" } });
        expect(result.isError).toBe(true);
      } finally {
        store.close();
      }
    });
  });
});

// ---------------------------------------------------------------------
// close_session
// ---------------------------------------------------------------------

describe("close_session", () => {
  it("closes through the reconciler and reports ok", async () => {
    const store = openStore({ filePath: ":memory:" });
    try {
      const h = await makeHarness(store);
      const result = await h.client.callTool({ name: "close_session", arguments: { linkId: "link-1" } });
      expect(result.isError).toBeFalsy();
      expect(h.reconciler.requestClose).toHaveBeenCalledWith("link-1");
    } finally {
      store.close();
    }
  });

  it("{} fails cleanly as a tool error (Zod: linkId required)", async () => {
    const store = openStore({ filePath: ":memory:" });
    try {
      const h = await makeHarness(store);
      const result = await h.client.callTool({ name: "close_session", arguments: {} });
      expect(result.isError).toBe(true);
      expect(h.reconciler.requestClose).not.toHaveBeenCalled();
    } finally {
      store.close();
    }
  });
});

// ---------------------------------------------------------------------
// send_command
// ---------------------------------------------------------------------

function fakeSession(overrides: { sendCommand?: ReturnType<typeof vi.fn>; sendUnsequencedQuery?: ReturnType<typeof vi.fn> } = {}): ConnectedSession {
  const link = {
    sendCommand: overrides.sendCommand ?? vi.fn(() => "OK\n"),
    sendUnsequencedQuery: overrides.sendUnsequencedQuery ?? vi.fn(() => "OK\n"),
  };
  return { linkId: "link-1", deviceId: 1, transport: "usb", link, classification: { type: "robot" } } as unknown as ConnectedSession;
}

describe("send_command", () => {
  it("sends an allowed verb (e.g. STATUS) through the open session and reports the wire line sent", async () => {
    const store = openStore({ filePath: ":memory:" });
    try {
      const sendUnsequencedQuery = vi.fn(() => "STATUS\n");
      const session = fakeSession({ sendUnsequencedQuery });
      const h = await makeHarness(store, { reconciler: fakeReconciler({ sessionsGet: vi.fn(() => session) }) });

      const result = await h.client.callTool({ name: "send_command", arguments: { linkId: "link-1", verb: "STATUS" } });

      expect(result.isError).toBeFalsy();
      expect(sendUnsequencedQuery).toHaveBeenCalledWith("STATUS", []);
      const payload = parseToolText(result as { content: Array<{ type: string; text?: string }> }) as { ok: boolean; sent: string };
      expect(payload).toEqual({ ok: true, sent: "STATUS" });
    } finally {
      store.close();
    }
  });

  it.each([...GATED_MOTION_VERBS])("rejects the gated motion verb %s, naming request_drive, with no write performed", async (verb) => {
    const store = openStore({ filePath: ":memory:" });
    try {
      const sendCommand = vi.fn();
      const sendUnsequencedQuery = vi.fn();
      const session = fakeSession({ sendCommand, sendUnsequencedQuery });
      const h = await makeHarness(store, { reconciler: fakeReconciler({ sessionsGet: vi.fn(() => session) }) });

      const result = await h.client.callTool({ name: "send_command", arguments: { linkId: "link-1", verb, fields: ["1", "2"] } });

      expect(result.isError).toBe(true);
      const text = ((result.content as Array<{ type: string; text?: string }>)[0]?.text) ?? "";
      expect(text).toContain("request_drive");
      expect(sendCommand).not.toHaveBeenCalled();
      expect(sendUnsequencedQuery).not.toHaveBeenCalled();
    } finally {
      store.close();
    }
  });

  it.each(["STOP", "ESTOP"])("always allows %s through, unconditionally", async (verb) => {
    const store = openStore({ filePath: ":memory:" });
    try {
      const sendCommand = vi.fn(() => `${verb}\n`);
      const sendUnsequencedQuery = vi.fn(() => `${verb}\n`);
      const session = fakeSession({ sendCommand, sendUnsequencedQuery });
      const h = await makeHarness(store, { reconciler: fakeReconciler({ sessionsGet: vi.fn(() => session) }) });

      const result = await h.client.callTool({ name: "send_command", arguments: { linkId: "link-1", verb } });

      expect(result.isError).toBeFalsy();
    } finally {
      store.close();
    }
  });

  it("a gated verb sent lowercase is still rejected (case-insensitive)", async () => {
    const store = openStore({ filePath: ":memory:" });
    try {
      const session = fakeSession();
      const h = await makeHarness(store, { reconciler: fakeReconciler({ sessionsGet: vi.fn(() => session) }) });

      const result = await h.client.callTool({ name: "send_command", arguments: { linkId: "link-1", verb: "wheels_x" } });

      expect(result.isError).toBe(true);
    } finally {
      store.close();
    }
  });

  it("no open session on the link is a plain tool error, not a crash", async () => {
    const store = openStore({ filePath: ":memory:" });
    try {
      const h = await makeHarness(store, { reconciler: fakeReconciler({ sessionsGet: vi.fn(() => undefined) }) });

      const result = await h.client.callTool({ name: "send_command", arguments: { linkId: "link-1", verb: "STATUS" } });

      expect(result.isError).toBe(true);
      const text = ((result.content as Array<{ type: string; text?: string }>)[0]?.text) ?? "";
      expect(text).toContain("no open session");
    } finally {
      store.close();
    }
  });

  it("fields defaults to [] when omitted", async () => {
    const store = openStore({ filePath: ":memory:" });
    try {
      const sendUnsequencedQuery = vi.fn(() => "ID\n");
      const session = fakeSession({ sendUnsequencedQuery });
      const h = await makeHarness(store, { reconciler: fakeReconciler({ sessionsGet: vi.fn(() => session) }) });

      await h.client.callTool({ name: "send_command", arguments: { linkId: "link-1", verb: "ID" } });

      expect(sendUnsequencedQuery).toHaveBeenCalledWith("ID", []);
    } finally {
      store.close();
    }
  });

  it("{} fails cleanly as a tool error (Zod: linkId/verb required)", async () => {
    const store = openStore({ filePath: ":memory:" });
    try {
      const h = await makeHarness(store);
      const result = await h.client.callTool({ name: "send_command", arguments: {} });
      expect(result.isError).toBe(true);
    } finally {
      store.close();
    }
  });
});
