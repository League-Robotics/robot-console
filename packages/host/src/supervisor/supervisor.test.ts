/**
 * supervisor.test.ts — the supervisor against a real child process: the
 * `fakeHost.fixture.mjs` stand-in (never the real host, which opens
 * USB/serial ports). Ports are ephemeral; timings are short but every
 * assertion waits on observable state rather than sleeping a fixed
 * amount and hoping.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { parseSupervisorConfig } from "./cli.js";
import { startSupervisor, type RunningSupervisor, type SupervisorOptions, type SupervisorStatus } from "./supervisor.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, "fakeHost.fixture.mjs");
const REPO_ROOT = path.resolve(HERE, "../../../..");

const supervisors: RunningSupervisor[] = [];
const sockets: WebSocket[] = [];
const children: ChildProcess[] = [];
const pids = new Set<number>();
const tempDirs: string[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) {
    socket.terminate();
  }
  await Promise.all(supervisors.splice(0).map((s) => s.close()));
  for (const child of children.splice(0)) {
    child.kill("SIGKILL");
  }
  for (const pid of pids) {
    if (isAlive(pid)) {
      process.kill(pid, "SIGKILL");
    }
  }
  pids.clear();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function waitFor<T>(check: () => T | undefined | false | Promise<T | undefined | false>, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error("waitFor timed out");
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function makeUiDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "rc-supervisor-ui-"));
  tempDirs.push(dir);
  writeFileSync(path.join(dir, "index.html"), "<!doctype html><title>ui-index</title>");
  mkdirSync(path.join(dir, "assets"));
  writeFileSync(path.join(dir, "assets", "app.js"), "console.log('app');");
  return dir;
}

async function start(
  overrides: Partial<SupervisorOptions> = {},
  fakeEnv: Record<string, string> = {},
): Promise<{ supervisor: RunningSupervisor; logs: string[] }> {
  const hostPort = await freePort();
  const logs: string[] = [];
  const supervisor = await startSupervisor({
    port: 0,
    hostPort,
    hostCommand: [process.execPath, FIXTURE],
    hostEnv: { ...process.env, ROBOT_CONSOLE_PORT: String(hostPort), ...fakeEnv },
    uiDir: makeUiDir(),
    idleMs: 300,
    startTimeoutMs: 5000,
    killTimeoutMs: 3000,
    restartBackoffInitialMs: 200,
    readyPollMs: 25,
    log: (line) => {
      logs.push(line);
      const match = /\(pid (\d+)/.exec(line);
      if (match) {
        pids.add(Number(match[1]));
      }
    },
    ...overrides,
  });
  supervisors.push(supervisor);
  return { supervisor, logs };
}

async function getStatus(supervisor: RunningSupervisor): Promise<SupervisorStatus> {
  const response = await fetch(`${supervisor.url}__supervisor/status`);
  expect(response.status).toBe(200);
  return (await response.json()) as SupervisorStatus;
}

/** Open a proxied socket; resolves once the fake host's first message
 * (its snapshot) has arrived, proving host -> client. */
