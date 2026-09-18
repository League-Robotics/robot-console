/**
 * daemon/cli.test.ts — `runStart`/`runStop`/`runStatus`/`runOpen`'s own
 * decision logic (sprint 021 ticket 003), exercised against injected
 * fakes for `spawn`/fs/network/`openBrowser` -- mirroring `cli.test.ts`'s
 * own `CliDeps` convention. No test in this file (other than the
 * dedicated "real process" describe block at the bottom) starts a real
 * child process, opens a real socket, or touches the real filesystem.
 */
import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { spawn as nodeSpawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runStart, runStop, runStatus, runOpen, type DaemonCliDeps, type SpawnedChildLike } from "./cli.js";
import type { DaemonInfo, HostInfoProbeResult } from "./daemonInfo.js";

function fakeSpawnedChild(pid = 4242): SpawnedChildLike {
  return { pid, unref: vi.fn() };
}

/** A minimal, fully-fake `DaemonCliDeps` -- every test below overrides
 * only the fields its own scenario cares about. `sleep` is a no-op by
 * default so bounded-wait loops in tests never actually wait in real
 * time. */
function baseDeps(overrides: DaemonCliDeps = {}): DaemonCliDeps {
  return {
    env: {} as NodeJS.ProcessEnv,
    sleep: vi.fn().mockResolvedValue(undefined),
    now: (() => {
      let t = 0;
      return () => t++;
    })(),
    openLogFd: vi.fn().mockReturnValue(7),
    closeLogFd: vi.fn(),
    ...overrides,
  };
}

