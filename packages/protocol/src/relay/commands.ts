/**
 * relay/commands.ts — the relay command-plane wire grammar: pure
 * line-builders, the reply-side parser/classifier, a preamble step
 * table, and the radio frame-size validators.
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
 * serial ports, no timers, no `Session`. Parsing a string is not I/O —
 * {@link parseRelayStatusLine}/{@link classifyRelayReply} read reply
 * text the same way `v6/codec.ts`'s `decodeLine` reads a wire line, and
 * belong here for the same reason: this is the one place that knows the
 * relay's own reply grammar, so a transport orchestrating the handshake
 * does not have to reimplement it.
 *
 * Because this module has no I/O, it correspondingly has no state
 * machine of its own: {@link relayPreambleSteps} hands back a plain,
 * ordered array of steps (line + label + confirmation predicate) and
 * nothing more. It does NOT bundle multiple steps into one function
 * call, and does NOT provide anything that would let a caller skip
 * inspecting a reply between steps. That is a deliberate shape, not an
 * omission — it is what makes two invariants enforceable one layer up,
 * in whatever orchestrator drives the handshake over a real transport:
 *
 *   - **A `!CG` rejection must leave the relay in the command plane.**
 *     Because each step is a separate array entry with its own
 *     `confirms` predicate, an orchestrator can inspect the `!CG` step's
 *     reply and simply stop, never reaching the `!GO` step — there is
 *     no combined "send `!CG` then `!GO`" function here that could
 *     paper over that choice.
 *   - **`!GO` must never hang un-timed-out.** This module cannot
 *     itself enforce a timeout (it has no clock, no I/O), so it
 *     enforces the *contract* instead: every step is plain data, never
 *     a promise or anything else a caller could accidentally `await`
 *     forever. Bounding the wait for a confirmation reply is the
 *     orchestrator's job, over whatever scheduler it is given.
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
 * itself.
 */

import { validateRadioAddress } from "../radioAddress.js";

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
 * Range-checked via `radioAddress.ts`'s {@link validateRadioAddress}
 * (channel odd in `[25, 73]`, group in `[1, 126]` excluding the
 * reserved `10`) — a caller building an address should get it from
 * `nameToRadioAddress` in the first place, but this refuses a malformed
 * pair outright rather than silently sending it over the radio.
 */
export function buildSetChannelGroupLine(channel: number, group: number): string {
  if (!Number.isInteger(channel)) {
    throw new RelayCommandError(`channel must be an integer, got ${channel}`);
  }
  if (!Number.isInteger(group)) {
    throw new RelayCommandError(`group must be an integer, got ${group}`);
  }
  if (!validateRadioAddress(channel, group)) {
    throw new RelayCommandError(
      `(${channel}, ${group}) is not a derived radio address -- channel must be odd in [25, 73], group in [1, 126] excluding the reserved value 10`,
    );
  }
  return `!CG ${channel} ${group}\n`;
}

/**
 * Transiently tune the relay to `(channel, group)` without persisting
 * it to flash (`!CGT`, rearch-12's proposed firmware addition — apply
 * immediately via `applyRadioConfig()`, but skip `saveConfig()`; the
 * next persisted `!CG`/reset restores the saved pair). Intended for a
 * background sweep that retunes far more often than a persisted `!CG`
 * can tolerate (flash is rated for a bounded number of erase cycles per
 * page). Same range-check as {@link buildSetChannelGroupLine}; a
 * caller must feature-detect the relay's advertised capability before
 * relying on this line having any effect (older firmware simply does
 * not recognize `!CGT`).
 */
