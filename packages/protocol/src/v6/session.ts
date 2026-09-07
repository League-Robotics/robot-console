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

/** The 11 verbs protocol.md §8.3 sequences — the only verbs
 * {@link Session.send} will assign an id to. Held as an explicit,
 * hand-maintained constant (the same posture `codec.ts`'s own
 * `REPLY_VERBS` takes) rather than derived from anywhere else, since
 * this module is the one place in the stack whose entire job is knowing
 * this list. */
export const SEQUENCED_VERBS: ReadonlySet<string> = new Set([
  "GET",
  "SET",
  "TLM",
  "STOP",
  "RUN",
  "WHEELS_X",
  "WHEELS_V",
  "MOVE_X",
  "MOVE_V",
  "GO_TO_R",
  "GO_TO_W",
]);

/** Is `verb` one of the 11 id-bearing verbs ({@link SEQUENCED_VERBS})? */
export function isSequencedVerb(verb: string): boolean {
  return SEQUENCED_VERBS.has(verb);
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
}

function parseAckNackFields(
  verb: "ack" | "nack",
  fields: readonly string[],
): { n: number; lastDone: number; reason: string } {
  const [nText, lastDoneText, reason] = fields;
  if (nText === undefined || lastDoneText === undefined || reason === undefined) {
    throw new SessionError(
      `malformed "${verb}" reply -- expected 3 fields (n, lastDone, reason), got ${JSON.stringify(fields)}`,
    );
  }
  const n = Number(nText);
  const lastDone = Number(lastDoneText);
  if (!Number.isInteger(n) || !Number.isInteger(lastDone)) {
    throw new SessionError(
      `malformed "${verb}" reply -- non-integer n/lastDone in ${JSON.stringify(fields)}`,
    );
  }
  return { n, lastDone, reason };
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
    if (!isSequencedVerb(verb)) {
      throw new SessionError(
        `"${verb}" is not one of the 11 id-bearing verbs (${[...SEQUENCED_VERBS].join(" ")}) -- use sendUnsequenced() instead`,
      );
    }
    const id = this.nextId++;
    const line = encodeLine(verb, fields, id);
    this.pending.set(id, { id, verb, fields, line });
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
    if (isSequencedVerb(verb)) {
      throw new SessionError(
        `"${verb}" is one of the 11 id-bearing verbs -- use send() instead`,
      );
    }
    if (verb === "HELLO") {
      throw new SessionError(
        'HELLO must not be sent via sendUnsequenced() -- it resets the session sequence and must never be used as a mid-session health check (protocol.md S8.3: "a probe that manufactures the wedge it was checking for"). Use connect() for the initial connect-time HELLO, or checkLiveness() (PING) for an ongoing liveness check.',
      );
    }
    return encodeLine(verb, fields);
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
   * output) to the session. Returns an {@link AckNackEvent} for `ack`/
   * `nack` replies (updating {@link seq}/{@link lastDone}/
   * {@link lastDoneReason} and, for a `nack`, resolving which pending
   * lines must be resent); returns `null` for every other reply verb
   * (`pong`, `status`, `id`, `ver`, `help`, `estop`, `err`, `ret`,
   * `debug`, `device`, ...) — this class has no opinion about those, a
   * caller reads them off wherever it already has the decoded line.
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
  handleReply(reply: DecodedLine): AckNackEvent | null {
    if (reply.verb === "ack") {
      return this.handleAck(reply.fields);
    }
    if (reply.verb === "nack") {
      return this.handleNack(reply.fields);
    }
    return null;
  }

  private handleAck(fields: readonly string[]): AckNackEvent {
    const { n, lastDone, reason } = parseAckNackFields("ack", fields);
    this.seq = n;
    this.lastDone = lastDone;
    this.lastDoneReason = reason;
    this.retireThrough(n);
    return { kind: "ack", n, seq: this.seq, lastDone, lastDoneReason: reason, resend: [] };
  }

  private handleNack(fields: readonly string[]): AckNackEvent {
    const { n, lastDone, reason } = parseAckNackFields("nack", fields);
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
    const resend = this.retransmitFrom(n);
    return { kind: "nack", n, seq: this.seq, lastDone, lastDoneReason: reason, resend };
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
