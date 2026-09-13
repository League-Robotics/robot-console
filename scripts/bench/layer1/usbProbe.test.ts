import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { filterDaplinkPorts, probeUsb, toCalloutPath, type UsbSerialPortLike } from "./usbProbe.js";

describe("toCalloutPath", () => {
  it("translates darwin's tty. dial-in path to the cu. callout path", () => {
    expect(toCalloutPath("/dev/tty.usbmodem2121102", "darwin")).toBe("/dev/cu.usbmodem2121102");
  });

  it("leaves a non-tty path alone on darwin", () => {
    expect(toCalloutPath("/dev/cu.usbmodem2121102", "darwin")).toBe("/dev/cu.usbmodem2121102");
  });

  it("is a no-op on a non-darwin platform", () => {
    expect(toCalloutPath("/dev/tty.usbmodem2121102", "linux")).toBe("/dev/tty.usbmodem2121102");
  });
});

describe("filterDaplinkPorts", () => {
  const daplink = { path: "/dev/tty.usbmodem2121102", vendorId: "0d28", productId: "0204", serialNumber: "abc" };
  const other = { path: "/dev/tty.debug-console" };
  const wrongVendor = { path: "/dev/tty.usbmodem9999", vendorId: "1234", productId: "0204" };

  it("keeps only ports matching DAPLink's VID/PID", () => {
    expect(filterDaplinkPorts([daplink, other, wrongVendor])).toEqual([daplink]);
  });

  it("returns an empty array when nothing matches", () => {
    expect(filterDaplinkPorts([other, wrongVendor])).toEqual([]);
  });

  it("is case-insensitive on hex ids the way serialport itself reports them", () => {
    const upper = { path: "/dev/tty.x", vendorId: "0D28", productId: "0204" };
    expect(filterDaplinkPorts([upper])).toEqual([upper]);
  });
});

/** A fully synthetic {@link UsbSerialPortLike} driven by a scripted
 * exchange, so `probeUsb` is testable against captured byte sequences
 * with no real serial port. */
class FakeSerialPort extends EventEmitter implements UsbSerialPortLike {
  public written: string[] = [];
  public breakEvents: boolean[] = [];
  constructor(
    private readonly onWrite: (line: string, port: FakeSerialPort) => void,
    private readonly setError?: Error,
  ) {
    super();
  }
  once(event: "open" | "error", listener: (...args: never[]) => void): this {
    return super.once(event, listener as (...args: unknown[]) => void);
  }
  on(event: "data", listener: (chunk: Buffer) => void): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }
  write(data: string): boolean {
    this.written.push(data);
    this.onWrite(data.trim(), this);
    return true;
  }
  set(options: { brk?: boolean }, callback?: (err?: Error | null) => void): void {
    this.breakEvents.push(options.brk === true);
    process.nextTick(() => callback?.(this.setError ?? null));
  }
  close(callback?: (err?: Error | null) => void): void {
    callback?.(null);
  }
  emitOpenNextTick(): void {
    process.nextTick(() => this.emit("open"));
  }
  reply(line: string): void {
    this.emit("data", Buffer.from(`${line}\n`, "utf8"));
  }
}

/** Instant, non-sleeping stand-in for `probeUsb`'s real `delay` option —
 * every break-reset retry test uses this so the suite never actually
 * waits `postBreakWaitMs`. */
const instantDelay = () => Promise.resolve();

