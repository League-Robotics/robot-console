/**
 * Enforces "no SQL outside store/" (architecture.md §4, ticket 014-003;
 * see `./README.md`): scans every `.ts` file under `packages/host/src`
 * outside this directory for a raw sqlite `.prepare(`/`.exec(` call.
 *
 * Mirrors `grep -rn "prepare(\|exec(" packages/host/src --include=*.ts`
 * restricted to outside `store/`, but with one deliberate refinement:
 * `.exec(` is only flagged in a file that itself imports from
 * `"node:sqlite"`, since `.exec(` alone is ambiguous with, e.g.,
 * `RegExp.prototype.exec` (a real, existing call in
 * `packages/host/src/releases.ts`, which this test must not flag).
 * `.prepare(` has no such ambiguity in this codebase — nothing else
 * defines a `.prepare` method — so it is flagged unconditionally,
 * without needing the `node:sqlite`-import gate.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const STORE_DIR = path.resolve(fileURLToPath(new URL(".", import.meta.url)));
const HOST_SRC_DIR = path.resolve(STORE_DIR, "..");
const THIS_FILE = fileURLToPath(import.meta.url);

function listTsFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      files.push(...listTsFiles(full));
    } else if (entry.endsWith(".ts")) {
      files.push(full);
    }
  }
  return files;
}

const NODE_SQLITE_IMPORT = /from\s+["']node:sqlite["']/;
const PREPARE_CALL = /\.prepare\(/;
const EXEC_CALL = /\.exec\(/;

describe("store: no raw SQL outside store/", () => {
  it("finds no .prepare(/.exec( sqlite calls outside packages/host/src/store/", () => {
    const offenders: string[] = [];

    for (const file of listTsFiles(HOST_SRC_DIR)) {
      if (file === THIS_FILE) {
        continue;
      }
      if (file.startsWith(STORE_DIR + path.sep)) {
        continue;
      }
      const text = readFileSync(file, "utf8");
      const relative = path.relative(HOST_SRC_DIR, file);

      if (PREPARE_CALL.test(text)) {
        offenders.push(`${relative}: contains ".prepare("`);
      }
      if (NODE_SQLITE_IMPORT.test(text) && EXEC_CALL.test(text)) {
        offenders.push(`${relative}: imports node:sqlite and contains ".exec("`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it("sanity check: the .exec( scoping actually excludes a real RegExp.exec() call", () => {
    // releases.ts calls a RegExp's .exec() and does not import
    // node:sqlite -- if this ever stops being true, the fixture this
    // test's sibling relies on to prove the scoping isn't a tautology
    // no longer holds, and that sibling test would need a new example.
    const releasesPath = path.join(HOST_SRC_DIR, "releases.ts");
    const text = readFileSync(releasesPath, "utf8");
    expect(EXEC_CALL.test(text)).toBe(true);
    expect(NODE_SQLITE_IMPORT.test(text)).toBe(false);
  });
});
