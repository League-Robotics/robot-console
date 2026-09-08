/**
 * relay/commands.ts — the relay command-plane wire grammar: pure
 * line-builders plus the radio frame-size validators. Named (and
 * deliberately left uncreated) in sprint 004's own Design Rationale: "a
 * module whose only purpose is to be shared by two transports that
 * don't exist yet ... is exactly the 'speculative generality'
 * anti-pattern." Sprint 007's `RelayRadioLink`/`MbrelayLink` (tickets
 * 002/003) are the real consumers, so this module exists now.
 *
 * Normative spec: `docs/design/specification.md` §3.7/§4.3/§6. Live
 * verification of the wire text this module produces:
 * `vendor/pxt-nezha-diffdrive/captures/radio-addressing-20260830.md`
 * §4 (`sent '!CG 47 60' -> # channel: 47 group: 60 mode: RAW250
 * power: 7`) and `vendor/pxt-nezha-diffdrive/tools/link.py`'s own
 * `relay_setup_lines()` (informative, not ported line-for-line — that
 * module also owns transport/timing concerns this one deliberately
 * does not).
 *
 * ---- This module is pure data in, pure data out — no I/O, ever ----
 *
 * Every export here is a plain function or constant: no sockets, no
 * serial ports, no timers, no `Session`, no knowledge of which
 * transport will eventually send a line or how it will recognize a
 * reply. That is what lets `RelayRadioLink` (USB) and `MbrelayLink`
 * (TCP) share one command-plane implementation
 * (`host/link/RelayCommandPlane.ts`, ticket 002) instead of each
 * re-deriving the preamble and its failure handling independently —
 * the same discipline `v6/session.ts` already applies to ack/nack
 * arithmetic.
 *
 * Because this module has no I/O, it correspondingly has no reply
 * parsing and no state machine: it hands back one line of wire text
 * per call and nothing more. It does NOT bundle multiple preamble
 * steps into one function, and does NOT provide anything that would
 * let a caller skip inspecting a reply between steps. That is a
 * deliberate shape, not an omission — it is what makes the two
 * sprint-wide invariants enforceable one layer up, in
 * `RelayCommandPlane` (ticket 002):
 *
 *   - **A `!CG` rejection must leave the relay in the command plane.**
 *     Because {@link buildSetChannelGroupLine} and {@link buildGoLine}
 *     are two separate calls, not one, `RelayCommandPlane` can inspect
 *     the `!CG` reply and simply never call {@link buildGoLine} on a
 *     rejection — there is no combined "send `!CG` then `!GO`"
 *     function here that could paper over that choice.
 *   - **`!GO` must never hang un-timed-out.** This module cannot
 *     itself enforce a timeout (it has no clock, no I/O), so it
 *     enforces the *contract* instead: {@link buildGoLine} only ever
 *     returns wire text, never a promise or anything else a caller
 *     could accidentally `await` forever. Bounding the wait for a
 *     confirmation reply is `RelayCommandPlane`'s job, over whatever
 *     scheduler it is given.
 *   - **There is no in-band escape from the data plane.** Once `!GO`
 *     has been sent and confirmed, the relay is in the data plane
 *     (specification.md §6: "the only way back to the command plane
 *     is a reset"). This module reflects that as a one-way fact about
 *     the wire, not as a state object with a `back()` method — there
 *     is nothing to expose here that would suggest one exists.
 *
 * ---- `#` lines are comments, never commands ----
 *
 * Per the relay's own reply grammar (see the live capture above), a
 * leading-`#` line is the relay's own confirmation/comment text (e.g.
 * `# channel: 47 group: 60 mode: RAW250 power: 7`), not a command —
 * this module never builds one, and a caller must never send one.
 *
 * ---- `HELLO` is deliberately absent from this module ----
 *
 * `HELLO` is a **v6 session reset** (`v6/session.ts`'s own "`HELLO` is
 * a reset, not a health check" section), not a relay command-plane
 * verb — the relay hands `HELLO` straight through to the robot once
 * the data plane is reached. It is sent exactly once, by
 * `Session.connect()`, and nowhere else. There is deliberately no
 * `buildHelloLine` (or equivalent) in this module: adding one here —
 * "for completeness", since every other verb in the preamble list gets
 * a builder — would hand a future caller an easy way to reconstruct an
 * ongoing liveness probe that resets the session out from under
 * itself. {@link PING_LINE}/{@link STATUS_LINE} are exported below
 * specifically as the correct alternative to reach for instead.
 */

