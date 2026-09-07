/**
 * UsbSerialLink.ts — the USB serial transport for a robot or relay
 * connected locally over its DAPLink CDC serial port. Per
 * `docs/design/specification.md` §4.3: every transport in this system
 * (this sprint's USB link, and sprint 7's relay/TCP/UDP links) reduces
 * to the same shape — a paced, banner-aware stream of newline-delimited
 * protocol-v6 lines. This module establishes that shape by implementing
 * {@link Link}; it does not itself carry any verb/arity/sequencing
 * knowledge — that lives in `@robot-console/protocol` (`banner.ts`,
 * `v6/codec.ts`, `v6/session.ts`), composed here rather than
 * reimplemented, and in the transport-agnostic `link/lineStream.ts`
 * (`LineReassembler`), `link/pacing.ts` (`WritePacer`/`Scheduler`), and
 * `link/LineRouter.ts` (decode -> classify -> ack/nack -> resend) pieces
 * this class composes rather than owns.
 *
 * ## `connect()` then `identify()` — two steps, not one
 *
 * Opening the port resets the target board on macOS (the open toggles
 * DTR and DAPLink resets on DTR assertion); on Linux nothing resets it
 * except a serial break, which this module does not attempt to send. In
 * both cases the boot banner — if the board happens to emit one at all
 * on this platform — is emitted **while the port is still opening**, so
 * waiting for an unsolicited read after connect routinely misses it
 * entirely.
 *
 * The reliable, platform-independent pattern is: {@link connect} opens
 * the port and attaches listeners only — no `HELLO`, no banner wait.
 * {@link identify} then sends `HELLO` (paced like any other write) and
 * reads the banner from `HELLO`'s own reply, never from whatever
 * arrived unsolicited during connect. There is deliberately no macOS/
 * Linux branch anywhere in this sequence — it works identically on
 * both, by construction, whether or not connecting actually reset the
 * board underneath it.
 *
 * {@link identify} **never throws**. A board that never replies is a
 * normal, representable outcome (`null`), not a transport failure — see
 * `link/Link.ts`'s own doc comment for why, and for how this is also
 * the fix for `port-lock-contention-between-identify-and-user-open.md`:
 * {@link connect} opens the port exactly once, and it stays open across
 * every later {@link identify} call — calling {@link identify} again
 * after a `null` resolution re-sends `HELLO` without touching the port.
 * Only {@link connect} itself can reject, and only on a genuine
 * transport-level failure (the port refusing to open, or erroring
 * before it does).
 *
 * ## `HELLO` is a reset, not a health check
 *
 * `HELLO` resets the robot's sequence state to 1 (protocol.md §8.3,
 * mirrored in `v6/session.ts`'s own doc comment). {@link identify} is
 * the ONLY place this module ever sends `HELLO` — it does so via
 * `Session.connect()`, never a hand-formatted line — and nothing in
 * this module re-sends it later as an ongoing liveness check.
 * `Session.sendUnsequenced()` itself refuses the verb `"HELLO"` for
 * exactly this reason, so a caller reaching for the general unsequenced-
 * send path cannot accidentally re-issue it either; use {@link
 * checkLiveness} (`PING`) for any post-connect liveness need.
 */

import { SerialPort } from "serialport";
import {
  parseBanner,
  Session,
  type ParsedBanner,
  type DecodedLine,
  type AckNackEvent,
  type WireField,
} from "@robot-console/protocol";
import { toCalloutPath } from "../devices.js";
import type { Link, LineListener, AckNackListener, LinkErrorListener } from "./Link.js";
import { LineReassembler } from "./lineStream.js";
import { WritePacer, realScheduler, type Scheduler } from "./pacing.js";
import { LineRouter } from "./LineRouter.js";

/** DAPLink CDC serial ports always run at this fixed baud rate. */
const BAUD_RATE = 115200;

/** Default gap between paced writes, in ms. Trap: writing flat out at
 * 115200 baud overruns the board's USB receive buffer — the radio side
 * this bridges to is far slower than the serial link, so every write
 * this module makes (the initial `HELLO` included) goes through the
 * same pacer, not just steady-state traffic. */
const DEFAULT_WRITE_PACE_MS = 10;

/** Default time to wait for a `HELLO` reply (the banner line) during
 * {@link UsbSerialLink.identify} before giving up (resolving `null`). */
const DEFAULT_OPEN_TIMEOUT_MS = 3000;