function connect(supervisor: RunningSupervisor): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${supervisor.port}/`);
    sockets.push(socket);
    socket.once("message", (data) => {
      const message = JSON.parse(String(data)) as { type: string };
      if (message.type === "snapshot") {
        resolve(socket);
      } else {
        reject(new Error(`unexpected first message ${String(data)}`));
      }
    });
    socket.once("error", reject);
  });
}

/** client -> host -> client round trip; returns the echoing host pid. */
function echo(socket: WebSocket, text: string): Promise<number> {
  return new Promise((resolve) => {
    const onMessage = (data: WebSocket.RawData) => {
      const match = /^echo:(\d+):(.*)$/.exec(String(data));
      if (match && match[2] === text) {
        socket.off("message", onMessage);
        resolve(Number(match[1]));
      }
    };
    socket.on("message", onMessage);
    socket.send(text);
  });
}

function closeSocket(socket: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    socket.once("close", () => resolve());
    socket.close();
  });
}

describe("supervisor: HTTP", () => {
  it("serves static files and the SPA fallback without starting the host", async () => {
    const { supervisor } = await start();

    const index = await fetch(supervisor.url);
    expect(index.status).toBe(200);
    expect(await index.text()).toContain("ui-index");

    const deepLink = await fetch(`${supervisor.url}robot/some-robot`);
    expect(deepLink.status).toBe(200);
    expect(await deepLink.text()).toContain("ui-index");

    const asset = await fetch(`${supervisor.url}assets/app.js`);
    expect(await asset.text()).toContain("console.log('app')");

    const unknownSupervisorPath = await fetch(`${supervisor.url}__supervisor/nope`);
    expect(unknownSupervisorPath.status).toBe(404);

    expect(await getStatus(supervisor)).toEqual({
      hostState: "stopped",
      hostPid: null,
      connections: 0,
      pendingUpgrades: 0,
      idleMsRemaining: null,
      restarts: 0,
      lastExit: null,
    });
  });

  it("explains itself when the UI has not been built", async () => {
    const { supervisor } = await start({ uiDir: path.join(os.tmpdir(), "rc-supervisor-no-such-ui") });
    const response = await fetch(supervisor.url);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("UI has not been built");
  });

  it("fails with a clear message when the public port is taken", async () => {
    const { supervisor } = await start();
    await expect(start({ port: supervisor.port })).rejects.toThrow(/already in use/);
  });

  // Merge note (linux-packaging x sprint 021): `/api/host-info` must be
  // answered here -- not left to the SPA catch-all -- so that both
  // `daemon/cli.ts`'s EADDRINUSE-attach probe and `AppHeader`'s running-
  // version display work the same way whether a bare host or a
  // supervisor-fronted install answers on the public port. See this
  // module's own doc comment, "`GET /api/host-info` is answered here,
  // not proxied".
  it("answers GET /api/host-info itself, with its own public port, whether or not the host is running", async () => {
    const { supervisor } = await start();

    const response = await fetch(`${supervisor.url}api/host-info`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/application\/json/);
    const body = (await response.json()) as { ok: boolean; service: string; port: number; version?: string };
    expect(body).toMatchObject({ ok: true, service: "robot-console", port: supervisor.port });

    // Unaffected by a live proxied connection -- still the supervisor's
    // own port, not the (different) host child port.
    const socket = await connect(supervisor);
    const whileRunning = await fetch(`${supervisor.url}api/host-info`);
    expect(await whileRunning.json()).toMatchObject({ ok: true, service: "robot-console", port: supervisor.port });
    await closeSocket(socket);
  });
});

describe("supervisor: WebSocket proxy and host lifecycle", () => {
  it("holds the first upgrade until the host is ready, then pipes both ways", async () => {
    const { supervisor } = await start({}, { FAKE_HOST_LISTEN_DELAY_MS: "300" });

    const socket = await connect(supervisor);
    const status = await getStatus(supervisor);
    expect(status).toMatchObject({ hostState: "running", connections: 1, pendingUpgrades: 0, idleMsRemaining: null });
    expect(status.hostPid).not.toBeNull();
    expect(await echo(socket, "hello")).toBe(status.hostPid);
  });

  it("stops the host after the idle time once the last window disconnects", async () => {
    const { supervisor } = await start({ idleMs: 300 });
    const socket = await connect(supervisor);
    const pid = (await getStatus(supervisor)).hostPid!;

    await closeSocket(socket);
    const idle = await waitFor(async () => {
      const s = await getStatus(supervisor);
      return s.connections === 0 && s.idleMsRemaining !== null && s;
    });
    expect(idle.hostState).toBe("running");

    const stopped = await waitFor(async () => {
      const s = await getStatus(supervisor);
      return s.hostState === "stopped" && s;
    });
    expect(stopped).toMatchObject({ hostPid: null, idleMsRemaining: null, restarts: 0, lastExit: { expected: true } });
    await waitFor(() => !isAlive(pid));
  });

  it("does not restart the host when a window reconnects within the idle grace (page reload)", async () => {
    const { supervisor } = await start({ idleMs: 800 });
    const first = await connect(supervisor);
    const pid = (await getStatus(supervisor)).hostPid;

    await closeSocket(first);
    const second = await connect(supervisor);
    expect(await getStatus(supervisor)).toMatchObject({ hostState: "running", hostPid: pid, connections: 1, idleMsRemaining: null });

    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(await getStatus(supervisor)).toMatchObject({ hostState: "running", hostPid: pid });
    expect(await echo(second, "still-here")).toBe(pid);
  });

  it("restarts a host that crashes while in use, with growing backoff", async () => {
    const { supervisor, logs } = await start({ idleMs: 5000, restartBackoffInitialMs: 200 });
    await connect(supervisor);
    const pid1 = (await getStatus(supervisor)).hostPid!;

    process.kill(pid1, "SIGKILL");
    await waitFor(async () => (await getStatus(supervisor)).hostState === "stopped");
    expect(logs).toContain("restarting host in 200 ms");

    const restarted = await waitFor(async () => {
      const s = await getStatus(supervisor);
      return s.hostState === "running" && s.hostPid !== pid1 && s;
    });
    expect(restarted.restarts).toBe(1);
    expect(restarted.lastExit).toMatchObject({ expected: false, signal: "SIGKILL" });

    // The UI reconnects on its own; a fresh socket reaches the new host.
    const socket = await connect(supervisor);
    expect(await echo(socket, "after-crash")).toBe(restarted.hostPid);

    process.kill(restarted.hostPid!, "SIGKILL");
    await waitFor(() => logs.includes("restarting host in 400 ms"));
    await waitFor(async () => (await getStatus(supervisor)).restarts === 2);
  });

  it("only records a host exit that happens while idle", async () => {
    const { supervisor, logs } = await start({ idleMs: 5000, restartBackoffInitialMs: 100 });
    const socket = await connect(supervisor);
    const pid = (await getStatus(supervisor)).hostPid!;
    await closeSocket(socket);

    // Past the crash-disconnect window: this exit is unrelated to use.
    await new Promise((resolve) => setTimeout(resolve, 2300));
    process.kill(pid, "SIGKILL");
    await waitFor(() => logs.includes("host exited while idle -- not restarting"));
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(await getStatus(supervisor)).toMatchObject({
      hostState: "stopped",
      restarts: 0,
      idleMsRemaining: null,
      lastExit: { expected: false },
    });
  }, 10_000);

  it("answers 503 when the host does not become ready in time, then stops it", async () => {
    const { supervisor } = await start({ startTimeoutMs: 400, idleMs: 200 }, { FAKE_HOST_NO_LISTEN: "1" });

    const statusCode = await new Promise<number>((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${supervisor.port}/`);
      sockets.push(socket);
      socket.once("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
      socket.once("open", () => reject(new Error("should not open")));
      socket.once("error", () => undefined);
    });
    expect(statusCode).toBe(503);

    const after = await getStatus(supervisor);
    expect(after.pendingUpgrades).toBe(0);
    expect(after.connections).toBe(0);
    await waitFor(async () => (await getStatus(supervisor)).hostState === "stopped");
  });

  it("SIGKILLs a host that ignores SIGTERM after the kill timeout", async () => {
    const { supervisor } = await start({ killTimeoutMs: 300 }, { FAKE_HOST_IGNORE_SIGTERM: "1" });
    await connect(supervisor);
    const pid = (await getStatus(supervisor)).hostPid!;

    await supervisor.close();
    expect(isAlive(pid)).toBe(false);
    expect(supervisor.status().lastExit).toMatchObject({ expected: true, signal: "SIGKILL" });
  });
});

