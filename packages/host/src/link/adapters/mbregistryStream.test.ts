/**
 * mbregistryStream.test.ts — sprint 018 ticket 003's own suite: one
 * JSON-lines + binary-frame fake `mbregistry` server, over a real Unix
 * socket in a temp dir (no real `mbregistry` binary anywhere, per this
 * sprint's Test Strategy constraint), driving the adapter through a real
 * `mbregistryClient` (ticket 001) exactly as the connector (ticket 004)
 * will. `$ROBOT_CONSOLE_MBREGISTRY` (resolution step 1) points straight
 * at the fake server, so no spawn/liveness machinery is exercised here —
 * that is ticket 001's own suite's job.
 *
 * One suite per acceptance criterion of ticket 003, in order.
 */
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createMbregistryClient, type LockKind, type MbregistryClient } from "../../mbregistry/client.js";
import { FRAME_BREAK, FRAME_CLOSE, FRAME_DATA, FRAME_SET_DTR, FRAME_SET_RTS, HEADER_SIZE, encodeFrame } from "../../mbregistry/streamFrame.js";
import { mbregistryStream, resolveFlashPlan, type FlashPlanClient, type MbregistryStreamDevice } from "./mbregistryStream.js";

// ---------------------------------------------------------------------------
// Fake server: JSON-lines lock/unlock/stream, then binary frames
// ---------------------------------------------------------------------------

interface LockRecord {
  kind: LockKind;
  label: string | null;
  since: number;
  /** `undefined` for a lock preset directly by a test (`presetLock`) —
   * never held by any of this fake server's own connections, so
   * `stream`'s "must be this connection's own lock" check can never
   * match it, exactly like a lock a different real client holds. */
  socket: net.Socket | undefined;
}

class FakeStreamServer {
  private readonly server: net.Server;
  private readonly locks = new Map<string, LockRecord>();
  /** Every BREAK/SET_DTR/SET_RTS frame received, across every
   * connection, in arrival order. */
  readonly controlFrames: Array<{ type: number; payload: Buffer }> = [];

  constructor() {
    this.server = net.createServer((socket) => this.handleConnection(socket));
  }

  presetLock(uid: string, holder: { kind: LockKind; label: string | null; since: number }): void {
    this.locks.set(uid, { ...holder, socket: undefined });
  }

  isLocked(uid: string): boolean {
    return this.locks.has(uid);
  }

  private handleConnection(socket: net.Socket): void {
    let mode: "json" | "stream" = "json";
    let lineBuffer = "";
    let frameBuffer = Buffer.alloc(0);

    socket.on("close", () => {
      for (const [uid, record] of [...this.locks.entries()]) {
        if (record.socket === socket) {
          this.locks.delete(uid);
        }
      }
    });

    socket.on("data", (chunk: Buffer) => {
      if (mode === "stream") {
        frameBuffer = Buffer.concat([frameBuffer, chunk]);
        // A tiny inline decode -- deliberately not `streamFrame.ts` (the
        // module under test), so a bug there can't mask itself here.
        for (;;) {
          if (frameBuffer.length < HEADER_SIZE) break;
          const type = frameBuffer.readUInt8(0);
          const length = frameBuffer.readUInt32BE(1);
          if (frameBuffer.length < HEADER_SIZE + length) break;
          const payload = Buffer.from(frameBuffer.subarray(HEADER_SIZE, HEADER_SIZE + length));
          frameBuffer = frameBuffer.subarray(HEADER_SIZE + length);
          if (type === FRAME_DATA) {
            socket.write(encodeFrame(FRAME_DATA, payload)); // loopback echo
          } else if (type === FRAME_CLOSE) {
            socket.end();
          } else {
            this.controlFrames.push({ type, payload });
          }
        }
        return;
      }

      lineBuffer += chunk.toString("utf8");
      let idx: number;
      while ((idx = lineBuffer.indexOf("\n")) >= 0) {
        const line = lineBuffer.slice(0, idx);
        lineBuffer = lineBuffer.slice(idx + 1);
        if (line.trim().length === 0) continue;
        this.handleLine(socket, JSON.parse(line), (next) => {
          mode = next;
        });
      }
    });
  }

