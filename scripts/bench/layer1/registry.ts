/**
 * registry.ts — the one HTTP call this harness makes: `GET
 * http://<host>:<registryPort>/names/<name>` against an mbrelay pool's
 * name registry, to learn the `(channel, group)` a given robot name
 * currently resolves to (`packages/host/src/mbrelayRegistry.ts`'s own
 * doc comment documents the exact same route/response shape and its
 * "write-on-read" trap — this module is a small, read-only-by-policy
 * duplicate for Layer 1's own use, not an import of that host module,
 * for the same host-internals boundary this harness keeps everywhere
 * else).
 *
 * Live-verified response shape (2026-09-13 bench, this ticket):
 * `{ channel, group, source, name, derived, updated }` — this module
 * only reads `channel`/`group`/`source`, per the host module's own
 * documented assumption.
 */

export interface RegistryAddress {
  channel: number;
  group: number;
  source: string;
}

/** Parse a `GET /names/<name>` response body. `undefined` for anything
 * not matching the documented shape — never throws. Pure, so directly
 * testable against a captured response body. */
export function parseRegistryResponse(body: unknown): RegistryAddress | undefined {
  if (typeof body !== "object" || body === null) {
    return undefined;
  }
  const record = body as Record<string, unknown>;
  const { channel, group, source } = record;
  if (typeof channel !== "number" || typeof group !== "number" || typeof source !== "string") {
    return undefined;
  }
  return { channel, group, source };
}

export interface ResolveRadioAddressOptions {
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}

/**
 * Resolve `name`'s current `(channel, group)` from the registry at
 * `host:port`. Never throws — a network error, timeout, non-OK status,
 * or malformed body all resolve to `undefined`, matching this
 * codebase's own "failure is a value" convention.
 */
export async function resolveRadioAddress(
  host: string,
  port: number,
  name: string,
  options: ResolveRadioAddressOptions = {},
): Promise<RegistryAddress | undefined> {
  const timeoutMs = options.timeoutMs ?? 2_000;
  const fetchFn = options.fetchFn ?? fetch;
  const url = `http://${host}:${port}/names/${encodeURIComponent(name)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchFn(url, { method: "GET", signal: controller.signal });
    if (!response.ok) {
      return undefined;
    }
    const body: unknown = await response.json();
    return parseRegistryResponse(body);
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}
