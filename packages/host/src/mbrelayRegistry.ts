/**
 * mbrelayRegistry.ts — resolve one robot name to a live radio address via
 * mbrelay's name registry over HTTP, distinguishing three outcomes.
 *
 * ## The write-on-read trap (read this first)
 *
 * Per `docs/design/specification.md` §6 ("A derived `(channel, group)`
 * is a default, not an address, and there are three outcomes, not
 * two"): `GET /names/<name>` on the registry's own host/port **mutates
 * the shared registry and always answers 200**. `httpapi.py:146`
 * returns `registry.resolve(name)`, and `resolve()` falls through to
 * deriving the address locally (a Python port of this package's own
 * `nameToRadioAddress`), writes the guess into `_learned`, calls
 * `save()`, and replies `source: "derived"`. So "the HTTP call
 * succeeded" is **never** the same as "the registry knew" — checking
 * only for a 200 presents a locally-derivable guess as authoritative.
 * `registry.py` has a separate, non-mutating `get()` that this HTTP
 * route does not use, so there is no way to "peek" without writing.
 *
 * Consequences this module enforces as policy, not merely documents:
 *   - **Only ever a single `GET`** per resolution — never `POST`/
 *     `DELETE` (the registry's HTTP API has no auth per the roadmap
 *     plan, so staying read-only is a choice this client makes, not
 *     something the API itself prevents).
 *   - **Lazy resolution only** — one name, at connect time. This
 *     module has no batch/prefetch entry point, because prefetching
 *     (e.g. to populate a dropdown) would enrol every candidate name
 *     into shared classroom state.
 *   - **Three outcomes surfaced, never collapsed to a boolean**:
 *     - `"config"` / `"registry"` — the registry actually knew (its
 *       reply indicates a real, previously-stored mapping, not a
 *       same-request derivation).
 *     - `"derived"` — the registry replied 200, but its own reply
 *       indicates it just derived the address on this request.
 *       Surfaced as prominently as a fallback, since the failure mode
 *       it represents (a locally-derivable guess presented as a 200
 *       OK) is identical to one.
 *     - `"local-derived"` — the registry was unreachable (timeout,
 *       network error, malformed response, or no registry host/port
 *       was ever supplied at all) and this module computed
 *       `{ channel, group }` itself via `@robot-console/protocol`'s
 *       `nameToRadioAddress`.
 *   Never use a derived value (of either kind) silently — that policy
 *   is this module's caller's job; this module's job is only to make
 *   the distinction impossible to lose.
 *
 * ## Response shape assumption
 *
 * The exact `GET /names/<name>` response body is not independently
 * captured in this codebase's docs beyond the `source: "derived"`
 * field (`specification.md` §6). This module assumes the shape
 * `{ channel: number, group: number, source: "config" | "registry" |
 * "derived" }`, with `"config"`/`"registry"` naming the two non-derived
 * ways `registry.py` may have actually known the mapping (a static
 * config entry vs. a previously-`_learned` one), per the roadmap
 * plan's own three-outcome framing. An unrecognized `source` value, or
 * a response missing/mistyped `channel`/`group`, is treated the same
 * as an unreachable registry (`"local-derived"`) rather than guessed
 * at further. The route itself (`GET /names/<name>`, no query string)
 * is exact (`specification.md` §6); the response body's wrapper shape
 * around `channel`/`group`/`source` is this module's one documented
 * assumption, kept behind the single {@link NAME_LOOKUP_PATH_PREFIX}
 * constant so it is easy to correct in one place if verified otherwise.
 *
 * ## Never throws
 *
 * Mirrors `releases.ts` and `KnownRobotsStore`'s "never throws"
 * contract: every failure path — network error, timeout, malformed
 * response, or no registry configured at all — resolves to
 * `"local-derived"`, never a rejected promise.
 *
 * ## Injectable `fetch` and `Scheduler`
 *
 * The injected `fetch` (mirrors `releases.ts`'s own network-call
 * injection pattern) is the only network I/O seam. The injected
 * `Scheduler` (`link/pacing.ts` — reused rather than inventing a
 * second timing abstraction, the same choice `RelayCommandPlane.ts`
 * already made) is the only timing seam, so the ~1.5s client-side
 * timeout is provable against a fake scheduler with no real
 * wall-clock delay in tests.
 *
 * ## Short TTL cache
 *
 * Resolutions are cached per name for {@link DEFAULT_TTL_MS} so a
 * re-click on the same name within the window doesn't re-trigger a
 * registry write (see "the write-on-read trap" above) — picked to
 * match the ~1.5s request timeout's order of magnitude, per
 * `sprint.md`'s Open Questions. The cache defaults to a module-level
 * `Map` shared by every real caller (so the app gets one coherent
 * cache with zero wiring); tests inject their own `Map` via
 * {@link ResolveRobotAddressOptions.cache} so cases never leak state
 * into one another.
 */

