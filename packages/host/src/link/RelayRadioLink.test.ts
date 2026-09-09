import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { RelayRadioLink } from "./RelayRadioLink.js";
import type { SerialPortLike } from "./UsbSerialLink.js";
import type { Scheduler } from "./pacing.js";
import { toCalloutPath } from "../devices.js";

// Mirrors `UsbSerialLink.test.ts`'s own structure and fake
// `SerialPortLike`, extended with the command-plane handshake step, per
// the ticket's own Testing section. Real relay-to-robot bridging over
// actual hardware is explicitly hardware-deferred to sprint 8's bench
// ticket (this ticket's assignment) -- everything here runs against a
// fully synthetic fake serial port and a fake scheduler.

const CHANNEL = 37;
const GROUP = 3;
const CG_CONFIRM_LINE = `# channel: ${CHANNEL} group: ${GROUP} mode: RAW250 power: 7`;
const GO_CONFIRM_LINE = "# go ok";

/** A fully synthetic stand-in for `serialport`'s `SerialPort` -- same
 * fake `UsbSerialLink.test.ts` uses. */
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

/** A scheduler that resolves `delay()` immediately (on a microtask),
 * recording every call -- same technique as `UsbSerialLink.test.ts`'s
 * `recordingScheduler`. */
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

const immediateScheduler: Scheduler = { delay: () => Promise.resolve() };

/** A scheduler whose `delay()` never resolves on its own -- a test
 * drives the handshake timeout deterministically via {@link
 * resolveAll}, with no real wall-clock wait. Used only for the
 * handshake-timeout tests below; every other test uses {@link
 * immediateScheduler} for both pacing and the handshake wait. */
