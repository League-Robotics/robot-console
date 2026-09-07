/**
 * releases.ts — resolve a configured firmware source to a GitHub
 * release, fetch and sha256-verify its hex, and expose a
 * periodically-polled availability signal.
 *
 * Per `docs/design/specification.md` §2.1 and §4.6: GitHub release
 * assets send no `Access-Control-Allow-Origin` header (verified,
 * including on the redirect target the initial asset URL 302s to), so
 * the browser cannot fetch them at all. Every GitHub HTTP call in this
 * codebase -- release lookup, asset download, and (via
 * {@link FirmwareAvailabilityCache}) the periodic recheck -- lives in
 * this module and this module alone, the same way `swdName.ts` is the
 * sole owner of the SWD transport it wraps. This is a hard boundary
 * dictated by the missing CORS header, not a convenience: nothing here
 * may be "simplified" by moving a fetch to the browser.
 *
 * ## Failure is a value, not an exception
 *
 * Following `swdName.ts`'s convention (see its own module doc):
 * {@link resolveRelease}, {@link fetchAndVerifyHex}, and
 * {@link checkAvailability} always resolve, never reject. A 404, a
 * network error, a missing asset, and a sha256 mismatch are all
 * ordinary return values, not thrown errors -- so `deviceRegistry.ts`
 * (ticket 005) can report a precise reason to a student rather than an
 * uncaught exception, and so `FirmwareAvailabilityCache`'s poll loop
 * never dies because one repo happens to have zero releases today.
 *
 * ## Availability is polled, not checked once
 *
 * `pxt-nezha-diffdrive` (the robot firmware repo) has published zero
 * GitHub releases as of this writing -- a verified, expected, entirely
 * normal state, not an error condition. `GET
 * /repos/.../releases/latest` simply 404s. The robot-firmware flash
 * button must go from disabled to enabled the moment that repo cuts
 * its first release, with **no code change and no host restart** --
 * see `sprint.md`'s Design Rationale. A one-shot check at server
 * startup could never do that; {@link FirmwareAvailabilityCache}
 * re-runs the check on an interval instead, mirroring `devices.ts`'s
 * `DeviceWatcher` shape exactly (`current()`, `onChange()`,
 * `start()`/`stop()`, a directly-callable `pollOnce()` for
 * deterministic tests) so `server.ts` composes it the same way it
 * already composes `DeviceWatcher`.
 *
 * ## Injectable `fetch`
 *
 * Every exported function takes an injectable `fetch`-shaped function
 * (default: the real global `fetch`), the same "swap the transport for
 * a fixture" pattern `UsbSerialLink` uses for its injected fake serial
 * port and `swdName.ts` uses for its injected `CortexMFactory`. No test
 * in this module's test file makes a real network call.
 */

import { createHash } from "node:crypto";
import type { FirmwareConfigMap, FirmwareSource } from "./config.js";
import type { FirmwareAvailability, FirmwareKind } from "./wsMessages.js";

/** GitHub's REST API base. Not itself injectable -- tests inject
 * `fetch` and assert against fixture responses keyed by whatever URL
 * this module builds, rather than pointing at a different base. */
const GITHUB_API_BASE = "https://api.github.com";

/** GitHub's REST API requires a `User-Agent` header on every request
 * (unauthenticated or not); `Accept` pins the response media type this
 * module parses against. */
const GITHUB_REQUEST_HEADERS: Record<string, string> = {
  Accept: "application/vnd.github+json",
  "User-Agent": "robot-console",
};

/** The two GitHub asset names this module looks for on every release,
 * matched case-insensitively against each asset's `name` field. */
const HEX_ASSET_NAME = "microbit.hex";
const MANIFEST_ASSET_NAME = "microbit.hex.txt";

/**
 * Minimal shape this module needs from a `fetch` response -- narrower
 * than the full DOM `Response` type, so a test fixture only needs to
 * implement these four members rather than a real `Response` (which a
 * global `fetch` call already structurally satisfies).
 */
export interface ReleasesFetchResponse {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
}

/** Function shape used for every HTTP call in this module. Defaults to
 * the real global `fetch`; tests inject a fixture-backed fake instead. */
export type FetchFn = (
  url: string,
  init?: { headers?: Record<string, string> },
) => Promise<ReleasesFetchResponse>;

async function defaultFetch(
  url: string,
  init?: { headers?: Record<string, string> },
): Promise<ReleasesFetchResponse> {
  return fetch(url, init);
}

/** Common shape shared by every exported function's options bag. */
export interface ReleasesOptions {
  /** Injectable HTTP layer. Defaults to the real global `fetch`. */
  fetch?: FetchFn;
}

