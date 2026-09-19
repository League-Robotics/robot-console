/**
 * flash.ts — write firmware hex bytes to a target board: universal-hex v2
 * extraction, SWD flashing via DAPjs, and an MSD volume-copy fallback.
 *
 * Per `docs/design/specification.md` §4.5 and `sprint.md`'s Step 3: this
 * module knows nothing about GitHub, config, or the device registry — it
 * only ever receives already-fetched, already-verified hex bytes
 * (`releases.ts`, ticket 003) and a joined {@link DaplinkDevice}
 * (`devices.ts`). Its only job is turning those bytes into a programmed
 * board.
 *
 * ## This module writes to real hardware — safety shapes the design
 *
 * A bug here can brick a student's micro:bit or corrupt a board mid-write.
 * Two rules follow directly from that, not as an afterthought:
 *
 *   1. **Validate before erasing anything.** {@link flash} extracts and
 *      structurally validates the hex text *before* ever attaching to the
 *      board. A board must never be left erased-but-unwritten because
 *      validation failed after the erase began — see
 *      {@link isValidIntelHexText} and its call site in {@link flash}.
 *   2. **Failure is a value, not an exception**, matching `swdName.ts`'s
 *      and `releases.ts`'s convention: {@link flashViaDapLink} and
 *      {@link flash} always resolve to a classified {@link FlashOutcome},
 *      never throw and never reject, so a caller can report precisely
 *      what state the board is in rather than catching an uncaught
 *      exception. ({@link flashViaMsd} is the one exception to "never
 *      throws" — see its own doc comment for why, and how {@link flash}
 *      absorbs that.)
 *
 * ## Attach-and-may-halt — the opposite contract from `swdName.ts`
 *
 * `swdName.ts` deliberately attaches to a target *without* halting or
 * resetting it, so reading a five-letter name never disturbs firmware a
 * student might be mid-session with. `flashViaDapLink` in this module
 * does the opposite on purpose: flashing fundamentally requires halting,
 * erasing, writing, and resetting the target — there is no way to
 * program new firmware without interrupting whatever is currently
 * running. Do not "fix" one module by copying the other's constraint:
 * `swdName.ts`'s no-halt rule exists for a use case (naming a live
 * board) that does not apply here, and this module's halt/reset sequence
 * exists for a use case (recovering a board that already failed to
 * identify) where the target is not expected to have anything running
 * worth preserving.
 *
 * ## Naming: DAPLink vendor commands, not SWD (sprint 017 ticket 003)
 *
 * `flashViaDapLink`/`resetViaDapLink` were previously named
 * `flashOverSwd`/`resetOverSwd` — a misnomer the 2026-09-11 review
 * called out (`03-host-server-flash-releases.md` §2): both drive
 * `dapjs`'s `DAPLink` class, which talks to the DAPLink *interface
 * chip's own vendor-specific HID commands*, not the target's SWD debug
 * port directly the way `swdName.ts`'s `CortexM`-based `readSwdName`
 * does. The distinction is not pedantic: it is why
 * {@link resetViaDapLink}'s reset never re-enumerates USB (that
 * function's own doc comment) — a fact that is true of the DAPLink
 * vendor reset command and would not necessarily be true of a genuine
 * SWD-level reset.
 *
 * ## Every dapjs/HID call is time-bounded (sprint 017 ticket 003)
 *
 * `daplink.connect()` is wrapped in {@link withTimeout}
 * (`lib/withTimeout.ts`) — `node-hid`/`dapjs` give no bounded-wait or
 * cancellation of their own, so a wedged USB transport used to hang the
 * caller (and the board's `board_owner` slot) forever. `daplink.flash()`
 * is bounded differently, by an inactivity watchdog on its progress
 * events plus a long overall ceiling
 * ({@link DEFAULT_DAPLINK_FLASH_IDLE_TIMEOUT_MS},
 * {@link DEFAULT_DAPLINK_FLASH_TIMEOUT_MS}): a total-time bound cannot
 * tell a slow flash from a stalled one, and a full micro:bit v2 image
 * over Linux hidraw takes ~86 s. Cutting a healthy write short is
 * worse than a slow wait, since dapjs cannot be cancelled and the
 * cleanup disconnects the handle under it.
 * A timeout classifies as `reason: "timeout"` in the returned
 * {@link FlashFailure}, and the DAPLink handle is disconnected
 * best-effort before returning (never left open) — see each function's
 * own doc comment for exactly where.
 *
 * ## DAPjs's `DAPLink.flash()` is one atomic vendor-command sequence
 *
 * Unlike `swdName.ts` (which drives `dapjs`'s `CortexM` register-level
 * API directly), this module uses `dapjs`'s `DAPLink` class, which talks
 * to DAPLink's own vendor-specific HID commands
 * (`OPEN` -> per-page `WRITE` -> `CLOSE` -> `RESET` — see
 * `dapjs`'s `DAPLinkFlash` enum). `DAPLink#flash()` runs that entire
 * sequence as one call and only resolves once the target has been reset;
 * there is no library-level seam between "erase" and "write" (DAPLink's
 * firmware erases each page as it is written) or between "write" and
 * "reset" (the reset is the last command `flash()` itself sends). This
 * module reports {@link FlashPhase} best-effort around that one call:
 * `"erasing"` immediately before it starts, `"writing"` on every
 * `DAPLink.EVENT_PROGRESS` event `flash()` emits internally, and
 * `"resetting"` once `flash()` resolves (since the reset command is
 * exactly the last thing that happened before that promise settles). Any
 * error thrown from within that one call is classified as
 * `"program-failed"` — `dapjs` gives us no finer-grained seam to split
 * an erase failure from a write failure from a reset failure, the same
 * limit `swdName.ts`'s own `classifyAttachError` already accepts for its
 * own error surface.
 *
 * ## MSD volume-to-device matching: real join, hardware proof still deferred
 *
 * Per `sprint.md`'s Step 2 and `radio_relay/scripts/flash-local.js` (the
 * named template, `specification.md` §4.5): {@link flash}'s default
 * volume resolver (`defaultResolveVolumePath`) reads every mounted
 * `/Volumes/MICROBIT*` volume's `DETAILS.TXT`, extracts its `Unique ID`
 * field, and matches it — an exact string match, never a prefix/suffix
 * heuristic — against the target {@link DaplinkDevice.serialNumber}.
 * `Unique ID` is verified (against real hardware) to be character-for-
 * character identical to the device's USB serial number. A volume with
 * no `DETAILS.TXT`, an unreadable one, or one whose `Unique ID` doesn't
 * match is skipped, not treated as a match; "no volume found" is a
 * legitimate result {@link flash} already handles. The join logic itself
 * ({@link parseDetailsTxt}, {@link findMatchingVolume}) is desk-verified
 * against fixtures covering unique match, no match, and multiple
 * candidates. What remains genuinely unverified is whether this correctly
 * discriminates between multiple *physically mounted* volumes at once —
 * that needs two real boards and is deferred to ticket 006 (see
 * `sprint.md`'s Success Criteria); this module's own tests still inject
 * their own `resolveVolumePath` rather than exercising the real
 * filesystem.
 *
 * ## Platform-aware MSD enumeration, and settle/remount timing (sprint 017 ticket 004)
 *
 * The volume-listing step above used to be a single hard-coded
 * `readdir("/Volumes")` — darwin-only, so Linux and Windows silently
 * never found a fallback volume at all. {@link listVolumeNames} replaces
 * that with a `platform`-branching enumeration (darwin `/Volumes`, linux
 * `/media/<user>`/`/run/media/<user>`/`/mnt`, win32 drive letters
 * `A:`-`Z:`), still plain `fs`/`readdir` per `sprint.md`'s Design
 * Rationale ("no external process"), and still gated by the same
 * `DETAILS.TXT` join described above — this function only narrows the
 * candidate list (by name, where a name is meaningful to check at all;
 * win32 drive letters carry none, so every present drive is a candidate
 * there). A directory that fails to list is logged via `console.warn`
 * and skipped, never swallowed silently.
 *
 * Separately, {@link flash}'s MSD path now waits
 * {@link DEFAULT_MSD_SETTLE_MS} before starting the copy (a volume that
 * has just been (re)mounted benefits from a short settle window), and —
 * after {@link flashViaMsd}'s write returns — polls (best-effort, up to
 * {@link DEFAULT_MSD_REMOUNT_TIMEOUT_MS}) for the volume to disappear and
 * reappear, the observable side effect of DAPLink's own bootloader
 * erasing/flashing/resetting the target from the file it was just handed.
 * Only once that poll settles (whether or not a remount was actually
 * observed — see {@link waitForVolumeRemount}'s own doc comment for why
 * failing to observe one is not itself a flash failure) is `"resetting"`
 * reported and the outcome resolved — `writeFile` returning is no longer
 * treated as "the flash is done."
 */

