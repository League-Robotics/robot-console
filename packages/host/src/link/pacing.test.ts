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
});
