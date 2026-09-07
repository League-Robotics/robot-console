import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getFirmwareConfig, loadEnvFile, parseFirmwareSource } from "./config.js";

/** A path that never resolves to a real file, so `getFirmwareConfig()`
 * calls in tests that don't care about `.env` reading never
 * accidentally pick up this repo's own real `.env` (if one happens to
 * exist at the repo root from a real `dotconfig load`). */
const NO_SUCH_FILE = path.join(tmpdir(), "robot-console-config-test-no-such-file.env");

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

describe("getFirmwareConfig", () => {
  it("resolves both firmware sources when both env vars are set", () => {
    const env = {
      ROBOT_CONSOLE_RELAY_FIRMWARE: "https://github.com/League-Robotics/microbit-radio-relay:latest",
      ROBOT_CONSOLE_ROBOT_FIRMWARE: "https://github.com/League-Robotics/pxt-nezha-diffdrive:v0.1.0",
    };
    expect(getFirmwareConfig(env, NO_SUCH_FILE)).toEqual({
      relay: { repoUrl: "https://github.com/League-Robotics/microbit-radio-relay", tag: "latest" },
      robot: { repoUrl: "https://github.com/League-Robotics/pxt-nezha-diffdrive", tag: "v0.1.0" },
    });
  });

  it("resolves only the configured entry when one env var is set", () => {
    const env = {
      ROBOT_CONSOLE_RELAY_FIRMWARE: "https://github.com/League-Robotics/microbit-radio-relay:latest",
    };
    const result = getFirmwareConfig(env, NO_SUCH_FILE);
    expect(result.relay).toEqual({
      repoUrl: "https://github.com/League-Robotics/microbit-radio-relay",
      tag: "latest",
    });
    expect(result.robot).toBeUndefined();
  });

  it("never throws and yields undefined for both entries when neither env var is set", () => {
    expect(() => getFirmwareConfig({}, NO_SUCH_FILE)).not.toThrow();
    expect(getFirmwareConfig({}, NO_SUCH_FILE)).toEqual({ relay: undefined, robot: undefined });
  });

  it("treats an empty-string env var the same as unset", () => {
    const result = getFirmwareConfig({ ROBOT_CONSOLE_RELAY_FIRMWARE: "" }, NO_SUCH_FILE);
    expect(result.relay).toBeUndefined();
  });

  it("changing the configured tag resolves a different source, with no code change", () => {
    const first = getFirmwareConfig(
      { ROBOT_CONSOLE_ROBOT_FIRMWARE: "https://github.com/League-Robotics/pxt-nezha-diffdrive:v1.0.0" },
      NO_SUCH_FILE,
    );
    const second = getFirmwareConfig(
      { ROBOT_CONSOLE_ROBOT_FIRMWARE: "https://github.com/League-Robotics/pxt-nezha-diffdrive:v2.0.0" },
      NO_SUCH_FILE,
    );
    expect(first.robot?.tag).toBe("v1.0.0");
    expect(second.robot?.tag).toBe("v2.0.0");
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
