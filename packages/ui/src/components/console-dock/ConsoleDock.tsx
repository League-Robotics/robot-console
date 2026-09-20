/**
 * ConsoleDock.tsx — the one console for a device page (sprint 022
 * ticket 002, SUC-001; sprint.md Architecture §Step 3, module 1).
 *
 * ## Why this exists as its own component
 *
 * Before this sprint the console was six separate mount sites
 * (`ConsolePane` wrapping `DeviceConsole`, once each in `RobotPage`'s
 * Main tab, `RelayPage`, `UnknownDevicePage`, `DriveTab`,
 * `CalibrationPage`, `ConfigurationPage`), each with its own local
 * toolbar state (autoscroll/show-polls/draft) that reset on every tab
 * switch even though the underlying log survives in `WsProvider`
 * (`useLinkLog`). The stakeholder's own word for the result was
 * "visually noisy." `ConsoleDock` exists so there is exactly one place
 * that mounts `DeviceConsole`/`CommandStrip` for a device page,
 * regardless of which tab is showing — a single mount cannot reset on
 * tab switch because it never unmounts across one.
 *
 * `ConsoleDock` itself owns none of that behavior — `DeviceConsole`
 * (log, toolbar, `SequencingIndicator`, send box) and `CommandStrip`
 * (HELLO/ID/VER/STATUS/FUNCS, GET/SET) are rendered here **unchanged**,
 * same props each already takes. This component's only job is to be the
 * one place both are mounted from, plus (as of ticket 003) the chrome
 * around them. It takes `{ link, name }` — "the device currently active
 * for console purposes" — and does not resolve routing or device
 * identity itself; that is its caller's job (`DevicePage.tsx`).
 *
 * ## Ticket 003: collapse/toggle chrome, persisted, with a quiet indicator
 *
 * The stakeholder's own words for the target shape: "let's reformat the
 * console so that it always runs at the bottom, is always full width,
 * and is always toggleable... If I open the toggle button, it opens the
 * bottom section to 10 lines or so. If I click the toggle button again,
 * it collapses it back down." This ticket builds exactly that:
 *
 *  - A bar labelled "Debug Console" is **always** rendered (this is
 *    what makes the dock "never disappear" per SUC-001) with a toggle
 *    control. Collapsed, nothing else renders — no log, no toolbar, no
 *    send box, per this ticket's own Acceptance Criteria.
 *  - Toggling open reveals the unchanged `DeviceConsole`/`CommandStrip`
 *    pair at a persisted (or default, `DEFAULT_DOCK_HEIGHT_PX`) height.
 *  - Open/collapsed state round-trips through `useDockPersistence`
 *    (see that module's own doc comment for why height rides along in
 *    the same stored shape even though nothing here can change it yet
 *    — ticket 004's drag handle is the first writer of `heightPx`).
 *  - The collapsed bar carries a quiet indicator sourced from
 *    `useLinkNotices()` (the same "worth surfacing" mechanism
 *    `FrontPage.tsx` already uses), lit only for a `warn`/`error`-level
 *    notice on *this* link — never a numeric `seq`/`pending` count,
 *    which the stakeholder explicitly called out as visual noise on the
 *    current calibration screen (sprint.md's Design Rationale). A
 *    collapsed console that silently hides a real error would be its
 *    own failure; this is the one thing the collapsed bar is allowed to
 *    say without becoming noisy again.
 *
 * ## Ticket 004: drag-to-resize, the first writer of `heightPx`
 *
 * The stakeholder's own words: "If I open it up, I can drag a resize
 * control at the top of the console to make it larger or smaller."
 * `ConsoleDock` gains a thin handle at the top edge of the open pane
 * (`.console-dock-resize-handle`, rendered only while `open`, per this
 * ticket's own Acceptance Criteria — there is nothing to resize while
 * collapsed). Dragging it up/down adjusts `heightPx` live via local
 * component state (`dragHeightPx`) so the pane follows the pointer with
 * no `localStorage` round-trip per `pointermove` — only `pointerup`
 * commits the final value through `useDockPersistence`, matching this
 * ticket's Implementation Plan ("avoid writing to localStorage on every
 * pointermove"). See `useDragResize` below for the drag mechanics and
 * `MIN_DOCK_HEIGHT_PX`/`MAX_DOCK_HEIGHT_PX` for the clamp and why those
 * numbers were chosen.
 *
 * Only pointer (mouse/pen/touch-via-pointer-events) drag is implemented.
 * Keyboard resize is not — the ticket's own Acceptance Criteria allow
 * this as a documented limitation rather than requiring it, and nothing
 * else in this dock is keyboard-resizable yet either.
 *
 * ## Ticket 005: pop-out into a separate browser window
 *
 * The stakeholder's own words: "you'll have a button to expand it to
 * its own window... the console in the main window gets collapsed...
 * if I uncollapse it, it will delete the window and open it back up on
 * the bottom." The pop-out button (`.console-dock-popout`, rendered on
 * the always-present bar so it works whether the dock is open or
 * collapsed, per SUC-003's own precondition) calls
 * `lib/popupWindow.ts`'s `openPopupWindow` **synchronously, inside its
 * own `onClick` handler** — not from an effect, not after an `await` —
 * because a `window.open` call whose user-gesture chain has already
 * ended by the time it runs is treated as an unrequested popup and
 * silently blocked. The returned `Window` is stored in this
 * component's own `popup` state; `PopupConsoleWindow` (mounted only
 * while `popup` is non-null) owns everything that happens *inside*
 * that window from then on — the actual `window.open` call
 * deliberately does not live inside `PopupConsoleWindow` itself, so
 * that component's mount effects (which do run on a later tick) are
 * never on the critical path for the user-gesture requirement. See
 * `PopupConsoleWindow.tsx`'s own doc comment for the full reasoning,
 * the stylesheet-copy mechanics, and the three-signal close lifecycle.
 *
 * Three things all converge on the same `open`/`popup` state pair,
 * matching the stakeholder's own description of the dock and the
 * popup as two views of one console, never both at once:
 *
 *  - Activating the pop-out button always collapses the dock (`open:
 *    false`), regardless of whether it was open or already collapsed
 *    beforehand — this is what SUC-003's own postcondition ("exactly
 *    one visible console exists at a time") requires.
 *  - Reopening the docked console (the ordinary toggle button) while a
 *    popup is active closes that popup first, then opens the dock —
 *    the stakeholder's own words for this exact case: "if I do that,
 *    it closes the window, and now I'm seeing the console at the
 *    bottom of the screen." This is not one of ticket 005's own
 *    checklist bullets in isolation, but it is squarely dock-shell
 *    interaction (ticket 003/005's territory, not ticket 006's
 *    route-driven retargeting), explicitly called out in the
 *    stakeholder's brief, and directly testable with the seam this
 *    ticket already introduces — so it is built now rather than left
 *    for later.
 *  - `PopupConsoleWindow`'s `onClose` (fired by "put it back", a native
 *    close, or the closed-poll fallback — see that component's own doc
 *    comment) clears `popup` and reopens the dock (`open: true`, never
 *    collapsed — per SUC-003's Alternate Flow, closing the popup is the
 *    student asking for the console *back*, not asking for it gone).
 *
 * ## Ticket 006: `link`/`name` are now the caller's resolved "active
 * console target," and this dock closes a live popup on its own unmount
 *
 * `DevicePage.tsx` no longer feeds this component its own raw
 * route-derived `link`/`device` — it resolves an `activeTarget` first
 * (see that module's own doc comment for why `RelayPage`'s bridged-child
 * substitution can make that diverge from the routed link) and passes
 * *that* through as this same `{ link, name }` prop pair. This
 * component's own props/shape need no change for that — `ConsoleDock`
 * never had, and still doesn't have, any opinion about routing; it just
 * renders whatever `link`/`name` it is handed, and retargets for free
 * (`PopupConsoleWindow`'s portaled JSX already reads `link`/`name` fresh
 * on every render, never re-running its one-time `window.open`-adjacent
 * setup effect) the moment its caller hands it a different pair.
 *
 * What ticket 006 *does* add here: an explicit `popupWindow.close()`
 * call from this component's own unmount, for the one real gap ticket
 * 005 left (see that ticket's own report and this file's earlier
 * doc-comment revision): a `window.open` result is a genuinely separate
 * browser window with its own lifetime, not something that closes
 * itself just because the React tree that once portaled into it goes
 * away. Before this ticket, navigating from a device page back to `/`
 * (which unmounts `DevicePage`, and therefore this component) left any
 * open popup as an orphan — blank once its portal content unmounted,
 * but never actually closed. See the `popupRef`/unmount-effect pair
 * below for why this is safe to do here, specifically, when it was
 * unsafe for `PopupConsoleWindow` to do the equivalent unconditionally
 * in its own cleanup (`PopupConsoleWindow.tsx`'s own doc comment, "Why
 * cleanup does not itself call popupWindow.close()").
 *
 * **No per-tab console mount is removed by this ticket** — every page
 * that already renders `ConsolePane`/`CommandStrip` keeps doing so
 * unchanged, so the running app shows both the dock and the old per-tab
 * console at once until ticket 007's single clean removal pass. That is
 * intentional incremental delivery (sprint.md's Migration Concerns), not
 * a defect to fix here.
 *
 * ## Ticket 008: pinned to the viewport bottom, and `--console-dock-height`
 *
 * The stakeholder's own analogy for this whole feature, from the very
 * start, was a browser's JavaScript devtools console — "like you can
 * with the console, the debug console, on a web browser for JavaScript.
 * Same idea" — and, asked directly with the two layouts shown side by
 * side (sprint 022, 2026-09-20), he confirmed "pinned to the bottom"
 * meant the browser **viewport**, not the bottom of the page's own
 * scrollable content. Tickets 002/003 built the latter: `ConsoleDock`
 * was a flex-column participant of `DevicePage.tsx`'s
 * `.device-page-shell`, so it sat after page content in normal document
 * flow — verified live in Chromium that a page taller than the viewport
 * (e.g. the Calibration tab) required scrolling to reach the dock at
 * all, exactly the devtools-console behavior the stakeholder's own
 * analogy rules out. See sprint.md's Architecture §Revision
 * (2026-09-20) and the Design Rationale entry it replaces for the full
 * decision record.
 *
 * `ConsoleDock.css` now makes `.console-dock` `position: fixed` to the
 * viewport's own bottom edge — both the always-present collapsed bar
 * and the open pane, since both live inside this one element, per this
 * ticket's own Acceptance Criteria ("both dock states are pinned, not
 * only the open pane"). That repositioning is the easy part; the hazard
 * it introduces is not. Several stylesheets already size page columns
 * against the *old*, in-flow dock's assumed footprint with fixed
 * `calc(100vh - Npx)` literals (`RobotPage.css`'s
 * `.robot-page-column-console`, before this ticket), and ticket 004's
 * drag handle makes the dock's own height a **live, student-controlled
 * variable** — collapsed-bar height in one state, bar height plus
 * `heightPx` in the other, changing continuously during a drag. A fixed
 * literal in page CSS and a variable-height fixed-position dock cannot
 * both be right at the same time: either a hardcoded reservation is too
 * small (page content hides behind the dock) or too large (a dead gap
 * opens beneath it) the moment the student drags the handle away from
 * whatever height the literal assumed.
 *
 * **The fix: exactly one number, computed here, written to one CSS
 * custom property, read by every page rule that needs to reserve room
 * for the dock.** `--console-dock-height` (see
 * {@link CONSOLE_DOCK_HEIGHT_PROPERTY}) is set on `document.
 * documentElement.style` — global, not scoped to this component's own
 * subtree, because the pages that need to read it
 * (`RobotPage.css`'s `.robot-page-column-console`, `DevicePage.css`'s
 * `.device-page-shell`) are siblings/ancestors of `ConsoleDock` in the
 * render tree, not descendants, and a plain CSS custom property
 * inherits from the document root to everywhere regardless of DOM
 * nesting, with no context/prop-threading required. This is the "single
 * source of truth" sprint.md's Design Rationale calls for: the dock's
 * own positioning and every page's reserved space read the *same* live
 * value, so they cannot drift apart the way two independently
 * hand-maintained numbers eventually would.
 *
 * **Why a computed formula, not a `ResizeObserver`/`getBoundingClientRect`
 * measurement of the real rendered dock.** A measurement would in
 * principle need no maintained constant at all and could never drift
 * from the truth. It was rejected specifically because this project's
 * test environment, jsdom, implements no layout engine — every element's
 * `getBoundingClientRect()`/`offsetHeight` is always `0` there (the same
 * gap `useDragResize`'s own doc comment already documents for the
 * Pointer Capture API) — so a measured value would make this property's
 * value *untestable*: every jsdom assertion would read back `"0px"`
 * regardless of `open`/`heightPx`, which is exactly the "vacuous CSS
 * assertion" failure mode this ticket's own Verification note warns
 * against. A small set of documented pixel constants, combined with
 * state this component already tracks precisely (`open`, `liveHeightPx`
 * — the exact same number already driving `.console-dock-pane`'s own
 * inline `style.height` a few lines below, so the two can never
 * disagree with each other), keeps the value both correct and
 * assertable in a plain jsdom test (`document.documentElement.style.
 * getPropertyValue(CONSOLE_DOCK_HEIGHT_PROPERTY)`), on mount, on
 * toggle, and live during a drag — see `ConsoleDock.test.tsx`'s own
 * ticket 008 suite.
 *
 * {@link COLLAPSED_DOCK_HEIGHT_PX} is therefore a *judgment-call
 * constant*, not a measurement — matching this codebase's already-
 * established discipline for exactly this kind of number (see
 * `RobotPage.css`'s own `12rem` comment: "approximates the measured
 * height... measured live at ~189px... leaves a little headroom rather
 * than cutting it exactly"). It was chosen by measuring
 * `.console-dock-bar`'s actual rendered height live in Chromium (title
 * text, the quiet indicator, the pop-out/toggle buttons, one row,
 * `align-items: center`, plus `.console-dock`'s own 1px top border) and
 * rounding up slightly for headroom, the same discipline. **If
 * `.console-dock-bar`'s own CSS ever changes height** (a new element
 * added to the bar, a font-size or padding change), this constant must
 * be re-measured and updated to match, or the dock's real footprint and
 * every page's reserved space will silently drift apart — the exact
 * hazard this ticket exists to prevent for the drag-resizable pane
 * height, now equally true for this fixed collapsed height. There is no
 * compiler or test that catches that drift; it is a manual invariant,
 * called out here so a future editor of `ConsoleDock.css` knows to look
 * for it.
 *
 * **Who reads `--console-dock-height`, and who deliberately does not:**
 *
 *  - `RobotPage.css`'s `.robot-page-column-console` (`DriveTab.tsx`'s
 *    right column, the one remaining user of that class post-ticket-007)
 *    subtracts it from its own `calc(100vh - ...)` height so its
 *    `position: sticky` box — and therefore `PathTracePanel`, which
 *    fills the rest of that column — never extends its own bottom edge
 *    underneath the fixed dock.
 *  - `DevicePage.css`'s `.device-page-shell` adds it as
 *    `padding-bottom`, reserving the same live height as blank space at
 *    the end of every device page's own content, so ordinary
 *    bottom-of-column controls that are not viewport-bound at all (the
 *    Copy button on both code blocks, `CalibrationTable`'s "Start
 *    over") still scroll fully into view above the dock rather than
 *    ending up hidden behind it.
 *  - `DeviceConsole.css`'s `.console-log` does **not** read this
 *    property, deliberately — see that file's own ticket 008 comment
 *    for why: it lives *inside* the console itself (mounted either in
 *    `.console-dock-pane`, whose own inline `style.height` already
 *    bounds it exactly, or in the popup window's `.popup-console-window`,
 *    which has no dock inside it to reserve room for at all), not in a
 *    page column reserving room *around* the dock — the two concerns
 *    that `--console-dock-height` exists to keep synchronized are simply
 *    not in play there.
 *
 * **Reset on unmount.** The effect below that writes the property also
 * removes it when `ConsoleDock` itself unmounts (navigating back to `/`,
 * which unmounts `DevicePage` and everything beneath it) — so a future
 * consumer mounted after this one never inherits a stale reservation
 * left over from a previous device page visit's dock height. `/`
 * (`FrontPage.tsx`) never reads this property today, but leaving a
 * document-root style property set indefinitely after its owning
 * component is gone is exactly the kind of silent-drift hazard this
 * ticket is otherwise working to eliminate everywhere else.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { SnapshotLink } from "@robot-console/host/src/wsMessages.js";
import { DeviceConsole } from "../DeviceConsole";
import { CommandStrip } from "../CommandStrip";
import { useLinkNotices } from "../../ws/WsProvider";
import { useDockPersistence } from "./useDockPersistence";
import { openPopupWindow } from "../../lib/popupWindow";
import { PopupConsoleWindow } from "./PopupConsoleWindow";
import "./ConsoleDock.css";

/** The pop-out window's `window.open` target name. A fixed name (rather
 * than one derived from the link id) is fine per this sprint's Out of
 * Scope ("multi-window support beyond one popup at a time") — nothing
 * in this codebase ever opens two of these at once. */
