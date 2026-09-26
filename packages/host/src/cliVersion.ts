/**
 * cliVersion.ts — resolves the version string that `rconsole`,
 * `robot-console`, and `robot-console-supervisor` print for their
 * `--version`/`-V` (and, for `rconsole`, `version`) handling (sprint 026
 * ticket 001).
 *
 * Reuses `hostVersion.ts`'s {@link findRepoRootVersion} — the same
 * walk-up-by-name `package.json` lookup `GET /api/host-info` already
 * relies on — rather than re-implementing "find the root package.json"
 * a third time for three separate `bin/*.js` entry points. That walk
 * starts from *this module's own* file location (`import.meta.url`,
 * resolved the same way `hostVersion.ts` resolves its own `MODULE_DIR`)
 * and climbs until it finds a `package.json` named `"robot-console"` —
 * which is what makes this resolve correctly both from a repo checkout
 * (this file lives under `packages/host/src|dist`, several levels below
 * the root) and from a global `npm link` install (`npm link` symlinks
 * the whole package directory into the global `node_modules`, so the
 * same relative walk-up still lands on the linked package's own
 * `package.json`, symlink or not — `fs.existsSync`/`readFileSync`
 * resolve through directory symlinks transparently).
 *
 * Deliberately does NOT consult `ROBOT_CONSOLE_VERSION` the way
 * `getHostVersion` does: that env var answers "which host is this
 * *running* process" (the `.deb`'s own env file), a different question
 * from "what version of this CLI did I install" — an operator who has
 * set it to debug a running host should not see it silently change what
 * `rconsole --version`/`robot-console --version` themselves report.
 *
 * Never throws and never resolves to nothing: a checkout/install so
 * broken that no ancestor `package.json` names `"robot-console"` still
 * gets a one-line answer (`"unknown"`), not a crash, out of a flag whose
 * entire job is to be a cheap, side-effect-free diagnostic.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findRepoRootVersion } from "./hostVersion.js";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

/**
 * Resolves the installed package's version. `startDir` defaults to this
 * module's own directory (real callers never pass it); tests pass a
 * constructed fixture directory to exercise the walk-up without
 * touching this repo's own real `package.json`.
 */
export function getCliVersion(startDir: string = MODULE_DIR): string {
  return findRepoRootVersion(startDir) ?? "unknown";
}
