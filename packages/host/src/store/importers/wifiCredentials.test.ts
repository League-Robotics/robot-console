import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { openStoreDb } from "../db.js";
import { Store } from "../index.js";
import { importWifiCredentials, WIFI_CREDENTIALS_SETTING_KEY } from "./wifiCredentials.js";

const FIXTURE_PATH = path.resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "..",
  "__fixtures__",
  "wifi-credentials.json",
);

function freshStore(): { store: Store; db: DatabaseSync } {
  const db = openStoreDb({ filePath: ":memory:" });
  return { store: new Store(db), db };
}

describe("importWifiCredentials", () => {
  it("imports the fixture into a single settings row (SUC-005)", () => {
    const { store } = freshStore();
    try {
      const result = importWifiCredentials(store, FIXTURE_PATH);
      expect(result.imported).toBe(true);
      expect(store.getSetting(WIFI_CREDENTIALS_SETTING_KEY)).toBe(
        JSON.stringify({ ssid: "Busboom_Garage", password: "hunter2" }),
      );
    } finally {
      store.close();
    }
  });

  it("is idempotent: a second call imports nothing and the setting is unchanged", () => {
    const { store } = freshStore();
    try {
      importWifiCredentials(store, FIXTURE_PATH);
      const second = importWifiCredentials(store, FIXTURE_PATH);
      expect(second.imported).toBe(false);
      expect(store.getSetting(WIFI_CREDENTIALS_SETTING_KEY)).toBe(
        JSON.stringify({ ssid: "Busboom_Garage", password: "hunter2" }),
      );
    } finally {
      store.close();
    }
  });

  it("leaves the fixture file itself untouched", () => {
    const before = readFileSync(FIXTURE_PATH, "utf8");
    const { store } = freshStore();
    try {
      importWifiCredentials(store, FIXTURE_PATH);
      expect(readFileSync(FIXTURE_PATH, "utf8")).toBe(before);
    } finally {
      store.close();
    }
  });

  it("does nothing when the file does not exist, without setting the guard", () => {
    const { store } = freshStore();
    try {
      const result = importWifiCredentials(store, "/no/such/wifi-credentials.json");
      expect(result.imported).toBe(false);
      expect(store.getSetting(WIFI_CREDENTIALS_SETTING_KEY)).toBeUndefined();

      const again = importWifiCredentials(store, FIXTURE_PATH);
      expect(again.imported).toBe(true);
    } finally {
      store.close();
    }
  });

  it("treats corrupt JSON as never-fatal and still sets the guard", () => {
    const { store } = freshStore();
    try {
      const result = importWifiCredentials(store, "/irrelevant/path.json", {
        existsSync: () => true,
        readFileSync: () => "{not valid json",
      });
      expect(result.imported).toBe(false);
      expect(store.getSetting(WIFI_CREDENTIALS_SETTING_KEY)).toBeUndefined();

      // guard is set even for unusable-but-present data, so a corrupt
      // file is not retried on every host start
      const again = importWifiCredentials(store, FIXTURE_PATH);
      expect(again.imported).toBe(false);
    } finally {
      store.close();
    }
  });

  it("treats a missing/empty ssid as nothing to import", () => {
    const { store } = freshStore();
    try {
      const result = importWifiCredentials(store, "/irrelevant/path.json", {
        existsSync: () => true,
        readFileSync: () => JSON.stringify({ version: 1, ssid: "", password: "x" }),
      });
      expect(result.imported).toBe(false);
      expect(store.getSetting(WIFI_CREDENTIALS_SETTING_KEY)).toBeUndefined();
    } finally {
      store.close();
    }
  });
});
