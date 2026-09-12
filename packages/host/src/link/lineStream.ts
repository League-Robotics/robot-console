/**
 * lineStream.ts — reassembles a raw byte stream into complete,
 * normalized wire lines. Transport-agnostic: every link (USB serial
 * this sprint; relay/TCP/UDP in sprint 7) feeds its raw inbound bytes
 * through the same {@link LineReassembler} rather than reimplementing
 * line framing per transport (sprint 4 ticket 002 — moved verbatim out
 * of `UsbSerialLink.ts`, no behavior change).
 */

/** Default cap on a buffered *partial* (no `\n` seen yet) line, in UTF-16
 * code units, before {@link LineReassembler} discards it rather than
 * growing unboundedly — review `02-host-transport.md` §6: "grows
 * unbounded without `\n`" was this class's one open reuse-verdict
 * finding. A generous multiple of the wire's own 240-byte
 * (`v6/codec.ts` `MAX_LINE_BYTES`) line cap: a legitimate line never
 * gets close to this, so the guard only ever trips for a stuck peer
 * that never sends a newline or a foreign carrier's binary noise. */
const DEFAULT_MAX_BUFFER_CHARS = 4096;

/** Options to {@link LineReassembler}. */
export interface LineReassemblerOptions {
  /** Maximum size, in UTF-16 code units, a buffered partial line may
   * reach before it is discarded; default {@link
   * DEFAULT_MAX_BUFFER_CHARS}. */
  maxBufferChars?: number;
  /** Called once, synchronously, with the discarded partial-line text
   * whenever the `maxBufferChars` guard trips. Optional — a caller that
   * does not need to know is unaffected and the buffer is still reset
   * either way. */
  onOverflow?: (discarded: string) => void;
}

/**
 * Reassembles a raw byte stream into complete wire lines, buffering a
 * partial line across calls (a `read`/`data` boundary can split a line
 * anywhere — including mid-`ack`, which would silently lose it if not
 * buffered). Mirrors `vendor/radio-robot-lib`'s own
 * `Transport.read_lines()` reassembly discipline.
 *
 * A trailing `\r` (a terminal artifact of the wire's own `\n`
 * convention) is stripped from every extracted line, unconditionally,
 * before it is handed back. A leading `"< "` receive-prefix is NOT
 * stripped here (ticket 014-004 moved that into
 * `@robot-console/protocol`'s `v6/codec.ts` `decodeLine`/
 * `stripReceivePrefix`, next to the wire framing it is part of) — a
 * caller that needs a banner or another raw-text inspection normalized
 * the same way should call `stripReceivePrefix` itself before doing
 * anything else with a line this class hands back (`parseBanner`'s own
 * grammar is anchored and does not tolerate the prefix).
 *
 * The internal partial-line buffer is bounded by `maxBufferChars` (see
 * {@link LineReassemblerOptions}) — see the module's own doc comment on
 * {@link DEFAULT_MAX_BUFFER_CHARS} for why this exists.
 */
export class LineReassembler {
  private buffer = "";
  private readonly maxBufferChars: number;
  private readonly onOverflow: ((discarded: string) => void) | undefined;

  constructor(options: LineReassemblerOptions = {}) {
    this.maxBufferChars = options.maxBufferChars ?? DEFAULT_MAX_BUFFER_CHARS;
    this.onOverflow = options.onOverflow;
  }

  /** Feed newly arrived bytes; returns every complete line that became
   * available (zero, one, or several), each already normalized per the
   * class doc comment. Any trailing partial line is retained internally
   * for the next call, unless doing so would exceed `maxBufferChars` —
   * in that case the partial buffer is discarded (see {@link
   * LineReassemblerOptions.onOverflow}) rather than grown further. */
  push(chunk: Buffer | string): string[] {
    this.buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    const lines: string[] = [];
    let newlineIndex: number;
    while ((newlineIndex = this.buffer.indexOf("\n")) >= 0) {
      let raw = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (raw.endsWith("\r")) {
        raw = raw.slice(0, -1);
      }
      lines.push(raw);
    }
    if (this.buffer.length > this.maxBufferChars) {
      const discarded = this.buffer;
      this.buffer = "";
      this.onOverflow?.(discarded);
    }
    return lines;
  }
}
