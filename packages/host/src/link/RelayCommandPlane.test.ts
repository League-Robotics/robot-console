import { describe, expect, it } from "vitest";
import { runRelayCommandPlane, RelayHandshakeError, sync, setChannelGroup, setChannelGroupTransient, go, probeRadioId } from "./RelayCommandPlane.js";
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

const STATUS_37_3 = "# channel: 37 group: 3 mode: RAW250 power: 7";

/** Drive a whole successful handshake against the fake, answering each
 * step the way relay vitut does (measured 2026-09-09). Returns the
 * writes made. */
async function answerHandshake(link: ReturnType<typeof fakeRelayLink>, channel: number, group: number): Promise<void> {
  await flush();
  expect(link.writes.at(-1)).toBe("?\n");
  link.emit(`# channel: 25 group: 1 mode: RAW250 power: 7`); // whatever it was before
  await flush();
  expect(link.writes.at(-1)).toBe("!ECHO OFF\n");
  link.emit("# echo: OFF");
  await flush();
  expect(link.writes.at(-1)).toBe("!MODE RAW250\n");
  link.emit("# mode: RAW250");
  await flush();
  expect(link.writes.at(-1)).toBe(`!CG ${channel} ${group}\n`);
  link.emit(`# channel: ${channel} group: ${group} mode: RAW250 power: 7`);
  await flush();
  expect(link.writes.at(-1)).toBe("!P 7\n");
  link.emit(`# channel: ${channel} group: ${group} mode: RAW250 power: 7`);
  await flush();
  expect(link.writes.at(-1)).toBe("!GO\n");
  link.emit("# entering data plane");
}

describe("runRelayCommandPlane -- successful handshake (each step gated on its own reply, OOP 2026-09-09)", () => {
  it("syncs with `?`, then sends one command at a time, each confirmed by its specific reply, and resolves on `# entering data plane`", async () => {
    const link = fakeRelayLink();
    const scheduler = controllableScheduler();
    const promise = runRelayCommandPlane({ write: link.write, subscribe: link.subscribe, channel: 37, group: 3, scheduler });
    await answerHandshake(link, 37, 3);
    await expect(promise).resolves.toBeUndefined();
    expect(link.writes).toEqual(["?\n", "!ECHO OFF\n", "!MODE RAW250\n", "!CG 37 3\n", "!P 7\n", "!GO\n"]);
  });

  it("ignores boot text, DBG chatter and stale replies -- only the step's own reply advances it", async () => {
    const link = fakeRelayLink();
    const scheduler = controllableScheduler();
    const promise = runRelayCommandPlane({ write: link.write, subscribe: link.subscribe, channel: 37, group: 3, scheduler });
    await flush();
    link.emit("# micro:bit radio relay");
    link.emit("DBG:wifi state=1 ip=-");
    link.emit("# echo: OFF"); // a stale reply -- NOT the `?` answer
    await flush();
    expect(link.writes).toEqual(["?\n"]); // still waiting for `# channel:`
    link.emit(STATUS_37_3);
    await flush();
    expect(link.writes.at(-1)).toBe("!ECHO OFF\n");
    link.emit("# mode: RAW250"); // wrong reply for this step -- ignored
    link.emit(STATUS_37_3);
    await flush();
    expect(link.writes.at(-1)).toBe("!ECHO OFF\n");
    link.emit("# echo: OFF");
    await flush();
    expect(link.writes.at(-1)).toBe("!MODE RAW250\n");
    link.emit("# mode: RAW250");
    await flush();
    link.emit("# channel: 99 group: 9 mode: RAW250 power: 7"); // wrong address -- ignored
    await flush();
    expect(link.writes.at(-1)).toBe("!CG 37 3\n");
    link.emit(STATUS_37_3);
    await flush();
    link.emit(STATUS_37_3);
    await flush();
    expect(link.writes.at(-1)).toBe("!GO\n");
    link.emit("# entering data plane");
    await expect(promise).resolves.toBeUndefined();
  });

  it("re-sends `?` on each sync timeout until the relay answers (a relay still booting after a reset)", async () => {
    const link = fakeRelayLink();
    const scheduler = controllableScheduler();
    const promise = runRelayCommandPlane({ write: link.write, subscribe: link.subscribe, channel: 37, group: 3, scheduler });
    await flush();
    expect(link.writes).toEqual(["?\n"]);
    scheduler.resolveAll();
    await flush();
    expect(link.writes).toEqual(["?\n", "?\n"]);
    scheduler.resolveAll();
    await flush();
    expect(link.writes).toEqual(["?\n", "?\n", "?\n"]);
    link.emit(STATUS_37_3);
    await flush();
    expect(link.writes.at(-1)).toBe("!ECHO OFF\n");
    link.emit("# echo: OFF"); await flush();
    link.emit("# mode: RAW250"); await flush();
    link.emit(STATUS_37_3); await flush();
    link.emit(STATUS_37_3); await flush();
    link.emit("# entering data plane");
    await expect(promise).resolves.toBeUndefined();
  });

  it("gives up on sync after the configured attempts, never having sent a real command", async () => {
    const link = fakeRelayLink();
    const scheduler = controllableScheduler();
    const promise = runRelayCommandPlane({ write: link.write, subscribe: link.subscribe, channel: 37, group: 3, scheduler, syncAttempts: 3 });
    for (let i = 0; i < 3; i++) { await flush(); scheduler.resolveAll(); }
    await expect(promise).rejects.toThrow(/never answered/);
    expect(link.writes).toEqual(["?\n", "?\n", "?\n"]);
  });
});

