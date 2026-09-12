/**
 * LineLink.ts — the transport-agnostic core replacing the shared
 * ~85-90% of `UsbSerialLink`/`RelayRadioLink`/`MbrelayLink`/
 * `MbserialLink` (issue `rearch-04-linelink-core-replaces-four-link-
 * classes.md`; `docs/reviews/2026-09-11/02-host-transport.md` §2's
 * measured duplication table). Per `sprint.md`'s Design Rationale
 * ("`LineLink` ships as a new, parallel module"): this ticket (014-005)
 * builds ONLY this core, verified entirely against a fake {@link
 * ByteStream} ({@link "./__fixtures__/FakeByteStream.js"}) — it does
 * not touch, wrap, or replace the four old classes, which keep running
 * completely unchanged until sprint 015's connector switches over and
 * deletes them. Real adapters (`serialStream`, `tcpStream`, the relay
 * preamble) are ticket 014-006's job, composing the {@link ByteStream}
 * seam this module defines rather than this module reaching into any
 * real transport itself.
 *
 * ## What this core fixes, relative to the four old classes
 *
 * (See `02-host-transport.md` §5/§6 for the full inventory; each item
 * below is a numbered failure mode there.)
 *
 * - **`onClose` exists.** The old classes flip `state = "closed"` on a
 *   port/socket `close` event and tell no one (§5.1) — the single
 *   largest source of the error storms the review investigated. Every
 *   {@link LineLink} transition to `"closed"` — requested or
 *   unsolicited — fires {@link LineLink.onClose} exactly once.
 * - **`identify()` truly never rejects** (§5.2/§1's "contract
 *   violation" table): a closed/not-yet-connected link resolves `null`
 *   immediately rather than throwing out of `assertConnected()`.
 * - **Lines are not lost during `identify()`'s banner wait** (§5.9): the
 *   old classes silently discard every non-banner line while waiting
 *   for `HELLO`'s reply, losing in-flight acks/nacks. This core still
 *   runs every line through {@link "@robot-console/protocol"}'s
 *   `receive()` while a banner wait is pending; only a line that
 *   actually parses as a banner is diverted to resolve the wait instead
 *   of being dispatched.
 * - **`connect()` is bounded** (§5.6/§1: "no connect timeout... hangs
 *   indefinitely") via `{ timeoutMs, signal }`, combined with any
 *   caller-supplied `AbortSignal` into one signal passed to {@link
 *   ByteStream.open} — every adapter gets this for free rather than
 *   each reimplementing its own timer.
 * - **Write failures are no longer invisible** (§5.8/§6): {@link
 *   ByteStream.write}'s callback failure is reported through {@link
 *   LineLink.onError} via `pacing.ts`'s now error-reporting
 *   `WritePacer.schedule`, instead of being swallowed.
 * - **Uses `receive()` instead of re-deriving decode → classify →
 *   ack/nack → resend ordering** (this ticket's own acceptance
 *   criteria; `sprint.md` Step 3's linelink → protocol boundary): this
 *   core has no hand-rolled equivalent of `LineRouter.ts`'s dance —
 *   `LineRouter` still exists for the four old classes it was written
 *   for, but this module calls the protocol package's own `receive()`
 *   facade (ticket 014-004) directly.
 */
import {
  parseBanner,
  stripReceivePrefix,
  receive,
  Session,
  type AckNackEvent,
  type DecodedLine,
  type ParsedBanner,
  type WireField,
} from "@robot-console/protocol";
import { LineReassembler, type LineReassemblerOptions } from "./lineStream.js";
import { WritePacer, realScheduler, type Scheduler } from "./pacing.js";

// ---------------------------------------------------------------------
// ByteStream — the adapter seam ticket 014-006 implements
// ---------------------------------------------------------------------

/**
 * The narrow surface every real transport adapter (serial, TCP, a relay
 * preamble wrapping either) implements, and the only thing {@link
 * LineLink} depends on for actual I/O. Kept intentionally small — no
 * `SerialPort`/`net.Socket`-specific members — so a test can supply a
 * fully synthetic fake (`./__fixtures__/FakeByteStream.js`) with no real
 * I/O at all, exactly the seam `UsbSerialLink.ts`'s own `SerialPortLike`
 * establishes for one transport, generalized here for every transport.
 */
