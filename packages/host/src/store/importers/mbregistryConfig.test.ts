/**
 * mbregistryConfig.test.ts — `importMbregistryConfig` (sprint 018
 * ticket 008). Mirrors `./firmwareConfig.test.ts`'s own
 * "in-memory store, explicit env object" convention.
 */
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getMbregistryShareBoards, MBREGISTRY_SHAREBOARDS_SETTINGS_KEY } from "../../config.js";
import { openStoreDb } from "../db.js";
import { Store } from "../index.js";
import { importMbregistryConfig, MBREGISTRY_SHARE_BOARDS_ENV_VAR } from "./mbregistryConfig.js";

function freshStore(): { store: Store; db: DatabaseSync } {
  const db = openStoreDb({ filePath: ":memory:" });
  return { store: new Store(db), db };
}

describe("importMbregistryConfig", () => {
  let store: Store;

  beforeEach(() => {
    ({ store } = freshStore());
  });

  afterEach(() => {
    store.close();
  });

  it("writes the settings row as 'true' for a truthy env value, and getMbregistryShareBoards reads it back as true", () => {
    const wrote = importMbregistryConfig(store, { env: { [MBREGISTRY_SHARE_BOARDS_ENV_VAR]: "true" } });
    expect(wrote).toBe(true);
    expect(store.getSetting(MBREGISTRY_SHAREBOARDS_SETTINGS_KEY)).toBe("true");
    expect(getMbregistryShareBoards(store)).toBe(true);
  });

  it("accepts the same case-insensitive truthy tokens as getMbregistryShareBoards", () => {
    for (const raw of ["TRUE", "1", "yes", "On"]) {
      importMbregistryConfig(store, { env: { [MBREGISTRY_SHARE_BOARDS_ENV_VAR]: raw } });
      expect(getMbregistryShareBoards(store)).toBe(true);
    }
  });

  it("writes 'false' for an unrecognized non-blank value", () => {
    const wrote = importMbregistryConfig(store, { env: { [MBREGISTRY_SHARE_BOARDS_ENV_VAR]: "nope" } });
    expect(wrote).toBe(true);
    expect(store.getSetting(MBREGISTRY_SHAREBOARDS_SETTINGS_KEY)).toBe("false");
    expect(getMbregistryShareBoards(store)).toBe(false);
  });

  it("does nothing when the env var is absent, leaving any existing settings row untouched (persists across a restart with no env var)", () => {
    store.setSetting(MBREGISTRY_SHAREBOARDS_SETTINGS_KEY, "true");

    const wrote = importMbregistryConfig(store, { env: {} });

    expect(wrote).toBe(false);
    expect(getMbregistryShareBoards(store)).toBe(true);
  });

  it("does nothing when the env var is blank", () => {
    store.setSetting(MBREGISTRY_SHAREBOARDS_SETTINGS_KEY, "true");

    const wrote = importMbregistryConfig(store, { env: { [MBREGISTRY_SHARE_BOARDS_ENV_VAR]: "   " } });

    expect(wrote).toBe(false);
    expect(getMbregistryShareBoards(store)).toBe(true);
  });

  it("a present env var overwrites a previously stored row", () => {
    store.setSetting(MBREGISTRY_SHAREBOARDS_SETTINGS_KEY, "true");

    importMbregistryConfig(store, { env: { [MBREGISTRY_SHARE_BOARDS_ENV_VAR]: "false" } });

    expect(getMbregistryShareBoards(store)).toBe(false);
  });
});
