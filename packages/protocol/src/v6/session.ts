/**
 * v6/session.ts — the reliability/sequencing layer on top of `v6/codec.ts`
 * (ticket 004). Host-side half of the mandatory-id, cumulative-ack/nack
 * scheme described normatively in `vendor/radio-robot-lib/docs/design/
 * protocol.md` §8 and `docs/design/specification.md` §3.5. Reference
 * implementation (informative, not ported line-for-line — it also owns a
 * `Transport` and blocking `pump()`/`wait_for_*()` loop that has no
 * business here): `vendor/radio-robot-lib/src/host/robot_v6/reliability.py`.
 *
 * This module is **pure logic, zero I/O**: it consumes already-decoded
 * reply lines (`codec.ts`'s `DecodedLine`) and produces line TEXT for a
 * caller to send — it never reads or writes a socket/serial port itself.
 * Wiring this to an actual transport (pacing writes, a read loop, retry
 * timers) is ticket 008's job (`UsbSerialLink`), not this one's.
 *
 * ---- The `expectedNext_` table this mirrors (protocol.md §8.1) ----
 *
 * The robot holds exactly two pieces of state per connection:
 * `expectedNext_` (the next sequence id it expects) and a "stall
 * outstanding" flag. Every inbound id-bearing line is classified against
 * `expectedNext_`:
 *
 * | inbound id | robot action | robot reply |
 * |---|---|---|
 * | `== expectedNext_` | decode fields FIRST; only on success dispatch and `expectedNext_ = id + 1` | `ack <id> <lastDone> <reason>` on decode success; `nack <expectedNext_> ...` on decode failure |
 * | `< expectedNext_` | do NOT re-execute — a retransmit whose ack was lost | `ack <expectedNext_ - 1> <lastDone> <reason>` |
 * | `> expectedNext_` | discard, do NOT execute — a numeric gap | `nack <expectedNext_> <lastDone> <reason>` |
 *
 * This class is the HOST's own mirror of that table, built from the two
 * reply lines the table above ever produces:
 *
 * - `ack N` means the robot has now accepted everything through id `N`
 *   in order — {@link Session.seq} becomes exactly `N`.
 * - `nack N` carries `expectedNext_` itself, i.e. **next-expected, not
 *   last-good** — so everything through `N - 1` is what the robot has
 *   actually confirmed. {@link Session.seq} becomes exactly `N - 1`.
 *   **Get this arithmetic right**: treating `nack N` the same as
 *   `ack N` (setting `seq = N` instead of `N - 1`) was a real logged bug
 *   in a sibling repo — see {@link Session.handleReply}'s own tests for
 *   the explicit named case pinning this.
 *
 * `seq` is therefore "the highest id the host currently believes the
 * robot has fully accepted" — the host-side analogue of the robot's own
 * `expectedNext_ - 1`. {@link Session.connect} (which sends `HELLO`) is
 * the one deliberate departure from that "highest CONFIRMED id" reading:
 * it sets `seq` to `1`, not `0`, directly mirroring protocol.md's own
 * "`HELLO` resets the sequence to 1" wording (`expectedNext_ = 1`) rather
 * than the strictly-accurate-but-unstated "nothing is confirmed yet"
 * value of `0`. Flagged here prominently as a deliberate call, not an
 * oversight, in case a future edit want to reconsider it.
 *
 * **Documented and consistent (ticket 014-004):** every OTHER path that
 * updates `seq` from a robot-reported next-expected value —
 * {@link Session.resyncTo} and a `nack N` in {@link Session.handleReply}
 * — uses the "nothing through `N - 1` is confirmed" reading (`seq = N -
 * 1`), so `resyncTo(1)` and `nack 1` both leave `seq` at `0` for the
 * identical robot state (`expectedNext_ = 1`) that `connect()` leaves at
 * `1`. That is the one, sole, explicitly-named exception above — not an
 * unnoticed drift between two call sites that should agree. `connect()`
 * additionally resets {@link Session.pendingCount}'s backing table AND
 * the give-up streak fields ({@link Session.resyncTo}'s own reset target
 * list) to `0`, matching `resyncTo()` exactly on every field except
 * `seq` itself, for the reason stated above.
 *
 * ---- Retransmits: sourced from `pending`, never freshly constructed ----
 *
 * A retransmitted frame **must reuse its original id** — a fresh id
 * reads to the robot as a numeric gap and stalls the stream (protocol.md
 * §8.1's own warning on this exact mistake). There is deliberately no
 * public API that lets a caller hand this class an id to retransmit
 * with: {@link Session.handleReply}'s automatic resend on `nack`, and
 * the explicit {@link Session.retransmit}, both source the line text
 * from the internal `pending` table (populated by {@link Session.send}
 * at the moment a command was first sent) rather than accepting one from
 * the caller. There is no way to construct a retransmit for an id this
 * class did not itself send and still consider outstanding.
 *
 * ---- A `nack` the host cannot possibly satisfy is a desync, not a retry ----
 *
 * "Resend from next forward, in order" (protocol.md §8.1) implicitly
 * assumes the host is still holding *something* at the id the robot
 * asked for. That assumption breaks when the robot's own `expectedNext_`
 * resets (a reflash, a power cycle, or a stray `HELLO`) to a value BELOW
 * every id the host currently has pending: every retransmit the host
 * sends is still numerically ahead of what the reset robot now expects,
 * so it gets discarded and re-nacked with the identical id, forever —
 * a real reported bug, not a hypothetical. {@link Session.handleReply}
 * detects exactly this case (the lowest pending id is `>` the nacked
 * id) and reports it via {@link AckNackEvent.desynced} with an empty
 * {@link AckNackEvent.resend} rather than manufacturing that loop — see
 * that field's own doc comment for the full reasoning. This is a
 * distinct failure mode from the ordinary "lost frame, still pending,
 * keep resending it" case worked through in the synthetic sequencing
 * tests, which is NOT touched by this check and keeps retransmitting
 * for as long as the robot keeps asking.
 *
 * ---- The 11 id-bearing verbs (protocol.md §8.3) ----
 *
 * Only `GET SET TLM STOP RUN WHEELS_X WHEELS_V MOVE_X MOVE_V GO_TO_R
 * GO_TO_W` carry a sequence id at all — see {@link SEQUENCED_VERBS}.
 * Every other verb (`HELLO`, `PING`, `STATUS`, `ID`, `VER`, `HELP`,
 * `ESTOP`, ...) is sent with no id and is outside the ack/nack sequence
 * entirely (§8.3's "a verb is sequenced iff its correctness depends on
 * its position in the stream" rule). {@link Session.send} is gated on
 * this allowlist; {@link Session.sendUnsequenced} is gated on its
 * complement.
 *
 * ---- `HELLO` is a reset, not a health check ----
 *
 * `HELLO` resets the robot's `expectedNext_` to 1 (and clears its stall
 * flag). Firing it at a live session therefore does not "check" the
 * session — it destroys its sequencing state out from under any
 * in-flight id-bearing command (protocol.md §8.3: *"A probe that
 * manufactures the wedge it was checking for"*). To make that misuse
 * structurally awkward rather than merely documented:
 *
 * - {@link Session.connect} is the ONLY method that ever formats a
 *   `HELLO` line, and it always resets local session state to match
 *   (fresh id counter, empty pending table) — see its own doc comment.
 * - {@link Session.sendUnsequenced} — the general-purpose "send an
 *   unsequenced verb" entry point ticket 008 would otherwise reach for
 *   — explicitly REFUSES the verb `"HELLO"` and points the caller at
 *   `connect()` instead, rather than silently formatting it.
 * - {@link Session.checkLiveness} is the distinctly-named liveness
 *   probe (`PING`) a caller should reach for instead of `HELLO` when it
 *   only wants to know "is anyone there" — see protocol.md §8.3's own
 *   "three verbs, three jobs" framing (`PING` = alive?, `STATUS` =
 *   alive + where does the sequence stand?, `HELLO` = start over).
 */

