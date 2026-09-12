import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * buildHygiene.test.ts — ticket 014-001's build-hygiene acceptance
 * criteria, checked as plain assertions against the repo's own
 * configuration files rather than by shelling out to `npm` (which would
 * be slow, environment-dependent, and out of step with every other test
 * in this repo, all of which run against injected fixtures rather than
 * real subprocesses/filesystem/network).
 *
 * These are deliberately narrow, static checks -- they read
 * `package.json`/`.npmrc` as data and assert on their shape, not on
 * runtime `npm` behavior. Actually exercising `npm install
 * --package-lock-only --dry-run` producing no diff after a version bump
 * (the ticket's own phrasing) is a manual/CI verification step, not
 * something a fast unit suite should re-implement by spawning a real
 * `npm` process.
 */

const REPO_ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../");

interface PackageJson {
  engines?: { node?: string };
  scripts?: Record<string, string>;
}

function readJson<T>(relativePath: string): T {
  const raw = readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
  return JSON.parse(raw) as T;
}

describe("Node engine floor (ticket 014-001)", () => {
  const workspacePackageJsonPaths = [
    "package.json",
    "packages/protocol/package.json",
    "packages/host/package.json",
    "packages/ui/package.json",
  ];

  for (const relativePath of workspacePackageJsonPaths) {
    it(`${relativePath} declares engines.node >= 22.13`, () => {
      const pkg = readJson<PackageJson>(relativePath);
      expect(pkg.engines?.node).toBe(">=22.13");
    });
  }

  it(".npmrc sets engine-strict=true so an old Node fails `npm install` loudly", () => {
    const npmrc = readFileSync(path.join(REPO_ROOT, ".npmrc"), "utf8");
    expect(npmrc).toMatch(/^engine-strict=true$/m);
  });

  it(".nvmrc and .node-version both pin major version 22", () => {
    expect(readFileSync(path.join(REPO_ROOT, ".nvmrc"), "utf8").trim()).toBe("22");
    expect(readFileSync(path.join(REPO_ROOT, ".node-version"), "utf8").trim()).toBe("22");
  });
});

describe("lockfile-drift guard (ticket 014-001)", () => {
  it("root package.json's \"version\" lifecycle script re-syncs package-lock.json", () => {
    // Regenerating the lockfile on every `npm version <bump>` is what
    // keeps a version bump from dirtying the very next `npm install` --
    // see README.md's "Lockfile drift after a version bump" section for
    // why this alone doesn't cover `dotconfig version bump` (which does
    // not invoke `npm version` at all) and what to do by hand for that
    // path.
    const pkg = readJson<PackageJson>("package.json");
    expect(pkg.scripts?.version).toBe("npm install --package-lock-only");
  });
});

describe("submodule pretest guard (ticket 014-001)", () => {
  it("root package.json's \"pretest\" script initializes vendor/ git submodules", () => {
    const pkg = readJson<PackageJson>("package.json");
    expect(pkg.scripts?.pretest).toContain("git submodule update --init");
  });
});
