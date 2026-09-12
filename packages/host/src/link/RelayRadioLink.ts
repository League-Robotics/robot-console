/**
 * RelayRadioLink.ts — the local USB relay transport (sprint 7 ticket
 * 002). Implements {@link Link} for a relay board connected locally over
 * its own DAPLink CDC serial port, exactly as `UsbSerialLink` does for a
 * robot on local USB, with one addition: {@link RelayRadioLink.connect}
 * runs the relay command-plane handshake (`link/RelayCommandPlane.ts`,
 * ticket 001's `@robot-console/protocol` line-builders) before the
 * transport is usable as an ordinary v6 line stream.
 *
 * ## Shares everything with `UsbSerialLink` except the open step and the
 * extra handshake
 *
 * Per this ticket's Description: this class composes `link/lineStream.ts`
 * (`LineReassembler`), `link/pacing.ts` (`WritePacer`/`Scheduler`), and
 * `link/LineRouter.ts` (decode -> classify -> ack/nack -> resend) exactly
 * as `UsbSerialLink` does — none of those three modules' logic is
 * reimplemented here. `identify()`/`sendCommand()`/`sendUnsequenced()`/
 * `checkLiveness()`/`onLine()`/`onAckNack()`/`onError()` are the same
 * composition, method for method, as `UsbSerialLink`'s own — see that
 * module's doc comment for the `connect()`/`identify()` split rationale
 * and the `HELLO`-is-a-reset discipline, both of which apply here
 * unchanged once the data plane is reached. `UsbSerialLink.ts` itself is
 * NOT modified or subclassed by this ticket (`sprint.md`'s Impact on
 * Existing Components) — there is no shared base class in this codebase
 * yet, so the glue methods below are written per-class, matching the
 * only existing precedent.
 *
 * ## The one thing that's different: a command-plane phase before the
 * data plane
 *
 * A raw inbound line is routed one of two ways, depending on {@link
 * inCommandPlane}:
 *
 *   - **While the handshake is running** (`inCommandPlane` true, from
 *     {@link connect} until `RelayCommandPlane` resolves): every raw
 *     line goes to {@link commandPlaneListeners} only — `RelayCommandPlane`
 *     itself is the (single, at any moment) subscriber, inspecting
 *     `!CG`/`!GO` replies. Nothing is decoded via `v6/codec.ts` at this
 *     point; relay preamble replies (e.g. `# channel: ...`) are not v6
 *     protocol lines at all (see `RelayCommandPlane.ts`'s own doc
 *     comment).
 *   - **Once the handshake succeeds** (`inCommandPlane` set `false`):
 *     every raw line goes through {@link handleLine}, identical to
 *     `UsbSerialLink#handleLine` — banner-wait during {@link identify},
 *     `LineRouter` otherwise.
 *
 * A handshake failure (a `!CG` rejection, a `!CG` or `!GO` timeout)
 * rejects {@link connect} with a diagnosable message and closes the
 * port — there is no partial "connected but handshake-pending" state a
 * caller could observe or act on (this ticket's own acceptance
 * criteria). Retrying means calling {@link connect} again from scratch
 * on a new `RelayRadioLink` instance, exactly like `UsbSerialLink`'s own
 * single-shot `connect()` contract.
 *
 * ## No `retarget()` -- see `link/Link.ts`
 *
 * This class has no method to point an already-open relay at a
 * different robot's `(channel, group)`. `link/Link.ts`'s own doc comment
 * ("No `retarget()`") explains why: the relay's data plane has no
 * in-band escape once `!GO` confirms (`specification.md` §6). Switching
 * targets is close-session -> new {@link RelayLinkSpec} (a new
 * `(channel, group)`) -> open-session on a fresh `RelayRadioLink` — never
 * an in-place change to this one.
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
import type { Link, LineListener, RawLineListener, AckNackListener, LinkErrorListener } from "./Link.js";
import { LineReassembler } from "./lineStream.js";
import { WritePacer, realScheduler, type Scheduler } from "./pacing.js";
import { LineRouter } from "./LineRouter.js";
import { runRelayCommandPlane, RelayHandshakeError } from "./RelayCommandPlane.js";
import type { SerialPortLike } from "./UsbSerialLink.js";

/** DAPLink CDC serial ports always run at this fixed baud rate -- the
 * relay's own port is no different from a robot's (`UsbSerialLink.ts`'s
 * own `BAUD_RATE`). */
const BAUD_RATE = 115200;

/** Default gap between paced writes, in ms -- see
 * `UsbSerialLink.ts`'s own `DEFAULT_WRITE_PACE_MS` doc comment; the same
 * overrun risk applies to every write this module makes, handshake
 * lines included. */
