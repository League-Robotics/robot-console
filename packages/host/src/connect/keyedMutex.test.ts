import { describe, expect, it } from "vitest";
import { KeyedMutex } from "./keyedMutex.js";

// Salvaged from `deviceRegistry.test.ts`'s own "KeyedMutex" suite
// (sprint 7), plus a new test for this ticket's own `.tails` pruning
// fix (`docs/reviews/2026-09-11/01-host-device-model.md` §7).

describe("KeyedMutex", () => {
  it("serializes two run() calls sharing one resourceKey regardless of which logical caller issued them", async () => {
    const mutex = new KeyedMutex();
    const order: string[] = [];
    const RELAY_PORT_RESOURCE_KEY = "usb-RELAY-SERIAL";

    // "robot-a" and "robot-b" stand in for two logical targets reached
    // through one relay -- both contend for the relay's one physical
    // USB port, so both run() calls below share one resourceKey even
    // though nothing else about them is related.
    const robotATask = mutex.run(RELAY_PORT_RESOURCE_KEY, async () => {
      order.push("robot-a-start");
      await new Promise((resolve) => setTimeout(resolve, 10));
      order.push("robot-a-end");
    });
    const robotBTask = mutex.run(RELAY_PORT_RESOURCE_KEY, async () => {
      order.push("robot-b-start");
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push("robot-b-end");
    });

    await Promise.all([robotATask, robotBTask]);

    // robot-b's task never starts until robot-a's fully finishes -- the
    // guarantee every connector call under a shared board_owner/
    // relay_leases resourceKey relies on.
    expect(order).toEqual(["robot-a-start", "robot-a-end", "robot-b-start", "robot-b-end"]);
  });

  it("runs tasks under different resourceKeys fully in parallel", async () => {
    const mutex = new KeyedMutex();
    const order: string[] = [];

    const taskA = mutex.run("usb-SERIAL-A", async () => {
      order.push("a-start");
      await new Promise((resolve) => setTimeout(resolve, 10));
      order.push("a-end");
    });
    const taskB = mutex.run("usb-SERIAL-B", async () => {
      order.push("b-start");
      await new Promise((resolve) => setTimeout(resolve, 1));
      order.push("b-end");
    });

    await Promise.all([taskA, taskB]);

    // b (shorter delay, different key) finishes before a even though a
    // started first -- proof the two keys never queue behind each other.
    expect(order).toEqual(["a-start", "b-start", "b-end", "a-end"]);
  });

  it("a rejecting task does not wedge a later task queued under the same key", async () => {
    const mutex = new KeyedMutex();
    const order: string[] = [];

    const failing = mutex.run("shared-key", async () => {
      order.push("failing");
      throw new Error("boom");
    });
    const following = mutex.run("shared-key", async () => {
      order.push("following");
    });

    await expect(failing).rejects.toThrow("boom");
    await following;
    expect(order).toEqual(["failing", "following"]);
  });

  it("prunes a resource key's tail once its chain settles and nothing newer has replaced it (review §7 fix)", async () => {
    const mutex = new KeyedMutex();

    await mutex.run("usb-SERIAL-A", async () => {});
    // Give the tail's own cleanup microtask a chance to run.
    await Promise.resolve();
    await Promise.resolve();

    expect(mutex.size).toBe(0);
  });

  it("does not prune a key while a newer run() call is still queued behind an older, already-settled one", async () => {
    const mutex = new KeyedMutex();
    const order: string[] = [];

    // Built before either run() call so `releaseFirst` is assigned
    // synchronously, up front -- run()'s task itself does not start
    // executing until at least one microtask later (it is always
    // reached via `previous.then(task)`), so assigning inside the task
    // closure would race this test's own synchronous code below.
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = mutex.run("shared-key", async () => {
      order.push("first-start");
      await gate;
      order.push("first-end");
    });
    // Queue the second call before the first has resolved -- the tail
    // map must still hold an entry for "shared-key" while this is
    // pending, even though the *first* call's own tail settles and
    // fires its cleanup check before the second call is done.
    const second = mutex.run("shared-key", async () => {
      order.push("second-start");
    });

    expect(mutex.size).toBe(1);
    releaseFirst();
    await Promise.all([first, second]);

    expect(order).toEqual(["first-start", "first-end", "second-start"]);
    // Both calls are done and settled -- the map prunes back to empty,
    // not stuck non-empty forever.
    await Promise.resolve();
    await Promise.resolve();
    expect(mutex.size).toBe(0);
  });
});
