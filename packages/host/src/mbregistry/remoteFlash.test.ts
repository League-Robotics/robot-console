/**
 * remoteFlash.test.ts — sprint 018 ticket 005's own suite: one JSON-lines
 * fake TCP server per test (a real `net.createServer`/`net.connect` TCP
 * socket on `127.0.0.1` — no real `mbregistry` binary anywhere, per this
 * sprint's Test Strategy constraint) driving `flashViaMbregistry`
 * through its full `lock`/`send_hex`/`flash` wire choreography. Ticket
 * 018-011 finding 2 adds a Unix-domain-socket variant of the same fake
 * server (still real `net`, still no `mbregistry` binary) driving
 * `flashViaLocalSocket`'s `lock`/`flash` (no `send_hex`) choreography.
 */
import { EventEmitter } from "node:events";
import * as fsp from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  classifyLogPhase,
  flashViaLocalSocket,
  flashViaMbregistry,
  type LocalFlashTarget,
  type RemoteFlashTarget,
} from "./remoteFlash.js";
import type { FlashPhase } from "../flash.js";

// ---------------------------------------------------------------------------
// Fake server
// ---------------------------------------------------------------------------

interface FakeFlashServerOptions {
  /** Simulates a pre-existing lock on this uid -- every `lock` request
   * for it gets `{"ok": false, "code": "locked", "holder": ...}`. */
  lockedUid?: string;
  lockedHolder?: Record<string, unknown>;
  /** 027-004: simulates mbtools' own "this UID isn't attached" fast-fail
   * -- every `lock` request for this uid gets `{"ok": false, "code":
   * "not_found", "error": ...}`, mirroring the wire shape ticket 003's
   * `isMbregistryNotFound` recognizes on the identify path. */
  notFoundUid?: string;
  /** Overrides the default `{ok: true, hex_path: ...}` `send_hex`
   * response. */
  sendHexResponse?: Record<string, unknown>;
  /** Streamed `{"type": "log", "line": ...}` lines the `flash` op sends
   * before its terminal result. */
  flashLogLines?: string[];
  /** Overrides the default successful terminal `flash` result. */
  flashResult?: Record<string, unknown>;
}

class FakeFlashServer {
  readonly server: net.Server;
  port = 0;
  readonly requests: Record<string, unknown>[] = [];

  constructor(private readonly opts: FakeFlashServerOptions = {}) {
    this.server = net.createServer((socket) => this.attach(socket));
  }

  listen(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", () => {
        const addr = this.server.address();
        this.port = typeof addr === "object" && addr !== null ? addr.port : 0;
        resolve(this.port);
      });
    });
  }

  /** Ticket 018-011 finding 2's own local-socket variant: the same fake
   * server, listening on a Unix domain socket path instead of TCP. */
  listenUnix(socketPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(socketPath, () => resolve());
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  private attach(socket: net.Socket): void {
    let buffer = "";
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let idx: number;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (line.trim().length === 0) continue;
        this.handle(socket, JSON.parse(line) as Record<string, unknown>);
      }
    });
  }

  private write(socket: net.Socket, obj: unknown): void {
    socket.write(JSON.stringify(obj) + "\n");
  }

  private handle(socket: net.Socket, op: Record<string, unknown>): void {
    this.requests.push(op);
    switch (op.op) {
      case "lock": {
        const uid = String(op.uid);
        if (this.opts.lockedUid === uid) {
          this.write(socket, { ok: false, code: "locked", error: "already locked", holder: this.opts.lockedHolder ?? {} });
          return;
        }
        if (this.opts.notFoundUid === uid) {
          this.write(socket, { ok: false, code: "not_found", error: `"${uid}" is not attached (last seen on /dev/ttyACM0)` });
          return;
        }
        this.write(socket, { ok: true });
        return;
      }
      case "send_hex": {
        this.write(socket, this.opts.sendHexResponse ?? { ok: true, hex_path: "/tmp/mbregistry-remote-hex-abc123.hex" });
        return;
      }
      case "flash": {
        for (const line of this.opts.flashLogLines ?? []) {
          this.write(socket, { type: "log", line });
        }
        this.write(socket, this.opts.flashResult ?? { type: "result", ok: true, success: true, exit_code: 0, error: null });
        return;
      }
      default:
        this.write(socket, { ok: false, code: "invalid_request", error: `unknown op: ${String(op.op)}` });
    }
  }
}

let currentServer: FakeFlashServer | undefined;

afterEach(async () => {
  await currentServer?.close();
  currentServer = undefined;
});

async function startServer(opts: FakeFlashServerOptions = {}): Promise<RemoteFlashTarget> {
  const server = new FakeFlashServer(opts);
  currentServer = server;
  const port = await server.listen();
  return { host: "127.0.0.1", port };
}

