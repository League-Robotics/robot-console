/**
 * config.ts — where the two flashable firmware sources come from
 * (sprint 2, ticket 002).
 *
 * Per `sprint.md`'s Architecture (Step 3, "config.ts"): this module
 * turns two `dotconfig`-assembled environment variables,
 * `ROBOT_CONSOLE_RELAY_FIRMWARE` and `ROBOT_CONSOLE_ROBOT_FIRMWARE`
 * (the same `ROBOT_CONSOLE_*` naming convention `cli.ts` already uses
 * for `ROBOT_CONSOLE_PORT`), into typed {@link FirmwareSource} values.
 * It owns environment parsing and nothing else -- it knows nothing
 * about HTTP, USB, or the WebSocket contract (those are
 * `releases.ts`'s, `flash.ts`'s, and `wsMessages.ts`'s jobs
 * respectively).
 *
 * ## An absent or malformed variable is never fatal
 *
 * A student or instructor with no `dotconfig` install at all -- or one
 * who simply hasn't set these two variables yet -- must still get a
 * fully running host. {@link getFirmwareConfig} therefore never
 * throws: a missing variable yields `undefined` for that
 * {@link FirmwareKind} entry, and the caller (`deviceRegistry.ts`/
 * `server.ts`, later tickets) renders that as "not configured" --
 * a disabled flash button with an explanation, not a crash.
 *
 * ## `.env` reading is a few lines of hand-rolled parsing, not `dotenv`
 *
 * Per the sprint's Design Rationale: adding the `dotenv` npm dependency
 * to parse two `KEY=value` lines would be disproportionate, and
 * shelling out to the `dotconfig` CLI would make an external binary's
 * presence a hard startup dependency -- both rejected. {@link loadEnvFile}
 * is deliberately narrow (unquoted `KEY=value`, blank-line and
 * `#`-comment skipping, no multi-line values) and is not meant to grow
 * into a general `.env` parser. It only ever sets a `process.env` key
 * that isn't already set -- an explicit environment variable always
 * wins over the assembled file -- and a missing file is a no-op, not
 * an error.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FirmwareKind } from "./wsMessages.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** A resolved firmware source: a GitHub repo URL and the release tag
 * to fetch from it (`"latest"` unless the configured value pins a
 * specific one). See `releases.ts` (ticket 003) for how this is
 * resolved to an actual release/asset. */
export interface FirmwareSource {
  repoUrl: string;
  tag: string;
}

/** One entry per {@link FirmwareKind}; `undefined` means that
 * firmware's environment variable was absent, empty, or otherwise
 * could not be resolved to a source -- never a thrown error. */
export type FirmwareConfigMap = Record<FirmwareKind, FirmwareSource | undefined>;

/** Tag used when a configured value carries no explicit `:<tag>`
 * suffix. */
const DEFAULT_TAG = "latest";

/** The `ROBOT_CONSOLE_*` environment variable that configures each
 * {@link FirmwareKind}, following `cli.ts`'s existing
 * `ROBOT_CONSOLE_PORT` naming convention. */
const ENV_VAR_BY_FIRMWARE: Record<FirmwareKind, string> = {
  relay: "ROBOT_CONSOLE_RELAY_FIRMWARE",
  robot: "ROBOT_CONSOLE_ROBOT_FIRMWARE",
};

/**
 * Parse a `<repo-url>:<tag>` configured value into a
 * {@link FirmwareSource}. `tag` defaults to `"latest"` when absent.
 *
 * The split happens on the **last** `:` in the string, and only when
 * what follows it contains no `/` -- a real tag never contains a
 * slash, but the `https://` scheme in `repo-url` itself does contain
 * one right after its own colon. This is what keeps
 * `https://github.com/org/repo` (no tag) from being misparsed as
 * repo `https` with tag `//github.com/org/repo`: the candidate "tag"
 * after the *first* colon contains `/`, so instead the *last* colon is
 * tried, finds nothing further to split (no colon after the host), and
 * the whole string is kept as `repoUrl` with the default tag. A
 * genuine `https://github.com/org/repo:v1.2.3` splits on its last
 * colon into `repoUrl: "https://github.com/org/repo"` and
 * `tag: "v1.2.3"` correctly, since `v1.2.3` contains no `/`.
 *
 * Never throws -- a malformed or empty `raw` value (e.g. a stray `:`
 * with nothing meaningful on either side) falls back to treating the
 * whole trimmed string as the repo URL with the default tag, rather
 * than producing an unusable empty `repoUrl`.
 */
