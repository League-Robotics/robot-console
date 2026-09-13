import { describe, expect, it } from "vitest";
import { DEFAULT_UNSEQUENCED_QUERY_RESEND_MS, expectedReplyVerbFor, LineLink } from "./LineLink.js";
import { FakeByteStream } from "./__fixtures__/FakeByteStream.js";
import type { Scheduler } from "./pacing.js";

// Drives the entire LineLink core suite against FakeByteStream -- no
// real serial/TCP I/O (ticket 014-006 builds the real adapters and
// their own tests on this same fixture). Mirrors the acceptance
// criteria on ticket 014-005 verbatim: connect / second connect
// refused / identify banner / identify null on timeout / identify null
// on closed link (no rejection) / lines during identify still routed /
// ack-nack resend ordering / close idempotent / onClose fires on
// stream close without error / write error surfaces via onError --
// plus the connect-bounded and preamble-hook criteria from the
// ticket's own top-level description.

/** A scheduler whose `delay()` resolves on the next microtask instead
 * of a real wall-clock wait -- same convention as
 * `UsbSerialLink.test.ts`'s own `immediateScheduler`. Real pacing
 * timing has its own coverage in `pacing.test.ts`. */
const immediateScheduler: Scheduler = { delay: () => Promise.resolve() };

/** Flush pending microtasks (a `WritePacer` chain, `FakeByteStream`'s
 * own `queueMicrotask` callbacks) so scheduled work has settled before
 * assertions run. A macrotask boundary (`setTimeout`) drains the whole
 * microtask queue first, however many hops deep. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** A banner line matching both this fixture's canonical example and
 * `UsbSerialLink.test.ts`'s own (`banner.ts`'s colon-form dialect). */
const BANNER_LINE = "DEVICE:RADIOBRIDGE:relay:getez:1779042496";

async function connectedLink(
  overrides: { identifyTimeoutMs?: number; connectTimeoutMs?: number; maxBufferChars?: number } = {},
): Promise<{ link: LineLink; stream: FakeByteStream }> {
  const stream = new FakeByteStream();
  const link = new LineLink(stream, {
    scheduler: immediateScheduler,
    identifyTimeoutMs: overrides.identifyTimeoutMs ?? 20,
    connectTimeoutMs: overrides.connectTimeoutMs ?? 200,
    maxBufferChars: overrides.maxBufferChars,
  });
  const connectPromise = link.connect();
  stream.resolveOpen();
  await connectPromise;
  return { link, stream };
}

// ---------------------------------------------------------------------
// connect() -- transport-only, bounded, refuses a second call
// ---------------------------------------------------------------------

describe("LineLink.connect", () => {
  it("opens the stream via ByteStream.open() and resolves", async () => {
    const stream = new FakeByteStream();
    const link = new LineLink(stream, { scheduler: immediateScheduler });
    const connectPromise = link.connect();
    expect(stream.openCallCount).toBe(1);
    stream.resolveOpen();
    await connectPromise;
    expect(link.isOpen).toBe(true);
  });

  it("refuses a second connect() call", async () => {
    const { link } = await connectedLink();
    await expect(link.connect()).rejects.toThrow(/connect\(\)|once/i);
  });

  it("rejects on a transport-level open() failure and does not mark the link connected", async () => {
    const stream = new FakeByteStream();
    const link = new LineLink(stream, { scheduler: immediateScheduler });
    const connectPromise = link.connect();
    const boom = new Error("ENOENT: no such device");
    stream.rejectOpen(boom);
    await expect(connectPromise).rejects.toBe(boom);
    expect(link.isOpen).toBe(false);
  });

  it("is bounded by timeoutMs -- rejects rather than hanging when open() never settles", async () => {
    const stream = new FakeByteStream();
    const link = new LineLink(stream, { scheduler: immediateScheduler, connectTimeoutMs: 20 });
    await expect(link.connect()).rejects.toThrow(/timed out/i);
    // Best-effort cleanup of the half-open transport.
    expect(stream.closeCallCount).toBeGreaterThanOrEqual(1);
  });

  it("is bounded by a caller-supplied AbortSignal", async () => {
    const stream = new FakeByteStream();
    const link = new LineLink(stream, { scheduler: immediateScheduler, connectTimeoutMs: 5000 });
    const controller = new AbortController();
    const connectPromise = link.connect({ signal: controller.signal });
    controller.abort(new Error("cancelled by caller"));
    await expect(connectPromise).rejects.toThrow(/cancelled by caller/);
  });

  it("runs the preamble hook after open() and before connect() resolves", async () => {
    const stream = new FakeByteStream();
    const order: string[] = [];
    const link = new LineLink(stream, {
      scheduler: immediateScheduler,
      preamble: async (s, signal) => {
        order.push("preamble");
        expect(s).toBe(stream);
        expect(signal.aborted).toBe(false);
      },
    });
    const connectPromise = link.connect();
    stream.resolveOpen();
    await connectPromise;
    order.push("connected");
    expect(order).toEqual(["preamble", "connected"]);
  });

  it("propagates a rejecting preamble as a connect() failure", async () => {
    const stream = new FakeByteStream();
    const boom = new Error("relay handshake failed");
    const link = new LineLink(stream, {
      scheduler: immediateScheduler,
      preamble: async () => {
        throw boom;
      },
    });
    const connectPromise = link.connect();
    stream.resolveOpen();
    await expect(connectPromise).rejects.toBe(boom);
    expect(stream.closeCallCount).toBe(1);
  });
});