const DEFAULT_WRITE_PACE_MS = 10;

/** Default time to wait for the `!CG`/`!GO` confirmation replies during
 * {@link RelayRadioLink.connect}'s handshake -- see
 * `RelayCommandPlane.ts`'s own `DEFAULT_HANDSHAKE_TIMEOUT_MS`, mirrored
 * here as this class's own default so a caller need not import that
 * module's internals to know what "not overridden" means. */
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 3000;

/** Default time to wait for a `HELLO` reply (the banner line) during
 * {@link RelayRadioLink.identify} before giving up (resolving `null`) --
 * identical in spirit to `UsbSerialLink.ts`'s own
 * `DEFAULT_OPEN_TIMEOUT_MS`. */
const DEFAULT_OPEN_TIMEOUT_MS = 3000;

function defaultCreatePort(path: string, options: { baudRate: number }): SerialPortLike {
  return new SerialPort({ path, baudRate: options.baudRate }) as unknown as SerialPortLike;
}

export interface RelayRadioLinkOptions {
  /** ms between paced writes; default {@link DEFAULT_WRITE_PACE_MS}. */
  writePaceMs?: number;
  /** ms to wait for the `HELLO` banner reply during {@link
   * RelayRadioLink.identify} before resolving `null`; default {@link
   * DEFAULT_OPEN_TIMEOUT_MS}. */
  openTimeoutMs?: number;
  /** ms to wait for the `!CG` confirmation reply, and separately the
   * `!GO` confirmation reply, during {@link RelayRadioLink.connect}'s
   * handshake; default {@link DEFAULT_HANDSHAKE_TIMEOUT_MS}. Passed
   * straight through to `RelayCommandPlane.ts`'s `timeoutMs`. */
  handshakeTimeoutMs?: number;
  /** Injectable port factory. Defaults to real `serialport`; tests
   * substitute a fake implementing `SerialPortLike` (same fake
   * `UsbSerialLink.test.ts` uses). */
  createPort?: (path: string, options: { baudRate: number }) => SerialPortLike;
  /** Injectable write-pacing scheduler, exactly as `UsbSerialLinkOptions.scheduler`.
   * Defaults to real timers ({@link realScheduler}). */
  scheduler?: Scheduler;
  /** Injectable delay primitive for the handshake's `!CG`/`!GO`
   * confirmation-wait timeouts specifically. Defaults to {@link
   * scheduler} (or {@link realScheduler} if that is also unset) --
   * override this separately from {@link scheduler} when a test needs
   * deterministic control over the handshake timeout without also
   * controlling every paced-write delay (see `RelayCommandPlane.test.ts`
   * for the pattern this exists for). */
  handshakeScheduler?: Scheduler;
  /** Injectable platform, passed straight through to {@link toCalloutPath}
   * during {@link connect}. Defaults to `process.platform`; tests
   * substitute `"darwin"`/`"linux"` explicitly -- same rationale as
   * `UsbSerialLinkOptions.platform` (ticket 014-001). */
  platform?: NodeJS.Platform;
}

type LinkState = "idle" | "connecting" | "connected" | "closed";

/**
 * The local USB relay transport -- see the module doc comment. Owns the
 * `serialport` I/O and the connect-then-handshake-then-identify
 * sequence; composes `link/lineStream.ts`, `link/pacing.ts`, and
 * `link/LineRouter.ts` for the transport-agnostic pieces, and
 * `link/RelayCommandPlane.ts` for the relay-specific command-plane
 * handshake, rather than reimplementing any of them.
 */
export class RelayRadioLink implements Link {
  private readonly portPath: string;
  private readonly channel: number;
  private readonly group: number;
  private readonly createPort: (
    path: string,
    options: { baudRate: number },
  ) => SerialPortLike;
  private readonly pacer: WritePacer;
  private readonly openTimeoutMs: number;
  private readonly handshakeTimeoutMs: number;
  private readonly handshakeScheduler: Scheduler;
  private readonly platform: NodeJS.Platform;
  private readonly lineReassembler = new LineReassembler();
  private readonly protocolSession = new Session();
  private readonly lineRouter: LineRouter;

  private readonly lineListeners = new Set<LineListener>();
  private readonly rawLineListeners = new Set<RawLineListener>();
  private readonly ackNackListeners = new Set<AckNackListener>();
  private readonly errorListeners = new Set<LinkErrorListener>();
  private readonly commandPlaneListeners = new Set<(line: string) => void>();