const unixSocketPaths: string[] = [];

afterEach(async () => {
  for (const p of unixSocketPaths.splice(0)) {
    await fsp.rm(p, { force: true }).catch(() => {});
  }
});

/** Ticket 018-011 finding 2's own local-socket fake server starter --
 * mirrors {@link startServer}, but listening on a fresh Unix domain
 * socket path under `os.tmpdir()` instead of TCP. */
async function startUnixServer(opts: FakeFlashServerOptions = {}): Promise<LocalFlashTarget> {
  const server = new FakeFlashServer(opts);
  currentServer = server;
  const socketPath = path.join(os.tmpdir(), `robot-console-flash-test-${process.pid}-${Math.random().toString(36).slice(2)}.sock`);
  unixSocketPaths.push(socketPath);
  await server.listenUnix(socketPath);
  return { kind: "unix", path: socketPath };
}

// ---------------------------------------------------------------------------
// classifyLogPhase
// ---------------------------------------------------------------------------

describe("classifyLogPhase", () => {
  it.each<[string, FlashPhase]>([
    ["erasing flash sectors...", "erasing"],
    ["Erasing chip", "erasing"],
    ["programming firmware", "writing"],
    ["writing 4096 bytes", "writing"],
    ["resetting target", "resetting"],
    ["some unrecognized status line", "writing"],
  ])("classifies %s as %s", (line, expected) => {
    expect(classifyLogPhase(line)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// flashViaMbregistry
// ---------------------------------------------------------------------------

describe("flashViaMbregistry", () => {
  it("locks (kind: flash), send_hexes, flashes, forwards log-line phases, and resolves ok on a successful terminal result", async () => {
    const target = await startServer({ flashLogLines: ["erasing chip", "programming firmware", "resetting target"] });
    const phases: FlashPhase[] = [];

    const outcome = await flashViaMbregistry(target, "uid-1", "alice-laptop", "hex-text-bytes", (phase) => phases.push(phase));

    expect(outcome).toEqual({ status: "ok", method: "mbregistry" });
    expect(phases).toEqual(["connecting", "erasing", "writing", "resetting"]);
    const requests = currentServer!.requests;
    expect(requests[0]).toMatchObject({ op: "lock", uid: "uid-1", kind: "flash", label: "alice-laptop" });
    expect(requests[1]).toMatchObject({ op: "send_hex", data: Buffer.from("hex-text-bytes", "utf8").toString("base64") });
    expect(requests[2]).toMatchObject({ op: "flash", uid: "uid-1", hex_path: "/tmp/mbregistry-remote-hex-abc123.hex" });
  });

  it("omits label from the lock op when none is given", async () => {
    const target = await startServer();
    await flashViaMbregistry(target, "uid-1", undefined, "hex", () => {});
    expect(currentServer!.requests[0]).not.toHaveProperty("label");
  });

  it("classifies a locked response naming holder.label when present", async () => {
    const target = await startServer({ lockedUid: "uid-1", lockedHolder: { label: "bob-desktop" } });

    const outcome = await flashViaMbregistry(target, "uid-1", undefined, "hex", () => {});

    expect(outcome).toEqual({
      status: "error",
      method: "mbregistry",
      reason: "owner-unavailable",
      error: "in use by bob-desktop",
    });
  });

  it("classifies a locked response with no holder.label as plain 'in use' -- never 'undefined'", async () => {
    const target = await startServer({ lockedUid: "uid-1", lockedHolder: {} });

    const outcome = await flashViaMbregistry(target, "uid-1", undefined, "hex", () => {});

    expect(outcome).toEqual({ status: "error", method: "mbregistry", reason: "owner-unavailable", error: "in use" });
    expect((outcome as { error: string }).error).not.toContain("undefined");
  });

  it("classifies a locked response with no holder at all (a registry predating mbtools 008-002) as plain 'in use'", async () => {
    const target = await startServer({ lockedUid: "uid-1" });

    const outcome = await flashViaMbregistry(target, "uid-1", undefined, "hex", () => {});

    expect(outcome).toEqual({ status: "error", method: "mbregistry", reason: "owner-unavailable", error: "in use" });
  });

  // 027-004: mbtools' own "gone" fast-fail on the `lock` step -- e.g. the
  // board went stale after `server.ts#resolveFlashLinkTarget`'s own
  // stale-link check ran but before this connection's `lock` landed --
  // must map to the same plain-language, uid-naming message that check
  // gives, never mbtools' raw wire text passed straight through.
  it("classifies a not_found lock response as flash-failed with a plain-language message naming the uid, not mbtools' raw wire text", async () => {
    const target = await startServer({ notFoundUid: "uid-1" });

    const outcome = await flashViaMbregistry(target, "uid-1", undefined, "hex", () => {});

    expect(outcome).toEqual({
      status: "error",
      method: "mbregistry",
      reason: "flash-failed",
      error: 'mbregistry device "uid-1" is not currently attached -- is it still connected?',
    });
  });

  it("classifies a send_hex failure as flash-failed", async () => {
    const target = await startServer({ sendHexResponse: { ok: false, code: "invalid_request", error: "payload too large" } });

    const outcome = await flashViaMbregistry(target, "uid-1", undefined, "hex", () => {});

    expect(outcome).toEqual({ status: "error", method: "mbregistry", reason: "flash-failed", error: "payload too large" });
  });

  it("classifies a failed terminal flash result (pyocd failure) as flash-failed with its own error text", async () => {
    const target = await startServer({
      flashResult: { type: "result", ok: false, success: false, exit_code: 1, error: "pyocd: could not connect to target" },
    });

    const outcome = await flashViaMbregistry(target, "uid-1", undefined, "hex", () => {});

    expect(outcome).toEqual({
      status: "error",
      method: "mbregistry",
      reason: "flash-failed",
      error: "pyocd: could not connect to target",
    });
  });

  it("resolves a classified flash-failed outcome, rather than throwing, when the connection cannot be established", async () => {
    // Nothing is listening on this port.
    const outcome = await flashViaMbregistry({ host: "127.0.0.1", port: 1 }, "uid-1", undefined, "hex", () => {});

    expect(outcome.status).toBe("error");
    expect((outcome as { method: string }).method).toBe("mbregistry");
    expect((outcome as { reason: string }).reason).toBe("flash-failed");
  });

  // Ticket 018-011 finding 3: a connect attempt that never resolves (an
  // unreachable host, dropped rather than refused -- the real bench
  // repro sat here for ~75s, the OS's own SYN-retry timeout) must time
  // out at this module's own bound, not the OS default, and the failure
  // message must name the target host:port. `onProgress` must have
  // already reported "connecting" before that timeout fires.
  it("times out the connect attempt at connectTimeoutMs (not the OS default), naming host:port in the failure, after reporting 'connecting'", async () => {
    const neverConnects = new EventEmitter() as unknown as net.Socket;
    (neverConnects as unknown as { destroy: () => void }).destroy = vi.fn();
    const phases: FlashPhase[] = [];

    const outcome = await flashViaMbregistry(
      { host: "10.0.0.254", port: 4795 },
      "uid-1",
      undefined,
      "hex",
      (phase) => phases.push(phase),
      { connect: () => neverConnects, connectTimeoutMs: 20 },
    );

    expect(phases).toEqual(["connecting"]);
    expect(outcome.status).toBe("error");
    expect((outcome as { reason: string }).reason).toBe("flash-failed");
    expect((outcome as { error: string }).error).toContain("10.0.0.254:4795");
  });
});

// ---------------------------------------------------------------------------
// flashViaLocalSocket -- ticket 018-011 finding 2: the local Unix
// socket/pipe `flash` op takes a `hex_path` already on this host's
// filesystem, with no `send_hex` staging step at all (unlike the remote
// TCP path above) -- this suite drives that against a fake Unix-socket
// server and a real (test-scoped) temp file.
// ---------------------------------------------------------------------------

describe("flashViaLocalSocket", () => {
  it("locks (kind: flash), stages hexText to a real temp file, flashes with that file's own path, forwards log-line phases, resolves ok, and cleans the temp file up afterwards", async () => {
    const target = await startUnixServer({ flashLogLines: ["erasing chip", "programming firmware", "resetting target"] });
    const phases: FlashPhase[] = [];

    const outcome = await flashViaLocalSocket(target, "uid-1", "alice-laptop", "hex-text-bytes", (phase) => phases.push(phase));

    expect(outcome).toEqual({ status: "ok", method: "mbregistry" });
    expect(phases).toEqual(["connecting", "erasing", "writing", "resetting"]);
    const requests = currentServer!.requests;
    expect(requests[0]).toMatchObject({ op: "lock", uid: "uid-1", kind: "flash", label: "alice-laptop" });
    // Never send_hex -- the local flash op has no such staging step.
    expect(requests.some((r) => r.op === "send_hex")).toBe(false);
    expect(requests[1]).toMatchObject({ op: "flash", uid: "uid-1" });
    const hexPath = (requests[1] as { hex_path: string }).hex_path;
    expect(typeof hexPath).toBe("string");
    expect(hexPath).toMatch(/robot-console-flash-.*firmware\.hex$/);
    // Cleaned up after the exchange completes -- never left behind in
    // os.tmpdir().
    await expect(fsp.access(hexPath)).rejects.toThrow();
  });

  it("omits label from the lock op when none is given", async () => {
    const target = await startUnixServer();
    await flashViaLocalSocket(target, "uid-1", undefined, "hex", () => {});
    expect(currentServer!.requests[0]).not.toHaveProperty("label");
  });

  it("classifies a locked response naming holder.label when present, without ever staging a hex file", async () => {
    const target = await startUnixServer({ lockedUid: "uid-1", lockedHolder: { label: "bob-desktop" } });
    let staged = false;
    const outcome = await flashViaLocalSocket(target, "uid-1", undefined, "hex", () => {}, {
      writeHexFile: async () => {
        staged = true;
        return { path: "/should/never/be/used", cleanup: async () => {} };
      },
    });

    expect(outcome).toEqual({
      status: "error",
      method: "mbregistry",
      reason: "owner-unavailable",
      error: "in use by bob-desktop",
    });
    expect(staged).toBe(false);
  });

  it("classifies a locked response with no holder.label as plain 'in use' -- never 'undefined'", async () => {
    const target = await startUnixServer({ lockedUid: "uid-1", lockedHolder: {} });

    const outcome = await flashViaLocalSocket(target, "uid-1", undefined, "hex", () => {});

    expect(outcome).toEqual({ status: "error", method: "mbregistry", reason: "owner-unavailable", error: "in use" });
    expect((outcome as { error: string }).error).not.toContain("undefined");
  });

  // 027-004: same not_found mapping as flashViaMbregistry's own test
  // above, applied to the local-socket leaf -- never stages a hex file
  // for a lock that never succeeded.
  it("classifies a not_found lock response as flash-failed with a plain-language message naming the uid, without ever staging a hex file", async () => {
    const target = await startUnixServer({ notFoundUid: "uid-1" });
    let staged = false;
    const outcome = await flashViaLocalSocket(target, "uid-1", undefined, "hex", () => {}, {
      writeHexFile: async () => {
        staged = true;
        return { path: "/should/never/be/used", cleanup: async () => {} };
      },
    });

    expect(outcome).toEqual({
      status: "error",
      method: "mbregistry",
      reason: "flash-failed",
      error: 'mbregistry device "uid-1" is not currently attached -- is it still connected?',
    });
    expect(staged).toBe(false);
  });

  it("classifies a failed terminal flash result (pyocd failure) as flash-failed with its own error text, and still cleans up the temp file", async () => {
    const target = await startUnixServer({
      flashResult: { type: "result", ok: false, success: false, exit_code: 1, error: "pyocd: could not connect to target" },
    });
    let cleanedUp = false;
    const outcome = await flashViaLocalSocket(target, "uid-1", undefined, "hex", () => {}, {
      writeHexFile: async () => ({
        path: "/tmp/fake-hex-path-does-not-need-to-exist.hex",
        cleanup: async () => {
          cleanedUp = true;
        },
      }),
    });

    expect(outcome).toEqual({
      status: "error",
      method: "mbregistry",
      reason: "flash-failed",
      error: "pyocd: could not connect to target",
    });
    expect(cleanedUp).toBe(true);
  });

  it("resolves a classified flash-failed outcome, rather than throwing, when the local socket cannot be reached", async () => {
    const missingPath = path.join(os.tmpdir(), `robot-console-flash-test-missing-${Math.random().toString(36).slice(2)}.sock`);
    const outcome = await flashViaLocalSocket({ kind: "unix", path: missingPath }, "uid-1", undefined, "hex", () => {});

    expect(outcome.status).toBe("error");
    expect((outcome as { method: string }).method).toBe("mbregistry");
    expect((outcome as { reason: string }).reason).toBe("flash-failed");
  });

  // Ticket 018-011 finding 3, applied to the local-socket leaf too (see
  // `FLASH_CONNECT_TIMEOUT_MS`'s own doc comment on why both share one
  // bound).
  it("times out the local-socket connect attempt at connectTimeoutMs, naming the socket path in the failure, after reporting 'connecting'", async () => {
    const neverConnects = new EventEmitter() as unknown as net.Socket;
    (neverConnects as unknown as { destroy: () => void }).destroy = vi.fn();
    const phases: FlashPhase[] = [];

    const outcome = await flashViaLocalSocket(
      { kind: "unix", path: "/tmp/fake/never-connects.sock" },
      "uid-1",
      undefined,
      "hex",
      (phase) => phases.push(phase),
      { connect: () => neverConnects, connectTimeoutMs: 20 },
    );

    expect(phases).toEqual(["connecting"]);
    expect(outcome.status).toBe("error");
    expect((outcome as { reason: string }).reason).toBe("flash-failed");
    expect((outcome as { error: string }).error).toContain("/tmp/fake/never-connects.sock");
  });
});
