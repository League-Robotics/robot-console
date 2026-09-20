/**
 * FakePopupWindow.ts — the one shared "`Window`-shaped" fake for sprint
 * 022 ticket 005's pop-out console window (SUC-003), matching the
 * fake's shape as specified in that ticket's own Description: "a plain
 * object exposing `document`, `closed`, `close()`, and an
 * event-target-like surface for `pagehide`."
 *
 * jsdom (this project's `@vitest-environment`) has no real
 * `window.open` — it either returns `undefined`/`null` depending on
 * version, per `lib/popupWindow.test.ts`'s own findings — so nothing
 * that models an *open* popup window can be built from a real browser
 * API here. This fake stands in for one everywhere a test needs to
 * drive `PopupConsoleWindow.tsx`'s open/portal/stylesheet-copy/
 * lifecycle logic (`PopupConsoleWindow.test.tsx`) or `ConsoleDock.tsx`'s
 * own pop-out button wiring (`ConsoleDock.test.tsx`, which mocks
 * `lib/popupWindow.ts`'s `openPopupWindow` to return one of these
 * instead of calling through to a real `window.open`).
 *
 * `document` is a *real* jsdom `Document`
 * (`document.implementation.createHTMLDocument`), not itself faked —
 * jsdom already gives every `Document` a working `head`/`body`/
 * `createElement`, so there is no reason to reimplement any of that;
 * the only things a real `Window` has that a bare `Document` doesn't
 * are `closed`, `close()`, and the popup-specific event surface, which
 * is exactly what this fake adds on top.
 *
 * `pagehide` is modeled with a tiny private listener registry rather
 * than a real `EventTarget`, so `firePagehide()` can simulate exactly
 * the one event `PopupConsoleWindow.tsx` listens for without depending
 * on jsdom's own window/event machinery at all.
 */
export interface FakePopupWindow {
  document: Document;
  closed: boolean;
  close: () => void;
  addEventListener: (type: string, listener: () => void) => void;
  removeEventListener: (type: string, listener: () => void) => void;
  /** Test-only: invoke every registered "pagehide" listener, simulating
   * what a real browser fires when the student uses the popup's own
   * native close control. */
  firePagehide: () => void;
}

export function createFakePopupWindow(): FakePopupWindow {
  const pagehideListeners = new Set<() => void>();
  const fakeDocument = document.implementation.createHTMLDocument("Popup");
  const fake: FakePopupWindow = {
    document: fakeDocument,
    closed: false,
    close: () => {
      fake.closed = true;
    },
    addEventListener: (type, listener) => {
      if (type === "pagehide") {
        pagehideListeners.add(listener);
      }
    },
    removeEventListener: (type, listener) => {
      if (type === "pagehide") {
        pagehideListeners.delete(listener);
      }
    },
    firePagehide: () => {
      pagehideListeners.forEach((listener) => listener());
    },
  };
  return fake;
}
