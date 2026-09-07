import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import {
  LineReassembler,
  UsbSerialLink,
  WritePacer,
  toCalloutPath,
  type Scheduler,
  type SerialPortLike,
} from "./UsbSerialLink.js";

// Per the ticket's Testing section: the real `serialport` I/O is a thin
// wrapper around real hardware and is not meaningfully unit-testable
// without either real hardware or a fairly elaborate fake. What IS
// unit-tested here, against a fully synthetic `FakeSerialPort`, is
// everything this module actually owns: the open->HELLO->banner-from-
// reply sequence, write pacing, ack/nack wiring into `Session`, and
// silently dropping foreign traffic. The real open/HELLO/console-command
// path against actual hardware is covered by this sprint's recorded
// hardware smoke test instead (see the ticket).

/** A fully synthetic stand-in for `serialport`'s `SerialPort`, recording
 * every write and letting a test drive `data`/`open`/`error`/`close`
 * events directly. */
class FakeSerialPort extends EventEmitter implements SerialPortLike {
  writes: string[] = [];
  closed = false;

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
    this.closed = true;
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
 * the "UsbSerialLink write pacing" / "WritePacer" suites below, each
 * with an explicit `recordingScheduler()`. Every other test in this
 * file cares about wiring/sequencing correctness, not real elapsed
 * time, so it defaults to a scheduler whose `delay()` resolves on the
 * next microtask instead of a real wall-clock wait -- otherwise every
 * such test would need to actually wait out real pacing delays (or
 * fake timers) just to observe a write that has nothing to do with
 * pacing itself. */
const immediateScheduler: Scheduler = { delay: () => Promise.resolve() };

function openedLink(overrides: { paceMs?: number; scheduler?: Scheduler } = {}): {
  link: UsbSerialLink;
  port: FakeSerialPort;
  openPromise: Promise<import("@robot-console/protocol").ParsedBanner>;
} {
  const port = new FakeSerialPort();
  const link = new UsbSerialLink("/dev/tty.usbmodemFAKE", {
    createPort: () => port,
    writePaceMs: overrides.paceMs ?? 10,
    scheduler: overrides.scheduler ?? immediateScheduler,
    openTimeoutMs: 200,
  });
  const openPromise = link.open();
  port.emit("open");
  return { link, port, openPromise };
}

// ---------------------------------------------------------------------
// toCalloutPath (trap #1)
// ---------------------------------------------------------------------

describe("toCalloutPath", () => {
  it("translates a macOS tty. path to its cu. counterpart", () => {
    expect(toCalloutPath("/dev/tty.usbmodem2121102", "darwin")).toBe(
      "/dev/cu.usbmodem2121102",
    );
  });

  it("leaves an already-cu. path unchanged on darwin", () => {
    expect(toCalloutPath("/dev/cu.usbmodem2121102", "darwin")).toBe(
      "/dev/cu.usbmodem2121102",
    );
  });

  it("leaves a Linux-shaped path unchanged", () => {
    expect(toCalloutPath("/dev/ttyACM0", "linux")).toBe("/dev/ttyACM0");
  });

  it("leaves a non-serial path unchanged on darwin (no tty. prefix)", () => {
    expect(toCalloutPath("/dev/something-else", "darwin")).toBe(
      "/dev/something-else",
    );
  });
});

// ---------------------------------------------------------------------
// LineReassembler (trap #6, #7)
// ---------------------------------------------------------------------

describe("LineReassembler", () => {
  it("returns nothing until a newline arrives, then the complete line", () => {
    const r = new LineReassembler();
    expect(r.push("ack 1 0 n")).toEqual([]);
    expect(r.push("one\n")).toEqual(["ack 1 0 none"]);
  });

  it("splits a single chunk carrying multiple lines", () => {
    const r = new LineReassembler();
    expect(r.push("pong\nack 1 0 none\n")).toEqual(["pong", "ack 1 0 none"]);
  });

  it("strips a trailing \\r", () => {
    const r = new LineReassembler();
    expect(r.push("pong\r\n")).toEqual(["pong"]);
  });

  it("strips a leading '< ' prefix unconditionally", () => {
    const r = new LineReassembler();
    expect(r.push("< pong\n")).toEqual(["pong"]);
  });

  it("strips both '< ' and a trailing \\r on the same line", () => {
    const r = new LineReassembler();
    expect(r.push("< ack 1 0 none\r\n")).toEqual(["ack 1 0 none"]);
  });

  it("does not strip '< ' if it is not a leading prefix", () => {
    const r = new LineReassembler();
    expect(r.push("ret 1 < 2\n")).toEqual(["ret 1 < 2"]);
  });
});

// ---------------------------------------------------------------------
// WritePacer (trap #5) -- pacing logic in isolation
// ---------------------------------------------------------------------

describe("WritePacer", () => {
  it("runs writes in order, delaying by paceMs between each", async () => {
    const scheduler = recordingScheduler();
    const pacer = new WritePacer(10, scheduler);
    const order: string[] = [];

    pacer.schedule(() => order.push("a"));
    pacer.schedule(() => order.push("b"));
    pacer.schedule(() => order.push("c"));

    await flush();

    expect(order).toEqual(["a", "b", "c"]);
    expect(scheduler.calls).toEqual([10, 10, 10]);
  });

  it("a throwing write does not wedge later scheduled writes", async () => {
    const scheduler = recordingScheduler();
    const pacer = new WritePacer(10, scheduler);
    const order: string[] = [];

    pacer.schedule(() => {
      throw new Error("boom");
    });
    pacer.schedule(() => order.push("still runs"));

    await flush();

    expect(order).toEqual(["still runs"]);
  });
});

// ---------------------------------------------------------------------
// UsbSerialLink.open() -- open -> HELLO -> read banner from reply
// ---------------------------------------------------------------------

describe("UsbSerialLink.open", () => {
  it("sends HELLO (paced) and resolves with the banner parsed from its reply (colon dialect)", async () => {
    const { port, openPromise } = openedLink();
    await flush();

    // HELLO must have been written before the reply arrives.
    expect(port.writes).toEqual(["HELLO\n"]);

    port.emit("data", Buffer.from("DEVICE:RADIOBRIDGE:relay:getez:1779042496\n"));
    const banner = await openPromise;

    expect(banner).toEqual({
      role: "RADIOBRIDGE",
      commonName: "relay",
      name: "getez",
      serial: 1779042496,
      dialect: "colon",
    });
  });

  it("resolves with the banner parsed from a space-dialect robot reply", async () => {
    const { port, openPromise } = openedLink();
    await flush();
    port.emit("data", Buffer.from("device NEZHA2 robot vevov 1198504156\n"));
    const banner = await openPromise;
    expect(banner.role).toBe("NEZHA2");
    expect(banner.name).toBe("vevov");
    expect(banner.dialect).toBe("space");
  });

  it("exposes role/name/serial getters once open", async () => {
    const { link, port, openPromise } = openedLink();
    await flush();
    port.emit("data", Buffer.from("DEVICE:RADIOBRIDGE:relay:getez:1779042496\n"));
    await openPromise;

    expect(link.role).toBe("RADIOBRIDGE");
    expect(link.name).toBe("getez");
    expect(link.serial).toBe(1779042496);
    expect(link.isOpen).toBe(true);
  });

  it("ignores noise arriving before the actual banner during the open wait", async () => {
    const { port, openPromise } = openedLink();
    await flush();
    port.emit("data", Buffer.from("not a banner\n"));
    port.emit("data", Buffer.from("DEVICE:RADIOBRIDGE:relay:getez:1779042496\n"));
    const banner = await openPromise;
    expect(banner.name).toBe("getez");
  });

  it("rejects if no banner arrives within openTimeoutMs", async () => {
    const port = new FakeSerialPort();
    const link = new UsbSerialLink("/dev/tty.usbmodemFAKE", {
      createPort: () => port,
      openTimeoutMs: 20,
    });
    const openPromise = link.open();
    port.emit("open");
    await expect(openPromise).rejects.toThrow(/timed out/i);
  });

  it("rejects if the port errors before opening", async () => {
    const port = new FakeSerialPort();
    const link = new UsbSerialLink("/dev/tty.usbmodemFAKE", {
      createPort: () => port,
    });
    const openPromise = link.open();
    port.emit("error", new Error("permission denied"));
    await expect(openPromise).rejects.toThrow(/permission denied/);
  });

  it("translates the tty. path to cu. on darwin when opening", () => {
    let requestedPath: string | undefined;
    const port = new FakeSerialPort();
    const link = new UsbSerialLink("/dev/tty.usbmodem2121102", {
      createPort: (path) => {
        requestedPath = path;
        return port;
      },
    });
    // Not awaited -- only the synchronous createPort() call matters here.
    void link.open();
    expect(requestedPath).toBe(toCalloutPath("/dev/tty.usbmodem2121102", "darwin"));
  });

  it("refuses to be opened a second time", async () => {
    const { link, port, openPromise } = openedLink();
    await flush();
    port.emit("data", Buffer.from("DEVICE:RADIOBRIDGE:relay:getez:1779042496\n"));
    await openPromise;
    await expect(link.open()).rejects.toThrow(/already|once|"open"/i);
  });
});

// ---------------------------------------------------------------------
// Write pacing through the link (trap #5)
// ---------------------------------------------------------------------

describe("UsbSerialLink write pacing", () => {
  it("paces every write, including the initial HELLO", async () => {
    const scheduler = recordingScheduler();
    const { port, openPromise } = openedLink({ paceMs: 10, scheduler });
    await flush();
    port.emit("data", Buffer.from("DEVICE:RADIOBRIDGE:relay:getez:1779042496\n"));
    await openPromise;

    // One write so far (HELLO), one pace delay recorded for it.
    expect(port.writes).toEqual(["HELLO\n"]);
    expect(scheduler.calls).toEqual([10]);
  });

  it("paces console-sent lines the same way as HELLO", async () => {
    const scheduler = recordingScheduler();
    const { link, port, openPromise } = openedLink({ paceMs: 10, scheduler });
    await flush();
    port.emit("data", Buffer.from("DEVICE:RADIOBRIDGE:relay:getez:1779042496\n"));
    await openPromise;

    link.checkLiveness();
    link.sendUnsequenced("STATUS");
    await flush();

    expect(port.writes).toEqual(["HELLO\n", "PING\n", "STATUS\n"]);
    expect(scheduler.calls).toEqual([10, 10, 10]);
  });
});

// ---------------------------------------------------------------------
// Sequencing / ack-nack wiring via v6/session.ts
// ---------------------------------------------------------------------

describe("UsbSerialLink sequencing", () => {
  async function openedRobotLink() {
    const { link, port, openPromise } = openedLink();
    await flush();
    port.emit("data", Buffer.from("device NEZHA2 robot vevov 1198504156\n"));
    await openPromise;
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

  it("never sends HELLO again after open -- sendUnsequenced refuses it", async () => {
    const { link } = await openedRobotLink();
    expect(() => link.sendUnsequenced("HELLO")).toThrow(/HELLO/);
  });
});

// ---------------------------------------------------------------------
// Foreign-traffic drop (acceptance criterion)
// ---------------------------------------------------------------------

describe("UsbSerialLink foreign traffic", () => {
  it("drops a lowercase line that is not a recognized reply verb, silently", async () => {
    const { link, port, openPromise } = openedLink();
    await flush();
    port.emit("data", Buffer.from("DEVICE:RADIOBRIDGE:relay:getez:1779042496\n"));
    await openPromise;

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
    const { link, port, openPromise } = openedLink();
    await flush();
    port.emit("data", Buffer.from("DEVICE:RADIOBRIDGE:relay:getez:1779042496\n"));
    await openPromise;

    const lines: Array<{ verb: string }> = [];
    link.onLine((l) => lines.push(l));

    port.emit("data", Buffer.from("pong\n"));
    await flush();

    expect(lines).toEqual([{ kind: "line", verb: "pong", fields: [] }]);
  });

  it("drops a blank line silently", async () => {
    const { link, port, openPromise } = openedLink();
    await flush();
    port.emit("data", Buffer.from("DEVICE:RADIOBRIDGE:relay:getez:1779042496\n"));
    await openPromise;

    const lines: unknown[] = [];
    link.onLine((l) => lines.push(l));
    port.emit("data", Buffer.from("   \n"));
    await flush();

    expect(lines).toEqual([]);
  });
});

// ---------------------------------------------------------------------
// Calling send*/checkLiveness before open
// ---------------------------------------------------------------------

describe("UsbSerialLink guards against use before open", () => {
  it("sendLine throws before open()", () => {
    const port = new FakeSerialPort();
    const link = new UsbSerialLink("/dev/tty.usbmodemFAKE", { createPort: () => port });
    expect(() => link.sendLine("STATUS")).toThrow(/not open/i);
  });

  it("checkLiveness throws before open()", () => {
    const port = new FakeSerialPort();
    const link = new UsbSerialLink("/dev/tty.usbmodemFAKE", { createPort: () => port });
    expect(() => link.checkLiveness()).toThrow(/not open/i);
  });
});
