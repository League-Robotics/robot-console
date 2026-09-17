/**
 * config.ts — where the two flashable firmware sources come from
 * (sprint 2, ticket 002; store-backed as of sprint 017 ticket 001).
 *
 * Per `sprint.md`'s Architecture (Step 3, "config.ts"): this module
 * turns two `dotconfig`-assembled environment variables,
 * `ROBOT_CONSOLE_RELAY_FIRMWARE` and `ROBOT_CONSOLE_ROBOT_FIRMWARE`
 * (the same `ROBOT_CONSOLE_*` naming convention `cli.ts` already uses
 * for `ROBOT_CONSOLE_PORT`), into typed {@link FirmwareSource} values.
 * It owns environment/string parsing and nothing else -- it knows
 * nothing about HTTP, USB, or the WebSocket contract (those are
 * `releases.ts`'s, `flash.ts`'s, and `wsMessages.ts`'s jobs
 * respectively).
 *
 * ## Sprint 017 ticket 001: `getFirmwareConfig` reads `settings`, not a file
 *
 * Through sprint 016, {@link getFirmwareConfig} resolved
 * `ROBOT_CONSOLE_*_FIRMWARE` straight from `process.env`/a `.env` file
 * resolved *relative to this module's own location*
 * (`packages/host/src/config.ts` -> `<repo root>/.env`). Under a
 * registry or packaged install that guessed path never exists (or,
 * worse, resolves to some unrelated directory), so both flash buttons
 * silently rendered "not configured" even when the environment was
 * otherwise set up correctly (`clasi/issues/
 * firmware-config-env-becomes-settings-importer.md`). The fix moves
 * `.env`-finding to a bootstrap-time importer
 * (`store/importers/firmwareConfig.ts`) that writes the resolved raw
 * strings into `settings` keys {@link SETTINGS_KEY_BY_FIRMWARE}; this
 * module's job shrinks to *reading* those settings and turning the
 * resolved string into a typed {@link FirmwareSource} -- it no longer
 * does any file I/O of its own for firmware sources. `parseEnvFile`
 * (a general-purpose helper) and `parseFirmwareSource` stay here, since
 * the importer itself calls the former and this module still owns the
 * latter.
 *
 * ## An absent or malformed variable is never fatal
 *
 * A student or instructor with no `dotconfig` install at all -- or one
 * who simply hasn't set these two variables yet -- must still get a
 * fully running host. {@link getFirmwareConfig} therefore never
 * throws: a missing `settings` row yields `undefined` for that
 * {@link FirmwareKind} entry, and the caller (`server.ts`) renders that
 * as "not configured" -- a disabled flash button with an explanation,
 * not a crash.
 *
 * ## `.env` reading is a few lines of hand-rolled parsing, not `dotenv`
 *
 * Per the sprint's Design Rationale: adding the `dotenv` npm dependency
 * to parse two `KEY=value` lines would be disproportionate, and
 * shelling out to the `dotconfig` CLI would make an external binary's
 * presence a hard startup dependency -- both rejected. {@link loadEnvFile}/
 * {@link parseEnvFile} are deliberately narrow (unquoted `KEY=value`,
 * blank-line and `#`-comment skipping, no multi-line values) and are not
 * meant to grow into a general `.env` parser.
 */

import type { FirmwareKind } from "./wsMessages.js";
import type { Store } from "./store/index.js";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/** A resolved firmware source that lives in a GitHub release: a repo URL
 * and the release tag to fetch from it (`"latest"` unless the configured
 * value pins a specific one). See `releases.ts` (ticket 003) for how
 * this is resolved to an actual release/asset.
 *
 * `kind` is **optional** here, and {@link parseFirmwareSource} omits it
 * when it builds one. A GitHub release was the only kind of firmware
 * source this codebase had until local hex paths were added
 * (out-of-process, 2026-09-16), so every pre-existing construction site
 * and test fixture in the tree writes the bare `{repoUrl, tag}` shape.
 * Making the discriminant optional on *this* arm (and required on
 * {@link LocalHexFirmwareSource}) keeps all of them valid while still
 * letting `source.kind === "local-file"` narrow correctly -- the check
 * every consumer actually performs. */
