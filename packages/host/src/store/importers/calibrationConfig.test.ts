import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WHEELS_TAPE_CM_SETTINGS_KEY } from "../../config.js";
import { openStoreDb } from "../db.js";
import { Store } from "../index.js";
import { CALWHEELS_CM_ENV_VAR, importCalibrationConfig } from "./calibrationConfig.js";

const noRepoEnv = { findRepoRootEnvPath: () => undefined };

describe("importCalibrationConfig", () => {
  let store: Store;
  let stateDir: string;

  beforeEach(() => {
    store = new Store(openStoreDb({ filePath: ":memory:" }));
    stateDir = mkdtempSync(path.join(tmpdir(), "calibration-config-"));
  });

  afterEach(() => {
    store.close();
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("stores the env var and the snapshot rows carry it as a number", () => {
    const wrote = importCalibrationConfig(store, { env: { [CALWHEELS_CM_ENV_VAR]: "90.0" }, stateDir }, noRepoEnv);

    expect(wrote).toBe(true);
    expect(store.getSetting(WHEELS_TAPE_CM_SETTINGS_KEY)).toBe("90");
    expect(store.projectionRows().wheelsTapeCm).toBe(90);
  });

  it("falls back to the state directory's .env when the env var is absent", () => {
    writeFileSync(path.join(stateDir, ".env"), `${CALWHEELS_CM_ENV_VAR}=88.25\n`);

    importCalibrationConfig(store, { env: {}, stateDir }, noRepoEnv);

    expect(store.projectionRows().wheelsTapeCm).toBe(88.25);
  });

  it("leaves the existing row alone for an absent, blank or non-positive value", () => {
    store.setSetting(WHEELS_TAPE_CM_SETTINGS_KEY, "91");
    for (const raw of [undefined, "  ", "abc", "0", "-5"]) {
      const env = raw === undefined ? {} : { [CALWHEELS_CM_ENV_VAR]: raw };
      expect(importCalibrationConfig(store, { env, stateDir }, noRepoEnv)).toBe(false);
    }
    expect(store.projectionRows().wheelsTapeCm).toBe(91);
  });

  it("reports no configured distance when nothing was ever stored", () => {
    expect(store.projectionRows().wheelsTapeCm).toBeNull();
  });
});
