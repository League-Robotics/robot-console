import { describe, expect, it, vi } from "vitest";
import { openStoreDb } from "../store/db.js";
import { Store } from "../store/index.js";
import { createUnhandledRejectionHandler } from "./unhandled.js";

// Sprint 015 ticket 003's own suite for the `unhandledRejection`
// backstop. Exercises `createUnhandledRejectionHandler`'s handler
// directly, exactly like a rejecting fake would drive it -- this file
// never calls `installUnhandledRejectionBackstop`, so it never touches
// this test process's own real `process.on('unhandledRejection', ...)`
// listeners (this ticket's own instruction).

function freshStore(): Store {
  return new Store(openStoreDb({ filePath: ":memory:" }));
}

describe("createUnhandledRejectionHandler", () => {
  it("logs and marks the offending link failed when the rejection carries a linkId", () => {
    const store = freshStore();
    try {
      store.upsertLink({ id: "link-1", transport: "usb", address: { path: "/dev/x" }, at: 0 });
      const log = vi.fn();
      const handler = createUnhandledRejectionHandler(store, { log, now: () => 12345 });

      const rejection = Object.assign(new Error("boom"), { linkId: "link-1" });
      handler(rejection);

      expect(log).toHaveBeenCalledTimes(1);
      expect(log.mock.calls[0]?.[0]).toContain("link-1");
      const row = store.snapshotRows().links.find((l) => l.id === "link-1");
      expect(row).toMatchObject({ state: "failed", state_reason: "boom" });
    } finally {
      store.close();
    }
  });

  it("accepts a plain object carrying linkId, not only an Error subclass", () => {
    const store = freshStore();
    try {
      store.upsertLink({ id: "link-2", transport: "wifi", address: { host: "x", port: 1 }, at: 0 });
      const handler = createUnhandledRejectionHandler(store, { log: vi.fn(), now: () => 1 });

      handler({ linkId: "link-2", detail: "whatever" });

      const row = store.snapshotRows().links.find((l) => l.id === "link-2");
      expect(row?.state).toBe("failed");
    } finally {
      store.close();
    }
  });

  it("logs but never touches the store when the rejection carries no linkId", () => {
    const store = freshStore();
    try {
      store.upsertLink({ id: "link-3", transport: "usb", address: { path: "/dev/y" }, at: 0 });
      const setLinkState = vi.spyOn(store, "setLinkState");
      const log = vi.fn();
      const handler = createUnhandledRejectionHandler(store, { log });

      handler(new Error("no id here"));
      handler("a bare string rejection");
      handler({ notLinkId: "link-3" });

      expect(log).toHaveBeenCalledTimes(3);
      expect(setLinkState).not.toHaveBeenCalled();
      expect(store.snapshotRows().links.find((l) => l.id === "link-3")?.state).toBe("discovered");
    } finally {
      store.close();
    }
  });

  it("is a no-op, not an error, for a linkId naming no links row", () => {
    const store = freshStore();
    try {
      const handler = createUnhandledRejectionHandler(store, { log: vi.fn() });
      expect(() => handler(Object.assign(new Error("boom"), { linkId: "no-such-link" }))).not.toThrow();
      expect(store.snapshotRows().links).toHaveLength(0);
    } finally {
      store.close();
    }
  });

  it("never throws even if the store write itself fails (e.g. a closed store, mid-shutdown)", () => {
    const store = freshStore();
    store.close();
    const handler = createUnhandledRejectionHandler(store, { log: vi.fn() });
    expect(() => handler(Object.assign(new Error("boom"), { linkId: "link-1" }))).not.toThrow();
  });

  it("does not register anything on the real process -- calling the handler directly never touches process listeners", () => {
    const before = process.listenerCount("unhandledRejection");
    const store = freshStore();
    try {
      const handler = createUnhandledRejectionHandler(store, { log: vi.fn() });
      handler(new Error("irrelevant"));
      expect(process.listenerCount("unhandledRejection")).toBe(before);
    } finally {
      store.close();
    }
  });
});
