---
status: pending
---

# The debug console's dragged height is clamped to 640px but not to the window's own height

## What I saw

Found during the sprint 022 close-out Chromium walk, 2026-09-20, on a
deliberately short viewport (1100x500) at `/d/mbrelay-torture`.

Dragging the dock taller gave `--console-dock-height: 490px` against a
500px-tall window: the dock's top edge sat at y=10, leaving ten pixels
of page. Nothing malfunctioned — every pinning assertion still passed —
but the console had effectively swallowed the page.

## Why it is worth fixing

`ConsoleDock.tsx` clamps the drag to `MAX_DOCK_HEIGHT_PX = 640`, chosen
(per its own comment) to "leave ~200px of page content visible on a
typical laptop viewport". That reasoning is sound and the constant is
fine — it is just measured against an assumed viewport rather than the
real one. On a short window, or a laptop with the browser not
maximised, 640 leaves nothing.

Two consequences:

1. **The height persists.** `useDockPersistence` stores `heightPx`, so a
   height dragged on a tall window comes back on a short one, and the
   student arrives at a page that is almost entirely console with no
   obvious cause. The fix for that is not to stop persisting — that was
   a deliberate decision — but to clamp on read as well as on drag.
2. **`calc()` can go negative.** `RobotPage.css`'s
   `.robot-page-column-console` computes
   `calc(100vh - 12rem - 1rem - var(--console-dock-height, 0px))`. At a
   684px total dock height on a 500px viewport that is negative. CSS
   clamps a negative `height` to 0 rather than erroring, so this
   degrades quietly rather than breaking — which is exactly why nobody
   would notice it was happening.

## The shape of a fix

Clamp against `window.innerHeight` as well as the constant — something
like `min(MAX_DOCK_HEIGHT_PX, innerHeight - MIN_PAGE_VISIBLE_PX)` —
applied both during the drag and when reading the persisted value back,
and re-applied on window resize. A browser devtools drawer, which is
this feature's stated model, behaves this way.

## Do not test this in jsdom

jsdom has no layout engine: `getBoundingClientRect` and `offsetHeight`
read 0, which is why `COLLAPSED_DOCK_HEIGHT_PX` is a hand-measured
constant in the first place. The custom property's *value* is
assertable in jsdom and should be; the visual consequence is not.
Verify in a real browser at a deliberately short viewport — the walk
above reproduces it in about fifteen seconds.

## Severity

Low. No data loss, nothing silently wrong, and the student can drag it
back. Filed because it is the one rough edge the sprint-022 walk found
that nothing in the test suite could ever catch.
