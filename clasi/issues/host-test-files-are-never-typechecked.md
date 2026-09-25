---
status: pending
---

# `packages/host` never type-checks its own test files, and `packages/ui` does

## The asymmetry

Found during sprint 023, 2026-09-21, and confirmed directly:

```jsonc
// packages/host/tsconfig.json
"include": ["src"],
"exclude": ["src/**/*.test.ts"]   // <- test files are not compiled

// packages/ui/tsconfig.json
"include": ["src"]                // <- no exclude; tests ARE compiled
```

So `npx tsc --noEmit -p packages/host/tsconfig.json` — the command every
ticket on this project treats as "the host build is sound" — says
nothing whatsoever about `packages/host`'s test files.

## Why it matters, with today's evidence

Sprint 023 widened `FirmwareKind` from two members to three. In
`packages/ui`, whose tsconfig compiles tests, that immediately surfaced
**eleven** hand-built `Record<FirmwareKind, …>` fixtures as compile
errors -- a precise, free worklist. In `packages/host` the same class of
fixture is invisible: `store/mbserialEndToEnd.test.ts` carries
`{ relay: …, robot: … }` literals that were never flagged, and were
found only because a programmer grepped for them by hand.

Two ways that bites:

1. **A stale host fixture is only ever caught at runtime, if at all.**
   A fixture missing a required key still transpiles, so vitest runs it
   happily; whether it fails depends on whether some assertion happens
   to touch the missing field.
2. **It makes the two packages' gates mean different things** while
   looking identical at the call site. A programmer who clears
   `tsc --noEmit` on both has checked far more of the UI than of the
   host, and nothing in the command says so.

## Compounding: the test suite cannot cover for it

Vitest transpiles without type-checking. On 2026-09-21 this repo had
**2817 passing tests against a tree that did not compile at all** (both
packages erroring). So "tests pass" and "it type-checks" are fully
independent claims here, and for host test files *neither* gate applies.

## The fix, and the reason it is not a one-liner

Dropping the `exclude` is the obvious move, but it will surface however
many pre-existing errors have accumulated in host tests under a
never-enforced type gate -- possibly a lot, since nothing has ever
checked them. Worth doing deliberately:

1. Remove the exclude locally and count what falls out. That number is
   the real size of this.
2. If it is small, fix and keep the exclude gone.
3. If it is large, consider a second tsconfig (`tsconfig.test.json`)
   checked in CI so the debt is visible and bounded rather than silently
   growing.

Whatever is chosen, the two packages should end up meaning the same
thing by `tsc --noEmit`, or the difference should be documented at the
command people actually run.

## Related

[[css-assertions-in-tests-pass-vacuously]] -- the same shape of problem:
a check that looks like coverage and is not.