import { encodeLine } from "../v6/codec.js";

// ---------------------------------------------------------------------
// Command-plane preamble line-builders
// ---------------------------------------------------------------------

/**
 * Turn the relay's echo transponder off. Without this, the relay
 * re-transmits received radio traffic back over the air on the
 * channel it is listening to (see `vendor/pxt-nezha-diffdrive/tools/
 * link.py`'s `relay_setup_lines` doc comment: "`!ECHO` is a
 * transponder, not terminal echo").
 */
export function buildEchoOffLine(): string {
  return "!ECHO OFF\n";
}

/** Put the relay into RAW250 frame mode (247-byte payload cap — see
 * {@link validateFrameSize}). */
export function buildModeRaw250Line(): string {
  return "!MODE RAW250\n";
}

/** Raised for caller misuse this module can catch structurally — an
 * out-of-range `channel`/`group` passed to
 * {@link buildSetChannelGroupLine}. Mirrors `v6/codec.ts`'s
 * `CodecError`/`v6/session.ts`'s `SessionError` posture: one small,
 * named error type per module, thrown only for a caller's own
 * programming error, never for anything that arrives over the wire
 * (this module never reads the wire at all). */
export class RelayCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RelayCommandError";
  }
}

/**
 * Tune the relay to `(channel, group)` — the radio address a robot's
 * default address (`radioAddress.ts`'s `nameToRadioAddress`) or a
 * registry lookup resolves to. Must be sent every time, even if the
 * relay already happens to be tuned correctly: the relay **persists**
 * its config across resets, so a previous session's channel/group is
 * silently inherited by any carrier that does not restate it (see this
 * module's own doc comment / `link.py`'s `relay_setup_lines`).
 *
 * `channel`/`group` are passed through verbatim as base-10 integers —
 * this function does not validate them against
 * `radioAddress.ts`'s legal ranges (25-73 step 2 / 1-126 excluding 10);
 * a caller building an address should get it from
 * {@link nameToRadioAddress} in the first place. It does reject a
 * non-finite-integer input outright, the same class of caller error
 * `encodeLine` itself refuses.
 */
export function buildSetChannelGroupLine(channel: number, group: number): string {
  if (!Number.isInteger(channel)) {
    throw new RelayCommandError(`channel must be an integer, got ${channel}`);
  }
  if (!Number.isInteger(group)) {
    throw new RelayCommandError(`group must be an integer, got ${group}`);
  }
  return `!CG ${channel} ${group}\n`;
}

/** Set the relay's radio transmit power to its documented level 7 (see
 * the live capture: `# channel: ... group: ... mode: RAW250 power: 7`
 * confirms `!P 7` sets "power", not a pacing/timing value). */
export function buildSetPowerLine(): string {
  return "!P 7\n";
}

/**
 * Hand the relay off from the command plane to the transparent data
 * plane. After this is sent and confirmed, ordinary v6 line traffic
 * flows through the relay unmodified, and — per specification.md §6 —
 * **there is no in-band way back**: over TCP a break cannot be sent at
 * all, and even a local serial relay only recovers via a reset. See
 * this module's own doc comment for why bounding the wait for `!GO`'s
 * confirmation is deliberately left to `RelayCommandPlane` (ticket
 * 002), not this function.
 */
export function buildGoLine(): string {
  return "!GO\n";
}

/**
 * Query the relay's current command-plane settings. Useful for a
 * caller that wants to confirm what the relay is currently tuned to
 * before restating the preamble (e.g. diagnostics), without side
 * effects.
 */
