/**
 * firmwareWatcher.ts — replaces the retired `FirmwareAvailabilityCache`
 * with a proper task: poll each firmware kind's GitHub release with
 * `If-None-Match`, honour `Retry-After`/back off exponentially on
 * `403`/`429`, bound every fetch with a 10s `AbortSignal` timeout, and
 * write the result to the `firmware` table only when it changes
 * (sprint 017 ticket 002; issue
 * `rearch-13-firmware-availability-watcher-etag-backoff.md`;
 * `docs/design/architecture.md` §6.4).
 *
 * ## Why this exists
 *
 * Through sprint 016, `FirmwareAvailabilityCache` (`releases.ts`)
 * polled unauthenticated, on a fixed interval, with no `ETag` and no
 * backoff on a rate-limit response. A classroom of hosts behind one
 * shared NAT shares GitHub's 60 req/hr/IP limit; 30 students polling
 * two firmware kinds every 5 minutes can exceed that within an hour,
 * and every host then reports `reason: "network"` and disables both
 * flash buttons. This module fixes that at the root: a conditional
 * `If-None-Match` request that gets back a `304` costs nothing against
 * the rate limit (GitHub's own documented behavior), and a `403`/`429`
 * response schedules the *next* poll no earlier than `Retry-After` (or
 * an exponential backoff, capped at 1 hour) instead of hammering again
 * on the next fixed tick.
 *
 * ## Verbatim reuse of `releases.ts`
 *
 * `resolveRelease` (and, through it, `parseGithubReleaseBody`/
 * `extractManifestSha256`) is reused unmodified for the actual
 * release-resolution logic -- this module's own job is entirely the
 * scheduling/conditional-GET/header wrapper *around* that call.
 * `resolveRelease`'s own {@link ReleasesFetchResponse} is deliberately
 * narrow (no `headers` accessor -- it never needed one), so this module
 * captures the response's `status`/`etag`/`retry-after` via a small
 * side-channel object mutated by its own fetch wrapper as a side effect
 * of the single call `resolveRelease` makes, rather than widening that
 * type or duplicating `resolveRelease`'s own HTTP/parsing logic.
 *
 * A `304` is detected this way *before* `resolveRelease` ever gets to
 * decide what it means (a non-404, non-ok status falls straight into
 * its own generic `{reason: "network"}` branch without ever calling
 * `.json()` -- satisfying "a 304 parses no response body" for free):
 * this module simply skips the store write for that poll, exactly
 * mirroring the "leaves the row untouched" requirement. Same for
 * `403`/`429`: detected via the captured status, backoff computed from
 * `Retry-After` or the running exponential backoff, and -- to guarantee
 * that a rate-limited burst never flips every host's row to
 * `reason: "network"` (the exact failure mode this ticket exists to
 * prevent) -- no store write happens for that poll either. Only a
 * genuine answer (a fresh `200`, a real `404`, or an actual network
 * failure/timeout) ever reaches the `firmware` table.
 *
 * ## Per-kind independent scheduling
 *
 * `relay` and `robot` are polled on independent self-rescheduling
 * timers (each poll schedules its own next one via `setTimeout`, not a
 * shared `setInterval`), since a `403`/`429` backoff on one kind must
 * never delay the other.
 *
 * ## `GITHUB_TOKEN`: env first, then `settings`, never logged
 *
 * Resolved once at {@link startFirmwareWatcher} construction (matching
 * the sprint's own "no hot-reload short of a restart" simplification --
 * `sprint.md`'s Migration Concerns): `deps.env.GITHUB_TOKEN` wins over
 * the `settings` key {@link GITHUB_TOKEN_SETTINGS_KEY}, matching
 * `store/importers/firmwareConfig.ts`'s own env-over-file precedence
 * (`sprint.md`'s Open Question 2). Sent as `Authorization: Bearer
 * <token>` only on the GitHub API request this module itself makes --
 * never placed in any `firmware.message`/`reason` value, notice, or log
 * line anywhere in this module.
 *
 * ## Injectable seams
 *
 * `deps.fetch` (default: the real global `fetch`), `deps.now` (default:
 * `Date.now`), and `deps.env` (default: `process.env`) are the only
 * seams this module needs -- mirroring `usbWatcher.ts`/`mdnsWatcher.ts`'s
 * own "enumerator/namer/clock" injection convention. No test in this
 * module's own suite makes a real network call or waits on a real
 * timer past a millisecond.
 */
import type { Store } from "../store/index.js";
import { getFirmwareConfig, type FirmwareConfigMap, type FirmwareSource } from "../config.js";
import { resolveRelease, type ReleasesFetchResponse, type ReleaseError, type ResolvedRelease } from "../releases.js";
import type { FirmwareKind } from "../wsMessages.js";

