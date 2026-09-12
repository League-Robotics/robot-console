import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * vendorSubmodules.test.ts — a single, fast-failing sanity check that the
 * two `vendor/` git submodules this repo's protocol fixtures read from
 * (`radioAddress.test.ts`, `v6/codec.test.ts`, `v6/session.test.ts`) are
 * actually initialized, per ticket 014-001's build-hygiene acceptance
 * criteria.
 *
 * Those three test files already carry their own per-fixture
 * "submodule not initialized" error message at the point they read their
 * specific fixture file. This test is deliberately narrower and runs
 * first (alphabetically, `v` sorts before those files' own `radioAddress`/
 * `v6` paths only coincidentally -- the point is independence, not
 * ordering): it checks only that each submodule's `docs/` directory
 * exists at all, so a missing `git submodule update --init` is reported
 * here, clearly, rather than only surfacing as a confusing JSON-parse or
 * ENOENT failure deep inside an unrelated test's assertions.
 */

const REPO_ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../");

const SUBMODULE_DOCS_PATHS = [
  "vendor/pxt-nezha-diffdrive/docs",
  "vendor/radio-robot-lib/docs",
] as const;

describe("vendor/ git submodules", () => {
  for (const relativeDocsPath of SUBMODULE_DOCS_PATHS) {
    it(`${relativeDocsPath} exists (submodule initialized)`, () => {
      const docsPath = path.join(REPO_ROOT, relativeDocsPath);
      expect(
        existsSync(docsPath),
        `${relativeDocsPath} not found at ${docsPath}. ` +
          "The vendor/ git submodules are not initialized -- run " +
          "`git submodule update --init` from the repo root, then re-run the tests.",
      ).toBe(true);
    });
  }
});