import { nameToRadioAddress, type RadioAddress } from "@robot-console/protocol";
import { realScheduler, type Scheduler } from "./link/pacing.js";

/** Ticket 014-001: used only to format a caught error for the
 * `console.warn` calls below -- this module's own "never throws"
 * contract already means every caller-visible failure collapses to
 * `"local-derived"`, so these warnings are diagnostics only. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Registry location, as advertised in a discovered relay's `_mbrelay._tcp`
 * TXT record (`registryPort`, per `discovery/mdnsDiscovery.ts`'s
 * `RelayService`) plus the relay's own resolved host. This module takes
 * these as plain arguments — it does no discovery of its own. */
export interface RegistryLocation {
  host: string;
  port: number;
}

/** Every outcome {@link resolveRobotAddress} can report — see this
 * module's doc comment for what each one means. */
export type AddressOutcome = "config" | "registry" | "derived" | "local-derived";

/** A resolved radio address plus which of the three outcomes produced
 * it. Never carries a `"config"`/`"registry"`/`"derived"` outcome
 * without values that actually came from the registry's reply, and
 * never a `"local-derived"` outcome with anything but a value computed
 * by `nameToRadioAddress`. */
export interface ResolvedAddress extends RadioAddress {
  outcome: AddressOutcome;
}

/** Minimal shape this module needs from a `fetch` response — narrower
 * than the full DOM `Response` type, so a test fixture only needs to
 * implement these two members rather than a real `Response` (which a
 * real global `fetch` call already structurally satisfies). */
export interface MbrelayRegistryFetchResponse {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}

/** Function shape used for the one HTTP call this module ever makes.
 * `init.method` is always `"GET"` — see this module's doc comment's
 * read-only-by-policy invariant. Defaults to the real global `fetch`;
 * tests inject a fixture-backed fake instead. */
export type FetchFn = (
  url: string,
  init: { method: "GET" },
) => Promise<MbrelayRegistryFetchResponse>;

async function defaultFetch(
  url: string,
  init: { method: "GET" },
): Promise<MbrelayRegistryFetchResponse> {
  return fetch(url, init);
}

interface CacheEntry {
  expiresAt: number;
  result: ResolvedAddress;
}

/** Module-level default cache, shared by every caller that doesn't
 * inject its own — see this module's doc comment's "Short TTL cache"
 * section. */
const DEFAULT_CACHE = new Map<string, CacheEntry>();

export interface ResolveRobotAddressOptions {
  /** Injectable HTTP layer. Defaults to the real global `fetch`. */
  fetch?: FetchFn;
  /** Injectable delay primitive for the client-side timeout. Defaults
   * to real timers ({@link realScheduler}); tests substitute a fake so
   * the timeout path is provable with no real wall-clock delay. */
  scheduler?: Scheduler;
  /** Client-side timeout in milliseconds for the registry HTTP call.
   * Defaults to {@link DEFAULT_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** TTL cache window in milliseconds. Defaults to
   * {@link DEFAULT_TTL_MS}. */
  ttlMs?: number;
  /** Returns the current time in epoch milliseconds. Defaults to
   * `Date.now`; injectable so tests can assert exact TTL-boundary
   * behavior deterministically. */
  now?: () => number;
  /** The TTL cache itself. Defaults to a module-level `Map` shared by
   * every real caller. Tests inject a fresh `Map` per test case so the
   * "one fetch call within the TTL window" contract is provable
   * without one test's cache entry leaking into another's. */
  cache?: Map<string, CacheEntry>;
}

/** ~1.5s — shorter than mbrelay's own 3s client, since this call blocks
 * a UI click (this module's own acceptance criteria / `sprint.md`). */
export const DEFAULT_TIMEOUT_MS = 1500;

/** Short TTL cache window — matches {@link DEFAULT_TIMEOUT_MS}'s order
 * of magnitude, per `sprint.md`'s Open Questions ("this sprint's
 * tickets should pick a concrete default"). */
export const DEFAULT_TTL_MS = 2000;

/** Registry HTTP route this module ever calls, exact per
 * `specification.md` §6 ("`GET /names/<name>` on :8761" — the port is
 * discovered, not assumed, so only the path is fixed here). Kept as
 * the single constant this module's response-shape assumption hangs
 * off of — see this module's doc comment. */
