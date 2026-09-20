/**
 * lib/popupWindow.ts — the one `window.open` seam in this codebase
 * (sprint 022 ticket 005, SUC-003). Confirmed while planning this
 * sprint that no call site existed before this file:
 * `grep -rn "window.open" packages/ui/src` returned zero matches.
 *
 * ## Why this exists as its own module, one line deep
 *
 * jsdom (this project's `@vitest-environment`) has no real popup
 * window — `window.open()` under jsdom returns `null` unconditionally,
 * so nothing that calls the bare global can be exercised against real
 * open/close/lifecycle behavior in a test. Wrapping the call in its own
 * module gives `PopupConsoleWindow.tsx`'s tests (and `ConsoleDock.tsx`'s
 * pop-out button tests) a single seam to `vi.mock` — they substitute a
 * plain `Window`-shaped fake object (exposing `document`, `closed`,
 * `close()`, and an event-target-like surface for `pagehide`, per this
 * ticket's own Description) instead of a real browser window, and every
 * caller in production code still just calls `openPopupWindow(...)`
 * with no idea a fake was ever involved.
 *
 * This function deliberately does nothing beyond the bare call — no
 * default features string, no error handling, no fallback — because
 * every hazard this ticket cares about (the user-gesture requirement,
 * stylesheet copying, lifecycle wiring) lives in *how* and *when* this
 * is called, not in this function itself. See `ConsoleDock.tsx`'s
 * pop-out button handler for the user-gesture-preserving call site: it
 * must call this function synchronously, with no `await` or effect
 * indirection first, or the browser treats the popup as unrequested and
 * blocks it.
 */

/**
 * Open (or reuse, per the `name` target) a new browser window. A thin,
 * intentionally trivial wrapper around the bare `window.open` call —
 * see this module's own doc comment for why a wrapper exists at all.
 *
 * `url` is always the empty string: the popup has nothing to navigate
 * to (its content is a React portal, not a page fetched by URL), so an
 * empty string opens a blank document ("about:blank") that this
 * codebase's `PopupConsoleWindow.tsx` then furnishes with copied
 * stylesheets and a portaled subtree.
 *
 * @param name - The window's `target` name (`window.open`'s second
 *   argument). Reusing the same name across calls would let a second
 *   `window.open` retarget an already-open window with that name
 *   instead of opening a second one, but this sprint's Out of Scope
 *   ("multi-window support beyond one popup at a time") means callers
 *   never need to rely on that — `ConsoleDock.tsx` only ever calls this
 *   once per pop-out, tracking the returned `Window` itself rather than
 *   re-deriving it from the name.
 * @param features - The window's `features` string (`window.open`'s
 *   third argument, e.g. `"width=640,height=420"`).
 * @returns The new window, or `null` if the browser blocked the popup
 *   (no user gesture in the call stack, a popup-blocker extension,
 *   etc.) — callers must treat `null` as "nothing opened," not throw.
 */
export function openPopupWindow(name: string, features: string): Window | null {
  return window.open("", name, features);
}
