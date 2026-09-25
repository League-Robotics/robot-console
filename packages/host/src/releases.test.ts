import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { FirmwareSource } from "./config.js";
import {
  checkAvailability,
  fetchAndVerifyHex,
  resolveRelease,
  type FetchFn,
  type ReleasesFetchResponse,
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

describe("resolveRelease: asset naming widened 2026-09-21", () => {
  // The stakeholder pointed this console at
  // League-Microbit/Remote-Joystick-Student, which publishes
  // `remote-joystick-student.hex` and no manifest. Demanding the exact
  // pair MICROBIT.hex + MICROBIT.hex.txt made a correctly-configured
  // firmware read as "not set up for this classroom yet" purely because
  // of a filename.
  const JOYSTICK_SOURCE: FirmwareSource = {
    repoUrl: "https://github.com/League-Microbit/Remote-Joystick-Student",
    tag: "latest",
  };
  const JOY_TAG = "v0.20260921.3";
  const JOY_HEX = `https://github.com/League-Microbit/Remote-Joystick-Student/releases/download/${JOY_TAG}/remote-joystick-student.hex`;

  it("accepts <repo>.hex when the release publishes no MICROBIT.hex, and reports no manifest", async () => {
    const fetchFn = async () =>
      jsonResponse(
        200,
        githubReleaseBody(JOY_TAG, {
          assets: [
            // The real release also carries a versioned copy. The rule
            // is an exact match on the repository's own name, so the
            // stable artifact wins deterministically rather than
            // whichever happens to sort first.
            { name: "remote-joystick-student-0.20260921.3.hex", browser_download_url: `${JOY_HEX}.versioned` },
            { name: "remote-joystick-student.hex", browser_download_url: JOY_HEX },
          ],
        }),
      );
    const result = await resolveRelease(JOYSTICK_SOURCE, { fetch: fetchFn as never });
    expect(result).toEqual({ tag: JOY_TAG, hexUrl: JOY_HEX });
    // Explicitly: no manifestUrl key at all, not a key set to undefined.
    expect("manifestUrl" in (result as object)).toBe(false);
  });

  it("still prefers MICROBIT.hex when a release publishes both spellings", async () => {
    const fetchFn = async () =>
      jsonResponse(
        200,
        githubReleaseBody(JOY_TAG, {
          assets: [
            { name: "remote-joystick-student.hex", browser_download_url: JOY_HEX },
            { name: "MICROBIT.hex", browser_download_url: HEX_DOWNLOAD_URL },
            { name: "MICROBIT.hex.txt", browser_download_url: MANIFEST_DOWNLOAD_URL },
          ],
        }),
      );
    const result = await resolveRelease(JOYSTICK_SOURCE, { fetch: fetchFn as never });
    // The existing convention keeps priority, so the two repos that
    // follow it are untouched by this widening.
    expect(result).toEqual({ tag: JOY_TAG, hexUrl: HEX_DOWNLOAD_URL, manifestUrl: MANIFEST_DOWNLOAD_URL });
  });

  it("finds the manifest beside whichever hex it chose, not only beside MICROBIT.hex", async () => {
    const fetchFn = async () =>
      jsonResponse(
        200,
        githubReleaseBody(JOY_TAG, {
          assets: [
            { name: "remote-joystick-student.hex", browser_download_url: JOY_HEX },
            { name: "remote-joystick-student.hex.txt", browser_download_url: `${JOY_HEX}.txt` },
          ],
        }),
      );
    const result = await resolveRelease(JOYSTICK_SOURCE, { fetch: fetchFn as never });
    expect(result).toEqual({ tag: JOY_TAG, hexUrl: JOY_HEX, manifestUrl: `${JOY_HEX}.txt` });
  });

  it("still refuses a release whose only hex matches neither accepted spelling", async () => {
    // The widening must not become "take any .hex you find" -- a
    // versioned-only release is still a maintainer mistake worth
    // naming, and the message names both spellings it would accept.
    const fetchFn = async () =>
      jsonResponse(
        200,
        githubReleaseBody(JOY_TAG, {
          assets: [{ name: "remote-joystick-student-0.20260921.3.hex", browser_download_url: JOY_HEX }],
        }),
      );
    const result = await resolveRelease(JOYSTICK_SOURCE, { fetch: fetchFn as never });
    expect(result).toEqual({
      reason: "no-asset",
      message:
        'release v0.20260921.3 has "remote-joystick-student-0.20260921.3.hex"; expected "MICROBIT.hex" or "remote-joystick-student.hex"',
    });
  });
});

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

  it("reports 'no-asset' when the resolved release is missing MICROBIT.hex or the manifest, naming the missing asset(s) in message", async () => {
    const fetchFn = vi.fn<FetchFn>(async () =>
      jsonResponse(200, githubReleaseBody(RELAY_TAG, { assets: [] })),
    );

    const result = await resolveRelease(RELAY_SOURCE, { fetch: fetchFn });

    expect(result).toEqual({
      reason: "no-asset",
      message: expect.stringContaining("MICROBIT.hex"),
    });
  });

  it("names the actual release-asset filename in the 'no-asset' message when the published asset is a real robot-firmware-shaped mismatch", async () => {
    // Pins the reported real-world scenario: the configured repo
    // publishes an asset like `nezha-robot-template-v0.20260909.1.hex`
    // instead of `MICROBIT.hex` -- resolveRelease still reports which
    // *required* asset is missing (it never guesses that the wrongly-
    // named asset was "close enough"), and this specific text is what
    // `wsMessages.ts`'s `FirmwareAvailability.message` now carries to
    // the UI end-to-end.
    const fetchFn = vi.fn<FetchFn>(async () =>
      jsonResponse(
        200,
        githubReleaseBody("v0.20260909.1", {
          assets: [
            {
              name: "nezha-robot-template-v0.20260909.1.hex",
              browser_download_url: "https://example.invalid/nezha-robot-template-v0.20260909.1.hex",
            },
          ],
        }),
      ),
    );

    const result = await resolveRelease(ROBOT_SOURCE, { fetch: fetchFn });

    expect(result).toEqual({
      reason: "no-asset",
      message:
        'release v0.20260909.1 has "nezha-robot-template-v0.20260909.1.hex"; expected "MICROBIT.hex" or "pxt-nezha-diffdrive.hex"',
    });
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

  it("downloads and returns the hex unverified when the release publishes no manifest (2026-09-21 joystick case)", async () => {
    // `Remote-Joystick-Student`'s live release (v0.20260921.3, reconfirmed
    // 2026-09-22 via `gh api`) has no `.hex.txt` beside its hex --
    // `resolveRelease` therefore returns a `ResolvedRelease` with no
    // `manifestUrl` key at all (see the "asset naming widened" describe
    // block above). This is the one real safety reduction this sprint
    // makes: a hex with no manifest is downloaded and returned as-is,
    // with no sha256 check. That must not rest on the module doc comment
    // alone -- this pins it as behavior.
    const hexBytes = relayHexFixtureBytes();
    const resolvedWithoutManifest: ResolvedRelease = {
      tag: RELAY_TAG,
      hexUrl: HEX_DOWNLOAD_URL,
    };

    const fetchFn = vi.fn<FetchFn>(async (url) => {
      if (url === HEX_DOWNLOAD_URL) return hexAssetResponse(hexBytes);
      throw new Error(`unexpected url: ${url} -- no manifest URL exists to fetch when resolved.manifestUrl is absent`);
    });

    const result = await fetchAndVerifyHex(resolvedWithoutManifest, { fetch: fetchFn });

    expect("hex" in result).toBe(true);
    if ("hex" in result) {
      expect(result.hex.equals(hexBytes)).toBe(true);
    }
    // Exactly one HTTP call -- the hex itself. No manifest fetch, no
    // checksum comparison, because there is nothing to check against.
    expect(fetchFn).toHaveBeenCalledTimes(1);
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