  private port: SerialPortLike | undefined;
  private state: LinkState = "idle";
  /** True from the moment the port opens until `RelayCommandPlane`
   * resolves -- see the module doc comment's "The one thing that's
   * different" section for what this flag switches. */
  private inCommandPlane = true;
  private parsedBanner: ParsedBanner | undefined;
  /** Set only while {@link identify} is actively waiting for a `HELLO`
   * banner reply -- identical role to `UsbSerialLink`'s own field of the
   * same name. */
  private resolveBannerWait: ((banner: ParsedBanner | null) => void) | undefined;

  constructor(portPath: string, channel: number, group: number, options: RelayRadioLinkOptions = {}) {
    this.portPath = portPath;
    this.channel = channel;
    this.group = group;
    this.createPort = options.createPort ?? defaultCreatePort;
    this.openTimeoutMs = options.openTimeoutMs ?? DEFAULT_OPEN_TIMEOUT_MS;
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
    this.handshakeScheduler = options.handshakeScheduler ?? options.scheduler ?? realScheduler;
    this.platform = options.platform ?? process.platform;
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

  /** True once {@link connect} (port open + handshake) has succeeded. */
  get isOpen(): boolean {
    return this.state === "connected";
  }

  /** The underlying `v6/session.ts` `Session` -- see `UsbSerialLink`'s
   * own getter of the same name for why callers should prefer {@link
   * sendCommand}/{@link sendUnsequenced}/{@link checkLiveness} over
   * writing through this directly. */
  get session(): Session {
    return this.protocolSession;
  }

  // ---- lifecycle --------------------------------------------------------

  /**
   * Open the local serial port (mirrors `UsbSerialLink.connect()`
   * exactly, including {@link toCalloutPath}), then run
   * `RelayCommandPlane`'s handshake over it. Rejects on either a
   * transport-level failure (the port refusing to open) or a handshake
   * failure (`!CG` rejected/timed out, `!GO` timed out) -- in both
   * cases the port, if it was opened, is closed and the link never
   * reaches `"connected"`; there is no partial "open but not
   * handshaken" state a caller can observe (this ticket's acceptance
   * criteria).
   */
  async connect(): Promise<void> {
    if (this.state !== "idle") {
      throw new Error(
        `RelayRadioLink.connect() called while state is "${this.state}" -- a link may only be connected once`,
      );
    }
    this.state = "connecting";

    const calloutPath = toCalloutPath(this.portPath, this.platform);
    const port = this.createPort(calloutPath, { baudRate: BAUD_RATE });
    this.port = port;
    this.attachPortListeners(port);

    try {
      await this.waitForPortOpen(port);
    } catch (error) {
      this.state = "closed";
      throw error;
    }

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
      await this.closePortSilently(port);
      this.state = "closed";
      const reason = error instanceof RelayHandshakeError ? error.message : String(error);
      throw new Error(`RelayRadioLink.connect() failed: relay command-plane handshake failed -- ${reason}`);
    }

    this.inCommandPlane = false;
    this.state = "connected";
  }

  /**
   * Send `HELLO` and wait for the banner reply -- identical contract to
   * `UsbSerialLink.identify()` (see that module's doc comment). Only
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

  /** Close the port. Idempotent. */
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
        `RelayRadioLink.${callerName}() called while not connected (state: "${this.state}") -- call connect() first`,
      );
    }
  }

  private paceWrite(lineText: string): void {
    this.pacer.schedule(() => {
      this.port?.write(lineText);
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
   * the module doc comment. */
  private subscribeCommandPlaneLine(listener: (line: string) => void): () => void {
    this.commandPlaneListeners.add(listener);
    return () => {
      this.commandPlaneListeners.delete(listener);
    };
  }

  private attachPortListeners(port: SerialPortLike): void {
    port.on("data", (chunk) => {
      for (const raw of this.lineReassembler.push(chunk)) {
        this.handleRawLine(raw);
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
   * whichever phase this link is currently in -- see the module doc
   * comment's "The one thing that's different" section. */
  private handleRawLine(raw: string): void {
    if (this.inCommandPlane) {
      for (const listener of this.commandPlaneListeners) {
        listener(raw);
      }
      // OOP 2026-09-09: the handshake's replies are visible too (see
      // Link.onRawLine) -- a handshake that goes wrong must be
      // diagnosable from the console, not only from an error string.
      this.dispatchRawLine(raw);
      return;
    }
    this.handleLine(raw);
  }

  /** Identical to `UsbSerialLink#handleLine` -- banner-wait during
   * {@link identify}, `LineRouter` otherwise. Only ever reached once
   * {@link inCommandPlane} is `false`, i.e. once the handshake has
   * already succeeded. */
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
  private closePortSilently(port: SerialPortLike): Promise<void> {
    return new Promise((resolve) => {
      port.close(() => resolve());
    });
  }
}
