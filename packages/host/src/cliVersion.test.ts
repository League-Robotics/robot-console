/**
 * cliVersion.test.ts — {@link getCliVersion}'s delegation to
 * `hostVersion.ts`'s `findRepoRootVersion` and its "unknown" fallback.
 * `findRepoRootVersion`'s own walk-up-by-name behavior is already
 * covered by `hostVersion.test.ts`; these tests only cover what
 * `cliVersion.ts` itself adds on top of it.
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getCliVersion } from "./cliVersion.js";

describe("getCliVersion", () => {
  let treeRoot: string;

  afterEach(() => {
    if (treeRoot) {
      rmSync(treeRoot, { recursive: true, force: true });
    }
  });

  it("resolves the version from an ancestor package.json named 'robot-console'", () => {
    treeRoot = mkdtempSync(path.join(tmpdir(), "robot-console-cliversion-test-"));
    const repoRoot = path.join(treeRoot, "fake-repo");
    const deepStart = path.join(repoRoot, "packages", "host", "dist", "rconsole");
    mkdirSync(deepStart, { recursive: true });
    writeFileSync(path.join(repoRoot, "package.json"), JSON.stringify({ name: "robot-console", version: "0.20260925.2" }));

    expect(getCliVersion(deepStart)).toBe("0.20260925.2");
  });

  it("falls back to 'unknown' rather than throwing when no ancestor package.json names 'robot-console'", () => {
    treeRoot = mkdtempSync(path.join(tmpdir(), "robot-console-cliversion-negative-test-"));
    const deepStart = path.join(treeRoot, "node_modules", "@robot-console", "host", "dist");
    mkdirSync(deepStart, { recursive: true });

    expect(getCliVersion(deepStart)).toBe("unknown");
  });

  it("resolves a symlinked directory tree the same way a global npm link install would", () => {
    treeRoot = mkdtempSync(path.join(tmpdir(), "robot-console-cliversion-symlink-test-"));
    const repoRoot = path.join(treeRoot, "real-repo");
    mkdirSync(path.join(repoRoot, "packages", "host", "dist"), { recursive: true });
    writeFileSync(path.join(repoRoot, "package.json"), JSON.stringify({ name: "robot-console", version: "0.20260925.3" }));

    const linkedRoot = path.join(treeRoot, "global-node-modules", "robot-console");
    mkdirSync(path.dirname(linkedRoot), { recursive: true });
    symlinkSync(repoRoot, linkedRoot, "dir");

    const deepStartViaSymlink = path.join(linkedRoot, "packages", "host", "dist");
    expect(getCliVersion(deepStartViaSymlink)).toBe("0.20260925.3");
  });

  it("with no argument, resolves this actual checkout's real package.json version", () => {
    expect(getCliVersion()).toEqual(expect.any(String));
    expect(getCliVersion()).not.toBe("unknown");
  });
});