import { access as fsAccess, readdir, readFile as fsReadFile, writeFile as fsWriteFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HID as NodeHidDevice } from "node-hid";
// Ticket 014-001: `dapjs` is vendored under `./vendor/dapjs/` (this
// repo's own TypeScript source, not the npm package) rather than
// installed from npm -- see that directory's README.md for why (the
// published package's UMD bundle lacks a working `.off` on its
// `DAPLink`/`CmsisDAP` classes; the vendored source, compiled by this
// package's own `tsc`, resolves `events` to Node's real `EventEmitter`,
// which has it).
import { HID as HidTransport, DAPLink } from "./vendor/dapjs/index.js";
import { TimeoutError, withTimeout } from "./lib/withTimeout.js";
import type { DaplinkDevice } from "./devices.js";
import type { FlashPhase } from "./wsMessages.js";

export type { FlashPhase } from "./wsMessages.js";

/** `microbit-foundation/universal-hex`'s block-start record marker
 * (`:04` byte count, `0000` address, `0A` record type) — the sniff test
 * for "this is a universal hex, not a plain Intel hex". */
const UNIVERSAL_HEX_BLOCK_START_MARKER = ":0400000A";

/** Universal-hex block ID for micro:bit v2 (nRF52). Block ID `0x9900` is
 * v1 (nRF51) and is discarded by {@link extractV2Hex} along with every
 * other non-v2 block. */
const BLOCK_ID_V2 = 0x9903;

/** A minimal, valid Intel hex end-of-file record, appended by
 * {@link extractV2Hex} if the extracted v2 block did not already end
 * with one. */
const EOF_RECORD = ":00000001FF";

/**
 * Sniff whether `hexText` is a universal hex (carries data for more than
 * one micro:bit hardware target) rather than a plain Intel hex. Only the
 * first 200 characters are inspected — universal hex's block-start
 * marker for the first block always appears at the very start of the
 * file, so a full-file scan is unnecessary for this check (ported from
 * `microbit-console/client/src/lib/universal-hex.ts`'s own `slice(0,
 * 200)`, adapted from `ArrayBuffer` to a plain string per this module's
 * string-based I/O boundary).
 */
export function isUniversalHex(hexText: string): boolean {
  return hexText.slice(0, 200).includes(UNIVERSAL_HEX_BLOCK_START_MARKER);
}

/**
 * Extract the micro:bit v2 (`BLOCK_ID_V2 = 0x9903`) section of a
 * universal hex as a standalone, plain Intel hex string that `dapjs`'s
 * DAPLink can flash directly (DAPLink's CMSIS-DAP interface understands
 * only standard Intel hex, not the universal-hex block-start extension).
 * Ported from `microbit-console/client/src/lib/universal-hex.ts`,
 * adapted from that file's `ArrayBuffer`-based original to plain
 * strings, consistent with this module's own I/O boundary.
 *
 * Returns `hexText` unchanged when it is not a universal hex at all
 * (per {@link isUniversalHex}) — a plain Intel hex passed to a v2-only
 * board needs no extraction.
 */
export function extractV2Hex(hexText: string): string {
  if (!hexText.includes(UNIVERSAL_HEX_BLOCK_START_MARKER)) {
    return hexText;
  }

  const lines = hexText.split(/\r?\n/);
  const outputLines: string[] = [];
  let inV2Block = false;

  for (const line of lines) {
    if (!line.startsWith(":")) {
      continue;
    }

    // Record type is byte 3 of the record -- hex chars [7, 9).
    const recordType = Number.parseInt(line.substring(7, 9), 16);

    if (recordType === 0x0a) {
      // Universal-hex block-start record: its data field's first two
      // bytes (hex chars [9, 13)) identify which hardware target the
      // following records belong to. Never emitted to the output --
      // DAPLink's flash protocol has no concept of it.
      const blockId = Number.parseInt(line.substring(9, 13), 16);
      inV2Block = blockId === BLOCK_ID_V2;
      continue;
    }

    if (inV2Block) {
      outputLines.push(line);
    }

    if (recordType === 0x01 && inV2Block) {
      // End-of-file record inside the v2 block -- the v2 section is
      // complete; any v1 block that might follow in the file is
      // irrelevant to a v2 target.
      break;
    }
  }

  const lastLine = outputLines[outputLines.length - 1];
  if (!lastLine || Number.parseInt(lastLine.substring(7, 9), 16) !== 0x01) {
    outputLines.push(EOF_RECORD);
  }

  return outputLines.join("\n") + "\n";
}

/**
 * Structural (not semantic) validation of a plain Intel hex string:
 * every non-blank line starts with `:`, is long enough to carry a
 * record-type byte, has a parseable record-type field, and at least one
 * line is a well-formed EOF record. This is the pre-erase safety gate
 * `flash()` runs before ever attaching to a board — see this module's
 * doc comment's "Validate before erasing anything" rule. It cannot (and
 * does not try to) verify the hex is *correct* firmware for the target
 * chip; `releases.ts`'s sha256 check is what establishes the bytes came
 * from the expected release. This only confirms the bytes are
 * well-formed enough that attempting to flash them is not itself the
 * failure.
 */