const POPUP_WINDOW_NAME = "robot-console-debug-console";

/** The pop-out window's initial `features` string. Sized close to
 * `DEFAULT_DOCK_HEIGHT_PX`'s own footprint plus room for the popup's own
 * title bar (`PopupConsoleWindow`'s `.popup-console-window-bar`) so the
 * window opens at a size that shows real content immediately rather
 * than a sliver the student has to resize by hand first. Ordinary
 * browser window chrome (resize handles, its own titlebar) still lets
 * the student resize it afterward — nothing here pins the size. */
const POPUP_WINDOW_FEATURES = "width=640,height=480";

/** Minimum dock height: the send box (`CommandStrip`'s own row) plus a
 * couple of log lines at `DeviceConsole.css`'s `.console-log` line
 * height, so a dragged-down dock still shows *something* useful rather
 * than shrinking to a sliver that only shows the bar. This is a judgment
 * call (ticket 004's Description explicitly leaves the exact numbers to
 * implementation), not a stakeholder-specified value. */
export const MIN_DOCK_HEIGHT_PX = 140;

/** Maximum dock height: leaves at least ~200px of page content visible
 * above the dock on a typical laptop viewport (~800px tall minus browser
 * chrome), so a dragged-up dock can never fully cover the page the
 * student is trying to look at. Also a judgment call per the ticket's
 * Description, not a stakeholder-specified number. */
