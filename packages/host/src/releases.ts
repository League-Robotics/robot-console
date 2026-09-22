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
 * `watchers/firmwareWatcher.ts`, sprint 017 ticket 002) the periodic
 * recheck -- lives in this module and this module alone, the same way
 * `swdName.ts` is the sole owner of the SWD transport it wraps. This is
 * a hard boundary dictated by the missing CORS header, not a
 * convenience: nothing here may be "simplified" by moving a fetch to
 * the browser.
 *
 * ## Failure is a value, not an exception
 *
 * Following `swdName.ts`'s convention (see its own module doc):
 * {@link resolveRelease}, {@link fetchAndVerifyHex}, and
 * {@link checkAvailability} always resolve, never reject. A 404, a
 * network error, a missing asset, and a sha256 mismatch are all
 * ordinary return values, not thrown errors -- so `deviceRegistry.ts`
 * (ticket 005) can report a precise reason to a student rather than an
 * uncaught exception, and so `watchers/firmwareWatcher.ts`'s poll loop
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
 * startup could never do that; `watchers/firmwareWatcher.ts` (sprint
 * 017 ticket 002, replacing the retired `FirmwareAvailabilityCache`)
 * re-runs the check on its own per-kind schedule instead, writing the
 * result straight to the `firmware` table.
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
import type { ReleaseFirmwareSource } from "./config.js";

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
  /** The `<hex>.txt` sha256 manifest beside the hex, when the release
   * publishes one. OPTIONAL as of 2026-09-21: see `resolveRelease`'s own
   * doc comment -- a release that ships a hex and no manifest is
   * flashable, unverified, rather than unflashable. */
  manifestUrl?: string;
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
 *
 * `message` is safe to forward to a browser client as-is (as
 * `wsMessages.ts`'s `FirmwareAvailability.message` now does,
 * out-of-process, 2026-09-08): every branch below builds it from public,
 * non-sensitive values already known to whoever configured the firmware
 * source -- the repo owner/repo/tag this codebase itself was told to
 * check, and (`"no-asset"`) the two fixed, public asset names this
 * module looks for. The one branch that touches a caught exception
 * (`"network"`, via {@link errorMessage}) only ever reads `error.message`
 * -- never `error.stack`, never the raw `error` object -- so a network
 * failure's `message` is a short description (e.g. `getaddrinfo ENOTFOUND
 * api.github.com`), not a stack trace. Nothing in this module puts a
 * secret, credential, or local file path into any `message`.
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
  source: ReleaseFirmwareSource,
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

  // Asset naming, widened 2026-09-21.
  //
  // This used to demand the exact pair `MICROBIT.hex` + `MICROBIT.hex.txt`
  // and reject everything else. `nezha-robot-template` and
  // `microbit-radio-relay` both publish that pair, so the rule was
  // invisible until the stakeholder pointed this console at
  // `League-Microbit/Remote-Joystick-Student`, which publishes
  // `remote-joystick-student.hex` (plus a versioned copy) and no
  // manifest at all. He supplied the repo URL and expected it to work;
  // being told "not set up for this classroom yet" because of a
  // filename is the console being precious about its own convention.
  //
  // Two names are accepted now, in priority order, and NOTHING is
  // guessed: `MICROBIT.hex` first (the existing convention, so the two
  // repos that follow it are unaffected), then `<repo>.hex` -- the
  // repository's own name, lowercased. That second rule is exact, not a
  // heuristic: it is derived from the URL already being fetched, so a
  // release carrying several `.hex` files (this one carries a versioned
  // one too) resolves deterministically to the stable, unversioned
  // artifact rather than to whichever happened to sort first.
  const repoHexName = `${repo.toLowerCase()}.hex`;
  const findAsset = (name: string) => release.assets.find((asset) => asset.name.toLowerCase() === name);
  const hexAsset = findAsset(HEX_ASSET_NAME) ?? findAsset(repoHexName);
  // The manifest is looked for beside whichever hex was chosen, and is
  // now OPTIONAL. It carries the sha256 the download is checked
  // against, so a release without one is flashed unverified -- a real
  // reduction in safety, and the honest trade against refusing to flash
  // a hex the maintainer clearly published on purpose. `downloadRelease`
  // below skips the checksum step when it is absent and says so.
  const manifestAsset = hexAsset === undefined ? undefined : findAsset(`${hexAsset.name.toLowerCase()}.txt`);
  if (!hexAsset) {
    // Sprint 017 ticket 002 / issue
    // `host-rejects-robot-template-release-asset-naming.md` step 3: name
    // the asset(s) actually found, not just which required name is
    // missing -- a maintainer staring at "release vX is missing
    // MICROBIT.hex" with no further clue has to go check GitHub by hand
    // to see the repo published `nezha-robot-template-vX.hex` instead.
    const foundNames = release.assets.map((asset) => `"${asset.name}"`);
    const foundText = foundNames.length > 0 ? `has ${foundNames.join(", ")}` : "has no assets";
    return {
      reason: "no-asset",
      message: `release ${release.tagName} ${foundText}; expected "MICROBIT.hex" or "${repoHexName}"`,
    };
  }

  return {
    tag: release.tagName,
    hexUrl: hexAsset.downloadUrl,
    ...(manifestAsset !== undefined ? { manifestUrl: manifestAsset.downloadUrl } : {}),
  };
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
 * Download a resolved release's hex and, when the release published one,
 * its sha256 manifest -- verifying the downloaded bytes against the
 * manifest's declared value before ever returning them. A mismatch, or
 * any download/parse failure along the way, comes back as `{ error }`;
 * the hex is never returned as if it were valid in that case. Never
 * throws.
 *
 * ## Unverified downloads (2026-09-21)
 *
 * `resolved.manifestUrl` is optional. A release that publishes a hex and
 * no `<hex>.txt` beside it is downloaded and returned WITHOUT a checksum
 * check -- there is nothing to check against. That is a genuine
 * reduction in safety and is not hidden: `resolveRelease`'s own comment
 * records why the alternative (refusing to flash a hex a maintainer
 * deliberately published, because of a missing sidecar file) was judged
 * worse. Both `nezha-robot-template` and `microbit-radio-relay` publish
 * manifests and are unaffected; `Remote-Joystick-Student` currently does
 * not, and adding one there restores verification with no change here.
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

  // No manifest published beside the hex (2026-09-21): download it and
  // skip the checksum. The alternative -- refusing a hex a maintainer
  // deliberately published because no `.txt` sits next to it -- is what
  // made a correctly-configured joystick firmware read as "not set up
  // for this classroom yet". A release WITH a manifest is still fully
  // verified below; nothing about that path is relaxed.
  const manifestUrl = resolved.manifestUrl;
  let manifestResponse: ReleasesFetchResponse | undefined;
  if (manifestUrl !== undefined) {
    try {
      manifestResponse = await fetchFn(manifestUrl);
    } catch (error) {
      return { error: `failed to download ${manifestUrl}: ${errorMessage(error)}` };
    }
    if (!manifestResponse.ok) {
      return { error: `failed to download ${manifestUrl}: HTTP ${manifestResponse.status}` };
    }
  }

  let hexBytes: Buffer;
  try {
    hexBytes = Buffer.from(await hexResponse.arrayBuffer());
  } catch (error) {
    return { error: `could not read downloaded hex bytes: ${errorMessage(error)}` };
  }

  if (manifestResponse !== undefined && manifestUrl !== undefined) {
    let manifestText: string;
    try {
      manifestText = await manifestResponse.text();
    } catch (error) {
      return { error: `could not read manifest text: ${errorMessage(error)}` };
    }

    const expectedSha256 = extractManifestSha256(manifestText);
    if (!expectedSha256) {
      return { error: `manifest at ${manifestUrl} did not contain a recognizable sha256 line` };
    }

    const actualSha256 = createHash("sha256").update(hexBytes).digest("hex");
    if (actualSha256 !== expectedSha256) {
      return {
        error: `sha256 mismatch for ${resolved.hexUrl}: manifest says ${expectedSha256}, downloaded bytes hash to ${actualSha256}`,
      };
    }
  }

  return { hex: hexBytes };
}

/**
 * `resolveRelease` narrowed to a boolean: `true` iff a release with
 * both required assets exists for `source`. Available standalone for
 * any caller that only needs a yes/no answer. Never throws.
 */
export async function checkAvailability(
  source: ReleaseFirmwareSource,
  options?: ReleasesOptions,
): Promise<boolean> {
  const result = await resolveRelease(source, options);
  return !("reason" in result);
}
