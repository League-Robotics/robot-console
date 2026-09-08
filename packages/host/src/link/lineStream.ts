/**
 * lineStream.ts — reassembles a raw byte stream into complete,
 * normalized wire lines. Transport-agnostic: every link (USB serial
 * this sprint; relay/TCP/UDP in sprint 7) feeds its raw inbound bytes
 * through the same {@link LineReassembler} rather than reimplementing
 * line framing per transport (sprint 4 ticket 002 — moved verbatim out
 * of `UsbSerialLink.ts`, no behavior change).
 */

/**
 * Reassembles a raw byte stream into complete wire lines, buffering a
 * partial line across calls (a `read`/`data` boundary can split a line
 * anywhere — including mid-`ack`, which would silently lose it if not
 * buffered). Mirrors `vendor/radio-robot-lib`'s own
 * `Transport.read_lines()` reassembly discipline.
 *
 * Two things are normalized on every extracted line, unconditionally,
 * before it is handed back:
 *   - a trailing `\r` (a terminal artifact of the wire's own `\n`
 *     convention) is stripped;
 *   - a leading `"< "` prefix is stripped. Nothing the robot/relay
 *     legitimately says begins with `"< "`; making this conditional
 *     (only strip it for carriers that are "known" to add it) becomes a
 *     per-carrier flag the carriers disagree about, so it is applied to
 *     every line unconditionally instead.
 */
export class LineReassembler {
  private buffer = "";

  /** Feed newly arrived bytes; returns every complete line that became
   * available (zero, one, or several), each already normalized per the
   * class doc comment. Any trailing partial line is retained internally
   * for the next call. */
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
      if (raw.startsWith("< ")) {
        raw = raw.slice(2);
      }
      lines.push(raw);
    }
    return lines;
  }
}
