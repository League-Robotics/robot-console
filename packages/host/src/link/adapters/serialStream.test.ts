import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { serialStream, type SerialPortLike } from "./serialStream.js";
import { toCalloutPath } from "../../devices.js";
import type { Scheduler } from "../pacing.js";

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
  /** Every `set()` call, in order -- ticket 016-002's own break-reset
   * assertions read this to confirm `brk` was asserted then cleared. */
  setCalls: Array<{ brk?: boolean }> = [];
  /** Set to fail the NEXT `set()` call's callback instead of succeeding.
   * Cleared after that one use. */
  nextSetError: Error | undefined;

  write(data: string, callback?: (err?: Error | null) => void): boolean {
    this.writes.push(data);
    callback?.(null);
    return true;
  }

  set(options: { brk?: boolean }, callback?: (err?: Error | null) => void): void {
    this.setCalls.push(options);
    const err = this.nextSetError;
    this.nextSetError = undefined;
    callback?.(err ?? null);
  }

  close(callback?: (err?: Error | null) => void): void {
    this.closeCalls++;
    callback?.(null);
    this.emit("close");
  }
}

/** A scheduler whose `delay()` resolves on the next microtask, recording
 * every requested duration -- lets a `sendBreak()` test assert the hold
 * duration without a real wall-clock wait. */
function recordingScheduler(): Scheduler & { delays: number[] } {
  const delays: number[] = [];
  return {
    delay: (ms: number) => {
      delays.push(ms);
      return Promise.resolve();
    },
    delays,
  };
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

// ---------------------------------------------------------------------
// Ticket 016-002: sendBreak() -- the serial-break reset primitive
// `connect/relayBridger.ts` uses for a relay with no HID interface
// (`resolveRelayPhysical`'s own `hidPath` absent). `serialport`'s own
// `set({brk: true})`/`set({brk: false})` pair, asserted then cleared
// after `durationMs` -- see the module doc comment's own section.
// ---------------------------------------------------------------------

describe("serialStream -- sendBreak() (ticket 016-002 reset primitive)", () => {
  it("asserts brk, waits durationMs, then clears brk, in that order", async () => {
    const port = new FakeSerialPort();
    const stream = serialStream("/dev/tty.usbmodemFAKE", { createPort: () => port });
    const openPromise = stream.open(new AbortController().signal);
    port.emit("open");
    await openPromise;

    const scheduler = recordingScheduler();
    await stream.sendBreak(123, scheduler);

    expect(port.setCalls).toEqual([{ brk: true }, { brk: false }]);
    expect(scheduler.delays).toEqual([123]);
  });

  it("defaults durationMs to DEFAULT_BREAK_MS when omitted", async () => {
    const port = new FakeSerialPort();
    const stream = serialStream("/dev/tty.usbmodemFAKE", { createPort: () => port });
    const openPromise = stream.open(new AbortController().signal);
    port.emit("open");
    await openPromise;

    const scheduler = recordingScheduler();
    await stream.sendBreak(undefined, scheduler);

    expect(scheduler.delays).toEqual([250]);
  });

  it("rejects if called before open() has resolved", async () => {
    const stream = serialStream("/dev/tty.usbmodemFAKE", { createPort: () => new FakeSerialPort() });
    await expect(stream.sendBreak(10, recordingScheduler())).rejects.toThrow(/before open\(\) resolved/);
  });

  it("rejects if asserting brk fails, and never attempts to clear it", async () => {
    const port = new FakeSerialPort();
    const stream = serialStream("/dev/tty.usbmodemFAKE", { createPort: () => port });
    const openPromise = stream.open(new AbortController().signal);
    port.emit("open");
    await openPromise;

    port.nextSetError = new Error("set() failed");
    await expect(stream.sendBreak(10, recordingScheduler())).rejects.toThrow(/set\(\) failed/);
    expect(port.setCalls).toEqual([{ brk: true }]);
  });

  it("rejects if clearing brk fails after a successful assert", async () => {
    const port = new FakeSerialPort();
    const stream = serialStream("/dev/tty.usbmodemFAKE", { createPort: () => port });
    const openPromise = stream.open(new AbortController().signal);
    port.emit("open");
    await openPromise;

    const scheduler = recordingScheduler();
    const pending = stream.sendBreak(10, scheduler);
    // The assert (`{brk:true}`) already succeeded synchronously above;
    // arm the failure for the clear (`{brk:false}`) before it runs.
    port.nextSetError = new Error("clear failed");
    await expect(pending).rejects.toThrow(/clear failed/);
    expect(port.setCalls).toEqual([{ brk: true }, { brk: false }]);
  });
});
