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
import {
  openSession,
  closeSession,
  requireSession,
  sendCommand,
  sendCommandWithReply,
  SEND_COMMAND_MAX_REPLY_LINES,
  type SessionOpsReconciler,
} from "./sessionOps.js";
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

/** `onInboundLine`/`onAckNack` default to a no-op subscription (never
 * fires, returns a plain unsubscribe) so every existing `sendCommand`
 * test -- which never touches either -- is unaffected by their
 * addition; `sendCommandWithReply`'s own tests below override them. */
function fakeSession(
  overrides: {
    sendCommand?: ReturnType<typeof vi.fn>;
    sendUnsequencedQuery?: ReturnType<typeof vi.fn>;
    onInboundLine?: ReturnType<typeof vi.fn>;
    onAckNack?: ReturnType<typeof vi.fn>;
  } = {},
): ConnectedSession {
  const link = {
    sendCommand: overrides.sendCommand ?? vi.fn(() => "SENT\n"),
    sendUnsequencedQuery: overrides.sendUnsequencedQuery ?? vi.fn(() => "SENT\n"),
    onInboundLine: overrides.onInboundLine ?? vi.fn(() => () => {}),
    onAckNack: overrides.onAckNack ?? vi.fn(() => () => {}),
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

describe("sendCommandWithReply", () => {
  it("collects an unsequenced query's own reply (and any unsolicited line) via onInboundLine, within the window", async () => {
    let inboundListener: ((line: string) => void) | undefined;
    const onInboundLine = vi.fn((listener: (line: string) => void) => {
      inboundListener = listener;
      return () => {};
    });
    const sendUnsequencedQuery = vi.fn(() => "ID\n");
    const session = fakeSession({ sendUnsequencedQuery, onInboundLine });

    const pending = sendCommandWithReply(session, "ID", [], 30);
    // Fires after the send, well inside the 30ms window -- both the
    // query's own answer and an unrelated, unsolicited DBG line.
    setTimeout(() => {
      inboundListener?.("id ABCDE\n");
      inboundListener?.("DBG:wifi state=1 ip=- ssid=-");
    }, 5);

    const result = await pending;

    expect(result).toEqual({ sent: "ID\n", reply: ["id ABCDE", "DBG:wifi state=1 ip=- ssid=-"] });
  });

  it("returns reply: [] when nothing arrives in the window -- not a rejection", async () => {
    const session = fakeSession();

    const result = await sendCommandWithReply(session, "STATUS", [], 20);

    expect(result).toEqual({ sent: "SENT\n", reply: [] });
  });

  it("a sequenced verb's reply is correlated via the existing onAckNack seq-matching, closing the window early", async () => {
    let inboundListener: ((line: string) => void) | undefined;
    let ackNackListener: ((event: unknown) => void) | undefined;
    const onInboundLine = vi.fn((listener: (line: string) => void) => {
      inboundListener = listener;
      return () => {};
    });
    const onAckNack = vi.fn((listener: (event: unknown) => void) => {
      ackNackListener = listener;
      return () => {};
    });
    const sendCommandSpy = vi.fn(() => "WIFICRED #1\n");
    const session = fakeSession({ sendCommand: sendCommandSpy, onInboundLine, onAckNack });

    // Real wire example (WIFICRED, sequenced): the ack/nack's own raw
    // line reaches `onInboundLine` first, then the decoded event reaches
    // `onAckNack` -- LineLink's own `Session` has already seq-matched it
    // to this send before dispatching either.
    const started = Date.now();
    const pending = sendCommandWithReply(session, "WIFICRED", [], 5_000);
    setTimeout(() => {
      inboundListener?.("nack 1 0 none");
      ackNackListener?.({ kind: "nack", n: 1, seq: 1, lastDone: 0, lastDoneReason: "none", resend: [], desynced: false });
    }, 5);

    const result = await pending;
    const elapsedMs = Date.now() - started;

    expect(result).toEqual({ sent: "WIFICRED #1\n", reply: ["nack 1 0 none"] });
    // Closed on the correlated ack/nack, not the full 5s window.
    expect(elapsedMs).toBeLessThan(1_000);
  });

  it("caps collected lines at SEND_COMMAND_MAX_REPLY_LINES", async () => {
    let inboundListener: ((line: string) => void) | undefined;
    const onInboundLine = vi.fn((listener: (line: string) => void) => {
      inboundListener = listener;
      return () => {};
    });
    const session = fakeSession({ onInboundLine });

    const pending = sendCommandWithReply(session, "STATUS", [], 30);
    setTimeout(() => {
      for (let i = 0; i < SEND_COMMAND_MAX_REPLY_LINES + 10; i += 1) {
        inboundListener?.(`DBG:spam ${i}`);
      }
    }, 5);

    const result = await pending;

    expect(result.reply).toHaveLength(SEND_COMMAND_MAX_REPLY_LINES);
  });

  it("unsubscribes both listeners when sendCommand itself throws (e.g. HELLO), and rejects rather than hanging", async () => {
    const unsubscribeInbound = vi.fn();
    const unsubscribeAckNack = vi.fn();
    const onInboundLine = vi.fn(() => unsubscribeInbound);
    const onAckNack = vi.fn(() => unsubscribeAckNack);
    const session = fakeSession({ onInboundLine, onAckNack });

    await expect(sendCommandWithReply(session, "HELLO", [], 30)).rejects.toThrow(/HELLO/);

    expect(unsubscribeInbound).toHaveBeenCalledTimes(1);
    // HELLO is not one of the 13 sequenced verbs, so onAckNack was never
    // subscribed in the first place.
    expect(onAckNack).not.toHaveBeenCalled();
    expect(unsubscribeAckNack).not.toHaveBeenCalled();
  });

  it("unsubscribes both listeners once the window closes normally (no listener leak across repeated calls)", async () => {
    const unsubscribeInbound = vi.fn();
    const unsubscribeAckNack = vi.fn();
    const onInboundLine = vi.fn(() => unsubscribeInbound);
    const onAckNack = vi.fn(() => unsubscribeAckNack);
    const sendCommandSpy = vi.fn(() => "WIFICRED #1\n");
    const session = fakeSession({ sendCommand: sendCommandSpy, onInboundLine, onAckNack });

    await sendCommandWithReply(session, "WIFICRED", [], 20);

    expect(unsubscribeInbound).toHaveBeenCalledTimes(1);
    expect(unsubscribeAckNack).toHaveBeenCalledTimes(1);
  });
});
