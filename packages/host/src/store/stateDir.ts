/**
 * stateDir.ts — the one place that resolves robot-console's host state
 * directory: an explicit override, then `ROBOT_CONSOLE_STATE_DIR`, then
 * `${XDG_STATE_HOME:-~/.local/state}/robot-console`.
 *
 * Factored out of `resolveKnownRobotsFilePath` (originally
 * `store/knownRobots.ts`) so every file that lives in the state
 * directory — `known-robots.json`, `wifi-credentials.json`,
 * `console.sqlite` (db.ts), and (sprint 021 ticket 003) `daemon.json`/
 * `console.log` (`daemon/daemonInfo.ts`) — resolves its directory the
 * same way, without re-encoding the override/XDG fallback logic per
 * file.
 *
 * {@link resolveKnownRobotsFilePath} itself moved here outright (sprint
 * 015 ticket 003): `store/knownRobots.ts` (the old in-memory
 * `KnownRobotsStore`, superseded by `store/importers/knownRobots.ts` +
 * the SQLite `devices` table) is retired along with `deviceRegistry.ts`
 * and its other satellites, but `store/wifiCredentials.ts` and
 * `store/bootstrap.ts` still need this one function to locate
 * `known-robots.json` on disk — moving just the function (not the
 * retired class around it) keeps the deletion clean without inventing a
 * new module neither ticket asked for.
 */
import { homedir } from "node:os";
import path from "node:path";

/** Filename of the on-disk known-robots roster, joined onto whichever
 * directory {@link resolveKnownRobotsFilePath} resolves. */
const KNOWN_ROBOTS_FILENAME = "known-robots.json";

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

/**
 * Resolve the on-disk path for `known-robots.json`, following (in
 * priority order): an explicit `filePath`, else {@link resolveStateDir}'s
 * directory joined with this file's name. Moved here verbatim from
 * `store/knownRobots.ts` (sprint 015 ticket 003, retiring that module) —
 * see this module's own doc comment.
 */
export function resolveKnownRobotsFilePath(
  options: { filePath?: string; stateDir?: string } = {},
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (options.filePath !== undefined) {
    return options.filePath;
  }
  return path.join(resolveStateDir(options, env), KNOWN_ROBOTS_FILENAME);
}

/** Filename of the daemon-info record (`daemon/daemonInfo.ts`'s
 * `{pid, host, port, startedAt}`), joined onto {@link resolveStateDir}'s
 * directory. */
const DAEMON_INFO_FILENAME = "daemon.json";

/** Filename the daemon CLI's detached child (`start`) redirects its
 * stdout/stderr into, joined onto {@link resolveStateDir}'s directory —
 * sprint 021 ticket 003's own "where daemon logs go" open question,
 * resolved to the same already-solved state directory rather than a
 * second convention (`sprint.md`'s Design Rationale, "Daemon log
 * destination"). */
const DAEMON_LOG_FILENAME = "console.log";

/**
 * Resolve the on-disk path for `daemon.json` — an explicit `filePath`,
 * else {@link resolveStateDir}'s directory joined with this file's name.
 * Same pattern as {@link resolveKnownRobotsFilePath}; no new
 * state-directory resolution rule.
 */
export function resolveDaemonInfoFilePath(
  options: { filePath?: string; stateDir?: string } = {},
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (options.filePath !== undefined) {
    return options.filePath;
  }
  return path.join(resolveStateDir(options, env), DAEMON_INFO_FILENAME);
}

/**
 * Resolve the on-disk path for the daemon's `console.log` — same
 * pattern as {@link resolveDaemonInfoFilePath}/{@link resolveKnownRobotsFilePath}.
 */
export function resolveDaemonLogFilePath(
  options: { filePath?: string; stateDir?: string } = {},
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (options.filePath !== undefined) {
    return options.filePath;
  }
  return path.join(resolveStateDir(options, env), DAEMON_LOG_FILENAME);
}