/** `tasks.name` this watcher heartbeats after every per-kind poll
 * attempt (architecture.md §3 rule 5). */
const TASK_NAME = "firmwareWatcher";

/** Ordered list of every {@link FirmwareKind}, for iterating a
 * {@link FirmwareConfigMap} without relying on object key enumeration
 * order -- same convention `releases.ts`'s retired cache used. */
const FIRMWARE_KINDS: readonly FirmwareKind[] = ["relay", "robot"];

/** Healthy-path poll interval: re-checked on every `304`/`200`. Not a
 * stakeholder-specified value (`sprint.md`'s Step 7 open question) --
 * frequent enough that a newly-cut release shows up within one class
 * period, infrequent enough that two firmware kinds polled
 * indefinitely stay well inside GitHub's unauthenticated rate limit
 * even with no conditional-GET savings at all. */
export const DEFAULT_POLL_INTERVAL_MS = 5 * 60 * 1000;

/** Every GitHub fetch this module makes is bounded by this timeout
 * (SUC-002 AC). */
export const DEFAULT_FETCH_TIMEOUT_MS = 10_000;

/** Exponential backoff on repeated `403`/`429` never exceeds this,
 * whether or not the response carries `Retry-After` (SUC-002 AC). */
export const DEFAULT_MAX_BACKOFF_MS = 60 * 60 * 1000;

/** `settings.key` an optional `GITHUB_TOKEN` may be stored under when
 * not set as an environment variable -- mirrors
 * `config.ts`'s `SETTINGS_KEY_BY_FIRMWARE` naming convention. Env always
 * wins (module doc comment). */
export const GITHUB_TOKEN_SETTINGS_KEY = "github.token";

/** {@link ReleasesFetchResponse} widened with an optional `headers`
 * reader -- the real global `fetch`'s `Response` already has one; this
 * module's own fetch wrapper uses it to capture `etag`/`retry-after`
 * without changing `releases.ts`'s own narrower public type (module doc
 * comment's "Verbatim reuse" section). Optional so a test fixture that
 * doesn't care about headers (most of `releases.test.ts`'s own
 * fixtures) still satisfies it. */
export interface FirmwareHttpResponse extends ReleasesFetchResponse {
  headers?: { get(name: string): string | null };
}

/** This module's own fetch shape -- a {@link ReleasesFetchResponse}-
 * returning function (so it is assignable wherever `releases.ts`'s
 * narrower `FetchFn` is expected) whose `init` also accepts an
 * `AbortSignal`, which `releases.ts`'s own `FetchFn` has no need of. */
export type FirmwareFetchFn = (
  url: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<FirmwareHttpResponse>;

async function defaultFetch(
  url: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal },
): Promise<FirmwareHttpResponse> {
  return fetch(url, init) as unknown as Promise<FirmwareHttpResponse>;
}

export interface FirmwareWatcherDeps {
  /** Injectable HTTP layer. Defaults to the real global `fetch`. Tests
   * substitute a fixture-backed fake -- never a real network call. */
  fetch?: FirmwareFetchFn;
  /** Wall-clock reader for every store timestamp. Defaults to
   * `Date.now`. */
  now?: () => number;
  /** Environment `GITHUB_TOKEN` is read from. Defaults to
   * `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Firmware source configuration. Defaults to a real
   * {@link getFirmwareConfig} call against `store` -- read once at
   * construction, matching `sprint.md`'s own "no hot-reload short of a
   * restart" simplification (Migration Concerns). Tests supply an
   * explicit map instead of seeding `settings`. */
  config?: FirmwareConfigMap;
}

export interface FirmwareWatcherOptions {
  /** Healthy-path poll interval in ms. Defaults to
   * {@link DEFAULT_POLL_INTERVAL_MS}. */
  pollIntervalMs?: number;
  /** Per-fetch `AbortSignal` timeout in ms. Defaults to
   * {@link DEFAULT_FETCH_TIMEOUT_MS}. */
  fetchTimeoutMs?: number;
  /** Backoff cap in ms. Defaults to {@link DEFAULT_MAX_BACKOFF_MS}. */
  maxBackoffMs?: number;
}

export interface FirmwareWatcherHandle {
  /** Stop every per-kind scheduled poll. Idempotent. */
  stop(): void;
}

/** Parses a `Retry-After` header value: either an integer count of
 * seconds, or an HTTP-date (RFC 7231) -- converted to a seconds-from-now
 * delta via `now`. Returns `undefined` for anything else, never
 * throws. */
