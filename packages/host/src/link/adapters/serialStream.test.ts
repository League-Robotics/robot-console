import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { serialStream, type SerialPortLike } from "./serialStream.js";
import { toCalloutPath } from "../../devices.js";

// Real `serialport` I/O is not meaningfully unit-testable without real
// hardware -- see `UsbSerialLink.test.ts`'s own doc comment, which this
// file's fake mirrors exactly. What's under test here is everything
// this adapter actually owns: the darwin/Linux callout-path
// translation (ticket 014-001's own regression -- asserted with an
// injected `platform`, never the real `process.platform`), listener
// wiring done before a port exists yet (LineLink's own
// `attachStreamListeners()` calls `on()` before `open()`), and honouring
// an aborting `signal` by closing the half-open port instead of hanging
// (`02-host-transport.md` §5.6).

class FakeSerialPort extends EventEmitter implements SerialPortLike {
  writes: string[] = [];
  closeCalls = 0;

  write(data: string, callback?: (err?: Error | null) => void): boolean {
    this.writes.push(data);
    callback?.(null);
    return true;
  }

  close(callback?: (err?: Error | null) => void): void {
    this.closeCalls++;
    callback?.(null);
    this.emit("close");
  }
}

describe("serialStream -- callout-path translation", () => {
  it("translates the tty. path to cu. on darwin when opening", () => {
    let requestedPath: string | undefined;
    const port = new FakeSerialPort();
    const stream = serialStream("/dev/tty.usbmodem2121102", {
      createPort: (path) => {
        requestedPath = path;
        return port;
      },
      platform: "darwin",
    });
    void stream.open(new AbortController().signal);
    expect(requestedPath).toBe(toCalloutPath("/dev/tty.usbmodem2121102", "darwin"));
  });

  it("leaves the path unchanged on Linux (no tty./cu. translation)", () => {
    let requestedPath: string | undefined;
    const port = new FakeSerialPort();
    const stream = serialStream("/dev/ttyACM0", {
      createPort: (path) => {
        requestedPath = path;
        return port;
      },
      platform: "linux",
    });
    void stream.open(new AbortController().signal);
    expect(requestedPath).toBe("/dev/ttyACM0");
  });
});

describe("serialStream -- open()", () => {
  it("resolves once the port emits open, having sent nothing", async () => {
    const port = new FakeSerialPort();
    const stream = serialStream("/dev/tty.usbmodemFAKE", { createPort: () => port });
    const openPromise = stream.open(new AbortController().signal);
    port.emit("open");
    await expect(openPromise).resolves.toBeUndefined();
    expect(port.writes).toEqual([]);
  });

  it("rejects if the port errors before opening", async () => {
    const port = new FakeSerialPort();
    const stream = serialStream("/dev/tty.usbmodemFAKE", { createPort: () => port });
    const openPromise = stream.open(new AbortController().signal);
    port.emit("error", new Error("permission denied"));
    await expect(openPromise).rejects.toThrow(/permission denied/);
  });

  it("rejects immediately if the signal is already aborted", async () => {
    const port = new FakeSerialPort();
    const stream = serialStream("/dev/tty.usbmodemFAKE", { createPort: () => port });
    const controller = new AbortController();
    controller.abort(new Error("connect timed out"));
    await expect(stream.open(controller.signal)).rejects.toThrow(/connect timed out/);
  });

  it("closes the half-open port and rejects when the signal aborts mid-open (connect timeout)", async () => {
    const port = new FakeSerialPort();
    const stream = serialStream("/dev/tty.usbmodemFAKE", { createPort: () => port });
    const controller = new AbortController();
    const openPromise = stream.open(controller.signal);
    controller.abort(new Error("LineLink.connect() timed out after 5000ms"));
    await expect(openPromise).rejects.toThrow(/timed out after 5000ms/);
    expect(port.closeCalls).toBe(1);
  });
});

describe("serialStream -- listener wiring, write, and close", () => {
  it("wires on('data'/'error'/'close') listeners registered before open() onto the real port once it exists", async () => {
    const port = new FakeSerialPort();
    const stream = serialStream("/dev/tty.usbmodemFAKE", { createPort: () => port });
    const dataChunks: Array<Buffer | string> = [];
    const errors: Error[] = [];
    let closed = false;
    stream.on("data", (chunk) => dataChunks.push(chunk));
    stream.on("error", (err) => errors.push(err));
    stream.on("close", () => {
      closed = true;
    });

    const openPromise = stream.open(new AbortController().signal);
    port.emit("open");
    await openPromise;

    port.emit("data", Buffer.from("hello"));
    port.emit("error", new Error("boom"));
    port.emit("close");

    expect(dataChunks).toEqual([Buffer.from("hello")]);
    expect(errors).toEqual([new Error("boom")]);
    expect(closed).toBe(true);
  });

  it("write() delegates to the port and reports the callback's result", async () => {
    const port = new FakeSerialPort();
    const stream = serialStream("/dev/tty.usbmodemFAKE", { createPort: () => port });
    const openPromise = stream.open(new AbortController().signal);
    port.emit("open");
    await openPromise;

    let callbackErr: Error | null | undefined;
    stream.write("HELLO 1\n", (err) => {
      callbackErr = err;
    });
    expect(port.writes).toEqual(["HELLO 1\n"]);
    expect(callbackErr).toBeNull();
  });

  it("write() before open() reports an error rather than throwing", () => {
    const stream = serialStream("/dev/tty.usbmodemFAKE", { createPort: () => new FakeSerialPort() });
    let callbackErr: Error | null | undefined;
    stream.write("HELLO 1\n", (err) => {
      callbackErr = err;
    });
    expect(callbackErr).toBeInstanceOf(Error);
  });

  it("close() calls the port's close() and resolves once its callback fires", async () => {
    const port = new FakeSerialPort();
    const stream = serialStream("/dev/tty.usbmodemFAKE", { createPort: () => port });
    const openPromise = stream.open(new AbortController().signal);
    port.emit("open");
    await openPromise;

    await stream.close();
    expect(port.closeCalls).toBe(1);
  });

  it("close() before open() is a no-op that resolves immediately", async () => {
    const stream = serialStream("/dev/tty.usbmodemFAKE", { createPort: () => new FakeSerialPort() });
    await expect(stream.close()).resolves.toBeUndefined();
  });
});