export const MAX_DOCK_HEIGHT_PX = 640;

/** The CSS custom property `ConsoleDock` writes its own live rendered
 * height to, and every page CSS rule that needs to reserve room for the
 * dock reads back via `var(--console-dock-height, 0px)` — see this
 * file's own doc comment, "Ticket 008," for the full contract. Exported
 * as a named constant (rather than each site spelling the string
 * literal) so `ConsoleDock.test.tsx` and any future consumer share
 * exactly one spelling of the property name. */
export const CONSOLE_DOCK_HEIGHT_PROPERTY = "--console-dock-height";

/** The collapsed bar's own rendered height in pixels, including
 * `.console-dock`'s own 1px top border — the dock's total footprint
 * while `open` is false. A documented constant, not a live
 * `getBoundingClientRect()` measurement — see this file's own doc
 * comment, "Ticket 008," for why (in short: jsdom has no layout engine,
 * so a measured value would always read back `0` in this project's
 * tests, making it unassertable). Re-measure and update this if
 * `.console-dock-bar`'s own CSS ever changes height. */
export const COLLAPSED_DOCK_HEIGHT_PX = 44;

/** Extra pixels `.console-dock-pane`'s own top border contributes once
 * the dock is open, on top of {@link COLLAPSED_DOCK_HEIGHT_PX} (which
 * already counts `.console-dock`'s own outer border, present in both
 * states). The pane's own *content* height is never approximated —
 * it's `liveHeightPx`, the exact number already driving that element's
 * inline `style.height` a few lines below `ConsoleDock`'s own render,
 * so the two can never disagree. Exported (like the constants above)
 * so `ConsoleDock.test.tsx` can compute the exact expected
 * `--console-dock-height` value from named constants rather than a
 * bare magic `+ 1` in the test file itself. */