// ---------------------------------------------------------------------
// identify() -- HELLO -> banner-from-reply, never rejects, re-entrant
// ---------------------------------------------------------------------

describe("LineLink.identify", () => {
  it("sends HELLO and resolves the banner parsed from its reply", async () => {
    const { link, stream } = await connectedLink();
    const identifyPromise = link.identify();
    await flush();
    stream.emitData(`${BANNER_LINE}\n`);
    const banner = await identifyPromise;
    expect(banner).toEqual(
      expect.objectContaining({ role: "RADIOBRIDGE", commonName: "relay", name: "getez", serial: 1779042496 }),
    );
    expect(link.banner).toEqual(banner);
    expect(link.name).toBe("getez");
  });

  it("resolves null, never rejects, if no banner arrives within identifyTimeoutMs", async () => {
    const { link } = await connectedLink({ identifyTimeoutMs: 20 });
    const banner = await link.identify();
    expect(banner).toBeNull();
  });

  it("resolves null immediately for a link that has never connected -- no rejection", async () => {
    const stream = new FakeByteStream();
    const link = new LineLink(stream, { scheduler: immediateScheduler });
    await expect(link.identify()).resolves.toBeNull();
  });

  it("resolves null immediately (no rejection) once the link has closed", async () => {
    const { link, stream } = await connectedLink();
    stream.emitClose();
    await flush();
    await expect(link.identify()).resolves.toBeNull();
  });

  it("re-entrant calls share one wait -- HELLO is sent exactly once", async () => {
    const { link, stream } = await connectedLink();
    const first = link.identify();
    const second = link.identify();
    await flush();
    const helloWrites = stream.writes.filter((w) => w.bytes.startsWith("HELLO"));
    expect(helloWrites).toHaveLength(1);

    stream.emitData(`${BANNER_LINE}\n`);
    const [a, b] = await Promise.all([first, second]);
    expect(a).not.toBeNull();
    expect(a).toEqual(b);
  });

  it("routes a non-banner line to onLine even while the banner wait is pending, instead of discarding it", async () => {
    const { link, stream } = await connectedLink();
    const lines: unknown[] = [];
    link.onLine((line) => lines.push(line));

    const identifyPromise = link.identify();
    await flush();
    stream.emitData("pong\n");
    expect(lines).toEqual([{ kind: "line", verb: "pong", fields: [] }]);

    stream.emitData(`${BANNER_LINE}\n`);
    await expect(identifyPromise).resolves.not.toBeNull();
  });

  it("an ack/nack arriving during the banner wait is still fed to the session and dispatched, not dropped", async () => {
    const { link, stream } = await connectedLink();
    const stopLine = link.sendCommand("STOP");
    await flush();

    const ackNacks: unknown[] = [];
    link.onAckNack((event) => ackNacks.push(event));
    const identifyPromise = link.identify();
    await flush();

    stream.emitData("ack 1 1 ok\n");
    expect(ackNacks).toHaveLength(1);
    expect(link.session.pendingCount).toBe(0);
    void stopLine;

    stream.emitData(`${BANNER_LINE}\n`);
    await expect(identifyPromise).resolves.not.toBeNull();
  });

  // 018-007: a WiFi robot sends its own banner twice after HELLO and
  // interleaves unsolicited `DBG:wifi ...` lines (live-verified root
  // cause of the `.local`-hostname connect investigation). Neither
  // should error, reject anything, or be mistaken for a fresh identify()
  // banner reply -- `resolveBannerWait` is already cleared by the time
  // either arrives, so a second `device ...` line classifies as an
  // ordinary "reply" direction line (`codec.ts`'s `REPLY_VERBS` includes
  // "device") and reaches `onLine` harmlessly, while `DBG:wifi ...`
  // (uppercase first letter -> "command" direction, not ack/nack) is
  // simply unrouted console text via `onRawLine` -- see
  // `receive.ts`/`codec.ts`'s own doc comments for why neither path ever
  // throws or flags malformed.
  it("018-007: tolerates a WiFi robot's doubled banner and interleaved DBG:wifi lines, without erroring or misclassifying", async () => {
    const { link, stream } = await connectedLink();
    const lines: unknown[] = [];
    const rawLines: string[] = [];
    const errors: unknown[] = [];
    link.onLine((line) => lines.push(line));
    link.onRawLine((raw) => rawLines.push(raw));
    link.onError((err) => errors.push(err));

    const identifyPromise = link.identify();
    await flush();

    const spaceFormBanner = "device NEZHA2 robot gopiv 2175407711";
    stream.emitData(`${spaceFormBanner}\n`);
    const banner = await identifyPromise;
    expect(banner).toEqual(
      expect.objectContaining({ role: "NEZHA2", commonName: "robot", name: "gopiv", serial: 2175407711 }),
    );
    expect(link.isOpen).toBe(true);

    // The robot's own second copy of the same banner, plus an
    // interleaved DBG:wifi line -- both arrive well after identify()
    // already resolved and cleared its banner wait.
    stream.emitData("DBG:wifi rssi=-42 ch=6\n");
    stream.emitData(`${spaceFormBanner}\n`);
    await flush();

    expect(errors).toEqual([]);
    expect(link.isOpen).toBe(true);
    // The DBG line: unrouted (command-direction, uppercase D), reaches
    // onRawLine as plain console text, not onLine.
    expect(rawLines).toContain("DBG:wifi rssi=-42 ch=6");
    // The repeated banner: reply-direction ("device" is a known reply
    // verb), reaches onLine like any other non-ack/nack reply -- it is
    // NOT re-consumed as a second identify() banner (identify() already
    // resolved once, above) and does not change `link.banner`/`link.name`.
    expect(lines).toEqual(expect.arrayContaining([expect.objectContaining({ verb: "device" })]));
    expect(link.banner).toEqual(banner);
    expect(link.name).toBe("gopiv");
  });
});

