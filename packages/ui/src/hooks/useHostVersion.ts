/**
 * useHostVersion.ts — reads the *running host's* version for
 * `AppHeader.tsx` to show right after the app name.
 *
 * Deliberately a plain `fetch("/api/host-info")`, not something routed
 * through `WsProvider`'s WebSocket connection: the version is a fact
 * about which host process answered this HTTP request, independent of
 * whether a WebSocket session happens to be open, and `server.ts`
 * mounts `/api/host-info` unconditionally (before the static/SPA
 * catch-all) for exactly this kind of one-shot probe -- see
 * `daemon/cli.ts`'s own use of the same endpoint for its
 * EADDRINUSE-attach decision.
 *
 * `npm run dev` (port 4795) serves a pre-built static bundle
 * (`packages/ui/dist`), so the bundle's own `package.json` can lag the
 * host it is actually talking to -- fetching from the host itself is
 * the point, not a convenience.
 *
 * ## The URL is derived from the WebSocket's host, not the page origin
 *
 * A bare relative `fetch("/api/host-info")` is correct only when the
 * page and the host share an origin -- true on the host's own port
 * (4795) and in the packaged app, and **false under `npm run dev`**,
 * where Vite serves the UI on 5173 while the host listens on 4795. A
 * relative fetch there hits Vite, which has no such route, so the
 * version silently never appeared -- reported from a browser on
 * `localhost:5173`.
 *
 * So the base comes from the same place `WsProvider`'s
 * `defaultSocketUrl()` gets its own: `VITE_WS_URL` when the dev script
 * defines it (`ws://<host>:<port>/`), converted `ws`->`http`. When it
 * is absent -- the packaged app, and the host's own port -- this falls
 * back to the page origin, which is right for both.
 *
 * Never surfaces a wrong or placeholder version: any failure (network
 * error, non-2xx, unparseable body, missing/non-string `version` field)
 * leaves the returned version `undefined`, same as "the host hasn't
 * answered yet".
 */
import { useEffect, useState } from "react";

/** A minimal `fetch`-shaped function, injectable so tests never make a
 * real network call -- mirrors `useHeldDrive.ts`'s `SendCommand` seam. */
export type FetchFn = typeof fetch;

interface HostInfoResponse {
  readonly ok?: boolean;
  readonly version?: string;
}

/** Fetches `/api/host-info` once on mount and returns the host's
 * `version`, or `undefined` before the fetch resolves or if it fails or
 * the host reports no version at all (an unresolvable version renders
 * as no version, never a wrong one -- see this module's own doc
 * comment). */
/**
 * The absolute URL of the running host's `/api/host-info`.
 *
 * Mirrors `WsProvider.tsx`'s own `defaultSocketUrl()` precedence so the
 * two can never disagree about *which host* the UI is talking to. See
 * this module's doc comment for why a relative URL is wrong under
 * `npm run dev`.
 */
export function hostInfoUrl(): string {
  const configured = import.meta.env.VITE_WS_URL;
  if (typeof configured === "string" && configured !== "") {
    try {
      const wsUrl = new URL(configured);
      const protocol = wsUrl.protocol === "wss:" ? "https:" : "http:";
      return `${protocol}//${wsUrl.host}/api/host-info`;
    } catch {
      // A malformed VITE_WS_URL should not take the version down with
      // it -- fall through to the same-origin path below.
    }
  }
  return "/api/host-info";
}

export function useHostVersion(fetchFn: FetchFn = fetch): string | undefined {
  const [version, setVersion] = useState<string | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    fetchFn(hostInfoUrl())
      .then((response) => (response.ok ? (response.json() as Promise<HostInfoResponse>) : undefined))
      .then((body) => {
        if (!cancelled && body && typeof body.version === "string" && body.version.length > 0) {
          setVersion(body.version);
        }
      })
      .catch(() => {
        // Network error, CORS, malformed JSON, etc. -- leave `version`
        // undefined; the header renders just the name.
      });
    return () => {
      cancelled = true;
    };
  }, [fetchFn]);

  return version;
}