import { encodeLine, type DecodedLine, type WireField } from "./codec.js";
import { isSequencedVerb, SEQUENCED_VERBS } from "./verbs.js";

/** Re-exported from `v6/verbs.ts` (ticket 004 split them out into their
 * own module) so existing callers importing them from `session.js`
 * continue to work unchanged. */
export { SEQUENCED_VERBS, isSequencedVerb };

/** Raised for any caller error this class can catch structurally: using
 * {@link Session.send} for a verb outside the 11-verb allowlist, using
 * {@link Session.sendUnsequenced} for one of those 11 (or for `"HELLO"`,
 * which gets its own dedicated message), or asking
 * {@link Session.retransmit} for an id this class is not currently
 * holding pending. */
export class SessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionError";
  }
}

/** One sequenced command this session has sent and is still holding in
 * case a `nack` requires it to be resent — removed once a cumulative
 * `ack` retires it (or an equal/higher id). `line` is the exact wire
 * text (id included) {@link Session.send} originally produced; a
 * retransmit always resends this same string verbatim, never a
 * re-encoded one, so it is byte-identical on the wire the second time. */
export interface PendingCommand {
  readonly id: number;
  readonly verb: string;
  readonly fields: readonly WireField[];
  readonly line: string;
}

/** The result of feeding one `ack`/`nack` reply line to
 * {@link Session.handleReply}. `resend` lists every pending command's
 * line text (byte-identical, original id) that a `nack` requires
 * resending, in ascending id order — empty for an `ack`, and empty for
 * a `nack` naming an id with nothing outstanding at or above it. */
