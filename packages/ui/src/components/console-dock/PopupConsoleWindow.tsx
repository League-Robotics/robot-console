/**
 * PopupConsoleWindow.tsx — portals the dock's own console content into
 * an already-opened browser window and owns that window's lifecycle
 * (sprint 022 ticket 005, SUC-003; sprint.md Architecture §Step 3,
 * module 1).
 *
 * ## Opening happens one level up, not here
 *
 * `window.open` must be called synchronously from inside the pop-out
 * button's own `onClick` handler — a call made from inside a `useEffect`
 * (which always runs on a later tick than the click that triggered the
 * render, even a `useLayoutEffect` in the presence of concurrent
 * features) risks losing the "this came from a user gesture" chain the
 * browser checks before allowing `window.open` to succeed, and the
 * browser silently returns `null` (a blocked popup) instead of opening
 * one. So `ConsoleDock.tsx` — the component that actually owns the
 * button — calls `lib/popupWindow.ts`'s `openPopupWindow` directly in
 * its click handler and only *then* mounts this component, handing it
 * the resulting `Window` as the `popupWindow` prop. By the time this
 * component's effects run, the window already exists; this component's
 * whole job is what happens inside it from that point on:
 *
 *  1. Copy every stylesheet from the parent document into it.
 *  2. Give it a container element and portal the console content in.
 *  3. Wire up the close/restore lifecycle in both directions.
 *
 * ## Copying stylesheets: the entire `<head>`, not "the owning file"
 *
 * A brand-new `window.open` document starts with none of the parent's
 * CSS — copying only the one `.css` file that "owns" `DeviceConsole`/
 * `CommandStrip` is not enough, because this app's ~30 plain `.css`
 * files reuse class names across files (confirmed while planning this
 * sprint: `ConfigurationPage.tsx` relies on `.calibration-code` rules
 * that live in `CalibrationPage.css`, not its own file — and the same
 * risk applies here, since `DeviceConsole`/`CommandStrip` may equally
 * depend on ambient rules, e.g. the `--rc-*` custom properties defined
 * on `:root` in whichever file happens to declare them). So
 * {@link copyParentStylesheets} below copies every `<style>` and
 * `<link rel="stylesheet">` element actually present in the *live*
 * parent `document.head` at the moment the popup opens, verbatim, via
 * `cloneNode(true)`. This is what makes the same code correct in both
 * environments this project ships in without special-casing either:
 * Vite's dev server injects one `<style>` tag per CSS module as the
 * page loads (so `document.head` accumulates many small `<style>`
 * tags), while a production build serves one or a few bundled
 * `<link rel="stylesheet">` elements instead — reading whatever is
 * actually in the DOM, rather than assuming either shape, covers both
 * for free. This was verified by reading the built output, not assumed
 * (see this ticket's own report for the exact check).
 *
 * `:root`-scoped custom properties copy correctly too: `:root` refers
 * to *the containing document's own* root element, so pasting the same
 * CSS text into the popup's `<head>` makes those variables resolve
 * against the popup's own `<html>`, with no special handling needed.
 *
 * ## The portal container: a `<div>` appended to the popup's `<body>`
 *
 * `ReactDOM.createPortal` needs a concrete DOM node to render into.
 * Rather than portal directly onto `popupWindow.document.body` itself
 * (a node this component does not otherwise own and would be awkward to
 * clean up), a single `<div>` is created and appended to that body once,
 * at open time, and portaled into — the standard shape for "render React
 * into a window I don't control the whole document of." The div is
 * created inside a `useEffect` (not a `useState` lazy initializer)
 * specifically so the one-time DOM mutation (creating a node and
 * appending it to a *different* document) is a documented side effect
 * tied to this component's lifecycle, not something that runs during
 * render.
 *
 * ## Lifecycle: three independent signals feeding one `onClose`
 *
 * Per this ticket's own Description, event delivery for a closing
 * window is not perfectly reliable, so three independent mechanisms all
 * funnel into the same `notifyClosed` (guarded to fire at most once via
 * `notifiedRef`, since more than one of the three can fire for the same
 * close):
 *
 *  1. **The popup's own `pagehide`** — the preferred signal (per this
 *     ticket's Description, more reliable across browsers than
 *     `beforeunload`) for "the student closed this window using its
 *     native close control."
 *  2. **A `popup.closed` poll**, checked once a second. Documented here
 *     as a pragmatic belt-and-suspenders fallback, not the primary
 *     mechanism — a window force-closed by the OS, or a fake test
 *     window whose `close()` never dispatches a real `pagehide`, may
 *     never fire event 1 at all.
 *  3. **The in-popup "put it back" button**, which calls `close()` on
 *     its own window and then calls `notifyClosed` directly rather than
 *     waiting on 1 or 2 — this is a synchronous, known-good closure
 *     triggered by this same component tree, so there is no reason to
 *     round-trip through an event that might not even be reliable in a
 *     test fake.
 *
 * ## Why cleanup does *not* itself call `popupWindow.close()`
 *
 * An earlier draft of this component closed the popup unconditionally
 * in its effect's cleanup function, reasoning that "the popup's owner
 * unmounting is what closes it" (this is in fact sprint.md's own stated
 * plan for ticket 006's route-driven teardown). That is wrong for *this*
 * component to do unconditionally, for a concrete, reproducible reason:
 * `main.tsx` wraps the app in `<StrictMode>`, and React's StrictMode
 * deliberately double-invokes every effect once in development
 * (mount → cleanup → mount again, synchronously) to surface exactly this
 * class of bug. A cleanup that closes the real browser window the
 * student just opened would fire during that synthetic first pass and
 * close the popup the instant it opened, in development only, with no
 * way to reopen it (this component never calls `window.open` itself —
 * only `ConsoleDock.tsx`'s click handler does, and StrictMode's replay
 * does not re-run the original click). So this effect's cleanup only
 * ever removes the listeners/interval it added; the three lifecycle
 * paths above are the *only* things that call `popupWindow.close()` from
 * inside this module. The fourth close path this ticket requires — the
 * parent tab's own `unload` — is safe to wire the same way real
 * `beforeunload`-adjacent listeners always are: it is a genuine browser
 * event on the real top-level `window`, never synthesized by StrictMode,
 * so attaching/detaching it in this same effect carries none of the
 * cleanup risk described above. Sprint 022 ticket 006 adds a fifth close
 * path — the *caller's* own unmount — but deliberately outside this
 * module (`ConsoleDock.tsx`'s own doc comment, "Ticket 006," explains
 * why doing it there instead sidesteps this exact hazard).
 *
 * ## Ticket 006: retargeting is already free -- no change needed here
 *
 * `link`/`name` below are read fresh on every render by the portaled
 * JSX at the bottom of this component, and the one-time setup effect
 * above depends only on `[popupWindow, notifyClosed]` -- never on
 * `link`/`name`. So when `DevicePage.tsx`'s "active console target"
 * changes (a device switch, or a relay's bridged child changing) while
 * a popup is already open, `ConsoleDock` simply re-renders this already-
 * mounted component with new `link`/`name` props: the portaled content
 * updates in place, the document-title effect below (already keyed on
 * `name`) updates the popup's title, and `window.open` is never called
 * again for the same popup. This is exactly the "same `Window` object,
 * new content" behavior sprint.md's Design Rationale calls for -- ticket
 * 005 built the seam without knowing it would be needed this way; ticket
 * 006 is the first caller to actually change `link`/`name` on a live
 * popup, and no code in this file needed to change for it to work.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { SnapshotLink } from "@robot-console/host/src/wsMessages.js";
import { ConsoleBody } from "./ConsoleBody";
import "./PopupConsoleWindow.css";

/** How often to poll `popupWindow.closed` as the belt-and-suspenders
 * fallback described in this module's own doc comment. One second is
 * frequent enough that "closed the popup, dock reopens" reads as
 * effectively instant to a student, without polling so often it shows
 * up in a profile for what is, in the common case, a no-op check. */
