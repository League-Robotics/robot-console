import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { UsbSerialLink, type SerialPortLike } from "./UsbSerialLink.js";
import type { Scheduler } from "./pacing.js";
import { toCalloutPath } from "../devices.js";

// Per the ticket's Testing section: the real `serialport` I/O is a thin
// wrapper around real hardware and is not meaningfully unit-testable
// without either real hardware or a fairly elaborate serial-port fake.
// What IS unit-tested here, against a fully synthetic `FakeSerialPort`,
// is everything this class actually owns: the connect()/identify()
// split, write pacing wired through to the port, and the port-lock-
// contention regression (identify() retried without re-opening the
// port). `LineReassembler`/`WritePacer` have their own test files
// (`lineStream.test.ts`/`pacing.test.ts`) and `LineRouter`'s decode/
// classify/ack-nack/resend logic has its own (`LineRouter.test.ts`) --
// this file only asserts that `UsbSerialLink` wires them together
// correctly. The real connect/identify/console-command path against
// actual hardware is covered by this sprint's recorded hardware smoke
// test instead (see the ticket).

/** A fully synthetic stand-in for `serialport`'s `SerialPort`, recording
 * every write and letting a test drive `data`/`open`/`error`/`close`
 * events directly. */
class FakeSerialPort extends EventEmitter implements SerialPortLike {
  writes: string[] = [];
  closeCalls = 0;

