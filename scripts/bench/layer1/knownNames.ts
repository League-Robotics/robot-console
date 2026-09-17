/**
 * knownNames.ts — read the bench's own roster of previously-seen robot
 * names, read-only, from `known-robots.json` (the file
 * `packages/host/src/store/importers/knownRobots.ts` imports into the
 * store — this module only ever reads it, per the ticket's own "never
 * write to the user's real state dir" constraint).
 *
 * Directory resolution mirrors `packages/host/src/store/stateDir.ts`'s
 * `resolveStateDir` (explicit override -> `ROBOT_CONSOLE_STATE_DIR` ->
 * `${XDG_STATE_HOME:-~/.local/state}/robot-console`), duplicated here in
 * miniature rather than imported — same host-internals boundary as the
 * rest of this harness.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const KNOWN_ROBOTS_FILENAME = "known-robots.json";

/** Resolve `known-robots.json`'s on-disk path, mirroring
 * `store/stateDir.ts`'s own fallback order. Read-only use only. */
export function defaultKnownRobotsPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.ROBOT_CONSOLE_STATE_DIR;
  if (override !== undefined && override.length > 0) {
    return path.join(override, KNOWN_ROBOTS_FILENAME);
  }
  const xdgStateHome = env.XDG_STATE_HOME;
  const base =
    xdgStateHome !== undefined && xdgStateHome.length > 0 ? xdgStateHome : path.join(homedir(), ".local", "state");
  return path.join(base, "robot-console", KNOWN_ROBOTS_FILENAME);
}

/**
 * Parse a `known-robots.json` file's raw text into the list of robot
 * names it records. Pure — never touches the filesystem itself, so it
 * is directly testable against captured file contents. Returns `[]` for
 * anything that doesn't parse as JSON or doesn't have the expected
 * `{ robots: [{ name }, ...] }` shape, never throwing.
 */
export function parseKnownRobotsFile(raw: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null) {
    return [];
  }
  const robots = (parsed as Record<string, unknown>).robots;
  if (!Array.isArray(robots)) {
    return [];
  }
  const names: string[] = [];
  for (const entry of robots) {
    if (typeof entry === "object" && entry !== null && typeof (entry as Record<string, unknown>).name === "string") {
      names.push((entry as Record<string, unknown>).name as string);
    }
  }
  return names;
}

/**
 * Read known robot names from disk (default path from
 * {@link defaultKnownRobotsPath}, or an explicit `filePath` for tests).
 * `[]` if the file doesn't exist or doesn't parse — never throws. This
 * function only ever reads; it never creates, modifies, or deletes the
 * file, per this harness's "never write to the user's real state dir"
 * constraint.
 */
export function readKnownRobotNames(filePath: string = defaultKnownRobotsPath()): string[] {
  if (!existsSync(filePath)) {
    return [];
  }
  try {
    return parseKnownRobotsFile(readFileSync(filePath, "utf8"));
  } catch {
    return [];
  }
}
