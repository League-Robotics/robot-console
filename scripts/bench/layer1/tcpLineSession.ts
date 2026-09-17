/**
 * tcpLineSession.ts — thin, transcript-recording line-oriented TCP client
 * used by every Layer 1 TCP probe (mbserial, WiFi `_robotlink`, the
 * mbrelay pool). This is orchestration glue over a raw `net.Socket` and
 * {@link LineReassembler}, not wire grammar — the grammar itself
 * (banner/relay-command parsing) comes from `@robot-console/protocol` or
 * this harness's own small parsers, never from here.
 *
 * Not unit-tested on its own (per this ticket's testing plan: transport
 * I/O is exercised by the live bench run, which is this ticket's own
 * evidence; {@link LineReassembler} and every probe's parsing logic
 * already have dedicated unit coverage against captured byte
 * sequences).
 */
import net from "node:net";
import { LineReassembler } from "./lineReassembler.js";
import type { TranscriptLine } from "./types.js";

export interface TcpLineSessionOptions {
  /** Bound on the initial TCP connect. Default 5000ms. */
  connectTimeoutMs?: number;
}

/** One open TCP connection, decoded into lines, with a running verbatim
 * transcript. */
export class TcpLineSession {
  readonly transcript: TranscriptLine[] = [];
  private readonly socket: net.Socket;
  private readonly reassembler = new LineReassembler();
  private readonly lineListeners = new Set<(line: string) => void>();
  private readonly startedAt = Date.now();
  private closed = false;

  private constructor(socket: net.Socket) {
    this.socket = socket;
    this.socket.on("data", (chunk: Buffer) => {
      for (const line of this.reassembler.push(chunk)) {
        this.record("rx", line);
        for (const listener of this.lineListeners) {
          listener(line);
        }
      }
    });
  }

  private record(dir: TranscriptLine["dir"], line: string): void {
    this.transcript.push({ t: Date.now() - this.startedAt, dir, line });
  }

  /** Connect to `host:port`, resolving once the TCP handshake completes
   * (never rejecting — a connect failure resolves `{ ok: false, error }`
   * instead, matching this codebase's own "failure is a value"
   * convention). `ok` is a literal-tagged discriminant (rather than
   * inferring success/failure from whether `session`/`error` happens to
   * be present) so every caller gets clean type narrowing after checking
   * it, regardless of `exactOptionalPropertyTypes`'s stricter rules
   * around optional-vs-absent properties. */
  static connect(
    host: string,
    port: number,
    options: TcpLineSessionOptions = {},
  ): Promise<{ ok: true; session: TcpLineSession } | { ok: false; error: string }> {
    const connectTimeoutMs = options.connectTimeoutMs ?? 5000;
    return new Promise((resolve) => {
      const socket = net.connect({ host, port });
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          socket.destroy();
          resolve({ ok: false, error: `connect to ${host}:${port} timed out after ${connectTimeoutMs}ms` });
        }
      }, connectTimeoutMs);
      socket.once("connect", () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          socket.setNoDelay(true);
          resolve({ ok: true, session: new TcpLineSession(socket) });
        }
      });
      socket.once("error", (error) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve({ ok: false, error: error.message });
        }
      });
    });
  }

  /** Send one line (a trailing `\n` is added). Recorded in the
   * transcript as `"tx"`. */
  send(line: string): void {
    this.record("tx", line);
    this.socket.write(`${line}\n`);
  }

  /** Send `raw` exactly as given, with no newline added — for callers
   * (the mbrelay probe) whose line-builders
   * (`@robot-console/protocol`'s `relay/commands.ts`) already return a
   * string with its own trailing `\n`. Recorded in the transcript with
   * that trailing newline stripped, so the transcript reads the same
   * whichever `send*` method produced it. */
  sendRaw(raw: string): void {
    this.record("tx", raw.endsWith("\n") ? raw.slice(0, -1) : raw);
    this.socket.write(raw);
  }

  /** Subscribe to every line this session receives, from now until
   * `unsubscribe()` is called. Unlike {@link waitForLine} this is not
   * one-shot — used where a caller must distinguish more than one
   * outcome from the same wait window (the mbrelay probe's preamble
   * step confirmation vs. an `"error"` rejection). */
  onLine(listener: (line: string) => void): () => void {
    this.lineListeners.add(listener);
    return () => {
      this.lineListeners.delete(listener);
    };
  }

  /** A free-text note about this probe's own orchestration (never
   * confused with a wire line — see {@link TranscriptLine.dir}). */
  note(text: string): void {
    this.record("info", text);
  }

  /** Resolve the next line matching `predicate`, or `undefined` if none
   * arrives within `timeoutMs`. Lines that arrived before this call was
   * made are not replayed — call this before sending the line whose
   * reply it awaits, matching every probe module's own call order. */
  waitForLine(predicate: (line: string) => boolean, timeoutMs: number): Promise<string | undefined> {
    return new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          this.lineListeners.delete(listener);
          resolve(undefined);
        }
      }, timeoutMs);
      const listener = (line: string): void => {
        if (!settled && predicate(line)) {
          settled = true;
          clearTimeout(timer);
          this.lineListeners.delete(listener);
          resolve(line);
        }
      };
      this.lineListeners.add(listener);
    });
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.socket.destroy();
  }
}