/** A `FirmwareSource.repoUrl` resolved to a release, with both asset
 * download URLs identified. `tag` is the *concrete* tag GitHub
 * resolved to -- identical to the requested tag except when the
 * requested tag was `"latest"`, in which case this is the actual
 * release tag name (e.g. `v0.20260831.1`). */
export interface ResolvedRelease {
  tag: string;
  hexUrl: string;
  manifestUrl: string;
}

/**
 * `resolveRelease` (and the availability poll built on it) failed for
 * one of four distinguishable reasons:
 *   - `"no-releases"` — the repo has published no releases at all (the
 *     verified, expected `pxt-nezha-diffdrive` state today).
 *   - `"tag-not-found"` — the repo has releases, but not the specific
 *     configured tag.
 *   - `"no-asset"` — the resolved release exists but is missing
 *     `MICROBIT.hex` or `MICROBIT.hex.txt`.
 *   - `"network"` — the request failed, returned a non-404 error
 *     status, or returned a body this module could not parse.
 */
export interface ReleaseError {
  reason: "no-releases" | "tag-not-found" | "no-asset" | "network";
  message: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Parse a `FirmwareSource.repoUrl` (a plain `https://github.com/<owner>/
 * <repo>` URL -- see `config.ts`) into its owner/repo pair. Never
 * throws: a URL that isn't a well-formed `owner/repo` GitHub path
 * yields `undefined` rather than a partially-wrong guess.
 */
function parseGithubRepoUrl(repoUrl: string): { owner: string; repo: string } | undefined {
  let parsed: URL;
  try {
    parsed = new URL(repoUrl);
  } catch {
    return undefined;
  }
  const segments = parsed.pathname.split("/").filter((segment) => segment.length > 0);
  if (segments.length < 2) {
    return undefined;
  }
  const [owner, rawRepo] = segments;
  if (!owner || !rawRepo) {
    return undefined;
  }
  const repo = rawRepo.replace(/\.git$/i, "");
  if (!repo) {
    return undefined;
  }
  return { owner, repo };
}

interface ParsedGithubAsset {
  name: string;
  downloadUrl: string;
}

interface ParsedGithubRelease {
  tagName: string;
  assets: ParsedGithubAsset[];
}

/**
 * Narrow an arbitrary parsed-JSON body down to the two fields this
 * module needs (`tag_name`, `assets[].name`/`browser_download_url`).
 * Mirrors `wsMessages.ts`'s `parseClientMessage` convention of never
 * trusting an external payload's shape -- this is the one place a
 * GitHub API response is trusted from.
 */
function parseGithubReleaseBody(body: unknown): ParsedGithubRelease | undefined {
  if (typeof body !== "object" || body === null) {
    return undefined;
  }
  const record = body as Record<string, unknown>;
  if (typeof record.tag_name !== "string" || !Array.isArray(record.assets)) {
    return undefined;
  }
  const assets: ParsedGithubAsset[] = [];
  for (const rawAsset of record.assets) {
    if (typeof rawAsset !== "object" || rawAsset === null) {
      continue;
    }
    const assetRecord = rawAsset as Record<string, unknown>;
    if (
      typeof assetRecord.name === "string" &&
      typeof assetRecord.browser_download_url === "string"
    ) {
      assets.push({ name: assetRecord.name, downloadUrl: assetRecord.browser_download_url });
    }
  }
  return { tagName: record.tag_name, assets };
}

/**
 * Resolve a {@link FirmwareSource} to a GitHub release and identify its
 * `MICROBIT.hex` / `MICROBIT.hex.txt` asset URLs.
 *
 * Uses `GET /repos/{owner}/{repo}/releases/latest` when `source.tag ===
 * "latest"`, and `GET /repos/{owner}/{repo}/releases/tags/{tag}`
 * otherwise. A 404 from either is the normal "nothing to flash yet"
 * signal, distinguished into `"no-releases"` (the `latest` case -- the
 * repo has published nothing at all, the verified
 * `pxt-nezha-diffdrive` state today) versus `"tag-not-found"` (a
 * specific pinned tag that does not exist, while the repo may well have
 * other releases). Never throws -- every failure mode is a returned
 * {@link ReleaseError}.
 */
export async function resolveRelease(
  source: FirmwareSource,
  options?: ReleasesOptions,
): Promise<ResolvedRelease | ReleaseError> {
  const fetchFn = options?.fetch ?? defaultFetch;

  const parsedRepo = parseGithubRepoUrl(source.repoUrl);
  if (!parsedRepo) {
    return { reason: "network", message: `could not parse an owner/repo from repoUrl: ${source.repoUrl}` };
  }
  const { owner, repo } = parsedRepo;
  const isLatest = source.tag === "latest";
  const url = isLatest
    ? `${GITHUB_API_BASE}/repos/${owner}/${repo}/releases/latest`
    : `${GITHUB_API_BASE}/repos/${owner}/${repo}/releases/tags/${encodeURIComponent(source.tag)}`;

  let response: ReleasesFetchResponse;
  try {
    response = await fetchFn(url, { headers: GITHUB_REQUEST_HEADERS });
  } catch (error) {
    return { reason: "network", message: `request to ${url} failed: ${errorMessage(error)}` };
  }

  if (response.status === 404) {
    return isLatest
      ? { reason: "no-releases", message: `${owner}/${repo} has published no releases` }
      : { reason: "tag-not-found", message: `${owner}/${repo} has no release tagged "${source.tag}"` };
  }
  if (!response.ok) {
    return { reason: "network", message: `GitHub API returned HTTP ${response.status} for ${url}` };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    return { reason: "network", message: `could not parse GitHub API response as JSON: ${errorMessage(error)}` };
  }

  const release = parseGithubReleaseBody(body);
  if (!release) {
    return { reason: "network", message: `malformed GitHub release response from ${url}` };
  }

  const hexAsset = release.assets.find((asset) => asset.name.toLowerCase() === HEX_ASSET_NAME);
  const manifestAsset = release.assets.find(
    (asset) => asset.name.toLowerCase() === MANIFEST_ASSET_NAME,
  );
  if (!hexAsset || !manifestAsset) {
    return {
      reason: "no-asset",
      message: `release ${release.tagName} is missing ${hexAsset ? "" : "MICROBIT.hex"}${
        !hexAsset && !manifestAsset ? " and " : ""
      }${manifestAsset ? "" : "MICROBIT.hex.txt"}`,
    };
  }

  return { tag: release.tagName, hexUrl: hexAsset.downloadUrl, manifestUrl: manifestAsset.downloadUrl };
}

/**
 * Extract a sha256 hex digest from a `MICROBIT.hex.txt` manifest's
 * text. Matched leniently -- a case-insensitive `sha256` key, optionally
 * followed by `:` or `=` and whitespace, then exactly 64 hex characters
 * -- rather than one hardcoded exact key string/casing, since the
 * manifest's exact format is not independently verified (see
 * `sprint.md`'s Step 7 open question). Returns `undefined` if no such
 * line is found.
 */
function extractManifestSha256(manifestText: string): string | undefined {
  const match = /sha[-_]?256\s*[:=]\s*([0-9a-f]{64})/i.exec(manifestText);
  const digest = match?.[1];
  return digest ? digest.toLowerCase() : undefined;
}

/**
 * Download a resolved release's `MICROBIT.hex` and `MICROBIT.hex.txt`,
 * and verify the downloaded hex's sha256 against the manifest's
 * declared value before ever returning it. A mismatch -- or any
 * download/parse failure along the way -- comes back as `{ error }`;
 * the hex is never returned as if it were valid in that case. Never
 * throws.
 */
export async function fetchAndVerifyHex(
  resolved: ResolvedRelease,
  options?: ReleasesOptions,
): Promise<{ hex: Buffer } | { error: string }> {
  const fetchFn = options?.fetch ?? defaultFetch;

  let hexResponse: ReleasesFetchResponse;
  try {
    hexResponse = await fetchFn(resolved.hexUrl);
  } catch (error) {
    return { error: `failed to download ${resolved.hexUrl}: ${errorMessage(error)}` };
  }
  if (!hexResponse.ok) {
    return { error: `failed to download ${resolved.hexUrl}: HTTP ${hexResponse.status}` };
  }

  let manifestResponse: ReleasesFetchResponse;
  try {
    manifestResponse = await fetchFn(resolved.manifestUrl);
  } catch (error) {
    return { error: `failed to download ${resolved.manifestUrl}: ${errorMessage(error)}` };
  }
  if (!manifestResponse.ok) {
    return { error: `failed to download ${resolved.manifestUrl}: HTTP ${manifestResponse.status}` };
  }

  let hexBytes: Buffer;
  try {
    hexBytes = Buffer.from(await hexResponse.arrayBuffer());
  } catch (error) {
    return { error: `could not read downloaded hex bytes: ${errorMessage(error)}` };
  }

  let manifestText: string;
  try {
    manifestText = await manifestResponse.text();
  } catch (error) {
    return { error: `could not read manifest text: ${errorMessage(error)}` };
  }

  const expectedSha256 = extractManifestSha256(manifestText);
  if (!expectedSha256) {
    return { error: `manifest at ${resolved.manifestUrl} did not contain a recognizable sha256 line` };
  }

  const actualSha256 = createHash("sha256").update(hexBytes).digest("hex");
  if (actualSha256 !== expectedSha256) {
    return {
      error: `sha256 mismatch for ${resolved.hexUrl}: manifest says ${expectedSha256}, downloaded bytes hash to ${actualSha256}`,
    };
  }

  return { hex: hexBytes };
}

/**
 * `resolveRelease` narrowed to a boolean: `true` iff a release with
 * both required assets exists for `source`. Used as the default
 * per-poll check inside {@link FirmwareAvailabilityCache}, and
 * available standalone for any caller that only needs a yes/no answer.
 * Never throws.
 */
export async function checkAvailability(
  source: FirmwareSource,
  options?: ReleasesOptions,
): Promise<boolean> {
  const result = await resolveRelease(source, options);
  return !("reason" in result);
}

/** Ordered list of every {@link FirmwareKind}, for iterating a
 * {@link FirmwareConfigMap}/status map without relying on object key
 * enumeration order. */
const FIRMWARE_KINDS: readonly FirmwareKind[] = ["relay", "robot"];

/** Full per-firmware availability snapshot, as `server.ts` merges into
 * every `DevicesMessage.firmwareStatus`. */
export type FirmwareStatusMap = Record<FirmwareKind, FirmwareAvailability>;

export type FirmwareAvailabilityListener = (current: FirmwareStatusMap) => void;

/**
 * Availability check result richer than {@link checkAvailability}'s
 * plain boolean: `reason` carries the specific {@link ReleaseError}
 * reason (e.g. `"no-releases"`) so {@link FirmwareAvailabilityCache}
 * can populate `FirmwareAvailability.reason` for the UI, rather than
 * only ever reporting an unexplained `false`.
 */
export type FirmwareAvailabilityChecker = (
  source: FirmwareSource,
) => Promise<{ available: boolean; reason?: string }>;

/** Default {@link FirmwareAvailabilityChecker}: resolves a release with
 * the real global `fetch` and maps a {@link ReleaseError}'s `reason`
 * straight through -- these are already exactly the short, stable
 * tokens (`"no-releases"`, `"tag-not-found"`, `"no-asset"`,
 * `"network"`) `wsMessages.ts`'s `FirmwareAvailability.reason` expects. */
async function defaultAvailabilityChecker(
  source: FirmwareSource,
): Promise<{ available: boolean; reason?: string }> {
  const result = await resolveRelease(source);
  return "reason" in result ? { available: false, reason: result.reason } : { available: true };
}

export interface FirmwareAvailabilityCacheOptions {
  /** Poll interval in ms when {@link FirmwareAvailabilityCache.start} is
   * used. Defaults to {@link DEFAULT_AVAILABILITY_POLL_INTERVAL_MS}.
   * Irrelevant if callers drive
   * {@link FirmwareAvailabilityCache.pollOnce} themselves. */
  pollIntervalMs?: number;
  /** How to check one configured source's availability. Defaults to
   * {@link defaultAvailabilityChecker} (real GitHub, real `fetch`).
   * Tests inject a fixture-backed fake so `pollOnce()` can be driven
   * deterministically with no network call. */
  checkAvailability?: FirmwareAvailabilityChecker;
  /** Re-read the firmware configuration at the start of every
   * {@link FirmwareAvailabilityCache.pollOnce}. Supply
   * `() => getFirmwareConfig()` (as `server.ts` does) so a `.env` that
   * appears or changes *after* the host started is picked up within one
   * poll interval instead of never -- the constructor's `config`
   * argument is only ever a starting snapshot.
   *
   * Opt-in rather than defaulted: a cache constructed with an explicit
   * config map (every test, and any caller wiring its own sources)
   * must keep using exactly that map, not silently reach out to the
   * real repo-root `.env` behind the caller's back. */
  loadConfig?: () => FirmwareConfigMap;
}

/**
 * Availability poll interval: a few minutes. This is an implementation
 * default, not a stakeholder-specified value (see `sprint.md`'s Step 7
 * open question) -- picked to be frequent enough that a newly-cut
 * `pxt-nezha-diffdrive` release shows up within one class period
 * without a host restart, while never hammering GitHub's unauthenticated
 * rate limit (60 requests/hour/IP) with two firmware kinds polled
 * indefinitely.
 */
export const DEFAULT_AVAILABILITY_POLL_INTERVAL_MS = 5 * 60 * 1000;

/** `reason` used for a configured-but-not-yet-polled entry, before
 * {@link FirmwareAvailabilityCache.pollOnce} has run for the first
 * time. Distinct from any {@link ReleaseError} reason so the UI (or a
 * test) can tell "never checked yet" apart from "checked and
 * unavailable". */
const NOT_YET_CHECKED_REASON = "not-yet-checked";

function initialStatus(config: FirmwareConfigMap): FirmwareStatusMap {
  const status = {} as FirmwareStatusMap;
  for (const kind of FIRMWARE_KINDS) {
    const source = config[kind];
    status[kind] =
      source === undefined
        ? { configured: false }
        : {
            configured: true,
            repoUrl: source.repoUrl,
            tag: source.tag,
            available: false,
            reason: NOT_YET_CHECKED_REASON,
          };
  }
  return status;
}

/**
 * Live poller over {@link checkAvailability}: re-checks every
 * configured {@link FirmwareSource} on an interval and notifies
 * listeners when the resulting {@link FirmwareStatusMap} changes. This
 * is what lets the robot-firmware flash button go from disabled to
 * enabled the moment `pxt-nezha-diffdrive` cuts its first release, with
 * no code change and no host restart (`sprint.md`'s Design Rationale).
 *
 * Deliberately mirrors `devices.ts`'s `DeviceWatcher` shape: `current()`
 * for the latest snapshot, `onChange()` to subscribe, `start()`/`stop()`
 * for the real interval timer (`unref`'d so it never keeps the process
 * alive on its own), and a directly-callable `pollOnce()` so tests can
 * drive the check deterministically without depending on real timers.
 */
export class FirmwareAvailabilityCache {
  private config: FirmwareConfigMap;
  private readonly pollIntervalMs: number;
  private readonly checkAvailabilityFn: FirmwareAvailabilityChecker;
  private readonly loadConfigFn: (() => FirmwareConfigMap) | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly listeners = new Set<FirmwareAvailabilityListener>();
  private status: FirmwareStatusMap;

