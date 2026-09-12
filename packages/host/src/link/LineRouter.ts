/**
 * LineRouter.ts — the transport-agnostic receive-path glue every
 * connected link runs an already-reassembled, already-normalized
 * inbound line (see `lineStream.ts`'s `LineReassembler` for what
 * "normalized" means) through: decode via `v6/codec.ts`'s
 * `decodeLine`, classify its verb's direction via `classifyLine`, and
 * — for `ack`/`nack` replies — feed it to `v6/session.ts`'s `Session`
 * for sequencing bookkeeping, re-sending whatever it asks for through
 * the caller's own paced write path.
 *
 * Extracted out of `UsbSerialLink#handleLine` (sprint 4 ticket 002, per
 * the roadmap issue's "four links must not each reimplement the nack
 * arithmetic") so a future relay/TCP/UDP link (sprint 7) composes this
 * instead of reimplementing it. The specific risk this centralizes:
 * `nack N` carries the *next-expected* sequence id, not the last-good
 * one, so the correct update is `seq = N - 1` — `Session.handleReply`
 * (this class's only call into the protocol package) already gets that
 * arithmetic right and is exercised by its own tests, but a transport
 * that hand-rolls the surrounding call sequence itself (decode, then
 * classify, then call `handleReply`, then resend, then dispatch, in
 * that order) risks getting the *sequence of calls* wrong even while
 * correctly delegating the arithmetic — e.g. dispatching before a
 * resend goes out, or skipping the classify step and treating a
 * foreign line as a protocol reply. That was a real logged bug in a
 * sibling project. Four transports must not each take on that risk
 * independently; they all use this one class instead.
 *
 * Only `"reply"`-direction lines are ever surfaced to a caller's
 * `onLine` callback (decoded). Everything else that is not blank — an
 * over-length line, a foreign (unrecognized lowercase) line, an
 * unexpected command-direction line — goes to `onUnrouted` as raw text
 * instead (OOP 2026-09-09): a relay answers its own `!` command plane
 * with `#`-prefixed comment text, an echo-on board repeats commands
 * back, and a board running some other dialect says whatever it says.
 * None of that is v6 protocol, none of it touches the sequencer, and
 * all of it must still reach the console — a reply the user cannot
 * see is indistinguishable from no reply at all (measured on relay
 * vitut: `!HELP` answered, nothing shown).
 */
import {
  decodeLine,
  classifyLine,
  type AckNackEvent,
  type DecodedLine,
  type Session,
} from "@robot-console/protocol";

// Note (ticket 014-004): `Session.handleReply` used to throw on a
// malformed ack/nack; it now returns a `{kind: "malformed"}` event
// instead (never throws on wire input). `handleLine` below narrows that
// out before touching `event.resend`/`onAckNack` -- a malformed reply
// still reaches the console via `onUnrouted`, exactly like any other
// non-actionable reply-direction oddity, rather than crashing the read
// loop the way an uncaught throw would have.

export interface LineRouterCallbacks {
  /** Every `"reply"`-direction decoded line, `ack`/`nack` included. */
  onLine: (line: DecodedLine) => void;
  /** An `ack`/`nack` event, after it has already been applied to the
   * session — mirrors `Session.handleReply`'s own return value. */
  onAckNack: (event: AckNackEvent) => void;
  /** One resend line a `nack` requires, already formatted wire text —
   * the caller is expected to pass this through the same paced write
   * path as every other write. */
  resend: (line: string) => void;
  /** Every non-blank inbound line that is NOT a recognized v6 reply, as
   * raw text (see the module doc comment). Optional so a caller that
   * only wants protocol replies is unchanged. */
  onUnrouted?: (raw: string) => void;
}

/**
 * Runs one already-reassembled, already-normalized inbound line through
 * decode -> classify -> (ack/nack -> session -> resend) -> dispatch.
 * See the module doc comment for why this exists as its own class
 * rather than being inlined per transport.
 */
export class LineRouter {
  constructor(
    private readonly session: Session,
    private readonly callbacks: LineRouterCallbacks,
  ) {}

  handleLine(raw: string): void {
    const decoded = decodeLine(raw);
    if (decoded.kind === "blank") {
      return;
    }
    if (decoded.kind !== "line" || classifyLine(decoded.verb) !== "reply") {
      this.callbacks.onUnrouted?.(raw);
      return;
    }

    if (decoded.verb === "ack" || decoded.verb === "nack") {
      const event = this.session.handleReply(decoded);
      if (event !== null && event.kind !== "malformed") {
        for (const resendLine of event.resend) {
          this.callbacks.resend(resendLine);
        }
        this.callbacks.onAckNack(event);
      } else if (event !== null) {
        // event.kind === "malformed" -- surface it the same way any
        // other non-actionable reply-direction line reaches the console.
        this.callbacks.onUnrouted?.(raw);
      }
    }

    this.callbacks.onLine(decoded);
  }
}
