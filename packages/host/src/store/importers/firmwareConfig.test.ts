/**
 * firmwareConfig.test.ts — `importFirmwareConfig` (sprint 017 ticket
 * 001) and its `findRepoRootEnvPath` helper.
 *
 * Every case here uses a fresh temp directory as the state dir and an
 * explicit `env` object (never bare `process.env`), exactly the way
 * `bootstrap.test.ts`/`db.test.ts` already do, so no real `~/.local/
 * state/robot-console` is ever touched. Critically, every
 * `importFirmwareConfig` call below also passes an explicit
 * `deps.findRepoRootEnvPath` (even when the case wants "no checkout
 * found", it passes `() => undefined` rather than omitting the option)
 * so no test ever falls through to the real default implementation,
 * which would otherwise walk up from this file's own real directory and
 * find (and read) *this actual repo's own real `.env`* -- exactly what
 * the ticket's "no test reads `.env` from anywhere but the importer's
 * own test" rule forbids.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { openStoreDb } from "../db.js";
import { Store } from "../index.js";
import { getFirmwareConfig, SETTINGS_KEY_BY_FIRMWARE } from "../../config.js";
import { findRepoRootEnvPath, importFirmwareConfig } from "./firmwareConfig.js";

const RELAY_KEY = "ROBOT_CONSOLE_RELAY_FIRMWARE";
const ROBOT_KEY = "ROBOT_CONSOLE_ROBOT_FIRMWARE";

function freshStore(): { store: Store; db: DatabaseSync } {
  const db = openStoreDb({ filePath: ":memory:" });
  return { store: new Store(db), db };
}

/** No test in this file relies on this being reachable -- every call
 * passes its own `deps.findRepoRootEnvPath` -- but it documents the
 * "never found" shape used throughout. */
const NO_CHECKOUT_FOUND = () => undefined;

describe("importFirmwareConfig", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(path.join(tmpdir(), "robot-console-firmwareconfig-test-"));
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("resolves both firmware kinds from env vars, writing settings", () => {
    const { store } = freshStore();
    try {
      const env = {
        [RELAY_KEY]: "https://github.com/League-Robotics/microbit-radio-relay:latest",
        [ROBOT_KEY]: "https://github.com/League-Robotics/pxt-nezha-diffdrive:v0.1.0",
      };
      const result = importFirmwareConfig(store, { env, stateDir }, { findRepoRootEnvPath: NO_CHECKOUT_FOUND });

      expect(result).toEqual({ relay: true, robot: true });
      expect(store.getSetting(SETTINGS_KEY_BY_FIRMWARE.relay)).toBe(
        "https://github.com/League-Robotics/microbit-radio-relay:latest",
      );
      expect(store.getSetting(SETTINGS_KEY_BY_FIRMWARE.robot)).toBe(
        "https://github.com/League-Robotics/pxt-nezha-diffdrive:v0.1.0",
      );
    } finally {
      store.close();
    }
  });

  it("resolves both firmware kinds from a state-dir .env file when env vars are absent", () => {
    const { store } = freshStore();
    try {
      writeFileSync(
        path.join(stateDir, ".env"),
        [
          `${RELAY_KEY}=https://example.test/relay:v1`,
          `${ROBOT_KEY}=https://example.test/robot:v2`,
          "",
        ].join("\n"),
      );

      const result = importFirmwareConfig(store, { env: {}, stateDir }, { findRepoRootEnvPath: NO_CHECKOUT_FOUND });

      expect(result).toEqual({ relay: true, robot: true });
      expect(store.getSetting(SETTINGS_KEY_BY_FIRMWARE.relay)).toBe("https://example.test/relay:v1");
      expect(store.getSetting(SETTINGS_KEY_BY_FIRMWARE.robot)).toBe("https://example.test/robot:v2");
    } finally {
      store.close();
    }
  });

  it("falls back to a repo-root .env only when the state dir has no .env of its own", () => {
    const { store } = freshStore();
    const repoRootDir = mkdtempSync(path.join(tmpdir(), "robot-console-firmwareconfig-repo-root-"));
    try {
      const repoRootEnvPath = path.join(repoRootDir, ".env");
      writeFileSync(repoRootEnvPath, `${RELAY_KEY}=https://example.test/from-repo-root:v3\n`);
      // stateDir deliberately has no .env of its own.

      const result = importFirmwareConfig(
        store,
        { env: {}, stateDir },
        { findRepoRootEnvPath: () => repoRootEnvPath },
      );

      expect(result).toEqual({ relay: true, robot: false });
      expect(store.getSetting(SETTINGS_KEY_BY_FIRMWARE.relay)).toBe("https://example.test/from-repo-root:v3");
      expect(store.getSetting(SETTINGS_KEY_BY_FIRMWARE.robot)).toBeUndefined();
    } finally {
      store.close();
      rmSync(repoRootDir, { recursive: true, force: true });
    }
  });

  it("does not fall back to repo root when a state-dir .env exists, even if it lacks the keys", () => {
    const { store } = freshStore();
    try {
      // An empty state-dir .env still counts as "the file to use" --
      // the repo-root fallback below must never be consulted.
      writeFileSync(path.join(stateDir, ".env"), "");

      const result = importFirmwareConfig(
        store,
        { env: {}, stateDir },
        {
          findRepoRootEnvPath: () => {
            throw new Error("must not be called when a state-dir .env exists");
          },
        },
      );

      expect(result).toEqual({ relay: false, robot: false });
    } finally {
      store.close();
    }
  });

  it("a present env var overwrites a stale settings row on every call (idempotent, env always wins)", () => {
    const { store } = freshStore();
    try {
      store.setSetting(SETTINGS_KEY_BY_FIRMWARE.relay, "https://stale.example/repo:old-tag");

      const env = { [RELAY_KEY]: "https://fresh.example/repo:new-tag" };
      const result = importFirmwareConfig(store, { env, stateDir }, { findRepoRootEnvPath: NO_CHECKOUT_FOUND });

      expect(result.relay).toBe(true);
      expect(store.getSetting(SETTINGS_KEY_BY_FIRMWARE.relay)).toBe("https://fresh.example/repo:new-tag");
    } finally {
      store.close();
    }
  });

  it("writes nothing when neither env nor .env resolve a value; getFirmwareConfig yields undefined, not a throw", () => {
    const { store } = freshStore();
    try {
      const result = importFirmwareConfig(store, { env: {}, stateDir }, { findRepoRootEnvPath: NO_CHECKOUT_FOUND });

      expect(result).toEqual({ relay: false, robot: false });
      expect(store.getSetting(SETTINGS_KEY_BY_FIRMWARE.relay)).toBeUndefined();
      expect(store.getSetting(SETTINGS_KEY_BY_FIRMWARE.robot)).toBeUndefined();
      expect(() => getFirmwareConfig(store)).not.toThrow();
      expect(getFirmwareConfig(store)).toEqual({ relay: undefined, robot: undefined });
    } finally {
      store.close();
    }
  });

  it("treats an empty-string env var as unset, falling through to the .env file", () => {
    const { store } = freshStore();
    try {
      writeFileSync(path.join(stateDir, ".env"), `${RELAY_KEY}=https://example.test/from-file:v9\n`);

      const env = { [RELAY_KEY]: "" };
      const result = importFirmwareConfig(store, { env, stateDir }, { findRepoRootEnvPath: NO_CHECKOUT_FOUND });

      expect(result.relay).toBe(true);
      expect(store.getSetting(SETTINGS_KEY_BY_FIRMWARE.relay)).toBe("https://example.test/from-file:v9");
    } finally {
      store.close();
    }
  });

  it("round-trips through getFirmwareConfig end to end", () => {
    const { store } = freshStore();
    try {
      const env = { [ROBOT_KEY]: "https://github.com/League-Robotics/pxt-nezha-diffdrive:v3.0.0" };
      importFirmwareConfig(store, { env, stateDir }, { findRepoRootEnvPath: NO_CHECKOUT_FOUND });

      expect(getFirmwareConfig(store)).toEqual({
        relay: undefined,
        robot: { repoUrl: "https://github.com/League-Robotics/pxt-nezha-diffdrive", tag: "v3.0.0" },
      });
    } finally {
      store.close();
    }
  });
});

