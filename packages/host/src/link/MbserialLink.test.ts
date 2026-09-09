import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MbserialLink, type TcpSocketLike } from "./MbserialLink.js";
import type { Scheduler } from "./pacing.js";

// Mirrors `UsbSerialLink.test.ts`'s own structure exactly (per the
// ticket's own Description: "the structurally smallest of the three new
// transports... composes lineStream.ts/pacing.ts/LineRouter.ts exactly
// as UsbSerialLink does"), with a fake TCP socket (`FakeSocket`, in the
// style of `MbrelayLink.test.ts`'s own fake) substituted for the fake
// serial port. There is no command-plane handshake to drive here at
// all -- connect() resolves as soon as the fake socket "connect"s, with
// no preamble step in between, which is exactly what the "connect()
// then identify()" tests below assert.

const HOST = "192.0.2.20";
const PORT = 8123;

/** A fully synthetic stand-in for `net.Socket` -- same discipline as
 * `MbrelayLink.test.ts`'s `FakeSocket`, minus `setNoDelay`: this
 * transport never calls it (see `MbserialLink.ts`'s own doc comment for
 * why `TCP_NODELAY` is deliberately left unset here). */
class FakeSocket extends EventEmitter implements TcpSocketLike {
  writes: string[] = [];
  endCalls = 0;

  write(data: string, callback?: (err?: Error | null) => void): boolean {
    this.writes.push(data);
    callback?.(null);
    return true;
  }

  end(callback?: () => void): void {
    this.endCalls++;
    callback?.();
    this.emit("close");
  }
}

/** A scheduler that resolves `delay()` immediately (on a microtask) but
 * records every call, so pacing behavior is assertable without any real
 * wall-clock waiting. */
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

/** Flush pending microtasks -- see `UsbSerialLink.test.ts`'s own `flush`
 * doc comment for why a macrotask boundary is used instead of a fixed
 * number of `await Promise.resolve()` hops. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

const immediateScheduler: Scheduler = { delay: () => Promise.resolve() };

/** Build a link and drive it through `connect()`, emitting the fake
 * socket's `connect` event so the returned promise settles. No
 * handshake step exists to drive in between -- `connect()` resolves
 * directly off the socket-level `connect` event. */
function connectedLink(overrides: { paceMs?: number; scheduler?: Scheduler; openTimeoutMs?: number } = {}): {
  link: MbserialLink;
  socket: FakeSocket;
  connectPromise: Promise<void>;
} {
  const socket = new FakeSocket();
  const link = new MbserialLink(HOST, PORT, {
    createSocket: () => socket,
    writePaceMs: overrides.paceMs ?? 10,
    scheduler: overrides.scheduler ?? immediateScheduler,
    openTimeoutMs: overrides.openTimeoutMs ?? 200,
  });
  const connectPromise = link.connect();
  socket.emit("connect");
  return { link, socket, connectPromise };
}

/** `connect()` then `identify()`, emitting `bannerLine` as the HELLO
 * reply once the HELLO write has gone out. */
async function identifiedLink(
  bannerLine: string,
  overrides: { paceMs?: number; scheduler?: Scheduler } = {},
): Promise<{ link: MbserialLink; socket: FakeSocket }> {
  const { link, socket, connectPromise } = connectedLink(overrides);
  await connectPromise;
  const identifyPromise = link.identify();
  await flush();
  socket.emit("data", Buffer.from(`${bannerLine}\n`));
  await identifyPromise;
  return { link, socket };
}

// ---------------------------------------------------------------------
// MbserialLink.connect() -- transport-only, no handshake of any kind
// (SUC-005)
// ---------------------------------------------------------------------

