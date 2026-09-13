/**
 * swdName.ts — the load-bearing module of this sprint: read a micro:bit's
 * five-letter friendly name over SWD.
 *
 * Per `docs/design/specification.md` §2.2 and §4.2: the name is a hash of
 * the **target nRF chip's** `FICR.DEVICEID[1]` register at
 * `0x10000064` — not the USB serial number `devices.ts` (ticket 006)
 * reads, which belongs to a *different* chip on the same board (the KL27
 * DAPLink interface MCU). The only way to learn the name is to read that
 * register directly, either from a cooperating firmware's serial banner
 * (`banner.ts`) or, as here, over SWD — which is what still works on a
 * blank, never-flashed board with no firmware running at all.
 *
 * ## Attach, never reset
 *
 * This module calls `CortexM#connect()` and `readMem32()` only — it never
 * halts or resets the target. `mbdeploy`'s `read_device_id()` establishes
 * the same contract on the Python/pyOCD side (`connect_mode="attach"`,
 * `blocking=False`, no halt). A halt/reset would stop or reboot whatever
 * firmware the board is currently running (relay, robot, anything else) —
 * for a robot a student is mid-session with, that means literally
 * interrupting it — just to read five letters. Do not "improve" this by
 * adding a halt "to be safe": it is unnecessary (memory reads work fine
 * without halting the core), and the risk isn't the blank-board case —
 * it's this *running-firmware, don't-disturb-it* case.
 *
 * ## Failure is a value, not an exception
 *
 * SWD attach can fail for reasons outside this module's control: OS HID
 * permissions, an unsupported/locked chip, or the probe being busy with
 * another operation. Per `docs/design/usecases.md` UC-001's error flow, a
 * device that fails to name must still be reported as
 * detected-but-unnamed with the specific reason — never thrown as an
 * uncaught exception (which would take down enumeration of every other
 * board too), and never silently omitted or given a serial-derived
 * fallback name (the exact `microbit-console` mistake this sprint exists
 * to not repeat).
 *
 * ## Every dapjs call is time-bounded (sprint 017 ticket 003)
 *
 * `processor.connect()` and `processor.readMem32()` are each wrapped in
 * `lib/withTimeout.ts`'s {@link withTimeout} — `node-hid`/`dapjs` give no
 * bounded-wait or cancellation of their own, so a wedged transport used
 * to hang the caller (and the board's `board_owner` naming slot) forever
 * (`flash.ts`'s own module doc carries the matching change for its own
 * DAPLink calls). A timeout classifies as `reason: "timeout"` in the
 * returned {@link SwdNameFailure}; `disconnect()` in this function's own
 * `finally` block already runs regardless of which of the two awaits
 * failed, so no additional best-effort cleanup is needed at the timeout
 * site itself.
 */

import { HID as NodeHidDevice } from "node-hid";
// Ticket 014-001: `dapjs` is vendored under `./vendor/dapjs/` (this
// repo's own TypeScript source, not the npm package) -- see that
// directory's README.md. Being our own ESM source (not a UMD bundle),
// both the runtime value and the type come from one ordinary named
// import; the old default-import-plus-type-only-named-import split this
// module used to need (to work around `dapjs`'s package having no ESM
// entry point) no longer applies.
import { HID as HidTransport, CortexM } from "./vendor/dapjs/index.js";
import { deviceIdToName } from "@robot-console/protocol";
import { TimeoutError, withTimeout } from "./lib/withTimeout.js";
import type { DaplinkDevice } from "./devices.js";

/** `FICR.DEVICEID[1]` — the 32-bit word CODAL hashes into the board's
 * five-letter friendly name. Same address on nRF51 and nRF52, so this
 * works unmodified on both micro:bit V1 and V2. */
export const FICR_DEVICEID1 = 0x10000064;

/** A name successfully read and derived over SWD. */
export interface SwdNameSuccess {
  status: "named";
  name: string;
  /** The raw 32-bit `FICR.DEVICEID[1]` value the name was derived from,
   * for diagnostics/logging. */
  deviceId: number;
}

/** SWD attach or read failed; the device is detected (`devices.ts` found
 * it) but its name could not be determined. `reason` distinguishes the
 * two causes `dapjs`/`node-hid` give us enough information to tell
 * apart; `error` is always the underlying message for display/logging. */
export interface SwdNameFailure {
  status: "unnamed";
  reason: "no-hid-path" | "permission" | "attach-failed" | "timeout";
  error: string;
}

export type SwdNameResult = SwdNameSuccess | SwdNameFailure;

