/**
 * localFirmware.ts — resolve and read a firmware source that is a hex
 * file on this machine's disk (out-of-process, 2026-09-16).
 *
 * ## Why this is not in `releases.ts`
 *
 * `releases.ts`'s own module doc comment states a hard boundary: every
 * GitHub HTTP call in this codebase lives there and nowhere else,
 * because GitHub release assets send no `Access-Control-Allow-Origin`
 * header and the browser therefore cannot fetch them at all. A local
 * hex involves no HTTP, no CORS, and no GitHub — putting it in that
 * module would dilute a boundary that exists for a specific, verified
 * reason. This module is its counterpart: the same two operations
 * (resolve a source to something concrete, then produce verified bytes)
 * against the filesystem instead of the network.
 *
 * ## Failure is a value, not an exception
 *
 * Both exported functions follow `releases.ts`/`swdName.ts`'s
 * convention verbatim: a missing file, a directory where a file was
 * expected, an unreadable file, and a malformed hex are all ordinary
 * return values. Nothing here throws, so `watchers/firmwareWatcher.ts`'s
 * poll loop cannot die because someone deleted a build, and `server.ts`
 * can report a precise reason to a student instead of an uncaught
 * exception.
 *
 * ## What replaces the sha256 manifest
 *
 * A GitHub release carries `MICROBIT.hex.txt`, and
 * `releases.ts#fetchAndVerifyHex` checks the downloaded hex against the
 * sha256 it declares — a defense against a corrupted or truncated
 * *download*. A locally built hex has no such manifest (neither
 * `microbit-radio-relay` nor the robot template produces one) and needs
 * no such defense: the bytes never crossed a network, and there is no
 * independent digest to check them against even in principle. Inventing
 * one (hashing the file and comparing it to itself) would be theater.
 *
 * What genuinely can go wrong with a local file is that it is empty,
 * half-written by a build that was still running, or simply not a hex at
 * all — so {@link readLocalHex} runs `flash.ts`'s own
 * {@link isValidIntelHexText} structural check instead, the same gate
 * `flash()` applies before erasing a board. That catches the real local
 * failure mode (a truncated or non-hex file) at the point where a clear
 * message can still be shown, rather than mid-flash.
 */

import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { LocalHexFirmwareSource } from "./config.js";
import { isValidIntelHexText } from "./flash.js";

/**
 * Why a local hex source could not be resolved or read. Deliberately
 * distinct tokens from `releases.ts`'s {@link ReleaseError} reasons
 * (`no-releases`/`tag-not-found`/…), which describe GitHub states that
 * cannot occur here; these are carried through the `firmware.reason`
 * column to the UI exactly the same way.
 *
 *   - `"file-missing"` — nothing exists at the configured path.
 *   - `"not-a-file"` — the path exists but is a directory (or similar).
 *   - `"unreadable"` — it exists but could not be stat'd/read
 *     (permissions, a vanished volume, an I/O error).
 *   - `"invalid-hex"` — it was read, but is not well-formed Intel hex.
 */
export interface LocalHexError {
  reason: "file-missing" | "not-a-file" | "unreadable" | "invalid-hex";
  message: string;
}

/** A local hex source resolved against the filesystem — the local
 * counterpart to `releases.ts`'s `ResolvedRelease`. */
export interface ResolvedLocalHex {
  hexPath: string;
  /** `hexPath`'s basename, so callers never split a path themselves. */
  fileName: string;
  /** The file's mtime in epoch ms — a locally built hex's only
   * meaningful version identity. */
  builtAt: number;
  byteLength: number;
  /** {@link formatBuildStamp} of `builtAt`, carried where a release's
   * tag goes. */
  tag: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * A local build's displayable version: `"built <YYYY-MM-DD HH:MM>"` in
 * local time. This is what a locally built hex has instead of a release
 * tag, and it is what the flash UI shows in the tag's place, so it is
 * formatted for reading rather than parsing. Minute resolution is
 * deliberate — a build's exact second is noise, and two rebuilds within
 * one minute are indistinguishable to the person reading it either way.
 */
export function formatBuildStamp(builtAt: number): string {
  const at = new Date(builtAt);
  const pad = (value: number): string => String(value).padStart(2, "0");
  const date = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
  const time = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
  return `built ${date} ${time}`;
}

/**
 * Stat the configured hex and report what is there — the local
 * counterpart to `releases.ts#resolveRelease`, and the call
 * `watchers/firmwareWatcher.ts` makes on every poll. Cheap enough to
 * repeat on the watcher's normal interval, which is what makes a rebuilt
 * hex show up as a new build stamp without a host restart. Never throws.
 */
export async function resolveLocalHex(
  source: LocalHexFirmwareSource,
): Promise<ResolvedLocalHex | LocalHexError> {
  let stats: Awaited<ReturnType<typeof stat>>;
  try {
    stats = await stat(source.hexPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") {
      return { reason: "file-missing", message: `no file at ${source.hexPath}` };
    }
    return { reason: "unreadable", message: `could not read ${source.hexPath}: ${errorMessage(error)}` };
  }

  if (!stats.isFile()) {
    return {
      reason: "not-a-file",
      message: `${source.hexPath} is not a file -- point this at a built .hex, not a directory`,
    };
  }

  const builtAt = Math.round(stats.mtimeMs);
  return {
    hexPath: source.hexPath,
    fileName: path.basename(source.hexPath),
    builtAt,
    byteLength: stats.size,
    tag: formatBuildStamp(builtAt),
  };
}

/**
 * Read the configured hex's bytes and structurally validate them — the
 * local counterpart to `releases.ts#fetchAndVerifyHex`, called by
 * `server.ts` at flash time. See this module's doc comment for why the
 * check here is `isValidIntelHexText` rather than a sha256 comparison.
 * The bytes are never returned when validation fails. Never throws.
 */
export async function readLocalHex(
  source: LocalHexFirmwareSource,
): Promise<{ hex: Buffer } | LocalHexError> {
  const resolved = await resolveLocalHex(source);
  if ("reason" in resolved) {
    return resolved;
  }

  let hex: Buffer;
  try {
    hex = await readFile(source.hexPath);
  } catch (error) {
    return { reason: "unreadable", message: `could not read ${source.hexPath}: ${errorMessage(error)}` };
  }

  const validation = isValidIntelHexText(hex.toString("utf-8"));
  if (!validation.valid) {
    return {
      reason: "invalid-hex",
      message:
        `${source.hexPath} is not a well-formed Intel hex (${validation.reason ?? "unknown reason"}) -- ` +
        `if a build is still running, wait for it to finish and try again`,
    };
  }

  return { hex };
}
