---
status: done
sprint: '004'
tickets:
- 004-009
---

# No build pipeline: tsx is a production runtime dependency

## Description

`bin/robot-console.js` loads the app through `tsx` at runtime, and `tsx`
is declared as a **production** dependency rather than a dev tool.

## Cause

Every package's `package.json` points `main`/`types` straight at `.ts`
source — there is no `dist` build output. `npm run build` only runs
`tsc --noEmit` (a type-check), so nothing is ever emitted. Plain Node
cannot load the sources directly: `UsbSerialLink.ts` uses constructor
parameter properties, which Node's type-stripping rejects outright even
with `--experimental-transform-types`.

Ticket 001 set `main` to `./src/index.ts` because the ticket asked for
it, and ticket 009 added `tsx` to make `npx robot-console` actually run.
Both were locally reasonable; together they leave the shipped artifact
depending on a TypeScript loader at runtime.

## Proposed fix

Give each package a real build: emit to `dist/`, point `main`/`types`
there, and drop `tsx` to a devDependency. Keep vitest running against
source.

## Verification

`npx robot-console` runs from a clean install with `tsx` absent from
production dependencies; `npm test` and `npm run build` still pass.
