import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { FirmwareConfigMap, FirmwareSource } from "./config.js";
import {
  checkAvailability,
  DEFAULT_AVAILABILITY_POLL_INTERVAL_MS,
  fetchAndVerifyHex,
  FirmwareAvailabilityCache,
  resolveRelease,
  type FetchFn,
  type ReleasesFetchResponse,
  type FirmwareStatusMap,
  type ResolvedRelease,
} from "./releases.js";

const RELAY_SOURCE: FirmwareSource = {
  repoUrl: "https://github.com/League-Robotics/microbit-radio-relay",
  tag: "latest",
};

const ROBOT_SOURCE: FirmwareSource = {
  repoUrl: "https://github.com/League-Robotics/pxt-nezha-diffdrive",
  tag: "latest",
};

const RELAY_TAG = "v0.20260831.1";
const RELAY_HEX_SIZE = 717576;
const HEX_DOWNLOAD_URL = `https://github.com/League-Robotics/microbit-radio-relay/releases/download/${RELAY_TAG}/MICROBIT.hex`;
const MANIFEST_DOWNLOAD_URL = `https://github.com/League-Robotics/microbit-radio-relay/releases/download/${RELAY_TAG}/MICROBIT.hex.txt`;

/** Builds a `MICROBIT.hex`-shaped buffer of the real relay release's
 * exact size (717576 bytes), filled with deterministic (non-zero, not
 * all-identical) bytes so a sha256 computed over it is meaningful. */
function relayHexFixtureBytes(): Buffer {
  const bytes = Buffer.alloc(RELAY_HEX_SIZE);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = (i * 7 + 13) % 256;
  }
  return bytes;
}

function jsonResponse(status: number, body: unknown): ReleasesFetchResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    arrayBuffer: async () => {
      throw new Error("arrayBuffer() not expected on a JSON response");
    },
    text: async () => JSON.stringify(body),
  };
}

function hexAssetResponse(bytes: Buffer): ReleasesFetchResponse {
  return {
    ok: true,
    status: 200,
    json: async () => {
      throw new Error("json() not expected on a hex asset response");
    },
    arrayBuffer: async () =>
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    text: async () => {
      throw new Error("text() not expected on a hex asset response");
    },
  };
}

function manifestAssetResponse(manifestText: string): ReleasesFetchResponse {
  return {
    ok: true,
    status: 200,
    json: async () => {
      throw new Error("json() not expected on a manifest asset response");
    },
    arrayBuffer: async () => {
      throw new Error("arrayBuffer() not expected on a manifest asset response");
    },
    text: async () => manifestText,
  };
}

/** GitHub release-shaped JSON body carrying the two assets this module
 * looks for. `assetNameCase` lets a test exercise the (real, plausible)
 * variance in how the asset filenames are cased. */
function githubReleaseBody(
  tagName: string,
  options?: { hexName?: string; manifestName?: string; assets?: unknown[] },
): unknown {
  const hexName = options?.hexName ?? "MICROBIT.hex";
  const manifestName = options?.manifestName ?? "MICROBIT.hex.txt";
  return {
    tag_name: tagName,
    assets: options?.assets ?? [
      { name: hexName, browser_download_url: HEX_DOWNLOAD_URL },
      { name: manifestName, browser_download_url: MANIFEST_DOWNLOAD_URL },
    ],
  };
}

function githubNotFoundBody(): unknown {
  return { message: "Not Found" };
}