const CLOSED_POLL_INTERVAL_MS = 1000;

/**
 * Clone every `<style>`/`<link rel="stylesheet">` element currently in
 * the parent document's `<head>` into `targetDocument`'s own `<head>`.
 * Exported (not just a local function) so `PopupConsoleWindow.test.tsx`
 * can call it directly against a bare fake document, independent of the
 * rest of this component's mount/portal machinery.
 *
 * Reads from the real ambient `document` — i.e. *this* module's own
 * parent document — deliberately, not a document passed in as a
 * parameter: `PopupConsoleWindow` only ever exists inside the same
 * top-level document `ConsoleDock` renders into, so there is exactly
 * one meaningful "parent" to copy from.
 */
export function copyParentStylesheets(targetDocument: Document): void {
  const nodes = document.head.querySelectorAll("style, link[rel='stylesheet']");
  nodes.forEach((node) => {
    targetDocument.head.appendChild(node.cloneNode(true));
  });
}

export interface PopupConsoleWindowProps {
  /** The already-opened popup window (or, in tests, a fake object
   * shaped like one — see this module's own doc comment for why opening
   * itself happens one level up, in `ConsoleDock.tsx`). */
  popupWindow: Window;
  /** The device currently active for console purposes — the same
   * `{ link, name }` shape `ConsoleDock` itself receives. This ticket's
   * scope is deliberately limited to *rendering* whatever `link`/`name`
   * currently are; reacting to them changing out from under an
   * already-open popup (device switch, relay retargeting) is ticket
   * 006's job, not this component's. */
  link: SnapshotLink;
  name: string;
  /** Called exactly once, no matter which of this module's three
   * lifecycle paths triggers it, whenever the popup should be
   * considered gone. `ConsoleDock.tsx` reacts by clearing its own
   * reference to the popup and reopening the docked pane (restored to
   * *open*, never collapsed — closing the popup is the student asking
   * for the console back, not asking for it to disappear entirely). */
  onClose: () => void;
  /** Whether the compact command rail is showing, and the handler that
   * flips it. Both come from `ConsoleDock`, which owns the persisted
   * dock state — this component deliberately does NOT read
   * `useDockPersistence` itself. Two independent `useState` copies of
   * one persisted record do not notify each other, so a rail toggled in
   * the popup would leave the dock rendering from a stale value the
   * moment the popup was put back. One owner, passed down. */
  commandsOpen: boolean;
  onToggleCommands: () => void;
}

