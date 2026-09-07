/**
 * UsbSerialLink.ts — the USB serial transport for a robot or relay
 * connected locally over its DAPLink CDC serial port. Per
 * `docs/design/specification.md` §4.3: every transport in this system
 * (this sprint's USB link, and sprint 3/6's relay/TCP/UDP links) reduces
 * to the same shape — a paced, banner-aware stream of newline-delimited
 * protocol-v6 lines. This module establishes that shape; it does not
 * itself carry any verb/arity/sequencing knowledge — that all lives in
 * `@robot-console/protocol` (`banner.ts`, `v6/codec.ts`, `v6/session.ts`),
 * which this module composes rather than reimplements.
 *
 * ## The open → HELLO → read-banner-from-reply sequence
 *
 * Opening the port resets the target board on macOS (the open toggles
 * DTR and DAPLink resets on DTR assertion); on Linux nothing resets it
 * except a serial break, which this module does not attempt to send. In
 * both cases the boot banner — if the board happens to emit one at all
 * on this platform — is emitted **while the port is still opening**, so
 * waiting for an unsolicited read after open routinely misses it
 * entirely.
 *
 * The reliable, platform-independent pattern — and the ONLY sequence
 * {@link UsbSerialLink.open} implements — is: open the port, send
 * `HELLO` (paced like any other write), and read the banner from
 * `HELLO`'s own reply, never from whatever arrived unsolicited during
 * open. There is deliberately no macOS/Linux branch in {@link
 * UsbSerialLink.open} itself — the open→HELLO→read-reply sequence works
 * identically on both, by construction, whether or not the open
 * actually reset the board underneath it.
 *
 * ## `HELLO` is a reset, not a health check
 *
 * `HELLO` resets the robot's sequence state to 1 (protocol.md §8.3,
 * mirrored in `v6/session.ts`'s own doc comment). {@link
 * UsbSerialLink.open} is the ONLY place this module ever sends `HELLO`
 * — it does so via `Session.connect()`, never a hand-formatted line —
 * and nothing in this module re-sends it later as an ongoing liveness
 * check. `Session.sendUnsequenced()` itself refuses the verb `"HELLO"`
 * for exactly this reason, so a caller reaching for the general
 * unsequenced-send path cannot accidentally re-issue it either; use
 * {@link UsbSerialLink.checkLiveness} (`PING`) for any post-open
 * liveness need.
 */

import { SerialPort } from "serialport";
import {
  parseBanner,
  decodeLine,
  classifyLine,
  Session,
  type ParsedBanner,
  type DecodedLine,
  type AckNackEvent,
  type WireField,
} from "@robot-console/protocol";
import { toCalloutPath } from "../devices.js";

/** DAPLink CDC serial ports always run at this fixed baud rate. */
const BAUD_RATE = 115200;

/** Default gap between paced writes, in ms. Trap: writing flat out at
 * 115200 baud overruns the board's USB receive buffer — the radio side
 * this bridges to is far slower than the serial link, so every write
 * this module makes (the initial `HELLO` included) goes through the
 * same pacer, not just steady-state traffic. */
const DEFAULT_WRITE_PACE_MS = 10;

/** Default time to wait for a `HELLO` reply (the banner line) during
 * {@link UsbSerialLink.open} before giving up. */
const DEFAULT_OPEN_TIMEOUT_MS = 3000;

// ---------------------------------------------------------------------
// Darwin tty./cu. path translation (trap #1)
//
// `toCalloutPath` now lives in `../devices.ts` (sprint 003 ticket 001) —
// `devices.ts` applies it when building `SerialPortInfo.path` so every
// consumer (the Devices tab, `linkError` text) agrees on the open-safe
// path, not just this one call site. It is imported above and still
// called below in `open()`, as deliberate defense-in-depth: correct
// even if a caller ever constructs a link directly from a raw path, not
// the only correctness mechanism now.
// ---------------------------------------------------------------------
// Line reassembly (trap #6, #7)
// ---------------------------------------------------------------------

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

