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
 *      and `releases.ts`'s convention: {@link flashOverSwd} and
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
 * student might be mid-session with. `flashOverSwd` in this module does
 * the opposite on purpose: flashing fundamentally requires halting,
 * erasing, writing, and resetting the target — there is no way to
 * program new firmware without interrupting whatever is currently
 * running. Do not "fix" one module by copying the other's constraint:
 * `swdName.ts`'s no-halt rule exists for a use case (naming a live
 * board) that does not apply here, and this module's halt/reset sequence
 * exists for a use case (recovering a board that already failed to
 * identify) where the target is not expected to have anything running
 * worth preserving.
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
 */

import { readdir, readFile as fsReadFile, writeFile as fsWriteFile } from "node:fs/promises";
import path from "node:path";
import { HID as NodeHidDevice } from "node-hid";
// `dapjs` ships only a UMD bundle (no ESM build, no `__esModule` marker) --
// see `swdName.ts`'s own doc comment for the full explanation of why the
// runtime value must come from the default import while the named types
// are imported `type`-only. Same import shape is followed here.
import DapJs from "dapjs";
import type { DAPLink } from "dapjs";
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
    | "write-failed";
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
  const transport = new DapJs.HID(hidDevice);
  return new DapJs.DAPLink(transport);
}

/**
 * Flash `hex` (already extracted to a plain, v2-only Intel hex — see
 * {@link flash}, which is the caller that does that extraction) onto
 * `device` over SWD, using `dapjs`'s `DAPLink` vendor-command flash
 * protocol against the same CMSIS-DAP HID handle `swdName.ts` uses
 * (`device.hid.path`).
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
 */
