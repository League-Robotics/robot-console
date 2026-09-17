/**
 * lineReassembler.ts — reassemble a raw byte stream into complete wire
 * lines, buffering a partial line across `push()` calls.
 *
 * This is a small, deliberate duplicate of `packages/host/src/link/
 * lineStream.ts`'s `LineReassembler`, not an import of it: that module
 * lives in `@robot-console/host`, and this ticket's own plan says Layer 1
 * must "exercise the wire, not the host's code paths, so a host bug is
 * never masked by sharing its parser" — reusing the host's own byte-
 * reassembly logic here would mean a bug in *that* logic could never
 * show up as a Layer 1 discrepancy, since both sides would share it.
 * `@robot-console/protocol`'s banner/relay-command parsers are fair game
 * (this harness imports them directly) because that package is pure,
 * zero-I/O wire *grammar*, not the host's own transport-adapter code —
 * see this ticket's own plan for the same distinction. This mirrors an
 * existing convention in this codebase: `watchers/mdnsWatcher.ts`
 * duplicates `discovery/mdnsDiscovery.ts`'s private `parseRegistryPort`
 * rather than importing it, for an analogous "small, self-contained
 * parser, not a shared dependency" reason.
 */

/** Cap on a buffered partial (no `\n` yet) line, in UTF-16 code units,
 * before it is discarded rather than grown unboundedly -- guards against
 * a stuck peer that never sends a newline. Generous relative to any
 * line this harness expects. */
const DEFAULT_MAX_BUFFER_CHARS = 4096;

/**
 * Reassembles a raw byte stream into complete wire lines. A trailing
 * `\r` is stripped from every extracted line. Nothing else is
 * normalized — a leading `< ` receive-prefix (relay pass-through
 * replies) is left exactly as it arrived, since the relay/protocol
 * parsers this harness calls expect to see it themselves.
 */
export class LineReassembler {
  private buffer = "";
  private readonly maxBufferChars: number;

  constructor(maxBufferChars: number = DEFAULT_MAX_BUFFER_CHARS) {
    this.maxBufferChars = maxBufferChars;
  }

  /** Feed newly arrived bytes; returns every complete line that became
   * available (zero, one, or several). Any trailing partial line is
   * retained for the next call, unless doing so would exceed
   * `maxBufferChars`, in which case it is discarded silently. */
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
      this.buffer = "";
    }
    return lines;
  }
}
