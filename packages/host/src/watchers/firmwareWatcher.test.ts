import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openStoreDb } from "../store/db.js";
import { Store } from "../store/index.js";
import type { FirmwareSource } from "../config.js";
import {
  startFirmwareWatcher,
  GITHUB_TOKEN_SETTINGS_KEY,
  type FirmwareFetchFn,
  type FirmwareHttpResponse,
} from "./firmwareWatcher.js";

// Sprint 017 ticket 002's own suite: every seam (fetch, clock, env,
// firmware config) is injected -- no real network call and no real
// wall-clock wait anywhere here. Fake timers throughout, advanced with
// `vi.advanceTimersByTimeAsync` so the watcher's own promise chains
// (resolveRelease -> capture -> store write -> reschedule) settle
// between ticks, mirroring `mdnsWatcher.test.ts`'s own convention.

function freshStore(): Store {
  return new Store(openStoreDb({ filePath: ":memory:" }));
}

const ROBOT_SOURCE: FirmwareSource = {
  repoUrl: "https://github.com/League-Robotics/pxt-nezha-diffdrive",
  tag: "latest",
};
const RELAY_SOURCE: FirmwareSource = {
  repoUrl: "https://github.com/League-Robotics/microbit-radio-relay",
  tag: "latest",
};
// Sprint 023 ticket 003: joystick is a third FIRMWARE_KINDS entry now
// that ticket 001 widened FirmwareKind -- this fixture only exists to
// prove the watcher schedules a third independent poll timer for it.
// The real ROBOT_CONSOLE_JOYSTICK_FIRMWARE .env value stays unset until
// ticket 007, once the joystick repo actually ships MICROBIT.hex.
const JOYSTICK_SOURCE: FirmwareSource = {
  repoUrl: "https://github.com/League-Robotics/pxt-joystick",
  tag: "latest",
};

const VALID_ASSETS = [{ name: "MICROBIT.hex" }, { name: "MICROBIT.hex.txt" }];

function githubHeaders(extra: Record<string, string> = {}): { get(name: string): string | null } {
  const lower = new Map(Object.entries(extra).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    get(name: string): string | null {
      return lower.get(name.toLowerCase()) ?? null;
    },
  };
}

/** A successful (2xx) release-lookup response carrying `assets`. */
function releaseResponse(
  tag: string,
  assets: Array<{ name: string; url?: string }>,
  responseHeaders: Record<string, string> = {},
): FirmwareHttpResponse {
  const body = {
    tag_name: tag,
    assets: assets.map((a) => ({ name: a.name, browser_download_url: a.url ?? `https://example.test/${a.name}` })),
  };
  return {
    ok: true,
    status: 200,
    json: async () => body,
    arrayBuffer: async () => {
      throw new Error("arrayBuffer() not expected on a release-lookup response");
    },
    text: async () => JSON.stringify(body),
    headers: githubHeaders(responseHeaders),
  };
}

/** A non-2xx, non-404 response (304/403/429/500) -- `resolveRelease`
 * never calls `.json()`/`.text()` for any of these, so both throw if
 * invoked, catching a regression that would parse a body it shouldn't. */
function statusOnlyResponse(status: number, responseHeaders: Record<string, string> = {}): FirmwareHttpResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      throw new Error(`json() should not be called for HTTP ${status}`);
    },
    arrayBuffer: async () => {
      throw new Error(`arrayBuffer() should not be called for HTTP ${status}`);
    },
    text: async () => {
      throw new Error(`text() should not be called for HTTP ${status}`);
    },
    headers: githubHeaders(responseHeaders),
  };
}

