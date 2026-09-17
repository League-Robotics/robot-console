import { describe, expect, it } from "vitest";
import { openStoreDb } from "../db.js";
import { Store } from "../index.js";
import { clearDeadProcessState } from "./clearDeadProcessState.js";

/** A fresh in-memory, fully-migrated store for one test. */
function freshStore(): Store {
  return new Store(openStoreDb({ filePath: ":memory:" }));
}

describe("clearDeadProcessState (018-010)", () => {
  it("releases a leftover board_owner row regardless of who held it", () => {
    const store = freshStore();
    try {
      store.acquireBoardOwner("SERIAL-A", "sweep", 100);

      clearDeadProcessState(store, 200);

      // A fresh acquire by this (new) process now succeeds -- proof the
      // old "sweep" owner is actually gone, not merely hidden.
      expect(store.acquireBoardOwner("SERIAL-A", "naming", 300)).toBe(true);
    } finally {
      store.close();
    }
  });

  it("releases a leftover relay_leases 'sweep' row -- the exact bench shape (vitut carrying a sweep lease from a different, still-running process)", () => {
    const store = freshStore();
    try {
      store.upsertLink({ id: "mbrelay-vitut", transport: "mbrelay", address: { host: "vitut.local", port: 8760 }, at: 100 });
      store.acquireRelayLease("mbrelay-vitut", "sweep", 100);

      clearDeadProcessState(store, 200);

      // A fresh acquire by this process's own sweeper now succeeds --
      // proof the old "sweep" owner is actually gone, not merely hidden.
      expect(store.acquireRelayLease("mbrelay-vitut", "sweep", 300)).toBe(true);
    } finally {
      store.close();
    }
  });

  it("closes a leftover open session row", () => {
    const store = freshStore();
    try {
      store.upsertLink({ id: "usb-SERIAL-A", transport: "usb", address: { path: "/dev/a" }, at: 100 });
      store.openSession("usb-SERIAL-A", 100);
      expect(store.snapshotRows().sessions).toHaveLength(1);

      clearDeadProcessState(store, 200);

      expect(store.snapshotRows().sessions).toHaveLength(0);
    } finally {
      store.close();
    }
  });

  it("resets a leftover 'connecting' link to 'connectable'", () => {
    const store = freshStore();
    try {
      store.upsertLink({ id: "usb-SERIAL-A", transport: "usb", address: { path: "/dev/a" }, at: 100 });
      store.setLinkState({ id: "usb-SERIAL-A", state: "connecting", at: 100 });

      clearDeadProcessState(store, 200);

      const link = store.snapshotRows().links.find((l) => l.id === "usb-SERIAL-A");
      expect(link).toMatchObject({ state: "connectable", state_reason: "process-restarted" });
    } finally {
      store.close();
    }
  });

  it("resets a leftover 'connected' link (no session survives a restart) to 'connectable' -- otherwise connect/reconciler.ts's deviceHasActiveLink treats it as already connected forever", () => {
    const store = freshStore();
    try {
      store.upsertLink({ id: "usb-SERIAL-A", transport: "usb", address: { path: "/dev/a" }, at: 100 });
      store.setLinkState({ id: "usb-SERIAL-A", state: "connected", at: 100 });

      clearDeadProcessState(store, 200);

      const link = store.snapshotRows().links.find((l) => l.id === "usb-SERIAL-A");
      expect(link).toMatchObject({ state: "connectable", state_reason: "process-restarted" });
    } finally {
      store.close();
    }
  });

  it("never touches a link in an ordinary non-live state (discovered/failed/stale/closed_by_user)", () => {
    const store = freshStore();
    try {
      store.upsertLink({ id: "usb-SERIAL-A", transport: "usb", address: { path: "/dev/a" }, at: 100 });
      store.setLinkState({ id: "usb-SERIAL-A", state: "failed", at: 100, reason: "boom" });

      clearDeadProcessState(store, 200);

      const link = store.snapshotRows().links.find((l) => l.id === "usb-SERIAL-A");
      expect(link).toMatchObject({ state: "failed", state_reason: "boom" });
    } finally {
      store.close();
    }
  });

  it("is idempotent -- a second run with nothing left to clear makes no further changes", () => {
    const store = freshStore();
    try {
      store.upsertLink({ id: "usb-SERIAL-A", transport: "usb", address: { path: "/dev/a" }, at: 100 });
      store.acquireBoardOwner("SERIAL-A", "flash", 100);
      store.setLinkState({ id: "usb-SERIAL-A", state: "connecting", at: 100 });

      clearDeadProcessState(store, 200);
      expect(() => clearDeadProcessState(store, 300)).not.toThrow();

      const link = store.snapshotRows().links.find((l) => l.id === "usb-SERIAL-A");
      expect(link).toMatchObject({ state: "connectable" });
      expect(store.acquireBoardOwner("SERIAL-A", "naming", 400)).toBe(true);
    } finally {
      store.close();
    }
  });

  it("a clean store (nothing dead-process-owned) is left entirely alone", () => {
    const store = freshStore();
    try {
      store.upsertLink({ id: "usb-SERIAL-A", transport: "usb", address: { path: "/dev/a" }, at: 100 });
      store.setLinkState({ id: "usb-SERIAL-A", state: "connectable", at: 100 });

      expect(() => clearDeadProcessState(store, 200)).not.toThrow();

      const link = store.snapshotRows().links.find((l) => l.id === "usb-SERIAL-A");
      expect(link).toMatchObject({ state: "connectable", state_since: 100 });
    } finally {
      store.close();
    }
  });
});