export interface ReleaseFirmwareSource {
  kind?: "release";
  repoUrl: string;
  tag: string;
}

/** A resolved firmware source that is simply a hex file already sitting
 * on this machine's disk (out-of-process, 2026-09-16).
 *
 * The stakeholder builds relay and robot firmware locally
 * (`microbit-radio-relay`'s own `MICROBIT.hex` at its repo root, the
 * robot template's `built/binary.hex`) and wants the console's existing
 * Flash buttons to deploy *that* build rather than whatever GitHub last
 * published. Pointing the env var at the file is the whole interface:
 * no release lookup, no download, and -- deliberately -- no sha256
 * manifest, because a locally built hex has no `MICROBIT.hex.txt`
 * alongside it and nothing to check one against. See
 * `localFirmware.ts`'s own module doc comment for what replaces that
 * verification step.
 *
 * `hexPath` is always absolute and `~`-expanded by the time it gets
 * here -- {@link parseFirmwareSource} resolves it once, so no consumer
 * has to care what the raw configured string looked like. */
export interface LocalHexFirmwareSource {
  kind: "local-file";
  hexPath: string;
}

/** Where one {@link FirmwareKind}'s flashable image comes from: a GitHub
 * release, or a hex file on this machine's disk. Discriminated by
 * `kind`, which is absent for the (historical, far more common) release
 * shape -- see {@link ReleaseFirmwareSource}'s own doc comment for why
 * it is optional there rather than required on both arms. */
export type FirmwareSource = ReleaseFirmwareSource | LocalHexFirmwareSource;

/** One entry per {@link FirmwareKind}; `undefined` means that
 * firmware's `settings` row was absent, empty, or otherwise could not
 * be resolved to a source -- never a thrown error. */
export type FirmwareConfigMap = Record<FirmwareKind, FirmwareSource | undefined>;

/** Tag used when a configured value carries no explicit `:<tag>`
 * suffix. */
const DEFAULT_TAG = "latest";

/** The `settings.key` each {@link FirmwareKind}'s resolved raw source
 * string is stored under. `store/importers/firmwareConfig.ts` is the
 * sole writer (at bootstrap); {@link getFirmwareConfig} is the sole
 * production reader. */
