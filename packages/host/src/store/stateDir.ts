/**
 * stateDir.ts — the one place that resolves robot-console's host state
 * directory: an explicit override, then `ROBOT_CONSOLE_STATE_DIR`, then
 * `${XDG_STATE_HOME:-~/.local/state}/robot-console`.
 *
 * Factored out of {@link resolveKnownRobotsFilePath} (knownRobots.ts) so
 * every file that lives in the state directory — `known-robots.json`,
 * `wifi-credentials.json`, and now `console.sqlite` (db.ts) — resolves
 * its directory the same way, without re-encoding the override/XDG
 * fallback logic per file. `resolveKnownRobotsFilePath`'s own behavior
 * is unchanged: it still returns exactly what it returned before this
 * refactor, for every input.
 */
import { homedir } from "node:os";
import path from "node:path";

/** Directory-resolution inputs shared by every per-file `resolve*Path`
 * helper in `store/`. */
export interface StateDirOptions {
  /** Use this directory as-is, overriding every fallback below.
   * Ignored when a caller-level `filePath` is given instead — that is
   * each file's own concern, not this helper's. */
  stateDir?: string;
}

/**
 * Resolve robot-console's state directory: `options.stateDir` as-is if
 * given, else `env.ROBOT_CONSOLE_STATE_DIR` as-is if set and non-empty,
 * else `${env.XDG_STATE_HOME:-~/.local/state}/robot-console` (the one
 * fallback that appends the `robot-console` subdirectory, since that
 * base directory is shared across unrelated applications).
 */
export function resolveStateDir(
  options: StateDirOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (options.stateDir !== undefined) {
    return options.stateDir;
  }
  const override = env.ROBOT_CONSOLE_STATE_DIR;
  if (override !== undefined && override.length > 0) {
    return override;
  }
  const xdgStateHome = env.XDG_STATE_HOME;
  const base =
    xdgStateHome !== undefined && xdgStateHome.length > 0
      ? xdgStateHome
      : path.join(homedir(), ".local", "state");
  return path.join(base, "robot-console");
}
