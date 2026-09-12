/**
 * v6/codec.ts — the line-framing layer for the protocol-v6 wire grammar.
 *
 * Normative source: `vendor/radio-robot-lib/docs/design/protocol.md` §2
 * (the wire grammar), §2.1 (case is direction), §2.2 (mandatory
 * sequence ids), §6/§6.1 (verb + reply tables). Reference implementation
 * (informative, not ported line-for-line): `vendor/radio-robot-lib/src/
 * host/robot_v6/codec.py`.
 *
 *     line   ::= sp? verb ( sp field )* sp? '\n'
 *     sp     ::= ' '+
 *     verb   ::= [A-Za-z][A-Za-z0-9_]*
 *     field  ::= any bytes except ' ' and '\n'
 *     id     ::= '#' [0-9]+        (bare unsigned digits, always the LAST
 *                                    token when present)
 *
 * This module deliberately holds **no verb table and no per-verb arity
 * knowledge** — same discipline as codec.py's own docstring: "a generic
 * caller needs neither to format or parse a line". Consequences that
 * follow directly from that:
 *
 *   - `decodeLine` never rejects a line for using an unrecognized verb,
 *     or for having the "wrong" number of fields for its verb — it has
 *     no table to check that against. Whether an id is *mandatory* for
 *     a given verb (§2.2's 11-verb list) is ticket 005's (session.ts)
 *     concern, layered on top of what this module hands back.
 *   - The only outcomes *this* layer itself can flag are the two purely
 *     structural, verb-independent framing rules: a blank/all-whitespace
 *     line (§2: "ignored silently ... does not count malformed") and a
 *     line that busts the 240-byte wire cap (§2).
 *
 * Case-as-direction (§2.1) is exposed as a separate, explicit helper
 * (`classifyLine`/`isReplyVerb`) rather than being baked into
 * `decodeLine`, because it needs its own small "known reply verb" table
 * that a bare line-framer has no business owning either — see the
 * comment on `REPLY_VERBS` below.
 */

/** Max wire line length, in bytes, **including** the `'\n'` terminator
 * (protocol.md §2: "Max line: 240 bytes ... Chosen to sit inside a radio
 * MTU ... so a message never fragments"). Applies symmetrically to
 * encoding (refuse to produce an overlong line) and decoding (refuse to
 * parse one) — see the acceptance criteria on ticket 004. */
export const MAX_LINE_BYTES = 240;

/** Raised by `encodeLine` for any caller error that would otherwise
 * silently produce a line that does not match the wire grammar (an
 * illegal verb spelling, a field containing whitespace, a non-finite
 * number, a negative id, ...) or that would exceed {@link MAX_LINE_BYTES}. */
export class CodecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodecError";
  }
}

/** `verb ::= [A-Za-z][A-Za-z0-9_]*` (protocol.md §2). Enforced on
 * *encode*, where this module is itself responsible for producing a
 * conformant line; deliberately **not** enforced on *decode*, where the
 * bytes come from the wire and codec.py's own stated posture applies
 * ("this module does not enforce or check [case] itself -- it only
 * formats/parses whatever verb spelling it is given, verbatim"). */
const VERB_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/;

/** A well-formed, bare, unsigned id token: `#` followed by one or more
 * digits. protocol.md §2.2 is explicit that this is a *dedicated*
 * digits-only grammar, distinct from the general signed-integer field
 * parser: `#+5`, `#-5`, and `# 5` (the last one is two tokens, a lone
 * `'#'` followed by `'5'`) are all malformed **as an id** — none of them
 * match this pattern, so none of them get pulled out of `fields` into
 * `id`. They are not decode *errors* either: they simply remain ordinary
 * trailing field text, exactly as codec.py's own `parse_reply` leaves
 * them (its `rest[-1][1:].isdigit()` check is the same rule spelled in
 * Python). */
const ID_TOKEN_PATTERN = /^#[0-9]+$/;

function utf8ByteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

/** Strip only literal space runs (protocol.md §2's `sp ::= ' '+`) from
 * both ends — deliberately narrower than a generic `\s` trim, since the
 * grammar's own whitespace is space-only. */
function trimLineSpaces(s: string): string {
  return s.replace(/^ +/, "").replace(/ +$/, "");
}

/**
 * Strip a leading `"< "` receive-prefix, unconditionally, if present.
 *
 * Some carriers mark an inbound line with a leading `"< "` (mirroring a
 * `"> "` they use for outbound); nothing this protocol's own devices
 * legitimately say ever begins with `"< "`, so this is applied
 * unconditionally rather than gated behind a per-carrier flag (a flag
 * every carrier would have to agree on). Exported as its own pure
 * function — used by {@link decodeLine} next to the `\r` strip below,
 * and available directly to a caller that needs to normalize a raw line
 * before doing anything else with it (e.g. before `banner.ts`'s
 * `parseBanner`, whose grammar is anchored and does not tolerate the
 * prefix itself).
 */
