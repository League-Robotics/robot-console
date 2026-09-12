/**
 * One-time importer: `wifi-credentials.json` (the file
 * `../wifiCredentials.ts`'s `WifiCredentialsStore` reads/writes) →
 * a single `settings` row (SUC-005).
 *
 * Guarded the same way as `./knownRobots.ts`'s importer — a `settings`
 * row (`IMPORT_GUARD_KEY`) marks this as done so a second call is a
 * no-op — and just as "never fatal": a missing or unparseable file, or
 * one missing a non-empty `ssid`, imports nothing and leaves the guard
 * unset only when there was no file to read at all (so a file that
 * appears later is still picked up); an unusable-but-present file sets
 * the guard so it is not retried every start. The source file is never
 * modified or deleted.
 */
import { existsSync, readFileSync } from "node:fs";
import type { Store } from "../index.js";

const IMPORT_GUARD_KEY = "import:wifi-credentials";

/** The `settings.key` the imported credentials are stored under, as
 * `JSON.stringify({ ssid, password })`. */
export const WIFI_CREDENTIALS_SETTING_KEY = "wifiCredentials";

export interface ImportWifiCredentialsResult {
  imported: boolean;
}

/** Injectable filesystem seam, mirroring `knownRobots.ts`'s own
 * pattern — defaults to real `node:fs`. */
export interface ImportWifiCredentialsDeps {
  existsSync?: (filePath: string) => boolean;
  readFileSync?: (filePath: string) => string;
}

export function importWifiCredentials(
  store: Store,
  filePath: string,
  deps: ImportWifiCredentialsDeps = {},
): ImportWifiCredentialsResult {
  const existsFn = deps.existsSync ?? existsSync;
  const readFn = deps.readFileSync ?? ((path: string) => readFileSync(path, "utf8"));

  if (store.getSetting(IMPORT_GUARD_KEY) === "done") {
    return { imported: false };
  }
  if (!existsFn(filePath)) {
    return { imported: false };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFn(filePath));
  } catch {
    store.setSetting(IMPORT_GUARD_KEY, "done");
    return { imported: false };
  }

  if (typeof parsed !== "object" || parsed === null) {
    store.setSetting(IMPORT_GUARD_KEY, "done");
    return { imported: false };
  }
  const { ssid, password } = parsed as { ssid?: unknown; password?: unknown };
  if (typeof ssid !== "string" || ssid.length === 0 || typeof password !== "string") {
    store.setSetting(IMPORT_GUARD_KEY, "done");
    return { imported: false };
  }

  store.setSetting(WIFI_CREDENTIALS_SETTING_KEY, JSON.stringify({ ssid, password }));
  store.setSetting(IMPORT_GUARD_KEY, "done");
  return { imported: true };
}
