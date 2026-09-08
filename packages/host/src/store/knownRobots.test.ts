import { mkdtempSync, readdirSync, rmSync, chmodSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CURRENT_KNOWN_ROBOTS_VERSION,
  KnownRobotsStore,
  resolveKnownRobotsFilePath,
  type KnownRobotRecord,
} from "./knownRobots.js";

/** A tiny in-memory "filesystem" shared by a store's injected seam
 * functions. Reused across two `KnownRobotsStore` instances pointed at
 * the same fake `filePath` to prove round-trip behavior with no real
 * disk I/O at all. */
function createFakeFs() {
  const files = new Map<string, string>();
  const existsSync = vi.fn((filePath: string) => files.has(filePath));
  const readFileSync = vi.fn((filePath: string) => {
    const content = files.get(filePath);
    if (content === undefined) {
      throw new Error(`ENOENT: no such fake file: ${filePath}`);
    }
    return content;
  });
  const writeFile = vi.fn(async (filePath: string, data: string) => {
    files.set(filePath, data);
  });
  const rename = vi.fn(async (oldPath: string, newPath: string) => {
    const data = files.get(oldPath);
    if (data === undefined) {
      throw new Error(`ENOENT: fake rename source missing: ${oldPath}`);
    }
    files.delete(oldPath);
    files.set(newPath, data);
  });
  const mkdir = vi.fn(async () => {});
  return { files, existsSync, readFileSync, writeFile, rename, mkdir };
}

const FAKE_PATH = "/fake/state/known-robots.json";

function makeNow(...timestamps: string[]): () => string {
  let index = 0;
  return () => {
    const value = timestamps[Math.min(index, timestamps.length - 1)];
    index += 1;
    return value as string;
  };
}

describe("KnownRobotsStore: recordSighting / list / get", () => {
  it("records a sighting with the injected now() and default fields", () => {
    const fakeFs = createFakeFs();
    const store = new KnownRobotsStore({
      filePath: FAKE_PATH,
      ...fakeFs,
      now: makeNow("2026-01-01T00:00:00.000Z"),
    });

    store.recordSighting({ name: "abcde", usbSerial: "usb-123", role: "left" });

    expect(store.list()).toEqual([
      {
        name: "abcde",
        firstSeenAt: "2026-01-01T00:00:00.000Z",
        lastSeenAt: "2026-01-01T00:00:00.000Z",
        lastSeenVia: "usb",
        lastUsbSerial: "usb-123",
        lastRole: "left",
        lastType: "robot",
      },
    ]);
    expect(store.get("abcde")).toEqual(store.list()[0]);
  });

  it("a second sighting of the same name updates lastSeenAt/lastUsbSerial/lastRole but preserves firstSeenAt", () => {
    const fakeFs = createFakeFs();
    const store = new KnownRobotsStore({
      filePath: FAKE_PATH,
      ...fakeFs,
      now: makeNow("2026-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z"),
    });

    store.recordSighting({ name: "abcde", usbSerial: "usb-123", role: "left" });
    store.recordSighting({ name: "abcde", usbSerial: "usb-456", role: "right" });

    const record = store.get("abcde");
    expect(record?.firstSeenAt).toBe("2026-01-01T00:00:00.000Z");
    expect(record?.lastSeenAt).toBe("2026-01-02T00:00:00.000Z");
    expect(record?.lastUsbSerial).toBe("usb-456");
    expect(record?.lastRole).toBe("right");
  });

  it("list() is sorted by name", () => {
    const fakeFs = createFakeFs();
    const store = new KnownRobotsStore({ filePath: FAKE_PATH, ...fakeFs, now: makeNow("t") });
    store.recordSighting({ name: "zzzzz", usbSerial: "s1", role: null });
    store.recordSighting({ name: "aaaaa", usbSerial: "s2", role: null });
    expect(store.list().map((r) => r.name)).toEqual(["aaaaa", "zzzzz"]);
  });

  it("list()/get() return copies -- mutating the result never affects internal state", () => {
    const fakeFs = createFakeFs();
    const store = new KnownRobotsStore({ filePath: FAKE_PATH, ...fakeFs, now: makeNow("t") });
    store.recordSighting({ name: "abcde", usbSerial: "s1", role: null });
    const record = store.get("abcde") as KnownRobotRecord;
    record.lastRole = "tampered";
    expect(store.get("abcde")?.lastRole).toBeNull();
  });
});