export function stripReceivePrefix(raw: string): string {
  return raw.startsWith("< ") ? raw.slice(2) : raw;
}

// ---------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------

/**
 * A value marked to render as `flags` does: lowercase hex, no `0x`
 * prefix (protocol.md §2: "`flags` is the one exception to base-10").
 * Build one with {@link flagsField}; every other wire value type
 * (`number`/`string`) renders as an ordinary base-10 field.
 */
export interface FlagsField {
  readonly wireType: "flags";
  readonly value: number;
}

/** Mark `value` to render as a `flags`-typed wire field: lowercase hex,
 * no `0x` prefix (e.g. `216` -> `"d8"`, matching the STATUS golden
 * vector's `flags=d8` for the same decimal value). */
export function flagsField(value: number): FlagsField {
  if (!Number.isInteger(value) || value < 0) {
    throw new CodecError(
      `a flags field must be a non-negative integer, got ${value}`,
    );
  }
  return { wireType: "flags", value };
}

function isFlagsField(x: unknown): x is FlagsField {
  return (
    typeof x === "object" &&
    x !== null &&
    (x as { wireType?: unknown }).wireType === "flags"
  );
}

/** One value that can be encoded as a single wire field: a plain string
 * token, a base-10 number, or a {@link flagsField}-wrapped value. */
export type WireField = number | string | FlagsField;

/**
 * Render one exponential-notation number string (JS's own `toString`
 * switches to it for very large/small magnitudes, e.g. `"1e-8"`) into
 * fixed-point, losslessly. protocol.md §2: "No exponents". Mirrors
 * codec.py's own documented trap: a naive fixed-decimals fallback would
 * silently round `1e-08` down to `"0"` — this instead re-renders the
 * exact same significant digits the exponential form already carried.
 */
function expandExponential(s: string): string {
  const match = /^(-)?(\d+)(?:\.(\d+))?e([+-]\d+)$/i.exec(s);
  if (!match) {
    throw new CodecError(`cannot render as a fixed-point wire field: ${s}`);
  }
  const [, sign, intPart, fracPart, expStr] = match as unknown as [
    string,
    string | undefined,
    string,
    string | undefined,
    string,
  ];
  const exp = Number(expStr);
  const digits = intPart + (fracPart ?? "");
  const pointPos = intPart.length + exp;

  let out: string;
  if (pointPos <= 0) {
    out = "0." + "0".repeat(-pointPos) + digits;
  } else if (pointPos >= digits.length) {
    out = digits + "0".repeat(pointPos - digits.length);
  } else {
    out = digits.slice(0, pointPos) + "." + digits.slice(pointPos);
  }
  if (out.includes(".")) {
    out = out.replace(/0+$/, "").replace(/\.$/, "");
  }
  return (sign ?? "") + out;
}

function formatNumber(n: number): string {
  if (!Number.isFinite(n)) {
    throw new CodecError(
      `a non-finite number is not a legal wire field: ${n}`,
    );
  }
  const s = n.toString(10);
  return /e/i.test(s) ? expandExponential(s) : s;
}

function formatField(field: WireField): string {
  // WireField's own type excludes `boolean`, but a JS (non-TS) caller
  // can still hand one in at runtime -- catch it explicitly rather than
  // silently emitting the wire-illegal text "true"/"false", the same
  // guard codec.py's `_format_field` makes for the same reason.
  if (typeof field === "boolean") {
    throw new CodecError(
      "bool is not a wire field type -- pass 0/1 explicitly",
    );
  }
  if (isFlagsField(field)) {
    // Number.isInteger + >= 0 already enforced in flagsField(); toString(16)
    // is already lowercase with no "0x" prefix.
    return field.value.toString(16);
  }
  if (typeof field === "number") {
    return formatNumber(field);
  }
  if (field.length === 0) {
    throw new CodecError("an empty string is not a legal wire field");
  }
  if (/\s/.test(field)) {
    throw new CodecError(
      `a wire field cannot contain whitespace: ${JSON.stringify(field)}`,
    );
  }
  return field;
}

/**
 * Format one command/reply line, terminator included.
 *
 * Produces `verb field field ... #id\n` when `id` is given, with no `#`
 * section at all when it is not (protocol.md §2.2's `#0`-suppression
 * spelling is gone — pass `id: undefined` for an unsequenced verb, never
 * a sentinel value). Throws {@link CodecError} rather than truncating if
 * the result would exceed {@link MAX_LINE_BYTES}, or if `verb`/any field/
 * `id` itself is not legal wire text.
 */
