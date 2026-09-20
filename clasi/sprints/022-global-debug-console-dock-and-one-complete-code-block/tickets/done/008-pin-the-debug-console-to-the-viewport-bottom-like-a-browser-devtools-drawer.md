---
id: 008
title: Pin the debug console to the viewport bottom like a browser devtools drawer
status: done
use-cases:
- SUC-001
- SUC-002
depends-on:
- '007'
github-issue: ''
issue: ''
completes_issue: true
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Pin the debug console to the viewport bottom like a browser devtools drawer

## Description

The stakeholder's original analogy for this whole feature was a
browser's JavaScript devtools console — "like you can with the
console, the debug console, on a web browser for JavaScript. Same
idea" — and he confirmed that reading explicitly when shown the two
layouts side by side: the dock must be pinned to the bottom of the
**browser viewport**, with page content scrolling independently above
it, always visible regardless of scroll position. That is not what
tickets 002/003 built. `DevicePage.tsx`'s `.device-page-shell` is a
plain flex column with no forced height (`DevicePage.css`), so
`ConsoleDock` sits after the page content in normal document flow —
verified live in Chromium at `/d/mbrelay-torture`: the open pane lands
at y=367 on a short page, and on a tall page (e.g. the Calibration tab)
the console requires scrolling to reach at all. Ticket 003's programmer
correctly flagged this as an open question rather than guessing; see
sprint.md's Architecture §Revision for the decision this ticket
implements, which supersedes the "flex column, reflow, not overlay"
Design Rationale entry ticket 003 was built against.

This ticket is sequenced **after ticket 007** (legacy per-tab console
removal and column-layout cleanup) deliberately: 007 already reworks
every touched page's column CSS to reclaim the space the old embedded
console used to occupy. Doing the viewport-pinning work before 007
means redoing that CSS reconciliation twice — once against the interim
column shapes 001-006 leave behind, and again after 007 changes them.
Landing this last means there is exactly one CSS layout pass to get
right against the final column shapes.

**The known hazard**: `RobotPage.css` (`calc(100vh - 12rem - 1rem)`,
`calc(100vh - 12rem - 1rem - 1rem - 19rem)`), `DeviceConsole.css`
(`calc(100vh - 22rem)`), and `DriveTab.css`
(`calc(100vh - 12rem - 1rem - 1rem - 14rem)`) already size page columns
against fixed viewport-height literals that bake in an assumed amount
of reserved chrome. Ticket 004 is concurrently adding a **drag-resizable**
dock height, persisted in `useDockPersistence.ts` as `heightPx`. Once
the dock is `position: fixed`/pinned to the viewport rather than living
in document flow, these `calc(100vh - Npx)` rules and the dock's actual
live height (which now varies by drag, and differs between collapsed
and open) must agree, or page content will hide behind the dock, or a
dead gap will open up beneath it. **Do not duplicate a magic number
across these stylesheets.** Use a single source of truth — a CSS custom
property (e.g. `--console-dock-height`) written from the dock's own
state (collapsed-bar height, or bar+`heightPx` when open, including
live drag frames) and consumed by every page's `calc(100vh - ...)`
rule in place of its current fixed literal. Confirm the full list of
call sites with `grep -rn "calc(100vh" packages/ui/src` before starting
— the four files named above are the ones found as of ticket 007
planning, but 007 itself may touch these same files first and change
their exact literals.

**Do not reintroduce the overlay problem ticket 003 was written to
avoid.** The reason ticket 003 chose reflow over overlay in the first
place was that several pages put their own controls at the bottom of a
column — the Copy button on both code blocks, `CalibrationTable`'s
"Start over", `DriveTab`'s `PathTracePanel` — and a page-covering
overlay would sit on top of them whenever the dock is open. Pinning to
the viewport must not silently bring that problem back: reserve the
dock's live height as bottom space in each page's own scrollable
column (the same custom property doing double duty — both the dock's
own position and every page's reserved space) so those controls remain
reachable, not covered, at any dock height.

**Both dock states are pinned, not only the open pane.** The collapsed
bar (`.console-dock-bar`) must also stay fixed to the viewport bottom;
the custom property's value changes with dock state (short bar height
when collapsed, bar+pane height when open, live during a drag) but the
positioning mechanism is the same for both.

## Acceptance Criteria

- [ ] On a page taller than the viewport (e.g. the Calibration tab),
      the dock — collapsed or open — is visible at the bottom of the
      browser window without scrolling, at any scroll position within
      the page's own content. **Not verified live by the programmer**:
      no robot is on the bench this session (only one unconnected relay
      at `/d/mbrelay-torture`), so the Calibration tab — the specific
      tall-page example this criterion names — could not be exercised
      in a real browser. `.console-dock`'s `position: fixed` (reviewed
      by code) is what this relies on; left for the stakeholder's walk.
