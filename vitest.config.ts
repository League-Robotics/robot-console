import { defineConfig } from "vitest/config";

// Discovers tests across all three workspace packages, run from the
// repo root via `npm test`. `vendor/` holds reference-only git
// submodules (pxt-nezha-diffdrive, radio-robot-lib) that carry their
// own test suites — those must never be collected by this runner.
//
// `scripts/**` (sprint 018 ticket 001): the bench harness under
// `scripts/bench/` is not a workspace package (it's `tsx`-run repo
// tooling, not published), but it still carries its own vitest unit
// coverage (parsers, the exclusivity check) that must run as part of
// `npm test` like everything else — see `scripts/bench/README.md`.
export default defineConfig({
  test: {
    include: [
      "packages/*/src/**/*.{test,spec}.{ts,tsx}",
      "scripts/**/*.{test,spec}.{ts,tsx}",
    ],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "vendor/**",
    ],
    // Ticket 001 is scaffolding only — no test files exist yet. `npm
    // test` must still exit 0 rather than treating "zero tests found"
    // as a failure.
    passWithNoTests: true,
  },
});
