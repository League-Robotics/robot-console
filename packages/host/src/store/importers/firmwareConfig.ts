/**
 * firmwareConfig.ts — bootstrap-time importer: resolves the two
 * `ROBOT_CONSOLE_*_FIRMWARE` environment variables into `settings` rows
 * (sprint 017 ticket 001; `clasi/issues/
 * firmware-config-env-becomes-settings-importer.md`).
 *
 * Through sprint 016, `config.ts`'s `getFirmwareConfig` resolved these
 * two variables itself, straight from `process.env`/a `.env` file
 * guessed *relative to `config.ts`'s own module location*
 * (`packages/host/src/config.ts` -> `<repo root>/.env`, three `..`
 * segments up from `__dirname`). Under a registry or packaged install
 * that guess never lands on the right directory -- the on-disk depth
 * from wherever a package actually gets installed to any meaningful
 * "repo root" is not the same fixed number of segments -- so both flash
 * buttons silently rendered "not configured" even when the environment
 * was otherwise set up correctly. This importer is the fix: at every
 * store bootstrap (`store/bootstrap.ts`'s `openStoreWithImports`), it
 * resolves each firmware kind's raw configured string (`process.env`
 * first, then a `.env` file) and writes it into `settings` under
 * {@link SETTINGS_KEY_BY_FIRMWARE} (`config.ts`) -- `config.ts`'s own
 * `getFirmwareConfig` becomes a pure `settings` reader, doing no file
 * I/O of its own (see that module's own doc comment).
 *
 * ## Precedence: `process.env`, then a `.env` file
 *
 * For each {@link FirmwareKind}: an explicit environment variable
 * always wins, full stop -- a present env var overwrites whatever
 * `settings` row is already there, every single bootstrap (this is
 * *not* a one-time-guarded import like `./knownRobots.ts`/
 * `./wifiCredentials.ts`; `Store.setSetting` is naturally idempotent, so
 * re-running this on every restart is exactly what keeps `settings`
 * truthful without any guard row of its own). Only when the env var is
 * absent or blank does a `.env` file get consulted, in this order:
 *
 * 1. `<state dir>/.env` -- if that file exists at all (regardless of
 *    whether it actually sets this particular key), this is the file
 *    used; the repo-root fallback below is not attempted.
 * 2. `<repo root>/.env`, but *only* when running from an actual
 *    robot-console checkout -- detected by {@link findRepoRootEnvPath}
 *    walking up from this module's own directory looking for a
 *    `package.json` whose `"name"` is `"robot-console"` (the monorepo
 *    root's own name), not by a fixed `..` count (see this module's own
 *    replacement of `config.ts`'s old, broken `defaultDotenvPath()`).
 *    Under a packaged/registry install no such ancestor exists and this
 *    step is skipped entirely -- no file outside the install is ever
 *    read.
 *
 * Neither env var nor either `.env` file resolving a kind is not an
 * error: that kind's `settings` row is simply left untouched (nothing
 * to import yet; `getFirmwareConfig` reports `undefined` for it, same
 * as always).
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnvFile, SETTINGS_KEY_BY_FIRMWARE } from "../../config.js";
import type { FirmwareKind } from "../../wsMessages.js";
import { resolveStateDir } from "../stateDir.js";
import type { Store } from "../index.js";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

const ENV_FILENAME = ".env";

/** The `ROBOT_CONSOLE_*` environment variable that configures each
 * {@link FirmwareKind}, following `cli.ts`'s existing
 * `ROBOT_CONSOLE_PORT` naming convention. Moved here from `config.ts`
 * (sprint 017 ticket 001) -- this importer is now the only reader of
 * these variable names; `config.ts`'s `getFirmwareConfig` only ever
 * reads the `settings` keys they get written to. */
const ENV_VAR_BY_FIRMWARE: Record<FirmwareKind, string> = {
  relay: "ROBOT_CONSOLE_RELAY_FIRMWARE",
  robot: "ROBOT_CONSOLE_ROBOT_FIRMWARE",
  // Sprint 023 ticket 002: joystick is a third flashable firmware kind
  // (`League-Microbit/Remote-Joystick-Student`). Deliberately left unset
  // in `.env` by this ticket -- the live joystick release doesn't yet
  // publish the `MICROBIT.hex`/`MICROBIT.hex.txt` asset pair `releases.ts`
  // requires (sprint.md Design Rationale, Decision 3), so pointing this
  // at the real repo waits for ticket 007, once that publishing gap is
  // fixed upstream. Until then this resolves to `undefined` below, same
  // as an unconfigured `relay`/`robot` does today.
  joystick: "ROBOT_CONSOLE_JOYSTICK_FIRMWARE",
};

const FIRMWARE_KINDS: readonly FirmwareKind[] = ["relay", "robot", "joystick"];

export interface ImportFirmwareConfigOptions {
  /** Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Forwarded to {@link resolveStateDir} verbatim. */
  stateDir?: string;
}

