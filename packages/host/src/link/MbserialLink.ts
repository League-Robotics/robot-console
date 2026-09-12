/**
 * MbserialLink.ts — the direct-to-robot TCP transport (sprint 7 ticket
 * 004). **This transport has no command plane, deliberately.**
 *
 * `_mbserial._tcp` (mbdeploy `serve`) exposes one specific robot's
 * serial port directly over TCP — there is no relay multiplexing a
 * shared radio channel in the path, so there is nothing to tell it
 * which channel/group to bridge, and no `!ECHO OFF` / `!MODE RAW250` /
 * `!CG <ch> <grp>` / `!P 7` / `!GO` preamble to run. `RelayRadioLink`
 * and `MbrelayLink` (tickets 002/003) both talk to a *relay* that must
 * be told what to bridge before any robot traffic can flow; this class
 * talks straight to a robot's own serial port, exactly as
 * `UsbSerialLink` does over a local port. **Do not** route this
 * transport through `RelayCommandPlane.ts` or give it `channel`/`group`
 * fields "for consistency" with the other two — nothing on the other
 * end of an `_mbserial._tcp` socket speaks the relay's `!CG`/`!GO`
 * grammar, and sending it would break a plain robot's own
 * `HELLO`/`identify()` exchange (see `sprint.md`'s Design Rationale,
 * "`MbserialLink` has no command plane"). This module has no import
 * from `RelayCommandPlane.ts` or `@robot-console/protocol/relay/
 * commands.ts` at all, and a source-scan test in
 * `MbserialLink.test.ts` enforces it, not just review discipline.
 *
 * Structurally this is `UsbSerialLink` with a TCP socket standing in
 * for a local serial port, nothing more: {@link connect} opens the
 * socket and attaches listeners only, and {@link identify} is the very
 * next thing that sends anything (`HELLO`, exactly as
 * `UsbSerialLink.identify()` does) — see that module's own doc comment
 * for the full connect()/identify() split rationale, the `HELLO`-is-a-
 * reset discipline, and the "No `retarget()`" design call
 * (`link/Link.ts`'s own doc comment); all of that applies here
 * unchanged and is not repeated in this file.
 *
 * ## `TCP_NODELAY`: deliberately left unset
 *
 * `MbrelayLink` sets `TCP_NODELAY` immediately after connecting because
 * its command-plane handshake is latency-sensitive, line-at-a-time
 * traffic that Nagle's algorithm would otherwise batch (see that
 * module's own doc comment, and `sprint.md`'s Solution section). That
 * argument does not transfer here: this transport has no handshake
 * phase at all — the only traffic on the wire is the same paced,
 * line-at-a-time v6 protocol stream every other transport already
 * sends, gapped `DEFAULT_WRITE_PACE_MS` apart specifically so a
 * receiver's buffer is never overrun. Whether Nagle's default coalescing
 * window is even reachable at a 10ms-plus write cadence is questionable,
 * and there is no bench evidence either way yet (see `sprint.md`'s Step
 * 7 Open Questions, which explicitly leaves this transport's
 * `TCP_NODELAY` unset for sprint 007 and defers it to sprint 008's bench
 * ticket if remote-mbserial latency turns out to matter in practice).
 * This is accordingly a deliberate judgment call, not an oversight: no
 * `setNoDelay` call is made, and {@link TcpSocketLike} does not even
 * declare the method, since this module has no use for it.
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

/** Default gap between paced writes, in ms — see `UsbSerialLink.ts`'s
 * own `DEFAULT_WRITE_PACE_MS` doc comment; the robot on the other end of
 * this socket is the same board with the same USB receive buffer, so
 * the same overrun risk and the same pacing applies whether the bytes
 * arrive over a local serial port or a TCP socket. */
const DEFAULT_WRITE_PACE_MS = 10;

/** Default time to wait for a `HELLO` reply (the banner line) during
 * {@link MbserialLink.identify} before giving up (resolving `null`) —
 * identical in spirit to `UsbSerialLink.ts`'s own
 * `DEFAULT_OPEN_TIMEOUT_MS`. */
const DEFAULT_OPEN_TIMEOUT_MS = 3000;

// ---------------------------------------------------------------------
// Injectable socket shape (real `net.Socket` in production, a fake in
// tests) — mirrors `UsbSerialLink.ts`'s `SerialPortLike` seam, narrowed
// to the `net.Socket` methods this module actually uses. Deliberately
// has no `setNoDelay` method — see the module doc comment's
// `TCP_NODELAY` section for why this transport never calls it.
// ---------------------------------------------------------------------

export interface TcpSocketLike {
  on(event: "data", listener: (chunk: Buffer) => void): void;
  on(event: "error", listener: (err: Error) => void): void;
  on(event: "close", listener: () => void): void;
  once(event: "connect", listener: () => void): void;
  once(event: "error", listener: (err: Error) => void): void;
  write(data: string, callback?: (err?: Error | null) => void): boolean;
  /** Ends the connection. Mirrors real `net.Socket#end`'s
   * `callback`-on-close-ish contract closely enough for this module's
   * needs — an idempotent, best-effort shutdown, not a full FIN/ACK
   * modeling exercise. */
  end(callback?: () => void): void;
}

function defaultCreateSocket(host: string, port: number): TcpSocketLike {
  return netConnect({ host, port }) as unknown as TcpSocketLike;
}