describe("probeUsb", () => {
  it("passes a robot round trip: HELLO banner then ID reply", async () => {
    let port!: FakeSerialPort;
    const created: FakeSerialPort[] = [];
    const result = await probeUsb(
      { path: "/dev/tty.usbmodem2121402", serialNumber: "board-1" },
      {
        platform: "darwin",
        createPort: (path, _baud) => {
          port = new FakeSerialPort((line, p) => {
            if (line === "HELLO") {
              p.reply("device NEZHA2 robot vitut 1234567890");
            } else if (line === "ID") {
              p.reply("id diffdrive tovez 1.20260912.8 vitut");
            }
          });
          created.push(port);
          port.emitOpenNextTick();
          return port;
        },
      },
    );
    expect(created).toHaveLength(1);
    expect(result.status).toBe("pass");
    expect(result.path).toBe("usb");
    expect(result.endpoint).toEqual({ serialPath: "/dev/cu.usbmodem2121402" });
    expect(result.transcript.map((l) => l.line)).toEqual([
      "HELLO",
      "device NEZHA2 robot vitut 1234567890",
      "ID",
      "id diffdrive tovez 1.20260912.8 vitut",
    ]);
  });

  it("probes a relay banner with '?' instead of ID", async () => {
    const result = await probeUsb(
      { path: "/dev/tty.usbmodem2121502" },
      {
        platform: "darwin",
        createPort: (_path, _baud) => {
          const port = new FakeSerialPort((line, p) => {
            if (line === "HELLO") {
              p.reply("DEVICE:RADIOBRIDGE:relay:gozop:4267970133");
            } else if (line === "?") {
              p.reply("# channel: 0 group: 10 mode: RAW250 power: 7");
            }
          });
          port.emitOpenNextTick();
          return port;
        },
      },
    );
    expect(result.status).toBe("pass");
    expect(result.reason).toContain("relay banner");
    expect(result.transcript.map((l) => l.line)).toContain("?");
  });

  it("fails after a break-reset retry when no banner ever arrives, even after the reset", async () => {
    let port!: FakeSerialPort;
    const result = await probeUsb(
      { path: "/dev/tty.usbmodemDEAD" },
      {
        helloTimeoutMs: 20,
        idTimeoutMs: 20,
        postBreakWaitMs: 5,
        delay: instantDelay,
        platform: "darwin",
        createPort: () => {
          port = new FakeSerialPort(() => {
            // never replies, to either the initial HELLO or the retry
          });
          port.emitOpenNextTick();
          return port;
        },
      },
    );
    expect(result.status).toBe("fail");
    expect(result.reason).toContain("no banner");
    expect(result.reason).toContain("break-reset");
    // exactly one break-reset attempt: brk true then false, no more
    expect(port.breakEvents).toEqual([true, false]);
    // two HELLO attempts (initial + one retry), captured as separate
    // transcript segments bracketed by "info" markers
    expect(result.transcript.filter((l) => l.line === "HELLO")).toHaveLength(2);
    expect(result.transcript.some((l) => l.dir === "info" && l.line.includes("break-reset"))).toBe(true);
  });

  it("recovers via break-reset retry: relay banner arrives only after the reset", async () => {
    let helloCount = 0;
    let port!: FakeSerialPort;
    const result = await probeUsb(
      { path: "/dev/tty.usbmodem2121402" },
      {
        helloTimeoutMs: 20,
        idTimeoutMs: 1000,
        postBreakWaitMs: 5,
        delay: instantDelay,
        platform: "darwin",
        createPort: () => {
          port = new FakeSerialPort((line, p) => {
            if (line === "HELLO") {
              helloCount += 1;
              // Parked in the data plane on the first HELLO -- no reply
              // at all until after the break-reset.
              if (helloCount > 1) {
                p.reply("DEVICE:RADIOBRIDGE:relay:vitut:2198604104");
              }
            } else if (line === "?") {
              p.reply("# channel: 47 group: 60 mode: RAW250 power: 7");
            }
          });
          port.emitOpenNextTick();
          return port;
        },
      },
    );
    expect(result.status).toBe("pass");
    expect(result.reason).toContain("recovered after one break-reset retry");
    expect(result.reason).toContain("relay banner");
    expect(port.breakEvents).toEqual([true, false]);
    expect(helloCount).toBe(2);
    expect(result.transcript.map((l) => l.line)).toContain("?");
  });

  it("reports a break-reset failure distinctly from a plain timeout", async () => {
    const result = await probeUsb(
      { path: "/dev/tty.usbmodemDEAD" },
      {
        helloTimeoutMs: 20,
        postBreakWaitMs: 5,
        delay: instantDelay,
        platform: "darwin",
        createPort: () => {
          const port = new FakeSerialPort(
            () => {
              // never replies
            },
            new Error("break-reset: port closed"),
          );
          port.emitOpenNextTick();
          return port;
        },
      },
    );
    expect(result.status).toBe("fail");
    expect(result.reason).toContain("break-reset failed");
    expect(result.reason).toContain("port closed");
  });

  it("fails with the open error's message when the port cannot be opened", async () => {
    const result = await probeUsb(
      { path: "/dev/tty.usbmodemPERM" },
      {
        platform: "darwin",
        createPort: () => {
          const port = new FakeSerialPort(() => {});
          process.nextTick(() => port.emit("error", new Error("Permission denied")));
          return port;
        },
      },
    );
    expect(result.status).toBe("fail");
    expect(result.reason).toContain("Permission denied");
  });
});