describe("runRelayCommandPlane -- !CG rejection (SUC-003)", () => {
  it("rejects when the relay answers !CG with a # error line, and !GO is never sent", async () => {
    const link = fakeRelayLink();
    const scheduler = controllableScheduler();
    const promise = runRelayCommandPlane({ write: link.write, subscribe: link.subscribe, channel: 37, group: 3, scheduler });
    await flush(); link.emit(STATUS_37_3);
    await flush(); link.emit("# echo: OFF");
    await flush(); link.emit("# mode: RAW250");
    await flush();
    expect(link.writes.at(-1)).toBe("!CG 37 3\n");
    link.emit("# error: usage !CG <ch 0-83> <group 0-255>");
    await expect(promise).rejects.toThrow(RelayHandshakeError);
    await expect(promise).rejects.toThrow(/rejected !CG 37 3/);
    expect(link.writes).not.toContain("!P 7\n");
    expect(link.writes).not.toContain("!GO\n");
  });

  it("rejects when !CG never receives its reply, and !GO is never sent", async () => {
    const link = fakeRelayLink();
    const scheduler = controllableScheduler();
    const promise = runRelayCommandPlane({ write: link.write, subscribe: link.subscribe, channel: 37, group: 3, scheduler });
    await flush(); link.emit(STATUS_37_3);
    await flush(); link.emit("# echo: OFF");
    await flush(); link.emit("# mode: RAW250");
    await flush();
    expect(link.writes.at(-1)).toBe("!CG 37 3\n");
    scheduler.resolveAll();
    await expect(promise).rejects.toThrow(RelayHandshakeError);
    await expect(promise).rejects.toThrow(/never confirmed !CG 37 3/);
    expect(link.writes).not.toContain("!GO\n");
  });
});

describe("runRelayCommandPlane -- !GO timeout (SUC-003)", () => {
  it("rejects with a timeout if !GO never confirms, driven entirely by the fake scheduler", async () => {
    const link = fakeRelayLink();
    const scheduler = controllableScheduler();
    const promise = runRelayCommandPlane({ write: link.write, subscribe: link.subscribe, channel: 37, group: 3, scheduler });
    await flush(); link.emit(STATUS_37_3);
    await flush(); link.emit("# echo: OFF");
    await flush(); link.emit("# mode: RAW250");
    await flush(); link.emit(STATUS_37_3);
    await flush(); link.emit(STATUS_37_3);
    await flush();
    expect(link.writes.at(-1)).toBe("!GO\n");
    scheduler.resolveAll();
    await expect(promise).rejects.toThrow(RelayHandshakeError);
    await expect(promise).rejects.toThrow(/never confirmed !GO/);
  });

  it("never leaves the returned promise unresolved -- always settles, one way or another", async () => {
    const link = fakeRelayLink();
    const scheduler = controllableScheduler();
    const promise = runRelayCommandPlane({ write: link.write, subscribe: link.subscribe, channel: 25, group: 1, scheduler });
    await flush();
    let settled = false;
    promise.then(() => { settled = true; }, () => { settled = true; });
    for (let i = 0; i < 20; i++) { scheduler.resolveAll(); await flush(); }
    expect(settled).toBe(true);
  });
});

