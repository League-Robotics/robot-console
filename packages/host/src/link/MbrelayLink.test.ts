import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { MbrelayLink } from "./MbrelayLink.js";
import type { TcpSocketLike } from "./MbrelayLink.js";
import type { Scheduler } from "./pacing.js";

// Mirrors `RelayRadioLink.test.ts`'s own structure and fake
// `SerialPortLike`, with a fake TCP socket substituted -- per the
// ticket's own Testing section ("parametrize or duplicate ticket 002's
// test suite against this fake, whichever keeps the two test files most
// readable"; duplicating chosen here, matching the existing
// `RelayRadioLink.test.ts`/`UsbSerialLink.test.ts` precedent of one
// self-contained fake-driven test file per transport). Real relay-to-
// robot bridging over actual hardware, and any actual `TCP_NODELAY`
// latency measurement, are explicitly hardware-deferred to sprint 8's
// bench ticket (this ticket's own assignment) -- everything here runs
// against a fully synthetic fake TCP socket and a fake scheduler, no
// real network.

const HOST = "192.0.2.10";
const PORT = 4747;
const CHANNEL = 37;
const GROUP = 3;
const CG_CONFIRM_LINE = `# channel: ${CHANNEL} group: ${GROUP} mode: RAW250 power: 7`;
const GO_CONFIRM_LINE = "# go ok";

/** A fully synthetic stand-in for `net.Socket` -- same discipline as
 * `RelayRadioLink.test.ts`'s `FakeSerialPort`. Records every call this
 * ticket's acceptance criteria need to assert against, including
 * `setNoDelay` and each call's position in a single combined `calls`
 * timeline so call-order (setNoDelay before any write) is directly
 * provable. */
class FakeSocket extends EventEmitter implements TcpSocketLike {
  writes: string[] = [];
  noDelayCalls: Array<boolean | undefined> = [];
  endCalls = 0;
  /** Combined call-order timeline -- `"setNoDelay"` or `"write:<data>"`
   * entries, in the order the link made them. */
  calls: string[] = [];

  write(data: string, callback?: (err?: Error | null) => void): boolean {
    this.writes.push(data);
    this.calls.push(`write:${data}`);
    callback?.(null);
    return true;
  }

  setNoDelay(noDelay?: boolean): void {
    this.noDelayCalls.push(noDelay);
    this.calls.push("setNoDelay");
  }

  end(callback?: () => void): void {
    this.endCalls++;
    callback?.();
    this.emit("close");
  }
}

/** A scheduler that resolves `delay()` immediately (on a microtask),
 * recording every call -- same technique as `RelayRadioLink.test.ts`'s
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

/** A scheduler whose `delay()` never resolves on its own -- see
 * `RelayRadioLink.test.ts`'s own `controllableScheduler` doc comment for
 * why this exists and why every "success" test below uses it by default
 * for `handshakeScheduler` specifically. */
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

function newLink(overrides: {
  paceMs?: number;
  scheduler?: Scheduler;
  openTimeoutMs?: number;
  handshakeTimeoutMs?: number;
  handshakeScheduler?: Scheduler & { resolveAll: () => void };
  channel?: number;
  group?: number;
} = {}): {
  link: MbrelayLink;
  socket: FakeSocket;
  connectPromise: Promise<void>;
  handshakeScheduler: Scheduler & { resolveAll: () => void };
} {
  const socket = new FakeSocket();
  const handshakeScheduler = overrides.handshakeScheduler ?? controllableScheduler();
  const link = new MbrelayLink(HOST, PORT, overrides.channel ?? CHANNEL, overrides.group ?? GROUP, {
    createSocket: () => socket,
    writePaceMs: overrides.paceMs ?? 10,
    scheduler: overrides.scheduler ?? immediateScheduler,
    openTimeoutMs: overrides.openTimeoutMs ?? 200,
    handshakeTimeoutMs: overrides.handshakeTimeoutMs ?? 200,
    handshakeScheduler,
  });
  const connectPromise = link.connect();
  socket.emit("connect");
  return { link, socket, connectPromise, handshakeScheduler };
}