export interface AckNackEvent {
  readonly kind: "ack" | "nack";
  /** The bare leading number the reply carried — the accepted id for
   * `ack`, the next-expected id for `nack`. */
  readonly n: number;
  /** {@link Session.seq} as of this event (i.e. after applying it). */
  readonly seq: number;
  readonly lastDone: number;
  readonly lastDoneReason: string;
  readonly resend: readonly string[];
  /**
   * `true` only for a `nack` this session cannot possibly resolve by
   * retransmitting — always `false` for `ack`. A `nack N` asks the host
   * to resend starting at id `N`; that is only satisfiable if the host
   * is still holding something at or below `N` (i.e. its lowest pending
   * id is `<= N`). When the host's lowest pending id is instead `> N`,
   * the robot is asking for an id the host will never produce again
   * (ids only ever increase) — the robot's own `expectedNext_` fell
   * BEHIND everything the host has sent, which only happens when the
   * robot's sequence state reset out from under the host (a reflash, a
   * power cycle, or an out-of-band `HELLO`), not from an ordinary lost
   * frame.
   *
   * This is the fix for a real reported bug: retransmitting into this
   * case cannot converge — every resent frame is still `> ` the robot's
   * freshly-reset `expectedNext_`, so it gets discarded and re-nacked
   * with the identical `N`, forever. When `desynced` is `true`,
   * {@link resend} is always empty (this class refuses to manufacture
   * that loop) and the doomed pending table is cleared — there is
   * nothing left worth holding onto for a future retransmit, since none
   * of it will ever be honored by a robot that has moved on.
   *
   * **Recovery is automatic (OOP 2026-09-09).** The robot has told the
   * host exactly what it expects next -- `N` -- so this session adopts
   * it on the spot ({@link Session.resyncTo}): the next `send()` carries
   * `#N` and is accepted. No `HELLO` round trip, no operator action. A
   * caller may still surface this as an informational notice ("the
   * robot restarted its counter; picked up at #N"), but must not ask
   * the user to do anything. Stakeholder direction, verbatim: "NACK
   * should never, ever mean I forgot what number I was supposed to
   * send."
   */
  readonly desynced: boolean;
  /**
   * Set only on a `nack` where this session has just given up on a
   * command it had already resent {@link MAX_RESENDS} times to the same
   * `nack N` with no progress -- the robot keeps refusing the identical
   * line, which (protocol.md §8.9) means the line itself is malformed as
   * constructed, not lost in transit, and resending it again would
   * wedge the stream forever. The dropped line's text is carried here
   * for reporting; the session has already resynced to `N`
   * ({@link Session.resyncTo}) so the next `send()` reuses that id and
   * the stream moves on. Absent otherwise.
   */
  readonly gaveUp?: string;
}