describe("MbserialLink.connect", () => {
  it("opens a TCP socket to the given host/port", () => {
    let requestedHost: string | undefined;
    let requestedPort: number | undefined;
    const socket = new FakeSocket();
    const link = new MbserialLink(HOST, PORT, {
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

  it("resolves without sending anything -- no preamble, no handshake step", async () => {
    const { socket, connectPromise } = connectedLink();
    await connectPromise;
    expect(socket.writes).toEqual([]);
  });

  it("rejects with a diagnosable message if the socket errors before connecting (unreachable/refused)", async () => {
    const socket = new FakeSocket();
    const link = new MbserialLink(HOST, PORT, { createSocket: () => socket });
    const connectPromise = link.connect();
    socket.emit("error", new Error("ECONNREFUSED"));
    await expect(connectPromise).rejects.toThrow(/could not reach/i);
    await expect(connectPromise).rejects.toThrow(/ECONNREFUSED/);
    expect(socket.writes).toEqual([]);
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
// MbserialLink.identify() -- HELLO -> banner-from-reply, or null;
// identical contract to UsbSerialLink's (SUC-005)
// ---------------------------------------------------------------------

describe("MbserialLink.identify", () => {
  it("sends HELLO (paced) as the very first thing this class ever writes, and resolves the banner from its reply", async () => {
    const { link, socket } = await identifiedLink("DEVICE:RADIOBRIDGE:relay:getez:1779042496");

    expect(socket.writes).toEqual(["HELLO\n"]);
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

  it("exposes role/name/serial getters once identified", async () => {
    const { link } = await identifiedLink("DEVICE:RADIOBRIDGE:relay:getez:1779042496");
    expect(link.role).toBe("RADIOBRIDGE");
    expect(link.name).toBe("getez");
    expect(link.serial).toBe(1779042496);
  });

  it("ignores noise arriving before the actual banner during the identify wait", async () => {
    const { link, socket, connectPromise } = connectedLink();
    await connectPromise;
    const identifyPromise = link.identify();
    await flush();
    socket.emit("data", Buffer.from("not a banner\n"));
    socket.emit("data", Buffer.from("DEVICE:RADIOBRIDGE:relay:getez:1779042496\n"));
    const banner = await identifyPromise;
    expect(banner?.name).toBe("getez");
  });

  it("resolves null (never rejects) if no banner arrives within openTimeoutMs", async () => {
    const { link, connectPromise } = connectedLink({ openTimeoutMs: 20 });
    await connectPromise;
    const banner = await link.identify();
    expect(banner).toBeNull();
    expect(link.isOpen).toBe(true); // the transport itself is untouched
  });

  it("throws if called before connect() has succeeded", async () => {
    const socket = new FakeSocket();
    const link = new MbserialLink(HOST, PORT, { createSocket: () => socket });
    await expect(link.identify()).rejects.toThrow(/not connected|connect\(\)/i);
  });

  it("calling identify() again after a null resolution re-sends HELLO without re-opening or closing the socket", async () => {
    let createSocketCalls = 0;
    const socket = new FakeSocket();
    const link = new MbserialLink(HOST, PORT, {
      createSocket: () => {
        createSocketCalls++;
        return socket;
      },
      openTimeoutMs: 20,
    });
    const connectPromise = link.connect();
    socket.emit("connect");
    await connectPromise;
    expect(createSocketCalls).toBe(1);

    const first = await link.identify();
    expect(first).toBeNull();

    const identifyPromise = link.identify();
    await flush();
    socket.emit("data", Buffer.from("DEVICE:RADIOBRIDGE:relay:getez:1779042496\n"));
    const second = await identifyPromise;

    expect(second?.name).toBe("getez");
    expect(socket.writes).toEqual(["HELLO\n", "HELLO\n"]);
    expect(createSocketCalls).toBe(1);
  });
});

// ---------------------------------------------------------------------
// Write pacing through the link
// ---------------------------------------------------------------------

describe("MbserialLink write pacing", () => {
  it("paces every write, including the initial HELLO", async () => {
    const scheduler = recordingScheduler();
    const { socket } = await identifiedLink("DEVICE:RADIOBRIDGE:relay:getez:1779042496", { paceMs: 10, scheduler });

    expect(socket.writes).toEqual(["HELLO\n"]);
    expect(scheduler.calls).toEqual([10]);
  });

  it("paces console-sent lines the same way as HELLO", async () => {
    const scheduler = recordingScheduler();
    const { link, socket } = await identifiedLink("DEVICE:RADIOBRIDGE:relay:getez:1779042496", {
      paceMs: 10,
      scheduler,
    });

    link.checkLiveness();
    link.sendUnsequenced("STATUS");
    await flush();

    expect(socket.writes).toEqual(["HELLO\n", "PING\n", "STATUS\n"]);
    expect(scheduler.calls).toEqual([10, 10, 10]);
  });
});

// ---------------------------------------------------------------------
// Sequencing / ack-nack wiring via v6/session.ts, through the link
// ---------------------------------------------------------------------

describe("MbserialLink sequencing", () => {
  async function openedRobotLink() {
    const { link, socket } = await identifiedLink("device NEZHA2 robot vevov 1198504156");
    socket.writes.length = 0; // drop the recorded HELLO write
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

  it("checkLiveness sends PING, never HELLO", async () => {
    const { link, socket } = await openedRobotLink();
    link.checkLiveness();
    await flush();
    expect(socket.writes).toEqual(["PING\n"]);
  });
});

// ---------------------------------------------------------------------
// Foreign-traffic drop, once connected (identical contract to
// UsbSerialLink/MbrelayLink)
// ---------------------------------------------------------------------

describe("MbserialLink foreign traffic", () => {
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

describe("MbserialLink guards against use before connect", () => {
  it("sendLine throws before connect()", () => {
    const socket = new FakeSocket();
    const link = new MbserialLink(HOST, PORT, { createSocket: () => socket });
    expect(() => link.sendLine("STATUS")).toThrow(/not connected/i);
  });

  it("checkLiveness throws before connect()", () => {
    const socket = new FakeSocket();
    const link = new MbserialLink(HOST, PORT, { createSocket: () => socket });
    expect(() => link.checkLiveness()).toThrow(/not connected/i);
  });
});

// ---------------------------------------------------------------------
// No command plane, ever (this ticket's central acceptance criterion) --
// SUC-005's negative assertion, plus a plain source-level check.
// ---------------------------------------------------------------------

/** Matches any line this transport might mistakenly send if it were
 * (incorrectly) copy-pasted from `MbrelayLink.ts`/`RelayRadioLink.ts`'s
 * command-plane preamble -- `!CG`, `!MODE`, `!ECHO`, `!GO`, `!P`. */
const COMMAND_PLANE_GRAMMAR = /^!(CG|MODE|ECHO|GO|P)\b/;

describe("MbserialLink never speaks the relay command-plane grammar (SUC-005)", () => {
  it("sends no line matching !CG/!MODE/!ECHO/!GO/!P across connect + full sequencing traffic", async () => {
    const { link, socket } = await identifiedLink("device NEZHA2 robot vevov 1198504156");

    link.sendCommand("STOP");
    await flush();
    socket.emit("data", Buffer.from("ack 1 1 ok\n"));
    await flush();
    link.checkLiveness();
    await flush();

    for (const written of socket.writes) {
      expect(written).not.toMatch(COMMAND_PLANE_GRAMMAR);
    }
    // Sanity check the assertion itself is not vacuous.
    expect(socket.writes.length).toBeGreaterThan(0);
  });

  // Following the `RobotPage.transportBlind.test.ts` precedent
  // (`sprint.md`'s own reference for this ticket): a structural property
  // ("this module must never import the relay command-plane") is
  // enforced with a direct source scan, not left to review alone, since
  // a copy-paste from `MbrelayLink.ts` is the most likely way this could
  // regress.
  it("does not import RelayCommandPlane.ts or protocol/relay/commands.ts", () => {
    const source = readFileSync(fileURLToPath(new URL("./MbserialLink.ts", import.meta.url)), "utf-8");
    const importLines = source.split("\n").filter((line) => /^\s*import\b/.test(line));
    for (const importLine of importLines) {
      expect(importLine).not.toMatch(/RelayCommandPlane/);
      expect(importLine).not.toMatch(/relay\/commands/);
    }
  });
});