export function buildTransientChannelGroupLine(channel: number, group: number): string {
  if (!Number.isInteger(channel)) {
    throw new RelayCommandError(`channel must be an integer, got ${channel}`);
  }
  if (!Number.isInteger(group)) {
    throw new RelayCommandError(`group must be an integer, got ${group}`);
  }
  if (!validateRadioAddress(channel, group)) {
    throw new RelayCommandError(
      `(${channel}, ${group}) is not a derived radio address -- channel must be odd in [25, 73], group in [1, 126] excluding the reserved value 10`,
    );
  }
  return `!CGT ${channel} ${group}\n`;
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
 * confirmation is deliberately left to the orchestrator driving this
 * step over a real transport, not this function.
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

/**
 * Send `text` over the radio through the relay's already-tuned
 * command-plane pass-through (`> <text>`, rearch-12's description §2/
 * §3.1), without entering the data plane via `!GO`. Lets a caller probe
 * a robot (e.g. `> ID`) and read back whatever `< <text>` lines the
 * relay forwards, then move on to the next robot without a `!GO`/reset
 * round trip. Refuses an empty string or one containing a newline —
 * neither is representable as a single wire line.
 */
export function buildRadioSendLine(text: string): string {
  if (text.length === 0) {
    throw new RelayCommandError("text must not be empty");
  }
  if (/[\r\n]/.test(text)) {
    throw new RelayCommandError(`text must not contain a newline: ${JSON.stringify(text)}`);
  }
  return `> ${text}\n`;
}

// ---------------------------------------------------------------------
// Reply-side grammar: parse and classify the relay's own `#` lines
// ---------------------------------------------------------------------

/** One relay status line's fields, positionally parsed from
 * `# channel: <ch> group: <grp> mode: <mode> power: <power>` — the
 * reply every one of `!CG`/`!P`/`?` confirms with (the live capture:
 * `sent '!CG 47 60' -> # channel: 47 group: 60 mode: RAW250 power: 7`). */
export interface RelayStatusLine {
  readonly channel: number;
  readonly group: number;
  readonly mode: string;
  readonly power: number;
}

const STATUS_LINE_PATTERN =
  /^#\s*channel:\s*(\d+)\s+group:\s*(\d+)\s+mode:\s*(\S+)\s+power:\s*(\d+)\b/i;

/**
 * Parse one relay status reply line into its four fields. `null` for
 * anything that does not match the shape — including a status-*looking*
 * line missing a field (e.g. no `power:`) — this never guesses at a
 * partial match.
 */
export function parseRelayStatusLine(line: string): RelayStatusLine | null {
  const match = STATUS_LINE_PATTERN.exec(line.trimStart());
  if (!match) {
    return null;
  }
  const channelText = match[1]!;
  const groupText = match[2]!;
  const mode = match[3]!;
  const powerText = match[4]!;
  return {
    channel: Number(channelText),
    group: Number(groupText),
    mode,
    power: Number(powerText),
  };
}

/** Which shape a relay's `#`-prefixed reply line takes. `"status"` is
 * the full `# channel: ... power: ...` line ({@link parseRelayStatusLine}
 * parses it); `"echo"`/`"mode"` are the single-field acknowledgements
 * for `!ECHO`/`!MODE`; `"enteringDataPlane"` is `!GO`'s confirmation;
 * `"error"` is a rejection of whatever command was just sent;
 * `"comment"` is any other `#`-prefixed text (boot banner, `!HELP`
 * output); `"other"` is anything not even `#`-prefixed (radio `DBG:`
 * chatter, an echoed command). */
export type RelayReplyKind =
  | "status"
  | "echo"
  | "mode"
  | "enteringDataPlane"
  | "error"
  | "comment"
  | "other";

const ECHO_PATTERN = /^#\s*echo:\s*(ON|OFF)\b/i;
const MODE_PATTERN = /^#\s*mode:\s*\S+/i;
const ENTERING_DATA_PLANE_PATTERN = /^#\s*entering data plane\b/i;
const ERROR_PATTERN = /^#\s*error\b/i;

/**
 * Classify one raw reply line from the relay's command plane. Checked
 * in this fixed order so a full status line (which itself contains
 * `mode: ...`) is never mistaken for a bare `"# mode: ..."`
 * acknowledgement: `"status"` (has `channel:`/`group:`) is checked
 * before `"mode"`.
 */
export function classifyRelayReply(line: string): RelayReplyKind {
  const trimmed = line.trimStart();
  if (STATUS_LINE_PATTERN.test(trimmed)) {
    return "status";
  }
  if (ECHO_PATTERN.test(trimmed)) {
    return "echo";
  }
  if (MODE_PATTERN.test(trimmed)) {
    return "mode";
  }
  if (ENTERING_DATA_PLANE_PATTERN.test(trimmed)) {
    return "enteringDataPlane";
  }
  if (ERROR_PATTERN.test(trimmed)) {
    return "error";
  }
  if (trimmed.startsWith("#")) {
    return "comment";
  }
  return "other";
}

// ---------------------------------------------------------------------
// Preamble step table
// ---------------------------------------------------------------------

/** One step of the command-plane preamble: the wire line to send, a
 * human-readable label for diagnostics/error messages, and a predicate
 * that tells an orchestrator whether a given reply line confirms THIS
 * step (never bundled with sending the next step — see the module doc
 * comment's two invariants). */
export interface RelayPreambleStep {
  readonly line: string;
  readonly label: string;
  readonly confirms: (reply: string) => boolean;
}

/**
 * The full `!ECHO OFF` -> `!MODE RAW250` -> `!CG <ch> <grp>` -> `!P 7`
 * -> `!GO` preamble, as one ordered, pure array — each entry pairs a
 * line with the predicate that recognizes its own confirmation, so an
 * orchestrator (over a real transport, with real timeouts) can drive
 * connect and a sweep off one shared definition instead of each
 * re-deriving the step order and its reply matching independently.
 */
export function relayPreambleSteps(channel: number, group: number): readonly RelayPreambleStep[] {
  return [
    {
      line: buildEchoOffLine(),
      label: "!ECHO OFF",
      confirms: (reply) => classifyRelayReply(reply) === "echo",
    },
    {
      line: buildModeRaw250Line(),
      label: "!MODE RAW250",
      confirms: (reply) => classifyRelayReply(reply) === "mode",
    },
    {
      line: buildSetChannelGroupLine(channel, group),
      label: `!CG ${channel} ${group}`,
      confirms: (reply) => {
        const status = parseRelayStatusLine(reply);
        return status !== null && status.channel === channel && status.group === group;
      },
    },
    {
      line: buildSetPowerLine(),
      label: "!P 7",
      confirms: (reply) => {
        const status = parseRelayStatusLine(reply);
        return status !== null && status.power === 7;
      },
    },
    {
      line: buildGoLine(),
      label: "!GO",
      confirms: (reply) => classifyRelayReply(reply) === "enteringDataPlane",
    },
  ];
}

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