/** How many times the same pending id may be resent to the same
 * `nack N` before {@link Session.handleReply} gives up on it -- see
 * {@link AckNackEvent.gaveUp}. */
export const MAX_RESENDS = 3;

/**
 * Returned by {@link Session.handleReply} for an `ack`/`nack` line that
 * fails to parse (too few fields, or a non-integer `n`/`lastDone`) --
 * the only outcome wire input can produce here now. This is a **value**,
 * not a thrown error: wire input is never trusted to be well-formed
 * (the same posture `codec.ts`'s `decodeLine` already takes -- it never
 * throws either), so a caller does not need to wrap every
 * {@link Session.handleReply} call in try/catch just to keep one bad
 * reply from killing its read loop. `session` state is left completely
 * untouched by a malformed reply -- `seq`/`lastDone`/`pending` are
 * exactly what they were before this call.
 */
export interface MalformedReplyEvent {
  readonly kind: "malformed";
  /** Which reply verb this was -- `"ack"` or `"nack"`. */
  readonly verb: "ack" | "nack";
  /** The reply's own decoded fields, verbatim, for diagnostics. */
  readonly fields: readonly string[];
  /** Human-readable reason this failed to parse. */
  readonly reason: string;
}

type ParsedAckNackFields =
  | { readonly ok: true; readonly n: number; readonly lastDone: number; readonly reason: string }
  | { readonly ok: false; readonly reason: string };

function parseAckNackFields(
  verb: "ack" | "nack",
  fields: readonly string[],
): ParsedAckNackFields {
  const [nText, lastDoneText, reason] = fields;
  if (nText === undefined || lastDoneText === undefined || reason === undefined) {
    return {
      ok: false,
      reason: `malformed "${verb}" reply -- expected 3 fields (n, lastDone, reason), got ${JSON.stringify(fields)}`,
    };
  }
  const n = Number(nText);
  const lastDone = Number(lastDoneText);
  if (!Number.isInteger(n) || !Number.isInteger(lastDone)) {
    return {
      ok: false,
      reason: `malformed "${verb}" reply -- non-integer n/lastDone in ${JSON.stringify(fields)}`,
    };
  }
  return { ok: true, n, lastDone, reason };
}

/**
 * Owns one session's worth of sequencing state: the id counter for
 * outgoing sequenced commands, the pending-retransmit table, and
 * {@link Session.seq}/`lastDone`/`lastDoneReason` as last observed from
 * an `ack`/`nack` reply. See the module doc comment for the full design.
 */
export class Session {
  private nextId = 1;
  private readonly pending = new Map<number, PendingCommand>();
  /** The `N` of the most recent `nack` that led to a resend, and how
   * many consecutive times that same `N` has been resent -- the
   * give-up counter behind {@link AckNackEvent.gaveUp}. */
  private lastResendN = 0;
  private resendStreak = 0;

  /** The host's current best belief about the highest sequence id the
   * robot has fully accepted — see the module doc comment for exactly
   * how `ack`/`nack`/`connect()` each update this. `0` until the first
   * `ack`/`nack`/`connect()` of the session's lifetime. */
  seq = 0;

  /** `Adapter::lastDone()` as of the most recently observed `ack`/
   * `nack` (protocol.md §8.8). `0` until the first one arrives. */
  lastDone = 0;

  /** The wire reason token paired with {@link lastDone} (`"none"` when
   * `lastDone` is `0`). */
  lastDoneReason = "none";

  /** How many sequenced commands have been sent but not yet retired by
   * a cumulative `ack` (or purged as already-confirmed by a `nack`). */
  get pendingCount(): number {
    return this.pending.size;
  }

  /** The id the next {@link send} will carry. With nothing pending this
   * is what the robot's `status next=` should read; a mismatch there
   * means the two counters drifted (the robot reset) and
   * {@link resyncTo} closes the gap without a `HELLO`. */
  get nextSequenceId(): number {
    return this.nextId;
  }