export function PopupConsoleWindow({
  popupWindow,
  link,
  name,
  onClose,
  commandsOpen,
  onToggleCommands,
}: PopupConsoleWindowProps) {
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const notifiedRef = useRef(false);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const notifyClosed = useCallback(() => {
    // Three independent signals (pagehide, the closed-poll, and the
    // in-popup "put it back" button) can all reach this function for
    // the very same close -- see this module's own doc comment. Only
    // the first one should actually do anything.
    if (notifiedRef.current) {
      return;
    }
    notifiedRef.current = true;
    onCloseRef.current();
  }, []);

  // One-time setup, keyed only on `popupWindow`'s own identity: copy
  // stylesheets, create the portal container, and wire up every
  // lifecycle listener. Deliberately does NOT depend on `link`/`name` --
  // those are read fresh on every render by the portaled JSX below, but
  // none of the setup here needs to redo itself just because the active
  // device's display name changed (out of scope for this ticket, see
  // this component's own doc comment; this effect shape is nonetheless
  // the seam ticket 006 will need for that).
  useEffect(() => {
    copyParentStylesheets(popupWindow.document);

    const portalContainer = popupWindow.document.createElement("div");
    popupWindow.document.body.appendChild(portalContainer);
    setContainer(portalContainer);

    popupWindow.addEventListener("pagehide", notifyClosed);

    const pollId = window.setInterval(() => {
      if (popupWindow.closed) {
        notifyClosed();
      }
    }, CLOSED_POLL_INTERVAL_MS);

    // The parent tab's own unload (a reload or the tab itself closing)
    // must not orphan the popup with no way back to it -- this is a
    // real browser event on the real top-level `window`, never
    // synthesized by React StrictMode, so closing the popup here (unlike
    // in this effect's cleanup below) carries none of the risk this
    // module's own doc comment describes.
    const handleParentUnload = () => {
      if (!popupWindow.closed) {
        popupWindow.close();
      }
    };
    window.addEventListener("unload", handleParentUnload);

    return () => {
      popupWindow.removeEventListener("pagehide", notifyClosed);
      window.clearInterval(pollId);
      window.removeEventListener("unload", handleParentUnload);
      // Deliberately no `popupWindow.close()` here -- see this module's
      // own doc comment ("Why cleanup does not itself call
      // popupWindow.close()") for the StrictMode-double-invoke hazard
      // that ruled this out.
    };
  }, [popupWindow, notifyClosed]);

  // The popup's document title tracks the active device's display name
  // so the browser's own window-switcher/taskbar entry is meaningful --
  // cheap and idempotent enough to just re-run whenever `name` changes,
  // unlike the one-time setup above.
  useEffect(() => {
    popupWindow.document.title = `Debug Console — ${name}`;
  }, [popupWindow, name]);

  const handleRestoreClick = useCallback(() => {
    if (!popupWindow.closed) {
      popupWindow.close();
    }
    // Call directly rather than relying solely on `pagehide` -- this
    // close is already a known-good, synchronous action taken from
    // inside this same component tree (see this module's own doc
    // comment, lifecycle path 3), and a test's fake `close()` is not
    // obliged to dispatch a real `pagehide` the way a browser would.
    notifyClosed();
  }, [popupWindow, notifyClosed]);

  if (!container) {
    // The one-render gap between mount and the setup effect creating the
    // portal container above -- nothing to portal into yet.
    return null;
  }

  return createPortal(
    <div className="popup-console-window" data-testid="popup-console-window">
      <div className="popup-console-window-bar">
        <span className="popup-console-window-title">Debug Console — {name}</span>
        {/* Same opt-in command rail as the docked console, driven by
            the same persisted flag -- the popup and the dock are two
            views of one console (popping out collapses the dock;
            closing the popup restores it), so turning the rail on in
            one and finding it off in the other would be a difference
            with no meaning behind it. */}
        <button
          type="button"
          className="popup-console-window-commands-toggle"
          data-testid="popup-console-commands-toggle"
          aria-expanded={commandsOpen}
          onClick={onToggleCommands}
        >
          {commandsOpen ? "Commands ▾" : "Commands ▸"}
        </button>
        <button
          type="button"
          className="popup-console-window-restore"
          data-testid="popup-console-restore"
          onClick={handleRestoreClick}
        >
          Put it back ▾
        </button>
      </div>
      <ConsoleBody link={link} name={name} commandsOpen={commandsOpen} />
    </div>,
    container,
  );
}