function robotOnlyConfig(): { relay: undefined; robot: FirmwareSource } {
  return { relay: undefined, robot: ROBOT_SOURCE };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("startFirmwareWatcher -- conditional GET / etag", () => {
  it("sends If-None-Match from the previously stored etag", async () => {
    const store = freshStore();
    store.setFirmware({ kind: "robot", repo: ROBOT_SOURCE.repoUrl, tag: "v0", available: true, etag: '"prev-etag"', checkedAt: 1 });

    const fetchFn: FirmwareFetchFn = vi.fn(async (_url, init) => {
      expect(init?.headers?.["If-None-Match"]).toBe('"prev-etag"');
      return statusOnlyResponse(304);
    });

    const handle = startFirmwareWatcher(store, { fetch: fetchFn, config: robotOnlyConfig() });
    await vi.advanceTimersByTimeAsync(0);
    handle.stop();

    expect(fetchFn).toHaveBeenCalled();
  });

  it("a 304 leaves the firmware row untouched and never parses a response body", async () => {
    const store = freshStore();
    store.setFirmware({ kind: "robot", repo: ROBOT_SOURCE.repoUrl, tag: "v0", available: true, etag: '"prev-etag"', checkedAt: 1 });
    const setFirmwareSpy = vi.spyOn(store, "setFirmware");

    const fetchFn: FirmwareFetchFn = vi.fn(async () => statusOnlyResponse(304));
    const handle = startFirmwareWatcher(store, { fetch: fetchFn, config: robotOnlyConfig() });
    await vi.advanceTimersByTimeAsync(0);
    handle.stop();

    const robotWrites = setFirmwareSpy.mock.calls.filter(([input]) => input.kind === "robot");
    expect(robotWrites).toHaveLength(0);
  });

  it("stores the response ETag from a fresh 200 for the next poll's If-None-Match", async () => {
    const store = freshStore();
    const fetchFn: FirmwareFetchFn = vi.fn(async () => releaseResponse("v1", VALID_ASSETS, { etag: '"new-etag"' }));

    const handle = startFirmwareWatcher(store, { fetch: fetchFn, config: robotOnlyConfig() });
    await vi.advanceTimersByTimeAsync(0);
    handle.stop();

    expect(store.getFirmwareEtag("robot")).toBe('"new-etag"');
  });
});

describe("startFirmwareWatcher -- writes only on change", () => {
  it("a fresh 200 with a new tag writes the row", async () => {
    const store = freshStore();
    const fetchFn: FirmwareFetchFn = vi.fn(async () => releaseResponse("v1", VALID_ASSETS));

    const handle = startFirmwareWatcher(store, { fetch: fetchFn, config: robotOnlyConfig() });
    await vi.advanceTimersByTimeAsync(0);
    handle.stop();

    const row = store.projectionRows().firmware.find((f) => f.kind === "robot");
    expect(row).toMatchObject({ tag: "v1", available: true, reason: null });
  });

  it("never re-writes the row when repeated polls resolve to the same content", async () => {
    const store = freshStore();
    const setFirmwareSpy = vi.spyOn(store, "setFirmware");
    const fetchFn: FirmwareFetchFn = vi.fn(async () => releaseResponse("v1", VALID_ASSETS));

    const handle = startFirmwareWatcher(
      store,
      { fetch: fetchFn, config: robotOnlyConfig() },
      { pollIntervalMs: 1000 },
    );
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);
    handle.stop();

    const robotWrites = setFirmwareSpy.mock.calls.filter(([input]) => input.kind === "robot");
    expect(robotWrites).toHaveLength(1);
    expect(fetchFn.mock.calls.length).toBeGreaterThanOrEqual(3);
  });
});