export function encodeLine(
  verb: string,
  fields: readonly WireField[] = [],
  id?: number,
): string {
  if (!VERB_PATTERN.test(verb)) {
    throw new CodecError(`not a legal verb token: ${JSON.stringify(verb)}`);
  }

  const tokens: string[] = [verb];
  for (const field of fields) {
    tokens.push(formatField(field));
  }
  if (id !== undefined) {
    if (!Number.isInteger(id) || id < 0) {
      throw new CodecError(
        `a sequence id is bare and unsigned, got ${id} (protocol.md S2.2: "#+5, #-5, and # 5 are all malformed")`,
      );
    }
    tokens.push(`#${id}`);
  }

  const content = tokens.join(" ");
  const line = content + "\n";
  const byteLength = utf8ByteLength(line);
  if (byteLength > MAX_LINE_BYTES) {
    throw new CodecError(
      `encoded line is ${byteLength} bytes, exceeding the ${MAX_LINE_BYTES}-byte wire cap (protocol.md S2): ${JSON.stringify(content)}`,
    );
  }
  return line;
}

// ---------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------

/** A successfully framed line: verb, positional fields (raw wire text —
 * this layer has no per-verb type table, so it never parses a field's
 * *contents*, only splits the line into tokens; see the module doc),
 * and `id` when a well-formed trailing `#<digits>` token was present.
 *
 * `id` is `undefined`, never a sentinel like `0` or `''`, when no such
 * token was present — ticket 005 (session.ts) needs to be able to tell
 * "no id at all" apart from "id 0" (protocol.md S2.2: `#0` is itself a
 * perfectly well-formed, meaningful id now that ids start at 1). */
export interface DecodedLine {
  readonly kind: "line";
  readonly verb: string;
  readonly fields: readonly string[];
  readonly id?: number;
}

/** A blank/all-whitespace line — protocol.md §2: "ignored silently...
 * does not count as malformed." Distinguished from {@link DecodedLine}
 * so a caller never has to treat "nothing to do" as an error case. */
export interface BlankLine {
  readonly kind: "blank";
}

/** A line whose wire byte count (content + implied/actual `'\n'`
 * terminator) exceeds {@link MAX_LINE_BYTES}. Checked *before* the blank
 * check: an oversized frame is rejected regardless of what it contains,
 * mirroring how a real receive buffer would refuse it before any
 * content-level parsing runs at all. */
export interface LineTooLong {
  readonly kind: "tooLong";
  readonly byteLength: number;
}

export type DecodeResult = DecodedLine | BlankLine | LineTooLong;

/**
 * Parse one wire line into verb/fields/id.
 *
 * `raw` may be passed either with or without its trailing `'\n'`
 * terminator (and, per protocol.md §2, a lone `'\r'` immediately before
 * it, "a terminal artifact" that is stripped and never appears anywhere
 * else) — this layer owns line framing, so it tolerates both a
 * transport that has already split lines on `'\n'` and one that hasn't.
 * A leading `"< "` receive-prefix ({@link stripReceivePrefix}) is
 * likewise stripped unconditionally, right after the `\r` strip, so a
 * caller never has to remember to normalize that itself before handing
 * a line to this function. The {@link MAX_LINE_BYTES} check always
 * counts the terminator, whether or not `raw` still carries it
 * literally.
 *
 * Never throws. A blank/all-whitespace line and an over-length line are
 * both ordinary, non-exceptional outcomes on the wire (see
 * {@link BlankLine}/{@link LineTooLong}) — only `encodeLine`, which is
 * this side's *own* output rather than untrusted wire input, throws.
 */
export function decodeLine(raw: string): DecodeResult {
  let content = raw;
  if (content.endsWith("\n")) {
    content = content.slice(0, -1);
  }
  if (content.endsWith("\r")) {
    content = content.slice(0, -1);
  }
  content = stripReceivePrefix(content);

  // +1 for the '\n' terminator, whether or not `content` still literally
  // carries it (see the doc comment above) -- the 240-byte cap is
  // defined inclusive of that byte either way.
  const byteLength = utf8ByteLength(content) + 1;
  if (byteLength > MAX_LINE_BYTES) {
    return { kind: "tooLong", byteLength };
  }

  const trimmed = trimLineSpaces(content);
  if (trimmed.length === 0) {
    return { kind: "blank" };
  }

  // "A run of spaces is ONE separator" (protocol.md S2).
  const tokens = trimmed.split(/ +/);
  const verb = tokens[0] as string;
  const rest = tokens.slice(1);

  const last = rest[rest.length - 1];
  if (last !== undefined && ID_TOKEN_PATTERN.test(last)) {
    const id = Number(last.slice(1));
    // Guard against a pathologically long digit run overflowing safe-
    // integer precision -- vanishingly unlikely on a 240-byte line, but
    // cheap to rule out rather than hand back a silently-lossy id.
    if (Number.isSafeInteger(id)) {
      return { kind: "line", verb, fields: rest.slice(0, -1), id };
    }
  }
  return { kind: "line", verb, fields: rest };
}