// ---------------------------------------------------------------------
// ack/nack sequencing via receive() -- resend ordering
// ---------------------------------------------------------------------

describe("LineLink ack/nack sequencing", () => {
  it("writes a nack's resend line before any later-scheduled write, in order", async () => {
    const { link, stream } = await connectedLink();
    const stopLine = link.sendCommand("STOP"); // id 1
    await flush();
    expect(stream.writes.map((w) => w.bytes)).toEqual([stopLine]);

    const ackNackEvents: unknown[] = [];
    link.onAckNack((event) => ackNackEvents.push(event));

    stream.emitData("nack 1 0 none\n");
    // Scheduled strictly after the resend, synchronously, in the same
    // tick as the nack was handled.
    const runLine = link.sendCommand("RUN"); // id 2
    await flush();

    expect(stream.writes.map((w) => w.bytes)).toEqual([stopLine, stopLine, runLine]);
    expect(ackNackEvents).toHaveLength(1);
    expect(link.session.seq).toBe(0); // nack N -> seq = N - 1, not N
  });

  it("a malformed ack/nack still reaches the console via onRawLine", async () => {
    const { link, stream } = await connectedLink();
    const raws: string[] = [];
    link.onRawLine((raw) => raws.push(raw));
    stream.emitData("nack notanumber 0 none\n");
    expect(raws).toEqual(["nack notanumber 0 none"]);
  });

  it("a foreign line is surfaced via onRawLine, never onLine", async () => {
    const { link, stream } = await connectedLink();
    const lines: unknown[] = [];
    const raws: string[] = [];
    link.onLine((line) => lines.push(line));
    link.onRawLine((raw) => raws.push(raw));
    stream.emitData("beep boop overheard\n");
    expect(lines).toEqual([]);
    expect(raws).toEqual(["beep boop overheard"]);
  });
});

