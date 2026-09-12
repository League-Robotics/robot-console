/**
 * MbrelayLink.ts — the remote TCP relay transport (sprint 7 ticket 003).
 * See `RelayRadioLink.ts`'s own doc comment for the full rationale this
 * class shares unchanged: the `RelayCommandPlane`/`Link` composition,
 * the "raw lines before the data plane, decoded lines after" split, the
 * `HELLO`-is-a-reset discipline, and the "No `retarget()`" design call
 * (`link/Link.ts`'s own doc comment) — all of that applies here
 * identically and is not repeated in this file.
 *
 * ## What actually differs from `RelayRadioLink`
 *
 * Only the transport-open step: {@link MbrelayLink.connect} opens a TCP
 * socket to a given `host`/`port` (`net.connect`, injectable via {@link
 * MbrelayLinkOptions.createSocket} exactly as `UsbSerialLink`/
 * `RelayRadioLink` inject `createPort`) instead of opening a local
 * serial port, and **sets `TCP_NODELAY` immediately after the socket
 * connects, before any write** — `sprint.md`'s explicit constraint: the
 * command-plane handshake is latency-sensitive, line-at-a-time traffic,
 * and Nagle's algorithm would batch it. Whether `TCP_NODELAY`
 * *measurably* fixes a latency problem is hardware-deferred (sprint
 * 008's bench ticket); setting it, and setting it before the first
 * handshake write goes out, is this ticket's own acceptance criterion,
 * provable against a fake socket with no real network.
 *
 * Once the socket is open and `TCP_NODELAY` is set, `RelayCommandPlane`
 * runs over it unmodified — the same runner `RelayRadioLink` composes,
 * given a paced-write/raw-line-subscribe pair backed by this socket
 * instead of a serial port. Everything from there on (command-plane vs.
 * data-plane line dispatch, `identify()`, `sendCommand()`/
 * `sendUnsequenced()`/`checkLiveness()`, write pacing, `LineRouter`
 * composition) is identical in shape to `RelayRadioLink`'s own — see
 * that module's doc comment for the details.
 */

import { connect as netConnect } from "node:net";
import {
  parseBanner,
  stripReceivePrefix,
  Session,
  type ParsedBanner,
  type DecodedLine,
  type AckNackEvent,
  type WireField,
} from "@robot-console/protocol";
import type { Link, LineListener, RawLineListener, AckNackListener, LinkErrorListener } from "./Link.js";
import { LineReassembler } from "./lineStream.js";
import { WritePacer, realScheduler, type Scheduler } from "./pacing.js";
import { LineRouter } from "./LineRouter.js";
import { runRelayCommandPlane, RelayHandshakeError } from "./RelayCommandPlane.js";

/** Default gap between paced writes, in ms -- see `RelayRadioLink.ts`'s
 * own `DEFAULT_WRITE_PACE_MS` doc comment; the same overrun risk applies
 * here, even over TCP, since the relay on the other end of this socket
 * paces its own radio-side writes at the same rate regardless of which
 * transport carries them to it. */
const DEFAULT_WRITE_PACE_MS = 10;

/** Default time to wait for the `!CG`/`!GO` confirmation replies during
 * {@link MbrelayLink.connect}'s handshake -- see `RelayCommandPlane.ts`'s
 * own `DEFAULT_HANDSHAKE_TIMEOUT_MS`, mirrored here as this class's own
 * default exactly as `RelayRadioLink` mirrors it. */
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 3000;

/** Default time to wait for a `HELLO` reply (the banner line) during
 * {@link MbrelayLink.identify} before giving up (resolving `null`) --
 * identical in spirit to `RelayRadioLink.ts`'s own
 * `DEFAULT_OPEN_TIMEOUT_MS`. */
const DEFAULT_OPEN_TIMEOUT_MS = 3000;

// ---------------------------------------------------------------------
// Injectable socket shape (real `net.Socket` in production, a fake in
// tests) -- mirrors `UsbSerialLink.ts`'s `SerialPortLike` seam exactly,
// narrowed to the `net.Socket` methods this module actually uses.
// ---------------------------------------------------------------------

