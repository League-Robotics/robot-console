---
status: pending
---

# CSS-content assertions in UI tests pass vacuously — Vitest stubs every `.css` import to `""`

## The gap

Found by ticket 022-001's programmer while trying to assert the
`.calibration-code` wrap change, 2026-09-20.

`packages/ui/vitest.config.ts` sets no `test.css` option, so Vitest
stubs **every** `.css`-extension import to the empty string — including
ones carrying an explicit `?raw` query, which in a Vite *build* would
return the file's source text. A test that imports a stylesheet to
assert something about its contents therefore reads `""`.

## Why it is worse than "no coverage"

`packages/ui/src/pages/RobotPage.test.tsx` already does this, via
`robotPageCssSource`, and the assertion is phrased as `.not.toMatch(...)`
— which is trivially true against `""`. So the test **passes**, has
always passed, and would go on passing if the CSS it guards were deleted
outright. It reads like coverage and is not.

That is the dangerous shape: an inverted assertion against empty content
cannot fail. A positive `.toMatch(...)` would at least have failed loudly
on day one and been noticed.

## Why 022-001 did not fix it

Out of that ticket's scope, and the obvious workaround is worse: reading
the file with `node:fs` fails `tsc --noEmit`, because
`packages/ui/tsconfig.json` deliberately carries `"types": ["vite/client"]`
and no Node types. Adding Node types to a browser package to make one
test work would be paying a real architectural cost for a test that
should probably be written a different way.

022-001 removed its own CSS assertions rather than write a vacuous one,
and documented the finding inline in `CalibrationPage.test.tsx`.

## Options, none yet chosen

- Set `test: { css: true }` (or a targeted transform) in
  `vitest.config.ts` so `?raw` imports return real text — then audit
  every existing CSS assertion, since some may start failing honestly.
- Assert computed style in jsdom instead of file text, where the property
  is one jsdom actually computes.
- Drop file-text assertions entirely and cover layout regressions in the
  browser walk instead, which is where the clipping in 022-001 was
  actually caught — by the stakeholder, in a screenshot, not by a test.

## Do this first

Whatever the fix, **re-check `RobotPage.test.tsx`'s own assertion under
it**. It is the known instance; there may be others. Grep for `?raw`
alongside `.css` across `packages/ui/src`.