// ---------------------------------------------------------------------
// onInboundLine (item G, team-lead 2026-09-13): a fourth, additive tap
// that fires for EVERY inbound raw line -- decoded, unrouted, or
// malformed alike -- unlike onRawLine, which fires only for a line
// receive() could not route to a decoded shape. Bench root cause: a
// real, successfully-decoded reply (id/status/ack/nack) never reached
// the student console because server.ts's own broadcast read only
// onRawLine -- see LineLink.onInboundLine's own doc comment.
// ---------------------------------------------------------------------

describe("LineLink.onInboundLine", () => {
  it("a decoded reply line (a well-formed, routable verb) fires both onLine and onInboundLine, not just onLine", async () => {
    const { link, stream } = await connectedLink();
    const lines: unknown[] = [];
    const inbound: string[] = [];
    link.onLine((line) => lines.push(line));
    link.onInboundLine((raw) => inbound.push(raw));
    stream.emitData("id diffdrive calibration-0.20260913.1 1.20260912.8 gopiv\n");
    expect(lines).toHaveLength(1);
    expect(inbound).toEqual(["id diffdrive calibration-0.20260913.1 1.20260912.8 gopiv"]);
  });

  it("an unrouted (foreign) line fires both onRawLine and onInboundLine", async () => {
    const { link, stream } = await connectedLink();
    const raws: string[] = [];
    const inbound: string[] = [];
    link.onRawLine((raw) => raws.push(raw));
    link.onInboundLine((raw) => inbound.push(raw));
    stream.emitData("beep boop overheard\n");
    expect(raws).toEqual(["beep boop overheard"]);
    expect(inbound).toEqual(["beep boop overheard"]);
  });

  it("a well-formed ack fires onAckNack and onInboundLine, not onRawLine", async () => {
    const { link, stream } = await connectedLink();
    link.sendCommand("STOP"); // id 1
    await flush();
    const acks: unknown[] = [];
    const raws: string[] = [];
    const inbound: string[] = [];
    link.onAckNack((event) => acks.push(event));
    link.onRawLine((raw) => raws.push(raw));
    link.onInboundLine((raw) => inbound.push(raw));
    stream.emitData("ack 1 7 none\n");
    expect(acks).toHaveLength(1);
    expect(raws).toEqual([]);
    expect(inbound).toEqual(["ack 1 7 none"]);
  });

  it("a line consumed as the identify() banner reply does NOT fire onInboundLine", async () => {
    const { link, stream } = await connectedLink();
    const inbound: string[] = [];
    link.onInboundLine((raw) => inbound.push(raw));
    const identifyPromise = link.identify();
    await flush();
    stream.emitData(`${BANNER_LINE}\n`);
    await identifyPromise;
    expect(inbound).toEqual([]);
  });
});

// ---------------------------------------------------------------------
// close() -- idempotent, and onClose fires (the fix for
// "no onClose" -- 02-host-transport.md S5.1)
// ---------------------------------------------------------------------

