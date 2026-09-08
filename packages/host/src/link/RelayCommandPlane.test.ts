import { describe, expect, it } from "vitest";
import { runRelayCommandPlane, RelayHandshakeError } from "./RelayCommandPlane.js";
import type { Scheduler } from "./pacing.js";

// This suite exercises `runRelayCommandPlane` entirely against a fake
// write/subscribe pair and a fake scheduler -- no real transport, no
// real wall-clock delay anywhere in this file, per the ticket's own
// Testing section and `sprint.md`'s Test Strategy ("commands.ts is pure
// and zero-I/O ... RelayCommandPlane ... under a fake scheduler -- no
// real relay or robot needed for any of it").

/** A fully synthetic write/subscribe pair recording every write and
 * letting a test deliver a raw reply line to whatever is currently
 * subscribed. */
function fakeRelayLink() {
  const writes: string[] = [];
  const listeners = new Set<(line: string) => void>();
  return {
    writes,
    write: (line: string): void => {
      writes.push(line);
    },
    subscribe: (listener: (line: string) => void): (() => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    /** Deliver `line` to every currently-subscribed listener (mirrors
     * `RelayCommandPlane`'s own single-subscriber-at-a-time usage, but
     * iterates a copy so a listener that unsubscribes itself mid-call
     * doesn't corrupt iteration). */
    emit: (line: string): void => {
      for (const listener of [...listeners]) {
        listener(line);
      }
    },
  };
}

/** A `Scheduler` whose `delay()` never resolves on its own -- a test
 * drives every timeout deterministically via {@link resolveAll}, so
 * nothing in this file ever waits on a real timer. Resolving an already-
 * settled `waitForReply` call's stale delay is harmless (`RelayCommandPlane`'s
 * own `waitForReply` guards on `settled`), so {@link resolveAll} can be
 * called without tracking which `delay()` call is "the live one". */
function controllableScheduler(): Scheduler & { resolveAll: () => void; pendingCount: () => number } {
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
    pendingCount: () => resolvers.length,
  };
}

/** Flush pending microtasks so awaited handshake steps have settled
 * before assertions run -- same technique as `UsbSerialLink.test.ts`'s
 * own `flush()`. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("runRelayCommandPlane -- successful handshake", () => {
  it("sends the full preamble in order and resolves once !GO confirms", async () => {
    const link = fakeRelayLink();
    const scheduler = controllableScheduler();
    const promise = runRelayCommandPlane({
      write: link.write,
      subscribe: link.subscribe,
      channel: 37,
      group: 3,
      scheduler,
    });

    await flush();
    expect(link.writes).toEqual(["!ECHO OFF\n", "!MODE RAW250\n", "!CG 37 3\n"]);

    link.emit("# channel: 37 group: 3 mode: RAW250 power: 7");
    await flush();
    expect(link.writes).toEqual(["!ECHO OFF\n", "!MODE RAW250\n", "!CG 37 3\n", "!P 7\n", "!GO\n"]);

    link.emit("# go ok");
    await expect(promise).resolves.toBeUndefined();
  });
});

describe("runRelayCommandPlane -- !CG rejection (SUC-003)", () => {
  it("rejects when the relay's !CG reply is not a # confirmation, and !GO is never sent", async () => {
    const link = fakeRelayLink();
    const scheduler = controllableScheduler();
    const promise = runRelayCommandPlane({
      write: link.write,
      subscribe: link.subscribe,
      channel: 37,
      group: 3,
      scheduler,
    });

    await flush();
    link.emit("NAK\n");

    await expect(promise).rejects.toThrow(RelayHandshakeError);
    await expect(promise).rejects.toThrow(/rejected !CG/);
    expect(link.writes).toEqual(["!ECHO OFF\n", "!MODE RAW250\n", "!CG 37 3\n"]);
    expect(link.writes).not.toContain("!P 7\n");
    expect(link.writes).not.toContain("!GO\n");
  });

  it("rejects when !CG never receives any reply at all, and !GO is never sent", async () => {
    const link = fakeRelayLink();
    const scheduler = controllableScheduler();
    const promise = runRelayCommandPlane({
      write: link.write,
      subscribe: link.subscribe,
      channel: 37,
      group: 3,
      scheduler,
    });

    await flush();
    expect(link.writes).toEqual(["!ECHO OFF\n", "!MODE RAW250\n", "!CG 37 3\n"]);

    scheduler.resolveAll();
    await expect(promise).rejects.toThrow(RelayHandshakeError);
    await expect(promise).rejects.toThrow(/never confirmed !CG/);
    expect(link.writes).not.toContain("!GO\n");
  });
});

describe("runRelayCommandPlane -- !GO timeout (SUC-003)", () => {
  it("rejects with a timeout if !GO never confirms, driven entirely by the fake scheduler", async () => {
    const link = fakeRelayLink();
    const scheduler = controllableScheduler();
    const promise = runRelayCommandPlane({
      write: link.write,
      subscribe: link.subscribe,
      channel: 37,
      group: 3,
      scheduler,
    });

    await flush();
    link.emit("# channel: 37 group: 3 mode: RAW250 power: 7");
    await flush();
    expect(link.writes).toEqual(["!ECHO OFF\n", "!MODE RAW250\n", "!CG 37 3\n", "!P 7\n", "!GO\n"]);

    // No real wall-clock delay anywhere -- the timeout fires purely
    // because the test drives the fake scheduler's pending delay(s).
    scheduler.resolveAll();

    await expect(promise).rejects.toThrow(RelayHandshakeError);
    await expect(promise).rejects.toThrow(/never confirmed !GO/);
  });

  it("never leaves the returned promise unresolved -- always settles, one way or another", async () => {
    const link = fakeRelayLink();
    const scheduler = controllableScheduler();
    const promise = runRelayCommandPlane({
      write: link.write,
      subscribe: link.subscribe,
      channel: 25,
      group: 1,
      scheduler,
    });

    await flush();
    link.emit("# channel: 25 group: 1 mode: RAW250 power: 7");
    await flush();

    let settled = false;
    promise.catch(() => {
      settled = true;
    });

    expect(settled).toBe(false);
    scheduler.resolveAll();
    await flush();
    expect(settled).toBe(true);
  });
});
