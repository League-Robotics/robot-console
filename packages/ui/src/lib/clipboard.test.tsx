// @vitest-environment jsdom
/**
 * clipboard.test.tsx — `useCopied`'s 1.5s "Copied" flash (ticket
 * 017-007), exercised against a tiny harness component (no
 * `WsProvider`/socket needed -- this hook is provider-independent).
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useCopied, type UseCopiedResult } from "./clipboard";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function Harness({ onResult }: { onResult: (result: UseCopiedResult) => void }) {
  const result = useCopied();
  onResult(result);
  return null;
}

function mountHarness(): { getResult: () => UseCopiedResult; rerender: () => void; unmount: () => void } {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  let result!: UseCopiedResult;

  function render(): void {
    act(() => {
      root!.render(<Harness onResult={(r) => (result = r)} />);
    });
  }
  render();

  return {
    getResult: () => result,
    rerender: render,
    unmount: () => {
      act(() => {
        root!.unmount();
      });
    },
  };
}

afterEach(() => {
  if (root) {
    act(() => {
      root!.unmount();
    });
    root = null;
  }
  if (container) {
    container.remove();
    container = null;
  }
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("useCopied", () => {
  it("starts uncopied", () => {
    const { getResult } = mountHarness();
    expect(getResult().copied).toBe(false);
  });

  it("writes the given text to the clipboard and flips to copied", () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    const { getResult, rerender } = mountHarness();

    act(() => {
      getResult().copy("hello");
    });
    rerender();

    expect(writeText).toHaveBeenCalledWith("hello");
    expect(getResult().copied).toBe(true);
  });

  it("reverts to uncopied after 1.5s", () => {
    vi.useFakeTimers();
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
    const { getResult, rerender } = mountHarness();

    act(() => {
      getResult().copy("hello");
    });
    rerender();
    expect(getResult().copied).toBe(true);

    act(() => {
      vi.advanceTimersByTime(1499);
    });
    rerender();
    expect(getResult().copied).toBe(true);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    rerender();
    expect(getResult().copied).toBe(false);
  });

  it("restarts the revert timer on a second copy before the first reverts", () => {
    vi.useFakeTimers();
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
    const { getResult, rerender } = mountHarness();

    act(() => {
      getResult().copy("first");
    });
    rerender();

    act(() => {
      vi.advanceTimersByTime(1000);
      getResult().copy("second");
    });
    rerender();

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    rerender();
    // 2000ms since the first copy, but only 1000ms since the second --
    // still copied because the second call restarted the timer.
    expect(getResult().copied).toBe(true);

    act(() => {
      vi.advanceTimersByTime(500);
    });
    rerender();
    expect(getResult().copied).toBe(false);
  });

  it("does not throw and still flashes copied when navigator.clipboard is absent", () => {
    Object.assign(navigator, { clipboard: undefined });
    const { getResult, rerender } = mountHarness();

    act(() => {
      getResult().copy("hello");
    });
    rerender();
    expect(getResult().copied).toBe(true);
  });

  it("skips the Copied flash entirely when the clipboard call throws synchronously", () => {
    Object.assign(navigator, {
      clipboard: {
        writeText: () => {
          throw new Error("denied");
        },
      },
    });
    const { getResult, rerender } = mountHarness();

    act(() => {
      getResult().copy("hello");
    });
    rerender();
    expect(getResult().copied).toBe(false);
  });
});