// ---------------------------------------------------------------------
// Darwin tty./cu. path translation (trap #1)
//
// `toCalloutPath` now lives in `../devices.ts` (sprint 003 ticket 001) —
// `devices.ts` applies it when building `SerialPortInfo.path` so every
// consumer (the Devices tab, `sessionError` text) agrees on the open-safe
// path, not just this one call site. It is imported above and still
// called below in `connect()`, as deliberate defense-in-depth: correct
// even if a caller ever constructs a link directly from a raw path, not
// the only correctness mechanism now.
// ---------------------------------------------------------------------

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

export interface UsbSerialLinkOptions {
  /** ms between paced writes; default {@link DEFAULT_WRITE_PACE_MS}. */
  writePaceMs?: number;
  /** ms to wait for the `HELLO` banner reply during {@link
   * UsbSerialLink.identify} before resolving `null`; default {@link
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

type LinkState = "idle" | "connecting" | "connected" | "closed";

/**
 * The USB serial transport for a robot or relay on local USB — the
 * first implementation of {@link Link} (see `link/Link.ts`'s own doc
 * comment). Owns the actual `serialport` I/O and the connect/identify
 * sequence; composes `link/lineStream.ts`, `link/pacing.ts`, and
 * `link/LineRouter.ts` for the transport-agnostic pieces, and
 * `@robot-console/protocol`'s `banner.ts`/`v6/session.ts` for banner
 * parsing and sequencing, rather than reimplementing any of them.
 */
export class UsbSerialLink implements Link {
  private readonly portPath: string;
  private readonly createPort: (
    path: string,
    options: { baudRate: number },
  ) => SerialPortLike;
  private readonly pacer: WritePacer;
  private readonly openTimeoutMs: number;
  private readonly lineReassembler = new LineReassembler();
  private readonly protocolSession = new Session();
  private readonly lineRouter: LineRouter;

  private readonly lineListeners = new Set<LineListener>();
  private readonly ackNackListeners = new Set<AckNackListener>();
  private readonly errorListeners = new Set<LinkErrorListener>();

  private port: SerialPortLike | undefined;
  private state: LinkState = "idle";
  private parsedBanner: ParsedBanner | undefined;
  /** Set only while {@link identify} is actively waiting for a `HELLO`
   * banner reply — see {@link handleLine}'s own doc comment for why
   * inbound lines are routed differently depending on this flag. */
  private resolveBannerWait: ((banner: ParsedBanner | null) => void) | undefined;

  constructor(portPath: string, options: UsbSerialLinkOptions = {}) {
    this.portPath = portPath;
    this.createPort = options.createPort ?? defaultCreatePort;
    this.openTimeoutMs = options.openTimeoutMs ?? DEFAULT_OPEN_TIMEOUT_MS;
    this.pacer = new WritePacer(
      options.writePaceMs ?? DEFAULT_WRITE_PACE_MS,
      options.scheduler ?? realScheduler,
    );
    this.lineRouter = new LineRouter(this.protocolSession, {
      onLine: (line) => this.dispatchLine(line),
      onAckNack: (event) => this.dispatchAckNack(event),
      resend: (line) => this.paceWrite(line),
    });
  }

  // ---- identity, populated once identify() resolves a banner ---------

  /** The parsed `HELLO` banner reply, once {@link identify} has resolved
   * one. */
  get banner(): ParsedBanner | undefined {
    return this.parsedBanner;
  }

  /** Banner role token (e.g. `"RADIOBRIDGE"`, `"NEZHA2"`), once
   * identified. */
  get role(): string | undefined {
    return this.parsedBanner?.role;
  }

  /** Five-letter device name, once identified. */
  get name(): string | undefined {
    return this.parsedBanner?.name;
  }

  /** Device serial number (decoded per the banner's own role-keyed
   * radix), once identified. */
  get serial(): number | undefined {
    return this.parsedBanner?.serial;
  }

  /** True once {@link connect} has succeeded — reflects the transport,
   * not identification. A `connect()`-ed link with no banner yet (or
   * whose {@link identify} timed out) is still `isOpen`. */
  get isOpen(): boolean {
    return this.state === "connected";
  }

  /** The underlying `v6/session.ts` `Session`, exposed read/write for
   * callers (`server.ts`) that need direct visibility into sequencing
   * state (`pendingCount`, `seq`, ...) beyond what {@link onAckNack}
   * reports as events. Prefer {@link sendCommand}/{@link
   * sendUnsequenced}/{@link checkLiveness} over calling this directly
   * to send — those also take care of write pacing, which sending
   * through the session alone does not. */
  get session(): Session {
    return this.protocolSession;
  }

  // ---- lifecycle --------------------------------------------------------

