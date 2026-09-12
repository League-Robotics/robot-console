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
      lines.push(raw);
    }
    return lines;
  }
}
