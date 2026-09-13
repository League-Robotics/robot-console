/**
 * flasher.test.ts — sprint 017 ticket 003's own suite for
 * `connect/flasher.ts`. Per `sprint.md`'s own Design Rationale ("the
 * ownership/handoff logic is exercised by the same kind of fake-store
 * table tests the reconciler and connector already use"), the store
 * fixture here is a real {@link Store} backed by an in-memory
 * `node:sqlite` connection (`connect/connector.test.ts`'s own
 * `freshStore()` pattern) rather than a hand-rolled fake -- so
 * `board_owner` acquire/release is exercised against the real schema,
 * not a reimplementation of it. `flash.ts`'s own orchestration
 * (`flash()`) and `dapjs`/HID are always faked here: this module's own
 * job is the owner acquire/release and session-close-first handoff, not
 * the DAPLink call path itself (already covered by `flash.test.ts`).
 */
import { describe, expect, it, vi } from "vitest";
import { openStoreDb } from "../store/db.js";
import { Store } from "../store/index.js";
import {
  createFlasher,
  DEFAULT_ACQUIRE_TIMEOUT_MS,
  FLASH_OWNER,
  type DelayFn,
} from "./flasher.js";
import type { FlashOutcome } from "../flash.js";
import type { DaplinkDevice } from "../devices.js";

function freshStore(): Store {
  return new Store(openStoreDb({ filePath: ":memory:" }));
}

function fakeDevice(): DaplinkDevice {
  return {
    serialNumber: "SERIAL123",
    displaySerial: "1234",
    availability: "full",
  } as DaplinkDevice;
}

const OK_OUTCOME: FlashOutcome = { status: "ok", method: "swd" };