export function isValidIntelHexText(hexText: string): { valid: boolean; reason?: string } {
  const lines = hexText.split(/\r?\n/).filter((line) => line.length > 0);
  if (lines.length === 0) {
    return { valid: false, reason: "hex is empty" };
  }

  let hasEofRecord = false;
  for (const line of lines) {
    if (!line.startsWith(":")) {
      return { valid: false, reason: `line does not start with ':': "${line.slice(0, 20)}"` };
    }
    if (line.length < 11) {
      return { valid: false, reason: `record too short to contain a record type: "${line}"` };
    }
    const recordType = Number.parseInt(line.substring(7, 9), 16);
    if (Number.isNaN(recordType)) {
      return { valid: false, reason: `unparseable record type in line: "${line}"` };
    }
    if (recordType === 0x01) {
      hasEofRecord = true;
    }
  }

  if (!hasEofRecord) {
    return { valid: false, reason: "no end-of-file (:00000001FF-shaped) record found" };
  }

  return { valid: true };
}

/** Which path actually wrote the firmware — logging/diagnostics only,
 * per `sprint.md`'s "no leak" note this is never part of the WebSocket
 * wire contract (`wsMessages.ts` has no `method` field). */
export type FlashMethod = "swd" | "msd";

/** A flash that completed successfully via the named {@link FlashMethod}. */
export interface FlashSuccess {
  status: "ok";
  method: FlashMethod;
}

/**
 * A flash that failed, classified into the reasons this module (and the
 * libraries it wraps) can actually distinguish:
 *   - `"invalid-hex"` — the hex failed {@link isValidIntelHexText}'s
 *     structural check; nothing was ever attached to the board.
 *   - `"no-hid-path"` — `devices.ts` could not resolve a CMSIS-DAP HID
 *     path for this device (mirrors `swdName.ts`'s `SwdNameFailure`).
 *   - `"permission"` — the HID/transport layer reported an OS
 *     permission error opening the device.
 *   - `"attach-failed"` — the DAPLink transport could not connect (bad
 *     probe state, unsupported/locked chip, probe busy) — the generic
 *     bucket `dapjs` gives us no way to split further, same limit
 *     `swdName.ts`'s `classifyAttachError` already accepts.
 *   - `"program-failed"` — attach succeeded but the `DAPLink#flash()`
 *     call itself (erase/write/reset, as one sequence — see the module
 *     doc) threw.
 *   - `"no-volume"` — SWD flashing failed and no mounted MSD volume
 *     could be resolved for this device, so no fallback was attempted.
 *   - `"write-failed"` — the MSD fallback's file write itself failed.
 *   - `"timeout"` (sprint 017 ticket 003) — `daplink.connect()` did not
 *     settle within its budget, or `daplink.flash()` reported no progress
 *     for its idle bound or ran past its overall ceiling; the error text
 *     names which (see the module doc's "Every dapjs/HID call is
 *     time-bounded" section).
 *     The DAPLink handle is disconnected best-effort before this is
 *     returned.
 *   - `"owner-unavailable"` (sprint 017 ticket 003) — produced only by
 *     `connect/flasher.ts`, never by this module directly: `board_owner
 *     = 'flash'` could not be acquired for this device within that
 *     module's own acquire-retry budget, even after closing any open
 *     session first. Listed here (rather than in a separate type)
 *     because `connect/flasher.ts` returns the same {@link FlashOutcome}
 *     type this module does, per its own "thin orchestrator" design
 *     (`sprint.md`'s Design Rationale).
 */
export interface FlashFailure {
  status: "error";
  method: FlashMethod;
  reason:
    | "invalid-hex"
    | "no-hid-path"
    | "permission"
    | "attach-failed"
    | "program-failed"
    | "no-volume"
    | "write-failed"
    | "timeout"
    | "owner-unavailable";
  error: string;
}

export type FlashOutcome = FlashSuccess | FlashFailure;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Classify a caught attach-time error the same way `swdName.ts`'s
 * `classifyAttachError` does -- a recognizable permission-flavored
 * substring versus a generic attach failure, which is everything
 * `dapjs`/`node-hid` give us enough information to split. */
function classifyAttachError(error: unknown): { reason: "permission" | "attach-failed"; error: string } {
  const message = errorMessage(error);
  const reason: "permission" | "attach-failed" = /eacces|eperm|permission|access denied/i.test(message)
    ? "permission"
    : "attach-failed";
  return { reason, error: message };
}

/** Function shape used to obtain a `dapjs` `DAPLink` instance from a
 * CMSIS-DAP HID path. Defaults to the real `node-hid` + `dapjs` stack;
 * overridable so tests can substitute a fake without touching real
 * hardware -- mirrors `swdName.ts`'s `CortexMFactory` injection seam and
 * its "not unit-tested against a mock beyond the seam itself" precedent
 * (see this file's test file doc comment). */
export type DapLinkFactory = (hidPath: string) => DAPLink;

function defaultDapLinkFactory(hidPath: string): DAPLink {
  const hidDevice = new NodeHidDevice(hidPath);
  const transport = new HidTransport(hidDevice);
  return new DAPLink(transport);
}

/** Default bound on `daplink.connect()` — see the module doc's "Every
 * dapjs/HID call is time-bounded" section. Overridable per call via
 * {@link FlashViaDapLinkOptions.connectTimeoutMs} (tests shrink this to
 * avoid a slow suite). */
export const DEFAULT_DAPLINK_CONNECT_TIMEOUT_MS = 5_000;

/** Overall ceiling on the single `daplink.flash()` call, which erases,
 * writes, and resets the target as one atomic sequence (module doc's
 * "DAPjs's DAPLink.flash() is one atomic vendor-command sequence"
 * section). This is only the backstop for a flash that keeps reporting
 * progress but never finishes; the bound that normally catches a wedged
 * transport is {@link DEFAULT_DAPLINK_FLASH_IDLE_TIMEOUT_MS}. It used to
 * be the *only* bound, at 30 s -- but a full micro:bit v2 image over
 * Linux hidraw takes ~86 s (real-hardware finding, Ubuntu 24.04), so a
 * healthy flash was reported as timed out while dapjs kept writing, and
 * the cleanup then disconnected the HID handle under a live write.
 * Overridable per call via {@link FlashViaDapLinkOptions.flashTimeoutMs}. */
export const DEFAULT_DAPLINK_FLASH_TIMEOUT_MS = 300_000;

/** Inactivity bound on `daplink.flash()`: the call fails with
 * `reason: "timeout"` only if no `DAPLink.EVENT_PROGRESS` event has
 * arrived for this long. The first window starts when `flash()` is
 * called (DAPLink's OPEN/erase happens before the first progress event);
 * every progress event restarts it; the last window covers the CLOSE and
 * RESET commands sent after the final (`1.0`) progress event. dapjs
 * emits progress once per written page, so a healthy flash resets this
 * many times a second however slow the transport is overall.
 * Overridable per call via {@link FlashViaDapLinkOptions.flashIdleTimeoutMs}. */
