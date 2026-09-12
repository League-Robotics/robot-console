import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openReadOnlyStoreDb } from "../store/db.js";
import { Store, openStore } from "../store/index.js";
import { dumpStore, formatStoreDump } from "./dumpStore.js";

describe("debug/dumpStore: dumpStore", () => {
  let dir: string;
  let dbFile: string;
  let store: Store | undefined;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "robot-console-dump-store-test-"));
    dbFile = path.join(dir, "console.sqlite");
  });

  afterEach(() => {
    store?.close();
    store = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns an empty snapshot -- not an error -- when console.sqlite does not exist yet", () => {
    const snapshot = dumpStore({ filePath: dbFile });
    expect(snapshot).toEqual({ devices: [], links: [], services: [], sessions: [], tasks: [] });
  });

  it("dumps rows seeded through the store's own typed operations", () => {
    store = openStore({ filePath: dbFile });
    store.upsertDevice({ id: 1198504156, name: "vevov", kind: "robot", at: 1000 });
    store.upsertLink({ id: "usb-serial-1", transport: "usb", address: { path: "/dev/tty.usb1" }, at: 1000 });
    store.upsertService({ instance: "vevov", type: "mbserial.tcp", host: "vevov.local", port: 7654, at: 1000 });
    store.openSession("usb-serial-1", 1000);
    store.heartbeat("usbWatcher", 1000);
    store.close();
    store = undefined;

    const snapshot = dumpStore({ filePath: dbFile });

    expect(snapshot.devices).toHaveLength(1);
    expect(snapshot.devices[0]).toMatchObject({ id: 1198504156, name: "vevov", kind: "robot" });

    expect(snapshot.links).toHaveLength(1);
    expect(snapshot.links[0]).toMatchObject({ id: "usb-serial-1", transport: "usb" });

    expect(snapshot.services).toHaveLength(1);
    expect(snapshot.services[0]).toMatchObject({ instance: "vevov", type: "mbserial.tcp" });

    expect(snapshot.sessions).toHaveLength(1);
    expect(snapshot.sessions[0]).toMatchObject({ link_id: "usb-serial-1" });

    expect(snapshot.tasks).toHaveLength(1);
    expect(snapshot.tasks[0]).toMatchObject({ name: "usbWatcher", state: "running" });
  });

  it("works whether or not a writer is currently open (a second WAL reader never blocks/corrupts)", () => {
    store = openStore({ filePath: dbFile });
    store.upsertDevice({ id: 1198504156, name: "vevov", kind: "robot", at: 1000 });

    // The primary connection is still open (mirrors the host process
    // still running) when the dump runs.
    const snapshot = dumpStore({ filePath: dbFile });
    expect(snapshot.devices).toHaveLength(1);

    store.upsertDevice({ id: 1198504156, name: "vevov", kind: "robot", role: "NEZHA2", at: 2000 });
    expect(store.snapshotRows().devices[0]).toMatchObject({ role: "NEZHA2" });
  });

  it("ships no write path: a Store built on the read-only connection throws on a write call", () => {
    store = openStore({ filePath: dbFile });
    store.close();
    store = undefined;

    const readOnlyDb = openReadOnlyStoreDb({ filePath: dbFile });
    expect(readOnlyDb).toBeDefined();
    const readOnlyStore = new Store(readOnlyDb!);
    try {
      expect(() =>
        readOnlyStore.upsertDevice({ id: 1198504156, name: "vevov", kind: "robot", at: 1000 }),
      ).toThrow();
    } finally {
      readOnlyDb!.close();
    }
  });
});

describe("debug/dumpStore: formatStoreDump", () => {
  it("formats a snapshot as pretty-printed JSON covering every table", () => {
    const formatted = formatStoreDump({
      devices: [{ id: 1 }],
      links: [],
      services: [],
      sessions: [],
      tasks: [],
    });

    const parsed = JSON.parse(formatted) as Record<string, unknown>;
    expect(parsed).toEqual({ devices: [{ id: 1 }], links: [], services: [], sessions: [], tasks: [] });
    // Pretty-printed, not a single line -- readable directly in a
    // terminal without piping through a formatter.
    expect(formatted).toContain("\n");
  });
});
