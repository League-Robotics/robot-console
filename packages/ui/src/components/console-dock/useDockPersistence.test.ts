// @vitest-environment jsdom
/**
 * useDockPersistence.test.ts — sprint 022 ticket 003.
 *
 * Exercises the pure storage half of the seam (`readDockState`/
 * `writeDockState`) directly against `window.localStorage`, per this
 * ticket's own Testing plan. The hook half (`useDockPersistence`) is
 * exercised indirectly through `ConsoleDock.test.tsx`'s toggle/
 * persistence cases -- there is no dedicated hook-rendering test here,
 * matching this file's own `.ts` (not `.tsx`) extension.
 */
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_DOCK_HEIGHT_PX, readDockState, writeDockState } from "./useDockPersistence";

const STORAGE_KEY = "robot-console:console-dock";

afterEach(() => {
  window.localStorage.clear();
});

describe("readDockState", () => {
  it("defaults to collapsed at the default height when nothing is stored", () => {
    expect(readDockState()).toEqual({ open: false, heightPx: DEFAULT_DOCK_HEIGHT_PX });
  });

  it("returns a validly-stored open:true as-is -- collapsed is only the fallback, not a forced reset", () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ open: true, heightPx: 400 }));
    expect(readDockState()).toEqual({ open: true, heightPx: 400 });
  });

  it("falls back to the default when the stored JSON does not parse", () => {
    window.localStorage.setItem(STORAGE_KEY, "{not json");
    expect(readDockState()).toEqual({ open: false, heightPx: DEFAULT_DOCK_HEIGHT_PX });
  });

  it("falls back to the default when the stored value is not an object", () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify("not an object"));
    expect(readDockState()).toEqual({ open: false, heightPx: DEFAULT_DOCK_HEIGHT_PX });
  });

  it("substitutes only the missing/invalid field, keeping the other stored one", () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ open: true, heightPx: "not a number" }));
    expect(readDockState()).toEqual({ open: true, heightPx: DEFAULT_DOCK_HEIGHT_PX });

    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ heightPx: 250 }));
    expect(readDockState()).toEqual({ open: false, heightPx: 250 });
  });

  it("rejects a non-positive heightPx", () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ open: true, heightPx: 0 }));
    expect(readDockState()).toEqual({ open: true, heightPx: DEFAULT_DOCK_HEIGHT_PX });
  });
});

describe("writeDockState", () => {
  it("round-trips through readDockState", () => {
    writeDockState({ open: true, heightPx: 275 });
    expect(readDockState()).toEqual({ open: true, heightPx: 275 });
  });

  it("is a no-op that does not throw when localStorage.setItem fails", () => {
    const original = window.localStorage.setItem.bind(window.localStorage);
    window.localStorage.setItem = () => {
      throw new Error("quota exceeded");
    };
    try {
      expect(() => writeDockState({ open: true, heightPx: 300 })).not.toThrow();
    } finally {
      window.localStorage.setItem = original;
    }
  });
});
