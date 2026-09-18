/**
 * drive.test.ts — sprint 019 ticket 007's own suite for `request_drive`
 * (SUC-006). Exercises the real MCP protocol machinery (Zod validation,
 * tool dispatch, `CallToolResult` shaping) via the SDK's own
 * `InMemoryTransport.createLinkedPair()` and a real `Client`, mirroring
 * `mcp/tools/connect.test.ts`'s own harness shape and rationale.
 *
 * A real, `:memory:` `Store` backs every test (never a hand-built fake)
 * so `agentActionLog.record()`'s own write/read discipline is exercised
 * against the real schema; only the reconciler's session lookup is
 * faked, mirroring `connect.test.ts`'s own `fakeReconciler` convention
 * (this file needs only its `sessions.get`, per {@link DriveToolsReconciler}).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerDriveTools, DRIVE_VERB_VALIDATOR_KEYS, type DriveToolsDeps, type DriveToolsReconciler } from "./drive.js";
import { GATED_MOTION_VERBS } from "./connect.js";
import { openStore, Store } from "../../store/index.js";
import type { ConnectedSession } from "../../connect/connector.js";

// ---------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------

interface Harness {
  client: Client;
  reconciler: DriveToolsReconciler & { sessions: { get: ReturnType<typeof vi.fn> } };
  close(): Promise<void>;
}

function fakeReconciler(sessionsGet?: ReturnType<typeof vi.fn>): DriveToolsReconciler & { sessions: { get: ReturnType<typeof vi.fn> } } {
  return { sessions: { get: sessionsGet ?? vi.fn(() => undefined) } };
}

function fakeSession(overrides: { sendCommand?: ReturnType<typeof vi.fn>; sendUnsequencedQuery?: ReturnType<typeof vi.fn> } = {}): ConnectedSession {
  const link = {
    sendCommand: overrides.sendCommand ?? vi.fn(() => "OK\n"),
    sendUnsequencedQuery: overrides.sendUnsequencedQuery ?? vi.fn(() => "OK\n"),
  };
  return { linkId: "link-1", deviceId: 1, transport: "usb", link, classification: { type: "robot" } } as unknown as ConnectedSession;
}

async function harness(
  store: Store,
  options: { reconciler?: ReturnType<typeof fakeReconciler>; clientName?: string } = {},
): Promise<Harness> {
  const reconciler = options.reconciler ?? fakeReconciler();
  const deps: DriveToolsDeps = { store, reconciler };
  const server = new McpServer({ name: "drive-test-server", version: "0.0.0" });
  registerDriveTools(server, deps);

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
// Allowlist consistency
// ---------------------------------------------------------------------

describe("request_drive: allowlist consistency", () => {
  it("validates exactly the same seven verbs mcp/tools/connect.ts's GATED_MOTION_VERBS gates, never redefining its own set", () => {
    expect(DRIVE_VERB_VALIDATOR_KEYS).toEqual(GATED_MOTION_VERBS);
    expect([...DRIVE_VERB_VALIDATOR_KEYS].sort()).toEqual(["GO_TO_R", "GO_TO_W", "MOVE_V", "MOVE_X", "RUN", "WHEELS_V", "WHEELS_X"]);
  });
});

// ---------------------------------------------------------------------
// Each of the seven allowlisted verbs: valid fields -> sendCommand ->
// exactly one agent_actions row (SUC-006's "full path" acceptance
// criterion)
// ---------------------------------------------------------------------

describe("request_drive: valid calls execute immediately and are recorded", () => {
  const VALID_FIELDS: Record<string, ReadonlyArray<string | number>> = {
    WHEELS_X: [100, -100, 50, 2000],
    WHEELS_V: [50, -50, 1000],
    MOVE_X: [100, 0, 50, 2000],
    MOVE_V: [50, 0, 1000],
    GO_TO_R: [100, 100, 50, 10, 5000],
    GO_TO_W: [100, 100, 50, 10, 5000],
    RUN: ["tour", "1", "2"],
  };

  it.each([...GATED_MOTION_VERBS])("%s: calls sendCommand with the exact verb/fields and writes exactly one agent_actions row", async (verb) => {
    const store = openStore({ filePath: ":memory:" });
    try {
      const sendCommand = vi.fn(() => `${verb}\n`);
      const session = fakeSession({ sendCommand });
      const h = await makeHarness(store, { reconciler: fakeReconciler(vi.fn(() => session)) });

      const fields = VALID_FIELDS[verb]!;
      const result = await h.client.callTool({ name: "request_drive", arguments: { linkId: "link-1", verb, fields: [...fields] } });

      expect(result.isError).toBeFalsy();
      expect(sendCommand).toHaveBeenCalledTimes(1);
      expect(sendCommand).toHaveBeenCalledWith(verb, [...fields]);

      const payload = parseToolText(result as { content: Array<{ type: string; text?: string }> }) as { ok: boolean; sent: string };
      expect(payload).toEqual({ ok: true, sent: verb });

      const rows = store.recentAgentActions({ linkId: "link-1" }, 10);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        kind: "drive",
        linkId: "link-1",
        deviceId: null,
        caller: "agent-smith",
        result: "sent",
        resultReason: null,
        params: { verb, fields: [...fields] },
      });
    } finally {
      store.close();
    }
  });

  it("falls back to a placeholder caller when this MCP server/transport pair never processed an initialize handshake -- never null/undefined in the NOT NULL column", async () => {
    // Deliberately bypasses this file's own harness() (which always
    // connects a real Client, so getClientVersion() would always return
    // that Client's real name) -- mirrors mcp/tools/connect.ts's own
    // doc comment on exactly this condition (a server instance that
    // never itself handled `initialize`). Captures the tool's own
    // handler directly off `registerTool` and invokes it with no
    // transport ever connected, so `server.server.getClientVersion()`
    // is genuinely `undefined`.
    const store = openStore({ filePath: ":memory:" });
    try {
      const session = fakeSession();
      const server = new McpServer({ name: "drive-test-server", version: "0.0.0" });
      let handler: ((args: { linkId: string; verb: string; fields: ReadonlyArray<string | number> }) => Promise<{ isError?: boolean }>) | undefined;
      const originalRegisterTool = server.registerTool.bind(server);
      vi.spyOn(server, "registerTool").mockImplementation((name: string, config: unknown, cb: unknown) => {
        handler = cb as typeof handler;
        return originalRegisterTool(name, config as never, cb as never);
      });
      registerDriveTools(server, { store, reconciler: fakeReconciler(vi.fn(() => session)) });
      expect(handler).toBeDefined();

      const result = await handler!({ linkId: "link-1", verb: "WHEELS_V", fields: [10, 10, 500] });

      expect(result.isError).toBeFalsy();
      const rows = store.recentAgentActions({ linkId: "link-1" }, 10);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.caller).toBe("unknown");
    } finally {
      store.close();
    }
  });

  it("a sendCommand failure (e.g. a write error) is recorded as result: failed with the error's own reason, and still reports the error to the caller", async () => {
    const store = openStore({ filePath: ":memory:" });
    try {
      const sendCommand = vi.fn(() => {
        throw new Error("write EPIPE");
      });
      const session = fakeSession({ sendCommand });
      const h = await makeHarness(store, { reconciler: fakeReconciler(vi.fn(() => session)) });

      const result = await h.client.callTool({ name: "request_drive", arguments: { linkId: "link-1", verb: "WHEELS_V", fields: [10, 10, 500] } });

      expect(result.isError).toBe(true);
      const text = ((result.content as Array<{ type: string; text?: string }>)[0]?.text) ?? "";
      expect(text).toContain("write EPIPE");

      const rows = store.recentAgentActions({ linkId: "link-1" }, 10);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ result: "failed", resultReason: "write EPIPE" });
    } finally {
      store.close();
    }
  });
});

// ---------------------------------------------------------------------
// Rejected verbs: STOP/ESTOP and any non-motion verb
// ---------------------------------------------------------------------

describe("request_drive: rejects non-allowlisted verbs, naming send_command, with no send and no audit row", () => {
  it.each(["STOP", "ESTOP", "STATUS", "ID", "HELLO", "bogus"])("%s is rejected before any wire write", async (verb) => {
    const store = openStore({ filePath: ":memory:" });
    try {
      const sendCommand = vi.fn();
      const session = fakeSession({ sendCommand });
      const h = await makeHarness(store, { reconciler: fakeReconciler(vi.fn(() => session)) });

      const result = await h.client.callTool({ name: "request_drive", arguments: { linkId: "link-1", verb, fields: [] } });

      expect(result.isError).toBe(true);
      const text = ((result.content as Array<{ type: string; text?: string }>)[0]?.text) ?? "";
      expect(text).toContain("send_command");
      expect(sendCommand).not.toHaveBeenCalled();
      expect(store.recentAgentActions({ linkId: "link-1" }, 10)).toHaveLength(0);
    } finally {
      store.close();
    }
  });

  it("a gated verb sent lowercase is still recognized and executes (case-insensitive allowlist match)", async () => {
    const store = openStore({ filePath: ":memory:" });
    try {
      const sendCommand = vi.fn(() => "OK\n");
      const session = fakeSession({ sendCommand });
      const h = await makeHarness(store, { reconciler: fakeReconciler(vi.fn(() => session)) });

      const result = await h.client.callTool({ name: "request_drive", arguments: { linkId: "link-1", verb: "wheels_v", fields: [10, 10, 500] } });

      expect(result.isError).toBeFalsy();
      expect(sendCommand).toHaveBeenCalledWith("wheels_v", [10, 10, 500]);
    } finally {
      store.close();
    }
  });
});

// ---------------------------------------------------------------------
// Malformed fields per verb: rejected before sendCommand, no audit row
// ---------------------------------------------------------------------

describe("request_drive: malformed fields are rejected before sendCommand, with no audit row", () => {
  const MALFORMED_CASES: ReadonlyArray<{ verb: string; fields: ReadonlyArray<string | number>; why: string }> = [
    { verb: "WHEELS_X", fields: [1, 2, 3], why: "wrong arity (needs 4)" },
    { verb: "WHEELS_X", fields: [1, 2, 3, "not-a-number"], why: "non-numeric timeout" },
    { verb: "WHEELS_X", fields: [1.5, 2, 3, 100], why: "non-integer field" },
    { verb: "WHEELS_V", fields: [1, 2], why: "wrong arity (needs 3)" },
    { verb: "WHEELS_V", fields: [1, 2, -5], why: "negative uint32 duration" },
    { verb: "MOVE_X", fields: [1, 2, 3], why: "wrong arity (needs 4)" },
    { verb: "MOVE_V", fields: [1, 2], why: "wrong arity (needs 3)" },
    { verb: "GO_TO_R", fields: [1, 2, 3, 4], why: "wrong arity (needs 5)" },
    { verb: "GO_TO_W", fields: [1, 2, 3, 4], why: "wrong arity (needs 5)" },
    { verb: "RUN", fields: [], why: "no function-name field" },
    { verb: "RUN", fields: Array.from({ length: 18 }, (_v, i) => i), why: "more than 17 fields" },
  ];

  it.each(MALFORMED_CASES)("$verb with $why fails cleanly, never reaching sendCommand", async ({ verb, fields }) => {
    const store = openStore({ filePath: ":memory:" });
    try {
      const sendCommand = vi.fn();
      const session = fakeSession({ sendCommand });
      const h = await makeHarness(store, { reconciler: fakeReconciler(vi.fn(() => session)) });

      const result = await h.client.callTool({ name: "request_drive", arguments: { linkId: "link-1", verb, fields: [...fields] } });

      expect(result.isError).toBe(true);
      expect(sendCommand).not.toHaveBeenCalled();
      expect(store.recentAgentActions({ linkId: "link-1" }, 10)).toHaveLength(0);
    } finally {
      store.close();
    }
  });
});

// ---------------------------------------------------------------------
// Open-session precondition
// ---------------------------------------------------------------------

describe("request_drive: requires an already-open session", () => {
  it("no open session on the link fails with a message directing the caller to open_session, calls sendCommand never, and writes no audit row", async () => {
    const store = openStore({ filePath: ":memory:" });
    try {
      const h = await makeHarness(store, { reconciler: fakeReconciler(vi.fn(() => undefined)) });

      const result = await h.client.callTool({ name: "request_drive", arguments: { linkId: "link-1", verb: "WHEELS_V", fields: [10, 10, 500] } });

      expect(result.isError).toBe(true);
      const text = ((result.content as Array<{ type: string; text?: string }>)[0]?.text) ?? "";
      expect(text).toContain("no open session");
      expect(text).toContain("open_session");
      expect(store.recentAgentActions({ linkId: "link-1" }, 10)).toHaveLength(0);
    } finally {
      store.close();
    }
  });
});

// ---------------------------------------------------------------------
// tool-call-empty-args.md survivability
// ---------------------------------------------------------------------

describe("request_drive: tool-call-empty-args.md survivability", () => {
  it("{} fails cleanly as a tool error (Zod: linkId/verb required), never reaching sendCommand", async () => {
    const store = openStore({ filePath: ":memory:" });
    try {
      const sendCommand = vi.fn();
      const session = fakeSession({ sendCommand });
      const h = await makeHarness(store, { reconciler: fakeReconciler(vi.fn(() => session)) });

      const result = await h.client.callTool({ name: "request_drive", arguments: {} });

      expect(result.isError).toBe(true);
      expect(sendCommand).not.toHaveBeenCalled();
    } finally {
      store.close();
    }
  });

  it("fields defaults to [] when omitted, then fails per-verb shape validation cleanly (rather than crashing on undefined)", async () => {
    const store = openStore({ filePath: ":memory:" });
    try {
      const sendCommand = vi.fn();
      const session = fakeSession({ sendCommand });
      const h = await makeHarness(store, { reconciler: fakeReconciler(vi.fn(() => session)) });

      const result = await h.client.callTool({ name: "request_drive", arguments: { linkId: "link-1", verb: "WHEELS_V" } });

      expect(result.isError).toBe(true);
      const text = ((result.content as Array<{ type: string; text?: string }>)[0]?.text) ?? "";
      expect(text).toContain("expects exactly 3 field");
      expect(sendCommand).not.toHaveBeenCalled();
    } finally {
      store.close();
    }
  });

  it("an empty-string linkId is rejected by Zod validation, not treated as a valid (if odd) call", async () => {
    const store = openStore({ filePath: ":memory:" });
    try {
      const h = await makeHarness(store);
      const result = await h.client.callTool({ name: "request_drive", arguments: { linkId: "", verb: "WHEELS_V", fields: [10, 10, 500] } });
      expect(result.isError).toBe(true);
    } finally {
      store.close();
    }
  });
});

// ---------------------------------------------------------------------
// No gate, ever: this ticket's own negative-space guarantee
// ---------------------------------------------------------------------

describe("request_drive: no approval/lifecycle vocabulary (negative-space test)", () => {
  const FORBIDDEN = [/\bapprove/i, /\bdeny\b/i, /\bdenied\b/i, /\bpending\b/i, /\bdecided_at\b/i, /\bdecided_reason\b/i, /\bTTL\b/, /\bqueue/i];

  it("drive.ts's own code (comments stripped) contains none of the superseded pending_actions design's vocabulary", async () => {
    const { readFileSync } = await import("node:fs");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const thisDir = path.dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(path.join(thisDir, "drive.ts"), "utf8");
    const stripped = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    for (const pattern of FORBIDDEN) {
      expect(stripped).not.toMatch(pattern);
    }
  });
});