export interface ByteStream {
  /** Establish the transport (open the port / connect the socket).
   * Bounded by `signal` — an adapter must reject (or otherwise stop
   * trying) once `signal` aborts, whether that abort came from {@link
   * LineLink.connect}'s own `timeoutMs` or a caller-supplied
   * `AbortSignal`. Never sends any protocol bytes itself. */
  open(signal: AbortSignal): Promise<void>;
  /** Write raw text. `callback` is invoked once with `undefined`/`null`
   * on success or an `Error` on failure — never swallowed by this
   * interface itself; {@link LineLink} reports a failure through {@link
   * LineLink.onError} rather than dropping it (see the module doc
   * comment). */
  write(bytes: string, callback: (err?: Error | null) => void): void;
  on(event: "data", listener: (chunk: Buffer | string) => void): void;
  on(event: "error", listener: (err: Error) => void): void;
  on(event: "close", listener: () => void): void;
  /** Close the transport. `LineLink.close()` itself is idempotent and
   * guards against calling this more than once; an adapter is free to
   * treat a repeat call as a no-op regardless. */
  close(): Promise<void>;
}

// ---------------------------------------------------------------------
// Listener types — mirror link/Link.ts's shape, plus onClose
// ---------------------------------------------------------------------

export type LineListener = (line: DecodedLine) => void;
export type RawLineListener = (raw: string) => void;
export type AckNackListener = (event: AckNackEvent) => void;
export type LinkErrorListener = (err: Error) => void;
/** Fired exactly once per connected lifetime, whenever the underlying
 * {@link ByteStream} closes — requested via {@link LineLink.close} or
 * unsolicited (a peer disconnect, a port yanked out). `reason` is the
 * most recent error {@link ByteStream}'s `"error"` event reported before
 * the close, if any; `undefined` for a clean close. This is the fix for
 * `02-host-transport.md` §5.1 — see the module doc comment. */
export type LinkCloseListener = (reason?: Error) => void;

/** Options to {@link LineLink}'s constructor. */
export interface LineLinkOptions {
  /** ms between paced writes; default {@link DEFAULT_WRITE_PACE_MS}. */
  writePaceMs?: number;
  /** ms to wait for the `HELLO` banner reply during {@link
   * LineLink.identify} before resolving `null`; default {@link
   * DEFAULT_IDENTIFY_TIMEOUT_MS}. */
  identifyTimeoutMs?: number;
  /** Default `timeoutMs` for {@link LineLink.connect} when its own
   * options don't specify one; default {@link
   * DEFAULT_CONNECT_TIMEOUT_MS}. */
  connectTimeoutMs?: number;
  /** Injectable write-pacing scheduler; defaults to real timers. Tests
   * substitute a fake to assert pacing without real wall-clock delays. */
  scheduler?: Scheduler;
  /** Forwarded to the internal {@link LineReassembler}'s max-buffer
   * guard — see that class's own doc comment. */
  maxBufferChars?: LineReassemblerOptions["maxBufferChars"];
  /** Forwarded to `@robot-console/protocol`'s `receive()` — called with
   * the raw text of any line classified `"foreign"`. Optional. */
  onForeign?: (raw: string) => void;
  /**
   * Runs once {@link ByteStream.open} has resolved, before {@link
   * LineLink.connect} returns (and therefore strictly before any
   * caller can reach {@link LineLink.identify}) — the relay command-
   * plane handshake's hook (`RelayCommandPlane`, ticket 014-006). Bound
   * by the same combined signal {@link LineLink.connect} passed to
   * `open()`. A rejection here fails `connect()` itself, exactly like
   * `open()` failing — see the module doc comment.
   */
  preamble?: (stream: ByteStream, signal: AbortSignal) => Promise<void>;
}

/** Options to {@link LineLink.connect}. */
export interface ConnectOptions {
  /** Bounds the entire `open()` (+ optional `preamble`) sequence;
   * default {@link LineLinkOptions.connectTimeoutMs}. */
  timeoutMs?: number;
  /** An additional, caller-supplied abort source — combined with the
   * internal timeout into one signal `open()`/`preamble` both see. */
  signal?: AbortSignal;
}

const DEFAULT_WRITE_PACE_MS = 10;
const DEFAULT_IDENTIFY_TIMEOUT_MS = 3000;
const DEFAULT_CONNECT_TIMEOUT_MS = 5000;