  // `on`/`once` are inherited unmodified from `EventEmitter` -- its own
  // `(event: string, listener: (...args: any[]) => void)` signature is
  // already broad enough to satisfy `SerialPortLike`'s per-event
  // overloads structurally, so this fake need not (and must not, per
  // `tsc`) redeclare either with a narrower `unknown[]` listener type.

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

/** A scheduler that resolves `delay()` immediately (on a microtask) but
 * records every call, so pacing behavior is assertable without any real
 * wall-clock waiting or fake-timer bookkeeping. */
function recordingScheduler(): Scheduler & { calls: number[] } {
  const calls: number[] = [];
  return {
    calls,
    delay: (ms: number) => {
      calls.push(ms);
      return Promise.resolve();
    },
  };
}

/** Flush pending microtasks (a `WritePacer` chain, or `UsbSerialLink`'s
 * internal writes) so scheduled work has settled before assertions run.
 * A macrotask boundary (`setTimeout`) drains the entire microtask queue
 * first, however many `.then()` hops a chained `WritePacer` schedule
 * happens to need -- unlike a fixed number of `await Promise.resolve()`
 * hops, this does not need retuning as that chain's shape changes. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** Real pacing behavior (the actual 10ms gap) is covered separately by
 * the "UsbSerialLink write pacing" suite below, with an explicit
 * `recordingScheduler()`. Every other test in this file cares about
 * wiring/sequencing correctness, not real elapsed time, so it defaults
 * to a scheduler whose `delay()` resolves on the next microtask instead
 * of a real wall-clock wait. */
const immediateScheduler: Scheduler = { delay: () => Promise.resolve() };

/** Build a link and drive it through `connect()`, emitting the fake
 * port's `open` event so the returned promise settles. */
function connectedLink(overrides: { paceMs?: number; scheduler?: Scheduler; openTimeoutMs?: number } = {}): {
  link: UsbSerialLink;
  port: FakeSerialPort;
  connectPromise: Promise<void>;
} {
  const port = new FakeSerialPort();
  const link = new UsbSerialLink("/dev/tty.usbmodemFAKE", {
    createPort: () => port,
    writePaceMs: overrides.paceMs ?? 10,
    scheduler: overrides.scheduler ?? immediateScheduler,
    openTimeoutMs: overrides.openTimeoutMs ?? 200,
  });
  const connectPromise = link.connect();
  port.emit("open");
  return { link, port, connectPromise };
}

/** `connect()` then `identify()`, emitting `bannerLine` as the HELLO
 * reply once the HELLO write has gone out. */
async function identifiedLink(
  bannerLine: string,
  overrides: { paceMs?: number; scheduler?: Scheduler } = {},
): Promise<{ link: UsbSerialLink; port: FakeSerialPort }> {
  const { link, port, connectPromise } = connectedLink(overrides);
  await connectPromise;
  const identifyPromise = link.identify();
  await flush();
  port.emit("data", Buffer.from(`${bannerLine}\n`));
  await identifyPromise;
  return { link, port };
}

// ---------------------------------------------------------------------
// UsbSerialLink.connect() -- transport-only, no HELLO
// ---------------------------------------------------------------------

describe("UsbSerialLink.connect", () => {
  it("opens the port and resolves without sending anything", async () => {
    const { port, connectPromise } = connectedLink();
    await connectPromise;
    expect(port.writes).toEqual([]);
  });

  it("translates the tty. path to cu. on darwin when connecting", () => {
    let requestedPath: string | undefined;
    const port = new FakeSerialPort();
    const link = new UsbSerialLink("/dev/tty.usbmodem2121102", {
      createPort: (path) => {
        requestedPath = path;
        return port;
      },
    });
    // Not awaited -- only the synchronous createPort() call matters here.
    void link.connect();
    expect(requestedPath).toBe(toCalloutPath("/dev/tty.usbmodem2121102", "darwin"));
  });

  it("rejects if the port errors before opening", async () => {
    const port = new FakeSerialPort();
    const link = new UsbSerialLink("/dev/tty.usbmodemFAKE", {
      createPort: () => port,
    });
    const connectPromise = link.connect();
    port.emit("error", new Error("permission denied"));
    await expect(connectPromise).rejects.toThrow(/permission denied/);
  });

  it("refuses to be connected a second time", async () => {
    const { link, connectPromise } = connectedLink();
    await connectPromise;
    await expect(link.connect()).rejects.toThrow(/already|once|"connect"|connected/i);
  });

  it("isOpen is true once connected, even before identify() is ever called", async () => {
    const { link, connectPromise } = connectedLink();
    await connectPromise;
    expect(link.isOpen).toBe(true);
  });
});

// ---------------------------------------------------------------------
// UsbSerialLink.identify() -- HELLO -> banner-from-reply, or null
// ---------------------------------------------------------------------

describe("UsbSerialLink.identify", () => {
  it("sends HELLO (paced) and resolves with the banner parsed from its reply (colon dialect)", async () => {
    const { link, port } = await identifiedLink("DEVICE:RADIOBRIDGE:relay:getez:1779042496");

    expect(port.writes).toEqual(["HELLO\n"]);
    expect(link.banner).toEqual({
      role: "RADIOBRIDGE",
      commonName: "relay",
      name: "getez",
      serial: 1779042496,
      dialect: "colon",
    });
  });

  it("resolves with the banner parsed from a space-dialect robot reply", async () => {
    const { link } = await identifiedLink("device NEZHA2 robot vevov 1198504156");
    expect(link.role).toBe("NEZHA2");
    expect(link.name).toBe("vevov");
  });

  it("exposes role/name/serial getters once identified", async () => {
    const { link } = await identifiedLink("DEVICE:RADIOBRIDGE:relay:getez:1779042496");
    expect(link.role).toBe("RADIOBRIDGE");
    expect(link.name).toBe("getez");
    expect(link.serial).toBe(1779042496);
  });

  it("ignores noise arriving before the actual banner during the identify wait", async () => {
    const { link, connectPromise, port } = connectedLink();
    await connectPromise;
    const identifyPromise = link.identify();
    await flush();
    port.emit("data", Buffer.from("not a banner\n"));
    port.emit("data", Buffer.from("DEVICE:RADIOBRIDGE:relay:getez:1779042496\n"));
    const banner = await identifyPromise;
    expect(banner?.name).toBe("getez");
  });

  it("resolves null (never rejects) if no banner arrives within openTimeoutMs", async () => {
    const port = new FakeSerialPort();
    const link = new UsbSerialLink("/dev/tty.usbmodemFAKE", {
      createPort: () => port,
      openTimeoutMs: 20,
    });
    const connectPromise = link.connect();
    port.emit("open");
    await connectPromise;
    const banner = await link.identify();
    expect(banner).toBeNull();
    expect(link.isOpen).toBe(true); // the transport itself is untouched
  });

  it("throws if called before connect() has succeeded", async () => {
    const port = new FakeSerialPort();
    const link = new UsbSerialLink("/dev/tty.usbmodemFAKE", { createPort: () => port });
    await expect(link.identify()).rejects.toThrow(/not connected|connect\(\)/i);
  });

  // ---- the port-lock-contention regression --------------------------
  //
  // port-lock-contention-between-identify-and-user-open.md: before this
  // ticket, a failed identify (a silent board) rejected UsbSerialLink's
  // old open(), whose caller (deviceRegistry.ts's openLink) then closed
  // the link -- so a later retry opened a brand-new port, racing the OS
  // over the handle the previous attempt had only just released. After
  // this split, identify() alone times out (resolving null) while the
  // port connect() opened stays untouched, so a retry re-sends HELLO on
  // the SAME already-open port -- no close, no reopen, nothing for the
  // OS to contend over.
  it("calling identify() again after a null resolution re-sends HELLO without re-opening or closing the port", async () => {
    const port = new FakeSerialPort();
    let createPortCalls = 0;
    const link = new UsbSerialLink("/dev/tty.usbmodemFAKE", {
      createPort: () => {
        createPortCalls++;
        return port;
      },
      openTimeoutMs: 20,
    });
    const connectPromise = link.connect();
    port.emit("open");
    await connectPromise;
    expect(createPortCalls).toBe(1);

    const first = await link.identify();
    expect(first).toBeNull();

    const identifyPromise = link.identify();
    await flush();
    port.emit("data", Buffer.from("DEVICE:RADIOBRIDGE:relay:getez:1779042496\n"));
    const second = await identifyPromise;

    expect(second?.name).toBe("getez");
    expect(port.writes).toEqual(["HELLO\n", "HELLO\n"]);
    // The port is opened exactly once across both identify() attempts,
    // and never closed in between -- this is the fix for
    // port-lock-contention-between-identify-and-user-open.md.
    expect(createPortCalls).toBe(1);
    expect(port.closeCalls).toBe(0);
  });
});

// ---------------------------------------------------------------------
// Write pacing through the link (trap #5)
// ---------------------------------------------------------------------

describe("UsbSerialLink write pacing", () => {
  it("paces every write, including the initial HELLO", async () => {
    const scheduler = recordingScheduler();
    const { port } = await identifiedLink("DEVICE:RADIOBRIDGE:relay:getez:1779042496", { paceMs: 10, scheduler });

    // One write so far (HELLO), one pace delay recorded for it.
    expect(port.writes).toEqual(["HELLO\n"]);
    expect(scheduler.calls).toEqual([10]);
  });

  it("paces console-sent lines the same way as HELLO", async () => {
    const scheduler = recordingScheduler();
    const { link, port } = await identifiedLink("DEVICE:RADIOBRIDGE:relay:getez:1779042496", { paceMs: 10, scheduler });

    link.checkLiveness();
    link.sendUnsequenced("STATUS");
    await flush();

    expect(port.writes).toEqual(["HELLO\n", "PING\n", "STATUS\n"]);
    expect(scheduler.calls).toEqual([10, 10, 10]);
  });
});

// ---------------------------------------------------------------------
// Sequencing / ack-nack wiring via v6/session.ts, through the link
// ---------------------------------------------------------------------

describe("UsbSerialLink sequencing", () => {
  async function openedRobotLink() {
    const { link, port } = await identifiedLink("device NEZHA2 robot vevov 1198504156");
    port.writes.length = 0; // drop the recorded HELLO write
    return { link, port };
  }

  it("sends id-bearing commands sequenced via Session.send()", async () => {
    const { link, port } = await openedRobotLink();
    const line = link.sendCommand("STOP");
    await flush();
    expect(line).toBe("STOP #1\n");
    expect(port.writes).toEqual(["STOP #1\n"]);
    expect(link.session.pendingCount).toBe(1);
  });

  it("updates session state and fires onAckNack when an ack reply arrives", async () => {
    const { link, port } = await openedRobotLink();
    link.sendCommand("STOP");
    await flush();

    const events: unknown[] = [];
    link.onAckNack((e) => events.push(e));

    port.emit("data", Buffer.from("ack 1 1 ok\n"));
    await flush();

    expect(link.session.seq).toBe(1);
    expect(link.session.pendingCount).toBe(0);
    expect(events).toHaveLength(1);
  });

  it("resends the correct pending line, through the paced write path, on nack", async () => {
    const { link, port } = await openedRobotLink();
    link.sendCommand("STOP"); // id 1
    await flush();
    port.writes.length = 0;

    port.emit("data", Buffer.from("nack 1 0 none\n"));
    await flush();

    expect(port.writes).toEqual(["STOP #1\n"]);
  });

  it("throws SessionError for a non-sequenced verb passed to sendCommand", async () => {
    const { link } = await openedRobotLink();
    expect(() => link.sendCommand("PING")).toThrow();
  });

  it("never sends HELLO again through sendUnsequenced -- it refuses it", async () => {
    const { link } = await openedRobotLink();
    expect(() => link.sendUnsequenced("HELLO")).toThrow(/HELLO/);
  });
});

// ---------------------------------------------------------------------
// Foreign-traffic drop (acceptance criterion), once connected
// ---------------------------------------------------------------------

describe("UsbSerialLink foreign traffic", () => {
  it("drops a lowercase line that is not a recognized reply verb, silently", async () => {
    const { link, port } = await identifiedLink("DEVICE:RADIOBRIDGE:relay:getez:1779042496");

    const lines: unknown[] = [];
    const errors: unknown[] = [];
    link.onLine((l) => lines.push(l));
    link.onError((e) => errors.push(e));

    expect(() => {
      port.emit("data", Buffer.from("beep boop overheard\n"));
    }).not.toThrow();
    await flush();

    expect(lines).toEqual([]);
    expect(errors).toEqual([]);
  });

  it("still delivers a recognized lowercase reply verb to onLine", async () => {
    const { link, port } = await identifiedLink("DEVICE:RADIOBRIDGE:relay:getez:1779042496");

    const lines: Array<{ verb: string }> = [];
    link.onLine((l) => lines.push(l));

    port.emit("data", Buffer.from("pong\n"));
    await flush();

    expect(lines).toEqual([{ kind: "line", verb: "pong", fields: [] }]);
  });

  it("still routes ordinary traffic after identify() times out (connected, unresponsive is not a dead link)", async () => {
    const port = new FakeSerialPort();
    const link = new UsbSerialLink("/dev/tty.usbmodemFAKE", {
      createPort: () => port,
      openTimeoutMs: 20,
    });
    const connectPromise = link.connect();
    port.emit("open");
    await connectPromise;
    const banner = await link.identify();
    expect(banner).toBeNull();

    const lines: Array<{ verb: string }> = [];
    link.onLine((l) => lines.push(l));
    port.emit("data", Buffer.from("pong\n"));
    await flush();

    expect(lines).toEqual([{ kind: "line", verb: "pong", fields: [] }]);
  });
});

// ---------------------------------------------------------------------
// Calling send*/checkLiveness before connect()
// ---------------------------------------------------------------------

describe("UsbSerialLink guards against use before connect", () => {
  it("sendLine throws before connect()", () => {
    const port = new FakeSerialPort();
    const link = new UsbSerialLink("/dev/tty.usbmodemFAKE", { createPort: () => port });
    expect(() => link.sendLine("STATUS")).toThrow(/not connected/i);
  });

  it("checkLiveness throws before connect()", () => {
    const port = new FakeSerialPort();
    const link = new UsbSerialLink("/dev/tty.usbmodemFAKE", { createPort: () => port });
    expect(() => link.checkLiveness()).toThrow(/not connected/i);
  });
});