describe("runRelayCommandPlane -- AbortSignal (ticket 014-006, LineLink's preamble hook)", () => {
  it("rejects immediately with the signal's own abort reason if it is already aborted before the handshake starts", async () => {
    const link = fakeRelayLink();
    const scheduler = controllableScheduler();
    const controller = new AbortController();
    controller.abort(new Error("connect aborted before preamble started"));
    const promise = runRelayCommandPlane({
      write: link.write,
      subscribe: link.subscribe,
      channel: 37,
      group: 3,
      scheduler,
      signal: controller.signal,
    });
    await expect(promise).rejects.toThrow(/connect aborted before preamble started/);
    expect(link.writes).toEqual([]);
  });

  it("aborts within the current step -- never waiting out the rest of its timeoutMs -- when the signal fires mid-handshake", async () => {
    const link = fakeRelayLink();
    const scheduler = controllableScheduler();
    const controller = new AbortController();
    const promise = runRelayCommandPlane({
      write: link.write,
      subscribe: link.subscribe,
      channel: 37,
      group: 3,
      scheduler,
      signal: controller.signal,
    });
    await flush();
    link.emit(STATUS_37_3); // answers `?`
    await flush();
    link.emit("# echo: OFF"); // answers !ECHO OFF
    await flush();
    expect(link.writes.at(-1)).toBe("!MODE RAW250\n");

    // The signal fires while waiting for !MODE RAW250's own reply --
    // note `scheduler.resolveAll()` is never called here, so a rejection
    // can only be this abort, not the step's timeout firing.
    controller.abort(new Error("link closing mid-preamble"));
    await expect(promise).rejects.toThrow(/link closing mid-preamble/);
    expect(link.writes).not.toContain("!CG 37 3\n");
    expect(link.writes).not.toContain("!GO\n");
  });
});

describe("sync/setChannelGroup/go -- individually callable steps (ticket 014-006, rearch-10's future sweeper)", () => {
  it("sync() resolves once the relay answers `?`, without running any other preamble step", async () => {
    const link = fakeRelayLink();
    const scheduler = controllableScheduler();
    const promise = sync({ write: link.write, subscribe: link.subscribe, scheduler });
    await flush();
    expect(link.writes).toEqual(["?\n"]);
    link.emit(STATUS_37_3);
    await expect(promise).resolves.toBeUndefined();
    expect(link.writes).toEqual(["?\n"]);
  });

  it("setChannelGroup() sends !CG alone and resolves on its own confirmation, never sending !GO -- the sweeper's 'drive !CG without !GO' shape", async () => {
    const link = fakeRelayLink();
    const scheduler = controllableScheduler();
    const promise = setChannelGroup(37, 3, { write: link.write, subscribe: link.subscribe, scheduler });
    await flush();
    expect(link.writes).toEqual(["!CG 37 3\n"]);
    link.emit(STATUS_37_3);
    await expect(promise).resolves.toBeUndefined();
    expect(link.writes).not.toContain("!GO\n");
  });

  it("sync() invokes onStatusLine with the raw status reply (ticket 016-007's own capability-detection seam)", async () => {
    const link = fakeRelayLink();
    const scheduler = controllableScheduler();
    const seen: string[] = [];
    const promise = sync({
      write: link.write,
      subscribe: link.subscribe,
      scheduler,
      onStatusLine: (line) => seen.push(line),
    });
    await flush();
    link.emit("# channel: 47 group: 60 mode: RAW250 power: 7 caps: CGT");
    await expect(promise).resolves.toBeUndefined();
    expect(seen).toEqual(["# channel: 47 group: 60 mode: RAW250 power: 7 caps: CGT"]);
  });

  it("sync() never calls onStatusLine when it never syncs (gives up after configured attempts)", async () => {
    const link = fakeRelayLink();
    const scheduler = controllableScheduler();
    const seen: string[] = [];
    const promise = sync({
      write: link.write,
      subscribe: link.subscribe,
      scheduler,
      syncAttempts: 2,
      onStatusLine: (line) => seen.push(line),
    });
    for (let i = 0; i < 2; i++) {
      await flush();
      scheduler.resolveAll();
    }
    await expect(promise).rejects.toThrow(/never answered/);
    expect(seen).toEqual([]);
  });

  it("setChannelGroupTransient() sends !CGT alone and resolves on its own confirmation, never sending !GO", async () => {
    const link = fakeRelayLink();
    const scheduler = controllableScheduler();
    const promise = setChannelGroupTransient(37, 3, { write: link.write, subscribe: link.subscribe, scheduler });
    await flush();
    expect(link.writes).toEqual(["!CGT 37 3\n"]);
    link.emit(STATUS_37_3);
    await expect(promise).resolves.toBeUndefined();
    expect(link.writes).not.toContain("!GO\n");
  });

  it("setChannelGroupTransient() rejects on a # error reply, mirroring setChannelGroup()'s own rejection handling", async () => {
    const link = fakeRelayLink();
    const scheduler = controllableScheduler();
    const promise = setChannelGroupTransient(37, 3, { write: link.write, subscribe: link.subscribe, scheduler });
    await flush();
    link.emit("# error: usage !CGT <ch 25-73> <group 1-126>");
    await expect(promise).rejects.toThrow(RelayHandshakeError);
    await expect(promise).rejects.toThrow(/rejected !CGT 37 3/);
  });

  it("go() sends !GO alone and resolves once the relay confirms entering the data plane", async () => {
    const link = fakeRelayLink();
    const scheduler = controllableScheduler();
    const promise = go({ write: link.write, subscribe: link.subscribe, scheduler });
    await flush();
    expect(link.writes).toEqual(["!GO\n"]);
    link.emit("# entering data plane");
    await expect(promise).resolves.toBeUndefined();
  });
});