/** Drive a link through the full successful handshake (socket connect,
 * then `!ECHO OFF`/`!MODE RAW250`/`!CG`/`!P 7`/`!GO`, confirming `!CG`
 * and `!GO`) and await `connect()`. */
async function handshakedLink(
  overrides: Parameters<typeof newLink>[0] = {},
): Promise<{ link: MbrelayLink; socket: FakeSocket }> {
  const { link, socket, connectPromise } = newLink(overrides);
  await flush();
  socket.emit("data", Buffer.from(`${CG_CONFIRM_LINE}\n`));
  await flush();
  socket.emit("data", Buffer.from(`${GO_CONFIRM_LINE}\n`));
  await connectPromise;
  return { link, socket };
}

/** `connect()` (full handshake) then `identify()`, emitting `bannerLine`
 * as the HELLO reply once the HELLO write has gone out. */
async function identifiedLink(
  bannerLine: string,
  overrides: Parameters<typeof newLink>[0] = {},
): Promise<{ link: MbrelayLink; socket: FakeSocket }> {
  const { link, socket } = await handshakedLink(overrides);
  const identifyPromise = link.identify();
  await flush();
  socket.emit("data", Buffer.from(`${bannerLine}\n`));
  await identifyPromise;
  return { link, socket };
}

// ---------------------------------------------------------------------
// MbrelayLink.connect() -- TCP connect, TCP_NODELAY, then the same
// command-plane handshake RelayRadioLink runs (SUC-004)
// ---------------------------------------------------------------------

describe("MbrelayLink.connect", () => {
  it("opens a TCP socket to the given host/port", () => {
    let requestedHost: string | undefined;
    let requestedPort: number | undefined;
    const socket = new FakeSocket();
    const link = new MbrelayLink(HOST, PORT, CHANNEL, GROUP, {
      createSocket: (host, port) => {
        requestedHost = host;
        requestedPort = port;
        return socket;
      },
    });
    void link.connect().catch(() => {});
    expect(requestedHost).toBe(HOST);
    expect(requestedPort).toBe(PORT);
  });

  it("sets TCP_NODELAY immediately after connect, before any write", async () => {
    const { socket, connectPromise } = newLink();
    await flush();
    expect(socket.noDelayCalls).toEqual([true]);
    // setNoDelay must precede every write the handshake makes -- assert
    // call order directly against the fake's combined timeline.
    const noDelayIndex = socket.calls.indexOf("setNoDelay");
    const firstWriteIndex = socket.calls.findIndex((call) => call.startsWith("write:"));
    expect(noDelayIndex).toBe(0);
    expect(firstWriteIndex).toBeGreaterThan(noDelayIndex);

    socket.emit("data", Buffer.from(`${CG_CONFIRM_LINE}\n`));
    await flush();
    socket.emit("data", Buffer.from(`${GO_CONFIRM_LINE}\n`));
    await connectPromise;
  });

  it("opens the socket then sends the full preamble in order, resolving once !GO confirms", async () => {
    const { socket } = await handshakedLink();
    expect(socket.writes).toEqual([
      "!ECHO OFF\n",
      "!MODE RAW250\n",
      `!CG ${CHANNEL} ${GROUP}\n`,
      "!P 7\n",
      "!GO\n",
    ]);
  });

  it("is not isOpen while the handshake is still in progress, only once it completes", async () => {
    const { link, socket, connectPromise } = newLink();
    expect(link.isOpen).toBe(false);
    await flush();
    expect(link.isOpen).toBe(false); // preamble sent, but !CG/!GO not yet confirmed

    socket.emit("data", Buffer.from(`${CG_CONFIRM_LINE}\n`));
    await flush();
    expect(link.isOpen).toBe(false); // !CG confirmed, !GO not yet

    socket.emit("data", Buffer.from(`${GO_CONFIRM_LINE}\n`));
    await connectPromise;
    expect(link.isOpen).toBe(true);
  });

  it("rejects with a diagnosable message if the socket errors before connecting (unreachable/refused)", async () => {
    const socket = new FakeSocket();
    const link = new MbrelayLink(HOST, PORT, CHANNEL, GROUP, { createSocket: () => socket });
    const connectPromise = link.connect();
    socket.emit("error", new Error("ECONNREFUSED"));
    await expect(connectPromise).rejects.toThrow(/could not reach mbrelay/i);
    await expect(connectPromise).rejects.toThrow(/ECONNREFUSED/);
    expect(socket.writes).toEqual([]);
  });

  it("refuses to be connected a second time", async () => {
    const { link } = await handshakedLink();
    await expect(link.connect()).rejects.toThrow(/already|once|"connect"|connected/i);
  });

  // ---- handshake failure: !CG rejection (SUC-003, shared runner) -----

  it("rejects connect() when the relay rejects !CG, closes the socket, and never sends !GO", async () => {
    const { socket, connectPromise } = newLink();
    await flush();
    expect(socket.writes).toEqual(["!ECHO OFF\n", "!MODE RAW250\n", `!CG ${CHANNEL} ${GROUP}\n`]);

    socket.emit("data", Buffer.from("NAK\n"));

    await expect(connectPromise).rejects.toThrow(/handshake failed/i);
    expect(socket.writes).not.toContain("!GO\n");
    expect(socket.endCalls).toBe(1);
  });

  it("never reaches isOpen after a !CG rejection -- no partial connected state", async () => {
    const { link, socket, connectPromise } = newLink();
    await flush();
    socket.emit("data", Buffer.from("NAK\n"));
    await expect(connectPromise).rejects.toThrow();
    expect(link.isOpen).toBe(false);
  });

  // ---- handshake failure: !GO timeout (SUC-003, shared runner) -------

  it("rejects connect() if !GO never confirms, under a fake handshake scheduler (no real wall-clock delay)", async () => {
    const { socket, connectPromise, handshakeScheduler } = newLink();
    await flush();
    socket.emit("data", Buffer.from(`${CG_CONFIRM_LINE}\n`));
    await flush();
    expect(socket.writes).toEqual([
      "!ECHO OFF\n",
      "!MODE RAW250\n",
      `!CG ${CHANNEL} ${GROUP}\n`,
      "!P 7\n",
      "!GO\n",
    ]);

    handshakeScheduler.resolveAll();

    await expect(connectPromise).rejects.toThrow(/handshake failed/i);
    expect(socket.endCalls).toBe(1);
  });
});