export interface TcpSocketLike {
  on(event: "data", listener: (chunk: Buffer) => void): void;
  on(event: "error", listener: (err: Error) => void): void;
  on(event: "close", listener: () => void): void;
  once(event: "connect", listener: () => void): void;
  once(event: "error", listener: (err: Error) => void): void;
  write(data: string, callback?: (err?: Error | null) => void): boolean;
  /** Sets or clears `TCP_NODELAY` on the socket -- Nagle's algorithm is
   * on by default for a new `net.Socket`; this module always calls it
   * with `true` (see the module doc comment). */
  setNoDelay(noDelay?: boolean): void;
  /** Ends the connection. Mirrors real `net.Socket#end`'s
   * `callback`-on-close-ish contract closely enough for this module's
   * needs -- an idempotent, best-effort shutdown, not a full FIN/ACK
   * modeling exercise. */
  end(callback?: () => void): void;
}

function defaultCreateSocket(host: string, port: number): TcpSocketLike {
  return netConnect({ host, port }) as unknown as TcpSocketLike;
}

export interface MbrelayLinkOptions {
  /** ms between paced writes; default {@link DEFAULT_WRITE_PACE_MS}. */
  writePaceMs?: number;
  /** ms to wait for the `HELLO` banner reply during {@link
   * MbrelayLink.identify} before resolving `null`; default {@link
   * DEFAULT_OPEN_TIMEOUT_MS}. */
  openTimeoutMs?: number;
  /** ms to wait for the `!CG` confirmation reply, and separately the
   * `!GO` confirmation reply, during {@link MbrelayLink.connect}'s
   * handshake; default {@link DEFAULT_HANDSHAKE_TIMEOUT_MS}. Passed
   * straight through to `RelayCommandPlane.ts`'s `timeoutMs`. */
  handshakeTimeoutMs?: number;
  /** Injectable socket factory. Defaults to real `net.connect`; tests
   * substitute a fake implementing {@link TcpSocketLike} (same
   * discipline as `UsbSerialLink`'s `createPort` seam). */
  createSocket?: (host: string, port: number) => TcpSocketLike;
  /** Injectable write-pacing scheduler, exactly as
   * `RelayRadioLinkOptions.scheduler`. Defaults to real timers ({@link
   * realScheduler}). */
  scheduler?: Scheduler;
  /** Injectable delay primitive for the handshake's `!CG`/`!GO`
   * confirmation-wait timeouts specifically -- see
   * `RelayRadioLinkOptions.handshakeScheduler`'s own doc comment for why
   * this is separate from {@link scheduler}. Defaults to {@link
   * scheduler} (or {@link realScheduler} if that is also unset). */
  handshakeScheduler?: Scheduler;
}

type LinkState = "idle" | "connecting" | "connected" | "closed";

/**
 * The remote TCP relay transport -- see the module doc comment. Owns the
 * TCP socket I/O and the connect-then-handshake-then-identify sequence;
 * composes `link/lineStream.ts`, `link/pacing.ts`, and
 * `link/LineRouter.ts` for the transport-agnostic pieces, and
 * `link/RelayCommandPlane.ts` for the relay-specific command-plane
 * handshake, exactly as `RelayRadioLink` does -- neither module
 * reimplements any of them.
 */
export class MbrelayLink implements Link {
  private readonly host: string;
  private readonly port: number;
  private readonly channel: number;
  private readonly group: number;
  private readonly createSocket: (host: string, port: number) => TcpSocketLike;
  private readonly pacer: WritePacer;
  private readonly openTimeoutMs: number;
  private readonly handshakeTimeoutMs: number;
  private readonly handshakeScheduler: Scheduler;
  private readonly lineReassembler = new LineReassembler();
  private readonly protocolSession = new Session();
  private readonly lineRouter: LineRouter;

  private readonly lineListeners = new Set<LineListener>();
  private readonly rawLineListeners = new Set<RawLineListener>();
  private readonly ackNackListeners = new Set<AckNackListener>();
  private readonly errorListeners = new Set<LinkErrorListener>();
  private readonly commandPlaneListeners = new Set<(line: string) => void>();

  private socket: TcpSocketLike | undefined;
  private state: LinkState = "idle";
  /** True from the moment the socket connects until `RelayCommandPlane`
   * resolves -- see `RelayRadioLink.ts`'s own `inCommandPlane` doc
   * comment for what this flag switches. */
  private inCommandPlane = true;
  private parsedBanner: ParsedBanner | undefined;
  /** Set only while {@link identify} is actively waiting for a `HELLO`
   * banner reply -- identical role to `RelayRadioLink`'s own field of the
   * same name. */
  private resolveBannerWait: ((banner: ParsedBanner | null) => void) | undefined;