describe("supervisor: cli", () => {
  it("resolves defaults and gives the host its own port", () => {
    const config = parseSupervisorConfig([], { ROBOT_CONSOLE_PORT: "4795", ROBOT_CONSOLE_STATE_DIR: "/state" });
    expect(config).toMatchObject({ port: 4795, hostPort: 4796, idleMs: 30_000, startTimeoutMs: 30_000, killTimeoutMs: 120_000 });
    expect(config.hostCommand.slice(1)).toEqual([path.join(REPO_ROOT, "bin/robot-console.js"), "--no-open", "--port", "4796"]);
    expect(config.uiDir).toBe(path.join(REPO_ROOT, "packages/ui/dist"));
    expect(config.hostEnv).toMatchObject({ ROBOT_CONSOLE_PORT: "4796", ROBOT_CONSOLE_NO_OPEN: "1", ROBOT_CONSOLE_STATE_DIR: "/state" });
  });

  it("honours flags and env overrides and rejects bad values", () => {
    const config = parseSupervisorConfig(["--port", "4895", "--host-port=4896", "--ui-dir", "/ui"], {
      ROBOT_CONSOLE_IDLE_MS: "5000",
      ROBOT_CONSOLE_HOST_COMMAND: JSON.stringify(["node", "fake.mjs"]),
    });
    expect(config).toMatchObject({ port: 4895, hostPort: 4896, uiDir: "/ui", idleMs: 5000, hostCommand: ["node", "fake.mjs"] });
    expect(() => parseSupervisorConfig([], { ROBOT_CONSOLE_HOST_COMMAND: "node fake.mjs" })).toThrow(/JSON array/);
    expect(() => parseSupervisorConfig([], { ROBOT_CONSOLE_HOST_PORT: "4795" })).toThrow(/both 4795/);
    expect(() => parseSupervisorConfig([], { ROBOT_CONSOLE_IDLE_MS: "soon" })).toThrow(/ROBOT_CONSOLE_IDLE_MS/);
  });

  /** Run cli.ts's main() in a real Node process (via tsx), the way
   * bin/robot-console-supervisor.js does, so real signals are used. */
  function spawnSupervisor(env: Record<string, string>): { child: ChildProcess; output: () => string } {
    const cliUrl = pathToFileURL(path.join(HERE, "cli.ts")).href;
    const script =
      `const { main } = await import(${JSON.stringify(cliUrl)});` +
      `try { await main(process.argv.slice(1)); }` +
      `catch (error) { console.error("robot-console-supervisor: " + error.message); process.exitCode = 1; }`;
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: REPO_ROOT,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);
    let output = "";
    child.stdout?.on("data", (chunk) => (output += String(chunk)));
    child.stderr?.on("data", (chunk) => (output += String(chunk)));
    return { child, output: () => output };
  }

  it("SIGTERM stops the host and exits 0", async () => {
    const hostPort = await freePort();
    const { child, output } = spawnSupervisor({
      ROBOT_CONSOLE_PORT: "0",
      ROBOT_CONSOLE_HOST_PORT: String(hostPort),
      ROBOT_CONSOLE_UI_DIR: makeUiDir(),
      ROBOT_CONSOLE_HOST_COMMAND: JSON.stringify([process.execPath, FIXTURE]),
    });
    const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));

    const port = await waitFor(() => /listening on http:\/\/127\.0\.0\.1:(\d+)\//.exec(output())?.[1], 10_000);
    const supervisor = { port: Number(port), url: `http://127.0.0.1:${port}/` } as RunningSupervisor;
    await connect(supervisor);
    const pid = (await getStatus(supervisor)).hostPid!;
    pids.add(pid);
    expect(isAlive(pid)).toBe(true);

    child.kill("SIGTERM");
    expect(await exited).toBe(0);
    expect(isAlive(pid)).toBe(false);
    expect(output()).toContain("received SIGTERM");
  }, 15_000);

  it("exits non-zero with a one-line error when the public port is taken", async () => {
    const blocker = net.createServer();
    await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
    const address = blocker.address();
    const takenPort = typeof address === "object" && address ? address.port : 0;
    try {
      const { child, output } = spawnSupervisor({
        ROBOT_CONSOLE_PORT: String(takenPort),
        ROBOT_CONSOLE_HOST_PORT: String(await freePort()),
        ROBOT_CONSOLE_UI_DIR: makeUiDir(),
        ROBOT_CONSOLE_HOST_COMMAND: JSON.stringify([process.execPath, FIXTURE]),
      });
      const code = await new Promise<number | null>((resolve) => child.once("exit", (c) => resolve(c)));
      expect(code).toBe(1);
      expect(output().trim()).toBe(
        `robot-console-supervisor: port ${takenPort} is already in use on 127.0.0.1 -- is another robot-console already running?`,
      );
    } finally {
      blocker.close();
    }
  }, 15_000);
});
