/**
 * hostVersion.ts — resolves the version of the *running host process*,
 * for `GET /api/host-info` (`server.ts`) to report to the UI.
 *
 * Why this needs its own resolution, rather than the UI just reading
 * its own bundled `package.json`: `npm run dev` (port 4795) serves a
 * pre-built static bundle from `packages/ui/dist`, so the bundle can be
 * older than the host it is actually talking to. The fact worth
 * showing a student -- and worth having for our own debugging -- is
 * which host is actually running, not which UI bundle happened to be
 * built last.
 *
 * Precedence, matching the `.deb` packaging's own env-var naming
 * (`store/importers/firmwareConfig.ts`'s `ROBOT_CONSOLE_*` convention):
 *
 * 1. `process.env.ROBOT_CONSOLE_VERSION` -- the `.deb` ships
 *    `/etc/robot-console/robot-console.env` setting exactly this, so a
 *    packaged install never needs to locate a `package.json` at all.
 * 2. The repo-root `package.json`'s own `"version"` field, found by
 *    walking up from this module's directory looking for a
 *    `package.json` whose `"name"` is `"robot-console"` -- the same
 *    "walk up looking for the monorepo root by name, not a fixed `..`
 *    count" approach `firmwareConfig.ts`'s `findRepoRootEnvPath` uses,
 *    for the same reason: a packaged install has a different directory
 *    depth than a checkout, so a fixed relative path would silently
 *    resolve to the wrong file (or nothing) in one of the two.
 *
 * Neither source resolving is not an error -- {@link getHostVersion}
 * returns `undefined` and callers render no version at all, never a
 * wrong or placeholder one.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

/**
 * Walks up from `startDir` looking for a `package.json` whose own
 * `"name"` field is `"robot-console"` -- the monorepo root's own
 * `package.json`, not merely *a* `package.json`. Returns its `version`
 * field, or `undefined` once the walk reaches the filesystem root
 * without finding one (a packaged/registry install, where no such
 * ancestor exists) or finds one with no readable `version` string.
 *
 * Exported so it can be exercised directly against a constructed
 * fixture directory tree in tests, without touching this repo's own
 * real `package.json`.
 */
export function findRepoRootVersion(startDir: string): string | undefined {
  let dir = startDir;
  for (;;) {
    const packageJsonPath = path.join(dir, "package.json");
    if (existsSync(packageJsonPath)) {
      try {
        const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { name?: unknown; version?: unknown };
        if (pkg.name === "robot-console") {
          return typeof pkg.version === "string" && pkg.version.length > 0 ? pkg.version : undefined;
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

/**
 * Resolves the running host's version: `ROBOT_CONSOLE_VERSION` when
 * set (the `.deb`'s own env file), else the repo-root `package.json`'s
 * `version` when running from a checkout, else `undefined`. Reads
 * fresh on every call (not memoized) so tests can toggle
 * `process.env.ROBOT_CONSOLE_VERSION` between assertions.
 */
export function getHostVersion(findRepoRootVersionFn: (startDir: string) => string | undefined = findRepoRootVersion): string | undefined {
  const fromEnv = process.env.ROBOT_CONSOLE_VERSION;
  if (typeof fromEnv === "string" && fromEnv.length > 0) {
    return fromEnv;
  }
  return findRepoRootVersionFn(MODULE_DIR);
}