type LineLinkState = "idle" | "connecting" | "connected" | "closing" | "closed";

/**
 * The transport-agnostic LineLink core. See the module doc comment for
 * the full rationale; see `ByteStream` above for the one thing it
 * depends on for actual I/O.
 */
export class LineLink {
  private readonly pacer: WritePacer;
  private readonly reassembler: LineReassembler;
  private readonly protocolSession = new Session();

  private readonly identifyTimeoutMs: number;
  private readonly connectTimeoutMs: number;
  private readonly onForeign: ((raw: string) => void) | undefined;
  private readonly preamble: ((stream: ByteStream, signal: AbortSignal) => Promise<void>) | undefined;

  private readonly lineListeners = new Set<LineListener>();
  private readonly rawLineListeners = new Set<RawLineListener>();
  private readonly ackNackListeners = new Set<AckNackListener>();
  private readonly errorListeners = new Set<LinkErrorListener>();
  private readonly closeListeners = new Set<LinkCloseListener>();

  private state: LineLinkState = "idle";
  private parsedBanner: ParsedBanner | undefined;
  private lastError: Error | undefined;
  private closeNotified = false;

  /** Set only while {@link identify} is actively waiting for a `HELLO`
   * banner reply — see {@link handleRawLine}'s own doc comment. */
  private resolveBannerWait: ((banner: ParsedBanner | null) => void) | undefined;
  /** The in-flight {@link identify} promise, if any — re-entrant calls
   * share this one wait rather than re-sending `HELLO` (this ticket's
   * own acceptance criterion). */
  private pendingIdentify: Promise<ParsedBanner | null> | undefined;

  constructor(
    private readonly stream: ByteStream,
    options: LineLinkOptions = {},
  ) {
    this.pacer = new WritePacer(options.writePaceMs ?? DEFAULT_WRITE_PACE_MS, options.scheduler ?? realScheduler);
    this.reassembler = new LineReassembler({
      // exactOptionalPropertyTypes: only include `maxBufferChars` when
      // actually given -- explicitly setting it to `undefined` is a
      // different (and rejected) thing from omitting it entirely.
      ...(options.maxBufferChars !== undefined ? { maxBufferChars: options.maxBufferChars } : {}),
      onOverflow: (discarded) => {
        this.dispatchError(
          new Error(`LineLink: discarded ${discarded.length}-char partial line -- max buffer exceeded with no newline`),
        );
      },
    });
    this.identifyTimeoutMs = options.identifyTimeoutMs ?? DEFAULT_IDENTIFY_TIMEOUT_MS;
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.onForeign = options.onForeign;
    this.preamble = options.preamble;
  }

  // ---- identity, populated once identify() resolves a banner ---------

  get banner(): ParsedBanner | undefined {
    return this.parsedBanner;
  }

  get role(): string | undefined {
    return this.parsedBanner?.role;
  }

  get name(): string | undefined {
    return this.parsedBanner?.name;
  }

  get serial(): number | undefined {
    return this.parsedBanner?.serial;
  }

  /** True once {@link connect} has succeeded and the link has not since
   * closed. */
  get isOpen(): boolean {
    return this.state === "connected";
  }

  /** The underlying `@robot-console/protocol` `Session` — sequencing
   * state (`seq`/`pendingCount`/...), mirroring `link/Link.ts`'s own
   * `session` accessor. */
  get session(): Session {
    return this.protocolSession;
  }

  // ---- lifecycle --------------------------------------------------------