describe("findRepoRootEnvPath", () => {
  let treeRoot: string;

  afterEach(() => {
    rmSync(treeRoot, { recursive: true, force: true });
  });

  it("returns the ancestor directory's .env path once a package.json named 'robot-console' is found", () => {
    treeRoot = mkdtempSync(path.join(tmpdir(), "robot-console-findreporoot-test-"));
    const repoRoot = path.join(treeRoot, "fake-repo");
    const deepStart = path.join(repoRoot, "packages", "host", "src", "store", "importers");
    mkdirSync(deepStart, { recursive: true });
    writeFileSync(path.join(repoRoot, "package.json"), JSON.stringify({ name: "robot-console" }));

    expect(findRepoRootEnvPath(deepStart)).toBe(path.join(repoRoot, ".env"));
  });

  it("returns undefined when no ancestor package.json names 'robot-console' (a packaged/registry install)", () => {
    treeRoot = mkdtempSync(path.join(tmpdir(), "robot-console-findreporoot-negative-test-"));
    const deepStart = path.join(treeRoot, "node_modules", "@robot-console", "host", "dist", "store", "importers");
    mkdirSync(deepStart, { recursive: true });
    // An unrelated package.json a couple of levels up must not
    // false-positive as the repo root.
    writeFileSync(
      path.join(treeRoot, "node_modules", "@robot-console", "host", "package.json"),
      JSON.stringify({ name: "@robot-console/host" }),
    );

    expect(findRepoRootEnvPath(deepStart)).toBeUndefined();
  });

  it("does not false-positive on a package.json that exists but has a different name", () => {
    treeRoot = mkdtempSync(path.join(tmpdir(), "robot-console-findreporoot-mismatch-test-"));
    const deepStart = path.join(treeRoot, "a", "b");
    mkdirSync(deepStart, { recursive: true });
    writeFileSync(path.join(treeRoot, "package.json"), JSON.stringify({ name: "some-other-project" }));

    expect(findRepoRootEnvPath(deepStart)).toBeUndefined();
  });
});