describe("LineLink.close", () => {
  it("is idempotent -- closing twice only closes the stream once", async () => {
    const { link, stream } = await connectedLink();
    await link.close();
    await link.close();
    await flush();
    expect(stream.closeCallCount).toBe(1);
  });

  it("is idempotent -- a second close() before the first settles does not double-close the stream", async () => {
    const { link, stream } = await connectedLink();
    const first = link.close();
    const second = link.close();
    await Promise.all([first, second]);
    await flush();
    expect(stream.closeCallCount).toBe(1);
  });

  it("close() before connect() ever succeeded is a no-op", async () => {
    const stream = new FakeByteStream();
    const link = new LineLink(stream, { scheduler: immediateScheduler });
    await link.close();
    expect(stream.closeCallCount).toBe(0);
  });

  it("fires onClose exactly once when the stream closes without a prior error", async () => {
    const { link, stream } = await connectedLink();
    const closes: Array<Error | undefined> = [];
    link.onClose((reason) => closes.push(reason));

    stream.emitClose(); // unsolicited -- e.g. a peer disconnect, no "error" event first
    await flush();

    expect(closes).toEqual([undefined]);
    expect(link.isOpen).toBe(false);
  });

  it("carries the most recent error as the close reason when an error preceded the close", async () => {
    const { link, stream } = await connectedLink();
    const closes: Array<Error | undefined> = [];
    link.onClose((reason) => closes.push(reason));

    const boom = new Error("EIO");
    stream.emitError(boom);
    stream.emitClose();
    await flush();

    expect(closes).toEqual([boom]);
  });

  it("an explicit close() also fires onClose exactly once", async () => {
    const { link, stream } = await connectedLink();
    const closes: Array<Error | undefined> = [];
    link.onClose((reason) => closes.push(reason));

    await link.close();
    await flush();

    expect(closes).toEqual([undefined]);
  });

  it("resolves a pending identify() null immediately instead of hanging, when the stream closes underneath it", async () => {
    const { link, stream } = await connectedLink({ identifyTimeoutMs: 5000 });
    const identifyPromise = link.identify();
    await flush();
    stream.emitClose();
    await expect(identifyPromise).resolves.toBeNull();
  });
});

// ---------------------------------------------------------------------
// 018-009: sendUnsequenced's own bounded resend-once-if-unanswered, and
// the hasPendingUnsequencedQuery gate connect/harvester.ts's STATUS poll
// checks. See LineLink.ts's own module doc comment, "Unsequenced query
// resend and poll/query serialization", for the bench evidence (a
// student's own `send-command ID` racing the harvester's STATUS poll on
// the real `torture` mbrelay pool) this fixes.
// ---------------------------------------------------------------------

/** A `Scheduler` whose `delay()` never resolves on its own -- a test
 * drives every timeout deterministically via {@link resolveAll}. Same
 * pattern as `RelayCommandPlane.test.ts`'s own `controllableScheduler()`. */
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

async function connectedLinkWithScheduler(scheduler: Scheduler): Promise<{ link: LineLink; stream: FakeByteStream }> {
  const stream = new FakeByteStream();
  const link = new LineLink(stream, { scheduler, connectTimeoutMs: 5000, identifyTimeoutMs: 5000 });
  const connectPromise = link.connect();
  stream.resolveOpen();
  await connectPromise;
  return { link, stream };
}

/** A well-formed `id ...` reply line, decoding with verb `"id"` --
 * matches the shape `LineLink.onInboundLine`'s own suite already uses. */
const ID_REPLY_LINE = "id diffdrive calibration-0.20260913.1 1.20260912.8 gopiv\n";