// ---------------------------------------------------------------------
// Write pacing (trap #5)
// ---------------------------------------------------------------------

/** Injectable delay primitive so write-pacing timing is unit-testable
 * without real wall-clock waits. Real usage defaults to {@link
 * realScheduler}; tests substitute a fake that records/controls delay
 * calls directly. */
export interface Scheduler {
  delay(ms: number): Promise<void>;
}

export const realScheduler: Scheduler = {
  delay: (ms: number) =>
    new Promise((resolve) => {
      setTimeout(resolve, ms);
    }),
};

/**
 * Serializes writes through a single chain so that every write this
 * module makes is separated from the next by at least `paceMs` — the
 * initial `HELLO` included, not just steady-state console traffic (see
 * the module doc comment's pacing trap). Implemented as a promise chain
 * rather than a timer-driven queue so that back-to-back `schedule()`
 * calls compose correctly regardless of how many are already pending.
 */
export class WritePacer {
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly paceMs: number,
    private readonly scheduler: Scheduler = realScheduler,
  ) {}

  /** Enqueue `write` to run once every previously-scheduled write (and
   * its trailing pace delay) has completed. A throwing `write` does not
   * wedge later writes — the failure is swallowed here (there is no
   * caller to report it to; this is fire-and-forget queuing) and the
   * chain continues. */
  schedule(write: () => void): void {
    this.chain = this.chain
      .then(() => {
        write();
      })
      .then(() => this.scheduler.delay(this.paceMs))
      .catch(() => {
        // Swallow: one bad write must not stall every later paced write.
      });
  }
}

// ---------------------------------------------------------------------
// Injectable port shape (real `serialport` in production, a fake in tests)
// ---------------------------------------------------------------------

/**
 * The slice of `serialport`'s `SerialPort` (itself a Node `Duplex`
 * stream / `EventEmitter`) this module actually uses. Kept narrow and
 * exported so unit tests can drive {@link UsbSerialLink} against a fully
 * synthetic fake — the ticket's own testing note calls the real
 * `serialport` I/O "not meaningfully unit-testable without real
 * hardware or a fairly elaborate serial-port fake"; this interface is
 * that seam.
 */
export interface SerialPortLike {
  on(event: "data", listener: (chunk: Buffer) => void): void;
  on(event: "error", listener: (err: Error) => void): void;
  on(event: "close", listener: () => void): void;
  once(event: "open", listener: () => void): void;
  once(event: "error", listener: (err: Error) => void): void;
  write(data: string, callback?: (err?: Error | null) => void): boolean;
  close(callback?: (err?: Error | null) => void): void;
}

function defaultCreatePort(path: string, options: { baudRate: number }): SerialPortLike {
  return new SerialPort({ path, baudRate: options.baudRate }) as unknown as SerialPortLike;
}

// ---------------------------------------------------------------------
// UsbSerialLink
// ---------------------------------------------------------------------

export type LineListener = (line: DecodedLine) => void;
export type AckNackListener = (event: AckNackEvent) => void;
export type LinkErrorListener = (err: Error) => void;

export interface UsbSerialLinkOptions {
  /** ms between paced writes; default {@link DEFAULT_WRITE_PACE_MS}. */
  writePaceMs?: number;
  /** ms to wait for the `HELLO` banner reply during {@link
   * UsbSerialLink.open} before rejecting; default {@link
   * DEFAULT_OPEN_TIMEOUT_MS}. */
  openTimeoutMs?: number;
  /** Injectable port factory. Defaults to real `serialport`; tests
   * substitute a fake implementing {@link SerialPortLike}. */
  createPort?: (path: string, options: { baudRate: number }) => SerialPortLike;
  /** Injectable write-pacing scheduler. Defaults to real timers ({@link
   * realScheduler}); tests substitute a fake to assert pacing without
   * real wall-clock delays. */
  scheduler?: Scheduler;
}