  /**
   * OOP 2026-09-09: adopt the robot's own next-expected id. Drops every
   * pending command (none of them can be honored -- they carry ids the
   * robot no longer expects) and continues numbering from `n`, so the
   * very next {@link send} is accepted. Used by {@link handleReply} on a
   * desynced `nack` and on give-up, and by a host that reads
   * `status next=` while nothing is pending. Unlike {@link connect},
   * this sends nothing and never resets the robot.
   */
  resyncTo(n: number): void {
    if (!Number.isInteger(n) || n < 1) {
      return;
    }
    this.pending.clear();
    this.nextId = n;
    this.seq = n - 1;
    this.lastResendN = 0;
    this.resendStreak = 0;
  }

  /** Every id currently pending, ascending. Exposed for callers/tests
   * that want to inspect outstanding state without reaching into
   * private fields; {@link retransmit} is the supported way to actually
   * resend one. */
  pendingIds(): number[] {
    return [...this.pending.keys()].sort((a, b) => a - b);
  }

  // ---- sending ------------------------------------------------------

  /**
   * Assign the next sequential id, format `verb`/`fields` as a wire
   * line (via `codec.ts`'s `encodeLine`), buffer it under that id for a
   * possible future retransmit, and return the line text to send.
   * Never blocks and never sends anything itself — this class has no
   * I/O (see the module doc comment).
   *
   * Throws {@link SessionError} if `verb` is not one of the 11
   * id-bearing verbs ({@link SEQUENCED_VERBS}) — use
   * {@link sendUnsequenced} for everything else.
   */
  send(verb: string, fields: readonly WireField[] = []): string {
    // Fold case ONCE, before both the classification check and the
    // encode -- see isSequencedVerb's own doc comment for why. Using the
    // same normalized spelling for both means a lowercase "get" can
    // never classify as sequenced here while encoding lowercase onto the
    // wire (which would look like reply-direction traffic to the robot,
    // protocol.md S2.1) -- it always ends up as the canonical "GET".
    const normalized = verb.toUpperCase();
    if (!isSequencedVerb(normalized)) {
      throw new SessionError(
        `"${verb}" is not one of the 11 id-bearing verbs (${[...SEQUENCED_VERBS].join(" ")}) -- use sendUnsequenced() instead`,
      );
    }
    const id = this.nextId++;
    const line = encodeLine(normalized, fields, id);
    this.pending.set(id, { id, verb: normalized, fields, line });
    return line;
  }

  /**
   * Format `verb`/`fields` as a wire line with **no** sequence id and
   * return it. For every verb outside {@link SEQUENCED_VERBS} — `PING`,
   * `STATUS`, `ID`, `VER`, `HELP`, `ESTOP`, ... — except `HELLO`, which
   * is refused here (see below) since it needs more than "no id" to be
   * safe.
   *
   * Throws {@link SessionError} if `verb` IS one of the 11 id-bearing
   * verbs (use {@link send}), or if `verb` is `"HELLO"`: `HELLO` resets
   * the robot's sequence (protocol.md §8.3) and must never be issued as
   * a casual, general-purpose unsequenced line — only through
   * {@link connect}, which also resets THIS session's own local state to
   * match. See the module doc comment's "`HELLO` is a reset, not a
   * health check" section for the full rationale and
   * {@link checkLiveness} for the liveness-probe alternative.
   */
  sendUnsequenced(verb: string, fields: readonly WireField[] = []): string {
    // Same fold-once discipline as send() -- see isSequencedVerb's doc
    // comment. Without this, a caller-supplied "hello" would sail past
    // both guards below (neither string-equals its uppercase spelling)
    // and get encoded verbatim, lowercase, onto the wire -- exactly the
    // silent-desync hole a sibling bug report pinned this on.
    const normalized = verb.toUpperCase();
    if (isSequencedVerb(normalized)) {
      throw new SessionError(
        `"${verb}" is one of the 11 id-bearing verbs -- use send() instead`,
      );
    }
    if (normalized === "HELLO") {
      throw new SessionError(
        'HELLO must not be sent via sendUnsequenced() -- it resets the session sequence and must never be used as a mid-session health check (protocol.md S8.3: "a probe that manufactures the wedge it was checking for"). Use connect() for the initial connect-time HELLO, or checkLiveness() (PING) for an ongoing liveness check.',
      );
    }
    return encodeLine(normalized, fields);
  }