export const OPEN_PANE_BORDER_PX = 1;

/** Clamp a candidate height to the documented [min, max] range. Shared
 * by the live-drag path and the persisted-restore path so a height
 * hand-edited into `localStorage` outside those bounds (or a bound that
 * later changes) is corrected the same way in both places. */
function clampDockHeight(px: number): number {
  return Math.min(MAX_DOCK_HEIGHT_PX, Math.max(MIN_DOCK_HEIGHT_PX, px));
}

interface DragState {
  /** `clientY` where the drag started, in the same coordinate space as
   * every subsequent `pointermove`'s `clientY`. */
  startY: number;
  /** The (already-clamped) height the pane had when the drag started. */
  startHeight: number;
  /** Updated on every `pointermove`; read once on `pointerup` so the
   * commit reflects the last frame of the drag without `pointerup`'s own
   * handler needing to recompute it from a stale `clientY`. */
  latestHeight: number;
}

/**
 * The drag mechanics behind the resize handle, factored out of
 * `ConsoleDock` itself so the component body stays a plain render.
 *
 * ## Window-level listeners, not element-level
 *
 * A real browser would normally reach for `setPointerCapture` on the
 * handle so move/up events keep arriving even once the pointer leaves
 * the (thin, easy-to-overshoot) handle element. But jsdom — this
 * project's test environment — does not implement the Pointer Capture
 * API at all; `HTMLElement.prototype.setPointerCapture` is simply absent
 * (confirmed against the installed jsdom 30.0.1: calling it throws
 * "setPointerCapture is not a function"), so a design that depended on
 * capture to work would be untestable here. Tracking the drag with
 * `window`-level `pointermove`/`pointerup` listeners instead — added on
 * `pointerdown`, removed on `pointerup`/`pointercancel`/unmount — sidesteps
 * that gap entirely and, as a side effect, is also exactly the behavior
 * the ticket asked for: the resize must keep working "if the pointer is
 * released outside the window" (it does — `pointerup` fires on `window`
 * regardless of where the pointer physically is when the button is
 * released, and `pointercancel` covers the case where the browser itself
 * aborts the gesture, e.g. an OS-level drag interruption). Real-browser
 * `setPointerCapture` is still attempted, best-effort, purely so the
 * handle keeps the *cursor* affordance while dragging past its own
 * edges; nothing about correctness depends on it succeeding.
 *
 * ## Local state during the drag, one persisted write at the end
 *
 * `dragHeightPx` is `null` whenever no drag is in progress (render
 * `persistedHeightPx` instead); while dragging it holds the live,
 * clamped height for immediate visual feedback. `commitHeight` (a
 * `useDockPersistence` write) fires exactly once, from `pointerup`, per
 * this ticket's Implementation Plan ("avoid writing to localStorage on
 * every pointermove — write once per drag gesture").
 */