describe("runStart", () => {
  it("spawns exactly one detached child, waits for it to report ready, and prints/returns its URL when nothing is running yet", async () => {
    const probeHostInfo = vi
      .fn<(url: string, timeoutMs: number) => Promise<HostInfoProbeResult | undefined>>()
      .mockResolvedValueOnce(undefined) // pre-spawn probe: nothing running
      .mockResolvedValueOnce(undefined) // first readiness poll: not ready yet
      .mockResolvedValueOnce({ ok: true, service: "robot-console", port: 4795 }); // second poll: ready
    const readDaemonInfo = vi.fn<() => DaemonInfo | undefined>().mockReturnValue(undefined);
    const spawnFn = vi.fn().mockReturnValue(fakeSpawnedChild());

    const result = await runStart(baseDeps({ probeHostInfo, readDaemonInfo, spawn: spawnFn }));

    expect(result).toEqual({ outcome: "started", url: "http://127.0.0.1:4795", pid: 4242 });
    expect(spawnFn).toHaveBeenCalledTimes(1);
    const [command, args, options] = spawnFn.mock.calls[0] as [string, string[], { detached?: boolean }];
    expect(args).toContain("--no-open");
    expect(options.detached).toBe(true);
    expect(command).toBeTruthy();
  });

  it("a second start while the first is still running reports already-running and never spawns a second child", async () => {
    const probeHostInfo = vi.fn().mockResolvedValue({ ok: true, service: "robot-console", port: 4795 });
    const spawnFn = vi.fn();

    const result = await runStart(baseDeps({ probeHostInfo, spawn: spawnFn }));

    expect(result).toEqual({ outcome: "already-running", url: "http://127.0.0.1:4795" });
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it("a stale daemon-info file (pid no longer alive) is detected and removed, and start proceeds fresh", async () => {
    const probeHostInfo = vi
      .fn<(url: string, timeoutMs: number) => Promise<HostInfoProbeResult | undefined>>()
      .mockResolvedValueOnce(undefined) // pre-spawn probe: nothing running
      .mockResolvedValueOnce({ ok: true, service: "robot-console", port: 4795 }); // readiness poll
    const staleInfo: DaemonInfo = { pid: 99999, host: "0.0.0.0", port: 4795, startedAt: 0 };
    const readDaemonInfo = vi.fn<() => DaemonInfo | undefined>().mockReturnValue(staleInfo);
    const removeDaemonInfo = vi.fn();
    const isProcessAlive = vi.fn().mockReturnValue(false);
    const spawnFn = vi.fn().mockReturnValue(fakeSpawnedChild());

    const result = await runStart(baseDeps({ probeHostInfo, readDaemonInfo, removeDaemonInfo, isProcessAlive, spawn: spawnFn }));

    expect(removeDaemonInfo).toHaveBeenCalledTimes(1);
    expect(spawnFn).toHaveBeenCalledTimes(1);
    expect(result.outcome).toBe("started");
  });

  it("a daemon-info file naming a still-alive pid that does not answer the probe refuses to spawn a second instance", async () => {
    const probeHostInfo = vi.fn().mockResolvedValue(undefined);
    const aliveInfo: DaemonInfo = { pid: 555, host: "0.0.0.0", port: 4795, startedAt: 0 };
    const readDaemonInfo = vi.fn<() => DaemonInfo | undefined>().mockReturnValue(aliveInfo);
    const isProcessAlive = vi.fn().mockReturnValue(true);
    const removeDaemonInfo = vi.fn();
    const spawnFn = vi.fn();

    await expect(runStart(baseDeps({ probeHostInfo, readDaemonInfo, isProcessAlive, removeDaemonInfo, spawn: spawnFn }))).rejects.toThrow(
      /pid 555/,
    );
    expect(spawnFn).not.toHaveBeenCalled();
    expect(removeDaemonInfo).not.toHaveBeenCalled();
  });

  it("throws a clear, log-pointing error if the spawned child never becomes ready within the bounded timeout", async () => {
    const probeHostInfo = vi.fn().mockResolvedValue(undefined);
    const spawnFn = vi.fn().mockReturnValue(fakeSpawnedChild());
    let calls = 0;
    const now = () => (calls++ === 0 ? 0 : 1000);

    await expect(
      runStart(baseDeps({ probeHostInfo, spawn: spawnFn, now, readyTimeoutMs: 500, readyPollIntervalMs: 1 })),
    ).rejects.toThrow(/start failed/);
    expect(spawnFn).toHaveBeenCalledTimes(1);
  });

  it("never probes or spawns against anything but the one default port, even if ROBOT_CONSOLE_PORT is set in env", async () => {
    const probeHostInfo = vi.fn().mockResolvedValue({ ok: true, service: "robot-console", port: 4795 });

    await runStart(baseDeps({ probeHostInfo, env: { ROBOT_CONSOLE_PORT: "9999" } as unknown as NodeJS.ProcessEnv }));

    expect(probeHostInfo).toHaveBeenCalledWith("http://127.0.0.1:4795/api/host-info", expect.any(Number));
  });
});

describe("runStop", () => {
  it("against no daemon-info reports not-running and exits cleanly (no signal sent)", async () => {
    const readDaemonInfo = vi.fn<() => DaemonInfo | undefined>().mockReturnValue(undefined);
    const kill = vi.fn();

    const result = await runStop(baseDeps({ readDaemonInfo, kill }));

    expect(result).toEqual({ outcome: "not-running" });
    expect(kill).not.toHaveBeenCalled();
  });

  it("against a stale daemon-info file (dead pid) reports not-running and removes the file", async () => {
    const info: DaemonInfo = { pid: 111, host: "0.0.0.0", port: 4795, startedAt: 0 };
    const readDaemonInfo = vi.fn<() => DaemonInfo | undefined>().mockReturnValue(info);
    const isProcessAlive = vi.fn().mockReturnValue(false);
    const removeDaemonInfo = vi.fn();
    const kill = vi.fn();

    const result = await runStop(baseDeps({ readDaemonInfo, isProcessAlive, removeDaemonInfo, kill }));

    expect(result).toEqual({ outcome: "not-running" });
    expect(kill).not.toHaveBeenCalled();
    expect(removeDaemonInfo).toHaveBeenCalledTimes(1);
  });

  it("against a running daemon sends SIGTERM, waits for it to actually exit, then removes the daemon-info file", async () => {
    const info: DaemonInfo = { pid: 222, host: "0.0.0.0", port: 4795, startedAt: 0 };
    const readDaemonInfo = vi.fn<() => DaemonInfo | undefined>().mockReturnValue(info);
    // Alive on the first two checks (before, and one poll iteration),
    // then gone -- proves this waits rather than trusting the signal
    // alone.
    const isProcessAlive = vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(true).mockReturnValueOnce(false);
    const removeDaemonInfo = vi.fn();
    const kill = vi.fn();

    const result = await runStop(baseDeps({ readDaemonInfo, isProcessAlive, removeDaemonInfo, kill }));

    expect(kill).toHaveBeenCalledWith(222, "SIGTERM");
    expect(result).toEqual({ outcome: "stopped", pid: 222 });
    expect(removeDaemonInfo).toHaveBeenCalledTimes(1);
  });

  it("reports timed-out (not stopped) and does not remove daemon-info if the process never actually exits", async () => {
    const info: DaemonInfo = { pid: 333, host: "0.0.0.0", port: 4795, startedAt: 0 };
    const readDaemonInfo = vi.fn<() => DaemonInfo | undefined>().mockReturnValue(info);
    const isProcessAlive = vi.fn().mockReturnValue(true); // never goes false
    const removeDaemonInfo = vi.fn();
    const kill = vi.fn();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let calls = 0;
    const now = () => (calls++ === 0 ? 0 : 10_000);

    const result = await runStop(baseDeps({ readDaemonInfo, isProcessAlive, removeDaemonInfo, kill, now, stopTimeoutMs: 500 }));

    expect(result).toEqual({ outcome: "timed-out", pid: 333 });
    expect(removeDaemonInfo).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

describe("runStatus", () => {
  it("reports running with port/url/uptime when the probe identifies the host", async () => {
    const probeHostInfo = vi.fn().mockResolvedValue({ ok: true, service: "robot-console", port: 4795 });
    const info: DaemonInfo = { pid: 444, host: "0.0.0.0", port: 4795, startedAt: 500 };
    const readDaemonInfo = vi.fn<() => DaemonInfo | undefined>().mockReturnValue(info);

    const result = await runStatus(baseDeps({ probeHostInfo, readDaemonInfo, now: () => 1500 }));

    expect(result).toEqual({ outcome: "running", url: "http://127.0.0.1:4795", port: 4795, uptimeMs: 1000 });
  });

  it("reports not-running and removes a stale daemon-info file when the probe does not identify a host", async () => {
    const probeHostInfo = vi.fn().mockResolvedValue(undefined);
    const info: DaemonInfo = { pid: 555, host: "0.0.0.0", port: 4795, startedAt: 0 };
    const readDaemonInfo = vi.fn<() => DaemonInfo | undefined>().mockReturnValue(info);
    const removeDaemonInfo = vi.fn();

    const result = await runStatus(baseDeps({ probeHostInfo, readDaemonInfo, removeDaemonInfo }));

    expect(result).toEqual({ outcome: "not-running" });
    expect(removeDaemonInfo).toHaveBeenCalledTimes(1);
  });

  it("reports not-running with no daemon-info to clean up when nothing was ever recorded", async () => {
    const probeHostInfo = vi.fn().mockResolvedValue(undefined);
    const readDaemonInfo = vi.fn<() => DaemonInfo | undefined>().mockReturnValue(undefined);
    const removeDaemonInfo = vi.fn();

    const result = await runStatus(baseDeps({ probeHostInfo, readDaemonInfo, removeDaemonInfo }));

    expect(result).toEqual({ outcome: "not-running" });
    expect(removeDaemonInfo).not.toHaveBeenCalled();
  });

  it("reports running even with no daemon-info at all -- an old build with no daemon.json is still detected via the probe alone (defect 2)", async () => {
    const probeHostInfo = vi.fn().mockResolvedValue({ ok: true, service: "robot-console", port: 4795 });
    const readDaemonInfo = vi.fn<() => DaemonInfo | undefined>().mockReturnValue(undefined);

    const result = await runStatus(baseDeps({ probeHostInfo, readDaemonInfo }));

    expect(result).toEqual({ outcome: "running", url: "http://127.0.0.1:4795", port: 4795 });
  });
});

describe("runOpen", () => {
  it("against a running host opens a local browser and prints/returns a LAN-shareable hostname URL, without calling openBrowser twice", async () => {
    const probeHostInfo = vi.fn().mockResolvedValue({ ok: true, service: "robot-console", port: 4795 });
    const readDaemonInfo = vi.fn<() => DaemonInfo | undefined>().mockReturnValue(undefined);
    const openBrowser = vi.fn().mockResolvedValue(undefined);

    const result = await runOpen(baseDeps({ probeHostInfo, readDaemonInfo, openBrowser }));

    expect(openBrowser).toHaveBeenCalledTimes(1);
    expect(openBrowser).toHaveBeenCalledWith("http://127.0.0.1:4795");
    expect(result.outcome).toBe("opened");
    if (result.outcome === "opened") {
      expect(result.localUrl).toBe("http://127.0.0.1:4795");
      expect(result.shareableUrl).toMatch(/^http:\/\/.+\.local:4795$/);
    }
  });

  it("against no running host reports not-running and never calls openBrowser", async () => {
    const probeHostInfo = vi.fn().mockResolvedValue(undefined);
    const readDaemonInfo = vi.fn<() => DaemonInfo | undefined>().mockReturnValue(undefined);
    const openBrowser = vi.fn();

    const result = await runOpen(baseDeps({ probeHostInfo, readDaemonInfo, openBrowser }));

    expect(result).toEqual({ outcome: "not-running" });
    expect(openBrowser).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------
// Real-process integration test (mirroring scripts/bench/layer2's own
// pattern: a real spawned host, a scratch state dir, bounded and
// self-cleaning). Deliberately uses an explicit scratch `port` override
// (see DaemonCliDeps.port's own doc comment) rather than the real
// DEFAULT_PORT: a real robot-console (or another session's dev server)
// may already occupy 4795 on this bench Mac, and this test must never
// interact with a process it did not itself start. `--no-sweep` keeps
// the spawned host from touching any real relay radio; a fresh scratch
// store has no owned devices, so its reconciler never auto-connects to
// any real hardware the USB/mDNS watchers happen to see either.
// ---------------------------------------------------------------------
describe("real process (spawns an actual robot-console host)", () => {
  it(
    "start spawns a real detached host, a second start attaches instead of double-spawning, and stop tears it down for real",
    async () => {
      const stateDir = mkdtempSync(path.join(tmpdir(), "robot-console-daemon-cli-integ-"));
      const port = 19000 + Math.floor(Math.random() * 2000);
      const thisDir = path.dirname(fileURLToPath(import.meta.url));
      const binPath = path.resolve(thisDir, "../../../../bin/robot-console.js");

      const spawnCalls: unknown[][] = [];
      const realSpawn: DaemonCliDeps["spawn"] = (command, args, options) => {
        spawnCalls.push([command, args, options]);
        const child = nodeSpawn(command, [...args, "--port", String(port), "--no-sweep"], {
          detached: options.detached,
          stdio: options.stdio,
          env: options.env,
        });
        return { pid: child.pid, unref: () => child.unref() };
      };

      const deps: DaemonCliDeps = {
        env: { ...process.env, ROBOT_CONSOLE_STATE_DIR: stateDir },
        stateDir,
        port,
        binPath,
        spawn: realSpawn,
        readyTimeoutMs: 20_000,
        readyPollIntervalMs: 300,
        stopTimeoutMs: 10_000,
        stopPollIntervalMs: 200,
      };

      try {
        const first = await runStart(deps);
        expect(first.outcome).toBe("started");
        expect(spawnCalls).toHaveLength(1);

        const second = await runStart(deps);
        expect(second.outcome).toBe("already-running");
        // No second child process spawned -- the vevov-grab regression
        // this sprint exists to prevent.
        expect(spawnCalls).toHaveLength(1);

        const pid = first.outcome === "started" ? first.pid : undefined;
        expect(pid).toBeDefined();

        const stopResult = await runStop(deps);
        expect(stopResult).toEqual({ outcome: "stopped", pid });

        // Confirmed gone -- not merely "a signal was sent".
        if (pid !== undefined) {
          expect(() => process.kill(pid, 0)).toThrow();
        }

        const statusAfterStop = await runStatus(deps);
        expect(statusAfterStop).toEqual({ outcome: "not-running" });
      } finally {
        rmSync(stateDir, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