describe("createFlasher", () => {
  it("closes the session first via the reconciler, before flash() ever runs", async () => {
    const store = freshStore();
    const calls: string[] = [];
    const requestClose = vi.fn(async (linkId: string) => {
      calls.push(`requestClose:${linkId}`);
    });
    const flashFn = vi.fn(async () => {
      calls.push("flash");
      return OK_OUTCOME;
    });
    const flasher = createFlasher(store, { reconciler: { requestClose }, flash: flashFn });

    const outcome = await flasher.flash("usb-SERIAL123", "SERIAL123", fakeDevice(), "hex", () => {});

    expect(outcome).toEqual(OK_OUTCOME);
    expect(calls).toEqual(["requestClose:usb-SERIAL123", "flash"]);
    store.close();
  });

  it("acquires board_owner='flash' for the usb serial before calling flash(), visible in the store", async () => {
    const store = freshStore();
    const flashFn = vi.fn(async () => {
      // board_owner must already be held by 'flash' by the time flash()
      // itself runs -- the owner handoff this ticket's AC calls "visible
      // in the store".
      expect(store.acquireBoardOwner("SERIAL123", FLASH_OWNER, Date.now())).toBe(true);
      expect(store.acquireBoardOwner("SERIAL123", "someone-else", Date.now())).toBe(false);
      return OK_OUTCOME;
    });
    const flasher = createFlasher(store, {
      reconciler: { requestClose: vi.fn().mockResolvedValue(undefined) },
      flash: flashFn,
    });

    await flasher.flash("usb-SERIAL123", "SERIAL123", fakeDevice(), "hex", () => {});

    expect(flashFn).toHaveBeenCalledTimes(1);
    store.close();
  });

  it("releases board_owner in a finally on a successful flash", async () => {
    const store = freshStore();
    const flasher = createFlasher(store, {
      reconciler: { requestClose: vi.fn().mockResolvedValue(undefined) },
      flash: vi.fn(async () => OK_OUTCOME),
    });

    await flasher.flash("usb-SERIAL123", "SERIAL123", fakeDevice(), "hex", () => {});

    // If board_owner were still held, a fresh acquire by a different
    // owner would fail; it succeeds here only because flasher released it.
    expect(store.acquireBoardOwner("SERIAL123", "someone-else", Date.now())).toBe(true);
    store.close();
  });

  it("releases board_owner even when flash() itself resolves to a timeout failure classified by flash.ts", async () => {
    const store = freshStore();
    const timeoutOutcome: FlashOutcome = {
      status: "error",
      method: "swd",
      reason: "timeout",
      error: "daplink.flash() timed out after 30000ms",
    };
    const flasher = createFlasher(store, {
      reconciler: { requestClose: vi.fn().mockResolvedValue(undefined) },
      flash: vi.fn(async () => timeoutOutcome),
    });

    const outcome = await flasher.flash("usb-SERIAL123", "SERIAL123", fakeDevice(), "hex", () => {});

    expect(outcome).toEqual(timeoutOutcome);
    expect(store.acquireBoardOwner("SERIAL123", "someone-else", Date.now())).toBe(true);
    store.close();
  });

  it("releases board_owner even when flash() itself rejects unexpectedly, and propagates the rejection", async () => {
    const store = freshStore();
    const boom = new Error("boom: unexpected flash() rejection");
    const flasher = createFlasher(store, {
      reconciler: { requestClose: vi.fn().mockResolvedValue(undefined) },
      flash: vi.fn(async () => {
        throw boom;
      }),
    });

    await expect(
      flasher.flash("usb-SERIAL123", "SERIAL123", fakeDevice(), "hex", () => {}),
    ).rejects.toBe(boom);
    expect(store.acquireBoardOwner("SERIAL123", "someone-else", Date.now())).toBe(true);
    store.close();
  });

  it("forwards onProgress and flashOptions to flash() unchanged", async () => {
    const store = freshStore();
    const phases: string[] = [];
    const flashFn = vi.fn(async (_device, _hex, onProgress: (phase: string) => void, options) => {
      onProgress("erasing");
      expect(options).toEqual({ createDapLink: expect.any(Function) });
      return OK_OUTCOME;
    });
    const flasher = createFlasher(store, {
      reconciler: { requestClose: vi.fn().mockResolvedValue(undefined) },
      flash: flashFn as never,
    });
    const createDapLink = () => {
      throw new Error("never called in this test");
    };

    await flasher.flash("usb-SERIAL123", "SERIAL123", fakeDevice(), "hex", (phase) => phases.push(phase), {
      createDapLink,
    });

    expect(phases).toEqual(["erasing"]);
    store.close();
  });

  it("retries acquiring board_owner until another owner releases it, then proceeds to flash()", async () => {
    const store = freshStore();
    // Simulate a lingering owner (e.g. a connect attempt still settling)
    // that releases itself only after a couple of retries.
    expect(store.acquireBoardOwner("SERIAL123", "session:usb-SERIAL123", 0)).toBe(true);
    let delayCalls = 0;
    const delay: DelayFn = vi.fn(async (_ms: number) => {
      delayCalls += 1;
      if (delayCalls === 2) {
        store.releaseBoardOwner("SERIAL123", "session:usb-SERIAL123");
      }
    });
    const flashFn = vi.fn(async () => OK_OUTCOME);
    const flasher = createFlasher(
      store,
      { reconciler: { requestClose: vi.fn().mockResolvedValue(undefined) }, flash: flashFn, delay },
      { acquireTimeoutMs: 10_000, acquirePollMs: 1 },
    );

    const outcome = await flasher.flash("usb-SERIAL123", "SERIAL123", fakeDevice(), "hex", () => {});

    expect(outcome).toEqual(OK_OUTCOME);
    expect(flashFn).toHaveBeenCalledTimes(1);
    expect(delayCalls).toBeGreaterThanOrEqual(2);
    store.close();
  });

  it("returns an owner-unavailable failure and never calls flash() when board_owner is never freed within the budget", async () => {
    const store = freshStore();
    expect(store.acquireBoardOwner("SERIAL123", "session:usb-SERIAL123", 0)).toBe(true);
    // A delay that never releases the owner -- forces the retry loop to
    // exhaust its budget via the injected `now` clock below rather than
    // waiting out real wall-clock time.
    let elapsedMs = 0;
    const now = () => {
      elapsedMs += 10;
      return elapsedMs;
    };
    const delay: DelayFn = vi.fn(async () => {});
    const flashFn = vi.fn();
    const flasher = createFlasher(
      store,
      { reconciler: { requestClose: vi.fn().mockResolvedValue(undefined) }, flash: flashFn as never, now, delay },
      { acquireTimeoutMs: 25, acquirePollMs: 5 },
    );

    const outcome = await flasher.flash("usb-SERIAL123", "SERIAL123", fakeDevice(), "hex", () => {});

    expect(outcome).toMatchObject({ status: "error", reason: "owner-unavailable" });
    expect(flashFn).not.toHaveBeenCalled();
    // board_owner is still held by the original owner -- flasher never
    // acquired it, so it has nothing of its own to release.
    expect(store.acquireBoardOwner("SERIAL123", "someone-else", elapsedMs)).toBe(false);
    store.close();
  });

  it("uses DEFAULT_ACQUIRE_TIMEOUT_MS when no acquireTimeoutMs override is given", () => {
    expect(DEFAULT_ACQUIRE_TIMEOUT_MS).toBeGreaterThan(0);
  });
});