function useDragResize(
  persistedHeightPx: number,
  commitHeight: (heightPx: number) => void,
): { heightPx: number; isDragging: boolean; onHandlePointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void } {
  const [dragHeightPx, setDragHeightPx] = useState<number | null>(null);
  const dragRef = useRef<DragState | null>(null);
  // `commitHeight`/`persistedHeightPx` are read from a ref inside the
  // window-listener callbacks below so those callbacks never need to be
  // torn down and re-added mid-drag just because a parent re-render
  // produced a new function identity.
  const commitHeightRef = useRef(commitHeight);
  commitHeightRef.current = commitHeight;

  const handlePointerMove = useCallback((event: PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) {
      return;
    }
    // Dragging the handle UP shrinks `event.clientY` relative to
    // `startY`; per this ticket's Description ("drag up to grow"), a
    // smaller `clientY` must mean a *larger* height, hence the
    // subtraction order below rather than the reverse.
    const next = clampDockHeight(drag.startHeight + (drag.startY - event.clientY));
    drag.latestHeight = next;
    setDragHeightPx(next);
  }, []);

  // One function that removes every listener a drag attaches, called
  // from both the normal end-of-drag path (`handlePointerUp`) and the
  // unmount-mid-drag cleanup path below, so the two can never drift out
  // of sync about which listeners exist.
  const detachWindowListeners = useCallback(() => {
    window.removeEventListener("pointermove", handlePointerMove);
    window.removeEventListener("pointerup", handlePointerUp);
    window.removeEventListener("pointercancel", handlePointerUp);
    document.body.style.removeProperty("user-select");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handlePointerMove]);

  const handlePointerUp = useCallback(() => {
    const drag = dragRef.current;
    dragRef.current = null;
    detachWindowListeners();
    setDragHeightPx(null);
    if (drag) {
      commitHeightRef.current(drag.latestHeight);
    }
  }, [detachWindowListeners]);

  // Unmounting mid-drag (e.g. the student navigates away while still
  // holding the handle) must not leave `window` listeners or the
  // text-selection suppression stuck behind — this is the cleanup the
  // ticket's own framing ("cleanup on unmount") calls for.
  useEffect(() => {
    return () => {
      if (dragRef.current) {
        detachWindowListeners();
      }
    };
  }, [detachWindowListeners]);

  const onHandlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      // Only a primary mouse button (or any non-mouse pointer, e.g.
      // touch/pen, which has no "button" concept in the same sense)
      // starts a drag -- a right-click on the handle shouldn't resize.
      if (event.pointerType === "mouse" && event.button !== 0) {
        return;
      }
      const startHeight = clampDockHeight(persistedHeightPx);
      dragRef.current = { startY: event.clientY, startHeight, latestHeight: startHeight };
      setDragHeightPx(startHeight);
      const handle = event.currentTarget;
      if (typeof handle.setPointerCapture === "function") {
        try {
          handle.setPointerCapture(event.pointerId);
        } catch {
          // Best-effort only -- see this function's own doc comment.
          // The window-level listeners below are the real mechanism.
        }
      }
      window.addEventListener("pointermove", handlePointerMove);
      window.addEventListener("pointerup", handlePointerUp);
      window.addEventListener("pointercancel", handlePointerUp);
      // Without this, dragging the handle over the log/toolbar beneath
      // it selects their text as a side effect of the mouse moving over
      // selectable content -- purely a drag-hygiene fix, unrelated to
      // resize correctness itself.
      document.body.style.userSelect = "none";
    },
    [persistedHeightPx, handlePointerMove, handlePointerUp],
  );

  return {
    heightPx: dragHeightPx ?? persistedHeightPx,
    isDragging: dragHeightPx !== null,
    onHandlePointerDown,
  };
}