describe("startFirmwareWatcher -- 403/429 backoff", () => {
  it("honours Retry-After and never overwrites the row with a rate-limit failure", async () => {
    const store = freshStore();
    const setFirmwareSpy = vi.spyOn(store, "setFirmware");
    const fetchFn: FirmwareFetchFn = vi.fn(async () => statusOnlyResponse(403, { "retry-after": "120" }));

    const handle = startFirmwareWatcher(store, { fetch: fetchFn, config: robotOnlyConfig() });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchFn).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(119_000);
    expect(fetchFn).toHaveBeenCalledTimes(1); // not yet -- Retry-After: 120s has not elapsed

    await vi.advanceTimersByTimeAsync(1_000); // total 120s
    expect(fetchFn).toHaveBeenCalledTimes(2);
    handle.stop();

    const robotWrites = setFirmwareSpy.mock.calls.filter(([input]) => input.kind === "robot");
    expect(robotWrites).toHaveLength(0);
  });

  it("backs off exponentially, capped at 1 hour, when no Retry-After is present", async () => {
    const store = freshStore();
    const fetchFn: FirmwareFetchFn = vi.fn(async () => statusOnlyResponse(429));

    const handle = startFirmwareWatcher(
      store,
      { fetch: fetchFn, config: robotOnlyConfig() },
      { pollIntervalMs: 1000, maxBackoffMs: 5000 },
    );
    await vi.advanceTimersByTimeAsync(0); // poll 1 @ t=0, backoff -> 1000ms->2000ms next
    expect(fetchFn).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2_000); // poll 2 @ t=2000, backoff -> 4000ms next
    expect(fetchFn).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(4_000); // poll 3 @ t=6000, backoff would be 8000 but capped at 5000
    expect(fetchFn).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(5_000); // poll 4, using the capped 5000ms schedule
    expect(fetchFn).toHaveBeenCalledTimes(4);

    handle.stop();
  });
});

describe("startFirmwareWatcher -- fetch timeout", () => {
  it("a fetch that never resolves aborts at the 10s default timeout and reports reason: 'network', without blocking an unrelated timer", async () => {
    const store = freshStore();
    const fetchFn: FirmwareFetchFn = vi.fn(
      (_url, init) =>
        new Promise<FirmwareHttpResponse>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted by timeout")));
        }),
    );

    const handle = startFirmwareWatcher(store, { fetch: fetchFn, config: robotOnlyConfig() });

    let otherTaskRan = false;
    setTimeout(() => {
      otherTaskRan = true;
    }, 50);
    await vi.advanceTimersByTimeAsync(50);
    expect(otherTaskRan).toBe(true); // proves the hung fetch never blocked an unrelated timer

    await vi.advanceTimersByTimeAsync(10_000 - 50);
    handle.stop();

    const row = store.projectionRows().firmware.find((f) => f.kind === "robot");
    expect(row?.reason).toBe("network");
  });

  it("respects a custom fetchTimeoutMs", async () => {
    const store = freshStore();
    const fetchFn: FirmwareFetchFn = vi.fn(
      (_url, init) =>
        new Promise<FirmwareHttpResponse>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted by timeout")));
        }),
    );

    const handle = startFirmwareWatcher(
      store,
      { fetch: fetchFn, config: robotOnlyConfig() },
      { fetchTimeoutMs: 2000 },
    );
    await vi.advanceTimersByTimeAsync(2000);
    handle.stop();

    const row = store.projectionRows().firmware.find((f) => f.kind === "robot");
    expect(row?.reason).toBe("network");
  });
});

describe("startFirmwareWatcher -- no-asset message", () => {
  it("names the asset(s) actually found", async () => {
    const store = freshStore();
    const fetchFn: FirmwareFetchFn = vi.fn(async () =>
      releaseResponse("v0.20260909.1", [{ name: "nezha-robot-template-v0.20260909.1.hex" }]),
    );

    const handle = startFirmwareWatcher(store, { fetch: fetchFn, config: robotOnlyConfig() });
    await vi.advanceTimersByTimeAsync(0);
    handle.stop();

    const row = store.projectionRows().firmware.find((f) => f.kind === "robot");
    expect(row?.reason).toBe("no-asset");
    expect(row?.message).toContain("nezha-robot-template-v0.20260909.1.hex");
    expect(row?.message).toContain("MICROBIT.hex");
  });
});