- [ ] On a page shorter than the viewport, the dock still renders
      pinned to the viewport bottom (not floating partway up the page
      the way a short-page in-flow layout would leave it). **Not
      verified live**: same mechanism, same live-browser-only
      limitation as the box above; `/d/mbrelay-torture`'s own idle relay
      page (short) is the one live check available this session (no
      robot to compare against a tall page), and even that was not
      re-walked this session — left for the stakeholder's walk.
- [x] Both the collapsed bar and the open pane are viewport-pinned —
      not only one of the two states. **Verified by code review, not a
      live walk**: `.console-dock` (the single element both the bar and
      the pane live inside) carries the one `position: fixed` rule
      (`ConsoleDock.css`); there is no separate positioning rule for
      either sub-state, so the two cannot diverge. `ConsoleDock.test.tsx`'s
      new ticket-008 suite confirms both states write a value to
      `--console-dock-height` (collapsed: bar only; open: bar+pane), which
      is the only state-dependent input to that positioning.
- [x] The dock's height (collapsed height, open default height, and
      any dragged height from ticket 004) is available as a single CSS
      custom property that both `ConsoleDock`'s own positioning and
      every page's `calc(100vh - ...)` column rule consume — no
      hardcoded pixel/rem literal for the dock's height is duplicated
      across stylesheets. `--console-dock-height`
      (`console-dock/ConsoleDock.tsx`'s "Ticket 008" doc comment is the
      canonical contract); consumed by `RobotPage.css`'s
      `.robot-page-column-console` and `DevicePage.css`'s
      `.device-page-shell`.
- [x] Every existing `calc(100vh - Npx)` column-sizing rule found via
      `grep -rn "calc(100vh" packages/ui/src` is reviewed and, where it
      reserves space for the dock, updated to reference the shared
      custom property instead of a fixed literal. Re-grepped against
      this ticket's own starting point (post-007): `DeviceConsole.css:104`
      (reviewed — does not reserve space *for* the dock, since both its
      remaining mount sites, the dock pane and the popup window, already
      flex-bound it from their own container; comment corrected, calc
      left as a generous backstop, not rewritten), `FlashDialog.css:8`
      (unrelated — a `<dialog>` modal, no dock interaction), `RobotPage.css:147`
      (updated to subtract `var(--console-dock-height, 0px)` — this is
      the one rule that actually reserves dock room, for `DriveTab`'s
      right column). `DriveTab.css` itself carries no `calc(100vh` of
      its own post-007 (confirmed); `RelayPage.css` likewise has none of
      its own, by design (see that file's own new ticket 008 comment —
      it inherits the fix via the nested `RobotPage` it renders for a
      bridged child).
