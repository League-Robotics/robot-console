import { describe, expect, it, vi } from "vitest";
import { nameToRadioAddress } from "@robot-console/protocol";
import {
  DEFAULT_TIMEOUT_MS,
  resolveRobotAddress,
  type FetchFn,
  type MbrelayRegistryFetchResponse,
  type ResolvedAddress,
} from "./mbrelayRegistry.js";
import type { Scheduler } from "./link/pacing.js";

// Every test injects its own `cache` (a fresh `Map`) so TTL state never
// leaks between test cases -- see mbrelayRegistry.ts's own doc comment
// ("Short TTL cache"). Every test also injects `now` for deterministic
// TTL-boundary control, and a `scheduler` whose `delay()` is driven
// explicitly rather than a real timer -- same technique
// `RelayCommandPlane.test.ts` already established -- so the timeout
// path never waits on real wall-clock time.

const REGISTRY = { host: "torture.local", port: 8761 };

function jsonResponse(status: number, body: unknown): MbrelayRegistryFetchResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

/** A `Scheduler` whose `delay()` never resolves on its own -- a test
 * drives the timeout deterministically via {@link controllableScheduler}'s
 * `fireAll`, so nothing in this file ever waits on a real timer.
 * Mirrors `RelayCommandPlane.test.ts`'s own `controllableScheduler`. */
function controllableScheduler(): Scheduler & { fireAll: () => void } {
  const resolvers: Array<() => void> = [];
  return {
    delay: (_ms: number) =>
      new Promise<void>((resolve) => {
        resolvers.push(resolve);
      }),
    fireAll: () => {
      const pending = resolvers.splice(0, resolvers.length);
      for (const resolve of pending) {
        resolve();
      }
    },
  };
}

/** A scheduler whose `delay()` never fires -- used whenever a test
 * expects the fetch to win the race well before any timeout matters. */
function neverFiringScheduler(): Scheduler {
  return { delay: () => new Promise<void>(() => {}) };
}