export const DEFAULT_DAPLINK_FLASH_IDLE_TIMEOUT_MS = 30_000;

/** Default bound on `daplink.connect()`/`daplink.reset()` inside
 * {@link resetViaDapLink}. Overridable via
 * {@link ResetViaDapLinkOptions}. */
export const DEFAULT_DAPLINK_RESET_TIMEOUT_MS = 5_000;

export interface FlashViaDapLinkOptions {
  createDapLink?: DapLinkFactory;
  /** See {@link DEFAULT_DAPLINK_CONNECT_TIMEOUT_MS}. */
  connectTimeoutMs?: number;
  /** Overall ceiling on `daplink.flash()`. See
   * {@link DEFAULT_DAPLINK_FLASH_TIMEOUT_MS}. */
  flashTimeoutMs?: number;
  /** Longest gap between progress events before `daplink.flash()` is
   * treated as stalled. See {@link DEFAULT_DAPLINK_FLASH_IDLE_TIMEOUT_MS}. */
  flashIdleTimeoutMs?: number;
}

/** `daplink.flash()` hit one of its two bounds -- `"idle"` (no progress
 * for {@link FlashViaDapLinkOptions.flashIdleTimeoutMs}) or `"ceiling"`
 * ({@link FlashViaDapLinkOptions.flashTimeoutMs} in total). Classified
 * as `reason: "timeout"`, like a {@link TimeoutError}. */
export class FlashBoundError extends Error {
  constructor(
    readonly bound: "idle" | "ceiling",
    readonly ms: number,
  ) {
    super(
      bound === "idle"
        ? `daplink.flash() made no progress for ${formatDuration(ms)}`
        : `daplink.flash() exceeded ${formatDuration(ms)}`,
    );
    this.name = "FlashBoundError";
  }
}

/** `30000` -> `"30 s"`; anything not a whole second stays in ms
 * (tests use short bounds). */
function formatDuration(ms: number): string {
  return ms % 1000 === 0 ? `${ms / 1000} s` : `${ms} ms`;
}

/**
 * Race `operation` against an inactivity watchdog and an overall
 * ceiling. `progressed()` restarts the inactivity window; the first
 * window starts now. Both timers are cleared once the race settles and
 * are `unref()`'d, like {@link withTimeout}'s. Like that helper, this
 * does not (cannot) cancel `operation` itself.
 */
function watchFlashProgress<T>(
  operation: Promise<T>,
  idleMs: number,
  ceilingMs: number,
): { result: Promise<T>; progressed: () => void } {
  let progressed = () => {};
  const result = new Promise<T>((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void) => {
      if (!settled) {
        settled = true;
        clearTimeout(idleTimer);
        clearTimeout(ceilingTimer);
        fn();
      }
    };
    const armIdle = () =>
      setTimeout(() => settle(() => reject(new FlashBoundError("idle", idleMs))), idleMs);
    let idleTimer = armIdle();
    idleTimer.unref?.();
    const ceilingTimer = setTimeout(() => settle(() => reject(new FlashBoundError("ceiling", ceilingMs))), ceilingMs);
    ceilingTimer.unref?.();
    progressed = () => {
      if (!settled) {
        clearTimeout(idleTimer);
        idleTimer = armIdle();
        idleTimer.unref?.();
      }
    };
    operation.then(
      (value) => settle(() => resolve(value)),
      (error: unknown) => settle(() => reject(error)),
    );
  });
  return { result, progressed: () => progressed() };
}

/**
 * Flash `hex` (already extracted to a plain, v2-only Intel hex — see
 * {@link flash}, which is the caller that does that extraction) onto
 * `device` via `dapjs`'s `DAPLink` vendor-command flash protocol,
 * against the same CMSIS-DAP HID handle `swdName.ts` uses
 * (`device.hid.path`) — see the module doc's "Naming" section for why
 * this is not itself an SWD-level operation despite the vendored `dapjs`
 * package's own class name.
 *
 * Unlike `swdName.ts`, this **does** halt, erase, write, and reset the
 * target -- see the module doc's "Attach-and-may-halt" section for why
 * that is correct here.
 *
 * Reports `"erasing"` immediately before the flash sequence starts,
 * `"writing"` on every progress event `DAPLink#flash()` emits
 * internally, and `"resetting"` once that call resolves (see the module
 * doc for why finer-grained phase boundaries aren't available from
 * `dapjs`). Always resolves to a {@link FlashOutcome}, never throws.
 *
 * `daplink.connect()` is wrapped in {@link withTimeout};
 * `daplink.flash()` is watched by {@link watchFlashProgress} (no progress
 * for `flashIdleTimeoutMs`, or `flashTimeoutMs` in total). Any of these
 * classifies as `reason: "timeout"`, with a message naming the bound. A
 * `connect()` timeout disconnects the (possibly still-opening) handle
 * best-effort before returning, since that call never reaches this
 * function's own `finally` block below; a `flash()` timeout is already
 * covered by that `finally`, same as every other error thrown from
 * within it.
 */
export async function flashViaDapLink(
  device: DaplinkDevice,
  hex: string,
  onProgress: (phase: FlashPhase) => void,
  options?: FlashViaDapLinkOptions,
): Promise<FlashOutcome> {
  const hidPath = device.hid?.path;
  if (hidPath === undefined) {
    return {
      status: "error",
      method: "swd",
      reason: "no-hid-path",
      error: "no HID path available for this device (node-hid could not resolve one)",
    };
  }

  const createDapLink = options?.createDapLink ?? defaultDapLinkFactory;
  const connectTimeoutMs = options?.connectTimeoutMs ?? DEFAULT_DAPLINK_CONNECT_TIMEOUT_MS;
  const flashTimeoutMs = options?.flashTimeoutMs ?? DEFAULT_DAPLINK_FLASH_TIMEOUT_MS;
  const flashIdleTimeoutMs = options?.flashIdleTimeoutMs ?? DEFAULT_DAPLINK_FLASH_IDLE_TIMEOUT_MS;

  let daplink: DAPLink;
  try {
    daplink = createDapLink(hidPath);
  } catch (error) {
    const { reason, error: message } = classifyAttachError(error);
    return { status: "error", method: "swd", reason, error: message };
  }

  try {
    await withTimeout(daplink.connect(), connectTimeoutMs, "daplink.connect()");
  } catch (error) {
    if (error instanceof TimeoutError) {
      try {
        await daplink.disconnect();
      } catch {
        // Best-effort cleanup only -- see this function's own `finally`
        // block below for why a failed disconnect must never mask or
        // replace whatever result was already determined.
      }
      return { status: "error", method: "swd", reason: "timeout", error: error.message };
    }
    const { reason, error: message } = classifyAttachError(error);
    return { status: "error", method: "swd", reason, error: message };
  }

  // Restarts the inactivity window; assigned once flash() is under watch.
  let progressed = () => {};
  const reportWriting = () => {
    progressed();
    onProgress("writing");
  };
  try {
    onProgress("erasing");
    daplink.on(DAPLink.EVENT_PROGRESS, reportWriting);
    const watch = watchFlashProgress(daplink.flash(Buffer.from(hex, "utf-8")), flashIdleTimeoutMs, flashTimeoutMs);
    progressed = watch.progressed;
    await watch.result;
    onProgress("resetting");
    return { status: "ok", method: "swd" };
  } catch (error) {
    if (error instanceof FlashBoundError || error instanceof TimeoutError) {
      return { status: "error", method: "swd", reason: "timeout", error: error.message };
    }
    return {
      status: "error",
      method: "swd",
      reason: "program-failed",
      error: errorMessage(error),
    };
  } finally {
    // Ticket 014-001: this used to be wrapped in its own try/catch,
    // working around the npm `dapjs` package's bundled `DAPLink` having
    // no `.off` alias at runtime (only `on`/`removeListener`/`emit`) --
    // see `./vendor/dapjs/README.md`. Now that `DAPLink` is vendored
    // source compiled against Node's real `events.EventEmitter`, `.off`
    // genuinely exists and never throws for a listener registered with
    // `.on` moments earlier, so no defensive wrapping is needed here.
    daplink.off(DAPLink.EVENT_PROGRESS, reportWriting);
    try {
      await daplink.disconnect();
    } catch {
      // Best-effort cleanup only -- a failed disconnect must not mask
      // (or replace) whatever result was already determined above, same
      // precedent as `swdName.ts`'s own `finally` block.
    }
  }
}