/**
 * Pure hand-off: a raw `FICR.DEVICEID[1]` value to a {@link SwdNameResult}.
 * Exists as its own function so the "value in, name out" step — the one
 * genuinely unit-testable part of this module — has something to call
 * without a real SWD read (see `swdName.test.ts`). This is intentionally
 * a thin re-confirmation of `naming.ts`'s own contract at this call site,
 * not new logic.
 */
export function swdNameResultFromDeviceId(deviceId: number): SwdNameSuccess {
  return { status: "named", name: deviceIdToName(deviceId), deviceId };
}

/** Classify a caught error into the distinguishable failure reasons
 * `dapjs`/`node-hid` give us. Permission failures surface recognizable
 * substrings (`EACCES`, `EPERM`, "permission", "access") from the OS or
 * HID backend; anything else is bucketed as a generic attach failure
 * (unsupported chip, locked part, probe busy, etc. — `dapjs` does not
 * give us enough to split those further). */
function classifyAttachError(error: unknown): SwdNameFailure {
  const message = error instanceof Error ? error.message : String(error);
  const reason: SwdNameFailure["reason"] = /eacces|eperm|permission|access denied/i.test(
    message,
  )
    ? "permission"
    : "attach-failed";
  return { status: "unnamed", reason, error: message };
}

/** Function shape used to obtain a fully-formed SWD transport/processor
 * pair from an HID path. Defaults to the real `node-hid` + `dapjs` stack;
 * overridable so callers (not tests — see the module/ticket doc for why
 * this is deliberately not unit-tested against a mock) can substitute a
 * different HID backend if ever needed. */
export type CortexMFactory = (hidPath: string) => CortexM;

function defaultCortexMFactory(hidPath: string): CortexM {
  const hidDevice = new NodeHidDevice(hidPath);
  const transport = new HidTransport(hidDevice);
  return new CortexM(transport);
}

/** Default bound on `processor.connect()`. Overridable via
 * {@link ReadSwdNameOptions.connectTimeoutMs}. */
export const DEFAULT_SWD_CONNECT_TIMEOUT_MS = 3_000;

/** Default bound on `processor.readMem32()` — a single 32-bit register
 * read, so this stays short. Overridable via
 * {@link ReadSwdNameOptions.readTimeoutMs}. */
export const DEFAULT_SWD_READ_TIMEOUT_MS = 3_000;

export interface ReadSwdNameOptions {
  createCortexM?: CortexMFactory;
  /** See {@link DEFAULT_SWD_CONNECT_TIMEOUT_MS}. */
  connectTimeoutMs?: number;
  /** See {@link DEFAULT_SWD_READ_TIMEOUT_MS}. */
  readTimeoutMs?: number;
}

/**
 * Read a joined `devices.ts` record's five-letter name over SWD.
 *
 * Attaches to the target via the record's CMSIS-DAP HID handle
 * (`device.hid.path`), reads {@link FICR_DEVICEID1} with `readMem32`, and
 * hands the raw value to `naming.ts`. Never halts, resets, or requires
 * cooperating firmware — see the module doc.
 *
 * Always resolves, never rejects: any failure (no HID path, permission
 * denied, attach/read failure, a timeout on either call) comes back as a
 * {@link SwdNameFailure} rather than a thrown error, so a caller
 * enumerating many devices can name each independently without one bad
 * board taking the others down.
 */
export async function readSwdName(
  device: DaplinkDevice,
  options?: ReadSwdNameOptions,
): Promise<SwdNameResult> {
  const hidPath = device.hid?.path;
  if (hidPath === undefined) {
    return {
      status: "unnamed",
      reason: "no-hid-path",
      error: "no HID path available for this device (node-hid could not resolve one)",
    };
  }

  const createCortexM = options?.createCortexM ?? defaultCortexMFactory;
  const connectTimeoutMs = options?.connectTimeoutMs ?? DEFAULT_SWD_CONNECT_TIMEOUT_MS;
  const readTimeoutMs = options?.readTimeoutMs ?? DEFAULT_SWD_READ_TIMEOUT_MS;
  let processor: CortexM;
  try {
    processor = createCortexM(hidPath);
  } catch (error) {
    return classifyAttachError(error);
  }

  try {
    await withTimeout(processor.connect(), connectTimeoutMs, "processor.connect()");
    const deviceId = await withTimeout(processor.readMem32(FICR_DEVICEID1), readTimeoutMs, "processor.readMem32()");
    return swdNameResultFromDeviceId(deviceId);
  } catch (error) {
    if (error instanceof TimeoutError) {
      return { status: "unnamed", reason: "timeout", error: error.message };
    }
    return classifyAttachError(error);
  } finally {
    try {
      await processor.disconnect();
    } catch {
      // Best-effort cleanup only — a failed disconnect must not mask
      // (or replace) whatever result/error was already determined above.
    }
  }
}
