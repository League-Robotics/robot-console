/**
 * remoteFlash.test.ts — sprint 018 ticket 005's own suite: one JSON-lines
 * fake TCP server per test (a real `net.createServer`/`net.connect` TCP
 * socket on `127.0.0.1` — no real `mbregistry` binary anywhere, per this
 * sprint's Test Strategy constraint) driving `flashViaMbregistry`
 * through its full `lock`/`send_hex`/`flash` wire choreography.
 */
import * as net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { classifyLogPhase, flashViaMbregistry, type RemoteFlashTarget } from "./remoteFlash.js";
import type { FlashPhase } from "../flash.js";

// ---------------------------------------------------------------------------
// Fake server
// ---------------------------------------------------------------------------

interface FakeFlashServerOptions {
  /** Simulates a pre-existing lock on this uid -- every `lock` request
   * for it gets `{"ok": false, "code": "locked", "holder": ...}`. */
  lockedUid?: string;
  lockedHolder?: Record<string, unknown>;
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
    expect(phases).toEqual(["erasing", "writing", "resetting"]);
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
});