  constructor(host: string, port: number, channel: number, group: number, options: MbrelayLinkOptions = {}) {
    this.host = host;
    this.port = port;
    this.channel = channel;
    this.group = group;
    this.createSocket = options.createSocket ?? defaultCreateSocket;
    this.openTimeoutMs = options.openTimeoutMs ?? DEFAULT_OPEN_TIMEOUT_MS;
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
    this.handshakeScheduler = options.handshakeScheduler ?? options.scheduler ?? realScheduler;
    this.pacer = new WritePacer(
      options.writePaceMs ?? DEFAULT_WRITE_PACE_MS,
      options.scheduler ?? realScheduler,
    );
    this.lineRouter = new LineRouter(this.protocolSession, {
      onLine: (line) => this.dispatchLine(line),
      onAckNack: (event) => this.dispatchAckNack(event),
      resend: (line) => this.paceWrite(line),
      onUnrouted: (raw) => this.dispatchRawLine(raw),
    });
  }

  // ---- identity, populated once identify() resolves a banner ---------

  /** The parsed `HELLO` banner reply, once {@link identify} has resolved
   * one. */
  get banner(): ParsedBanner | undefined {
    return this.parsedBanner;
  }

  /** Banner role token (e.g. `"NEZHA2"`), once identified. */
  get role(): string | undefined {
    return this.parsedBanner?.role;
  }

  /** Five-letter device name, once identified. */
  get name(): string | undefined {
    return this.parsedBanner?.name;
  }

  /** Device serial number, once identified. */
  get serial(): number | undefined {
    return this.parsedBanner?.serial;
  }

  /** True once {@link connect} (socket connect + handshake) has
   * succeeded. */
  get isOpen(): boolean {
    return this.state === "connected";
  }

  /** The underlying `v6/session.ts` `Session` -- see `RelayRadioLink`'s
   * own getter of the same name for why callers should prefer {@link
   * sendCommand}/{@link sendUnsequenced}/{@link checkLiveness} over
   * writing through this directly. */
  get session(): Session {
    return this.protocolSession;
  }

  // ---- lifecycle --------------------------------------------------------

