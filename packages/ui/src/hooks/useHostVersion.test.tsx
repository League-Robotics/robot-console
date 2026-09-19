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
import { hostInfoUrl, useHostVersion, type FetchFn } from "./useHostVersion";

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

describe("hostInfoUrl", () => {
  // A bare relative "/api/host-info" is right only when the page and
  // the host share an origin. Under `npm run dev` they do not: Vite
  // serves the UI on 5173 while the host listens on 4795, so the fetch
  // hit Vite, found no such route, and the version silently never
  // appeared. Reported from a browser on localhost:5173.
  const original = import.meta.env.VITE_WS_URL;
  afterEach(() => {
    import.meta.env.VITE_WS_URL = original;
  });

  it("points at the host's own port when the dev script defines VITE_WS_URL", () => {
    import.meta.env.VITE_WS_URL = "ws://127.0.0.1:4795/";
    expect(hostInfoUrl()).toBe("http://127.0.0.1:4795/api/host-info");
  });

  it("uses https for a wss socket", () => {
    import.meta.env.VITE_WS_URL = "wss://gala.local:4795/";
    expect(hostInfoUrl()).toBe("https://gala.local:4795/api/host-info");
  });

  it("falls back to the page origin when VITE_WS_URL is absent", () => {
    // The packaged app and the host's own port: page and host share an
    // origin, so a relative URL is correct there.
    import.meta.env.VITE_WS_URL = "";
    expect(hostInfoUrl()).toBe("/api/host-info");
  });

  it("falls back to the page origin rather than throwing on a malformed VITE_WS_URL", () => {
    import.meta.env.VITE_WS_URL = "not a url";
    expect(hostInfoUrl()).toBe("/api/host-info");
  });
});