/**
 * Reset `device` via its DAPLink interface chip's own vendor reset
 * command (`dapjs`'s `CmsisDAP#reset()`, which `DAPLink` inherits) --
 * **not** a flash, and not the same operation as {@link flashViaDapLink}'s
 * own post-write reset (which is the last step of `DAPLink#flash()`'s
 * one atomic sequence, not separately callable).
 *
 * The property this function exists for (OOP 2026-09-09,
 * `deviceRegistry.ts`'s relay-via-radio support): unlike a flash --
 * which remounts the target as mass storage and back, re-enumerating
 * USB -- a target reset through the DAPLink interface chip does **not**
 * re-enumerate USB. The board's CDC serial port stays exactly where it
 * was, at the same OS path, the whole time. That matters because a
 * relay's radio data plane has no in-band escape once `!GO` confirms
 * (`link/RelayRadioLink.ts`'s own doc comment: exit is reset-only) --
 * this is how a relay already bridging one robot is returned to its
 * command plane, ready for a fresh `!CG`/`!GO` handshake against a
 * (possibly different) robot, without the serial port the caller is
 * about to reopen ever disappearing out from under it mid-sequence.
 *
 * Mirrors {@link flashViaDapLink}'s own shape and "failure is a value,
 * never throws" contract exactly (HID-path-first, injectable
 * `createDapLink`, best-effort `disconnect()` in a `finally` that can
 * never mask an already-determined result, every dapjs call bound by
 * {@link withTimeout}) but with nothing to write and no
 * {@link FlashPhase} progress to report -- just connect, reset,
 * disconnect. A `connect()` or `reset()` timeout is reported as
 * `{ ok: false, error }` — this function has no typed failure-reason
 * union of its own (unlike {@link FlashOutcome}), so a timeout here is
 * just another rejected-then-classified error, distinguishable by the
 * `TimeoutError`-shaped message.
 */
export interface ResetViaDapLinkOptions {
  createDapLink?: DapLinkFactory;
  /** See {@link DEFAULT_DAPLINK_RESET_TIMEOUT_MS}. Bounds both
   * `daplink.connect()` and `daplink.reset()`. */
  timeoutMs?: number;
}

export async function resetViaDapLink(
  device: DaplinkDevice,
  options?: ResetViaDapLinkOptions,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const hidPath = device.hid?.path;
  if (hidPath === undefined) {
    return {
      ok: false,
      error: "no HID path available for this device (node-hid could not resolve one)",
    };
  }

  const createDapLink = options?.createDapLink ?? defaultDapLinkFactory;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_DAPLINK_RESET_TIMEOUT_MS;
  let daplink: DAPLink;
  try {
    daplink = createDapLink(hidPath);
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }

  try {
    await withTimeout(daplink.connect(), timeoutMs, "daplink.connect()");
  } catch (error) {
    if (error instanceof TimeoutError) {
      try {
        await daplink.disconnect();
      } catch {
        // Best-effort cleanup only -- see this function's own `finally`
        // block below.
      }
    }
    return { ok: false, error: errorMessage(error) };
  }

  try {
    await withTimeout(daplink.reset(), timeoutMs, "daplink.reset()");
    return { ok: true };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  } finally {
    // Best-effort cleanup only -- see flashViaDapLink's own `finally`
    // block for why a failed disconnect must never mask or replace
    // whatever result was already determined above.
    try {
      await daplink.disconnect();
    } catch {
      // Swallowed intentionally.
    }
  }
}

/** Function shape used to write bytes to a mounted MSD volume path.
 * Defaults to `node:fs/promises`'s `writeFile`; overridable so tests run
 * against a fake/injectable filesystem, never a real mounted volume. */
export type WriteFileFn = (filePath: string, data: Buffer) => Promise<void>;

async function defaultWriteFile(filePath: string, data: Buffer): Promise<void> {
  await fsWriteFile(filePath, data);
}

/** Filename written into the mounted MICROBIT volume. Any `.hex`
 * filename triggers DAPLink's bootloader to flash it -- this name is
 * chosen for consistency with the asset `releases.ts` fetches, not
 * because the bootloader requires this exact name. */
const MSD_HEX_FILENAME = "MICROBIT.hex";

/**
 * Write `hex` bytes to `volumePath` (a mounted `/Volumes/MICROBIT*`-style
 * path), following `radio_relay/scripts/flash-local.js`'s write pattern:
 * a single write of the whole file into the mounted volume, which
 * DAPLink's bootloader then picks up and flashes on its own.
 *
 * Unlike this module's other exported functions, **this one can throw**
 * (matching `flash-local.js`'s own `fs.writeFileSync`-throws-on-failure
 * pattern) rather than returning a classified failure value itself --
 * {@link flash}, its only caller, wraps this call and turns a thrown
 * error into a classified {@link FlashFailure} (`reason: "write-failed"`)
 * so the "failure is a value" convention still holds at this module's
 * public orchestration boundary, even though this one lower-level helper
 * is a plain throwing async function.
 */
export async function flashViaMsd(
  volumePath: string,
  hex: Buffer,
  options?: { writeFile?: WriteFileFn },
): Promise<void> {
  const writeFile = options?.writeFile ?? defaultWriteFile;
  await writeFile(path.join(volumePath, MSD_HEX_FILENAME), hex);
}

/** Injectable delay, mirroring `connect/flasher.ts`'s own `DelayFn` seam
 * exactly (same shape, same "real, `unref()`'d timer by default"
 * default) -- both modules need the same "never keep the process alive
 * on a pending delay" property, and tests need the same "swap in an
 * instant/deterministic delay" seam, so the shape is duplicated here
 * rather than importing it from `connect/flasher.ts` (this module has no
 * dependency on that one -- see this module's own doc comment on
 * dependency direction, and `connect/flasher.ts`'s own "depends only on
 * `store` and `flash.ts`" note; the edge does not run the other way). */
