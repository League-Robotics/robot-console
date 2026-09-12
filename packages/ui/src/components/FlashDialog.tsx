/**
 * FlashDialog.tsx — out-of-process work (2026-09-08, no ticket/sprint,
 * OOP bypass): the stakeholder's bench-testing request that flashing
 * become a popup modal ("let's make flashing a pop-up modal window, so
 * the whole flash process goes in the window that pops up, and you
 * just see the flash stuff going on"). `FlashControls.tsx` already
 * owns the entire flash flow as one endpoint-in state machine, shared
 * across three call sites (`FrontPage.tsx`'s `EndpointCard`,
 * `UnknownDevicePage.tsx`, `AppHeader.tsx`'s Flash entry); this
 * component wraps it in a `<dialog>` and is the *one* place that owns
 * the trigger button, the modal chrome, and the gating logic all three
 * call sites need, so they don't drift back into three copies of it.
 *
 * **Gating moved here from `FlashControls`.** Before this change,
 * `FlashControls` decided for itself (via `canBeFlashed`) whether to
 * render anything, with a `forceShow` escape hatch for `AppHeader`'s
 * identified-device case. With an explicit trigger at every call site,
 * the caller has already committed to offering flashing the moment it
 * renders a trigger at all -- so the gate now lives on the trigger
 * itself: a device that cannot be flashed (`canBeFlashed` false) gets
 * no trigger, hence no way to ever open the dialog, unless the caller
 * passes `forceShow` (ticket 004's `AppHeader`, for an identified
 * relay/robot device -- see its own doc comment). This preserves the
 * property ticket 012-001 fixed: a silent, unflashed board (`role ===
 * null`, no `sessionError`) is `canBeFlashed` regardless, so it still
 * gets a trigger. `FlashControls.tsx` no longer knows about gating at
 * all -- see its own doc comment.
 *
 * **`window.confirm` removed.** `AppHeader` used to gate opening
 * `FlashControls` for an identified device behind a `window.confirm()`
 * -- a second, blocking confirmation on top of a dialog that is itself
 * a deliberate, dismissible confirmation surface showing exactly what
 * is about to happen before anything is sent. Stacking a native
 * `confirm()` in front of that bought nothing but an extra click, so it
 * is gone; in its place, opening this dialog for an already-identified
 * device (`forceShow` used where `canBeFlashed` is false) shows a
 * short warning line ("Reflashing … will interrupt …") inside the
 * dialog itself, where the student is already looking, rather than in
 * a separate native alert they have to dismiss first.
 *
 * **Dismissal during an in-progress flash.** Flashing is destructive
 * and takes real wall-clock time, so a stray Escape or an accidental
 * backdrop click mid-write is bad -- but a dialog the student can never
 * get out of is worse (a stalled flash, or a board that never reports
 * back, must not trap them). The resolution: Escape (the dialog's
 * `cancel` event) and a backdrop click are both suppressed only while
 * `useFlashProgress` reports an active write for this endpoint
 * (`inProgress` below); the explicit "Close" button rendered inside the
 * dialog is *never* disabled, so there is always a deliberate,
 * intentional way out even if a flash never completes. Once a
 * `flash-result` arrives (success, error, or the "waiting for the
 * board to come back" reidentify-timeout case), `useFlashProgress`
 * clears and Escape/backdrop dismissal are re-enabled immediately.
 *
 * **Why `<dialog>`, not a hand-rolled overlay `<div>`.** A native
 * `<dialog>` shown via `showModal()` gets the browser's own top-layer
 * rendering (so it always paints over the page, no z-index bookkeeping
 * needed), an inert background (nothing behind it is focusable or
 * clickable while open), a `::backdrop` pseudo-element for the dim
 * overlay, and (in browsers that implement the full spec) automatic
 * initial-focus and close-time focus restoration -- exactly the
 * accessibility properties this component needs, for free, in every
 * real target browser. This component still manages focus imperatively
 * (moving focus into the dialog on open, back to the trigger on close)
 * and adds a small Tab-cycling handler rather than relying solely on
 * that native behavior, for two reasons: (1) it makes the behavior
 * deterministic and independent of exactly which spec steps a given
 * browser implements, and (2) the test environment (jsdom, this
 * package's `@vitest-environment`) does not implement `showModal()`/
 * `close()` at all as of the pinned jsdom version -- both are called
 * behind an existence check (`typeof dialog.showModal === "function"`)
 * with a plain `open` attribute fallback, so this component degrades to
 * a plain (non-inert, non-top-layer) `open` dialog in that environment
 * rather than throwing, while still being fully exercised by this
 * file's own imperative focus/keyboard logic. Every real target browser
 * (this is a bench tool used from current Chrome/Firefox/Safari) has
 * shipped `showModal()` for years, so this fallback is a test-only
 * concession, not a supported degraded mode for students.
 *
 * ## Sprint 015 ticket 008: takes a `SnapshotLink`, not an `EndpointListEntry`
 *
 * Flashability is now a per-link capability (`link.capabilities.flash`,
 * `deviceDisplay.ts`'s `canBeFlashed`) rather than a device-level
 * `role === null` guess, and flash progress rides on `linkId`
 * (`useFlashProgress(link.id)`, `flash-start`'s `linkId` field) instead
 * of `endpointId`. `name` is passed in by the caller for the dialog's
 * own title/warning text -- a link has no name of its own (only its
 * owning `SnapshotDevice` does, and an `unassigned` link has no device
 * at all), so the caller (which already knows whether it has a device
 * to name) supplies it directly rather than this component guessing one.
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type SyntheticEvent,
} from "react";
import type { SnapshotLink } from "@robot-console/host/src/wsMessages.js";
import { useFlashProgress } from "../ws/WsProvider";
import { canBeFlashed } from "../deviceDisplay";
import { FlashControls } from "./FlashControls";
import "./FlashDialog.css";

export interface FlashDialogProps {
  link: SnapshotLink;
  /** Display label for this dialog's title/warning text -- the owning
   * device's name, or the link's own label when there is no device yet
   * (an `unassigned` board). */
  name: string;
  /** Bypass the `canBeFlashed` gate on the trigger button and render it
   * regardless of `link.capabilities.flash` -- see this module's doc
   * comment. Default `false`; only `AppHeader` passes `true`, for an
   * identified relay/robot device. */
  forceShow?: boolean;
  /** Trigger button's visible label. Every call site uses the default
   * ("Flash") per the stakeholder's own phrasing; overridable for a
   * call site whose surrounding chrome wants different wording. */
  triggerLabel?: string;
  /** Trigger button's `className`, so each call site's trigger can
   * match its surrounding chrome (a device card's action row vs. the
   * app header's toolbar) without this component hardcoding either
   * one. Defaults to the same `device-button` class `FlashControls`'
   * own buttons use. */
  triggerClassName?: string;
}

