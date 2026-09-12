import { describe, expect, it } from "vitest";
import { TimeoutError, withTimeout } from "./withTimeout.js";

describe("withTimeout", () => {
  it("resolves with the promise's own value when it settles before the deadline", async () => {
    const result = await withTimeout(Promise.resolve("value"), 1000, "test");
    expect(result).toBe("value");
  });

  it("rejects with the promise's own error when it rejects before the deadline", async () => {
    const boom = new Error("boom");
    await expect(withTimeout(Promise.reject(boom), 1000, "test")).rejects.toBe(boom);
  });

  it("rejects with a TimeoutError labeled with the given label when the deadline fires first", async () => {
    const neverSettles = new Promise<void>(() => {});
    await expect(withTimeout(neverSettles, 5, "my-op")).rejects.toThrow(TimeoutError);
    await expect(withTimeout(neverSettles, 5, "my-op")).rejects.toMatchObject({
      name: "TimeoutError",
      label: "my-op",
      ms: 5,
    });
  });

  it("includes the label and ms in the TimeoutError's own message", async () => {
    const neverSettles = new Promise<void>(() => {});
    await expect(withTimeout(neverSettles, 5, "daplink.connect()")).rejects.toThrow(
      /daplink\.connect\(\) timed out after 5ms/,
    );
  });

  it("never fires the timer once the promise has already settled (no dangling rejection)", async () => {
    // Regression guard for a timer that isn't cleared -- if `withTimeout`
    // failed to clear it, this would be an unhandled rejection later.
    const result = await withTimeout(Promise.resolve("fast"), 5, "test");
    expect(result).toBe("fast");
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
});
