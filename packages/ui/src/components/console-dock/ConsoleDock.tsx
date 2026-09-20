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
 * ## Still deliberately incomplete after this ticket
 *
 * No pop-out window (ticket 005), no route-driven retargeting/teardown
 * for relay bridging (ticket 006). **No per-tab console mount is removed
 * by this ticket** — every page that already renders
 * `ConsolePane`/`CommandStrip` keeps doing so unchanged, so the running
 * app shows both the dock and the old per-tab console at once until
 * ticket 007's single clean removal pass. That is intentional
 * incremental delivery (sprint.md's Migration Concerns), not a defect to
 * fix here.
 */
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { SnapshotLink } from "@robot-console/host/src/wsMessages.js";
import { DeviceConsole } from "../DeviceConsole";
import { CommandStrip } from "../CommandStrip";
import { useLinkNotices } from "../../ws/WsProvider";
import { useDockPersistence } from "./useDockPersistence";
import "./ConsoleDock.css";

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

  const toggleOpen = useCallback(() => {
    updateDockState({ open: !open });
  }, [open, updateDockState]);

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