// ---------------------------------------------------------------------
// MbrelayLink.identify() -- identical contract to RelayRadioLink's, once
// the data plane is reached
// ---------------------------------------------------------------------

describe("MbrelayLink.identify", () => {
  it("sends HELLO (paced) and resolves with the banner parsed from its reply", async () => {
    const { link, socket } = await identifiedLink("DEVICE:RADIOBRIDGE:relay:getez:1779042496");

    expect(socket.writes.slice(-1)).toEqual(["HELLO\n"]);
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
    const { link, socket } = await handshakedLink({ openTimeoutMs: 20 });
    socket.writes.length = 0;
    const banner = await link.identify();
    expect(banner).toBeNull();
    expect(link.isOpen).toBe(true); // the transport itself is untouched
  });

  it("throws if called before connect() has succeeded", async () => {
    const socket = new FakeSocket();
    const link = new MbrelayLink(HOST, PORT, CHANNEL, GROUP, { createSocket: () => socket });
    await expect(link.identify()).rejects.toThrow(/not connected|connect\(\)/i);
  });

  it("ignores relay/handshake-shaped noise arriving before the actual banner", async () => {
    const { link, socket } = await handshakedLink();
    const identifyPromise = link.identify();
    await flush();
    socket.emit("data", Buffer.from("not a banner\n"));
    socket.emit("data", Buffer.from("DEVICE:RADIOBRIDGE:relay:getez:1779042496\n"));
    const banner = await identifyPromise;
    expect(banner?.name).toBe("getez");
  });
});

// ---------------------------------------------------------------------
// Write pacing -- every write, handshake included, goes through the pacer
// ---------------------------------------------------------------------

