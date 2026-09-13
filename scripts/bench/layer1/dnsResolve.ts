/**
 * dnsResolve.ts — resolve a `.local` mDNS hostname to its IPv4 address
 * before dialing it, with a bounded timeout, recording how long
 * resolution took.
 *
 * Verified live-bench fact (team-lead, 2026-09-13): `dns.lookup` on this
 * Mac's default (dual-stack) settings takes ~5s for some `.local` names
 * (e.g. `gopiv.local`) and, for others (e.g. `loki.local`), returns an
 * IPv6 link-local address first that a plain `net.connect({host})` then
 * fails to route to at all. Both failure shapes have the same root
 * cause: macOS's resolver stalling on (or preferring) a dead/absent
 * route before an IPv4 fallback that itself answers in single-digit
 * milliseconds. `dns.lookup(host, {family: 4})` sidesteps the IPv6
 * preference; the bounded race below sidesteps the multi-second stall,
 * so a caller's *own* connect timeout is never spent waiting on DNS
 * instead of the wire.
 *
 * Every probe module in this harness must resolve a `.local` host with
 * this function and dial the resulting IP, never the raw hostname
 * directly — this is Layer 1's own regression guard against the exact
 * defect (bench defect 6, sprint.md) this sprint's later tickets fix in
 * the host itself.
 */
import dns from "node:dns";

/** Injectable lookup seam, matching `node:dns`'s own `lookup(hostname,
 * options, callback)` shape closely enough that the real one needs no
 * wrapping beyond promisifying it — tests substitute a fake that never
 * touches a real resolver. */
export type DnsLookupFn = (
  hostname: string,
  options: { family: 4 },
) => Promise<{ address: string; family: number }>;

function defaultLookup(hostname: string, options: { family: 4 }): Promise<{ address: string; family: number }> {
  return new Promise((resolve, reject) => {
    dns.lookup(hostname, options, (error, address, family) => {
      if (error) {
        reject(error);
      } else {
        resolve({ address, family });
      }
    });
  });
}

/** Default bound on resolution — generous relative to the ~5s stall
 * this module exists to detect and report as its own finding, not hide
 * inside a caller's connect timeout. */
export const DEFAULT_RESOLVE_TIMEOUT_MS = 8_000;

export interface ResolveIPv4Options {
  timeoutMs?: number;
  lookup?: DnsLookupFn;
  now?: () => number;
}

export interface ResolveIPv4Result {
  /** The resolved IPv4 address, or `undefined` on failure/timeout. */
  ip: string | undefined;
  /** Wall-clock time this resolution took, however it ended — this is
   * itself bench evidence (the host-side hang the module doc describes
   * is exactly a *large* value here, not a thrown error). */
  resolveMs: number;
  /** Populated whenever `ip` is `undefined`: `"timeout"` if the bound
   * elapsed first, or the underlying lookup error's message otherwise. */
  error?: string;
}

/**
 * Resolve `hostname` to an IPv4 address, racing the real lookup against
 * {@link ResolveIPv4Options.timeoutMs} (default
 * {@link DEFAULT_RESOLVE_TIMEOUT_MS}). Never rejects — every failure
 * (a thrown/rejected lookup, or the timeout winning the race) resolves
 * to `{ ip: undefined, resolveMs, error }` instead, mirroring this
 * codebase's own "failure is a value" convention (`swdName.ts`,
 * `mbrelayRegistry.ts`).
 */
export async function resolveIPv4(hostname: string, options: ResolveIPv4Options = {}): Promise<ResolveIPv4Result> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_RESOLVE_TIMEOUT_MS;
  const lookup = options.lookup ?? defaultLookup;
  const now = options.now ?? Date.now;
  const start = now();

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<ResolveIPv4Result>((resolve) => {
    timer = setTimeout(() => {
      resolve({ ip: undefined, resolveMs: now() - start, error: `resolution timed out after ${timeoutMs}ms` });
    }, timeoutMs);
    timer.unref?.();
  });

  const attempt = (async (): Promise<ResolveIPv4Result> => {
    try {
      const { address } = await lookup(hostname, { family: 4 });
      return { ip: address, resolveMs: now() - start };
    } catch (error) {
      return {
        ip: undefined,
        resolveMs: now() - start,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  })();

  const result = await Promise.race([attempt, timeout]);
  if (timer) {
    clearTimeout(timer);
  }
  return result;
}

/** Strips a trailing `.` (bonjour-service sometimes reports a fully
 * qualified `host.` with a trailing dot) so {@link resolveIPv4} gets a
 * plain hostname `dns.lookup` accepts identically either way, but
 * consistently. */
export function normalizeHostname(host: string): string {
  return host.endsWith(".") ? host.slice(0, -1) : host;
}