describe("startFirmwareWatcher -- GITHUB_TOKEN", () => {
  it("sends Authorization when the token is present via env, and never surfaces it in a written row", async () => {
    const store = freshStore();
    const capturedHeaders: Array<Record<string, string> | undefined> = [];
    const fetchFn: FirmwareFetchFn = vi.fn(async (_url, init) => {
      capturedHeaders.push(init?.headers);
      return releaseResponse("v1", VALID_ASSETS);
    });

    const handle = startFirmwareWatcher(store, {
      fetch: fetchFn,
      config: robotOnlyConfig(),
      env: { GITHUB_TOKEN: "secret-token-123" },
    });
    await vi.advanceTimersByTimeAsync(0);
    handle.stop();

    expect(capturedHeaders[0]?.Authorization).toBe("Bearer secret-token-123");
    for (const row of store.projectionRows().firmware) {
      expect(JSON.stringify(row)).not.toContain("secret-token-123");
    }
    const task = store.projectionRows().tasks.find((t) => t.name === "firmwareWatcher");
    expect(JSON.stringify(task)).not.toContain("secret-token-123");
  });

  it("omits Authorization when no token is configured anywhere", async () => {
    const store = freshStore();
    const capturedHeaders: Array<Record<string, string> | undefined> = [];
    const fetchFn: FirmwareFetchFn = vi.fn(async (_url, init) => {
      capturedHeaders.push(init?.headers);
      return releaseResponse("v1", VALID_ASSETS);
    });

    const handle = startFirmwareWatcher(store, { fetch: fetchFn, config: robotOnlyConfig(), env: {} });
    await vi.advanceTimersByTimeAsync(0);
    handle.stop();

    expect(capturedHeaders[0]?.Authorization).toBeUndefined();
  });

  it("falls back to the settings key when the environment variable is absent", async () => {
    const store = freshStore();
    store.setSetting(GITHUB_TOKEN_SETTINGS_KEY, "settings-token-456");
    const capturedHeaders: Array<Record<string, string> | undefined> = [];
    const fetchFn: FirmwareFetchFn = vi.fn(async (_url, init) => {
      capturedHeaders.push(init?.headers);
      return releaseResponse("v1", VALID_ASSETS);
    });

    const handle = startFirmwareWatcher(store, { fetch: fetchFn, config: robotOnlyConfig(), env: {} });
    await vi.advanceTimersByTimeAsync(0);
    handle.stop();

    expect(capturedHeaders[0]?.Authorization).toBe("Bearer settings-token-456");
  });

  it("prefers the environment variable over a stored settings token", async () => {
    const store = freshStore();
    store.setSetting(GITHUB_TOKEN_SETTINGS_KEY, "settings-token-456");
    const capturedHeaders: Array<Record<string, string> | undefined> = [];
    const fetchFn: FirmwareFetchFn = vi.fn(async (_url, init) => {
      capturedHeaders.push(init?.headers);
      return releaseResponse("v1", VALID_ASSETS);
    });

    const handle = startFirmwareWatcher(store, {
      fetch: fetchFn,
      config: robotOnlyConfig(),
      env: { GITHUB_TOKEN: "env-token-789" },
    });
    await vi.advanceTimersByTimeAsync(0);
    handle.stop();

    expect(capturedHeaders[0]?.Authorization).toBe("Bearer env-token-789");
  });
});

