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
export function useHostVersion(fetchFn: FetchFn = fetch): string | undefined {
  const [version, setVersion] = useState<string | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    fetchFn("/api/host-info")
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