describe("KnownRobotsStore: round-trip via flush() and a fresh instance", () => {
  it("a fresh store pointed at the same file reads back the same records after flush()", async () => {
    const fakeFs = createFakeFs();
    const store1 = new KnownRobotsStore({
      filePath: FAKE_PATH,
      ...fakeFs,
      now: makeNow("2026-01-01T00:00:00.000Z"),
    });
    store1.recordSighting({ name: "abcde", usbSerial: "usb-1", role: "left" });
    await store1.flush();

    const store2 = new KnownRobotsStore({ filePath: FAKE_PATH, ...fakeFs, now: makeNow("t") });
    expect(store2.list()).toEqual(store1.list());
    expect(store2.isReadOnly).toBe(false);
  });
});

describe("KnownRobotsStore: missing / corrupt / version-mismatched files", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("a missing file produces an empty list() with no warning", () => {
    const fakeFs = createFakeFs();
    const store = new KnownRobotsStore({ filePath: FAKE_PATH, ...fakeFs, now: makeNow("t") });
    expect(store.list()).toEqual([]);
    expect(store.isReadOnly).toBe(false);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("invalid JSON degrades to an empty roster, warns once, is not read-only, and a later write succeeds", async () => {
    const fakeFs = createFakeFs();
    fakeFs.files.set(FAKE_PATH, "{ this is not valid json");

    const store = new KnownRobotsStore({ filePath: FAKE_PATH, ...fakeFs, now: makeNow("2026-01-01T00:00:00.000Z") });
    expect(store.list()).toEqual([]);
    expect(store.isReadOnly).toBe(false);
    expect(warnSpy).toHaveBeenCalledTimes(1);

    store.recordSighting({ name: "abcde", usbSerial: "usb-1", role: null });
    await store.flush();

    expect(fakeFs.writeFile).toHaveBeenCalledTimes(1);
    const persisted = JSON.parse(fakeFs.files.get(FAKE_PATH) as string);
    expect(persisted.robots).toHaveLength(1);
    expect(persisted.robots[0].name).toBe("abcde");
  });

  it("a missing/non-numeric version field is treated the same as corrupt JSON", () => {
    const fakeFs = createFakeFs();
    fakeFs.files.set(FAKE_PATH, JSON.stringify({ robots: [] }));
    const store = new KnownRobotsStore({ filePath: FAKE_PATH, ...fakeFs, now: makeNow("t") });
    expect(store.list()).toEqual([]);
    expect(store.isReadOnly).toBe(false);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it("an unreadable file (readFileSync throws) degrades the same way as corrupt JSON", () => {
    const fakeFs = createFakeFs();
    fakeFs.existsSync.mockReturnValue(true);
    fakeFs.readFileSync.mockImplementation(() => {
      throw new Error("EACCES: permission denied");
    });
    const store = new KnownRobotsStore({ filePath: FAKE_PATH, ...fakeFs, now: makeNow("t") });
    expect(store.list()).toEqual([]);
    expect(store.isReadOnly).toBe(false);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it("a file with version below current loads normally through the migration seam", () => {
    const fakeFs = createFakeFs();
    const existingRecord: KnownRobotRecord = {
      name: "abcde",
      firstSeenAt: "2025-01-01T00:00:00.000Z",
      lastSeenAt: "2025-01-01T00:00:00.000Z",
      lastSeenVia: "usb",
      lastUsbSerial: "usb-1",
      lastRole: null,
      lastType: "robot",
    };
    fakeFs.files.set(FAKE_PATH, JSON.stringify({ version: 0, robots: [existingRecord] }));
    const store = new KnownRobotsStore({ filePath: FAKE_PATH, ...fakeFs, now: makeNow("t") });
    expect(store.list()).toEqual([existingRecord]);
    expect(store.isReadOnly).toBe(false);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("a newer file version loads empty, warns once, sets isReadOnly, and every subsequent mutation is a silent no-op", async () => {
    const fakeFs = createFakeFs();
    fakeFs.files.set(FAKE_PATH, JSON.stringify({ version: 999, robots: [] }));

    const store = new KnownRobotsStore({ filePath: FAKE_PATH, ...fakeFs, now: makeNow("t") });
    expect(store.list()).toEqual([]);
    expect(store.isReadOnly).toBe(true);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(CURRENT_KNOWN_ROBOTS_VERSION).toBeLessThan(999);

    store.recordSighting({ name: "abcde", usbSerial: "usb-1", role: null });
    expect(store.list()).toEqual([]);

    const forgetResult = store.forget("abcde");
    expect(forgetResult).toBe(false);

    await store.flush();
    expect(fakeFs.writeFile).not.toHaveBeenCalled();
    expect(fakeFs.rename).not.toHaveBeenCalled();
  });
});

describe("KnownRobotsStore: forget", () => {
  it("removes an existing record from list() and, after flush(), from a fresh instance", async () => {
    const fakeFs = createFakeFs();
    const store1 = new KnownRobotsStore({ filePath: FAKE_PATH, ...fakeFs, now: makeNow("t") });
    store1.recordSighting({ name: "abcde", usbSerial: "usb-1", role: null });
    await store1.flush();

    const removed = store1.forget("abcde");
    expect(removed).toBe(true);
    expect(store1.list()).toEqual([]);

    await store1.flush();
    const store2 = new KnownRobotsStore({ filePath: FAKE_PATH, ...fakeFs, now: makeNow("t") });
    expect(store2.list()).toEqual([]);
  });

  it("forgetting a name that is not present returns false and schedules no write", async () => {
    const fakeFs = createFakeFs();
    const store = new KnownRobotsStore({ filePath: FAKE_PATH, ...fakeFs, now: makeNow("t") });
    expect(() => store.forget("zzzzz")).not.toThrow();
    expect(store.forget("zzzzz")).toBe(false);
    await store.flush();
    expect(fakeFs.writeFile).not.toHaveBeenCalled();
  });
});

describe("KnownRobotsStore: debounced, atomic writes", () => {
  it("coalesces several mutations within one debounce window into exactly one writeFile call", async () => {
    const fakeFs = createFakeFs();
    const store = new KnownRobotsStore({ filePath: FAKE_PATH, ...fakeFs, now: makeNow("t") });

    store.recordSighting({ name: "aaaaa", usbSerial: "s1", role: null });
    store.recordSighting({ name: "bbbbb", usbSerial: "s2", role: null });
    store.forget("aaaaa");
    store.recordSighting({ name: "ccccc", usbSerial: "s3", role: null });

    await store.flush();

    expect(fakeFs.writeFile).toHaveBeenCalledTimes(1);
    const persisted = JSON.parse(fakeFs.files.get(FAKE_PATH) as string);
    expect(persisted.robots.map((r: KnownRobotRecord) => r.name).sort()).toEqual(["bbbbb", "ccccc"]);
  });

  it("uses the temp-file-then-rename pattern", async () => {
    const fakeFs = createFakeFs();
    const store = new KnownRobotsStore({ filePath: FAKE_PATH, ...fakeFs, now: makeNow("t") });
    store.recordSighting({ name: "abcde", usbSerial: "s1", role: null });
    await store.flush();

    expect(fakeFs.writeFile).toHaveBeenCalledTimes(1);
    expect(fakeFs.rename).toHaveBeenCalledTimes(1);
    const writtenPath = fakeFs.writeFile.mock.calls[0]?.[0] as string;
    const [renameFrom, renameTo] = fakeFs.rename.mock.calls[0] as [string, string];
    expect(writtenPath).not.toBe(FAKE_PATH);
    expect(renameFrom).toBe(writtenPath);
    expect(renameTo).toBe(FAKE_PATH);
  });

  it("a failing writeFile does not throw out of recordSighting or flush(), and does not change list()", async () => {
    const fakeFs = createFakeFs();
    fakeFs.writeFile.mockRejectedValue(new Error("disk full"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = new KnownRobotsStore({ filePath: FAKE_PATH, ...fakeFs, now: makeNow("t") });

    expect(() => store.recordSighting({ name: "abcde", usbSerial: "s1", role: null })).not.toThrow();
    await expect(store.flush()).resolves.toBeUndefined();

    expect(store.list().map((r) => r.name)).toEqual(["abcde"]);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("flush() with no pending mutation resolves without attempting a write", async () => {
    const fakeFs = createFakeFs();
    const store = new KnownRobotsStore({ filePath: FAKE_PATH, ...fakeFs, now: makeNow("t") });
    await expect(store.flush()).resolves.toBeUndefined();
    expect(fakeFs.writeFile).not.toHaveBeenCalled();
  });
});

describe("resolveKnownRobotsFilePath", () => {
  it("uses an explicit filePath over everything else", () => {
    expect(resolveKnownRobotsFilePath({ filePath: "/explicit/path.json", stateDir: "/ignored" }, {})).toBe(
      "/explicit/path.json",
    );
  });

  it("uses stateDir (joined with the fixed filename) over env vars", () => {
    expect(
      resolveKnownRobotsFilePath({ stateDir: "/tmp/state" }, { ROBOT_CONSOLE_STATE_DIR: "/ignored" }),
    ).toBe(path.join("/tmp/state", "known-robots.json"));
  });

  it("uses ROBOT_CONSOLE_STATE_DIR directly (no robot-console subdirectory appended)", () => {
    expect(resolveKnownRobotsFilePath({}, { ROBOT_CONSOLE_STATE_DIR: "/opt/rc-state" })).toBe(
      path.join("/opt/rc-state", "known-robots.json"),
    );
  });

  it("falls back to XDG_STATE_HOME/robot-console when ROBOT_CONSOLE_STATE_DIR is unset", () => {
    expect(resolveKnownRobotsFilePath({}, { XDG_STATE_HOME: "/home/user/.state" })).toBe(
      path.join("/home/user/.state", "robot-console", "known-robots.json"),
    );
  });

  it("falls back to ~/.local/state/robot-console when neither env var is set", () => {
    expect(resolveKnownRobotsFilePath({}, {})).toBe(
      path.join(homedir(), ".local", "state", "robot-console", "known-robots.json"),
    );
  });
});

describe("KnownRobotsStore: real filesystem (atomic rename, permission failure)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "known-robots-store-test-"));
  });

  afterEach(() => {
    try {
      chmodSync(tmpDir, 0o700);
    } catch {
      // best-effort restore so cleanup below can succeed
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes via a real temp-file-then-rename with no leftover temp file, and round-trips through a fresh instance", async () => {
    const filePath = path.join(tmpDir, "known-robots.json");
    const store = new KnownRobotsStore({ filePath, now: makeNow("2026-01-01T00:00:00.000Z") });
    store.recordSighting({ name: "abcde", usbSerial: "usb-1", role: "left" });
    await store.flush();

    const entries = readdirSync(tmpDir);
    expect(entries).toEqual(["known-robots.json"]);

    const fresh = new KnownRobotsStore({ filePath, now: makeNow("t") });
    expect(fresh.list()).toEqual(store.list());
  });

  // Skipped when running as root (e.g. some CI/container setups): root
  // bypasses directory permission bits entirely, so the write this test
  // depends on failing would instead silently succeed.
  const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
  it.skipIf(isRoot)(
    "a real permission failure (read-only directory) does not throw and leaves list() intact",
    async () => {
      const filePath = path.join(tmpDir, "known-robots.json");
      const store = new KnownRobotsStore({ filePath, now: makeNow("t") });
      store.recordSighting({ name: "abcde", usbSerial: "usb-1", role: null });
      await store.flush();
      expect(readdirSync(tmpDir)).toEqual(["known-robots.json"]);

      chmodSync(tmpDir, 0o500); // r-x: no write permission, so a new temp file cannot be created
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        store.recordSighting({ name: "fghij", usbSerial: "usb-2", role: null });
        await expect(store.flush()).resolves.toBeUndefined();
        expect(warnSpy).toHaveBeenCalled();
        expect(store.list().map((r) => r.name).sort()).toEqual(["abcde", "fghij"]);
      } finally {
        warnSpy.mockRestore();
        chmodSync(tmpDir, 0o700);
      }
    },
  );
});