describe("startFirmwareWatcher -- unconfigured kind / heartbeat / stop", () => {
  it("reports an unconfigured kind without ever fetching for it", async () => {
    const store = freshStore();
    const fetchFn: FirmwareFetchFn = vi.fn(async () => releaseResponse("v1", VALID_ASSETS));

    const handle = startFirmwareWatcher(store, { fetch: fetchFn, config: { relay: undefined, robot: undefined } });
    await vi.advanceTimersByTimeAsync(0);
    handle.stop();

    expect(fetchFn).not.toHaveBeenCalled();
    const relayRow = store.projectionRows().firmware.find((f) => f.kind === "relay");
    const robotRow = store.projectionRows().firmware.find((f) => f.kind === "robot");
    expect(relayRow).toMatchObject({ repo: null, tag: null, available: null });
    expect(robotRow).toMatchObject({ repo: null, tag: null, available: null });
  });

  it("heartbeats a 'firmwareWatcher' tasks row after every poll", async () => {
    const store = freshStore();
    const fetchFn: FirmwareFetchFn = vi.fn(async () => releaseResponse("v1", VALID_ASSETS));

    const handle = startFirmwareWatcher(store, { fetch: fetchFn, config: robotOnlyConfig() });
    await vi.advanceTimersByTimeAsync(0);
    handle.stop();

    const task = store.projectionRows().tasks.find((t) => t.name === "firmwareWatcher");
    expect(task).toBeDefined();
    expect(task?.state).toBe("running");
  });

  it("stop() cancels every scheduled per-kind poll", async () => {
    const store = freshStore();
    const fetchFn: FirmwareFetchFn = vi.fn(async () => releaseResponse("v1", VALID_ASSETS));

    const handle = startFirmwareWatcher(
      store,
      { fetch: fetchFn, config: { relay: RELAY_SOURCE, robot: ROBOT_SOURCE } },
      { pollIntervalMs: 1000 },
    );
    await vi.advanceTimersByTimeAsync(0);
    const callsAtStop = fetchFn.mock.calls.length;

    handle.stop();
    handle.stop(); // idempotent

    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchFn.mock.calls.length).toBe(callsAtStop);
  });

  it("polls relay and robot independently, both eventually succeeding", async () => {
    const store = freshStore();
    const fetchFn: FirmwareFetchFn = vi.fn(async (url: string) =>
      url.includes("microbit-radio-relay") ? releaseResponse("v-relay-1", VALID_ASSETS) : releaseResponse("v-robot-1", VALID_ASSETS),
    );

    const handle = startFirmwareWatcher(store, { fetch: fetchFn, config: { relay: RELAY_SOURCE, robot: ROBOT_SOURCE } });
    await vi.advanceTimersByTimeAsync(0);
    handle.stop();

    const relayRow = store.projectionRows().firmware.find((f) => f.kind === "relay");
    const robotRow = store.projectionRows().firmware.find((f) => f.kind === "robot");
    expect(relayRow).toMatchObject({ tag: "v-relay-1", available: true });
    expect(robotRow).toMatchObject({ tag: "v-robot-1", available: true });
  });

  it("023/003: polls relay, robot, and joystick independently -- a third self-rescheduling timer starts for joystick alongside the existing two", async () => {
    const store = freshStore();
    const fetchFn: FirmwareFetchFn = vi.fn(async (url: string) => {
      if (url.includes("microbit-radio-relay")) return releaseResponse("v-relay-1", VALID_ASSETS);
      if (url.includes("pxt-joystick")) return releaseResponse("v-joystick-1", VALID_ASSETS);
      return releaseResponse("v-robot-1", VALID_ASSETS);
    });

    const handle = startFirmwareWatcher(store, {
      fetch: fetchFn,
      config: { relay: RELAY_SOURCE, robot: ROBOT_SOURCE, joystick: JOYSTICK_SOURCE },
    });
    await vi.advanceTimersByTimeAsync(0);
    handle.stop();

    const relayRow = store.projectionRows().firmware.find((f) => f.kind === "relay");
    const robotRow = store.projectionRows().firmware.find((f) => f.kind === "robot");
    const joystickRow = store.projectionRows().firmware.find((f) => f.kind === "joystick");
    expect(relayRow).toMatchObject({ tag: "v-relay-1", available: true });
    expect(robotRow).toMatchObject({ tag: "v-robot-1", available: true });
    expect(joystickRow).toMatchObject({ tag: "v-joystick-1", available: true });
    // All three kinds' rows were actually written, not just relay/robot --
    // the failure mode a `FIRMWARE_KINDS` array quietly missing "joystick"
    // would produce (it type-checks fine as a readonly FirmwareKind[]
    // subset, so only a behavioral test like this one catches it).
    expect(fetchFn.mock.calls.length).toBe(3);
  });
});