export type DelayFn = (ms: number) => Promise<void>;

function defaultDelay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    (timer as unknown as { unref?: () => void }).unref?.();
  });
}

/** Settle delay {@link flash} waits before starting the MSD write itself
 * -- this ticket's own acceptance criterion. A volume that has just been
 * (re)mounted (for instance, immediately after the SWD attempt that
 * itself failed) benefits from a short window before it is written to. */
export const DEFAULT_MSD_SETTLE_MS = 500;

/** Default total budget {@link waitForVolumeRemount} polls for the MSD
 * volume to disappear and reappear after {@link flashViaMsd}'s write
 * returns -- DAPLink's own bootloader typically completes its
 * erase/flash/remount cycle well under this on real hardware; 10s leaves
 * headroom for a slow USB mass-storage re-enumeration without leaving a
 * `flash-progress` client waiting indefinitely. */
export const DEFAULT_MSD_REMOUNT_TIMEOUT_MS = 10_000;

/** Poll interval within {@link DEFAULT_MSD_REMOUNT_TIMEOUT_MS}'s budget. */
export const DEFAULT_MSD_REMOUNT_POLL_MS = 200;

/** Function shape used to check whether `volumePath` is currently
 * present/mounted. Defaults to a real filesystem check (`fs.access`);
 * overridable so tests simulate the volume disappearing and reappearing
 * on a schedule without a real board. */
export type VolumeExistsFn = (volumePath: string) => Promise<boolean>;