export interface MbserialLinkOptions {
  /** ms between paced writes; default {@link DEFAULT_WRITE_PACE_MS}. */
  writePaceMs?: number;
  /** ms to wait for the `HELLO` banner reply during {@link
   * MbserialLink.identify} before resolving `null`; default {@link
   * DEFAULT_OPEN_TIMEOUT_MS}. */
  openTimeoutMs?: number;
  /** Injectable socket factory. Defaults to real `net.connect`; tests
   * substitute a fake implementing {@link TcpSocketLike} (same
   * discipline as `UsbSerialLink`'s `createPort` seam). */
  createSocket?: (host: string, port: number) => TcpSocketLike;
  /** Injectable write-pacing scheduler. Defaults to real timers ({@link
   * realScheduler}); tests substitute a fake to assert pacing without
   * real wall-clock delays. */
  scheduler?: Scheduler;
}

type LinkState = "idle" | "connecting" | "connected" | "closed";

/**
 * The direct-to-robot TCP transport — see the module doc comment for
 * why it has no command plane. Owns the TCP socket I/O and the
 * connect/identify sequence; composes `link/lineStream.ts`,
 * `link/pacing.ts`, and `link/LineRouter.ts` for the transport-agnostic
 * pieces, exactly as `UsbSerialLink` does — nothing from
 * `RelayCommandPlane.ts` or `protocol/relay/commands.ts` is imported or
 * composed here.
 */
export class MbserialLink implements Link {
  private readonly host: string;
  private readonly port: number;
  private readonly createSocket: (host: string, port: number) => TcpSocketLike;
  private readonly pacer: WritePacer;
  private readonly openTimeoutMs: number;
  private readonly lineReassembler = new LineReassembler();
  private readonly protocolSession = new Session();
  private readonly lineRouter: LineRouter;

  private readonly lineListeners = new Set<LineListener>();
  private readonly rawLineListeners = new Set<RawLineListener>();
  private readonly ackNackListeners = new Set<AckNackListener>();
  private readonly errorListeners = new Set<LinkErrorListener>();

  private socket: TcpSocketLike | undefined;
  private state: LinkState = "idle";
  private parsedBanner: ParsedBanner | undefined;
  /** Set only while {@link identify} is actively waiting for a `HELLO`
   * banner reply — see `UsbSerialLink.ts`'s own field of the same name
   * for what this switches. */
  private resolveBannerWait: ((banner: ParsedBanner | null) => void) | undefined;

  constructor(host: string, port: number, options: MbserialLinkOptions = {}) {
    this.host = host;
    this.port = port;
    this.createSocket = options.createSocket ?? defaultCreateSocket;
    this.openTimeoutMs = options.openTimeoutMs ?? DEFAULT_OPEN_TIMEOUT_MS;
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

  /** True once {@link connect} (socket connect only — there is no
   * handshake step) has succeeded. */
  get isOpen(): boolean {
    return this.state === "connected";
  }

  /** The underlying `v6/session.ts` `Session` — see `UsbSerialLink`'s
   * own getter of the same name for why callers should prefer {@link
   * sendCommand}/{@link sendUnsequenced}/{@link checkLiveness} over
   * writing through this directly. */
  get session(): Session {
    return this.protocolSession;
  }

  // ---- lifecycle --------------------------------------------------------

  /**
   * Open a TCP socket to `host`/`port` and attach listeners. **No
   * handshake step of any kind** — no preamble, no `RelayCommandPlane`
   * involvement at all (see the module doc comment). Never sends
   * `HELLO`, never waits for a banner. Rejects only on a transport-level
   * failure: the socket refusing to connect, or erroring before it
   * does. The rejection message distinguishes "could not reach" (a
   * genuine transport failure — unreachable host, connection refused)
   * from a handshake-shaped failure, because there is no handshake here
   * to fail — every `connect()` rejection from this class is a
   * transport-level failure by construction.
   */
  async connect(): Promise<void> {
    if (this.state !== "idle") {
      throw new Error(
        `MbserialLink.connect() called while state is "${this.state}" -- a link may only be connected once`,
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
        `MbserialLink.connect() failed: could not reach ${this.host}:${this.port} -- ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    this.state = "connected";
  }

  /**
   * Send `HELLO` and wait for the banner reply — identical contract to
   * `UsbSerialLink.identify()` (see that module's doc comment). This is
   * the very first thing this class ever sends: {@link connect} runs no
   * preamble before it.
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
        `MbserialLink.${callerName}() called while not connected (state: "${this.state}") -- call connect() first`,
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

  private attachSocketListeners(socket: TcpSocketLike): void {
    socket.on("data", (chunk) => {
      for (const raw of this.lineReassembler.push(chunk)) {
        this.handleLine(raw);
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

  /** Never rejects -- resolves `null` on timeout instead. See {@link
   * identify}'s own doc comment and `UsbSerialLink.ts`'s module doc
   * comment for why. */
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

  /** Handle one already-reassembled, already-normalized inbound line —
   * identical dispatch to `UsbSerialLink#handleLine`: banner-wait during
   * {@link identify}, `LineRouter` otherwise. There is no command-plane
   * phase to branch on here (contrast `MbrelayLink#handleRawLine`,
   * which dispatches to command-plane listeners while
   * `inCommandPlane` is true) — this transport is in the data plane
   * from the moment {@link connect} resolves. */
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
}
