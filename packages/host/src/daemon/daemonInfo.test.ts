/**
 * daemon/daemonInfo.test.ts — round-trip, staleness, and probe coverage
 * for sprint 021 ticket 003's own read/write/remove/probe leaf. Mirrors
 * `store/wifiCredentials.test.ts`'s own convention: a real temporary
 * directory for the file I/O (no fs injection, matching
 * `daemonInfo.ts`'s own doc comment on why), a fake `fetch` for
 * {@link probeHostInfo} (its one network dependency).
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isProcessAlive, probeHostInfo, readDaemonInfo, removeDaemonInfo, writeDaemonInfo, type DaemonInfo } from "./daemonInfo.js";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "robot-console-daemon-info-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const SAMPLE: DaemonInfo = { pid: 12345, host: "0.0.0.0", port: 4795, startedAt: 1_700_000_000_000 };

describe("writeDaemonInfo / readDaemonInfo / removeDaemonInfo", () => {
  it("round-trips a written record, creating the state directory if needed", () => {
    const stateDir = path.join(tempDir(), "nested", "state-dir");
    writeDaemonInfo(SAMPLE, { stateDir });
    expect(readDaemonInfo({ stateDir })).toEqual(SAMPLE);

    const filePath = path.join(stateDir, "daemon.json");
    expect(JSON.parse(readFileSync(filePath, "utf8"))).toEqual(SAMPLE);

    removeDaemonInfo({ stateDir });
    expect(readDaemonInfo({ stateDir })).toBeUndefined();
  });

  it("returns undefined for a file that does not exist", () => {
    expect(readDaemonInfo({ stateDir: tempDir() })).toBeUndefined();
  });

  it("returns undefined for malformed JSON, treating it as absent", () => {
    const stateDir = tempDir();
    writeFileSync(path.join(stateDir, "daemon.json"), "not json at all", "utf8");
    expect(readDaemonInfo({ stateDir })).toBeUndefined();
  });

  it("returns undefined for well-formed JSON missing a required field", () => {
    const stateDir = tempDir();
    writeFileSync(path.join(stateDir, "daemon.json"), JSON.stringify({ pid: 1, host: "0.0.0.0" }), "utf8");
    expect(readDaemonInfo({ stateDir })).toBeUndefined();
  });

  it("removeDaemonInfo is a no-op (never throws) when the file is already absent", () => {
    expect(() => removeDaemonInfo({ stateDir: tempDir() })).not.toThrow();
  });

  it("an explicit filePath overrides stateDir resolution entirely", () => {
    const dir = tempDir();
    const filePath = path.join(dir, "custom-name.json");
    writeDaemonInfo(SAMPLE, { filePath });
    expect(readDaemonInfo({ filePath })).toEqual(SAMPLE);
    // Not written under the ordinary daemon.json name.
    expect(readDaemonInfo({ stateDir: dir })).toBeUndefined();
  });
});

describe("isProcessAlive", () => {
  it("is true for this process's own pid", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it("is false for a pid that (almost certainly) does not exist", () => {
    // A pid in the high range well past any realistic live process on a
    // dev/CI box -- mirrors sprint 018's `clearDeadProcessState` "is this
    // PID still real" idiom the issue references.
    expect(isProcessAlive(999_999)).toBe(false);
  });
});

describe("probeHostInfo", () => {
  it("returns the parsed body on a clean, identifying response", async () => {
    const fakeFetch = (async () => ({
      ok: true,
      json: async () => ({ ok: true, service: "robot-console", port: 4795 }),
    })) as unknown as typeof fetch;

    await expect(probeHostInfo("http://127.0.0.1:4795/api/host-info", 1000, { fetch: fakeFetch })).resolves.toEqual({
      ok: true,
      service: "robot-console",
      port: 4795,
    });
  });

  it("returns undefined on a non-2xx status", async () => {
    const fakeFetch = (async () => ({ ok: false, json: async () => ({ ok: true, service: "robot-console", port: 1 }) })) as unknown as typeof fetch;
    await expect(probeHostInfo("http://x/api/host-info", 1000, { fetch: fakeFetch })).resolves.toBeUndefined();
  });

  it("returns undefined on a body that does not carry an `ok` field", async () => {
    const fakeFetch = (async () => ({ ok: true, json: async () => ({ unrelated: true }) })) as unknown as typeof fetch;
    await expect(probeHostInfo("http://x/api/host-info", 1000, { fetch: fakeFetch })).resolves.toBeUndefined();
  });

  it("returns undefined when the body fails to parse as JSON", async () => {
    const fakeFetch = (async () => ({
      ok: true,
      json: async () => {
        throw new SyntaxError("Unexpected token");
      },
    })) as unknown as typeof fetch;
    await expect(probeHostInfo("http://x/api/host-info", 1000, { fetch: fakeFetch })).resolves.toBeUndefined();
  });

  it("returns undefined when fetch itself rejects (connection refused)", async () => {
    const fakeFetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    await expect(probeHostInfo("http://x/api/host-info", 1000, { fetch: fakeFetch })).resolves.toBeUndefined();
  });

  it("returns undefined when the request never settles within timeoutMs (an abort races a fetch that honors the signal)", async () => {
    const fakeFetch = ((_url: string, init?: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as unknown as typeof fetch;

    await expect(probeHostInfo("http://x/api/host-info", 10, { fetch: fakeFetch })).resolves.toBeUndefined();
  });
});