async function defaultVolumeExists(volumePath: string): Promise<boolean> {
  try {
    await fsAccess(volumePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Wait (bounded by `timeoutMs`) for `volumePath` to disappear and then
 * reappear -- DAPLink's own remount cycle once it has finished processing
 * the `.hex` file {@link flashViaMsd} just wrote onto it. This is what
 * lets {@link flash} avoid reporting success the instant `writeFile`
 * returns, per this ticket's own acceptance criterion.
 *
 * Best-effort: if the volume is never observed to disappear at all (for
 * instance because the polling interval is too coarse to catch a very
 * fast unmount/remount cycle), or `timeoutMs` elapses before it
 * reappears, this resolves anyway rather than rejecting. The write itself
 * already succeeded -- {@link flashViaMsd} returned without throwing --
 * so a remount this function fails to *observe* is a lost confirmation,
 * not evidence the flash itself failed; a real board that this function's
 * polling simply never catches mid-cycle should not be reported as a
 * flash failure on that basis alone.
 */
async function waitForVolumeRemount(
  volumePath: string,
  options: {
    volumeExists: VolumeExistsFn;
    delay: DelayFn;
    now: () => number;
    timeoutMs: number;
    pollMs: number;
  },
): Promise<void> {
  const { volumeExists, delay, now, timeoutMs, pollMs } = options;
  const deadline = now() + timeoutMs;

  let sawGone = false;
  while (now() < deadline) {
    const present = await volumeExists(volumePath);
    if (!present) {
      sawGone = true;
    } else if (sawGone) {
      // Disappeared, then reappeared -- the remount DAPLink's own
      // bootloader performs once it's done processing the write.
      return;
    }
    await delay(pollMs);
  }
  // Timed out without observing a disappear-then-reappear cycle -- see
  // this function's own doc comment for why that is not itself treated
  // as a failure.
}

/** Function shape used to read a text file's contents whole. Defaults to
 * `node:fs/promises`'s `readFile` (utf-8); overridable so tests supply
 * fixture `DETAILS.TXT` content without touching a real mounted volume,
 * mirroring this module's existing {@link WriteFileFn} injection
 * pattern. */
export type ReadTextFileFn = (filePath: string) => Promise<string>;

async function defaultReadTextFile(filePath: string): Promise<string> {
  return fsReadFile(filePath, "utf-8");
}

/** Filename DAPLink writes onto every mounted MSD volume, carrying
 * (among other fields) the `Unique ID` this module joins against
 * {@link DaplinkDevice.serialNumber}. */
const DETAILS_TXT_FILENAME = "DETAILS.TXT";

/** The `DETAILS.TXT` field verified (against real hardware) to be
 * character-for-character identical to the owning device's USB serial
 * number -- the join key {@link findMatchingVolume} matches on. */
const DETAILS_UNIQUE_ID_KEY = "Unique ID";

/**
 * Parse DAPLink's `DETAILS.TXT` format into a flat key/value map: `#`-
 * prefixed comment lines are ignored, blank lines are ignored, and every
 * remaining line is split on its *first* `:` into a trimmed key and
 * trimmed value -- tolerant of the single space DAPLink puts after the
 * colon and of keys that themselves contain spaces (e.g. `Unique ID`,
 * `Auto Reset`, `USB Interfaces`). A line with no `:` at all, or an
 * empty key, is skipped rather than producing a malformed entry. Pure
 * and filesystem-free -- unit-testable directly against fixture text.
 */
export function parseDetailsTxt(text: string): Record<string, string> {
  const details: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }
    const separatorIndex = line.indexOf(":");
    if (separatorIndex === -1) {
      continue;
    }
    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim();
    if (key.length === 0) {
      continue;
    }
    details[key] = value;
  }
  return details;
}

/** One mounted candidate volume, already read and parsed -- what
 * {@link findMatchingVolume} joins against a device's `serialNumber`. */
export interface VolumeCandidate {
  volumePath: string;
  details: Record<string, string>;
}

/**
 * Pure join: the `volumePath` of whichever `candidates` entry's
 * `Unique ID` field is an *exact* string match for `serialNumber` --
 * never a prefix/suffix heuristic, since several mounted `MICROBIT*`
 * volumes are otherwise indistinguishable by name alone (see the module
 * doc). A candidate with no `Unique ID` field, or one that doesn't
 * match, is not returned. `undefined` (no match among any candidate) is
 * a legitimate result, not a failure. When more than one candidate
 * somehow reports the same `Unique ID` (not expected on real hardware),
 * the first such candidate is returned, mirroring `Array#find`'s own
 * first-match semantics rather than inventing a tie-break rule nothing
 * requires. Pure and filesystem-free -- unit-testable directly against
 * fixture candidates.
 */
export function findMatchingVolume(
  candidates: readonly VolumeCandidate[],
  serialNumber: string,
): string | undefined {
  return candidates.find((candidate) => candidate.details[DETAILS_UNIQUE_ID_KEY] === serialNumber)
    ?.volumePath;
}

/** Injectable seams for {@link listVolumeNames}. Defaults to the real
 * filesystem (`node:fs/promises`'s `readdir`) and `os.userInfo().username`
 * so this function is unit-testable against a fake filesystem, per this
 * module's other injection seams ({@link WriteFileFn},
 * {@link ReadTextFileFn}). */
export interface ListVolumeNamesDeps {
  /** Reads one directory's entries. Defaults to `node:fs/promises`'s
   * `readdir`. Reused for win32's drive-letter probing too -- a
   * successful `readdir` on a drive root is treated as "this letter is
   * in use", a thrown error as "not in use" (see {@link listVolumeNames}'s
   * own doc comment for why that particular throw is not itself logged
   * as an enumeration failure). */
  readdir?: (dirPath: string) => Promise<string[]>;
  /** Resolves the logged-in username substituted into linux's
   * `/media/<user>` and `/run/media/<user>` candidate directories.
   * Defaults to `os.userInfo().username`. */
  username?: () => string;
}

/** Every drive letter Windows can assign -- `win32`'s own candidate
 * enumeration probes each one via {@link ListVolumeNamesDeps.readdir},
 * since (unlike darwin's `/Volumes` or linux's `/media/<user>`) there is
 * no single parent directory to list; a mounted volume simply *is* one
 * of these 26 possible roots. Forward slashes (`"D:/"`, not `"D:\\"`) so
 * every path this module builds stays deterministic under test
 * regardless of the host OS actually running the test suite -- Node's
 * `fs` accepts `/` as a path separator on Windows too, so this is not a
 * compromise at real runtime either. */
const WIN32_DRIVE_LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/**
 * Enumerate every mounted-volume candidate path for `platform`, matched
 * on name (`MICROBIT*`) where a name is meaningful to check at all -- see
 * the module doc's "MSD volume-to-device matching" section for why the
 * *actual* device match always happens later, via `DETAILS.TXT`'s
 * `Unique ID` ({@link findMatchingVolume}); this function is only the
 * cheap first-pass narrowing step, generalized (sprint 017 ticket 004)
 * from the old darwin-only `readdir("/Volumes")` call to also cover linux
 * and win32:
 *
 *   - **darwin**: `/Volumes/MICROBIT*`.
 *   - **linux**: `/media/<user>/MICROBIT*`, `/run/media/<user>/MICROBIT*`,
 *     and `/mnt/MICROBIT*` -- three conventional per-distro mount roots,
 *     all checked (a distro that doesn't use one of them simply fails to
 *     list it, logged and skipped, not fatal to checking the others --
 *     see below). `<user>` is `os.userInfo().username` unless
 *     {@link ListVolumeNamesDeps.username} overrides it.
 *   - **win32**: every drive letter `A:` through `Z:`, probed for
 *     existence via {@link ListVolumeNamesDeps.readdir} rather than
 *     name-matched -- a drive letter carries no name to check at all; the
 *     real match still happens via `DETAILS.TXT` downstream, same as
 *     every other platform.
 *
 * A candidate directory that fails to list (darwin's `/Volumes`, or one
 * of linux's three candidate roots) is logged via `console.warn` and
 * skipped -- never swallowed silently, and never fatal to checking the
 * platform's other candidate directories. An absent win32 drive letter is
 * *not* logged as a failure: unlike a missing `/Volumes` or
 * `/media/<user>` (both expected to exist on their respective platforms),
 * an unused drive letter is the overwhelmingly common case -- most of the
 * 26 are never assigned -- so treating every one as a loggable failure
 * would be noise, not signal.
 */
export async function listVolumeNames(
  platform: NodeJS.Platform,
  deps: ListVolumeNamesDeps = {},
): Promise<string[]> {
  const readdirFn = deps.readdir ?? ((dirPath: string) => readdir(dirPath));

  if (platform === "win32") {
    const volumePaths: string[] = [];
    for (const letter of WIN32_DRIVE_LETTERS) {
      const drivePath = `${letter}:/`;
      try {
        await readdirFn(drivePath);
        volumePaths.push(drivePath);
      } catch {
        // Not a failure -- see this function's own doc comment.
        continue;
      }
    }
    return volumePaths;
  }

  let baseDirs: string[];
  if (platform === "darwin") {
    baseDirs = ["/Volumes"];
  } else if (platform === "linux") {
    const username = (deps.username ?? (() => os.userInfo().username))();
    baseDirs = [`/media/${username}`, `/run/media/${username}`, "/mnt"];
  } else {
    console.warn(`listVolumeNames: unsupported platform "${platform}" -- no MSD volumes will be found`);
    return [];
  }

  const volumePaths: string[] = [];
  for (const baseDir of baseDirs) {
    let entries: string[];
    try {
      entries = await readdirFn(baseDir);
    } catch (error) {
      console.warn(
        `listVolumeNames: could not list "${baseDir}" (${errorMessage(error)}) -- skipping this directory`,
      );
      continue;
    }
    for (const name of entries.filter((entry) => entry.startsWith("MICROBIT"))) {
      volumePaths.push(path.join(baseDir, name));
    }
  }
  return volumePaths;
}

/**
 * Default MSD volume resolver: enumerate every candidate volume path via
 * {@link listVolumeNames} (platform-aware since sprint 017 ticket 004 --
 * see that function's own doc comment), read each one's `DETAILS.TXT`,
 * and hand the parsed candidates to {@link findMatchingVolume} to pick
 * the one actually belonging to `device` -- see the module doc's "MSD
 * volume-to-device matching" section. A volume whose `DETAILS.TXT` is
 * missing or unreadable is skipped (not a match, and not a failure of the
 * whole resolution); an empty candidate list or a failure enumerating at
 * all still returns `undefined`. `listVolumeNames`/`readTextFile` are
 * injectable (defaulting to the real filesystem) purely so this function
 * itself is unit-testable with no real mounted volume -- {@link flash}'s
 * own tests always inject their own `resolveVolumePath` instead of
 * exercising this default (see the module doc).
 */
export async function defaultResolveVolumePath(
  device: DaplinkDevice,
  options?: {
    listVolumeNames?: () => Promise<string[]>;
    readTextFile?: ReadTextFileFn;
  },
): Promise<string | undefined> {
  const listNames = options?.listVolumeNames ?? (() => listVolumeNames(os.platform()));
  const readTextFile = options?.readTextFile ?? defaultReadTextFile;

  let volumePaths: string[];
  try {
    volumePaths = await listNames();
  } catch (error) {
    console.warn(
      `defaultResolveVolumePath: could not enumerate mounted volumes (${errorMessage(error)}) -- ` +
        "treating this as no mounted MSD volume found",
    );
    return undefined;
  }

  const candidates: VolumeCandidate[] = [];
  for (const volumePath of volumePaths) {
    try {
      const text = await readTextFile(path.join(volumePath, DETAILS_TXT_FILENAME));
      candidates.push({ volumePath, details: parseDetailsTxt(text) });
    } catch {
      // No DETAILS.TXT, or unreadable -- skip this volume rather than
      // failing the whole resolution.
      continue;
    }
  }

  return findMatchingVolume(candidates, device.serialNumber);
}

export interface FlashOptions {
  /** Injectable `dapjs`/`node-hid` factory for {@link flashViaDapLink}.
   * Defaults to the real stack. */
  createDapLink?: DapLinkFactory;
  /** Injectable filesystem write for {@link flashViaMsd}. Defaults to
   * `node:fs/promises`'s `writeFile`. */
  writeFile?: WriteFileFn;
  /** Resolve a mounted MSD volume path for `device`, or `undefined` if
   * none can be found. Defaults to {@link defaultResolveVolumePath}'s
   * real `DETAILS.TXT`-to-serial join (see the module doc). Tests always
   * inject their own. */
  resolveVolumePath?: (device: DaplinkDevice) => Promise<string | undefined>;
  /** Forwarded to {@link flashViaDapLink}'s own
   * {@link FlashViaDapLinkOptions.connectTimeoutMs}. Defaults to
   * {@link DEFAULT_DAPLINK_CONNECT_TIMEOUT_MS}. */
  connectTimeoutMs?: number;
  /** Forwarded to {@link flashViaDapLink}'s own
   * {@link FlashViaDapLinkOptions.flashTimeoutMs} (the overall ceiling).
   * Defaults to {@link DEFAULT_DAPLINK_FLASH_TIMEOUT_MS}. */
  flashTimeoutMs?: number;
  /** Forwarded to {@link flashViaDapLink}'s own
   * {@link FlashViaDapLinkOptions.flashIdleTimeoutMs} (the no-progress
   * bound). Defaults to {@link DEFAULT_DAPLINK_FLASH_IDLE_TIMEOUT_MS}. */
  flashIdleTimeoutMs?: number;
  /** Settle delay before the MSD write starts (sprint 017 ticket 004).
   * Defaults to {@link DEFAULT_MSD_SETTLE_MS}. */
  msdSettleMs?: number;
  /** Total budget to observe the MSD volume disappear/reappear after the
   * write completes. Defaults to {@link DEFAULT_MSD_REMOUNT_TIMEOUT_MS}. */
  msdRemountTimeoutMs?: number;
  /** Poll interval within that budget. Defaults to
   * {@link DEFAULT_MSD_REMOUNT_POLL_MS}. */
  msdRemountPollMs?: number;
  /** Injectable delay, used for both the MSD settle wait and the remount
   * poll loop. Defaults to a real, `unref()`'d `setTimeout`-based delay.
   * Tests substitute an instant/deterministic delay so the settle/poll
   * timing this ticket adds does not make the suite slow. */
  delay?: DelayFn;
  /** Wall-clock reader for the remount poll's own deadline. Defaults to
   * `Date.now`. Tests substitute a fake, manually-advanced clock paired
   * with a fake `delay` so a 10s poll budget resolves instantly. */
  now?: () => number;
  /** Injectable check for whether the MSD volume is currently present.
   * Defaults to a real filesystem check (`fs.access`). Tests substitute
   * a fake that reports the volume disappearing and reappearing on a
   * schedule, without a real board. */
  volumeExists?: VolumeExistsFn;
}

/**
 * Orchestrate a full flash: extract the universal-hex v2 block (if
 * `hexText` is a universal hex at all -- a plain Intel hex passes
 * through unchanged), validate the result structurally, try
 * {@link flashViaDapLink}, and fall back to {@link flashViaMsd} only
 * when the SWD attempt itself failed to attach or program (never on a
 * successful-but-slow write -- a `FlashSuccess` from `flashViaDapLink`
 * is returned as-is, with no fallback attempted).
 *
 * Per the module doc's "Validate before erasing anything" rule: hex
 * extraction and structural validation both happen **before**
 * {@link flashViaDapLink} is called at all, so a malformed hex is
 * rejected with no board ever attached to, let alone erased.
 *
 * The MSD fallback is skipped (the original SWD failure is returned
 * unchanged) whenever `resolveVolumePath` cannot find a mounted volume
 * for this device -- there is nothing to copy to. Always resolves to a
 * {@link FlashOutcome}, never throws.
 */
export async function flash(
  device: DaplinkDevice,
  hexText: string,
  onProgress: (phase: FlashPhase) => void,
  options?: FlashOptions,
): Promise<FlashOutcome> {
  const extracted = isUniversalHex(hexText) ? extractV2Hex(hexText) : hexText;

  const validation = isValidIntelHexText(extracted);
  if (!validation.valid) {
    return {
      status: "error",
      method: "swd",
      reason: "invalid-hex",
      error: validation.reason ?? "hex failed structural validation",
    };
  }

  const swdOutcome = await flashViaDapLink(device, extracted, onProgress, {
    ...(options?.createDapLink !== undefined ? { createDapLink: options.createDapLink } : {}),
    ...(options?.connectTimeoutMs !== undefined ? { connectTimeoutMs: options.connectTimeoutMs } : {}),
    ...(options?.flashTimeoutMs !== undefined ? { flashTimeoutMs: options.flashTimeoutMs } : {}),
    ...(options?.flashIdleTimeoutMs !== undefined ? { flashIdleTimeoutMs: options.flashIdleTimeoutMs } : {}),
  });
  if (swdOutcome.status === "ok") {
    return swdOutcome;
  }

  const resolveVolumePath = options?.resolveVolumePath ?? defaultResolveVolumePath;
  const volumePath = await resolveVolumePath(device);
  if (volumePath === undefined) {
    // No fallback target -- the SWD failure is the final result.
    return swdOutcome;
  }

  const delay = options?.delay ?? defaultDelay;
  const now = options?.now ?? (() => Date.now());
  const volumeExists = options?.volumeExists ?? defaultVolumeExists;
  const settleMs = options?.msdSettleMs ?? DEFAULT_MSD_SETTLE_MS;
  const remountTimeoutMs = options?.msdRemountTimeoutMs ?? DEFAULT_MSD_REMOUNT_TIMEOUT_MS;
  const remountPollMs = options?.msdRemountPollMs ?? DEFAULT_MSD_REMOUNT_POLL_MS;

  try {
    // Sprint 017 ticket 004: settle before writing at all -- a volume
    // that has just been (re)mounted (e.g. right after the SWD attempt
    // that itself just failed) benefits from a short window first.
    await delay(settleMs);
    onProgress("writing");
    await flashViaMsd(volumePath, Buffer.from(extracted, "utf-8"), {
      ...(options?.writeFile !== undefined ? { writeFile: options.writeFile } : {}),
    });
    // `writeFile` returning is not "done" -- DAPLink's bootloader still
    // has to erase/flash/reset the target from the file it was just
    // handed, observable only as the volume disappearing and
    // reappearing. Report "resetting" now (the write that triggers that
    // process has just been handed off) and wait for it (best-effort)
    // before resolving success -- see `waitForVolumeRemount`'s own doc
    // comment.
    onProgress("resetting");
    await waitForVolumeRemount(volumePath, {
      volumeExists,
      delay,
      now,
      timeoutMs: remountTimeoutMs,
      pollMs: remountPollMs,
    });
    return { status: "ok", method: "msd" };
  } catch (error) {
    return {
      status: "error",
      method: "msd",
      reason: "write-failed",
      error: errorMessage(error),
    };
  }
}