const NAME_LOOKUP_PATH_PREFIX = "/names/";

/** The registry's own `source` values this module recognizes as an
 * actual hit or an on-request derivation (see this module's doc
 * comment's "Response shape assumption"). Any other value is treated
 * as malformed. */
const KNOWN_SOURCES: ReadonlySet<string> = new Set(["config", "registry", "derived"]);

/** Sentinel Promise.race can resolve to when the timeout wins the
 * race against the registry's `fetch` call. */
const REGISTRY_TIMEOUT = Symbol("mbrelayRegistry.timeout");

/**
 * Parse a `GET /names/<name>` response body into a {@link
 * ResolvedAddress}. Returns `undefined` for anything that doesn't
 * match this module's documented response-shape assumption — never
 * throws, never guesses at a partially-valid shape.
 */
function parseResolvedAddress(body: unknown): ResolvedAddress | undefined {
  if (typeof body !== "object" || body === null) {
    return undefined;
  }
  const record = body as Record<string, unknown>;
  const { channel, group, source } = record;
  if (typeof channel !== "number" || typeof group !== "number") {
    return undefined;
  }
  if (typeof source !== "string" || !KNOWN_SOURCES.has(source)) {
    return undefined;
  }
  return { channel, group, outcome: source as "config" | "registry" | "derived" };
}

/**
 * Issue the one `GET /names/<name>` call this module ever makes,
 * racing it against {@link timeoutMs} via the injected `scheduler`.
 * Returns `undefined` for every failure mode (network error, timeout,
 * non-OK status, unparseable JSON, or a body that doesn't match this
 * module's response-shape assumption) — the caller falls back to
 * `"local-derived"` in every such case. Never throws.
 */
async function fetchResolution(
  name: string,
  registry: RegistryLocation,
  fetchFn: FetchFn,
  scheduler: Scheduler,
  timeoutMs: number,
): Promise<ResolvedAddress | undefined> {
  const url = `http://${registry.host}:${registry.port}${NAME_LOOKUP_PATH_PREFIX}${encodeURIComponent(name)}`;

  let response: MbrelayRegistryFetchResponse | typeof REGISTRY_TIMEOUT;
  try {
    response = await Promise.race<MbrelayRegistryFetchResponse | typeof REGISTRY_TIMEOUT>([
      fetchFn(url, { method: "GET" }),
      scheduler.delay(timeoutMs).then(() => REGISTRY_TIMEOUT),
    ]);
  } catch (error) {
    console.warn(
      `fetchResolution: request to "${url}" failed (${errorMessage(error)}) -- falling back to local-derived`,
    );
    return undefined;
  }

  if (response === REGISTRY_TIMEOUT || !response.ok) {
    return undefined;
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    console.warn(
      `fetchResolution: response body from "${url}" was not valid JSON (${errorMessage(error)}) -- falling back to local-derived`,
    );
    return undefined;
  }

  return parseResolvedAddress(body);
}

/**
 * Resolve `name` to a live radio address via mbrelay's name registry,
 * distinguishing three outcomes (`"config"`/`"registry"`, `"derived"`,
 * `"local-derived"`) — see this module's doc comment. **Never throws**:
 * every failure path (no `registry` supplied, network error, timeout,
 * or a malformed response) resolves to `"local-derived"`, computed via
 * `@robot-console/protocol`'s `nameToRadioAddress`, never a rejected
 * promise.
 *
 * Cached per `name` for {@link ResolveRobotAddressOptions.ttlMs} (or
 * {@link DEFAULT_TTL_MS}): a second call for the same name within the
 * TTL window returns the cached result with **no** further registry
 * call — see this module's doc comment's write-on-read trap. Only ever
 * issues a `GET`.
 */
export async function resolveRobotAddress(
  name: string,
  registry: RegistryLocation | undefined,
  options: ResolveRobotAddressOptions = {},
): Promise<ResolvedAddress> {
  const cache = options.cache ?? DEFAULT_CACHE;
  const now = options.now ?? Date.now;

  const cached = cache.get(name);
  if (cached !== undefined && now() < cached.expiresAt) {
    return cached.result;
  }

  const fetchFn = options.fetch ?? defaultFetch;
  const scheduler = options.scheduler ?? realScheduler;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;

  const resolved =
    registry !== undefined
      ? await fetchResolution(name, registry, fetchFn, scheduler, timeoutMs)
      : undefined;

  const result: ResolvedAddress = resolved ?? { ...nameToRadioAddress(name), outcome: "local-derived" };

  cache.set(name, { expiresAt: now() + ttlMs, result });
  return result;
}