  /**
   * The ONLY way this class ever formats a `HELLO` line. Resets local
   * session state to match the fresh session `HELLO` establishes on the
   * robot side: the next {@link send} will assign id `1` again, every
   * previously pending command is dropped (a resent retransmit for a
   * pre-reset id would itself now read as a stale/garbage id to the
   * just-reset robot), and {@link seq} becomes `1` (protocol.md: "`HELLO`
   * resets the sequence to 1" — see the module doc comment for why this
   * is `1`, not `0`). {@link lastDone}/{@link lastDoneReason} are left
   * untouched: they live on the robot's `Adapter`, not its handler, and
   * a `HELLO` reset does not reach into the Adapter's own state
   * (protocol.md §8.8) — mirrored here for the same reason.
   *
   * Call this once, at connect time. Never call it again on a session
   * that already has in-flight commands — see the module doc comment.
   */
  connect(): string {
    this.nextId = 1;
    this.pending.clear();
    this.seq = 1;
    // Matches resyncTo()'s own reset -- a session that hit the give-up
    // streak before reconnecting must not carry that count into the
    // fresh session HELLO establishes; otherwise a single ordinary nack
    // right after connect() could trip resendStreak > MAX_RESENDS on
    // its very first resend and give up prematurely. See the
    // streak-reset-after-connect test for the pinned regression case.
    this.lastResendN = 0;
    this.resendStreak = 0;
    return encodeLine("HELLO", []);
  }

  /**
   * Format the `PING` liveness probe: no id, answers even while the
   * stream is stalled on a gap (protocol.md §8.3), and — unlike
   * `HELLO` — never touches any session state. This is what a caller
   * should reach for to check "is anyone there" on an already-live
   * session.
   */
  checkLiveness(): string {
    return encodeLine("PING", []);
  }

  /**
   * Re-send an already-pending command's ORIGINAL line, unchanged,
   * looked up by the id it was originally sent under. There is no
   * overload that accepts fresh field/verb data here — a retransmit is
   * always the exact bytes {@link send} produced the first time (see
   * the module doc comment on why a fresh id would stall the stream).
   *
   * Throws {@link SessionError} if `id` is not currently pending (never
   * sent, or already retired by a cumulative `ack`).
   */
  retransmit(id: number): string {
    const pending = this.pending.get(id);
    if (pending === undefined) {
      throw new SessionError(
        `cannot retransmit id ${id} -- it is not currently pending (never sent, or already retired by an ack)`,
      );
    }
    return pending.line;
  }

  // ---- receiving ------------------------------------------------------

  /**
   * Feed one already-decoded reply line (`codec.ts`'s `decodeLine`
   * output) to the session. Returns an {@link AckNackEvent} for a
   * well-formed `ack`/`nack` reply (updating {@link seq}/
   * {@link lastDone}/{@link lastDoneReason} and, for a `nack`, resolving
   * which pending lines must be resent); a {@link MalformedReplyEvent}
   * for an `ack`/`nack` reply that fails to parse (too few fields, or a
   * non-integer `n`/`lastDone`) — this **never throws**, even for wire
   * input this class cannot make sense of, matching `codec.ts`'s own
   * "wire input is data, never an exception" posture; and `null` for
   * every other reply verb (`pong`, `status`, `id`, `ver`, `help`,
   * `estop`, `err`, `ret`, `debug`, `device`, ...) — this class has no
   * opinion about those, a caller reads them off wherever it already has
   * the decoded line.
   *
   * Deliberately tolerant of a reply-then-trailing-nack pair arriving
   * as two separate lines (protocol.md §8.3's conditional reminder:
   * while a stall is outstanding, `PING`/`HELP`/`ID`/`VER`/`STATUS`
   * emit their own reply FOLLOWED BY a `nack` on its own line) — each
   * line is simply fed through this method in turn; the leading reply
   * returns `null` and the trailing `nack` is handled normally as its
   * own event. There is nothing here that treats that pairing as a
   * protocol violation.
   */
  handleReply(reply: DecodedLine): AckNackEvent | MalformedReplyEvent | null {
    if (reply.verb === "ack") {
      return this.handleAck(reply.fields);
    }
    if (reply.verb === "nack") {
      return this.handleNack(reply.fields);
    }
    return null;
  }