  constructor(config: FirmwareConfigMap, options: FirmwareAvailabilityCacheOptions = {}) {
    this.config = config;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_AVAILABILITY_POLL_INTERVAL_MS;
    this.checkAvailabilityFn = options.checkAvailability ?? defaultAvailabilityChecker;
    this.loadConfigFn = options.loadConfig;
    this.status = initialStatus(config);
  }

  /** Availability as of the most recent poll (a conservative
   * "not yet checked" / unavailable placeholder before the first
   * {@link pollOnce}). */
  current(): FirmwareStatusMap {
    return this.status;
  }

  /** Subscribe to change events. Returns an unsubscribe function. */
  onChange(listener: FirmwareAvailabilityListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Run one poll immediately: re-read configuration (if `loadConfig`
   * was supplied), re-check every configured firmware source, update
   * the snapshot, and notify listeners only if the result actually
   * changed. Returns the latest snapshot either way so callers/tests
   * can inspect it without a listener.
   */
  async pollOnce(): Promise<FirmwareStatusMap> {
    // Re-read configuration first, when the caller opted into it: a
    // source that was unconfigured at startup (no `.env` yet) or has
    // been repointed at a different tag since must take effect here,
    // otherwise it never would. See `loadConfig`'s own doc.
    if (this.loadConfigFn !== undefined) {
      this.config = this.loadConfigFn();
    }
    const next = {} as FirmwareStatusMap;
    for (const kind of FIRMWARE_KINDS) {
      const source = this.config[kind];
      if (source === undefined) {
        next[kind] = { configured: false };
        continue;
      }
      const { available, reason } = await this.checkAvailabilityFn(source);
      next[kind] = available
        ? { configured: true, repoUrl: source.repoUrl, tag: source.tag, available: true }
        : {
            configured: true,
            repoUrl: source.repoUrl,
            tag: source.tag,
            available: false,
            ...(reason !== undefined ? { reason } : {}),
          };
    }

    const changed = JSON.stringify(next) !== JSON.stringify(this.status);
    this.status = next;
    if (changed) {
      for (const listener of this.listeners) {
        listener(this.status);
      }
    }
    return this.status;
  }

  /** Start polling on `pollIntervalMs`. No-op if already started. */
  start(): void {
    if (this.timer) {
      return;
    }
    this.timer = setInterval(() => {
      void this.pollOnce();
    }, this.pollIntervalMs);
    // Don't let the poll timer keep the process alive on its own.
    this.timer.unref?.();
  }

  /** Stop polling. No-op if not started. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}