function parseRetryAfterSeconds(raw: string | null | undefined, now: () => number): number | undefined {
  if (raw === null || raw === undefined) {
    return undefined;
  }
  const trimmed = raw.trim();
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number.parseInt(trimmed, 10);
    return seconds >= 0 ? seconds : undefined;
  }
  const dateMs = Date.parse(trimmed);
  if (Number.isNaN(dateMs)) {
    return undefined;
  }
  return Math.max(0, Math.round((dateMs - now()) / 1000));
}

/** `deps.env.GITHUB_TOKEN` wins; otherwise the `settings` row at
 * {@link GITHUB_TOKEN_SETTINGS_KEY}; otherwise `undefined`. Never
 * throws, never logs. */
function resolveGithubToken(env: NodeJS.ProcessEnv, store: Store): string | undefined {
  const fromEnv = env.GITHUB_TOKEN;
  if (fromEnv !== undefined && fromEnv.trim().length > 0) {
    return fromEnv;
  }
  const fromSettings = store.getSetting(GITHUB_TOKEN_SETTINGS_KEY);
  return fromSettings !== undefined && fromSettings.trim().length > 0 ? fromSettings : undefined;
}

/** Bounds `fetchFn` to `timeoutMs`: on timeout, aborts the in-flight
 * request via `AbortController` -- `resolveRelease`'s own `catch`
 * reports the resulting rejection as `{reason: "network", message}`
 * (never throwing past this module, `releases.ts`'s own "failure is a
 * value" contract, unchanged). */