  private handleAck(fields: readonly string[]): AckNackEvent | MalformedReplyEvent {
    const parsed = parseAckNackFields("ack", fields);
    if (!parsed.ok) {
      return { kind: "malformed", verb: "ack", fields, reason: parsed.reason };
    }
    const { n, lastDone, reason } = parsed;
    this.seq = n;
    this.lastDone = lastDone;
    this.lastDoneReason = reason;
    this.retireThrough(n);
    this.lastResendN = 0;
    this.resendStreak = 0;
    return { kind: "ack", n, seq: this.seq, lastDone, lastDoneReason: reason, resend: [], desynced: false };
  }

  private handleNack(fields: readonly string[]): AckNackEvent | MalformedReplyEvent {
    const parsed = parseAckNackFields("nack", fields);
    if (!parsed.ok) {
      return { kind: "malformed", verb: "nack", fields, reason: parsed.reason };
    }
    const { n, lastDone, reason } = parsed;
    // `nack` carries next-expected, NOT last-good -- everything through
    // n - 1 is what the robot has actually confirmed. See the module
    // doc comment's own worked-through explanation of this arithmetic
    // and its logged-bug history.
    this.seq = n - 1;
    this.lastDone = lastDone;
    this.lastDoneReason = reason;
    // Everything below n is now known-confirmed (whether or not this
    // session ever saw its own ack for it -- a lost ack self-heals
    // exactly here) and no longer needs to be held for a retransmit.
    this.retireThrough(this.seq);

    // What survived that retirement is exactly the candidate set for
    // retransmitFrom(n) (everything still pending is, by construction,
    // >= n at this point). If the lowest surviving id is still > n, the
    // robot is asking for an id this session will never hold again --
    // see AckNackEvent.desynced's own doc comment for the full
    // reasoning. Retransmitting the survivors in that case cannot
    // converge, so this deliberately does NOT call retransmitFrom(n)
    // (which would happily hand back every id >= n and re-trigger the
    // exact runaway loop this guards against) -- it clears them instead.
    const remaining = this.pendingIds();
    const desynced = remaining.length > 0 && remaining[0]! > n;

    if (desynced) {
      // The robot's counter reset under us. Adopt its number and move
      // on -- see AckNackEvent.desynced (OOP 2026-09-09).
      this.resyncTo(n);
      return { kind: "nack", n, seq: this.seq, lastDone, lastDoneReason: reason, resend: [], desynced };
    }

    if (remaining.length > 0 && remaining[0] === n) {
      // About to resend #n. Same n as last time means the previous
      // resend of this exact line was refused again -- count it, and
      // give up once it has clearly stopped being "lost in transit".
      if (this.lastResendN === n) {
        this.resendStreak++;
      } else {
        this.lastResendN = n;
        this.resendStreak = 1;
      }
      if (this.resendStreak > MAX_RESENDS) {
        const dropped = this.pending.get(n)?.line ?? "";
        this.resyncTo(n);
        return { kind: "nack", n, seq: this.seq, lastDone, lastDoneReason: reason, resend: [], desynced: false, gaveUp: dropped };
      }
    }

    const resend = this.retransmitFrom(n);
    return { kind: "nack", n, seq: this.seq, lastDone, lastDoneReason: reason, resend, desynced };
  }

  /** One `ack` covers every earlier id too (protocol.md §8.1) -- drop
   * every pending id `<= n` in one shot. */
  private retireThrough(n: number): void {
    for (const id of this.pending.keys()) {
      if (id <= n) {
        this.pending.delete(id);
      }
    }
  }

  /** Every still-pending id `>= nextId`, ascending, as its original
   * (never re-encoded) line text -- the resend a `nack` requires
   * (protocol.md §8.1: "resend from next forward, in order"). */
  private retransmitFrom(nextId: number): string[] {
    return this.pendingIds()
      .filter((id) => id >= nextId)
      .map((id) => this.retransmit(id));
  }
}