export async function flashOverSwd(
  device: DaplinkDevice,
  hex: string,
  onProgress: (phase: FlashPhase) => void,
  options?: { createDapLink?: DapLinkFactory },
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
  let daplink: DAPLink;
  try {
    daplink = createDapLink(hidPath);
  } catch (error) {
    const { reason, error: message } = classifyAttachError(error);
    return { status: "error", method: "swd", reason, error: message };
  }

  try {
    await daplink.connect();
  } catch (error) {
    const { reason, error: message } = classifyAttachError(error);
    return { status: "error", method: "swd", reason, error: message };
  }

  const reportWriting = () => onProgress("writing");
  try {
    onProgress("erasing");
    daplink.on(DapJs.DAPLink.EVENT_PROGRESS, reportWriting);
    await daplink.flash(Buffer.from(hex, "utf-8"));
    onProgress("resetting");
    return { status: "ok", method: "swd" };
  } catch (error) {
    return {
      status: "error",
      method: "swd",
      reason: "program-failed",
      error: errorMessage(error),
    };
  } finally {
    // `dapjs`'s `DAPLink` extends `CmsisDAP`, whose TypeScript typings
    // declare it as a Node `events.EventEmitter` (which has both `.off`
    // and `.removeListener`) -- but the actual runtime object, verified
    // against real hardware, is backed by dapjs's own bundled UMD event
    // emitter, which implements `on`/`emit`/`removeListener` but has no
    // `.off` alias at all. Calling `.off` here threw `"daplink.off is
    // not a function"` from inside this `finally` block, which replaced
    // -- silently, since a `finally`-block throw always wins over a
    // `try`-block `return` -- an already-successful `{ status: "ok" }`
    // result with an uncaught rejection. That broke this function's own
    // "always resolves, never throws" contract and, one level up,
    // `deviceRegistry.ts#runFlash` never reached its post-flash
    // `openLink` call, so a board that *had* been flashed correctly
    // never re-announced. `removeListener` is the one method this
    // listener-detach step can rely on existing on both the real
    // runtime object and the Node-shaped type declaration; wrapped in
    // its own try/catch (same as `disconnect()` just below) so that
    // even a `removeListener` failure can never mask or replace
    // whatever result was already determined above.
    try {
      daplink.removeListener(DapJs.DAPLink.EVENT_PROGRESS, reportWriting);
    } catch {
      // Best-effort cleanup only -- see comment above.
    }
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
 * **not** a flash, and not the same operation as {@link flashOverSwd}'s
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
 * Mirrors {@link flashOverSwd}'s own shape and "failure is a value,
 * never throws" contract exactly (HID-path-first, injectable
 * `createDapLink`, best-effort `disconnect()` in a `finally` that can
 * never mask an already-determined result) but with nothing to write
 * and no {@link FlashPhase} progress to report -- just connect, reset,
 * disconnect.
 */
export async function resetOverSwd(
  device: DaplinkDevice,
  options?: { createDapLink?: DapLinkFactory },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const hidPath = device.hid?.path;
  if (hidPath === undefined) {
    return {
      ok: false,
      error: "no HID path available for this device (node-hid could not resolve one)",
    };
  }

  const createDapLink = options?.createDapLink ?? defaultDapLinkFactory;
  let daplink: DAPLink;
  try {
    daplink = createDapLink(hidPath);
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }

  try {
    await daplink.connect();
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }

  try {
    await daplink.reset();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  } finally {
    // Best-effort cleanup only -- see flashOverSwd's own `finally` block
    // for why a failed disconnect must never mask or replace whatever
    // result was already determined above.
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

/**
 * Default MSD volume resolver: list `/Volumes/MICROBIT*` entries
 * (unchanged from the old placeholder's discovery step), read each
 * one's `DETAILS.TXT`, and hand the parsed candidates to
 * {@link findMatchingVolume} to pick the one actually belonging to
 * `device` -- see the module doc's "MSD volume-to-device matching"
 * section. A volume whose `DETAILS.TXT` is missing or unreadable is
 * skipped (not a match, and not a failure of the whole resolution); an
 * empty `/Volumes` listing or a failure listing it at all still returns
 * `undefined`, exactly mirroring the old placeholder's `readdir`
 * try/catch. `listVolumeNames`/`readTextFile` are injectable (defaulting
 * to the real filesystem) purely so this function itself is
 * unit-testable with no real mounted volume -- {@link flash}'s own tests
 * always inject their own `resolveVolumePath` instead of exercising this
 * default (see the module doc).
 */
export async function defaultResolveVolumePath(
  device: DaplinkDevice,
  options?: {
    listVolumeNames?: () => Promise<string[]>;
    readTextFile?: ReadTextFileFn;
  },
): Promise<string | undefined> {
  const listVolumeNames = options?.listVolumeNames ?? (() => readdir("/Volumes"));
  const readTextFile = options?.readTextFile ?? defaultReadTextFile;

  let entries: string[];
  try {
    entries = await listVolumeNames();
  } catch {
    return undefined;
  }

  const candidates: VolumeCandidate[] = [];
  for (const name of entries.filter((entry) => entry.startsWith("MICROBIT"))) {
    const volumePath = path.join("/Volumes", name);
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
  /** Injectable `dapjs`/`node-hid` factory for {@link flashOverSwd}.
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
}

/**
 * Orchestrate a full flash: extract the universal-hex v2 block (if
 * `hexText` is a universal hex at all -- a plain Intel hex passes
 * through unchanged), validate the result structurally, try
 * {@link flashOverSwd}, and fall back to {@link flashViaMsd} only when
 * the SWD attempt itself failed to attach or program (never on a
 * successful-but-slow write -- a `FlashSuccess` from `flashOverSwd` is
 * returned as-is, with no fallback attempted).
 *
 * Per the module doc's "Validate before erasing anything" rule: hex
 * extraction and structural validation both happen **before**
 * {@link flashOverSwd} is called at all, so a malformed hex is rejected
 * with no board ever attached to, let alone erased.
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

  const swdOutcome = await flashOverSwd(device, extracted, onProgress, {
    ...(options?.createDapLink !== undefined ? { createDapLink: options.createDapLink } : {}),
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

  try {
    onProgress("writing");
    await flashViaMsd(volumePath, Buffer.from(extracted, "utf-8"), {
      ...(options?.writeFile !== undefined ? { writeFile: options.writeFile } : {}),
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