  private handleLine(socket: net.Socket, op: Record<string, unknown>, setMode: (mode: "json" | "stream") => void): void {
    const write = (resp: unknown) => socket.write(JSON.stringify(resp) + "\n");
    if (op.op === "lock") {
      const uid = String(op.uid);
      const existing = this.locks.get(uid);
      if (existing !== undefined) {
        write({
          ok: false,
          code: "locked",
          error: "already locked",
          holder: { kind: existing.kind, pid: 1, label: existing.label, since: existing.since },
        });
        return;
      }
      this.locks.set(uid, {
        kind: op.kind as LockKind,
        label: (op.label as string | undefined) ?? null,
        since: Date.now() / 1000,
        socket,
      });
      write({ ok: true });
      return;
    }
    if (op.op === "unlock") {
      const uid = String(op.uid);
      const released = this.locks.delete(uid);
      write({ ok: true, released });
      return;
    }
    if (op.op === "stream") {
      const uid = String(op.uid);
      const record = this.locks.get(uid);
      if (record === undefined || record.socket !== socket) {
        write({ ok: false, code: "not_locked", error: "no serial/relay-kind lock held by this connection" });
        return;
      }
      write({ ok: true });
      setMode("stream");
      if (uid === "malformed-uid") {
        // Simulate a malformed/oversized frame straight from the server:
        // a declared length far over MAX_FRAME_PAYLOAD.
        const bad = Buffer.alloc(HEADER_SIZE);
        bad.writeUInt8(FRAME_DATA, 0);
        bad.writeUInt32BE(0xffffffff, 1);
        socket.write(bad);
      }
      return;
    }
    write({ ok: false, code: "invalid_request", error: `unknown op: ${String(op.op)}` });
  }

