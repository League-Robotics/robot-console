/**
 * sessionOps.test.ts — sprint 019 ticket 005's own suite for the
 * extracted, WS-independent `openSession`/`closeSession`/`sendCommand`/
 * `requireSession` (SUC-005). `server.ts`'s WS handlers and `mcp/tools/
 * connect.ts`'s MCP tools both call exactly these functions -- this file
 * proves their own behavior directly, once, rather than through either
 * caller. `server.test.ts`'s existing suite (unchanged by this ticket)
 * is what proves the WS wrapper still behaves the same as before this
 * extraction.
 *
 * A real {@link Store} backed by an in-memory `node:sqlite` connection
 * (`connect/flasher.test.ts`'s own `freshStore()` pattern) is used
 * throughout -- `setSessionIdentity`'s conditional-change discipline and
 * `openSession`'s own reset-to-`'ui'` behavior are store-schema
 * behavior, not something a hand-rolled fake should reimplement.
 */
import { describe, expect, it, vi } from "vitest";
import { openStoreDb } from "../store/db.js";
import { Store } from "../store/index.js";
import { openSession, closeSession, requireSession, sendCommand, type SessionOpsReconciler } from "./sessionOps.js";
import type { ConnectedSession } from "./connector.js";

function freshStore(): Store {
  return new Store(openStoreDb({ filePath: ":memory:" }));
}

function fakeReconciler(overrides: Partial<SessionOpsReconciler> = {}): SessionOpsReconciler & {
  requestOpen: ReturnType<typeof vi.fn>;
  requestClose: ReturnType<typeof vi.fn>;
} {
  return {
    requestOpen: vi.fn(async () => ({})),
    requestClose: vi.fn(async () => undefined),
    ...overrides,
  } as SessionOpsReconciler & { requestOpen: ReturnType<typeof vi.fn>; requestClose: ReturnType<typeof vi.fn> };
}

function fakeSession(overrides: { sendCommand?: ReturnType<typeof vi.fn>; sendUnsequencedQuery?: ReturnType<typeof vi.fn> } = {}): ConnectedSession {
  const link = {
    sendCommand: overrides.sendCommand ?? vi.fn(() => "SENT\n"),
    sendUnsequencedQuery: overrides.sendUnsequencedQuery ?? vi.fn(() => "SENT\n"),
  };
  return { linkId: "link-1", deviceId: 1, transport: "usb", link, classification: { type: "robot" } } as unknown as ConnectedSession;
}

describe("openSession: {linkId} form", () => {
  it("dispatches through reconciler.requestOpen and writes no identity when refused", async () => {
    const store = freshStore();
    try {
      const reconciler = fakeReconciler({ requestOpen: vi.fn(async () => ({ refusedReason: "already open" })) });
      const spy = vi.spyOn(store, "setSessionIdentity");

      const result = await openSession({ store, reconciler }, { linkId: "link-1" });

      expect(reconciler.requestOpen).toHaveBeenCalledWith("link-1");
      expect(result).toEqual({ linkId: "link-1", refusedReason: "already open" });
      expect(spy).not.toHaveBeenCalled();
    } finally {
      store.close();
    }
  });

  it("writes the default 'ui' identity after a successful open (no-op on the store, but exercised)", async () => {
    const store = freshStore();
    try {
      store.upsertLink({ id: "link-1", transport: "usb", address: {}, at: 1 });
      store.openSession("link-1", 1);
      const reconciler = fakeReconciler();

      const result = await openSession({ store, reconciler }, { linkId: "link-1" });

      expect(result).toEqual({ linkId: "link-1" });
      const row = store.projectionRows().sessions.find((s) => s.linkId === "link-1");
      expect(row).toMatchObject({ origin: "ui", caller: null });
    } finally {
      store.close();
    }
  });

  it("writes origin 'mcp'/caller when given an MCP identity, after a successful open", async () => {
    const store = freshStore();
    try {
      store.upsertLink({ id: "link-1", transport: "usb", address: {}, at: 1 });
      store.openSession("link-1", 1);
      const reconciler = fakeReconciler();

      await openSession({ store, reconciler }, { linkId: "link-1" }, { origin: "mcp", caller: "agent-smith" });

      const row = store.projectionRows().sessions.find((s) => s.linkId === "link-1");
      expect(row).toMatchObject({ origin: "mcp", caller: "agent-smith" });
    } finally {
      store.close();
    }
  });

  it("never overwrites an existing session's identity when the open is refused (someone else already holds it)", async () => {
    const store = freshStore();
    try {
      store.upsertLink({ id: "link-1", transport: "usb", address: {}, at: 1 });
      store.openSession("link-1", 1);
      // A human already holds this link's session.
      const reconciler = fakeReconciler({ requestOpen: vi.fn(async () => ({ refusedReason: "already connected" })) });

      await openSession({ store, reconciler }, { linkId: "link-1" }, { origin: "mcp", caller: "agent-smith" });

      const row = store.projectionRows().sessions.find((s) => s.linkId === "link-1");
      expect(row).toMatchObject({ origin: "ui", caller: null });
    } finally {
      store.close();
    }
  });
});