describe("resolveRelease", () => {
  it("resolves the latest-tag release for a real-shaped relay fixture and identifies both asset URLs", async () => {
    const fetchFn = vi.fn<FetchFn>(async (url) => {
      expect(url).toBe("https://api.github.com/repos/League-Robotics/microbit-radio-relay/releases/latest");
      return jsonResponse(200, githubReleaseBody(RELAY_TAG));
    });

    const result = await resolveRelease(RELAY_SOURCE, { fetch: fetchFn });

    expect(result).toEqual<ResolvedRelease>({
      tag: RELAY_TAG,
      hexUrl: HEX_DOWNLOAD_URL,
      manifestUrl: MANIFEST_DOWNLOAD_URL,
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("resolves a pinned (non-latest) tag via the /releases/tags/<tag> endpoint", async () => {
    const pinned: FirmwareSource = {
      repoUrl: "https://github.com/League-Robotics/microbit-radio-relay",
      tag: "v0.1.0",
    };
    const fetchFn = vi.fn<FetchFn>(async (url) => {
      expect(url).toBe(
        "https://api.github.com/repos/League-Robotics/microbit-radio-relay/releases/tags/v0.1.0",
      );
      return jsonResponse(200, githubReleaseBody("v0.1.0"));
    });

    const result = await resolveRelease(pinned, { fetch: fetchFn });

    expect(result).toEqual<ResolvedRelease>({
      tag: "v0.1.0",
      hexUrl: HEX_DOWNLOAD_URL,
      manifestUrl: MANIFEST_DOWNLOAD_URL,
    });
  });

  it("changing the configured tag resolves a different release, with no code change", async () => {
    const fetchFn = vi.fn<FetchFn>(async (url) => {
      if (url.endsWith("/tags/v1.0.0")) {
        return jsonResponse(200, githubReleaseBody("v1.0.0"));
      }
      if (url.endsWith("/tags/v2.0.0")) {
        return jsonResponse(200, githubReleaseBody("v2.0.0"));
      }
      throw new Error(`unexpected url: ${url}`);
    });

    const first = await resolveRelease(
      { repoUrl: RELAY_SOURCE.repoUrl, tag: "v1.0.0" },
      { fetch: fetchFn },
    );
    const second = await resolveRelease(
      { repoUrl: RELAY_SOURCE.repoUrl, tag: "v2.0.0" },
      { fetch: fetchFn },
    );

    expect(first).toMatchObject({ tag: "v1.0.0" });
    expect(second).toMatchObject({ tag: "v2.0.0" });
  });

  it("reports 'no-releases' for the verified zero-release pxt-nezha-diffdrive state (latest tag, 404)", async () => {
    const fetchFn = vi.fn<FetchFn>(async (url) => {
      expect(url).toBe("https://api.github.com/repos/League-Robotics/pxt-nezha-diffdrive/releases/latest");
      return jsonResponse(404, githubNotFoundBody());
    });

    const result = await resolveRelease(ROBOT_SOURCE, { fetch: fetchFn });

    expect(result).toEqual({
      reason: "no-releases",
      message: expect.stringContaining("pxt-nezha-diffdrive"),
    });
  });

  it("distinguishes 'tag-not-found' from 'no-releases' for a 404 on a specific pinned tag", async () => {
    const pinned: FirmwareSource = { repoUrl: RELAY_SOURCE.repoUrl, tag: "v99.0.0" };
    const fetchFn = vi.fn<FetchFn>(async () => jsonResponse(404, githubNotFoundBody()));

    const result = await resolveRelease(pinned, { fetch: fetchFn });

    expect(result).toEqual({
      reason: "tag-not-found",
      message: expect.stringContaining("v99.0.0"),
    });
  });

  it("reports 'no-asset' when the resolved release is missing MICROBIT.hex or the manifest", async () => {
    const fetchFn = vi.fn<FetchFn>(async () =>
      jsonResponse(200, githubReleaseBody(RELAY_TAG, { assets: [] })),
    );

    const result = await resolveRelease(RELAY_SOURCE, { fetch: fetchFn });

    expect(result).toMatchObject({ reason: "no-asset" });
  });

  it("reports 'network' when the fetch call itself rejects", async () => {
    const fetchFn = vi.fn<FetchFn>(async () => {
      throw new Error("getaddrinfo ENOTFOUND api.github.com");
    });

    const result = await resolveRelease(RELAY_SOURCE, { fetch: fetchFn });

    expect(result).toEqual({
      reason: "network",
      message: expect.stringContaining("ENOTFOUND"),
    });
  });

  it("reports 'network' for a non-404 error status", async () => {
    const fetchFn = vi.fn<FetchFn>(async () => jsonResponse(500, { message: "server error" }));

    const result = await resolveRelease(RELAY_SOURCE, { fetch: fetchFn });

    expect(result).toMatchObject({ reason: "network" });
  });

  it("never throws, even against a malformed repoUrl", async () => {
    const malformed: FirmwareSource = { repoUrl: "not a url", tag: "latest" };
    await expect(resolveRelease(malformed)).resolves.toMatchObject({ reason: "network" });
  });
});

describe("fetchAndVerifyHex", () => {
  const resolved: ResolvedRelease = {
    tag: RELAY_TAG,
    hexUrl: HEX_DOWNLOAD_URL,
    manifestUrl: MANIFEST_DOWNLOAD_URL,
  };

  it("downloads and verifies a real-shaped relay hex + manifest (717576 bytes)", async () => {
    const hexBytes = relayHexFixtureBytes();
    const sha256 = createHash("sha256").update(hexBytes).digest("hex");
    const manifestText = `commit: abc123\nbuilt: 2026-08-31T00:00:00Z\nsha256: ${sha256}\n`;

    const fetchFn = vi.fn<FetchFn>(async (url) => {
      if (url === HEX_DOWNLOAD_URL) return hexAssetResponse(hexBytes);
      if (url === MANIFEST_DOWNLOAD_URL) return manifestAssetResponse(manifestText);
      throw new Error(`unexpected url: ${url}`);
    });

    const result = await fetchAndVerifyHex(resolved, { fetch: fetchFn });

    expect("hex" in result).toBe(true);
    if ("hex" in result) {
      expect(result.hex).toHaveLength(RELAY_HEX_SIZE);
      expect(result.hex.equals(hexBytes)).toBe(true);
    }
  });

  it("refuses the hex on a sha256 mismatch, and never returns it as valid", async () => {
    const hexBytes = relayHexFixtureBytes();
    const manifestText = `sha256: ${"0".repeat(64)}\n`;

    const fetchFn = vi.fn<FetchFn>(async (url) => {
      if (url === HEX_DOWNLOAD_URL) return hexAssetResponse(hexBytes);
      if (url === MANIFEST_DOWNLOAD_URL) return manifestAssetResponse(manifestText);
      throw new Error(`unexpected url: ${url}`);
    });

    const result = await fetchAndVerifyHex(resolved, { fetch: fetchFn });

    expect("error" in result).toBe(true);
    expect("hex" in result).toBe(false);
    if ("error" in result) {
      expect(result.error).toContain("mismatch");
    }
  });

  it.each([
    ["lower-case colon form", "sha256: SHA_PLACEHOLDER\n"],
    ["upper-case key with equals", "SHA256=SHA_PLACEHOLDER\n"],
    ["mixed case with hyphen", "Sha-256 : SHA_PLACEHOLDER\n"],
    ["embedded in a multi-line manifest", "commit: abc\nbuilt: now\nSHA256:SHA_PLACEHOLDER\n"],
  ])("parses the manifest sha256 leniently: %s", async (_label, template) => {
    const hexBytes = relayHexFixtureBytes();
    const sha256 = createHash("sha256").update(hexBytes).digest("hex");
    const manifestText = template.replace("SHA_PLACEHOLDER", sha256);

    const fetchFn = vi.fn<FetchFn>(async (url) => {
      if (url === HEX_DOWNLOAD_URL) return hexAssetResponse(hexBytes);
      if (url === MANIFEST_DOWNLOAD_URL) return manifestAssetResponse(manifestText);
      throw new Error(`unexpected url: ${url}`);
    });

    const result = await fetchAndVerifyHex(resolved, { fetch: fetchFn });

    expect("hex" in result).toBe(true);
  });

  it("errors when the manifest has no recognizable sha256 line", async () => {
    const hexBytes = relayHexFixtureBytes();
    const fetchFn = vi.fn<FetchFn>(async (url) => {
      if (url === HEX_DOWNLOAD_URL) return hexAssetResponse(hexBytes);
      if (url === MANIFEST_DOWNLOAD_URL) return manifestAssetResponse("commit: abc123\nbuilt: today\n");
      throw new Error(`unexpected url: ${url}`);
    });

    const result = await fetchAndVerifyHex(resolved, { fetch: fetchFn });

    expect("error" in result).toBe(true);
  });

  it("errors, rather than throws, when the hex download itself fails", async () => {
    const fetchFn = vi.fn<FetchFn>(async (url) => {
      if (url === HEX_DOWNLOAD_URL) {
        throw new Error("connection reset");
      }
      return manifestAssetResponse("sha256: 0\n");
    });

    await expect(fetchAndVerifyHex(resolved, { fetch: fetchFn })).resolves.toMatchObject({
      error: expect.stringContaining("connection reset"),
    });
  });
});

describe("checkAvailability", () => {
  it("is true when resolveRelease succeeds", async () => {
    const fetchFn = vi.fn<FetchFn>(async () => jsonResponse(200, githubReleaseBody(RELAY_TAG)));
    await expect(checkAvailability(RELAY_SOURCE, { fetch: fetchFn })).resolves.toBe(true);
  });

  it("is false for the verified zero-release pxt-nezha-diffdrive state", async () => {
    const fetchFn = vi.fn<FetchFn>(async () => jsonResponse(404, githubNotFoundBody()));
    await expect(checkAvailability(ROBOT_SOURCE, { fetch: fetchFn })).resolves.toBe(false);
  });
});

describe("FirmwareAvailabilityCache", () => {
  it("reports 'configured: false' for an unconfigured firmware kind, with no check attempted", async () => {
    const checkAvailabilityFn = vi.fn(async () => ({ available: true }));
    const cache = new FirmwareAvailabilityCache(
      { relay: undefined, robot: undefined },
      { checkAvailability: checkAvailabilityFn },
    );

    const status = await cache.pollOnce();

    expect(status.relay).toEqual({ configured: false });
    expect(status.robot).toEqual({ configured: false });
    expect(checkAvailabilityFn).not.toHaveBeenCalled();
  });

  it("reports available:true with repoUrl/tag for a configured, available firmware", async () => {
    const checkAvailabilityFn = vi.fn(async () => ({ available: true }));
    const cache = new FirmwareAvailabilityCache(
      { relay: RELAY_SOURCE, robot: undefined },
      { checkAvailability: checkAvailabilityFn },
    );

    const status = await cache.pollOnce();

    expect(status.relay).toEqual({
      configured: true,
      repoUrl: RELAY_SOURCE.repoUrl,
      tag: RELAY_SOURCE.tag,
      available: true,
    });
  });

  it("reports available:false with a reason for the zero-release robot firmware state", async () => {
    const checkAvailabilityFn = vi.fn(async (source: FirmwareSource) =>
      source === ROBOT_SOURCE ? { available: false, reason: "no-releases" } : { available: true },
    );
    const cache = new FirmwareAvailabilityCache(
      { relay: undefined, robot: ROBOT_SOURCE },
      { checkAvailability: checkAvailabilityFn },
    );

    const status = await cache.pollOnce();

    expect(status.robot).toEqual({
      configured: true,
      repoUrl: ROBOT_SOURCE.repoUrl,
      tag: ROBOT_SOURCE.tag,
      available: false,
      reason: "no-releases",
    });
  });

  it("self-heals to available:true on a later poll with no code change", async () => {
    const checkAvailabilityFn = vi
      .fn()
      .mockResolvedValueOnce({ available: false, reason: "no-releases" })
      .mockResolvedValueOnce({ available: true });
    const cache = new FirmwareAvailabilityCache(
      { relay: undefined, robot: ROBOT_SOURCE },
      { checkAvailability: checkAvailabilityFn },
    );

    const first = await cache.pollOnce();
    expect(first.robot).toMatchObject({ available: false, reason: "no-releases" });

    const second = await cache.pollOnce();
    expect(second.robot).toEqual({
      configured: true,
      repoUrl: ROBOT_SOURCE.repoUrl,
      tag: ROBOT_SOURCE.tag,
      available: true,
    });
  });

  it("notifies onChange listeners only when the status actually changes", async () => {
    const checkAvailabilityFn = vi
      .fn()
      .mockResolvedValueOnce({ available: false, reason: "no-releases" })
      .mockResolvedValueOnce({ available: false, reason: "no-releases" })
      .mockResolvedValueOnce({ available: true });
    const cache = new FirmwareAvailabilityCache(
      { relay: undefined, robot: ROBOT_SOURCE },
      { checkAvailability: checkAvailabilityFn },
    );
    const listener = vi.fn();
    cache.onChange(listener);

    await cache.pollOnce();
    expect(listener).toHaveBeenCalledTimes(1);

    await cache.pollOnce();
    expect(listener).toHaveBeenCalledTimes(1);

    await cache.pollOnce();
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("stops notifying an unsubscribed listener", async () => {
    const checkAvailabilityFn = vi
      .fn()
      .mockResolvedValueOnce({ available: false })
      .mockResolvedValueOnce({ available: true });
    const cache = new FirmwareAvailabilityCache(
      { relay: undefined, robot: ROBOT_SOURCE },
      { checkAvailability: checkAvailabilityFn },
    );
    const listener = vi.fn();
    const unsubscribe = cache.onChange(listener);
    unsubscribe();

    await cache.pollOnce();
    await cache.pollOnce();

    expect(listener).not.toHaveBeenCalled();
  });

  it("start()/stop() use an unref'd timer so it never keeps the process alive on its own", () => {
    vi.useFakeTimers();
    try {
      const checkAvailabilityFn = vi.fn(async () => ({ available: true }));
      const cache = new FirmwareAvailabilityCache(
        { relay: RELAY_SOURCE, robot: undefined },
        { checkAvailability: checkAvailabilityFn, pollIntervalMs: 1000 },
      );

      cache.start();
      cache.start(); // no-op when already started
      vi.advanceTimersByTime(2500);
      cache.stop();
      cache.stop(); // no-op when already stopped

      expect(checkAvailabilityFn.mock.calls.length).toBeGreaterThanOrEqual(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("documents a multi-minute default poll interval", () => {
    expect(DEFAULT_AVAILABILITY_POLL_INTERVAL_MS).toBeGreaterThanOrEqual(60_000);
  });
});

describe("FirmwareAvailabilityCache config reload", () => {
  it("re-reads configuration on each poll when loadConfig is supplied", async () => {
    // The host-start-before-`dotconfig load` case: the cache is
    // constructed while nothing is configured, and must still notice
    // the source once the file lands.
    let config: FirmwareConfigMap = { relay: undefined, robot: undefined };
    const cache = new FirmwareAvailabilityCache(config, {
      loadConfig: () => config,
      checkAvailability: async () => ({ available: true }),
    });

    expect((await cache.pollOnce()).relay).toEqual({ configured: false });

    config = {
      relay: { repoUrl: "https://example.test/relay", tag: "latest" },
      robot: undefined,
    };

    expect((await cache.pollOnce()).relay).toEqual({
      configured: true,
      repoUrl: "https://example.test/relay",
      tag: "latest",
      available: true,
    });
  });

  it("notifies listeners when a reload changes the status", async () => {
    let config: FirmwareConfigMap = { relay: undefined, robot: undefined };
    const cache = new FirmwareAvailabilityCache(config, {
      loadConfig: () => config,
      checkAvailability: async () => ({ available: true }),
    });
    await cache.pollOnce();

    const seen: FirmwareStatusMap[] = [];
    cache.onChange((status) => seen.push(status));

    config = {
      relay: { repoUrl: "https://example.test/relay", tag: "latest" },
      robot: undefined,
    };
    await cache.pollOnce();

    expect(seen).toHaveLength(1);
    expect(seen[0]?.relay).toMatchObject({ configured: true, available: true });
  });

  it("keeps using the constructor config when loadConfig is omitted", async () => {
    const cache = new FirmwareAvailabilityCache(
      { relay: { repoUrl: "https://example.test/relay", tag: "pinned" }, robot: undefined },
      { checkAvailability: async () => ({ available: true }) },
    );

    expect((await cache.pollOnce()).relay).toMatchObject({ tag: "pinned", available: true });
  });
});