  /**
   * Open the serial port and attach listeners. Never sends `HELLO`,
   * never waits for a banner — see the module doc comment. Rejects only
   * on a transport-level failure: the port failing to open, or erroring
   * before it does.
   */
  async connect(): Promise<void> {
    if (this.state !== "idle") {
      throw new Error(
        `UsbSerialLink.connect() called while state is "${this.state}" -- a link may only be connected once`,
      );
    }
    this.state = "connecting";

    const calloutPath = toCalloutPath(this.portPath);
    const port = this.createPort(calloutPath, { baudRate: BAUD_RATE });
    this.port = port;
    this.attachPortListeners(port);

    try {
      await this.waitForPortOpen(port);
    } catch (error) {
      this.state = "closed";
      throw error;
    }

    this.state = "connected";
  }

  /**
   * Send `HELLO` and wait for the banner reply. Resolves the parsed
   * banner, or `null` if no banner-shaped reply arrives within
   * `openTimeoutMs` — **never rejects**. May be called again after a
   * `null` resolution; each call re-sends `HELLO` (resetting the
   * session's sequence state, per the module doc comment) without
   * touching the port itself. Throws only if called before {@link
   * connect} has succeeded — a programmer error, not a runtime
   * condition this method's `null`/banner contract covers.
   */
  async identify(): Promise<ParsedBanner | null> {
    this.assertConnected("identify");

    // The one and only place this module ever sends HELLO -- via
    // Session.connect(), never a hand-formatted line, so the session's
    // own local sequencing state resets in lockstep with the reset this
    // line causes on the robot side. See the module doc comment.
    const bannerWait = this.waitForBanner();
    const helloLine = this.protocolSession.connect();
    this.paceWrite(helloLine);
    const banner = await bannerWait;

    if (banner) {
      this.parsedBanner = banner;
    }
    return banner;
  }

  /** Close the port. Idempotent -- calling it again, or before {@link
   * connect} ever succeeded, is a no-op. */
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
    this.assertConnected("sendLine");
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
    this.assertConnected("sendCommand");
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
    this.assertConnected("sendUnsequenced");
    const line = this.protocolSession.sendUnsequenced(verb, fields);
    this.paceWrite(line);
    return line;
  }

  /** Send `PING` — the liveness probe to use instead of re-sending
   * `HELLO` once a session is live (see the module doc comment). */
  checkLiveness(): void {
    this.assertConnected("checkLiveness");
    this.paceWrite(this.protocolSession.checkLiveness());
  }

  private assertConnected(callerName: string): void {
    if (this.state !== "connected") {
      throw new Error(
        `UsbSerialLink.${callerName}() called while not connected (state: "${this.state}") -- call connect() first`,
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
   * §2.1's case-as-direction rule, via `v6/codec.ts`'s `classifyLine`,
   * applied through {@link LineRouter}) — `ack`/`nack` included,
   * alongside `pong`/`status`/`id`/`ver`/`help`/`debug`/`ret`/`err`/etc.
   * A foreign or command-direction inbound line is never delivered here
   * (dropped silently). Returns an unsubscribe function. */
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

  /** Subscribe to port-level errors that occur after {@link connect} has
   * already resolved (an error during connect instead rejects {@link
   * connect} itself). Returns an unsubscribe function. */
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

  /** Never rejects -- resolves `null` on timeout instead. See {@link
   * identify}'s own doc comment and the module doc comment for why. */
  private waitForBanner(): Promise<ParsedBanner | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.resolveBannerWait = undefined;
        resolve(null);
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
   * While {@link identify} is actively waiting for a banner reply
   * ({@link resolveBannerWait} is set): every line is tried against
   * {@link parseBanner} and anything that doesn't parse as a banner is
   * ignored (not an error, not routed through {@link LineRouter}) until
   * one does or the wait times out.
   *
   * Otherwise, whenever the transport is `connected` — whether {@link
   * identify} has never been called yet, resolved a banner, or timed
   * out with `null` — inbound lines are handed to {@link LineRouter}
   * (decode -> classify -> ack/nack -> resend -> dispatch). Routing
   * traffic this way even after a `null` identify is deliberate: a
   * connected-but-unidentified transport (a relay whose target robot
   * hasn't answered) can still legitimately exchange console/liveness
   * traffic (see `link/Link.ts`'s own doc comment for why this state
   * is normal, not an error).
   */
  private handleLine(raw: string): void {
    if (this.resolveBannerWait) {
      const banner = parseBanner(raw);
      if (banner) {
        this.resolveBannerWait(banner);
      }
      return;
    }

    if (this.state !== "connected") {
      return;
    }

    this.lineRouter.handleLine(raw);
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