export const SETTINGS_KEY_BY_FIRMWARE: Record<FirmwareKind, string> = {
  relay: "firmware.relay.source",
  robot: "firmware.robot.source",
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
/** Matches a URL scheme prefix (`https://`, `http://`, `git+ssh://`, …).
 * Used only to rule a value *out* of being a local path -- see
 * {@link isLocalHexPath}. */
const URL_SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * Whether a configured firmware value names a hex file on this machine
 * rather than a GitHub repo (out-of-process, 2026-09-16).
 *
 * This is the **single source of truth** for that question. It is used
 * both when parsing the configured string ({@link parseFirmwareSource})
 * and when interpreting the `firmware.repo` column the resolved value
 * was stored in (`projection.ts`'s `buildFirmwareAvailability`), so the
 * two can never disagree about what a given stored string means -- the
 * column holds exactly what was configured, and exactly one predicate
 * decides how to read it.
 *
 * A value is a local path when it carries no URL scheme **and** either
 * looks like a path (`/…`, `~/…`, `./…`, `../…`) or ends in `.hex`. The
 * `.hex` suffix is what makes a repo-relative `build/MICROBIT.hex` work
 * without a leading `./`; no GitHub repo URL ends in `.hex`, so the two
 * cases cannot collide. Never throws.
 */
export function isLocalHexPath(raw: string): boolean {
  const trimmed = raw.trim();
  if (trimmed.length === 0 || URL_SCHEME_PATTERN.test(trimmed)) {
    return false;
  }
  return (
    trimmed.startsWith("/") ||
    trimmed.startsWith("~/") ||
    trimmed.startsWith("./") ||
    trimmed.startsWith("../") ||
    trimmed.toLowerCase().endsWith(".hex")
  );
}

/** Expand a leading `~`/`~/` to this user's home directory. Any other
 * value (including a `~user` form, which this deliberately does not
 * support) is returned untouched. */
function expandHome(rawPath: string): string {
  if (rawPath === "~") {
    return homedir();
  }
  if (rawPath.startsWith("~/")) {
    return path.join(homedir(), rawPath.slice(2));
  }
  return rawPath;
}

export function parseFirmwareSource(raw: string): FirmwareSource {
  const trimmed = raw.trim();
  // Checked before any `:`-splitting below: a path is never a
  // `<repo-url>:<tag>` pair, and splitting one on a stray colon would
  // silently truncate it into an unopenable file name.
  if (isLocalHexPath(trimmed)) {
    return { kind: "local-file", hexPath: path.resolve(expandHome(trimmed)) };
  }
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

/**
 * Minimal `.env` parser: splits on newlines, skips blank lines and
 * `#`-comments, and splits each remaining line on its first `=` into a
 * key/value pair. Returns a plain map and mutates nothing. A missing
 * `dotenvPath` file yields an empty map, not an error; this is the only
 * I/O in this module and it deliberately never throws.
 *
 * `dotenvPath` is required -- as of sprint 017 ticket 001 this module no
 * longer guesses a default location relative to its own module file
 * (the old `defaultDotenvPath()`, `path.resolve(__dirname,
 * "../../../.env")`, silently resolved to a nonexistent -- or worse,
 * unrelated -- directory under a registry/packaged install, since the
 * on-disk depth from this file to the repo root is not the same as the
 * depth from wherever the package actually gets installed). Finding
 * *which* `.env` file (if any) applies is now `store/importers/
 * firmwareConfig.ts`'s job (state dir, falling back to a checkout's
 * repo root, detected by an actual `package.json` walk rather than a
 * fixed `..` count); this function only ever parses a path it is
 * handed.
 */
export function parseEnvFile(dotenvPath: string): Record<string, string> {
  const vars: Record<string, string> = {};
  if (!existsSync(dotenvPath)) {
    return vars;
  }
  let contents: string;
  try {
    contents = readFileSync(dotenvPath, "utf8");
  } catch {
    return vars;
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
    if (key.length === 0) {
      continue;
    }
    vars[key] = trimmed.slice(eq + 1).trim();
  }
  return vars;
}

/**
 * Copy {@link parseEnvFile}'s result onto `env`, setting `env[key]`
 * only when that key is not already present -- an explicit environment
 * variable always wins over the assembled file. A missing `dotenvPath`
 * file is a no-op, not an error. `dotenvPath` is required for the same
 * reason {@link parseEnvFile}'s is -- see that function's doc comment.
 */
export function loadEnvFile(dotenvPath: string, env: NodeJS.ProcessEnv = process.env): void {
  for (const [key, value] of Object.entries(parseEnvFile(dotenvPath))) {
    if (!(key in env)) {
      env[key] = value;
    }
  }
}

/**
 * Read the two firmware-source `settings` rows
 * ({@link SETTINGS_KEY_BY_FIRMWARE}) and parse them into a
 * {@link FirmwareConfigMap}. Called at host startup (`cli.ts`) and
 * again on every availability poll (`server.ts`/`releases.ts`), so the
 * result is threaded down to callers afresh rather than captured once.
 *
 * As of sprint 017 ticket 001, this reads `settings` via `store` --
 * never `process.env` or a `.env` file directly. Those are
 * `store/importers/firmwareConfig.ts`'s job, run once at every store
 * bootstrap (`store/bootstrap.ts`); "re-read on every call" therefore
 * now means "re-read whatever the importer last wrote", not "re-parse
 * a file on every poll" -- a `.env` edited after the host started is
 * picked up on the next restart (the next bootstrap), not before.
 * Never throws: an absent, empty, or unparseable `settings` value
 * yields `undefined` for that {@link FirmwareKind}'s entry.
 */
export function getFirmwareConfig(store: Store): FirmwareConfigMap {
  return {
    relay: parseConfiguredSetting(store, "relay"),
    robot: parseConfiguredSetting(store, "robot"),
  };
}

function parseConfiguredSetting(store: Store, kind: FirmwareKind): FirmwareSource | undefined {
  const raw = store.getSetting(SETTINGS_KEY_BY_FIRMWARE[kind]);
  if (raw === undefined || raw.trim().length === 0) {
    return undefined;
  }
  return parseFirmwareSource(raw);
}
