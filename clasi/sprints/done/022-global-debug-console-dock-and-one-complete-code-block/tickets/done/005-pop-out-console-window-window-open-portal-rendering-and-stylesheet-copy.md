---
id: '005'
title: 'Pop-out console window: window.open, portal rendering, and stylesheet copy'
status: done
use-cases:
- SUC-003
depends-on:
- '003'
github-issue: ''
issue: ''
completes_issue: true
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Pop-out console window: window.open, portal rendering, and stylesheet copy

## Description

Add a pop-out ("expand") button to the open dock (ticket 003) that
opens the same console content in its own browser window. This is a
genuinely new mechanism for this codebase — `grep -rn "window.open"
packages/ui/src` currently returns zero matches, confirmed while
planning this sprint. Three real hazards apply here (sprint.md
Architecture, Step 1 / stakeholder's own brief) and each needs a
concrete answer, not just an attempt:

1. **User-gesture requirement.** `window.open` must be called
   synchronously from the pop-out button's own click handler, not from
   inside an effect or a promise continuation, or the browser will
   block it as an unrequested popup.
2. **No shared stylesheets.** The popup gets a brand-new `document`
   with none of the parent's CSS. This app has a single global
   stylesheet built from ~30 plain `.css` files with cross-file
   class-name reuse (confirmed while planning: `ConfigurationPage.tsx`
   relies on `.calibration-code` rules defined in
   `CalibrationPage.css`, not its own file) — copying only "the file
   that owns this component" is not sufficient. Copy the **entire**
   set of `<style>`/`<link rel="stylesheet">` elements found in the
   live parent `document.head` at the moment the popup opens, into the
   popup's own `<head>`. This works in both Vite dev (per-module
   injected `<style>` tags) and a production build (one or few bundled
   `<link>` stylesheets) because it reads whatever's actually present
   in the DOM rather than assuming a build-specific shape.
3. **Lifecycle events, both directions.** The popup's own `pagehide`
   (preferred over `beforeunload` for reliability across browsers) must
   notify the parent so the dock can reopen; the parent's own `unload`
   must close the popup so a reloaded/closed parent tab doesn't orphan
   a window with no way back. Because event delivery isn't perfectly
   reliable (a window force-closed by the OS may not fire `pagehide` at
   all), also poll `popup.closed` at a low frequency (e.g. every
   second) as a fallback safety net — document this as a pragmatic
   belt-and-suspenders measure, not the primary mechanism.

**Testability**: jsdom has no real `window.open` (it returns `null` by
default) — introduce `packages/ui/src/lib/popupWindow.ts` exporting
`openPopupWindow(name: string, features: string): Window | null`, a
thin wrapper around the bare `window.open` call and nothing else. Tests
substitute a fake `Window`-shaped object (a plain object exposing
`document`, `closed`, `close()`, and an event-target-like surface for
`pagehide`) via this one seam, never a real browser window. The seam
has no use case of its own; it exists purely so SUC-003's
pop-out/restore logic is unit-testable at all.

Scope for this ticket: opening, portaling content in, copying
styles, and the "put it back" button inside the popup, plus the
close↔reopen event wiring described above. **Route-driven retargeting**
(switching devices while popped out, closing on `/`-navigation, the
relay-bridging handoff) is ticket 006's job — this ticket's popup only
needs to track the same `{ link, name }` `ConsoleDock` already receives
(ticket 002/003), not react to it changing yet.

## Acceptance Criteria

- [x] `lib/popupWindow.ts` exports `openPopupWindow(name, features):
      Window | null`, calling the bare `window.open` and nothing more.
- [x] The pop-out button's `onClick` handler calls `openPopupWindow`
      synchronously (no `await`/effect indirection before the call).
- [x] The popup renders the same `DeviceConsole`/`CommandStrip` content
      via a `ReactDOM.createPortal` into the popup's `document.body`.
- [x] Every `<style>`/`<link rel="stylesheet">` element present in the
      parent `document.head` at open time is copied into the popup's
      `<head>`; the popup is visually consistent with the main window
      (verified live in both `npm run dev` and a production build —
      **ask the stakeholder to restart `npm run dev`** if a restart is
      genuinely needed to pick up a build change; never kill or
      restart it yourself, per this project's standing safety rule —
      Vite HMR should pick up UI source changes without one in the
      normal case).
- [x] Activating the pop-out button collapses the docked console in
      the main window (ticket 003's collapsed state).
- [x] The popup has a "put it back" control that closes the popup and
      reopens the main-window dock (open, not collapsed).
- [x] Closing the popup window directly (its native close control)
      also reopens the main-window dock — covered by both the
      `pagehide` listener and the `popup.closed` poll fallback.
- [x] The parent window's `unload` closes an open popup, so a reload or
      tab close doesn't orphan it.
- [x] All of the above is tested against the `lib/popupWindow.ts` fake
      seam — no test depends on a real browser `window.open`.

## Implementation Plan

**Approach**: Isolate all popup mechanics in one component
(`PopupConsoleWindow.tsx`) that knows nothing about dock chrome
(toggle/resize) — it only knows how to render `{ link, name }` content
into a foreign document and manage that document's lifecycle. This
keeps `ConsoleDock` simple (it just knows "am I popped out or not") and
keeps the one genuinely hazardous piece of new code contained and
independently testable.

**Files to create**:
- `packages/ui/src/lib/popupWindow.ts` — the `window.open` seam.
- `packages/ui/src/lib/popupWindow.test.ts`
- `packages/ui/src/components/console-dock/PopupConsoleWindow.tsx` —
  open/portal/stylesheet-copy/lifecycle logic.
- `packages/ui/src/components/console-dock/PopupConsoleWindow.test.tsx`
  — using a fake `Window`-shaped object substituted via the
  `popupWindow.ts` seam (e.g. via a test-only mock of that module).

**Files to modify**:
- `packages/ui/src/components/console-dock/ConsoleDock.tsx` — add the
  pop-out button, "is popped out" state, collapse-when-popped-out
  behavior, mount `PopupConsoleWindow` when popped out.
- `packages/ui/src/components/console-dock/ConsoleDock.css` — pop-out
  button styling.

**Testing plan**: `npm test -- popupWindow PopupConsoleWindow
console-dock` from `packages/ui`, foreground. Live-browser check in
both `npm run dev` and a production build (`npm run build` +
preview, if this project has a preview script — check
`packages/ui/package.json`) that the popup is styled correctly in
both. Per project memory, confirm this with an actual Chromium walk,
not just a script — popups specifically are exactly the kind of
interaction a headless/scripted check can miss.

**Documentation updates**: None.

## Testing

- **Existing tests to run**: `npm test -- console-dock` from
  `packages/ui`.
- **New tests to write**: `popupWindow.test.ts` (seam behavior);
  `PopupConsoleWindow.test.tsx` (open/portal/style-copy/lifecycle,
  against the fake window); `ConsoleDock.test.tsx` additions for
  pop-out-collapses-dock and put-it-back behavior.
- **Verification command**: `npm test -- popupWindow
  PopupConsoleWindow console-dock` (run from `packages/ui`), plus a
  live Chromium check of the popup's styling in dev and (if
  practical) a production build.
