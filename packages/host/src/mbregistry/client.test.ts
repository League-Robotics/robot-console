/**
 * client.test.ts — sprint 018 ticket 001's own suite: one JSON-lines
 * fake server per test (a real `net.createServer`/`net.connect` Unix
 * socket in a temp dir — no real `mbregistry` binary anywhere, per this
 * sprint's Test Strategy constraint) plus a fake `child_process.spawn`
 * for the resolution steps that spawn or shell out to `--version`.
 *
 * One suite per acceptance criterion of ticket 001, in order.
 */
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import type { ChildProcess } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  MIN_MBREGISTRY_VERSION,
  MbregistryError,
  clientSocketCandidates,
  compareVersions,
  consoleOwnedEndpoint,
  createMbregistryClient,
  extractVersion,
  parseEndpointSpec,
  resolveMbregistryConnection,
  type ConnectFn,
  type LockKind,
  type ResolvedEndpoint,
  type SpawnFn,
} from "./client.js";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

/** A minimal JSON-lines fake `mbregistry` server over a Unix socket, for
 * exercising the wire protocol without any real mbregistry binary. Ops
 * are dispatched to `handlers`; a missing handler gets `not_found`, just
 * like a real unrecognized/unhandled case would surface to a client. */
class FakeRegistryServer {
  private readonly server: net.Server;
  private readonly sockets = new Set<net.Socket>();
  private readonly locks = new Map<string, LockKind>();

  constructor(private readonly devices: Record<string, unknown>[] = []) {
    this.server = net.createServer((socket) => {
      this.sockets.add(socket);
      socket.on("close", () => this.sockets.delete(socket));
      let buffer = "";
      socket.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        let idx: number;
        while ((idx = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 1);
          if (line.trim().length === 0) continue;
          this.handleLine(socket, JSON.parse(line));
        }
      });
    });
  }

  private handleLine(socket: net.Socket, op: Record<string, unknown>): void {
    const write = (resp: unknown) => socket.write(JSON.stringify(resp) + "\n");
    switch (op.op) {
      case "list":
        write({ ok: true, devices: this.devices });
        return;
      case "find": {
        const device = this.devices.find((d) => d.uid === op.uid);
        if (device === undefined) {
          write({ ok: false, code: "not_found", error: `no such device: ${String(op.uid)}` });
        } else {
          write({ ok: true, device });
        }
        return;
      }
      case "lock": {
        const uid = String(op.uid);
        if (this.locks.has(uid)) {
          write({
            ok: false,
            code: "locked",
            error: "already locked",
            holder: { kind: this.locks.get(uid), pid: 1, label: null, since: 0 },
          });
        } else {
          this.locks.set(uid, op.kind as LockKind);
          write({ ok: true });
        }
        return;
      }
      case "unlock": {
        const uid = String(op.uid);
        const released = this.locks.delete(uid);
        write({ ok: true, released });
        return;
      }
      case "watch":
        write({ ok: true });
        return;
      default:
        write({ ok: false, code: "invalid_request", error: `unknown op: ${String(op.op)}` });
    }
  }

  /** Push one raw line (used for `watch` events) to every connected
   * socket — this fake has exactly one client per test. */
  pushToAll(payload: unknown): void {
    for (const socket of this.sockets) {
      socket.write(JSON.stringify(payload) + "\n");
    }
  }

  listen(socketPath: string): Promise<void> {
    fs.mkdirSync(path.dirname(socketPath), { recursive: true });
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(socketPath, () => resolve());
    });
  }

  close(): Promise<void> {
    for (const socket of this.sockets) {
      socket.destroy();
    }
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}

/** A fake `ChildProcess` — an `EventEmitter` with `stdout`/`stderr`
 * sub-emitters and a no-op `kill()`, just enough surface for
 * `client.ts` to drive. */