describe("openSession: {relayLinkId, name} form", () => {
  it("derives a deterministic child link id, upserts it, and opens through the reconciler", async () => {
    const store = freshStore();
    try {
      const reconciler = fakeReconciler();

      const result = await openSession({ store, reconciler }, { relayLinkId: "usb-relay1", name: "vevov" });

      expect(result.linkId).toBe("radio-vevov-via-usb-relay1");
      expect(reconciler.requestOpen).toHaveBeenCalledWith("radio-vevov-via-usb-relay1");
      const link = store.projectionRows().links.find((l) => l.id === "radio-vevov-via-usb-relay1");
      expect(link).toBeDefined();
      expect(link?.transport).toBe("radio");
    } finally {
      store.close();
    }
  });

  it("reuses an already-sighted (channel, group) for a repeat bridge to the same (name, relay) pair", async () => {
    const store = freshStore();
    try {
      store.upsertLink({ id: "radio-vevov-via-usb-relay1", transport: "radio", address: { relayLinkId: "usb-relay1", channel: 41, group: 3 }, at: 1 });
      const reconciler = fakeReconciler();

      await openSession({ store, reconciler }, { relayLinkId: "usb-relay1", name: "vevov" });

      const link = store.projectionRows().links.find((l) => l.id === "radio-vevov-via-usb-relay1");
      expect(link?.address).toMatchObject({ channel: 41, group: 3 });
    } finally {
      store.close();
    }
  });
});

describe("closeSession", () => {
  it("forwards to reconciler.requestClose", async () => {
    const reconciler = fakeReconciler();
    await closeSession({ reconciler }, "link-1");
    expect(reconciler.requestClose).toHaveBeenCalledWith("link-1");
  });
});

describe("requireSession", () => {
  it("returns the session when one is open", () => {
    const session = fakeSession();
    const sessions = { get: vi.fn(() => session) };
    expect(requireSession(sessions, "link-1")).toBe(session);
  });

  it("throws a plain error when no session is open for the link", () => {
    const sessions = { get: vi.fn(() => undefined) };
    expect(() => requireSession(sessions, "link-1")).toThrow(/no open session/);
  });
});

describe("sendCommand", () => {
  it("rejects HELLO", () => {
    const session = fakeSession();
    expect(() => sendCommand(session, "HELLO")).toThrow(/HELLO/);
    expect(() => sendCommand(session, "hello")).toThrow(/HELLO/);
  });

  it("routes a sequenced verb (e.g. STOP) through link.sendCommand", () => {
    const sendCommandSpy = vi.fn(() => "STOP #1\n");
    const session = fakeSession({ sendCommand: sendCommandSpy });

    const sent = sendCommand(session, "STOP", []);

    expect(sendCommandSpy).toHaveBeenCalledWith("STOP", []);
    expect(sent).toBe("STOP #1\n");
  });

  it("routes an unsequenced verb (e.g. STATUS) through link.sendUnsequencedQuery", () => {
    const sendUnsequencedQuerySpy = vi.fn(() => "STATUS\n");
    const session = fakeSession({ sendUnsequencedQuery: sendUnsequencedQuerySpy });

    const sent = sendCommand(session, "STATUS", []);

    expect(sendUnsequencedQuerySpy).toHaveBeenCalledWith("STATUS", []);
    expect(sent).toBe("STATUS\n");
  });

  it("routes ESTOP (unsequenced, always-allowed) through link.sendUnsequencedQuery", () => {
    const sendUnsequencedQuerySpy = vi.fn(() => "ESTOP\n");
    const session = fakeSession({ sendUnsequencedQuery: sendUnsequencedQuerySpy });

    sendCommand(session, "ESTOP", []);

    expect(sendUnsequencedQuerySpy).toHaveBeenCalledWith("ESTOP", []);
  });

  it("defaults fields to an empty array when omitted", () => {
    const sendUnsequencedQuerySpy = vi.fn(() => "ID\n");
    const session = fakeSession({ sendUnsequencedQuery: sendUnsequencedQuerySpy });

    sendCommand(session, "ID");

    expect(sendUnsequencedQuerySpy).toHaveBeenCalledWith("ID", []);
  });
});