type LinkState = "idle" | "opening" | "open" | "closed";

/**
 * The USB serial transport for a robot or relay on local USB — the
 * first of the `link/` family (see the module doc comment). Owns the
 * actual `serialport` I/O, the open→HELLO→read-banner sequence, and
 * write pacing; it composes `@robot-console/protocol`'s `banner.ts`/
 * `v6/codec.ts`/`v6/session.ts` rather than reimplementing banner
 * parsing, line framing, or ack/nack sequencing itself.
 */
export class UsbSerialLink {
  private readonly portPath: string;
  private readonly createPort: (
    path: string,
    options: { baudRate: number },
  ) => SerialPortLike;
  private readonly pacer: WritePacer;
  private readonly openTimeoutMs: number;
  private readonly lineReassembler = new LineReassembler();
  private readonly protocolSession = new Session();

  private readonly lineListeners = new Set<LineListener>();
  private readonly ackNackListeners = new Set<AckNackListener>();
  private readonly errorListeners = new Set<LinkErrorListener>();

  private port: SerialPortLike | undefined;
  private state: LinkState = "idle";
  private parsedBanner: ParsedBanner | undefined;
  private resolveBannerWait: ((banner: ParsedBanner) => void) | undefined;

  constructor(portPath: string, options: UsbSerialLinkOptions = {}) {
    this.portPath = portPath;
    this.createPort = options.createPort ?? defaultCreatePort;
    this.openTimeoutMs = options.openTimeoutMs ?? DEFAULT_OPEN_TIMEOUT_MS;
    this.pacer = new WritePacer(
      options.writePaceMs ?? DEFAULT_WRITE_PACE_MS,
      options.scheduler ?? realScheduler,
    );
  }

  // ---- identity, populated after open() -------------------------------

  /** The parsed `HELLO` banner reply, once {@link open} has resolved. */
  get banner(): ParsedBanner | undefined {
    return this.parsedBanner;
  }

  /** Banner role token (e.g. `"RADIOBRIDGE"`, `"NEZHA2"`), once open. */
  get role(): string | undefined {
    return this.parsedBanner?.role;
  }

  /** Five-letter device name, once open. */
  get name(): string | undefined {
    return this.parsedBanner?.name;
  }

  /** Device serial number (decoded per the banner's own role-keyed
   * radix), once open. */
  get serial(): number | undefined {
    return this.parsedBanner?.serial;
  }

  get isOpen(): boolean {
    return this.state === "open";
  }

  /** The underlying `v6/session.ts` `Session`, exposed read/write for
   * callers (`server.ts`, ticket 009) that need direct visibility into
   * sequencing state (`pendingCount`, `seq`, ...) beyond what {@link
   * onAckNack} reports as events. Prefer {@link sendCommand}/{@link
   * sendUnsequenced}/{@link checkLiveness} over calling this directly
   * to send — those also take care of write pacing, which sending
   * through the session alone does not. */
  get session(): Session {
    return this.protocolSession;
  }

  // ---- lifecycle --------------------------------------------------------

  /**
   * Open the serial port and identify the device on the other end.
   *
   * Always follows open → send `HELLO` → read the banner from the
   * reply (see the module doc comment) — never from an unsolicited read
   * during open. Resolves with the parsed banner once it arrives, or
   * rejects if the port fails to open, errors before a banner arrives,
   * or no banner-shaped reply arrives within `openTimeoutMs`.
   */
  async open(): Promise<ParsedBanner> {
    if (this.state !== "idle") {
      throw new Error(
        `UsbSerialLink.open() called while state is "${this.state}" -- a link may only be opened once`,
      );
    }
    this.state = "opening";

    const calloutPath = toCalloutPath(this.portPath);
    const port = this.createPort(calloutPath, { baudRate: BAUD_RATE });
    this.port = port;
    this.attachPortListeners(port);

    await this.waitForPortOpen(port);

    // The one and only place this module ever sends HELLO -- via
    // Session.connect(), never a hand-formatted line, so the session's
    // own local sequencing state resets in lockstep with the reset this
    // line causes on the robot side. See the module doc comment.
    const bannerWait = this.waitForBanner();
    const helloLine = this.protocolSession.connect();
    this.paceWrite(helloLine);
    const banner = await bannerWait;

    this.parsedBanner = banner;
    this.state = "open";
    return banner;
  }