  listen(socketPath: string): Promise<void> {
    fs.mkdirSync(path.dirname(socketPath), { recursive: true });
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(socketPath, () => resolve());
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}

function tempSocketPath(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mbregistrystream-")), "api.sock");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("mbregistryStream", () => {
  let server: FakeStreamServer;
  let socketPath: string;
  let client: MbregistryClient;

  beforeEach(async () => {
    server = new FakeStreamServer();
    socketPath = tempSocketPath();
    await server.listen(socketPath);
    client = createMbregistryClient({ env: { ROBOT_CONSOLE_MBREGISTRY: socketPath } });
    await client.connect();
  });

  afterEach(async () => {
    client.close();
    await server.close();
  });

  it("open() on an unlocked device succeeds and carries DATA frames both directions", async () => {
    const device: MbregistryStreamDevice = { uid: "board-1" };
    const stream = mbregistryStream(device, { client, label: "robot-console" });
    const received = new Promise<Buffer>((resolve) => {
      stream.on("data", (chunk) => resolve(chunk as Buffer));
    });
    stream.on("error", () => {});

    await stream.open(new AbortController().signal);
    await new Promise<void>((resolve, reject) => {
      stream.write("HELLO 1\n", (err) => (err ? reject(err) : resolve()));
    });

    expect(await received).toEqual(Buffer.from("HELLO 1\n"));
    await stream.close();
  });

  it("open() on an already-locked device rejects with 'in use by <label>' when a label is present", async () => {
    server.presetLock("board-2", { kind: "serial", label: "alice-laptop", since: Date.now() / 1000 });
    const stream = mbregistryStream({ uid: "board-2" }, { client });
    await expect(stream.open(new AbortController().signal)).rejects.toThrow("in use by alice-laptop");
  });

  it("open() on an already-locked device with no holder.label rejects with a plain 'in use', no 'undefined' anywhere", async () => {
    server.presetLock("board-3", { kind: "serial", label: null, since: Date.now() / 1000 });
    const stream = mbregistryStream({ uid: "board-3" }, { client });
    let message = "";
    try {
      await stream.open(new AbortController().signal);
      throw new Error("expected open() to reject");
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toBe("in use");
    expect(message).not.toMatch(/undefined/);
  });

  it("a stale-looking lock's rejection message includes the exact mbregistry unlock --force <name> command and the owning host", async () => {
    const longAgo = Date.now() / 1000 - 10_000; // well past the default 5-minute display threshold
    server.presetLock("board-4", { kind: "serial", label: "bob", since: longAgo });
    const stream = mbregistryStream({ uid: "board-4", host: "loki" }, { client });
    await expect(stream.open(new AbortController().signal)).rejects.toThrow("mbregistry unlock --force board-4` on loki");
  });

  it("a fresh (non-stale) lock's rejection carries no unlock --force hint", async () => {
    server.presetLock("board-4b", { kind: "serial", label: "bob", since: Date.now() / 1000 });
    const stream = mbregistryStream({ uid: "board-4b", host: "loki" }, { client });
    let message = "";
    try {
      await stream.open(new AbortController().signal);
      throw new Error("expected open() to reject");
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toBe("in use by bob");
    expect(message).not.toContain("unlock --force");
  });

  it("sendBreak()/setDtr()/setRts() send BREAK/SET_DTR/SET_RTS with the correct one-byte payload", async () => {
    const stream = mbregistryStream({ uid: "board-5" }, { client });
    stream.on("error", () => {});
    await stream.open(new AbortController().signal);

    await stream.sendBreak();
    await stream.setDtr(true);
    await stream.setRts(false);

    await vi.waitFor(() => expect(server.controlFrames.length).toBe(3));
    expect(server.controlFrames[0]).toEqual({ type: FRAME_BREAK, payload: Buffer.alloc(0) });
    expect(server.controlFrames[1]).toEqual({ type: FRAME_SET_DTR, payload: Buffer.from([0x01]) });
    expect(server.controlFrames[2]).toEqual({ type: FRAME_SET_RTS, payload: Buffer.from([0x00]) });

    await stream.close();
  });

  it("close() sends CLOSE and the socket closes; no dangling lock", async () => {
    const stream = mbregistryStream({ uid: "board-6" }, { client });
    const closed = new Promise<void>((resolve) => stream.on("close", resolve));
    stream.on("error", () => {});
    await stream.open(new AbortController().signal);

    expect(server.isLocked("board-6")).toBe(true);
    await stream.close();
    await closed;
    await vi.waitFor(() => expect(server.isLocked("board-6")).toBe(false));
  });

  it("a malformed/oversized frame from the server is handled without crashing -- surfaces as onError/onClose", async () => {
    const stream = mbregistryStream({ uid: "malformed-uid" }, { client });
    const errors: Error[] = [];
    let closed = false;
    stream.on("error", (err) => errors.push(err));
    stream.on("close", () => {
      closed = true;
    });

    await stream.open(new AbortController().signal);
    await vi.waitFor(() => expect(errors.length).toBeGreaterThan(0));
    await vi.waitFor(() => expect(closed).toBe(true));
    expect(errors[0]?.message).toMatch(/exceeds/);
  });
});

// ---------------------------------------------------------------------------
// resolveFlashPlan -- sprint 018 ticket 005's extension of
// resolveStreamTarget for send_hex/flash, reworked by ticket 011 finding 2
// to use the local socket's own `flash` op for a local device instead of
// requiring this console's own remote TCP port (only known when this
// console itself spawned the instance).
// ---------------------------------------------------------------------------

describe("resolveFlashPlan", () => {
  function client(overrides: Partial<FlashPlanClient> = {}): FlashPlanClient {
    return {
      resolvedEndpoint: { kind: "unix", path: "/tmp/fake/api.sock" },
      remotePort: undefined,
      ...overrides,
    };
  }

  it("a remote (peer-owned) device's own endpoint is used unchanged, ignoring the client entirely", () => {
    const device: MbregistryStreamDevice = { uid: "peer-uid", endpoint: { host: "10.0.0.5", port: 7440 } };
    expect(resolveFlashPlan(device, client({ remotePort: 9999 }))).toEqual({
      kind: "remote",
      target: { host: "10.0.0.5", port: 7440 },
    });
    expect(resolveFlashPlan(device, client())).toEqual({ kind: "remote", target: { host: "10.0.0.5", port: 7440 } });
  });

  it("a local device resolves to the local socket's own flash op when this console's own connection is a local socket -- even with no remote port known (a pre-existing registry this console didn't spawn)", () => {
    const device: MbregistryStreamDevice = { uid: "local-uid" };
    expect(resolveFlashPlan(device, client({ resolvedEndpoint: { kind: "unix", path: "/tmp/fake/api.sock" }, remotePort: undefined }))).toEqual({
      kind: "local",
      endpoint: { kind: "unix", path: "/tmp/fake/api.sock" },
    });
  });

  it("a local device on a Windows named pipe resolves to that pipe", () => {
    const device: MbregistryStreamDevice = { uid: "local-uid" };
    expect(resolveFlashPlan(device, client({ resolvedEndpoint: { kind: "pipe", path: "\\\\.\\pipe\\mbregistry" } }))).toEqual({
      kind: "local",
      endpoint: { kind: "pipe", path: "\\\\.\\pipe\\mbregistry" },
    });
  });

  it("a local device falls back to 127.0.0.1:remotePort when this console's own connection is itself over TCP", () => {
    const device: MbregistryStreamDevice = { uid: "local-uid" };
    expect(resolveFlashPlan(device, client({ resolvedEndpoint: { kind: "tcp", host: "10.0.0.9", port: 4795 }, remotePort: 7440 }))).toEqual({
      kind: "remote",
      target: { host: "127.0.0.1", port: 7440 },
    });
  });

  it("throws a descriptive error for a local device when this console's own connection is over TCP and no remote port is known", () => {
    const device: MbregistryStreamDevice = { uid: "local-uid" };
    expect(() =>
      resolveFlashPlan(device, client({ resolvedEndpoint: { kind: "tcp", host: "10.0.0.9", port: 4795 }, remotePort: undefined })),
    ).toThrow(/local-uid/);
  });
});