describe("probeRadioId -- sprint 016 ticket 003's own sweep probe step", () => {
  it("sends '> ID' and resolves true once a matching '< id ...' reply arrives, never sending !GO or HELLO", async () => {
    const link = fakeRelayLink();
    const scheduler = controllableScheduler();
    const promise = probeRadioId("vevov", { write: link.write, subscribe: link.subscribe, scheduler });
    await flush();
    expect(link.writes).toEqual(["> ID\n"]);
    link.emit("< id diffdrive vevov 1.0.10 vevov");
    await expect(promise).resolves.toBe(true);
    expect(link.writes).not.toContain("!GO\n");
    expect(link.writes.some((w) => w.startsWith("HELLO"))).toBe(false);
  });

  it("ignores a reply for a different name, then resolves true once the matching one arrives", async () => {
    const link = fakeRelayLink();
    const scheduler = controllableScheduler();
    const promise = probeRadioId("vevov", { write: link.write, subscribe: link.subscribe, scheduler });
    await flush();
    link.emit("< id diffdrive tovez 1.0.10 tovez"); // a different robot answering on the same channel
    link.emit("< id diffdrive vevov 1.0.10 vevov");
    await expect(promise).resolves.toBe(true);
  });

  it("resolves false on timeout when no reply arrives within timeoutMs -- a candidate that does not answer, not a handshake failure", async () => {
    const link = fakeRelayLink();
    const scheduler = controllableScheduler();
    const promise = probeRadioId("vevov", { write: link.write, subscribe: link.subscribe, scheduler, timeoutMs: 500 });
    await flush();
    expect(link.writes).toEqual(["> ID\n"]);
    scheduler.resolveAll();
    await expect(promise).resolves.toBe(false);
  });

  it("defaults to a 500ms timeout when none is given", async () => {
    const link = fakeRelayLink();
    const scheduler = controllableScheduler();
    const promise = probeRadioId("vevov", { write: link.write, subscribe: link.subscribe, scheduler });
    await flush();
    scheduler.resolveAll();
    await expect(promise).resolves.toBe(false);
  });

  it("rejects immediately with the signal's own abort reason when already aborted before the probe starts, never sending '> ID'", async () => {
    const link = fakeRelayLink();
    const scheduler = controllableScheduler();
    const controller = new AbortController();
    controller.abort(new Error("probe aborted before it started"));
    await expect(
      probeRadioId("vevov", { write: link.write, subscribe: link.subscribe, scheduler, signal: controller.signal }),
    ).rejects.toThrow(/probe aborted before it started/);
    expect(link.writes).toEqual([]);
  });
});