  /**
   * Open the transport (via {@link ByteStream.open}) and, if given, run
   * the {@link LineLinkOptions.preamble} hook — bounded overall by
   * `options.timeoutMs` (default {@link DEFAULT_CONNECT_TIMEOUT_MS})
   * combined with `options.signal`. Never sends `HELLO`, never waits for
   * a banner (see {@link identify}). Rejects only on a transport-level
   * failure or the bound expiring; a link may only be connected once —
   * a second call while not `"idle"` rejects immediately.
   */
  async connect(options: ConnectOptions = {}): Promise<void> {
    if (this.state !== "idle") {
      throw new Error(`LineLink.connect() called while state is "${this.state}" -- a link may only be connected once`);
    }
    this.state = "connecting";
    this.attachStreamListeners();

    const controller = new AbortController();
    const cleanups: Array<() => void> = [];

    const externalSignal = options.signal;
    if (externalSignal) {
      if (externalSignal.aborted) {
        controller.abort(externalSignal.reason);
      } else {
        const onAbort = () => controller.abort(externalSignal.reason);
        externalSignal.addEventListener("abort", onAbort, { once: true });
        cleanups.push(() => externalSignal.removeEventListener("abort", onAbort));
      }
    }

    const timeoutMs = options.timeoutMs ?? this.connectTimeoutMs;
    const timer = setTimeout(() => {
      controller.abort(new Error(`LineLink.connect() timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    cleanups.push(() => clearTimeout(timer));

    try {
      await this.stream.open(controller.signal);
      if (this.preamble) {
        await this.preamble(this.stream, controller.signal);
      }
    } catch (error) {
      this.state = "closed";
      // Best-effort cleanup of a half-open transport -- a close failure
      // here must never mask the original connect failure.
      void this.stream.close().catch(() => {});
      throw error;
    } finally {
      for (const cleanup of cleanups) {
        cleanup();
      }
    }

    this.state = "connected";
  }

  /**
   * Send `HELLO` and wait for the banner reply. Resolves the parsed
   * banner, or `null` if no banner-shaped reply arrives within
   * `identifyTimeoutMs`, or immediately if the link is not currently
   * `"connected"` — **never rejects**. A call made while a previous
   * call's wait is still pending shares that same wait rather than
   * re-sending `HELLO`.
   */
  async identify(): Promise<ParsedBanner | null> {
    if (this.state !== "connected") {
      return null;
    }
    if (this.pendingIdentify) {
      return this.pendingIdentify;
    }

    const wait = new Promise<ParsedBanner | null>((resolve) => {
      const timer = setTimeout(() => {
        this.resolveBannerWait = undefined;
        resolve(null);
      }, this.identifyTimeoutMs);
      this.resolveBannerWait = (banner) => {
        clearTimeout(timer);
        this.resolveBannerWait = undefined;
        resolve(banner);
      };
    });
    this.pendingIdentify = wait.finally(() => {
      this.pendingIdentify = undefined;
    });

    // The one and only place this module ever sends HELLO -- via
    // Session.connect(), never a hand-formatted line -- see
    // link/UsbSerialLink.ts's own module doc comment for why (it
    // resets the robot's sequence state, so the session's local
    // counter must reset in lockstep).
    const helloLine = this.protocolSession.connect();
    this.paceWrite(helloLine);

    const banner = await this.pendingIdentify;
    if (banner) {
      this.parsedBanner = banner;
    }
    return banner;
  }

  /** Close the transport. Idempotent — calling it again (or before
   * {@link connect} ever succeeded) is a no-op. Never rejects on its own
   * account; {@link onClose} fires once the underlying {@link
   * ByteStream} actually closes. */
  async close(): Promise<void> {
    if (this.state === "closed" || this.state === "closing") {
      return;
    }
    if (this.state === "idle") {
      this.state = "closed";
      return;
    }
    this.state = "closing";
    await this.stream.close();
  }

  // ---- sending ------------------------------------------------------

  /** Send an already-formatted line verbatim (a trailing `\n` is added
   * if not already present). Paced like every other write. */
  sendLine(line: string): void {
    this.assertConnected("sendLine");
    this.paceWrite(line.endsWith("\n") ? line : `${line}\n`);
  }

  /** Send one of the 11 id-bearing verbs, sequenced via `Session.send()`.
   * Paced like every other write. Returns the exact line text sent. */
  sendCommand(verb: string, fields: readonly WireField[] = []): string {
    this.assertConnected("sendCommand");
    const line = this.protocolSession.send(verb, fields);
    this.paceWrite(line);
    return line;
  }

  /** Send an unsequenced verb via `Session.sendUnsequenced()`. Paced
   * like every other write. */
  sendUnsequenced(verb: string, fields: readonly WireField[] = []): string {
    this.assertConnected("sendUnsequenced");
    const line = this.protocolSession.sendUnsequenced(verb, fields);
    this.paceWrite(line);
    return line;
  }

  /** Send `PING` — the liveness probe to use instead of re-sending
   * `HELLO` once a session is live. */
  checkLiveness(): void {
    this.assertConnected("checkLiveness");
    this.paceWrite(this.protocolSession.checkLiveness());
  }

  private assertConnected(callerName: string): void {
    if (this.state !== "connected") {
      throw new Error(`LineLink.${callerName}() called while not connected (state: "${this.state}") -- call connect() first`);
    }
  }

  /** Schedule a paced write; a failure reported through {@link
   * ByteStream.write}'s callback surfaces via {@link onError} rather
   * than being swallowed (`pacing.ts`'s `WritePacer.schedule` now
   * accepts an async write plus an `onError` callback for exactly this
   * -- see the module doc comment). */
  private paceWrite(lineText: string): void {
    this.pacer.schedule(
      () =>
        new Promise<void>((resolve, reject) => {
          this.stream.write(lineText, (err) => {
            if (err) {
              reject(err);
            } else {
              resolve();
            }
          });
        }),
      (err) => this.dispatchError(err),
    );
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

  /** Subscribe to the link's own close — see {@link LinkCloseListener}'s
   * doc comment. Returns an unsubscribe function. */
  onClose(listener: LinkCloseListener): () => void {
    this.closeListeners.add(listener);
    return () => {
      this.closeListeners.delete(listener);
    };
  }

  private attachStreamListeners(): void {
    this.stream.on("data", (chunk) => {
      for (const raw of this.reassembler.push(chunk)) {
        this.handleRawLine(raw);
      }
    });
    this.stream.on("error", (err) => {
      this.lastError = err;
      this.dispatchError(err);
    });
    this.stream.on("close", () => {
      this.handleStreamClose();
    });
  }

  /**
   * Handle one already-reassembled, already-normalized inbound line.
   *
   * While {@link identify} is actively waiting for a banner reply
   * ({@link resolveBannerWait} is set): the line is first tried against
   * {@link parseBanner} (after {@link stripReceivePrefix}, whose grammar
   * does not tolerate the "< " receive-prefix). A match resolves the
   * wait and is consumed here — it is not also dispatched to a listener,
   * mirroring the old classes' behavior for the banner line itself. Any
   * OTHER line — critically, unlike the four old classes
   * (`02-host-transport.md` §5.9) — is still run through {@link receive}
   * and dispatched normally instead of being silently discarded; this is
   * the fix for lines (most importantly in-flight acks/nacks) being lost
   * during the banner wait.
   *
   * Once there is no banner wait pending (identify never called yet,
   * already resolved, or timed out), every line runs through {@link
   * receive} unconditionally.
   */
  private handleRawLine(raw: string): void {
    if (this.resolveBannerWait) {
      const banner = parseBanner(stripReceivePrefix(raw));
      if (banner) {
        this.resolveBannerWait(banner);
        return;
      }
    }

    // exactOptionalPropertyTypes: only include `onForeign` when actually
    // configured -- see the constructor's own reassembler options for
    // the identical reasoning.
    const result = receive(this.protocolSession, raw, this.onForeign ? { onForeign: this.onForeign } : {});

    // The resend MUST go out before anything else -- receive()'s own
    // contract (protocol.md S8.1: a resend reordered behind other
    // traffic breaks "resend from next forward, in order").
    for (const resendLine of result.resend) {
      this.paceWrite(resendLine);
    }

    if (result.ackNack) {
      if (result.ackNack.kind === "malformed") {
        // Still reach the console, exactly like any other non-
        // actionable reply-direction oddity (mirrors LineRouter.ts's
        // own handling of this case).
        this.dispatchRawLine(raw);
      } else {
        this.dispatchAckNack(result.ackNack);
      }
    }

    if (result.line) {
      this.dispatchLine(result.line);
    }
    if (result.unrouted !== undefined) {
      this.dispatchRawLine(result.unrouted);
    }
    // result.dropped ("blank" | "tooLong") -- nothing to do.
  }

  /** Guarded to fire {@link onClose} exactly once per connected
   * lifetime, whether reached via {@link close}'s own `stream.close()`
   * call or an unsolicited `"close"` event. If {@link identify} is
   * actively waiting, the wait resolves `null` immediately instead of
   * hanging until its timeout. */
  private handleStreamClose(): void {
    if (this.closeNotified) {
      return;
    }
    this.closeNotified = true;
    this.state = "closed";
    this.resolveBannerWait?.(null);

    const reason = this.lastError;
    for (const listener of this.closeListeners) {
      listener(reason);
    }
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
