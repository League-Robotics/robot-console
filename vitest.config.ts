import { defineConfig } from "vitest/config";

// Discovers tests across all three workspace packages, run from the
// repo root via `npm test`. `vendor/` holds reference-only git
// submodules (pxt-nezha-diffdrive, radio-robot-lib) that carry their
// own test suites — those must never be collected by this runner.
export default defineConfig({
  test: {
    include: [
      "packages/*/src/**/*.{test,spec}.{ts,tsx}",
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