function controllableScheduler(): Scheduler & { resolveAll: () => void } {
  const resolvers: Array<() => void> = [];
  return {
    delay: (_ms: number) =>
      new Promise<void>((resolve) => {
        resolvers.push(resolve);
      }),
    resolveAll: () => {
      const pending = resolvers.splice(0, resolvers.length);
      for (const resolve of pending) {
        resolve();
      }
    },
  };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Every test below that expects a successful handshake defaults
 * `handshakeScheduler` to a fresh {@link controllableScheduler} that is
 * never resolved unless a test explicitly calls `resolveAll()` on it --
 * this is deliberate, not an oversight: the write-pacing `scheduler`
 * (`immediateScheduler`) resolves its own `delay()` calls on the very
 * next microtask, which would otherwise race ahead of (and beat) a
 * confirmation line this test emits after an `await flush()` macrotask
 * boundary. Keeping the handshake's own timeout scheduler separate and
 * silent-by-default means the confirmation-line branch always wins in a
 * "success" test, deterministically, with no timing race -- only a test
 * that explicitly calls `resolveAll()` (the !CG/!GO-timeout tests) ever
 * exercises the timeout branch at all.
 */
function newLink(overrides: {
  paceMs?: number;
  scheduler?: Scheduler;
  openTimeoutMs?: number;
  handshakeTimeoutMs?: number;
  handshakeScheduler?: Scheduler & { resolveAll: () => void };
  channel?: number;
  group?: number;
} = {}): {
  link: RelayRadioLink;
  port: FakeSerialPort;
  connectPromise: Promise<void>;
  handshakeScheduler: Scheduler & { resolveAll: () => void };
} {
  const port = new FakeSerialPort();
  const handshakeScheduler = overrides.handshakeScheduler ?? controllableScheduler();
  const link = new RelayRadioLink(
    "/dev/tty.usbmodemFAKE",
    overrides.channel ?? CHANNEL,
    overrides.group ?? GROUP,
    {
      createPort: () => port,
      writePaceMs: overrides.paceMs ?? 10,
      scheduler: overrides.scheduler ?? immediateScheduler,
      openTimeoutMs: overrides.openTimeoutMs ?? 200,
      handshakeTimeoutMs: overrides.handshakeTimeoutMs ?? 200,
      handshakeScheduler,
    },
  );
  const connectPromise = link.connect();
  port.emit("open");
  return { link, port, connectPromise, handshakeScheduler };
}

/** Drive a link through the full successful handshake (port open, then
 * `!ECHO OFF`/`!MODE RAW250`/`!CG`/`!P 7`/`!GO`, confirming `!CG` and
 * `!GO`) and await `connect()`. */
async function handshakedLink(
  overrides: Parameters<typeof newLink>[0] = {},
): Promise<{ link: RelayRadioLink; port: FakeSerialPort }> {
  const { link, port, connectPromise } = newLink(overrides);
  await flush();
  port.emit("data", Buffer.from(`${CG_CONFIRM_LINE}\n`));
  await flush();
  port.emit("data", Buffer.from(`${GO_CONFIRM_LINE}\n`));
  await connectPromise;
  return { link, port };
}

/** `connect()` (full handshake) then `identify()`, emitting `bannerLine`
 * as the HELLO reply once the HELLO write has gone out. */
async function identifiedLink(
  bannerLine: string,
  overrides: Parameters<typeof newLink>[0] = {},
): Promise<{ link: RelayRadioLink; port: FakeSerialPort }> {
  const { link, port } = await handshakedLink(overrides);
  const identifyPromise = link.identify();
  await flush();
  port.emit("data", Buffer.from(`${bannerLine}\n`));
  await identifyPromise;
  return { link, port };
}

// ---------------------------------------------------------------------
// RelayRadioLink.connect() -- port open, then the command-plane handshake
// ---------------------------------------------------------------------

describe("RelayRadioLink.connect", () => {
  it("opens the port then sends the full preamble in order, resolving once !GO confirms", async () => {
    const { port } = await handshakedLink();
    expect(port.writes).toEqual([
      "!ECHO OFF\n",
      "!MODE RAW250\n",
      `!CG ${CHANNEL} ${GROUP}\n`,
      "!P 7\n",
      "!GO\n",
    ]);
  });

  it("is not isOpen while the handshake is still in progress, only once it completes", async () => {
    const { link, port, connectPromise } = newLink();
    expect(link.isOpen).toBe(false);
    await flush();
    expect(link.isOpen).toBe(false); // preamble sent, but !CG/!GO not yet confirmed

    port.emit("data", Buffer.from(`${CG_CONFIRM_LINE}\n`));
    await flush();
    expect(link.isOpen).toBe(false); // !CG confirmed, !GO not yet

    port.emit("data", Buffer.from(`${GO_CONFIRM_LINE}\n`));
    await connectPromise;
    expect(link.isOpen).toBe(true);
  });

  it("translates the tty. path to cu. on darwin when connecting", () => {
    let requestedPath: string | undefined;
    const port = new FakeSerialPort();
    const link = new RelayRadioLink("/dev/tty.usbmodem2121102", CHANNEL, GROUP, {
      createPort: (path) => {
        requestedPath = path;
        return port;
      },
    });
    void link.connect().catch(() => {});
    expect(requestedPath).toBe(toCalloutPath("/dev/tty.usbmodem2121102", "darwin"));
  });

  it("rejects if the port errors before opening, without attempting a handshake", async () => {
    const port = new FakeSerialPort();
    const link = new RelayRadioLink("/dev/tty.usbmodemFAKE", CHANNEL, GROUP, {
      createPort: () => port,
    });
    const connectPromise = link.connect();
    port.emit("error", new Error("permission denied"));
    await expect(connectPromise).rejects.toThrow(/permission denied/);
    expect(port.writes).toEqual([]);
  });

  it("refuses to be connected a second time", async () => {
    const { link } = await handshakedLink();
    await expect(link.connect()).rejects.toThrow(/already|once|"connect"|connected/i);
  });

  // ---- handshake failure: !CG rejection (SUC-003) --------------------

  it("rejects connect() when the relay rejects !CG, closes the port, and never sends !GO", async () => {
    const { port, connectPromise } = newLink();
    await flush();
    expect(port.writes).toEqual(["!ECHO OFF\n", "!MODE RAW250\n", `!CG ${CHANNEL} ${GROUP}\n`]);

    port.emit("data", Buffer.from("NAK\n"));

    await expect(connectPromise).rejects.toThrow(/handshake failed/i);
    expect(port.writes).not.toContain("!GO\n");
    expect(port.closeCalls).toBe(1);
  });

  it("never reaches isOpen after a !CG rejection -- no partial connected state", async () => {
    const { link, port, connectPromise } = newLink();
    await flush();
    port.emit("data", Buffer.from("NAK\n"));
    await expect(connectPromise).rejects.toThrow();
    expect(link.isOpen).toBe(false);
  });

  // ---- handshake failure: !GO timeout (SUC-003) -----------------------

  it("rejects connect() if !GO never confirms, under a fake handshake scheduler (no real wall-clock delay)", async () => {
    const { port, connectPromise, handshakeScheduler } = newLink();
    await flush();
    port.emit("data", Buffer.from(`${CG_CONFIRM_LINE}\n`));
    await flush();
    expect(port.writes).toEqual([
      "!ECHO OFF\n",
      "!MODE RAW250\n",
      `!CG ${CHANNEL} ${GROUP}\n`,
      "!P 7\n",
      "!GO\n",
    ]);

    handshakeScheduler.resolveAll();

    await expect(connectPromise).rejects.toThrow(/handshake failed/i);
    expect(port.closeCalls).toBe(1);
  });
});

// ---------------------------------------------------------------------
// RelayRadioLink.identify() -- identical contract to UsbSerialLink's,
// once the data plane is reached
// ---------------------------------------------------------------------

describe("RelayRadioLink.identify", () => {
  it("sends HELLO (paced) and resolves with the banner parsed from its reply", async () => {
    const { link, port } = await identifiedLink("DEVICE:RADIOBRIDGE:relay:getez:1779042496");

    expect(port.writes.slice(-1)).toEqual(["HELLO\n"]);
    expect(link.banner).toEqual({
      role: "RADIOBRIDGE",
      commonName: "relay",
      name: "getez",
      serial: 1779042496,
      dialect: "colon",
      raw: "DEVICE:RADIOBRIDGE:relay:getez:1779042496",
    });
  });

  it("resolves with the banner parsed from a space-dialect robot reply", async () => {
    const { link } = await identifiedLink("device NEZHA2 robot vevov 1198504156");
    expect(link.role).toBe("NEZHA2");
    expect(link.name).toBe("vevov");
  });

  it("resolves null (never rejects) if no banner arrives within openTimeoutMs", async () => {
    const { link, port } = await handshakedLink({ openTimeoutMs: 20 });
    port.writes.length = 0;
    const banner = await link.identify();
    expect(banner).toBeNull();
    expect(link.isOpen).toBe(true); // the transport itself is untouched
  });

  it("throws if called before connect() has succeeded", async () => {
    const port = new FakeSerialPort();
    const link = new RelayRadioLink("/dev/tty.usbmodemFAKE", CHANNEL, GROUP, { createPort: () => port });
    await expect(link.identify()).rejects.toThrow(/not connected|connect\(\)/i);
  });

  it("ignores relay/handshake-shaped noise arriving before the actual banner", async () => {
    const { link, port } = await handshakedLink();
    const identifyPromise = link.identify();
    await flush();
    port.emit("data", Buffer.from("not a banner\n"));
    port.emit("data", Buffer.from("DEVICE:RADIOBRIDGE:relay:getez:1779042496\n"));
    const banner = await identifyPromise;
    expect(banner?.name).toBe("getez");
  });
});

// ---------------------------------------------------------------------
// Write pacing -- every write, handshake included, goes through the pacer
// ---------------------------------------------------------------------

describe("RelayRadioLink write pacing", () => {
  it("paces every write, including the handshake lines and HELLO", async () => {
    const scheduler = recordingScheduler();
    const { port } = await identifiedLink("DEVICE:RADIOBRIDGE:relay:getez:1779042496", {
      paceMs: 10,
      scheduler,
    });

    expect(port.writes).toEqual([
      "!ECHO OFF\n",
      "!MODE RAW250\n",
      `!CG ${CHANNEL} ${GROUP}\n`,
      "!P 7\n",
      "!GO\n",
      "HELLO\n",
    ]);
    expect(scheduler.calls).toEqual([10, 10, 10, 10, 10, 10]);
  });
});

// ---------------------------------------------------------------------
// Sequencing / ack-nack wiring, delegated to the same Session/LineRouter/
// WritePacer composition UsbSerialLink uses -- no duplicated logic here
// ---------------------------------------------------------------------

describe("RelayRadioLink sequencing", () => {
  async function openedRobotLink() {
    const { link, port } = await identifiedLink("device NEZHA2 robot vevov 1198504156");
    port.writes.length = 0; // drop the recorded handshake + HELLO writes
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

  it("never sends HELLO again through sendUnsequenced -- it refuses it", async () => {
    const { link } = await openedRobotLink();
    expect(() => link.sendUnsequenced("HELLO")).toThrow(/HELLO/);
  });

  it("checkLiveness sends PING, never HELLO", async () => {
    const { link, port } = await openedRobotLink();
    link.checkLiveness();
    await flush();
    expect(port.writes).toEqual(["PING\n"]);
  });
});

// ---------------------------------------------------------------------
// Foreign-traffic drop, once connected (identical contract to UsbSerialLink)
// ---------------------------------------------------------------------

describe("RelayRadioLink foreign traffic", () => {
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
});

// ---------------------------------------------------------------------
// Calling send*/checkLiveness before connect()
// ---------------------------------------------------------------------

describe("RelayRadioLink guards against use before connect", () => {
  it("sendLine throws before connect()", () => {
    const port = new FakeSerialPort();
    const link = new RelayRadioLink("/dev/tty.usbmodemFAKE", CHANNEL, GROUP, { createPort: () => port });
    expect(() => link.sendLine("STATUS")).toThrow(/not connected/i);
  });

  it("checkLiveness throws before connect()", () => {
    const port = new FakeSerialPort();
    const link = new RelayRadioLink("/dev/tty.usbmodemFAKE", CHANNEL, GROUP, { createPort: () => port });
    expect(() => link.checkLiveness()).toThrow(/not connected/i);
  });
});
