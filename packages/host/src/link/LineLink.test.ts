import { describe, expect, it } from "vitest";
import { LineLink } from "./LineLink.js";
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