describe("MbrelayLink write pacing", () => {
  it("paces every write, including the handshake lines and HELLO", async () => {
    const scheduler = recordingScheduler();
    const { socket } = await identifiedLink("DEVICE:RADIOBRIDGE:relay:getez:1779042496", {
      paceMs: 10,
      scheduler,
    });

    expect(socket.writes).toEqual([
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
// WritePacer composition RelayRadioLink/UsbSerialLink use -- no
// duplicated logic here
// ---------------------------------------------------------------------

describe("MbrelayLink sequencing", () => {
  async function openedRobotLink() {
    const { link, socket } = await identifiedLink("device NEZHA2 robot vevov 1198504156");
    socket.writes.length = 0; // drop the recorded handshake + HELLO writes
    return { link, socket };
  }

  it("sends id-bearing commands sequenced via Session.send()", async () => {
    const { link, socket } = await openedRobotLink();
    const line = link.sendCommand("STOP");
    await flush();
    expect(line).toBe("STOP #1\n");
    expect(socket.writes).toEqual(["STOP #1\n"]);
    expect(link.session.pendingCount).toBe(1);
  });

  it("updates session state and fires onAckNack when an ack reply arrives", async () => {
    const { link, socket } = await openedRobotLink();
    link.sendCommand("STOP");
    await flush();

    const events: unknown[] = [];
    link.onAckNack((e) => events.push(e));

    socket.emit("data", Buffer.from("ack 1 1 ok\n"));
    await flush();

    expect(link.session.seq).toBe(1);
    expect(link.session.pendingCount).toBe(0);
    expect(events).toHaveLength(1);
  });

  it("resends the correct pending line, through the paced write path, on nack", async () => {
    const { link, socket } = await openedRobotLink();
    link.sendCommand("STOP"); // id 1
    await flush();
    socket.writes.length = 0;

    socket.emit("data", Buffer.from("nack 1 0 none\n"));
    await flush();

    expect(socket.writes).toEqual(["STOP #1\n"]);
  });

  it("never sends HELLO again through sendUnsequenced -- it refuses it", async () => {
    const { link } = await openedRobotLink();
    expect(() => link.sendUnsequenced("HELLO")).toThrow(/HELLO/);
  });

  it("checkLiveness sends PING, never HELLO (SUC-006)", async () => {
    const { link, socket } = await openedRobotLink();
    link.checkLiveness();
    await flush();
    expect(socket.writes).toEqual(["PING\n"]);
  });
});

// ---------------------------------------------------------------------
// Foreign-traffic drop, once connected (identical contract to
// RelayRadioLink/UsbSerialLink)
// ---------------------------------------------------------------------

describe("MbrelayLink foreign traffic", () => {
  it("drops a lowercase line that is not a recognized reply verb, silently", async () => {
    const { link, socket } = await identifiedLink("DEVICE:RADIOBRIDGE:relay:getez:1779042496");

    const lines: unknown[] = [];
    const errors: unknown[] = [];
    link.onLine((l) => lines.push(l));
    link.onError((e) => errors.push(e));

    expect(() => {
      socket.emit("data", Buffer.from("beep boop overheard\n"));
    }).not.toThrow();
    await flush();

    expect(lines).toEqual([]);
    expect(errors).toEqual([]);
  });

  it("still delivers a recognized lowercase reply verb to onLine", async () => {
    const { link, socket } = await identifiedLink("DEVICE:RADIOBRIDGE:relay:getez:1779042496");

    const lines: Array<{ verb: string }> = [];
    link.onLine((l) => lines.push(l));

    socket.emit("data", Buffer.from("pong\n"));
    await flush();

    expect(lines).toEqual([{ kind: "line", verb: "pong", fields: [] }]);
  });
});

// ---------------------------------------------------------------------
// Calling send*/checkLiveness before connect()
// ---------------------------------------------------------------------

describe("MbrelayLink guards against use before connect", () => {
  it("sendLine throws before connect()", () => {
    const socket = new FakeSocket();
    const link = new MbrelayLink(HOST, PORT, CHANNEL, GROUP, { createSocket: () => socket });
    expect(() => link.sendLine("STATUS")).toThrow(/not connected/i);
  });

  it("checkLiveness throws before connect()", () => {
    const socket = new FakeSocket();
    const link = new MbrelayLink(HOST, PORT, CHANNEL, GROUP, { createSocket: () => socket });
    expect(() => link.checkLiveness()).toThrow(/not connected/i);
  });
});