function withTimeout(fetchFn: FirmwareFetchFn, timeoutMs: number): FirmwareFetchFn {
  return async (url, init) => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort(new Error(`request to ${url} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    try {
      return await fetchFn(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  };
}

/** What this module needs out of one HTTP exchange that
 * {@link ReleasesFetchResponse} doesn't expose -- populated as a side
 * effect of the single fetch call `resolveRelease` makes (module doc
 * comment's "Verbatim reuse" section). `status`/`etag`/`retryAfterSeconds`
 * stay `undefined` when the underlying `fetchFn` itself rejects (a real
 * network failure or this module's own timeout abort) -- exactly the
 * case that must fall through to a `reason: "network"` write. */
interface CapturedResponse {
  status?: number | undefined;
  etag?: string | undefined;
  retryAfterSeconds?: number | undefined;
}

/** Adds `If-None-Match`/`Authorization` to every request `fetchFn`
 * makes and records the response's `status`/`etag`/`retry-after` into
 * `capture`. */
function withGithubHeadersAndCapture(
  fetchFn: FirmwareFetchFn,
  headers: Record<string, string>,
  capture: CapturedResponse,
  now: () => number,
): FirmwareFetchFn {
  return async (url, init) => {
    const response = await fetchFn(url, { ...init, headers: { ...init?.headers, ...headers } });
    capture.status = response.status;
    capture.etag = response.headers?.get("etag") ?? undefined;
    capture.retryAfterSeconds = parseRetryAfterSeconds(response.headers?.get("retry-after") ?? null, now);
    return response;
  };
}

/** Fields of one `firmware` row this module ever writes, compared
 * (excluding `etag`/`checkedAt`, which change on every poll regardless
 * of whether anything user-visible did) to decide whether a write is
 * actually a change -- belt-and-suspenders alongside the `304`/backoff
 * short-circuits above, for the one case neither covers: a repeated,
 * un-cached `404` (`no-releases`/`tag-not-found`), which carries no
 * `ETag` to conditionally-GET against. */
interface WrittenFields {
  repo: string | null;
  tag: string | null;
  available: boolean | null;
  reason: string | null;
  message: string | null;
}

function dedupeKey(fields: WrittenFields): string {
  return JSON.stringify(fields);
}

interface KindSchedule {
  timer: ReturnType<typeof setTimeout> | undefined;
  backoffMs: number;
  lastWritten: string | undefined;
}

/**
 * Start the firmware availability watcher against `store`. See the
 * module doc comment for the per-poll flow. Returns a handle whose
 * `stop()` tears everything down -- there is no other way to stop this
 * task (architecture.md §3 rule 5).
 */
export function startFirmwareWatcher(
  store: Store,
  deps: FirmwareWatcherDeps = {},
  opts: FirmwareWatcherOptions = {},
): FirmwareWatcherHandle {
  const fetchFn = deps.fetch ?? defaultFetch;
  const now = deps.now ?? (() => Date.now());
  const env = deps.env ?? process.env;
  const config = deps.config ?? getFirmwareConfig(store);

  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const fetchTimeoutMs = opts.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const maxBackoffMs = opts.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;

  // Resolved once, matching `config`'s own "no hot-reload short of a
  // restart" simplification (module doc comment).
  const githubToken = resolveGithubToken(env, store);

  let stopped = false;
  const schedules = new Map<FirmwareKind, KindSchedule>(
    FIRMWARE_KINDS.map((kind) => [kind, { timer: undefined, backoffMs: pollIntervalMs, lastWritten: undefined }]),
  );

  function scheduleNext(kind: FirmwareKind, delayMs: number): void {
    if (stopped) {
      return;
    }
    const schedule = schedules.get(kind);
    if (!schedule) {
      return;
    }
    schedule.timer = setTimeout(() => {
      void pollKind(kind);
    }, delayMs);
    schedule.timer.unref?.();
  }

  function writeIfChanged(kind: FirmwareKind, schedule: KindSchedule, fields: WrittenFields, etag: string | undefined): void {
    const key = dedupeKey(fields);
    if (schedule.lastWritten === key) {
      return;
    }
    schedule.lastWritten = key;
    store.setFirmware({
      kind,
      repo: fields.repo,
      tag: fields.tag,
      available: fields.available,
      reason: fields.reason,
      message: fields.message,
      etag: etag ?? null,
      checkedAt: now(),
    });
  }

  async function pollKind(kind: FirmwareKind): Promise<void> {
    const schedule = schedules.get(kind);
    if (!schedule || stopped) {
      return;
    }
    const source: FirmwareSource | undefined = config[kind];

    if (source === undefined) {
      writeIfChanged(
        kind,
        schedule,
        { repo: null, tag: null, available: null, reason: null, message: null },
        undefined,
      );
      store.heartbeat(TASK_NAME, now());
      scheduleNext(kind, pollIntervalMs);
      return;
    }

    const capture: CapturedResponse = {};
    const headers: Record<string, string> = {};
    const storedEtag = store.getFirmwareEtag(kind);
    if (storedEtag !== undefined) {
      headers["If-None-Match"] = storedEtag;
    }
    if (githubToken !== undefined) {
      headers.Authorization = `Bearer ${githubToken}`;
    }

    const bounded = withTimeout(withGithubHeadersAndCapture(fetchFn, headers, capture, now), fetchTimeoutMs);

    let result: ResolvedRelease | ReleaseError;
    try {
      result = await resolveRelease(source, { fetch: bounded });
    } catch {
      // resolveRelease never throws (releases.ts's own "failure is a
      // value" contract) -- this catch exists only so a defect there
      // can never take this watcher's timer chain down with it.
      result = { reason: "network", message: "resolveRelease threw unexpectedly" };
    }

    if (stopped) {
      return;
    }

    if (capture.status === 304) {
      // Unchanged: leave the row untouched, and -- since resolveRelease
      // never reached `.json()` for this non-ok, non-404 status -- no
      // body was ever parsed either. Healthy path: reset backoff.
      schedule.backoffMs = pollIntervalMs;
      store.heartbeat(TASK_NAME, now());
      scheduleNext(kind, pollIntervalMs);
      return;
    }

    if (capture.status === 403 || capture.status === 429) {
      // Rate-limited: never overwrite the row with a failure here (the
      // exact "every host reports network, flash disables" failure mode
      // this watcher exists to prevent) -- only reschedule, further out.
      const backoffMs =
        capture.retryAfterSeconds !== undefined ? capture.retryAfterSeconds * 1000 : schedule.backoffMs * 2;
      schedule.backoffMs = Math.min(backoffMs, maxBackoffMs);
      store.heartbeat(TASK_NAME, now());
      scheduleNext(kind, schedule.backoffMs);
      return;
    }

    schedule.backoffMs = pollIntervalMs;
    const fields: WrittenFields =
      "reason" in result
        ? { repo: source.repoUrl, tag: source.tag, available: false, reason: result.reason, message: result.message }
        : { repo: source.repoUrl, tag: result.tag, available: true, reason: null, message: null };
    writeIfChanged(kind, schedule, fields, capture.etag);
    store.heartbeat(TASK_NAME, now());
    scheduleNext(kind, pollIntervalMs);
  }

  for (const kind of FIRMWARE_KINDS) {
    void pollKind(kind);
  }

  return {
    stop(): void {
      if (stopped) {
        return;
      }
      stopped = true;
      for (const schedule of schedules.values()) {
        if (schedule.timer) {
          clearTimeout(schedule.timer);
          schedule.timer = undefined;
        }
      }
    },
  };
}
