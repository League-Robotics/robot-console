// @vitest-environment jsdom
/**
 * popupWindow.test.ts — sprint 022 ticket 005, SUC-003.
 *
 * This module is a one-line wrapper around the bare `window.open`
 * call, so its own test only needs to prove two things: it forwards
 * `name`/`features` to `window.open` unchanged, and it returns exactly
 * whatever `window.open` returns (including `null`, jsdom's own
 * unconditional behavior for this call — confirmed by *not* mocking
 * `window.open` in the "returns null under jsdom" case below, so this
 * assertion breaks loudly if a future jsdom upgrade ever changes that).
 * Every other seam-related concern (the fake `Window`-shaped object
 * substitution, lifecycle wiring) belongs to
 * `PopupConsoleWindow.test.tsx` and `ConsoleDock.test.tsx`, which mock
 * this module entirely rather than exercising it for real.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { openPopupWindow } from "./popupWindow";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("openPopupWindow", () => {
  it("calls window.open with an empty URL, the given name, and the given features", () => {
    const openSpy = vi.spyOn(window, "open").mockReturnValue(null);
    openPopupWindow("robot-console-debug-console", "width=640,height=420");
    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(openSpy).toHaveBeenCalledWith("", "robot-console-debug-console", "width=640,height=420");
  });

  it("returns whatever window.open returns, unmodified", () => {
    const fakeWindow = { closed: false } as unknown as Window;
    vi.spyOn(window, "open").mockReturnValue(fakeWindow);
    expect(openPopupWindow("n", "f")).toBe(fakeWindow);
  });

  it("returns a falsy value under jsdom, unmocked -- this is the real environment gap this whole seam exists to work around", () => {
    // Deliberately not mocking `window.open` here: jsdom (the installed
    // 30.0.1, confirmed by running this exact assertion) does not
    // implement `Window.open()` and returns `undefined` at runtime
    // (logging "Not implemented: Window's open() method" to the
    // console) despite `lib.dom.d.ts` typing the call as
    // `WindowProxy | null` -- so this checks falsiness, not a specific
    // one of `null`/`undefined`, deliberately tolerant of exactly which
    // "nothing" value a given jsdom version picks. Either way, this is
    // this ticket's own Testability note in concrete form: nothing that
    // depends on a real popup window can be exercised this way, which
    // is exactly why `PopupConsoleWindow.test.tsx`/`ConsoleDock.test.tsx`
    // mock this module entirely rather than calling through it. If a
    // future jsdom upgrade ever makes this call return a real object,
    // this test should be the first thing to fail, since it would mean
    // the premise for the fake-seam design elsewhere needs revisiting.
    expect(openPopupWindow("n", "f")).toBeFalsy();
  });
});