  /** Close the port. Idempotent -- calling it again, or before {@link
   * open} ever succeeded, is a no-op. */
  close(): Promise<void> {
    const port = this.port;
    if (!port || this.state === "closed") {
      this.state = "closed";
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      port.close((err) => {
        this.state = "closed";
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }

  // ---- sending ------------------------------------------------------

  /**
   * Send an already-formatted line verbatim (a trailing `\n` is added
   * if not already present). Paced like every other write. Intended for
   * raw/console-typed traffic that does not go through {@link
   * sendCommand}/{@link sendUnsequenced} (e.g. a UI console echoing
   * exactly what the user typed).
   */
  sendLine(line: string): void {
    this.assertOpen();
    this.paceWrite(line.endsWith("\n") ? line : `${line}\n`);
  }

  /**
   * Send one of the 11 id-bearing verbs (`GET`, `SET`, `TLM`, `STOP`,
   * `RUN`, `WHEELS_X`, `WHEELS_V`, `MOVE_X`, `MOVE_V`, `GO_TO_R`,
   * `GO_TO_W`), sequenced via `v6/session.ts`'s `Session.send()`. Paced
   * like every other write. Throws `SessionError` (from the protocol
   * package) if `verb` is not one of those 11. Returns the exact line
   * text sent, for callers that want it (e.g. logging).
   */
  sendCommand(verb: string, fields: readonly WireField[] = []): string {
    this.assertOpen();
    const line = this.protocolSession.send(verb, fields);
    this.paceWrite(line);
    return line;
  }

  /**
   * Send an unsequenced verb (`PING`, `STATUS`, `ID`, `VER`, `HELP`,
   * `ESTOP`, ...) via `Session.sendUnsequenced()`. Paced like every
   * other write. `Session.sendUnsequenced()` itself refuses `"HELLO"` —
   * see the module doc comment — so this can never be used to re-send
   * `HELLO` as a live-session health check.
   */
  sendUnsequenced(verb: string, fields: readonly WireField[] = []): string {
    this.assertOpen();
    const line = this.protocolSession.sendUnsequenced(verb, fields);
    this.paceWrite(line);
    return line;
  }

  /** Send `PING` — the liveness probe to use instead of re-sending
   * `HELLO` once a session is live (see the module doc comment). */
  checkLiveness(): void {
    this.assertOpen();
    this.paceWrite(this.protocolSession.checkLiveness());
  }

  private assertOpen(): void {
    if (this.state !== "open") {
      throw new Error(
        `UsbSerialLink is not open (state: "${this.state}") -- call open() first`,
      );
    }
  }

  private paceWrite(lineText: string): void {
    this.pacer.schedule(() => {
      this.port?.write(lineText);
    });
  }

  // ---- receiving ------------------------------------------------------

  /** Subscribe to every inbound reply-direction line (protocol.md
   * §2.1's case-as-direction rule, via `v6/codec.ts`'s `classifyLine`) —
   * `ack`/`nack` included, alongside `pong`/`status`/`id`/`ver`/`help`/
   * `debug`/`ret`/`err`/etc. A foreign or command-direction inbound
   * line is never delivered here (dropped silently — see the module doc
   * comment and the ticket's acceptance criteria). Returns an
   * unsubscribe function. */
  onLine(listener: LineListener): () => void {
    this.lineListeners.add(listener);
    return () => {
      this.lineListeners.delete(listener);
    };
  }

  /** Subscribe to `ack`/`nack` events specifically, as already applied
   * to the session (`Session.handleReply`'s own return value) — a
   * narrower, typed alternative to filtering {@link onLine} yourself.
   * Returns an unsubscribe function. */
  onAckNack(listener: AckNackListener): () => void {
    this.ackNackListeners.add(listener);
    return () => {
      this.ackNackListeners.delete(listener);
    };
  }

  /** Subscribe to port-level errors that occur after {@link open} has
   * already resolved (an error during open instead rejects {@link
   * open} itself). Returns an unsubscribe function. */
  onError(listener: LinkErrorListener): () => void {
    this.errorListeners.add(listener);
    return () => {
      this.errorListeners.delete(listener);
    };
  }

  private attachPortListeners(port: SerialPortLike): void {
    port.on("data", (chunk) => {
      for (const raw of this.lineReassembler.push(chunk)) {
        this.handleLine(raw);
      }
    });
    port.on("error", (err) => {
      this.dispatchError(err);
    });
    port.on("close", () => {
      this.state = "closed";
    });
  }

  private waitForPortOpen(port: SerialPortLike): Promise<void> {
    return new Promise((resolve, reject) => {
      port.once("open", () => {
        resolve();
      });
      port.once("error", (err) => {
        reject(err);
      });
    });
  }

  private waitForBanner(): Promise<ParsedBanner> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.resolveBannerWait = undefined;
        reject(
          new Error(
            `timed out after ${this.openTimeoutMs}ms waiting for a HELLO banner reply from ${this.portPath}`,
          ),
        );
      }, this.openTimeoutMs);
      this.resolveBannerWait = (banner) => {
        clearTimeout(timer);
        this.resolveBannerWait = undefined;
        resolve(banner);
      };
    });
  }

  /**
   * Handle one already-reassembled, already-normalized inbound line
   * (trailing `\r` and leading `"< "` already stripped by {@link
   * LineReassembler}).
   *
   * While `opening`: this is exclusively the HELLO-reply banner wait
   * (see the module doc comment) — every line is tried against {@link
   * parseBanner} and anything that doesn't parse as a banner is
   * ignored (not an error) until one does or the open timeout fires.
   *
   * Once `open`: lines are framed via `v6/codec.ts`'s `decodeLine`,
   * then classified via `classifyLine`. Only `"reply"`-direction lines
   * are ever surfaced to listeners; a blank line, an over-length line,
   * a foreign (unrecognized lowercase) line, and an unexpected
   * command-direction line are all dropped here silently — never
   * surfaced as an error or shown in any output this module produces
   * (the ticket's own acceptance criterion). `ack`/`nack` replies are
   * additionally fed to the session for sequencing bookkeeping, with
   * any resend the session requires re-sent through the same paced
   * write path as everything else.
   */
  private handleLine(raw: string): void {
    if (this.state === "opening") {
      const banner = parseBanner(raw);
      if (banner) {
        this.resolveBannerWait?.(banner);
      }
      return;
    }

    if (this.state !== "open") {
      return;
    }

    const decoded = decodeLine(raw);
    if (decoded.kind !== "line") {
      return;
    }

    if (classifyLine(decoded.verb) !== "reply") {
      return;
    }

    if (decoded.verb === "ack" || decoded.verb === "nack") {
      const event = this.protocolSession.handleReply(decoded);
      if (event) {
        for (const resendLine of event.resend) {
          this.paceWrite(resendLine);
        }
        this.dispatchAckNack(event);
      }
    }

    this.dispatchLine(decoded);
  }

  private dispatchLine(line: DecodedLine): void {
    for (const listener of this.lineListeners) {
      listener(line);
    }
  }

  private dispatchAckNack(event: AckNackEvent): void {
    for (const listener of this.ackNackListeners) {
      listener(event);
    }
  }

  private dispatchError(err: Error): void {
    for (const listener of this.errorListeners) {
      listener(err);
    }
  }
}