// ---------------------------------------------------------------------
// Case is direction (protocol.md S2.1)
// ---------------------------------------------------------------------

/** Every lowercase verb this library's v6 grammar (protocol.md §6/§6.1)
 * ever emits robot -> host. Deliberately small and hand-maintained here
 * (this module still owns no *field*-level verb table — arity, etc. —
 * only this one flat membership check needed for case-as-direction
 * classification):
 *   - transport layer: `ack`, `nack`
 *   - application: `err`, `ret`
 *   - unsequenced-verb replies: `pong`, `estop`, `id`, `ver`, `status`,
 *     `help`
 *   - unsolicited: `debug`
 *   - legacy space-form HELLO banner sentinel (protocol.md §2.4: the
 *     colon `DEVICE:...` form is current and is *exempt* from this
 *     case rule per §2.4's own flagged note, but the pre-2026-08-26
 *     lowercase `device ...` dialect banner.ts also parses is an
 *     ordinary lowercase reply-direction line under this rule, not
 *     foreign traffic to drop)
 * Includes `thdr`/`t` (telemetry, v6/telemetry.ts's own schemaless
 * verbs, the same way `funcs` was added below: without them these lines
 * classified as "foreign" and never
 * reached a listener, even though the robot emits them continuously at
 * 20 Hz (protocol.md S10.2). `v6/telemetry.ts` is what actually zips a
 * `thdr` against each `t` line; this module owns only the classification
 * that lets them reach a caller at all. */
export const REPLY_VERBS: ReadonlySet<string> = new Set([
  "ack",
  "nack",
  "err",
  "ret",
  "pong",
  "estop",
  "id",
  "ver",
  "status",
  "help",
  "debug",
  "device",
  // `funcs <name> [signature]` -- one line per registered RUN function,
  // emitted by the robot firmware in reply to `FUNCS #<id>` (added
  // out-of-process, 2026-09-09; without it these lines classified as
  // "foreign" and never reached a listener).
  "funcs",
  // `wificred <slot> <ssid> <haspw>` -- the reply to `WIFICRED` (OOP
  // 2026-09-10).
  "wificred",
  // `thdr <col> <col> ...` -- the telemetry column-name header
  // (protocol.md S10.2), emitted whenever the column set changes or the
  // wire's own 20-frame auto-refresh fires.
  "thdr",
  // `t <val> <val> ...` -- one telemetry frame, zipped positionally
  // against the most recently held `thdr` by v6/telemetry.ts.
  "t",
]);

/** Is `verb` one of the wire's own known lowercase reply verbs
 * (`REPLY_VERBS`)? Case-sensitive, per protocol.md §2.1 ("Verb lookup is
 * case-sensitive"). */
export function isReplyVerb(verb: string): boolean {
  return REPLY_VERBS.has(verb);
}

/**
 * Which direction a line's own verb spelling belongs to.
 *
 *   - `"command"` — the first letter is uppercase (host -> robot, per
 *     protocol.md §2.1). Includes the current colon-form `HELLO` banner
 *     sentinel `DEVICE:...:...` (§2.4's own flagged case: it is
 *     uppercase, so it classifies as command-direction here even though
 *     it is not actually a command — banner.ts is responsible for
 *     recognizing and special-casing it before this classification
 *     would otherwise apply to it).
 *   - `"reply"` — lowercase, and a known reply verb (`REPLY_VERBS`).
 *   - `"foreign"` — lowercase but *not* a known reply verb: another
 *     robot's own traffic overheard on a shared radio channel
 *     (protocol.md §2.1). The caller must drop this silently, **not**
 *     treat it as a decode error (see the ticket's acceptance criteria
 *     and protocol.md §2.1's own "does not count malformed").
 *
 * A verb whose first character is neither an ASCII letter (e.g. empty,
 * or leading with a digit/symbol) cannot be a legitimate uppercase
 * command either, so it is classified `"foreign"` too — conservatively
 * safe to drop, never mistaken for a command this caller might act on.
 */
export type LineDirection = "command" | "reply" | "foreign";

export function classifyLine(verb: string): LineDirection {
  const first = verb.charAt(0);
  if (first >= "A" && first <= "Z") {
    return "command";
  }
  if (first >= "a" && first <= "z") {
    return isReplyVerb(verb) ? "reply" : "foreign";
  }
  return "foreign";
}
