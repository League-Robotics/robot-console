/**
 * wifiCredentials.ts — the one WiFi network the console provisions
 * robots onto (OOP 2026-09-10, stakeholder direction: "save them in
 * persistent storage in the application, then write them to the
 * robot").
 *
 * Resolution order for a read: the stored file (`wifi-credentials.json`
 * beside `known-robots.json` in the host's state dir), else
 * `WIFI_SSID`/`WIFI_PASSWORD` from the process environment or, failing
 * that, straight from the repo's `.env` file (the host never loads that
 * file into its environment; `config.ts`'s `parseEnvFile` reads it on
 * demand), surrounding quotes stripped; else nothing. A write always
 * goes to the file, created `0600`, since it holds a password. The
 * password is never sent to a browser: {@link WifiCredentialsStore.describe}
 * reports only whether one is held.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseEnvFile } from "../config.js";
import { resolveKnownRobotsFilePath } from "./knownRobots.js";

export interface WifiCredentials {
  ssid: string;
  password: string;
}

export type WifiCredentialsSource = "stored" | "env" | "none";

export interface WifiCredentialsDescription {
  ssid: string | null;
  hasPassword: boolean;
  source: WifiCredentialsSource;
}

const WIFI_CREDENTIALS_FILENAME = "wifi-credentials.json";

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'")))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function resolveWifiCredentialsFilePath(
  options: { filePath?: string; stateDir?: string } = {},
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (options.filePath !== undefined) {
    return options.filePath;
  }
  const knownRobots = resolveKnownRobotsFilePath(options.stateDir !== undefined ? { stateDir: options.stateDir } : {}, env);
  return path.join(path.dirname(knownRobots), WIFI_CREDENTIALS_FILENAME);
}

export class WifiCredentialsStore {
  private readonly filePath: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly envFile: () => Record<string, string>;

  constructor(
    options: { filePath?: string; stateDir?: string; env?: NodeJS.ProcessEnv; envFile?: () => Record<string, string> } = {},
  ) {
    this.env = options.env ?? process.env;
    this.envFile = options.envFile ?? (() => parseEnvFile());
    this.filePath = resolveWifiCredentialsFilePath(options, this.env);
  }

  /** The stored credentials, else the environment's, else `undefined`. */
  read(): (WifiCredentials & { source: WifiCredentialsSource }) | undefined {
    const stored = this.readFile();
    if (stored) {
      return { ...stored, source: "stored" };
    }
    const fromFile = this.env.WIFI_SSID === undefined ? this.envFile() : {};
    const rawSsid = this.env.WIFI_SSID ?? fromFile.WIFI_SSID;
    const rawPassword = this.env.WIFI_PASSWORD ?? fromFile.WIFI_PASSWORD;
    const ssid = rawSsid !== undefined ? stripQuotes(rawSsid) : "";
    const password = rawPassword !== undefined ? stripQuotes(rawPassword) : "";
    if (ssid.length > 0) {
      return { ssid, password, source: "env" };
    }
    return undefined;
  }

  /** What a browser may know: the SSID and whether a password is held. */
  describe(): WifiCredentialsDescription {
    const current = this.read();
    if (!current) {
      return { ssid: null, hasPassword: false, source: "none" };
    }
    return { ssid: current.ssid, hasPassword: current.password.length > 0, source: current.source };
  }

  /** Persist a network. An empty `password` keeps the one already held
   * (stored or from the environment) when the SSID is unchanged. */
  write(ssid: string, password: string): void {
    const previous = this.read();
    const effectivePassword =
      password.length > 0 ? password : previous && previous.ssid === ssid ? previous.password : "";
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify({ version: 1, ssid, password: effectivePassword }, null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o600,
    });
  }

  private readFile(): WifiCredentials | undefined {
    if (!existsSync(this.filePath)) {
      return undefined;
    }
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.filePath, "utf8"));
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        typeof (parsed as { ssid?: unknown }).ssid === "string" &&
        typeof (parsed as { password?: unknown }).password === "string"
      ) {
        const { ssid, password } = parsed as WifiCredentials;
        return ssid.length > 0 ? { ssid, password } : undefined;
      }
    } catch {
      // Unreadable or malformed: behave as if absent.
    }
    return undefined;
  }
}