  /**
   * Open a TCP socket to `host`/`port`, set `TCP_NODELAY` on it (before
   * any write -- see the module doc comment), then run
   * `RelayCommandPlane`'s handshake over it. Rejects on either a
   * transport-level failure (the socket refusing to connect) or a
   * handshake failure (`!CG` rejected/timed out, `!GO` timed out) -- in
   * both cases the socket, if it connected, is closed and the link never
   * reaches `"connected"`; there is no partial "connected but
   * handshake-pending" state a caller could observe or act on, exactly
   * as `RelayRadioLink.connect()`.
   */
  async connect(): Promise<void> {
    if (this.state !== "idle") {
      throw new Error(
        `MbrelayLink.connect() called while state is "${this.state}" -- a link may only be connected once`,
      );
    }
    this.state = "connecting";

    const socket = this.createSocket(this.host, this.port);
    this.socket = socket;
    this.attachSocketListeners(socket);

    try {
      await this.waitForSocketConnect(socket);
    } catch (error) {
      this.state = "closed";
      throw new Error(
        `MbrelayLink.connect() failed: could not reach mbrelay at ${this.host}:${this.port} -- ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    // TCP_NODELAY immediately after connect, before any write -- the
    // module doc comment's own constraint, and this ticket's first
    // acceptance criterion.
    socket.setNoDelay(true);

    try {
      await runRelayCommandPlane({
        write: (line) => this.paceWrite(line),
        subscribe: (listener) => this.subscribeCommandPlaneLine(listener),
        channel: this.channel,
        group: this.group,
        timeoutMs: this.handshakeTimeoutMs,
        scheduler: this.handshakeScheduler,
      });
    } catch (error) {
      await this.closeSocketSilently(socket);
      this.state = "closed";
      const reason = error instanceof RelayHandshakeError ? error.message : String(error);
      throw new Error(`MbrelayLink.connect() failed: relay command-plane handshake failed -- ${reason}`);
    }

    this.inCommandPlane = false;
    this.state = "connected";
  }

  /**
   * Send `HELLO` and wait for the banner reply -- identical contract to
   * `RelayRadioLink.identify()` (see that module's doc comment). Only
   * reachable once {@link connect} has resolved, i.e. once the data
   * plane has already been reached -- `inCommandPlane` is always `false`
   * by the time this can be called.
   */
  async identify(): Promise<ParsedBanner | null> {
    this.assertConnected("identify");

    const bannerWait = this.waitForBanner();
    const helloLine = this.protocolSession.connect();
    this.paceWrite(helloLine);
    const banner = await bannerWait;

    if (banner) {
      this.parsedBanner = banner;
    }
    return banner;
  }

  /** Close the socket. Idempotent. */
  close(): Promise<void> {
    const socket = this.socket;
    if (!socket || this.state === "closed") {
      this.state = "closed";
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      socket.end(() => {
        this.state = "closed";
        resolve();
      });
    });
  }

  // ---- sending ------------------------------------------------------

  sendLine(line: string): void {
    this.assertConnected("sendLine");
    this.paceWrite(line.endsWith("\n") ? line : `${line}\n`);
  }

  sendCommand(verb: string, fields: readonly WireField[] = []): string {
    this.assertConnected("sendCommand");
    const line = this.protocolSession.send(verb, fields);
    this.paceWrite(line);
    return line;
  }

  sendUnsequenced(verb: string, fields: readonly WireField[] = []): string {
    this.assertConnected("sendUnsequenced");
    const line = this.protocolSession.sendUnsequenced(verb, fields);
    this.paceWrite(line);
    return line;
  }

  checkLiveness(): void {
    this.assertConnected("checkLiveness");
    this.paceWrite(this.protocolSession.checkLiveness());
  }

  private assertConnected(callerName: string): void {
    if (this.state !== "connected") {
      throw new Error(
        `MbrelayLink.${callerName}() called while not connected (state: "${this.state}") -- call connect() first`,
      );
    }
  }

  private paceWrite(lineText: string): void {
    this.pacer.schedule(() => {
      this.socket?.write(lineText);
    });
  }

  // ---- receiving ------------------------------------------------------

  onLine(listener: LineListener): () => void {
    this.lineListeners.add(listener);
    return () => {
      this.lineListeners.delete(listener);
    };
  }

  onRawLine(listener: RawLineListener): () => void {
    this.rawLineListeners.add(listener);
    return () => {
      this.rawLineListeners.delete(listener);
    };
  }

  onAckNack(listener: AckNackListener): () => void {
    this.ackNackListeners.add(listener);
    return () => {
      this.ackNackListeners.delete(listener);
    };
  }

  onError(listener: LinkErrorListener): () => void {
    this.errorListeners.add(listener);
    return () => {
      this.errorListeners.delete(listener);
    };
  }

  /** Subscribe to raw, already-reassembled lines while {@link
   * inCommandPlane} is `true` -- the seam `RelayCommandPlane` is driven
   * over. Never delivers anything once the data plane is reached; see
   * `RelayRadioLink.ts`'s own doc comment. */
  private subscribeCommandPlaneLine(listener: (line: string) => void): () => void {
    this.commandPlaneListeners.add(listener);
    return () => {
      this.commandPlaneListeners.delete(listener);
    };
  }

  private attachSocketListeners(socket: TcpSocketLike): void {
    socket.on("data", (chunk) => {
      for (const raw of this.lineReassembler.push(chunk)) {
        this.handleRawLine(raw);
      }
    });
    socket.on("error", (err) => {
      this.dispatchError(err);
    });
    socket.on("close", () => {
      this.state = "closed";
    });
  }

  private waitForSocketConnect(socket: TcpSocketLike): Promise<void> {
    return new Promise((resolve, reject) => {
      socket.once("connect", () => {
        resolve();
      });
      socket.once("error", (err) => {
        reject(err);
      });
    });
  }

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

  /** Dispatch one already-reassembled, already-normalized raw line to
   * whichever phase this link is currently in -- see `RelayRadioLink.ts`'s
   * own doc comment. */
  private handleRawLine(raw: string): void {
    if (this.inCommandPlane) {
      for (const listener of this.commandPlaneListeners) {
        listener(raw);
      }
      return;
    }
    this.handleLine(raw);
  }

  /** Identical to `RelayRadioLink#handleLine` -- banner-wait during
   * {@link identify}, `LineRouter` otherwise. Only ever reached once
   * {@link inCommandPlane} is `false`, i.e. once the handshake has
   * already succeeded. */
  private handleLine(raw: string): void {
    if (this.resolveBannerWait) {
      const banner = parseBanner(stripReceivePrefix(raw));
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

  private dispatchRawLine(raw: string): void {
    for (const listener of this.rawLineListeners) {
      listener(raw);
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

  /** Best-effort close after a handshake failure -- swallows a close
   * error (there is no caller to report it to beyond the handshake
   * failure itself, which is already what {@link connect} rejects
   * with). */
  private closeSocketSilently(socket: TcpSocketLike): Promise<void> {
    return new Promise((resolve) => {
      socket.end(() => resolve());
    });
  }
}