export function parseFirmwareSource(raw: string): FirmwareSource {
  const trimmed = raw.trim();
  const lastColon = trimmed.lastIndexOf(":");
  if (lastColon === -1) {
    return { repoUrl: trimmed, tag: DEFAULT_TAG };
  }
  const candidateTag = trimmed.slice(lastColon + 1);
  const candidateRepoUrl = trimmed.slice(0, lastColon);
  if (candidateTag.length === 0 || candidateTag.includes("/") || candidateRepoUrl.length === 0) {
    return { repoUrl: trimmed, tag: DEFAULT_TAG };
  }
  return { repoUrl: candidateRepoUrl, tag: candidateTag };
}

/** `packages/host/src/config.ts` -> `<repo root>/.env`, the file
 * `dotconfig load` assembles. Resolved relative to this module's own
 * location (not `process.cwd()`), mirroring `server.ts`'s
 * `defaultStaticDir()` pattern, so it works regardless of where
 * `robot-console` is invoked from. */
function defaultDotenvPath(): string {
  return path.resolve(__dirname, "../../../.env");
}

/**
 * Minimal `.env` reader: splits on newlines, skips blank lines and
 * `#`-comments, and splits each remaining line on its first `=` into
 * a key/value pair. Sets `env[key]` only when that key is not already
 * present on `env` -- an explicit environment variable always wins
 * over the assembled file. A missing `dotenvPath` file is a no-op, not
 * an error; this is the only I/O in this module and it deliberately
 * never throws.
 */
export function loadEnvFile(
  dotenvPath: string = defaultDotenvPath(),
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!existsSync(dotenvPath)) {
    return;
  }
  let contents: string;
  try {
    contents = readFileSync(dotenvPath, "utf8");
  } catch {
    return;
  }
  for (const line of contents.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      continue;
    }
    const eq = trimmed.indexOf("=");
    if (eq === -1) {
      continue;
    }
    const key = trimmed.slice(0, eq).trim();
    if (key.length === 0 || key in env) {
      continue;
    }
    env[key] = trimmed.slice(eq + 1).trim();
  }
}

/**
 * Read the two `ROBOT_CONSOLE_*_FIRMWARE` environment variables and
 * parse them into a {@link FirmwareConfigMap}. Called once at host
 * startup (`cli.ts`) and the result threaded down to
 * `deviceRegistry.ts`/`server.ts`.
 *
 * First loads `dotenvPath` (default: the repo-root `.env` `dotconfig
 * load` assembles) via {@link loadEnvFile} -- a no-op if that file
 * doesn't exist, e.g. no `dotconfig` install at all -- then reads from
 * `env`. Never throws: an absent, empty, or unparseable variable
 * yields `undefined` for that {@link FirmwareKind}'s entry.
 */
export function getFirmwareConfig(
  env: NodeJS.ProcessEnv = process.env,
  dotenvPath?: string,
): FirmwareConfigMap {
  loadEnvFile(dotenvPath, env);
  return {
    relay: parseConfiguredVar(env, ENV_VAR_BY_FIRMWARE.relay),
    robot: parseConfiguredVar(env, ENV_VAR_BY_FIRMWARE.robot),
  };
}

function parseConfiguredVar(env: NodeJS.ProcessEnv, key: string): FirmwareSource | undefined {
  const raw = env[key];
  if (raw === undefined || raw.trim().length === 0) {
    return undefined;
  }
  return parseFirmwareSource(raw);
}
