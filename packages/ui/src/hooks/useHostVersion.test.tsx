// @vitest-environment jsdom
/**
 * useHostVersion.test.tsx — focused unit tests for the `/api/host-info`
 * version probe, exercised directly against a tiny harness component
 * (mirrors `useHeldDrive.test.tsx`'s own shape) with an injected fake
 * `fetch` -- never a real network call.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useHostVersion, type FetchFn } from "./useHostVersion";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function Harness({ fetchFn, onVersion }: { fetchFn: FetchFn; onVersion: (v: string | undefined) => void }) {
  const version = useHostVersion(fetchFn);
  onVersion(version);
  return null;
}

function mountHarness(fetchFn: FetchFn): { getVersion: () => string | undefined; unmount: () => void } {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  let version: string | undefined;
  act(() => {
    root!.render(<Harness fetchFn={fetchFn} onVersion={(v) => (version = v)} />);
  });
  return { getVersion: () => version, unmount: () => root!.unmount() };
}

function fakeFetch(body: unknown, ok = true): FetchFn {
  return (async () =>
    ({
      ok,
      json: async () => body,
    }) as Response) as FetchFn;
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
});

describe("useHostVersion", () => {
  it("returns undefined before the fetch resolves", () => {
    const neverResolves: FetchFn = (() => new Promise(() => {})) as unknown as FetchFn;
    const { getVersion } = mountHarness(neverResolves);
    expect(getVersion()).toBeUndefined();
  });

  it("returns the host's version once /api/host-info resolves with one", async () => {
    const { getVersion } = mountHarness(fakeFetch({ ok: true, service: "robot-console", port: 4795, version: "0.20260919.9" }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(getVersion()).toBe("0.20260919.9");
  });

  it("stays undefined when the host answers with no version field", async () => {
    const { getVersion } = mountHarness(fakeFetch({ ok: true, service: "robot-console", port: 4795 }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(getVersion()).toBeUndefined();
  });

  it("stays undefined on a non-2xx response -- never a wrong or placeholder version", async () => {
    const { getVersion } = mountHarness(fakeFetch({ version: "should-not-be-used" }, false));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(getVersion()).toBeUndefined();
  });

  it("stays undefined on a network error, swallowed rather than thrown", async () => {
    const rejecting: FetchFn = (() => Promise.reject(new Error("network down"))) as unknown as FetchFn;
    const { getVersion } = mountHarness(rejecting);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(getVersion()).toBeUndefined();
  });
});