/** Focusable elements inside `container`, in DOM order -- used by the
 * Tab-cycling handler below. Deliberately simple (no `tabindex`
 * ordering beyond "not -1"): everything this dialog ever renders is
 * either not-in-tab-order-by-default markup this component controls
 * directly, or `FlashControls`' own buttons/inputs, none of which set a
 * custom positive `tabindex`. */
function focusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  );
}

export function FlashDialog({
  link,
  name,
  forceShow = false,
  triggerLabel = "Flash",
  triggerClassName = "device-button",
}: FlashDialogProps) {
  const progress = useFlashProgress(link.id);
  const inProgress = progress !== undefined;

  const [open, setOpen] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  // A dialog opened for one link must not silently carry over to the
  // next. `AppHeader` renders one `FlashDialog` instance whose `link`
  // prop swaps to a different device as the route changes (react-router
  // does not remount it just because the matched link changed -- see
  // `AppHeader.tsx`'s doc comment), so this guards that case; it is a
  // harmless no-op for `FrontPage`/`UnknownDevicePage`, which get a
  // fresh instance per link already.
  useEffect(() => {
    setOpen(false);
  }, [link.id]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) {
      return;
    }
    if (open) {
      if (typeof dialog.showModal === "function") {
        dialog.showModal();
      } else {
        // jsdom fallback -- see this module's doc comment.
        dialog.setAttribute("open", "");
      }
      dialog.focus();
    }
  }, [open]);

  const close = useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus();
  }, []);

  /** Fires for every way the native dialog considers itself closed
   * (including a real browser's own post-`cancel` close). Kept in sync
   * with `open` even when the close didn't originate from this
   * component's own `close()` above. */
  const handleDialogClose = useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus();
  }, []);

  const handleCancel = useCallback(
    (event: SyntheticEvent<HTMLDialogElement>) => {
      if (inProgress) {
        // Escape mid-write -- suppressed, see this module's doc
        // comment's dismissal decision. The "Close" button below
        // remains the deliberate way out.
        event.preventDefault();
        return;
      }
      // Closing explicitly here (rather than only relying on the
      // browser's own unprevented-cancel-then-close follow-through)
      // keeps behavior identical in the jsdom test environment, which
      // does not implement that follow-through.
      close();
    },
    [close, inProgress],
  );

  const handleBackdropClick = useCallback(
    (event: ReactMouseEvent<HTMLDialogElement>) => {
      if (event.target !== dialogRef.current) {
        // Landed on the panel content, not the backdrop.
        return;
      }
      if (inProgress) {
        return;
      }
      close();
    },
    [close, inProgress],
  );

  const handleKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDialogElement>) => {
    if (event.key !== "Tab") {
      return;
    }
    const dialog = dialogRef.current;
    if (!dialog) {
      return;
    }
    const focusable = focusableElements(dialog);
    if (focusable.length === 0) {
      event.preventDefault();
      return;
    }
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }, []);

  if (!forceShow && !canBeFlashed(link)) {
    return null;
  }

  // Set only for the case `forceShow` exists to cover: an already-
  // identified device. A `canBeFlashed` device (the common case) is
  // never mid-mission, so it gets no warning line.
  const showReflashWarning = !canBeFlashed(link);
  const deviceLabel = name;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={triggerClassName}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        {triggerLabel}
      </button>
      {open && (
        <dialog
          ref={dialogRef}
          className="flash-dialog"
          aria-label={`Flash ${deviceLabel}`}
          tabIndex={-1}
          onCancel={handleCancel}
          onClose={handleDialogClose}
          onClick={handleBackdropClick}
          onKeyDown={handleKeyDown}
        >
          <div className="flash-dialog-panel">
            <div className="flash-dialog-header">
              <h2>Flash {deviceLabel}</h2>
              <button type="button" className="flash-dialog-close" onClick={close}>
                Close
              </button>
            </div>
            {showReflashWarning && (
              <p className="device-flash-hint flash-dialog-warning" role="note">
                Reflashing "{deviceLabel}" will interrupt whatever it's currently running.
              </p>
            )}
            <FlashControls link={link} />
          </div>
        </dialog>
      )}
    </>
  );
}
