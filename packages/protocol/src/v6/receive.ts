/**
 * v6/receive.ts — the pure receive-path facade.
 *
 * A raw inbound line must be run through a fixed sequence of steps
 * before anything can safely dispatch it: decode (`codec.ts`'s
 * `decodeLine`) -> classify direction (`classifyLine`) -> drop a blank/
 * over-length/foreign line -> feed an `ack`/`nack` to the `Session` --
 * whose resend lines must go out over the wire BEFORE the line itself
 * is dispatched to any listener (protocol.md §8.1: "resend from next
 * forward, in order" only holds if the resend is not itself reordered
 * behind other traffic). Getting the *sequence of calls* wrong (e.g.
 * dispatching before a resend goes out, or skipping the classify step
 * and treating a foreign line as a protocol reply) is a real logged bug
 * in a sibling project — every transport that hand-rolls this sequence
 * independently risks it again.
 *
 * {@link receive} is that sequence, as one pure function: no I/O, no
 * transport, no clock. It returns everything a caller needs to finish
 * the job (which lines to write first, what to dispatch, what to log),
 * in a shape that makes the ordering hard to get wrong: `resend` is a
 * separate field a caller writes before looking at anything else in the
 * result.
 */
import { classifyLine, decodeLine, type DecodedLine } from "./codec.js";
import type { AckNackEvent, MalformedReplyEvent, Session } from "./session.js";

/** Options to {@link receive}. */
export interface ReceiveOptions {
  /**
   * Called with the raw line text whenever `classifyLine` drops it as
   * `"foreign"` — a lowercase verb this build does not recognize as a
   * reply (protocol.md §2.1: on a shared radio channel, another
   * device's own traffic overheard; on USB, more often a firmware
   * reply this client's `REPLY_VERBS` allowlist has not yet been taught
   * — see that constant's own doc comment for a logged history of
   * exactly this). Optional and absent by default, matching
   * `decodeLine`/`classifyLine`'s own "quiet unless asked" posture — a
   * caller that wants visibility into what is being dropped (to log it,
   * or to notice a firmware reply worth adding to the allowlist) opts in
   * here rather than every caller paying for logging it never asked
   * for.
   */
  readonly onForeign?: (raw: string) => void;
}

/** The result of feeding one raw line to {@link receive}. */
export interface ReceiveResult {
  /**
   * Wire line(s) a `nack` requires resending, byte-identical, in
   * ascending id order — always empty except for a well-formed `nack`
   * with something outstanding to resend. A caller MUST write these
   * (through its own paced write path) before doing anything else with
   * this result — that ordering is the entire reason this field exists
   * separately rather than being folded into `ackNack.resend`.
   */
  readonly resend: readonly string[];
  /**
   * The `ack`/`nack` outcome, present only when the incoming line was
   * one of those two verbs — a well-formed one as an {@link
   * AckNackEvent}, a malformed one as a {@link MalformedReplyEvent}
   * (never thrown; see `Session.handleReply`'s own doc comment).
   * Absent for every other reply verb and for anything dropped or
   * unrouted below.
   */
  readonly ackNack?: AckNackEvent | MalformedReplyEvent;
  /**
   * The decoded line, present whenever `classifyLine` classified this
   * line `"reply"` direction — what a caller should dispatch to its own
   * reply listeners (`ack`/`nack` included, exactly like the event
   * above is additional information about the same line, not a
   * replacement for it).
   */
  readonly line?: DecodedLine;
  /**
   * Raw text, present instead of `line` for a command-direction line
   * (an echo) or a foreign line that is not silently dropped — the
   * console still needs to show this even though it is not a decoded
   * v6 reply (a relay's own `#`-prefixed comment text, a board's other-
   * dialect chatter, overheard traffic once tapped via `onForeign`).
   */
  readonly unrouted?: string;
  /**
   * Set when this line was dropped outright with nothing at all for a
   * caller to show: `"blank"` (protocol.md §2 — silently ignored, not
   * malformed) or `"tooLong"` (the 240-byte wire cap). A `"foreign"`
   * line is NOT reported here — see `unrouted`/`onForeign` above; a
   * caller relying on `dropped === undefined` to mean "there is
   * something to show" is never surprised by a foreign line vanishing
   * silently out from under it.
   */
  readonly dropped?: "blank" | "tooLong";
}

/**
 * Run one raw inbound line through decode -> classify -> drop ->
 * `session.handleReply` -> resend, in that order, and return everything
 * a caller needs to finish dispatching it. See the module doc comment
 * for why this exists as one tested function rather than each transport
 * re-deriving the call sequence.
 */
export function receive(session: Session, raw: string, options: ReceiveOptions = {}): ReceiveResult {
  const decoded = decodeLine(raw);
  if (decoded.kind === "blank") {
    return { resend: [], dropped: "blank" };
  }
  if (decoded.kind === "tooLong") {
    return { resend: [], dropped: "tooLong" };
  }

  const direction = classifyLine(decoded.verb);
  if (direction !== "reply") {
    if (direction === "foreign") {
      options.onForeign?.(raw);
    }
    return { resend: [], unrouted: raw };
  }

  if (decoded.verb === "ack" || decoded.verb === "nack") {
    const event = session.handleReply(decoded);
    // handleReply always returns non-null for "ack"/"nack" -- the null
    // case is only for every other reply verb -- but the type is shared,
    // so narrow defensively rather than asserting.
    if (event === null) {
      return { resend: [], line: decoded };
    }
    const resend = event.kind === "malformed" ? [] : event.resend;
    return { resend, ackNack: event, line: decoded };
  }

  return { resend: [], line: decoded };
}