describe("LineLink.sendUnsequencedQuery resend + pending gate (018-009)", () => {
  it("hasPendingUnsequencedQuery is true immediately after sendUnsequenced, false again once the matching reply arrives", async () => {
    const scheduler = controllableScheduler();
    const { link, stream } = await connectedLinkWithScheduler(scheduler);

    expect(link.hasPendingUnsequencedQuery).toBe(false);
    link.sendUnsequencedQuery("ID");
    expect(link.hasPendingUnsequencedQuery).toBe(true);

    stream.emitData(ID_REPLY_LINE);
    expect(link.hasPendingUnsequencedQuery).toBe(false);
  });

  it("resends the identical line exactly once if unanswered within the bound, then gives up", async () => {
    const scheduler = controllableScheduler();
    const { link, stream } = await connectedLinkWithScheduler(scheduler);

    const line = link.sendUnsequencedQuery("ID");
    await flush();
    expect(stream.writes.map((w) => w.bytes)).toEqual([line]);
    expect(link.hasPendingUnsequencedQuery).toBe(true);

    // First bound elapses with no reply -- one resend, identical text.
    scheduler.resolveAll();
    await flush();
    expect(stream.writes.map((w) => w.bytes)).toEqual([line, line]);
    expect(link.hasPendingUnsequencedQuery).toBe(true); // still within the resend's own wait

    // Second bound elapses, still no reply -- give up, never a third send.
    scheduler.resolveAll();
    await flush();
    expect(stream.writes.map((w) => w.bytes)).toEqual([line, line]);
    expect(link.hasPendingUnsequencedQuery).toBe(false);
  });

  it("never resends once a matching reply has already arrived", async () => {
    const scheduler = controllableScheduler();
    const { link, stream } = await connectedLinkWithScheduler(scheduler);

    const line = link.sendUnsequencedQuery("ID");
    await flush();
    stream.emitData(ID_REPLY_LINE);
    expect(link.hasPendingUnsequencedQuery).toBe(false);

    // The bound elapsing after the reply already settled must not trigger
    // a resend.
    scheduler.resolveAll();
    await flush();
    expect(stream.writes.map((w) => w.bytes)).toEqual([line]);
  });

  it("a reply arriving during the resend's own wait window still clears the pending gate and stops further resends", async () => {
    const scheduler = controllableScheduler();
    const { link, stream } = await connectedLinkWithScheduler(scheduler);

    const line = link.sendUnsequencedQuery("ID");
    await flush();
    scheduler.resolveAll(); // first bound elapses -- one resend goes out
    await flush();
    expect(stream.writes.map((w) => w.bytes)).toEqual([line, line]);

    stream.emitData(ID_REPLY_LINE); // the resend's own reply arrives
    expect(link.hasPendingUnsequencedQuery).toBe(false);

    scheduler.resolveAll(); // the resend's own bound elapsing must not fire a third send
    await flush();
    expect(stream.writes.map((w) => w.bytes)).toEqual([line, line]);
  });

  it("expectedReplyVerbFor mirrors a query verb's own lowercase text, except PING -> pong", () => {
    expect(expectedReplyVerbFor("ID")).toBe("id");
    expect(expectedReplyVerbFor("STATUS")).toBe("status");
    expect(expectedReplyVerbFor("status")).toBe("status");
    expect(expectedReplyVerbFor("HELP")).toBe("help");
    expect(expectedReplyVerbFor("PING")).toBe("pong");
    expect(expectedReplyVerbFor("ping")).toBe("pong");
  });

  it("DEFAULT_UNSEQUENCED_QUERY_RESEND_MS is comfortably inside a 5000ms outer reply budget", () => {
    // scripts/bench/layer2/pathChecks.ts's own DEFAULT_REPLY_TIMEOUT_MS --
    // two full resend-wait windows must still fit comfortably inside it,
    // per the module doc comment's own "Unsequenced query resend" section.
    expect(DEFAULT_UNSEQUENCED_QUERY_RESEND_MS * 2).toBeLessThan(5000);
  });
});

// ---------------------------------------------------------------------
// Write failures -- surfaced via onError, not swallowed
// ---------------------------------------------------------------------

describe("LineLink write errors", () => {
  it("a write failure surfaces via onError instead of being swallowed", async () => {
    const { link, stream } = await connectedLink();
    const errors: Error[] = [];
    link.onError((err) => errors.push(err));

    const boom = new Error("EPIPE");
    stream.nextWriteError = boom;
    link.sendLine("hello");
    await flush();

    expect(errors).toEqual([boom]);
  });

  it("a throwing/failing write does not wedge a later write", async () => {
    const { link, stream } = await connectedLink();
    const errors: Error[] = [];
    link.onError((err) => errors.push(err));

    stream.nextWriteError = new Error("EPIPE");
    link.sendLine("first");
    link.sendLine("second");
    await flush();

    expect(errors).toHaveLength(1);
    expect(stream.writes.map((w) => w.bytes)).toEqual(["first\n", "second\n"]);
  });
});

// ---------------------------------------------------------------------
// Reassembly max-buffer guard (lineStream.ts) wired through onError
// ---------------------------------------------------------------------

describe("LineLink reassembly guard", () => {
  it("surfaces via onError when a partial line with no newline exceeds maxBufferChars", async () => {
    const { link, stream } = await connectedLink({ maxBufferChars: 10 });
    const errors: Error[] = [];
    link.onError((err) => errors.push(err));

    stream.emitData("x".repeat(20)); // no newline -- a runaway partial line
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toMatch(/buffer/i);
  });
});