function fakeChild(): ChildProcess & { stdout: EventEmitter; stderr: EventEmitter } {
  const child = new EventEmitter() as unknown as ChildProcess & { stdout: EventEmitter; stderr: EventEmitter };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn(() => true) as unknown as ChildProcess["kill"];
  return child;
}

let tmpDirs: string[] = [];

function freshTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mbregistry-client-test-"));
  tmpDirs.push(dir);
  return dir;
}

const connect: ConnectFn = (endpoint: ResolvedEndpoint) => {
  if (endpoint.kind === "tcp") {
    return net.connect({ host: endpoint.host, port: endpoint.port });
  }
  return net.connect({ path: endpoint.path });
};

afterEach(() => {
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// $ROBOT_CONSOLE_MBREGISTRY (resolution step 1)
// ---------------------------------------------------------------------------

describe("resolveMbregistryConnection — step 1: $ROBOT_CONSOLE_MBREGISTRY", () => {
  it("connects there directly and never spawns", async () => {
    const dir = freshTmpDir();
    const socketPath = path.join(dir, "explicit.sock");
    const server = new FakeRegistryServer();
    await server.listen(socketPath);
    const spawnFn = vi.fn() as unknown as SpawnFn;

    const resolved = await resolveMbregistryConnection({
      env: { ROBOT_CONSOLE_MBREGISTRY: socketPath },
      connect,
      spawnFn,
    });

    expect(resolved.endpoint).toEqual({ kind: "unix", path: socketPath });
    expect(resolved.spawned).toBe(false);
    expect(spawnFn).not.toHaveBeenCalled();
    resolved.socket.destroy();
    await server.close();
  });

  it("surfaces a clear connect error when unreachable, without falling back to spawn", async () => {
    const dir = freshTmpDir();
    const socketPath = path.join(dir, "nothing-listening.sock");
    const spawnFn = vi.fn() as unknown as SpawnFn;

    await expect(
      resolveMbregistryConnection({
        env: { ROBOT_CONSOLE_MBREGISTRY: socketPath },
        connect,
        spawnFn,
      }),
    ).rejects.toMatchObject({ code: "unreachable" });
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it("parses a host:port form as TCP", () => {
    expect(parseEndpointSpec("registry.local:7440")).toEqual({
      kind: "tcp",
      host: "registry.local",
      port: 7440,
    });
  });

  it("parses a bare socket path as unix", () => {
    expect(parseEndpointSpec("/run/mbregistry/api.sock")).toEqual({
      kind: "unix",
      path: "/run/mbregistry/api.sock",
    });
  });
});

// ---------------------------------------------------------------------------
// Standard client candidates (resolution step 2)
// ---------------------------------------------------------------------------

describe("resolveMbregistryConnection — step 2: standard client candidates", () => {
  it("connects to the running standard candidate without spawning", async () => {
    const dir = freshTmpDir();
    const fakeHome = freshTmpDir();
    const homedirFn = () => fakeHome;
    const candidates = clientSocketCandidates({}, homedirFn);
    const userCandidate = candidates[0];
    if (userCandidate.kind !== "unix") throw new Error("expected a unix candidate on this platform");

    const server = new FakeRegistryServer([{ uid: "abc123", short_uid: "abc" }]);
    await server.listen(userCandidate.path);
    const spawnFn = vi.fn() as unknown as SpawnFn;

    const resolved = await resolveMbregistryConnection({
      env: {},
      connect,
      spawnFn,
      homedirFn,
      livenessTimeoutMs: 1000,
    });

    expect(resolved.endpoint).toEqual(userCandidate);
    expect(resolved.spawned).toBe(false);
    expect(spawnFn).not.toHaveBeenCalled();
    resolved.socket.destroy();
    await server.close();
    void dir;
  });
});

// ---------------------------------------------------------------------------
// Previously-spawned console-owned socket (resolution step 3)
// ---------------------------------------------------------------------------

describe("resolveMbregistryConnection — step 3: console-owned socket", () => {
  it("connects to this console's own prior spawn when no standard candidate answers", async () => {
    const stateDir = freshTmpDir();
    const fakeHome = freshTmpDir(); // an empty "user socket" location -- nothing listens there
    const homedirFn = () => fakeHome;
    const env = { ROBOT_CONSOLE_STATE_DIR: stateDir };

    const endpoint = consoleOwnedEndpoint(env);
    if (endpoint.kind !== "unix") throw new Error("expected a unix endpoint on this platform");
    const server = new FakeRegistryServer();
    await server.listen(endpoint.path);
    const spawnFn = vi.fn() as unknown as SpawnFn;

    const resolved = await resolveMbregistryConnection({
      env,
      connect,
      spawnFn,
      homedirFn,
      livenessTimeoutMs: 300,
    });

    expect(resolved.endpoint).toEqual(endpoint);
    expect(resolved.spawned).toBe(false);
    expect(spawnFn).not.toHaveBeenCalled();
    resolved.socket.destroy();
    await server.close();
  });
});

// ---------------------------------------------------------------------------
// Version check / missing binary (resolution step 4 — gates step 5)
// ---------------------------------------------------------------------------

describe("resolveMbregistryConnection — step 4: version check gates spawning", () => {
  function spawnFnFor(versionOutput: string | Error): SpawnFn {
    return vi.fn((command: string, args: readonly string[]) => {
      const child = fakeChild();
      queueMicrotask(() => {
        if (versionOutput instanceof Error) {
          child.emit("error", versionOutput);
          return;
        }
        expect(args).toEqual(["--version"]);
        child.stdout.emit("data", Buffer.from(versionOutput));
        child.emit("exit", 0);
      });
      return child;
    }) as unknown as SpawnFn;
  }

  async function unresolvableEnv(): Promise<{ env: NodeJS.ProcessEnv; homedirFn: () => string }> {
    const stateDir = freshTmpDir();
    const fakeHome = freshTmpDir();
    return { env: { ROBOT_CONSOLE_STATE_DIR: stateDir }, homedirFn: () => fakeHome };
  }

  it("fails with a message naming MIN_MBREGISTRY_VERSION when mbregistry is missing", async () => {
    const { env, homedirFn } = await unresolvableEnv();
    const notFound = Object.assign(new Error("spawn mbregistry ENOENT"), { code: "ENOENT" });
    const spawnFn = spawnFnFor(notFound);

    await expect(
      resolveMbregistryConnection({ env, connect, spawnFn, homedirFn, livenessTimeoutMs: 200 }),
    ).rejects.toMatchObject({ code: "binary_not_found" });
    await expect(
      resolveMbregistryConnection({ env, connect, spawnFn, homedirFn, livenessTimeoutMs: 200 }),
    ).rejects.toThrow(new RegExp(MIN_MBREGISTRY_VERSION.replace(/\./g, "\\.")));
    // Never got as far as `mbregistry run ...`.
    for (const call of (spawnFn as unknown as { mock: { calls: unknown[][] } }).mock.calls) {
      expect(call[1]).not.toContain("run");
    }
  });

  it("fails the same way, with no spawn attempted, when the installed version is too old", async () => {
    const { env, homedirFn } = await unresolvableEnv();
    const spawnFn = spawnFnFor("mbregistry 0.1.0\n");

    await expect(
      resolveMbregistryConnection({ env, connect, spawnFn, homedirFn, livenessTimeoutMs: 200 }),
    ).rejects.toMatchObject({ code: "version_too_old", details: { required: MIN_MBREGISTRY_VERSION } });
    for (const call of (spawnFn as unknown as { mock: { calls: unknown[][] } }).mock.calls) {
      expect(call[1]).not.toContain("run");
    }
  });

  it("compareVersions orders dotted-numeric versions correctly", () => {
    expect(compareVersions("0.8.0", "0.8.0")).toBe(0);
    expect(compareVersions("0.7.9", "0.8.0")).toBe(-1);
    expect(compareVersions("0.8.1", "0.8.0")).toBe(1);
    expect(compareVersions("1.0", "0.9.9")).toBe(1);
  });

  it("extractVersion pulls a semver token out of banner text", () => {
    expect(extractVersion("mbregistry 0.9.2\n")).toBe("0.9.2");
    expect(extractVersion("v1.2.3")).toBe("1.2.3");
    expect(extractVersion("no version here")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Spawn-on-demand (resolution step 5) + wire ops against the spawned instance
// ---------------------------------------------------------------------------

describe("resolveMbregistryConnection — step 5: spawn on demand", () => {
  /** Builds a `spawnFn` that answers `--version` with a passing version,
   * and `run ...` by starting a real fake server at the `--socket` path
   * the caller passed, then reporting `--ready-json`. */
  function spawnFnStartingServer(server: FakeRegistryServer): SpawnFn {
    return vi.fn((command: string, args: readonly string[]) => {
      const child = fakeChild();
      if (args[0] === "--version") {
        queueMicrotask(() => {
          child.stdout.emit("data", Buffer.from(`mbregistry ${MIN_MBREGISTRY_VERSION}\n`));
          child.emit("exit", 0);
        });
        return child;
      }
      expect(args[0]).toBe("run");
      expect(args).toContain("--exit-with-parent");
      expect(args).toContain("--ready-json");
      const socketIdx = args.indexOf("--socket");
      const socketPath = args[socketIdx + 1] as string;
      void server.listen(socketPath).then(() => {
        child.stdout.emit(
          "data",
          Buffer.from(JSON.stringify({ ready: true, instance: "x-console", socket: socketPath, ports: { remote: 17440 } }) + "\n"),
        );
      });
      return child;
    }) as unknown as SpawnFn;
  }

  async function unresolvableEnv(): Promise<{ env: NodeJS.ProcessEnv; homedirFn: () => string }> {
    const stateDir = freshTmpDir();
    const fakeHome = freshTmpDir();
    return { env: { ROBOT_CONSOLE_STATE_DIR: stateDir }, homedirFn: () => fakeHome };
  }

  it("spawns with --exit-with-parent, connects to the reported socket, and does not spawn a second time when a candidate already ran", async () => {
    const { env, homedirFn } = await unresolvableEnv();
    const server = new FakeRegistryServer([{ uid: "u1", short_uid: "u1" }]);
    const spawnFn = spawnFnStartingServer(server);

    const resolved = await resolveMbregistryConnection({
      env,
      connect,
      spawnFn,
      homedirFn,
      livenessTimeoutMs: 200,
      spawnReadyTimeoutMs: 2000,
    });

    expect(resolved.spawned).toBe(true);
    expect(resolved.remotePort).toBe(17440);
    const runCall = (spawnFn as unknown as { mock: { calls: unknown[][] } }).mock.calls.find((c) => c[1][0] === "run");
    expect(runCall?.[1]).toContain("--no-peering");
    resolved.socket.destroy();
    await server.close();
  });

  it("flips --no-peering off when shareBoards is true", async () => {
    const { env, homedirFn } = await unresolvableEnv();
    const server = new FakeRegistryServer();
    const spawnFn = spawnFnStartingServer(server);

    const resolved = await resolveMbregistryConnection({
      env,
      connect,
      spawnFn,
      homedirFn,
      shareBoards: true,
      livenessTimeoutMs: 200,
      spawnReadyTimeoutMs: 2000,
    });
    resolved.socket.destroy();
    await server.close();

    const runCall = (spawnFn as unknown as { mock: { calls: unknown[][] } }).mock.calls.find((c) => c[1][0] === "run");
    expect(runCall?.[1]).not.toContain("--no-peering");
  });
});

// ---------------------------------------------------------------------------
// createMbregistryClient — typed ops against a spawned fake instance
// ---------------------------------------------------------------------------

describe("createMbregistryClient — typed ops (list/lock/unlock/watch)", () => {
  async function connectedClientAndServer() {
    const stateDir = freshTmpDir();
    const fakeHome = freshTmpDir();
    const env = { ROBOT_CONSOLE_STATE_DIR: stateDir };
    const server = new FakeRegistryServer([
      {
        uid: "abc123",
        short_uid: "abc",
        port: "/dev/ttyACM0",
        vid_pid: "0d28:0204",
        role: "robot",
        common_name: "nezha",
        device_name: "tovez",
        serial_payload: null,
        raw_announcement: null,
        state: "connected",
        error_note: null,
        flash_count: 0,
        chip_identity_name: null,
        chip_identity_serial: null,
        first_seen: 0,
        last_seen: 0,
        last_probe: null,
        lock_kind: null,
        lock_pid: null,
        lock_label: null,
        lock_since: null,
      },
    ]);

    const spawnFn = vi.fn((command: string, args: readonly string[]) => {
      const child = fakeChild();
      if (args[0] === "--version") {
        queueMicrotask(() => {
          child.stdout.emit("data", Buffer.from(`mbregistry ${MIN_MBREGISTRY_VERSION}\n`));
          child.emit("exit", 0);
        });
        return child;
      }
      const socketIdx = args.indexOf("--socket");
      const socketPath = args[socketIdx + 1] as string;
      void server.listen(socketPath).then(() => {
        child.stdout.emit(
          "data",
          Buffer.from(JSON.stringify({ ready: true, socket: socketPath, ports: { remote: 17441 } }) + "\n"),
        );
      });
      return child;
    }) as unknown as SpawnFn;

    const client = createMbregistryClient({
      env,
      connect,
      spawnFn,
      homedirFn: () => fakeHome,
      livenessTimeoutMs: 200,
      spawnReadyTimeoutMs: 2000,
    });
    await client.connect();
    return { client, server };
  }

  it("list() returns typed devices from the spawned instance", async () => {
    const { client, server } = await connectedClientAndServer();
    const devices = await client.list();
    expect(devices).toHaveLength(1);
    expect(devices[0].uid).toBe("abc123");
    expect(devices[0].device_name).toBe("tovez");
    client.close();
    await server.close();
  });

  it("lock() then unlock() round-trip, and a second lock is rejected as locked", async () => {
    const { client, server } = await connectedClientAndServer();
    await client.lock("abc123", "serial", "alice-laptop");
    await expect(client.lock("abc123", "serial")).rejects.toMatchObject({ code: "locked" });
    const released = await client.unlock("abc123");
    expect(released).toBe(true);
    client.close();
    await server.close();
  });

  it("find() surfaces not_found for an unknown uid", async () => {
    const { client, server } = await connectedClientAndServer();
    await expect(client.find("nope")).rejects.toBeInstanceOf(MbregistryError);
    await expect(client.find("nope")).rejects.toMatchObject({ code: "not_found" });
    client.close();
    await server.close();
  });

  it("watch() yields events pushed after the ack", async () => {
    const { client, server } = await connectedClientAndServer();
    const events = client.watch();
    const iterator = events[Symbol.asyncIterator]();
    const firstEvent = iterator.next();
    // Give the ack a tick to land before pushing an event, mirroring a
    // real server's "ack, then later events" timing.
    await new Promise((resolve) => setTimeout(resolve, 20));
    server.pushToAll({ type: "attach", host: "bench", uid: "abc123", port: "/dev/ttyACM0", vid_pid: "0d28:0204" });
    const result = await firstEvent;
    expect(result.done).toBe(false);
    expect(result.value).toMatchObject({ type: "attach", uid: "abc123" });
    client.close();
    await server.close();
  });
});
