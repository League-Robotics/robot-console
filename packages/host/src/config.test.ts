import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openStoreDb } from "./store/db.js";
import { Store } from "./store/index.js";
import {
  getFirmwareConfig,
  isLocalHexPath,
  loadEnvFile,
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
 * Out-of-process, 2026-09-16: the two `ROBOT_CONSOLE_*_FIRMWARE`
 * variables also accept a path to a hex file on this machine, so the
 * console can flash a locally built image instead of a GitHub release.
 * These pin the detection rule itself -- the thing both
 * `parseFirmwareSource` and `projection.ts` depend on agreeing about.
 */
describe("isLocalHexPath / local-file firmware sources", () => {
  it("treats absolute, ~-relative, and ./-relative paths as local", () => {
    expect(isLocalHexPath("/Volumes/Proj/microbit-radio-relay/MICROBIT.hex")).toBe(true);
    expect(isLocalHexPath("~/builds/MICROBIT.hex")).toBe(true);
    expect(isLocalHexPath("./built/binary.hex")).toBe(true);
    expect(isLocalHexPath("../built/binary.hex")).toBe(true);
  });

  it("treats a bare path ending in .hex as local, so build/MICROBIT.hex needs no ./", () => {
    expect(isLocalHexPath("build/MICROBIT.hex")).toBe(true);
    expect(isLocalHexPath("BINARY.HEX")).toBe(true);
  });

  it("never treats a URL as local -- including one that somehow ends in .hex", () => {
    expect(isLocalHexPath("https://github.com/League-Robotics/microbit-radio-relay")).toBe(false);
    expect(isLocalHexPath("http://example.com/org/repo")).toBe(false);
    expect(isLocalHexPath("https://example.com/builds/MICROBIT.hex")).toBe(false);
  });

  it("does not treat an empty or bare repo-shaped value as local", () => {
    expect(isLocalHexPath("")).toBe(false);
    expect(isLocalHexPath("   ")).toBe(false);
    expect(isLocalHexPath("League-Robotics/microbit-radio-relay")).toBe(false);
  });

  it("parses an absolute path into a local-file source, never splitting it on a colon", () => {
    expect(parseFirmwareSource("/Volumes/Proj/microbit-radio-relay/MICROBIT.hex")).toEqual({
      kind: "local-file",
      hexPath: "/Volumes/Proj/microbit-radio-relay/MICROBIT.hex",
    });
  });

  it("expands ~ and resolves a relative path to an absolute one", () => {
    const expanded = parseFirmwareSource("~/builds/MICROBIT.hex");
    expect(expanded.kind).toBe("local-file");
    const home = expanded as { kind: "local-file"; hexPath: string };
    expect(home.hexPath.startsWith("~")).toBe(false);
    expect(path.isAbsolute(home.hexPath)).toBe(true);
    expect(home.hexPath.endsWith(path.join("builds", "MICROBIT.hex"))).toBe(true);

    const relative = parseFirmwareSource("./built/binary.hex") as { kind: "local-file"; hexPath: string };
    expect(path.isAbsolute(relative.hexPath)).toBe(true);
  });

  it("still parses a repo URL as a release source, with no kind discriminant", () => {
    // The historical shape stays byte-for-byte what it always was --
    // every existing construction site and fixture depends on it.
    expect(parseFirmwareSource("https://github.com/League-Robotics/microbit-radio-relay:v1.2.3")).toEqual({
      repoUrl: "https://github.com/League-Robotics/microbit-radio-relay",
      tag: "v1.2.3",
    });
  });

  it("resolves a configured local path through getFirmwareConfig", () => {
    const store = freshStore();
    store.setSetting(SETTINGS_KEY_BY_FIRMWARE.relay, "/Volumes/Proj/microbit-radio-relay/MICROBIT.hex");
    expect(getFirmwareConfig(store).relay).toEqual({
      kind: "local-file",
      hexPath: "/Volumes/Proj/microbit-radio-relay/MICROBIT.hex",
    });
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

  // Sprint 023 ticket 002: joystick is a third firmware kind, following
  // the exact relay/robot pattern -- round-trips through the same
  // `settings` key/`getFirmwareConfig` path, and reads as `undefined`
  // ("not configured") when unset, exactly like relay/robot above. The
  // real `.env` value is deliberately not set until ticket 007.
  it("resolves the joystick source when its settings row is present, following the relay/robot pattern", () => {
    store.setSetting(SETTINGS_KEY_BY_FIRMWARE.joystick, "https://github.com/League-Microbit/Remote-Joystick-Student:v0.1.0");

    const result = getFirmwareConfig(store);
    expect(result.joystick).toEqual({
      repoUrl: "https://github.com/League-Microbit/Remote-Joystick-Student",
      tag: "v0.1.0",
    });
  });

  it("reports joystick as undefined ('not configured') when its settings row is absent, same as relay/robot", () => {
    const result = getFirmwareConfig(store);
    expect(result.joystick).toBeUndefined();
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
