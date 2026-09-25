import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openStoreDb } from "./store/db.js";
import { Store } from "./store/index.js";
import {
  getFirmwareConfig,
  getMbregistryShareBoards,
  loadEnvFile,
  MBREGISTRY_SHAREBOARDS_SETTINGS_KEY,
  parseEnvFile,
  parseFirmwareSource,
  SETTINGS_KEY_BY_FIRMWARE,
} from "./config.js";

/** A path that never resolves to a real file, so `parseEnvFile`/
 * `loadEnvFile` calls in tests that don't care about `.env` reading
 * never accidentally pick up this repo's own real `.env` (if one
 * happens to exist at the repo root from a real `dotconfig load`). */
const NO_SUCH_FILE = path.join(tmpdir(), "robot-console-config-test-no-such-file.env");

function freshStore(): Store {
  const db = openStoreDb({ filePath: ":memory:" });
  return new Store(db);
}

describe("parseFirmwareSource", () => {
  it("defaults tag to latest for a bare repo URL", () => {
    expect(parseFirmwareSource("https://github.com/League-Robotics/microbit-radio-relay")).toEqual({
      repoUrl: "https://github.com/League-Robotics/microbit-radio-relay",
      tag: "latest",
    });
  });

  it("splits on the last colon when a tag suffix is present", () => {
    expect(parseFirmwareSource("https://github.com/League-Robotics/microbit-radio-relay:v1.2.3")).toEqual({
      repoUrl: "https://github.com/League-Robotics/microbit-radio-relay",
      tag: "v1.2.3",
    });
  });

  it("does not misparse the https:// scheme's own colon as a tag separator", () => {
    // The first colon in the string is the one after "https"; the text
    // that follows it ("//github.com/...") contains a "/", so it must
    // not be treated as a tag.
    const result = parseFirmwareSource("https://github.com/org/repo");
    expect(result.repoUrl).toBe("https://github.com/org/repo");
    expect(result.tag).toBe("latest");
  });

  it("handles a tag suffix on an http (non-https) URL the same way", () => {
    expect(parseFirmwareSource("http://example.com/org/repo:latest")).toEqual({
      repoUrl: "http://example.com/org/repo",
      tag: "latest",
    });
  });

  it("falls back to the whole string as repoUrl for malformed input (trailing colon)", () => {
    const result = parseFirmwareSource("https://github.com/org/repo:");
    expect(result.repoUrl).toBe("https://github.com/org/repo:");
    expect(result.tag).toBe("latest");
  });

  it("never throws on an empty string", () => {
    expect(() => parseFirmwareSource("")).not.toThrow();
    expect(parseFirmwareSource("")).toEqual({ repoUrl: "", tag: "latest" });
  });
});

/**
 * Sprint 017 ticket 001: `getFirmwareConfig` is now a `settings` reader
 * (via `store`), not an `env`/`.env` reader -- resolving `process.env`/
 * `.env` into those `settings` rows is `store/importers/
 * firmwareConfig.ts`'s job (see its own test file). These tests only
 * exercise the "turn a settings row into a typed FirmwareSource, never
 * throw" contract.
 */
describe("getFirmwareConfig", () => {
  let store: Store;

  beforeEach(() => {
    store = freshStore();
  });

  afterEach(() => {
    store.close();
  });

  it("resolves both firmware sources when both settings rows are present", () => {
    store.setSetting(SETTINGS_KEY_BY_FIRMWARE.relay, "https://github.com/League-Robotics/microbit-radio-relay:latest");
    store.setSetting(SETTINGS_KEY_BY_FIRMWARE.robot, "https://github.com/League-Robotics/pxt-nezha-diffdrive:v0.1.0");

    expect(getFirmwareConfig(store)).toEqual({
      relay: { repoUrl: "https://github.com/League-Robotics/microbit-radio-relay", tag: "latest" },
      robot: { repoUrl: "https://github.com/League-Robotics/pxt-nezha-diffdrive", tag: "v0.1.0" },
    });
  });

  it("resolves only the configured entry when one settings row is present", () => {
    store.setSetting(SETTINGS_KEY_BY_FIRMWARE.relay, "https://github.com/League-Robotics/microbit-radio-relay:latest");

    const result = getFirmwareConfig(store);
    expect(result.relay).toEqual({
      repoUrl: "https://github.com/League-Robotics/microbit-radio-relay",
      tag: "latest",
    });
    expect(result.robot).toBeUndefined();
  });

  it("never throws and yields undefined for both entries when neither settings row exists", () => {
    expect(() => getFirmwareConfig(store)).not.toThrow();
    expect(getFirmwareConfig(store)).toEqual({ relay: undefined, robot: undefined });
  });

  it("treats an empty-string settings value the same as unset", () => {
    store.setSetting(SETTINGS_KEY_BY_FIRMWARE.relay, "");
    const result = getFirmwareConfig(store);
    expect(result.relay).toBeUndefined();
  });

  it("reflects a settings row updated between calls, with no code change", () => {
    store.setSetting(SETTINGS_KEY_BY_FIRMWARE.robot, "https://github.com/League-Robotics/pxt-nezha-diffdrive:v1.0.0");
    const first = getFirmwareConfig(store);
    expect(first.robot?.tag).toBe("v1.0.0");

    store.setSetting(SETTINGS_KEY_BY_FIRMWARE.robot, "https://github.com/League-Robotics/pxt-nezha-diffdrive:v2.0.0");
    const second = getFirmwareConfig(store);
    expect(second.robot?.tag).toBe("v2.0.0");
  });
});

