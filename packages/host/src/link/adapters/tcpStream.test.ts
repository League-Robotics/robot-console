import { EventEmitter } from "node:events";
import { createServer, type Server, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { tcpStream, type TcpSocketLike } from "./tcpStream.js";

// A fully synthetic fake drives the wiring assertions this adapter
// actually owns (NODELAY-before-any-write, destroy()-not-end() on
// close, honouring an aborting signal) with no real network at all --
// mirroring `MbrelayLink.test.ts`'s own fake-socket discipline. One
// integration test at the bottom exercises this adapter against a real
// loopback `net.createServer` on an ephemeral port (per the ticket:
// "a loopback net.createServer on port 0 is fine for tcpStream"),
// closed in `afterEach` -- never a real remote port.

class FakeSocket extends EventEmitter implements TcpSocketLike {
  writes: string[] = [];
  noDelayCalls: boolean[] = [];
  destroyCalls = 0;

  write(data: string, callback?: (err?: Error | null) => void): boolean {
    this.writes.push(data);
    callback?.(null);
    return true;
  }

  setNoDelay(noDelay = true): void {
    this.noDelayCalls.push(noDelay);
  }

  destroy(): void {
    this.destroyCalls++;
    this.emit("close");
  }
}

describe("tcpStream -- open()", () => {
  it("sets NODELAY immediately after connect, before any write, then resolves", async () => {
    const socket = new FakeSocket();
    const stream = tcpStream("relay.local", 8080, { createSocket: () => socket });
    const openPromise = stream.open(new AbortController().signal);
    expect(socket.noDelayCalls).toEqual([]);
    socket.emit("connect");
    await openPromise;
    expect(socket.noDelayCalls).toEqual([true]);
    expect(socket.writes).toEqual([]);
  });

  it("rejects if the socket errors before connecting", async () => {
    const socket = new FakeSocket();
    const stream = tcpStream("relay.local", 8080, { createSocket: () => socket });
    const openPromise = stream.open(new AbortController().signal);
    socket.emit("error", new Error("ECONNREFUSED"));
    await expect(openPromise).rejects.toThrow(/ECONNREFUSED/);
  });

  it("rejects immediately if the signal is already aborted", async () => {
    const socket = new FakeSocket();
    const stream = tcpStream("relay.local", 8080, { createSocket: () => socket });
    const controller = new AbortController();
    controller.abort(new Error("connect timed out"));
    await expect(stream.open(controller.signal)).rejects.toThrow(/connect timed out/);
  });

  it("destroy()s the half-open socket and rejects when the signal aborts mid-connect (connect timeout)", async () => {
    const socket = new FakeSocket();
    const stream = tcpStream("relay.local", 8080, { createSocket: () => socket });
    const controller = new AbortController();
    const openPromise = stream.open(controller.signal);
    controller.abort(new Error("LineLink.connect() timed out after 5000ms"));
    await expect(openPromise).rejects.toThrow(/timed out after 5000ms/);
    expect(socket.destroyCalls).toBe(1);
    // Honouring the connect timeout means never having reached the data
    // plane at all -- NODELAY is only ever set on a successful connect.
    expect(socket.noDelayCalls).toEqual([]);
  });
});

describe("tcpStream -- listener wiring, write, and close", () => {
  it("wires on('data'/'error'/'close') listeners registered before open() onto the real socket once it exists", async () => {
    const socket = new FakeSocket();
    const stream = tcpStream("relay.local", 8080, { createSocket: () => socket });
    const dataChunks: Array<Buffer | string> = [];
    const errors: Error[] = [];
    let closed = false;
    stream.on("data", (chunk) => dataChunks.push(chunk));
    stream.on("error", (err) => errors.push(err));
    stream.on("close", () => {
      closed = true;
    });

    const openPromise = stream.open(new AbortController().signal);
    socket.emit("connect");
    await openPromise;

    socket.emit("data", Buffer.from("hello"));
    socket.emit("error", new Error("boom"));
    socket.emit("close");

    expect(dataChunks).toEqual([Buffer.from("hello")]);
    expect(errors).toEqual([new Error("boom")]);
    expect(closed).toBe(true);
  });

  it("write() delegates to the socket and reports the callback's result", async () => {
    const socket = new FakeSocket();
    const stream = tcpStream("relay.local", 8080, { createSocket: () => socket });
    const openPromise = stream.open(new AbortController().signal);
    socket.emit("connect");
    await openPromise;

    let callbackErr: Error | null | undefined;
    stream.write("HELLO 1\n", (err) => {
      callbackErr = err;
    });
    expect(socket.writes).toEqual(["HELLO 1\n"]);
    expect(callbackErr).toBeNull();
  });

  it("write() before open() reports an error rather than throwing", () => {
    const stream = tcpStream("relay.local", 8080, { createSocket: () => new FakeSocket() });
    let callbackErr: Error | null | undefined;
    stream.write("HELLO 1\n", (err) => {
      callbackErr = err;
    });
    expect(callbackErr).toBeInstanceOf(Error);
  });

  it("close() calls destroy() -- never end() -- and resolves immediately without waiting for the close event", async () => {
    const socket = new FakeSocket();
    const stream = tcpStream("relay.local", 8080, { createSocket: () => socket });
    const openPromise = stream.open(new AbortController().signal);
    socket.emit("connect");
    await openPromise;

    await expect(stream.close()).resolves.toBeUndefined();
    expect(socket.destroyCalls).toBe(1);
  });

  it("close() before open() is a no-op that resolves immediately", async () => {
    const stream = tcpStream("relay.local", 8080, { createSocket: () => new FakeSocket() });
    await expect(stream.close()).resolves.toBeUndefined();
  });
});

describe("tcpStream -- real loopback socket (no fake, per the ticket's allowance)", () => {
  let server: Server | undefined;
  let serverSocket: Socket | undefined;

  afterEach(async () => {
    serverSocket?.destroy();
    serverSocket = undefined;
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
  });

  it("connects to a real loopback server, sets NODELAY, and exchanges data both ways", async () => {
    server = createServer((socket) => {
      serverSocket = socket;
      socket.on("data", (chunk) => {
        socket.write(`echo:${chunk.toString()}`);
      });
    });
    const port = await new Promise<number>((resolve) => {
      server!.listen(0, "127.0.0.1", () => {
        const address = server!.address();
        resolve(typeof address === "object" && address !== null ? address.port : 0);
      });
    });

    const stream = tcpStream("127.0.0.1", port);
    await stream.open(new AbortController().signal);

    const received = new Promise<string>((resolve) => {
      stream.on("data", (chunk) => resolve(chunk.toString()));
    });
    await new Promise<void>((resolve, reject) => {
      stream.write("ping\n", (err) => (err ? reject(err) : resolve()));
    });
    await expect(received).resolves.toBe("echo:ping\n");

    await stream.close();
  });
});