export interface ConsoleDockProps {
  /** The device currently active for console purposes. The caller
   * (`DevicePage.tsx`) resolves this from the route; `ConsoleDock`
   * itself has no opinion about routing or relay bridging. */
  link: SnapshotLink;
  /** Display label passed straight through to `DeviceConsole`/
   * `CommandStrip`'s own "No link open to …" hints. */
  name: string;
}

export function ConsoleDock({ link, name }: ConsoleDockProps) {
  const [{ open, heightPx }, updateDockState] = useDockPersistence();
  const commitHeight = useCallback(
    (nextHeightPx: number) => {
      updateDockState({ heightPx: nextHeightPx });
    },
    [updateDockState],
  );
  const { heightPx: liveHeightPx, isDragging, onHandlePointerDown } = useDragResize(heightPx, commitHeight);

  // Sprint 022 ticket 008: the dock's own current total footprint --
  // just the collapsed bar while closed, or the bar plus the open
  // pane's own live height (already `liveHeightPx`, which already
  // tracks a drag in progress) while open. See this file's own doc
  // comment, "Ticket 008," for why this is a computed formula from
  // state already tracked here rather than a DOM measurement.
  const dockHeightPx = open ? COLLAPSED_DOCK_HEIGHT_PX + OPEN_PANE_BORDER_PX + liveHeightPx : COLLAPSED_DOCK_HEIGHT_PX;

  // `useLayoutEffect`, not `useEffect`: this must commit before the
  // browser paints the frame that changed `dockHeightPx` (a toggle or a
  // drag), or a page reading `var(--console-dock-height)` for its own
  // `calc(100vh - ...)` sizing would paint one frame using the *old*
  // reservation against the *new* dock height -- exactly the "visible
  // flash of overlap or gap during the drag" this ticket's Acceptance
  // Criteria rule out.
  useLayoutEffect(() => {
    document.documentElement.style.setProperty(CONSOLE_DOCK_HEIGHT_PROPERTY, `${dockHeightPx}px`);
  }, [dockHeightPx]);

  // Cleanup only, deliberately on its own effect with an empty
  // dependency array (matching the popup-close-on-unmount effect
  // below): removing the property is something that should happen
  // exactly once, when this component itself unmounts, not every time
  // `dockHeightPx` happens to change -- folding it into the effect
  // above would remove the property on every render's cleanup pass,
  // immediately before that same render's own `setProperty` call put it
  // right back, which is harmless but pointless churn.
  useEffect(() => {
    return () => {
      document.documentElement.style.removeProperty(CONSOLE_DOCK_HEIGHT_PROPERTY);
    };
  }, []);

  const linkNotices = useLinkNotices();
  const notice = linkNotices.get(link.id);
  // Bench defect 010 addendum's `LinkNotice.level` is already
  // `"info" | "warn" | "error"` (`WsProvider.tsx`) -- `"info"` is
  // deliberately excluded here. An `"info"`-level notice (e.g. a
  // routine state change) lighting up the collapsed bar would be
  // exactly the noise the stakeholder asked this indicator to avoid;
  // only `warn`/`error` clears the "worth surfacing while collapsed"
  // bar this ticket sets.
  const showIndicator = notice !== undefined && (notice.level === "warn" || notice.level === "error");

  // `null` whenever no popup is open. Holding the actual `Window` here
  // (rather than a plain boolean "is popped out" flag) is what lets
  // `handleToggleOpen`/`handlePopupClosed` below call `.close()` on the
  // *same* window object `PopupConsoleWindow` is managing, with no
  // second source of truth to keep in sync.
  const [popup, setPopup] = useState<Window | null>(null);

  // Sprint 022 ticket 006: mirror `popup` into a ref so the unmount
  // effect below (which must have an empty dependency array — see its
  // own comment) always reads the *current* value from its cleanup,
  // not whatever `popup` was at the time the effect itself was set up.
  const popupRef = useRef<Window | null>(null);
  useEffect(() => {
    popupRef.current = popup;
  }, [popup]);

  // Sprint 022 ticket 006: close a live popup when this component
  // itself unmounts — e.g. `DevicePage` unmounting on navigation back
  // to `/`, or (less commonly) a device losing its link entirely
  // mid-session, which also drops this component from `DevicePage`'s
  // render tree. See this file's own doc comment ("Ticket 006") for why
  // the gap this closes is real (a popup window does not close itself
  // just because its portal content's React tree goes away).
  //
  // Why this is safe here specifically, when the identical-looking
  // unconditional `popupWindow.close()` in `PopupConsoleWindow`'s own
  // cleanup was rejected as unsafe (`PopupConsoleWindow.tsx`'s own doc
  // comment, "Why cleanup does not itself call popupWindow.close()"):
  // that hazard is about a component whose mount/unmount cycle repeats
  // *within* one device visit — `PopupConsoleWindow` is conditionally
  // rendered on `popup` truthiness, so it freshly mounts on every single
  // pop-out, and React's `<StrictMode>` double-invokes effects (setup ->
  // cleanup -> setup, synchronously) on every one of those fresh mounts,
  // not only the app's first-ever render. A cleanup that closed the real
  // window there would fire during that synthetic replay and close the
  // popup the instant a student opened it, in development only, with no
  // click available to reopen it.
  //
  // `ConsoleDock` does not have that problem, because its own mount
  // lifetime is different in *kind*, not just degree: this component is
  // mounted exactly once per device-page visit (`DevicePage.tsx`'s own
  // doc comment — React Router keeps the same `DevicePage` instance
  // across a `:linkId` param change, and this element sits at the same
  // JSX position across every one of `DevicePage`'s three dispatch
  // branches, so it survives even a robot-to-relay switch) and unmounts
  // only when the whole device page goes away. The one moment this
  // effect's own cleanup could possibly observe a StrictMode synthetic
  // replay is immediately after *this* mount, before the student has
  // had any chance to click Pop out — `popupRef.current` is still its
  // initial `null` at that point, so that one synthetic cleanup is a
  // no-op. Every *genuine* unmount happens strictly later than that
  // one synthetic cycle, by which time the ref is exactly correct.
  useEffect(() => {
    return () => {
      const openPopup = popupRef.current;
      if (openPopup && !openPopup.closed) {
        openPopup.close();
      }
    };
  }, []);

  const handlePopOut = useCallback(() => {
    // Must be a direct, synchronous call from inside this click
    // handler -- see this file's own doc comment ("Ticket 005: pop-out
    // into a separate browser window") and `lib/popupWindow.ts`'s own
    // doc comment for why an effect or a promise continuation here
    // would risk the browser silently blocking the popup.
    const popupWindow = openPopupWindow(POPUP_WINDOW_NAME, POPUP_WINDOW_FEATURES);
    if (!popupWindow) {
      // Blocked by the browser (no popup-blocker exception granted) or
      // simply unavailable (e.g. jsdom's own `window.open`, which
      // always returns `null` -- this ticket's own Description).
      // Nothing opened, so the dock stays exactly as it was rather
      // than collapsing into a state with no popup to show for it.
      return;
    }
    setPopup(popupWindow);
    updateDockState({ open: false });
  }, [updateDockState]);

  const handlePopupClosed = useCallback(() => {
    setPopup(null);
    // Restored to *open*, never collapsed -- SUC-003's Alternate Flow:
    // closing the popup (by its own "put it back" button, its native
    // close control, or the closed-poll fallback -- see
    // `PopupConsoleWindow.tsx`) is the student asking for the console
    // back, not asking for it to disappear.
    updateDockState({ open: true });
  }, [updateDockState]);

  const toggleOpen = useCallback(() => {
    if (popup) {
      // The stakeholder's own words for this exact case: "if I do that,
      // it closes the window, and now I'm seeing the console at the
      // bottom of the screen." Reopening the docked console while a
      // popup is active is treated as "bring it back," not "also show a
      // second copy" -- SUC-003's postcondition is exactly one visible
      // console at a time. `popup.close()` here does not by itself
      // update this component's own state (a real browser's `pagehide`
      // would eventually notify `PopupConsoleWindow`, but there's no
      // reason to wait on that round trip for an action already known
      // to have succeeded from right here), so this handler also does
      // what `handlePopupClosed` would.
      if (!popup.closed) {
        popup.close();
      }
      handlePopupClosed();
      return;
    }
    updateDockState({ open: !open });
  }, [open, popup, handlePopupClosed, updateDockState]);

  return (
    <section className="console-dock" aria-label="Debug console" data-testid="console-dock">
      <div className="console-dock-bar">
        <span className="console-dock-title">Debug Console</span>
        {showIndicator && (
          <span
            className={`console-dock-indicator console-dock-indicator-${notice!.level}`}
            data-testid="console-dock-indicator"
            role="status"
            aria-label={`Debug console has a ${notice!.level}: ${notice!.text}`}
            title={notice!.text}
          />
        )}
        {popup ? (
          // No second pop-out while one is already active -- this
          // sprint's Out of Scope excludes multi-window support, and
          // there is nothing meaningful for a second click to do (the
          // same content is already showing in the open popup).
          <span className="console-dock-popped-out-hint" data-testid="console-dock-popped-out-hint">
            Open in a separate window
          </span>
        ) : (
          <button
            type="button"
            className="console-dock-popout"
            data-testid="console-dock-popout"
            aria-label="Open console in a separate window"
            title="Open console in a separate window"
            onClick={handlePopOut}
          >
            Pop out ⧉
          </button>
        )}
        <button
          type="button"
          className="console-dock-toggle"
          data-testid="console-dock-toggle"
          aria-expanded={open}
          onClick={toggleOpen}
        >
          {open ? "Hide ▾" : "Show ▸"}
        </button>
      </div>
      {popup && <PopupConsoleWindow popupWindow={popup} link={link} name={name} onClose={handlePopupClosed} />}
      {open && (
        <div
          className={`console-dock-pane${isDragging ? " console-dock-pane-dragging" : ""}`}
          data-testid="console-dock-pane"
          style={{ height: liveHeightPx }}
        >
          {/* The resize handle sits at the pane's own top edge (not the
              bar above it) so it only exists in the DOM while the dock
              is open, per this ticket's Acceptance Criteria -- there is
              nothing to resize while collapsed, and the bar itself
              (ticket 003) must stay exactly as it was for the collapsed
              case. Dragging it up grows `heightPx`, down shrinks it,
              clamped to [MIN_DOCK_HEIGHT_PX, MAX_DOCK_HEIGHT_PX] -- see
              `useDragResize`'s doc comment for the full mechanics. */}
          <div
            className="console-dock-resize-handle"
            data-testid="console-dock-resize-handle"
            role="separator"
            aria-orientation="horizontal"
            aria-label="Resize debug console"
            onPointerDown={onHandlePointerDown}
          />
          <DeviceConsole link={link} name={name} />
          <CommandStrip link={link} />
        </div>
      )}
    </section>
  );
}