/**
 * Sprint 018 ticket 008: `mbregistry.shareBoards` -- the host-only
 * toggle deciding whether a console-spawned mbregistry instance keeps
 * `--no-peering` or turns peering on. Mirrors `getFirmwareConfig`'s own
 * "settings row -> typed value, never throw" contract.
 */
describe("getMbregistryShareBoards", () => {
  let store: Store;

  beforeEach(() => {
    store = freshStore();
  });

  afterEach(() => {
    store.close();
  });

  it("defaults to false when no settings row exists", () => {
    expect(getMbregistryShareBoards(store)).toBe(false);
  });

  it("is true when the settings row is the string 'true'", () => {
    store.setSetting(MBREGISTRY_SHAREBOARDS_SETTINGS_KEY, "true");
    expect(getMbregistryShareBoards(store)).toBe(true);
  });

  it("is case-insensitive and tolerates surrounding whitespace", () => {
    store.setSetting(MBREGISTRY_SHAREBOARDS_SETTINGS_KEY, " TRUE ");
    expect(getMbregistryShareBoards(store)).toBe(true);
  });

  it("is false for 'false', empty, or any other unrecognized value -- never throws", () => {
    store.setSetting(MBREGISTRY_SHAREBOARDS_SETTINGS_KEY, "false");
    expect(getMbregistryShareBoards(store)).toBe(false);

    store.setSetting(MBREGISTRY_SHAREBOARDS_SETTINGS_KEY, "");
    expect(getMbregistryShareBoards(store)).toBe(false);

    store.setSetting(MBREGISTRY_SHAREBOARDS_SETTINGS_KEY, "banana");
    expect(() => getMbregistryShareBoards(store)).not.toThrow();
    expect(getMbregistryShareBoards(store)).toBe(false);
  });

  it("reflects a settings row updated between calls", () => {
    store.setSetting(MBREGISTRY_SHAREBOARDS_SETTINGS_KEY, "true");
    expect(getMbregistryShareBoards(store)).toBe(true);

    store.setSetting(MBREGISTRY_SHAREBOARDS_SETTINGS_KEY, "false");
    expect(getMbregistryShareBoards(store)).toBe(false);
  });
});

describe("loadEnvFile", () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
      dir = undefined;
    }
  });

  it("sets an unset key from the file, skipping blank lines and comments", () => {
    dir = mkdtempSync(path.join(tmpdir(), "robot-console-config-test-"));
    const envPath = path.join(dir, ".env");
    writeFileSync(
      envPath,
      ["# a comment", "", "ROBOT_CONSOLE_RELAY_FIRMWARE=https://example.com/repo:v1", ""].join("\n"),
    );
    const env: NodeJS.ProcessEnv = {};
    loadEnvFile(envPath, env);
    expect(env.ROBOT_CONSOLE_RELAY_FIRMWARE).toBe("https://example.com/repo:v1");
  });

  it("does not override a key already present in env", () => {
    dir = mkdtempSync(path.join(tmpdir(), "robot-console-config-test-"));
    const envPath = path.join(dir, ".env");
    writeFileSync(envPath, "ROBOT_CONSOLE_RELAY_FIRMWARE=https://example.com/from-file:v1\n");
    const env: NodeJS.ProcessEnv = {
      ROBOT_CONSOLE_RELAY_FIRMWARE: "https://example.com/from-real-env:v2",
    };
    loadEnvFile(envPath, env);
    expect(env.ROBOT_CONSOLE_RELAY_FIRMWARE).toBe("https://example.com/from-real-env:v2");
  });

  it("is a no-op when the file does not exist", () => {
    const env: NodeJS.ProcessEnv = {};
    expect(() => loadEnvFile(NO_SUCH_FILE, env)).not.toThrow();
    expect(env).toEqual({});
  });
});

describe("parseEnvFile", () => {
  it("returns an empty map for a missing file, never throwing", () => {
    expect(() => parseEnvFile(NO_SUCH_FILE)).not.toThrow();
    expect(parseEnvFile(NO_SUCH_FILE)).toEqual({});
  });
});