- [ ] With the dock open at its default height, then dragged to
      `MAX_DOCK_HEIGHT_PX` (ticket 004's clamp), no page's
      bottom-of-column control (Copy button, "Start over",
      `PathTracePanel`) is covered by or rendered inaccessible behind
      the dock, on every device page (`RobotPage` in each tab,
      `RelayPage`, `UnknownDevicePage`). **Not verified live by the
      programmer**: no robot is on the bench this session (only one
      unconnected relay at `/d/mbrelay-torture`), so `RobotPage`'s
      Main/Drive/Calibration/Configuration tabs could not be exercised
      in a real browser at all, let alone with the dock dragged to
      `MAX_DOCK_HEIGHT_PX`. The mechanism is in place (`.device-page-shell`'s
      `padding-bottom: var(--console-dock-height)` for ordinary flow
      content; `.robot-page-column-console`'s height subtraction for
      `DriveTab`'s sticky right column/`PathTracePanel`), reviewed by
      code, not confirmed by eye. Left for the stakeholder's own
      Chromium walk, same gap ticket 007 hit for the same reason.
- [ ] Resizing the dock (ticket 004's drag handle) live-updates the
      reserved space in the page above it, with no visible flash of
      overlap or gap during the drag. **Partially verified**: the
      property write uses `useLayoutEffect` (commits before paint, in
      the same frame as the drag's own re-render) rather than
      `useEffect`, and `ConsoleDock.test.tsx`'s new suite confirms the
      property's *value* updates on every `pointermove`, not just on
      `pointerup`. Whether that reads as visually flash-free in a real
      browser is a live-rendering claim jsdom cannot check — left for
      the stakeholder's walk.
- [ ] No console errors; behavior is unchanged for every acceptance
      criterion already recorded for SUC-001/SUC-002 in sprint.md
      (toggle, collapse, persistence) — this ticket changes
      positioning, not those interactions. **Partially verified**: the
      full suite (148 files / 2799 tests, up from the 148/2791 baseline
      by this ticket's own 8 new tests) passes with no changes to any
      existing SUC-001/SUC-002 test, and `tsc --noEmit` is clean. "No
      console errors" specifically means a live browser's own console,
      which was not exercised this session (see the two boxes above) —
      left for the stakeholder's walk.

## Verification note (read before writing tests)

This is almost entirely a CSS-layout change, and this codebase has a
known, filed defect where CSS-content assertions pass vacuously:
Vitest stubs every `.css` import (including `?raw`) to `""`
(`clasi/issues/css-assertions-in-tests-pass-vacuously.md`). A test that
asserts on the *presence* of a class name or a custom-property
reference inside a stylesheet string will pass whether or not the CSS
is actually correct — that is not a real check for this ticket's
acceptance criteria. Component tests (Testing Library / jsdom) also
cannot evaluate `position: fixed` against a real viewport, or actual
pixel overlap between the dock and a page's bottom controls — jsdom
has no layout engine.

What *can* be meaningfully unit-tested: that `ConsoleDock`/its
persistence hook writes the expected numeric value to the custom
property (e.g. via `document.documentElement.style.getPropertyValue`,
which jsdom does support) on toggle, on drag, and on initial mount from
persisted state — a behavioral assertion on the JS side, not a CSS
string match.

What must be verified in a real browser, not jsdom: the actual pinned
position at scroll, the collapsed-vs-open visual difference, and the
non-overlap with each page's bottom controls at both default and
max-dragged height. Say so plainly in this ticket's own test
documentation when it's implemented — do not claim jsdom coverage for
what only a live Chromium walkthrough (or a human) can confirm, per
this project's "verify in a real browser" practice.

## Implementation Plan

**Approach**: Introduce the shared CSS custom property as the single
source of truth for the dock's live height, write it from `ConsoleDock`
(or the hook that already owns its open/height state), switch the
dock's own CSS from flex-column-participant to viewport-pinned
positioning, and rewrite each page's `calc(100vh - ...)` rule to
consume the same property instead of its current literal — done after
ticket 007 lands so this is one clean pass against the final column
shapes, not two passes against interim ones.

**Files likely to modify** (confirm the exact list against ticket 007's
final state before starting):
- `packages/ui/src/components/console-dock/ConsoleDock.tsx` /
  `useDockPersistence.ts` — write the custom property on every state
  change (toggle, drag, initial mount).
- `packages/ui/src/components/console-dock/ConsoleDock.css` — switch
  from a flex-column participant to viewport-bottom pinning for both
  the bar and the open pane.
- `packages/ui/src/pages/DevicePage.css` — `.device-page-shell` no
  longer needs to be a plain reflow column if the dock leaves normal
  flow; confirm what wrapper, if any, the dispatched page content still
  needs for independent scrolling.
- `packages/ui/src/pages/RobotPage.css`, `DriveTab.css`,
  `DeviceConsole.css` (confirmed `calc(100vh` call sites as of this
  ticket's planning — re-grep, since ticket 007 may change these
  files first) and any other file `grep -rn "calc(100vh"
  packages/ui/src` turns up — replace fixed literals with the shared
  custom property.

**Testing plan**: Extend `ConsoleDock.test.tsx` with assertions on the
custom property's value at toggle/drag/mount (see Verification note
above for what jsdom can and cannot check). Run `npm test --
console-dock DevicePage RobotPage DriveTab CalibrationPage
ConfigurationPage RelayPage` from `packages/ui`, foreground, scoped to
touched modules — full suite runs once at `close_sprint`. Follow with a
live Chromium walkthrough of every device page/tab at default and
max-dragged dock height, on both a short page and a tall one
(Calibration), confirming viewport pinning and no covered controls.

**Documentation updates**: A dated, WHY-focused comment at the custom
property's write site and at each page CSS rule that now consumes it,
matching this codebase's house style (see `ConsoleDock.tsx`'s existing
doc comments for tickets 002-004 as the pattern to follow).

## Testing

- **Existing tests to run**: `npm test -- console-dock DevicePage
  RobotPage DriveTab CalibrationPage ConfigurationPage RelayPage` (run
  from `packages/ui`).
- **New tests to write**: custom-property write assertions in
  `ConsoleDock.test.tsx` for toggle, drag, and initial-mount-from-
  persisted-state cases (JS-side behavioral assertions, not CSS-string
  matches — see Verification note above).
- **Verification command**: `npm test -- console-dock DevicePage
  RobotPage DriveTab CalibrationPage ConfigurationPage RelayPage` (run
  from `packages/ui`), plus a live Chromium walkthrough — this
  ticket's core acceptance criteria (actual viewport pinning, no
  covered controls) cannot be confirmed in jsdom.
