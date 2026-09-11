import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WifiCredentialsStore, resolveWifiCredentialsFilePath } from "./wifiCredentials.js";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "wifi-cred-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("WifiCredentialsStore", () => {
  it("lives beside known-robots.json in the state dir", () => {
    expect(resolveWifiCredentialsFilePath({ stateDir: "/tmp/x" }, {})).toBe("/tmp/x/wifi-credentials.json");
  });

  it("falls back to WIFI_SSID/WIFI_PASSWORD from the environment, stripping quotes, and never reveals the password", () => {
    const store = new WifiCredentialsStore({ stateDir: tempDir(), env: { WIFI_SSID: '"Busboom_Garage"', WIFI_PASSWORD: "'hunter2'" } });
    expect(store.read()).toEqual({ ssid: "Busboom_Garage", password: "hunter2", source: "env" });
    expect(store.describe()).toEqual({ ssid: "Busboom_Garage", hasPassword: true, source: "env" });
  });

  it("reads WIFI_SSID/WIFI_PASSWORD from the repo's .env file when the process environment lacks them", () => {
    const store = new WifiCredentialsStore({ stateDir: tempDir(), env: {}, envFile: () => ({ WIFI_SSID: '"Garage"', WIFI_PASSWORD: "pw" }) });
    expect(store.read()).toEqual({ ssid: "Garage", password: "pw", source: "env" });
  });

  it("reports none with nothing stored and nothing in the environment", () => {
    const store = new WifiCredentialsStore({ stateDir: tempDir(), env: {}, envFile: () => ({}) });
    expect(store.read()).toBeUndefined();
    expect(store.describe()).toEqual({ ssid: null, hasPassword: false, source: "none" });
  });

  it("writes a 0600 file that wins over the environment, and keeps the held password when a rewrite leaves it blank", () => {
    const dir = tempDir();
    const store = new WifiCredentialsStore({ stateDir: dir, env: { WIFI_SSID: "EnvNet", WIFI_PASSWORD: "envpw" } });
    store.write("Garage", "secret");
    const file = path.join(dir, "wifi-credentials.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ version: 1, ssid: "Garage", password: "secret" });
    expect(store.describe()).toEqual({ ssid: "Garage", hasPassword: true, source: "stored" });

    store.write("Garage", "");
    expect(store.read()?.password).toBe("secret");
    store.write("Other", "");
    expect(store.read()).toEqual({ ssid: "Other", password: "", source: "stored" });
  });
});