/** Injectable seam, mirroring `./knownRobots.ts`/`./wifiCredentials.ts`'s
 * own pattern -- every field defaults to the real implementation. */
export interface ImportFirmwareConfigDeps {
  /** Resolves the repo-root `.env` path when running from a checkout,
   * or `undefined` when no such ancestor is found (a packaged/registry
   * install). Defaults to {@link findRepoRootEnvPath} started from this
   * module's own directory. Overridden by tests so no test ever walks
   * this real repo's real directory tree looking for its own real
   * `.env` -- see {@link findRepoRootEnvPath}'s own doc comment. */
  findRepoRootEnvPath?: () => string | undefined;
}

/** One entry per {@link FirmwareKind}: `true` if that kind's `settings`
 * row was written (from either source) this call, `false` if neither
 * `process.env` nor a `.env` file resolved a non-empty value for it. */
export type ImportFirmwareConfigResult = Record<FirmwareKind, boolean>;

/**
 * Walks up from `startDir` looking for a `package.json` whose own
 * `"name"` field is `"robot-console"` -- the monorepo root's own
 * `package.json`, not merely *a* `package.json` (an installed package
 * sitting a few directories under some unrelated project's
 * `node_modules` would otherwise false-positive on "a `package.json`
 * exists here"). Returns that directory's `.env` path, or `undefined`
 * once the walk reaches the filesystem root without finding one -- the
 * signal that this process is not running from a checkout at all (a
 * packaged/registry install), in which case no repo-root `.env` read is
 * ever attempted.
 *
 * Exported (not just used via {@link ImportFirmwareConfigDeps}'s
 * default) so it can be exercised directly against a constructed
 * fixture directory tree in tests, without ever touching this repo's
 * own real directory tree or its own real `.env`.
 */
export function findRepoRootEnvPath(startDir: string): string | undefined {
  let dir = startDir;
  for (;;) {
    const packageJsonPath = path.join(dir, "package.json");
    if (existsSync(packageJsonPath)) {
      try {
        const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { name?: unknown };
        if (pkg.name === "robot-console") {
          return path.join(dir, ENV_FILENAME);
        }
      } catch {
        // Malformed/unreadable package.json -- not the root we're
        // looking for; keep walking up.
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return undefined;
    }
    dir = parent;
  }
}

function defaultFindRepoRootEnvPath(): string | undefined {
  return findRepoRootEnvPath(MODULE_DIR);
}

/**
 * Resolves the `.env` vars to fall back on when an env var is absent:
 * the state directory's own `.env` if that file exists at all, else the
 * repo root's `.env` when running from a checkout, else an empty map.
 * See this module's own doc comment for the full precedence.
 */
function resolveFileVars(stateDir: string, findRepoRootEnvPathFn: () => string | undefined): Record<string, string> {
  const stateDirEnvPath = path.join(stateDir, ENV_FILENAME);
  if (existsSync(stateDirEnvPath)) {
    return parseEnvFile(stateDirEnvPath);
  }
  const repoRootEnvPath = findRepoRootEnvPathFn();
  if (repoRootEnvPath !== undefined && existsSync(repoRootEnvPath)) {
    return parseEnvFile(repoRootEnvPath);
  }
  return {};
}

/**
 * Resolves both firmware kinds (`process.env` first, then a `.env`
 * file -- see this module's own doc comment) and writes each resolved
 * raw string into its `settings` row. Idempotent by construction (a
 * plain `Store.setSetting` upsert) and deliberately *not* guarded by a
 * one-time `settings` row the way `./knownRobots.ts`/
 * `./wifiCredentials.ts` are -- it is meant to run, and overwrite, on
 * every bootstrap so a present env var always wins over a stale row and
 * an edited `.env` takes effect on the next restart.
 */
export function importFirmwareConfig(
  store: Store,
  options: ImportFirmwareConfigOptions = {},
  deps: ImportFirmwareConfigDeps = {},
): ImportFirmwareConfigResult {
  const env = options.env ?? process.env;
  const findRepoRootEnvPathFn = deps.findRepoRootEnvPath ?? defaultFindRepoRootEnvPath;

  const stateDir = resolveStateDir(options.stateDir !== undefined ? { stateDir: options.stateDir } : {}, env);
  const fileVars = resolveFileVars(stateDir, findRepoRootEnvPathFn);

  const result = {} as ImportFirmwareConfigResult;
  for (const kind of FIRMWARE_KINDS) {
    const envVarName = ENV_VAR_BY_FIRMWARE[kind];
    const fromEnv = env[envVarName];
    const raw = fromEnv !== undefined && fromEnv.trim().length > 0 ? fromEnv : fileVars[envVarName];
    if (raw !== undefined && raw.trim().length > 0) {
      store.setSetting(SETTINGS_KEY_BY_FIRMWARE[kind], raw);
      result[kind] = true;
    } else {
      result[kind] = false;
    }
  }
  return result;
}
