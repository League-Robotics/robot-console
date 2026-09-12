/**
 * v6/verbs.ts — the id-bearing verb vocabulary (protocol.md §8.3), split
 * out of `session.ts` (ticket 004) so the one static allowlist question
 * ("is this verb sequenced?") lives in its own small module, the same
 * way `codec.ts` owns `REPLY_VERBS`/`isReplyVerb` as its own flat
 * membership check.
 */

/** The 11 verbs protocol.md §8.3 sequences — the only verbs
 * `Session.send` will assign an id to. Held as an explicit,
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
  // FUNCS: the robot firmware's wire_handler.cpp registers FUNCS with a
  // mandatory `#<id>` -- the ack is what terminates its variable-length
  // `funcs <name>` reply -- so a bare `FUNCS` with no id is malformed
  // there and draws no reply at all.
  "FUNCS",
  // WIFICRED: `WIFICRED #<id>` lists the credential slots, `WIFICRED SET
  // <slot> <ssid> <password> #<id>` writes one; sequenced in the
  // firmware, replied with `wificred <slot> <ssid> <haspw>` then the ack.
  "WIFICRED",
]);

/** Is `verb` one of the 13 id-bearing verbs ({@link SEQUENCED_VERBS})?
 * Case-folded before the lookup: protocol.md §2.1's "case is direction"
 * rule is about what a line looks like ON THE WIRE (this library only
 * ever emits sequenced verbs uppercase), not a license for a caller-
 * supplied verb spelling to silently pick a different code path just
 * because it arrived lowercase. A caller one layer up asking "is `get`
 * sequenced?" should get the same answer as "is `GET` sequenced?" --
 * see `Session.send`/`Session.sendUnsequenced`, which fold case the same
 * way before both classifying AND encoding, so the two never disagree
 * with each other. */
export function isSequencedVerb(verb: string): boolean {
  return SEQUENCED_VERBS.has(verb.toUpperCase());
}
