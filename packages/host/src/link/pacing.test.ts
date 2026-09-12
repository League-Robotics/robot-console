import { describe, expect, it } from "vitest";
import { WritePacer, type Scheduler } from "./pacing.js";

// Moved verbatim out of UsbSerialLink.test.ts (sprint 4 ticket 002) --
// no behavior change, import path only.

/** A scheduler that records every `delay()` call and its argument,
 * resolving immediately so no test needs a real wall-clock wait. */
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

/** Flush pending microtasks so a `WritePacer` chain has settled before
 * assertions run. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

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

  it("a throwing write with no onError is swallowed exactly as before -- backward compatible", async () => {
    const scheduler = recordingScheduler();
    const pacer = new WritePacer(10, scheduler);

    expect(() => {
      pacer.schedule(() => {
        throw new Error("boom");
      });
    }).not.toThrow();

    await flush(); // the rejection settles asynchronously; must not become an unhandled rejection
  });

  // Ticket 014-005 / review 02-host-transport.md S5.8, S6: "write
  // failures are invisible ... have schedule() accept an async write
  // and report failures via a callback instead of swallowing."
  describe("async write + onError (ticket 014-005)", () => {
    it("accepts a write that returns a Promise, pacing it the same as a synchronous one", async () => {
      const scheduler = recordingScheduler();
      const pacer = new WritePacer(10, scheduler);
      const order: string[] = [];

      pacer.schedule(() => Promise.resolve().then(() => order.push("a")));
      pacer.schedule(() => order.push("b"));

      await flush();

      expect(order).toEqual(["a", "b"]);
      expect(scheduler.calls).toEqual([10, 10]);
    });

    it("reports a rejected async write's failure via onError instead of swallowing it", async () => {
      const scheduler = recordingScheduler();
      const pacer = new WritePacer(10, scheduler);
      const errors: Error[] = [];
      const boom = new Error("EPIPE");

      pacer.schedule(() => Promise.reject(boom), (err) => errors.push(err));

      await flush();

      expect(errors).toEqual([boom]);
    });

    it("reports a synchronously throwing write's failure via onError when one is given", async () => {
      const scheduler = recordingScheduler();
      const pacer = new WritePacer(10, scheduler);
      const errors: Error[] = [];

      pacer.schedule(
        () => {
          throw new Error("boom");
        },
        (err) => errors.push(err),
      );

      await flush();

      expect(errors).toHaveLength(1);
      expect(errors[0]?.message).toBe("boom");
    });

    it("a failing write does not wedge a later scheduled write, whether or not onError is given", async () => {
      const scheduler = recordingScheduler();
      const pacer = new WritePacer(10, scheduler);
      const order: string[] = [];
      const errors: Error[] = [];

      pacer.schedule(() => Promise.reject(new Error("first failed")), (err) => errors.push(err));
      pacer.schedule(() => order.push("still runs"));

      await flush();

      expect(order).toEqual(["still runs"]);
      expect(errors).toHaveLength(1);
    });
  });
});
