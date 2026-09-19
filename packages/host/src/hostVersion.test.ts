/**
 * hostVersion.test.ts — {@link getHostVersion}'s precedence
 * (`ROBOT_CONSOLE_VERSION` env var, then repo-root `package.json`) and
 * {@link findRepoRootVersion}'s walk-up-by-name behavior, mirroring
 * `firmwareConfig.test.ts`'s own `findRepoRootEnvPath` suite shape.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findRepoRootVersion, getHostVersion } from "./hostVersion.js";

describe("findRepoRootVersion", () => {
  let treeRoot: string;

  afterEach(() => {
    rmSync(treeRoot, { recursive: true, force: true });
  });

  it("returns the ancestor package.json's version once a package.json named 'robot-console' is found", () => {
    treeRoot = mkdtempSync(path.join(tmpdir(), "robot-console-hostversion-test-"));
    const repoRoot = path.join(treeRoot, "fake-repo");
    const deepStart = path.join(repoRoot, "packages", "host", "src");
    mkdirSync(deepStart, { recursive: true });
    writeFileSync(path.join(repoRoot, "package.json"), JSON.stringify({ name: "robot-console", version: "0.20260101.1" }));

    expect(findRepoRootVersion(deepStart)).toBe("0.20260101.1");
  });

  it("returns undefined when no ancestor package.json names 'robot-console' (a packaged/registry install)", () => {
    treeRoot = mkdtempSync(path.join(tmpdir(), "robot-console-hostversion-negative-test-"));
    const deepStart = path.join(treeRoot, "node_modules", "@robot-console", "host", "dist");
    mkdirSync(deepStart, { recursive: true });
    writeFileSync(
      path.join(treeRoot, "node_modules", "@robot-console", "host", "package.json"),
      JSON.stringify({ name: "@robot-console/host", version: "9.9.9" }),
    );

    expect(findRepoRootVersion(deepStart)).toBeUndefined();
  });

  it("does not false-positive on a package.json that exists but has a different name", () => {
    treeRoot = mkdtempSync(path.join(tmpdir(), "robot-console-hostversion-mismatch-test-"));
    const deepStart = path.join(treeRoot, "a", "b");
    mkdirSync(deepStart, { recursive: true });
    writeFileSync(path.join(treeRoot, "package.json"), JSON.stringify({ name: "some-other-project", version: "1.0.0" }));

    expect(findRepoRootVersion(deepStart)).toBeUndefined();
  });

  it("returns undefined for a matching package.json with no readable version field", () => {
    treeRoot = mkdtempSync(path.join(tmpdir(), "robot-console-hostversion-noversion-test-"));
    mkdirSync(treeRoot, { recursive: true });
    writeFileSync(path.join(treeRoot, "package.json"), JSON.stringify({ name: "robot-console" }));

    expect(findRepoRootVersion(treeRoot)).toBeUndefined();
  });
});

describe("getHostVersion", () => {
  const ORIGINAL_ENV = process.env.ROBOT_CONSOLE_VERSION;

  afterEach(() => {
    if (ORIGINAL_ENV === undefined) {
      delete process.env.ROBOT_CONSOLE_VERSION;
    } else {
      process.env.ROBOT_CONSOLE_VERSION = ORIGINAL_ENV;
    }
  });

  it("prefers ROBOT_CONSOLE_VERSION over the repo-root package.json (the .deb's own env file)", () => {
    process.env.ROBOT_CONSOLE_VERSION = "0.20260101.5";
    const neverCalled = () => {
      throw new Error("findRepoRootVersionFn must not be called when the env var is set");
    };

    expect(getHostVersion(neverCalled)).toBe("0.20260101.5");
  });

  it("falls back to the repo-root package.json when the env var is absent", () => {
    delete process.env.ROBOT_CONSOLE_VERSION;

    expect(getHostVersion(() => "0.20260202.1")).toBe("0.20260202.1");
  });

  it("falls back to the repo-root package.json when the env var is set but empty", () => {
    process.env.ROBOT_CONSOLE_VERSION = "";

    expect(getHostVersion(() => "0.20260202.1")).toBe("0.20260202.1");
  });

  it("returns undefined when neither source resolves -- never a wrong or placeholder version", () => {
    delete process.env.ROBOT_CONSOLE_VERSION;

    expect(getHostVersion(() => undefined)).toBeUndefined();
  });

  it("with no injected finder, resolves this actual checkout's real package.json version", () => {
    delete process.env.ROBOT_CONSOLE_VERSION;

    expect(getHostVersion()).toEqual(expect.any(String));
  });
});