export function buildQueryLine(): string {
  return "?\n";
}

// ---------------------------------------------------------------------
// Liveness pair — data, not a runner
// ---------------------------------------------------------------------

/**
 * The unsequenced `PING` line, exactly as `v6/session.ts`'s
 * `Session.checkLiveness()` produces it (`encodeLine("PING")`).
 * Exported here as plain data — not a function this module calls
 * itself, since this module performs no I/O — so that a caller
 * reaching for "how do I check liveness without HELLO" finds this
 * instead of reconstructing `HELLO` by hand. Actually sending a
 * liveness probe still goes through `Session.checkLiveness()`
 * (SUC-006: "no transport-specific liveness logic exists to test
 * separately"); this constant exists for reference/documentation
 * parity with {@link STATUS_LINE}, not as a second code path.
 */
export const PING_LINE: string = encodeLine("PING");

/**
 * The unsequenced `STATUS` line, exactly as `Session.sendUnsequenced("STATUS")`
 * would produce it (`encodeLine("STATUS")`) — alive, plus where the
 * sequence currently stands. See {@link PING_LINE}'s doc comment: data
 * only, not a second send path.
 */
export const STATUS_LINE: string = encodeLine("STATUS");

// ---------------------------------------------------------------------
// Frame-size validators
// ---------------------------------------------------------------------

/** Which radio frame mode a payload is being checked against — see
 * {@link buildModeRaw250Line}. MakeCode-compatible mode caps a frame at
 * 16 bytes; RAW250 (this preamble's own target mode) caps it at 247. */
export type RelayFrameMode = "makecode" | "raw250";

/** Inclusive per-mode payload byte caps (specification.md §6: "Keep
 * every message in one frame: <=16 bytes for MAKECODE mode, <=247 bytes
 * for RAW250 mode"). A payload exactly at the cap is valid; the radio
 * is fire-and-forget with no retransmit, so neither truncation nor
 * fragmentation is supported — see {@link validateFrameSize}. */
const FRAME_SIZE_CAP_BYTES: Readonly<Record<RelayFrameMode, number>> = {
  makecode: 16,
  raw250: 247,
};

/** {@link validateFrameSize} succeeded: `payloadBytes` fits within the
 * mode's cap. */
export interface FrameSizeOk {
  readonly ok: true;
}

/** {@link validateFrameSize} failed: `payloadBytes` exceeds the mode's
 * cap. `reason` is a human-readable message a caller can surface
 * directly (e.g. in a refused-write UI message) — there is nothing
 * else to inspect, since there is no truncated/fragmented value to
 * offer instead. */
export interface FrameSizeRefusal {
  readonly ok: false;
  readonly reason: string;
}

export type FrameSizeResult = FrameSizeOk | FrameSizeRefusal;

/**
 * Check `payloadBytes` against `mode`'s frame-size cap (16 bytes for
 * `"makecode"`, 247 for `"raw250"` — {@link FRAME_SIZE_CAP_BYTES}).
 *
 * Returns a value in both outcomes; **never throws**. There is no
 * truncation or fragmentation code path anywhere in this module — the
 * radio protocol supports neither (specification.md §6), so an
 * oversized frame is refused outright, before any write is attempted,
 * rather than silently reduced to something that would fit.
 *
 * A payload exactly at the cap (16/247) succeeds; one byte over (17/248)
 * fails.
 */
export function validateFrameSize(mode: RelayFrameMode, payloadBytes: number): FrameSizeResult {
  const cap = FRAME_SIZE_CAP_BYTES[mode];
  if (payloadBytes > cap) {
    return {
      ok: false,
      reason: `${mode} frame is ${payloadBytes} bytes, exceeding the ${cap}-byte cap for this mode -- the radio protocol supports neither truncation nor fragmentation (specification.md S6), so this frame must be refused, not shrunk`,
    };
  }
  return { ok: true };
}