describe("resolveRobotAddress", () => {
  it("yields outcome config/registry for the registry's actual-hit response shape", async () => {
    const fetchFn = vi.fn<FetchFn>(async (url, init) => {
      expect(url).toBe("http://torture.local:8761/names/zuzuv");
      expect(init).toEqual({ method: "GET" });
      return jsonResponse(200, { channel: 41, group: 6, source: "registry" });
    });

    const result = await resolveRobotAddress("zuzuv", REGISTRY, {
      fetch: fetchFn,
      scheduler: neverFiringScheduler(),
      cache: new Map(),
    });

    expect(result).toEqual<ResolvedAddress>({ channel: 41, group: 6, outcome: "registry" });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("yields outcome config for a statically-configured hit", async () => {
    const fetchFn = vi.fn<FetchFn>(async () => jsonResponse(200, { channel: 41, group: 6, source: "config" }));

    const result = await resolveRobotAddress("zuzuv", REGISTRY, {
      fetch: fetchFn,
      scheduler: neverFiringScheduler(),
      cache: new Map(),
    });

    expect(result).toEqual<ResolvedAddress>({ channel: 41, group: 6, outcome: "config" });
  });

  it("yields outcome derived, distinguished from an actual hit even with the same channel/group", async () => {
    const fetchFn = vi.fn<FetchFn>(async () => jsonResponse(200, { channel: 41, group: 6, source: "derived" }));

    const result = await resolveRobotAddress("zuzuv", REGISTRY, {
      fetch: fetchFn,
      scheduler: neverFiringScheduler(),
      cache: new Map(),
    });

    // Same numeric address as the actual-hit test above, but the
    // outcome tag must differ -- asserting the full object (not just
    // channel/group) is the point of this test.
    expect(result).toEqual<ResolvedAddress>({ channel: 41, group: 6, outcome: "derived" });
    expect(result.outcome).not.toBe("registry");
  });

  it("falls back to local-derived, computed via nameToRadioAddress, when the registry call times out", async () => {
    const fetchFn = vi.fn<FetchFn>(() => new Promise(() => {})); // never resolves/rejects
    const scheduler = controllableScheduler();

    const pending = resolveRobotAddress("zuzuv", REGISTRY, {
      fetch: fetchFn,
      scheduler,
      cache: new Map(),
    });
    scheduler.fireAll(); // simulate the ~1.5s client-side timeout elapsing

    const result = await pending;

    expect(result).toEqual<ResolvedAddress>({ ...nameToRadioAddress("zuzuv"), outcome: "local-derived" });
  });

  it("falls back to local-derived when the fetch rejects with a network error", async () => {
    const fetchFn = vi.fn<FetchFn>(async () => {
      throw new Error("getaddrinfo ENOTFOUND torture.local");
    });

    const result = await resolveRobotAddress("zuzuv", REGISTRY, {
      fetch: fetchFn,
      scheduler: neverFiringScheduler(),
      cache: new Map(),
    });

    expect(result).toEqual<ResolvedAddress>({ ...nameToRadioAddress("zuzuv"), outcome: "local-derived" });
  });

  it("falls back to local-derived on a malformed response body", async () => {
    const fetchFn = vi.fn<FetchFn>(async () => jsonResponse(200, { unexpected: "shape" }));

    const result = await resolveRobotAddress("zuzuv", REGISTRY, {
      fetch: fetchFn,
      scheduler: neverFiringScheduler(),
      cache: new Map(),
    });

    expect(result).toEqual<ResolvedAddress>({ ...nameToRadioAddress("zuzuv"), outcome: "local-derived" });
  });

  it("falls back to local-derived on a non-OK HTTP status", async () => {
    const fetchFn = vi.fn<FetchFn>(async () => jsonResponse(500, { error: "internal" }));

    const result = await resolveRobotAddress("zuzuv", REGISTRY, {
      fetch: fetchFn,
      scheduler: neverFiringScheduler(),
      cache: new Map(),
    });

    expect(result).toEqual<ResolvedAddress>({ ...nameToRadioAddress("zuzuv"), outcome: "local-derived" });
  });

  it("never throws, resolving to local-derived, when no registry host/port is supplied at all", async () => {
    const fetchFn = vi.fn<FetchFn>(async () => jsonResponse(200, { channel: 1, group: 1, source: "registry" }));

    const result = await resolveRobotAddress("zuzuv", undefined, {
      fetch: fetchFn,
      scheduler: neverFiringScheduler(),
      cache: new Map(),
    });

    expect(result).toEqual<ResolvedAddress>({ ...nameToRadioAddress("zuzuv"), outcome: "local-derived" });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("caches a resolution for the TTL window: a second call within it makes no further fetch call", async () => {
    const fetchFn = vi.fn<FetchFn>(async () => jsonResponse(200, { channel: 41, group: 6, source: "registry" }));
    let currentTime = 0;
    const cache = new Map();

    const first = await resolveRobotAddress("zuzuv", REGISTRY, {
      fetch: fetchFn,
      scheduler: neverFiringScheduler(),
      cache,
      now: () => currentTime,
      ttlMs: 2000,
    });
    currentTime += 1000; // still within the 2000ms TTL window
    const second = await resolveRobotAddress("zuzuv", REGISTRY, {
      fetch: fetchFn,
      scheduler: neverFiringScheduler(),
      cache,
      now: () => currentTime,
      ttlMs: 2000,
    });

    expect(first).toEqual<ResolvedAddress>({ channel: 41, group: 6, outcome: "registry" });
    expect(second).toEqual(first);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("issues a second fetch after the TTL window expires", async () => {
    const fetchFn = vi.fn<FetchFn>(async () => jsonResponse(200, { channel: 41, group: 6, source: "registry" }));
    let currentTime = 0;
    const cache = new Map();

    await resolveRobotAddress("zuzuv", REGISTRY, {
      fetch: fetchFn,
      scheduler: neverFiringScheduler(),
      cache,
      now: () => currentTime,
      ttlMs: 2000,
    });
    currentTime += 2001; // past the 2000ms TTL window
    await resolveRobotAddress("zuzuv", REGISTRY, {
      fetch: fetchFn,
      scheduler: neverFiringScheduler(),
      cache,
      now: () => currentTime,
      ttlMs: 2000,
    });

    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("only ever issues a GET -- never POST/DELETE", async () => {
    const fetchFn = vi.fn<FetchFn>(async (_url, init) => {
      expect(init.method).toBe("GET");
      return jsonResponse(200, { channel: 41, group: 6, source: "registry" });
    });

    await resolveRobotAddress("zuzuv", REGISTRY, {
      fetch: fetchFn,
      scheduler: neverFiringScheduler(),
      cache: new Map(),
    });

    expect(fetchFn).toHaveBeenCalledWith("http://torture.local:8761/names/zuzuv", { method: "GET" });
  });

  it("uses ~1.5s as the default client-side timeout", () => {
    expect(DEFAULT_TIMEOUT_MS).toBe(1500);
  });
});
