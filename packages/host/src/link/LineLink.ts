/**
 * LineLink.ts — the transport-agnostic core replacing the shared ~85-90%
 * of the old `UsbSerialLink`/`RelayRadioLink`/`MbrelayLink`/
 * `MbserialLink` classes (`docs/reviews/2026-09-11/02-host-transport.md`
 * §2's measured duplication table). Depends only on {@link ByteStream} —
 * real adapters (`serialStream`, `tcpStream`, the relay preamble) compose
 * that seam rather than this module touching any real transport itself.
 *
 * What this core fixes, relative to the four old classes (full inventory
 * in `02-host-transport.md` §5/§6): `onClose` fires exactly once per
 * connected lifetime, requested or unsolicited (§5.1, the review's
 * biggest error-storm source); `identify()` truly never rejects (§5.2);
 * non-banner lines are still routed through `receive()` during the
 * banner wait instead of discarded, so in-flight acks/nacks are never
 * lost (§5.9); `connect()` is bounded via `{ timeoutMs, signal }` (§5.6);
 * a write failure surfaces via {@link LineLink.onError} instead of being
 * swallowed (§5.8); and this module calls `@robot-console/protocol`'s
 * `receive()` facade directly instead of re-deriving decode → classify →
 * ack/nack → resend ordering by hand.
 *
 * ## Unsequenced query resend and poll/query serialization (018-009)
 *
 * A non-sequenced verb (`ID`, `STATUS`, `HELP`, `DEBUG`, `VER`, `ESTOP`,
 * ...; `isSequencedVerb` gates only the 11 id-bearing verbs onto
 * `sendCommand` instead) has no built-in retry of any kind, unlike a
 * sequenced verb (which the protocol's own ack/nack scheme already
 * resends on a nack) — one lost packet on a lossy hop is simply gone.
 *
 * Bench evidence (sprint 018 ticket 009, `torture` mbrelay pool, real
 * hardware): `vevov` bridged through `torture` passes Layer 1's full
 * data-plane handshake every time (HELLO/ID both eventually answered,
 * packets lost on either verb unpredictably) but repeatedly failed
 * Layer 2's `send-command ID` — "connected, but no line rx matching
 * `id ` within 5000ms" — even though the identical robot answers a raw,
 * uncontended `ID` reliably. The isolated reproduction
 * (`scripts/bench/repro/mbrelay-reliability.ts`) confirmed
 * `connect/harvester.ts`'s own 2s-cadence `STATUS` poll racing a
 * student's own `ID` send (`server.ts`'s `send-command` dispatch) on the
 * same physical radio hop is a material contributor: two near-
 * simultaneous unprefixed sends can be merged or dropped by the relay,
 * on top of the link's own baseline loss rate.
 *
 * Two changes, both on {@link sendUnsequencedQuery} — a distinct method
 * from the plain {@link sendUnsequenced}, deliberately: see
 * {@link sendUnsequenced}'s own doc comment for why the harvester's own
 * internal bookkeeping sends (its initial `ID` probe, its `STATUS` poll
 * itself) must never gate on themselves, only `server.ts`'s dispatch of
 * a genuinely foreign, student-originated query uses this method:
 *
 *   1. **One bounded resend.** After sending, this module waits up to
 *      {@link DEFAULT_UNSEQUENCED_QUERY_RESEND_MS} for an inbound line
 *      whose decoded verb is this send's own expected reply verb (see
 *      {@link expectedReplyVerbFor}); if none arrives, it resends the
 *      identical line exactly once and waits the same bound again, then
 *      gives up. Safe to resend blindly: every verb ever sent
 *      unsequenced is either a pure query (`ID`/`STATUS`/`HELP`/`DEBUG`/
 *      `VER`) or an idempotent state-set (`ESTOP` — sending it twice
 *      leaves the robot no more stopped than sending it once); nothing
 *      unsequenced carries ordering state the way a sequenced verb's own
 *      id does, which is exactly why it is unsequenced in the first
 *      place.
 *   2. **A pending-query gate.** {@link hasPendingUnsequencedQuery} is
 *      `true` for the whole window above (both the original wait and the
 *      one resend's own wait) — `connect/harvester.ts`'s own poll loop
 *      checks this before each tick and skips sending its own `STATUS`
 *      entirely while it is `true`, so a poll tick is never issued at the
 *      same moment a foreign query sent via `sendUnsequencedQuery` is
 *      still in flight on the same link. A skipped tick is not counted
 *      as a missed poll — it was never sent, so it cannot have been
 *      unanswered.
 *
 * Applied uniformly to every transport (not only radio/mbrelay) — the
 * same posture this module's missed-poll-ceiling generalization already
 * takes (`connect/harvester.ts`'s own doc comment): a resend/gate that
 * never fires on a reliable transport (the reply arrives almost
 * immediately, well inside the bound) costs nothing there, and there is
 * no reliable way to ask "is this specific hop lossy" up front anyway.
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

/** The narrow surface every real transport adapter (serial, TCP, a relay
 * preamble wrapping either) implements, and the only thing {@link
 * LineLink} depends on for actual I/O — small enough that a test can
 * supply a fully synthetic fake (`./__fixtures__/FakeByteStream.js`). */
export interface ByteStream {
  /** Establish the transport. Bounded by `signal` — an adapter must
   * reject once `signal` aborts. Never sends any protocol bytes. */
  open(signal: AbortSignal): Promise<void>;
  /** Write raw text; `callback` gets `undefined`/`null` on success or an
   * `Error` on failure — never swallowed here (see {@link LineLink.onError}). */
  write(bytes: string, callback: (err?: Error | null) => void): void;
  on(event: "data", listener: (chunk: Buffer | string) => void): void;
  on(event: "error", listener: (err: Error) => void): void;
  on(event: "close", listener: () => void): void;
  /** Close the transport. Idempotent from `LineLink.close()`'s side; an
   * adapter is free to treat a repeat call as a no-op regardless. */
  close(): Promise<void>;
}

// ---- listener types ---------------------------------------------------

export type LineListener = (line: DecodedLine) => void;
export type RawLineListener = (raw: string) => void;
export type AckNackListener = (event: AckNackEvent) => void;
export type LinkErrorListener = (err: Error) => void;
/** Fired exactly once per connected lifetime when the underlying {@link
 * ByteStream} closes — requested or unsolicited. `reason` is the most
 * recent `"error"` event before the close, if any; `undefined` if clean. */
export type LinkCloseListener = (reason?: Error) => void;

/** Options to {@link LineLink}'s constructor. */
export interface LineLinkOptions {
  /** ms between paced writes; default {@link DEFAULT_WRITE_PACE_MS}. */
  writePaceMs?: number;
  /** ms to wait for the `HELLO` banner reply during {@link
   * LineLink.identify} before resolving `null`; default {@link
   * DEFAULT_IDENTIFY_TIMEOUT_MS}. */
  identifyTimeoutMs?: number;
  /** Default `timeoutMs` for {@link LineLink.connect}; default {@link
   * DEFAULT_CONNECT_TIMEOUT_MS}. */
  connectTimeoutMs?: number;
  /** Injectable write-pacing scheduler; defaults to real timers. */
  scheduler?: Scheduler;
  /** Forwarded to {@link LineReassembler}'s max-buffer guard. */
  maxBufferChars?: LineReassemblerOptions["maxBufferChars"];
  /** Forwarded to `@robot-console/protocol`'s `receive()` — called with
   * the raw text of any line classified `"foreign"`. Optional. */
  onForeign?: (raw: string) => void;
  /** Runs once {@link ByteStream.open} resolves, before {@link
   * LineLink.connect} returns — the relay command-plane handshake's hook
   * (`RelayCommandPlane`). Bound by the same combined signal `open()`
   * sees. A rejection here fails `connect()`, exactly like `open()`
   * failing. */
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

/** Default bound {@link LineLink.sendUnsequenced} waits for its own
 * expected reply verb before resending once, and again after the resend
 * before giving up — see the module doc comment's "Unsequenced query
 * resend" section. Comfortably shorter than
 * `scripts/bench/layer2/pathChecks.ts`'s own 5000ms reply-timeout budget,
 * so a resend still has time to be answered within that outer window;
 * comfortably longer than the ~30-40ms reply latency this codebase's own
 * live-bench evidence measured for an uncontended radio reply. */
export const DEFAULT_UNSEQUENCED_QUERY_RESEND_MS = 1500;

/**
 * The lowercase reply verb {@link LineLink.sendUnsequenced} should wait
 * for after sending `verb` unsequenced — `undefined` for a verb this
 * module cannot pair a reply to at all, in which case no resend/pending-
 * tracking happens (identical to this method's behavior before 018-009).
 * Every verb actually sent unsequenced in production (`ID`, `STATUS`,
 * `HELP`, `DEBUG`, `VER`, `ESTOP` — anything a student's `send-command`
 * reaches that `isSequencedVerb` does not claim) mirrors its own
 * lowercase text as its reply verb (`@robot-console/protocol`'s
 * `REPLY_VERBS`); `PING` is the one documented exception (`checkLiveness()`'s
 * own `pong` reply), handled explicitly here even though production never
 * routes `PING` through `sendUnsequenced` (`checkLiveness()` is its own
 * dedicated method) — a student typing `send-command PING` by hand
 * (unusual, but not rejected by `isSequencedVerb`) still gets a correctly
 * paired wait instead of one that can never see its own reply. Exported
 * for direct unit coverage of this mapping, independent of the timing
 * machinery around it.
 */
export function expectedReplyVerbFor(verb: string): string {
  return verb.toUpperCase() === "PING" ? "pong" : verb.toLowerCase();
}

type LineLinkState = "idle" | "connecting" | "connected" | "closing" | "closed";

/** Tiny multi-listener Set wrapper — every `onX`/dispatch pair below
 * (line, raw line, ack/nack, error, close) shares this same add/remove/
 * fan-out shape, so it is factored out once rather than five times. */
class Emitter<T> {
  private readonly listeners = new Set<(arg: T) => void>();

  on(listener: (arg: T) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  dispatch(arg: T): void {
    for (const listener of this.listeners) {
      listener(arg);
    }
  }
}

/** The transport-agnostic LineLink core — see the module doc comment. */
export class LineLink {
  private readonly pacer: WritePacer;
  private readonly reassembler: LineReassembler;
  private readonly protocolSession = new Session();

  private readonly identifyTimeoutMs: number;
  private readonly connectTimeoutMs: number;
  private readonly onForeign: ((raw: string) => void) | undefined;
  private readonly preamble: ((stream: ByteStream, signal: AbortSignal) => Promise<void>) | undefined;
  private readonly scheduler: Scheduler;

  /** Count of {@link sendUnsequencedQuery} calls currently within their
   * own resend/wait window — see {@link hasPendingUnsequencedQuery} and
   * the module doc comment's "Unsequenced query resend" section. */
  private pendingUnsequencedQueries = 0;

  private readonly lineEmitter = new Emitter<DecodedLine>();
  /** Fan-out for outgoing verbs, both sequenced and unsequenced -- see
   * {@link onQuerySent}. */
  private readonly querySentEmitter = new Emitter<string>();
  private readonly rawLineEmitter = new Emitter<string>();
  private readonly inboundLineEmitter = new Emitter<string>();
  private readonly ackNackEmitter = new Emitter<AckNackEvent>();
  private readonly errorEmitter = new Emitter<Error>();
  private readonly closeEmitter = new Emitter<Error | undefined>();

  private state: LineLinkState = "idle";
  private parsedBanner: ParsedBanner | undefined;
  private lastError: Error | undefined;
  private closeNotified = false;

  /** Set only while {@link identify} is actively waiting for a `HELLO`
   * banner reply — see {@link handleRawLine}. */
  private resolveBannerWait: ((banner: ParsedBanner | null) => void) | undefined;
  /** The in-flight {@link identify} promise, if any — re-entrant calls
   * share this wait instead of re-sending `HELLO`. */
  private pendingIdentify: Promise<ParsedBanner | null> | undefined;

  constructor(
    private readonly stream: ByteStream,
    options: LineLinkOptions = {},
  ) {
    this.scheduler = options.scheduler ?? realScheduler;
    this.pacer = new WritePacer(options.writePaceMs ?? DEFAULT_WRITE_PACE_MS, this.scheduler);
    this.reassembler = new LineReassembler({
      // exactOptionalPropertyTypes: only include `maxBufferChars` when
      // actually given -- explicitly setting it to `undefined` is a
      // different (and rejected) thing from omitting it entirely.
      ...(options.maxBufferChars !== undefined ? { maxBufferChars: options.maxBufferChars } : {}),
      onOverflow: (discarded) => {
        this.errorEmitter.dispatch(
          new Error(`LineLink: discarded ${discarded.length}-char partial line -- max buffer exceeded with no newline`),
        );
      },
    });
    this.identifyTimeoutMs = options.identifyTimeoutMs ?? DEFAULT_IDENTIFY_TIMEOUT_MS;
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.onForeign = options.onForeign;
    this.preamble = options.preamble;
  }

  // ---- identity, populated once identify() resolves a banner ----
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

  /** True while at least one query verb sent via {@link sendUnsequencedQuery}
   * is still within its own resend/wait window (original send plus, if
   * unanswered, one resend) — see the module doc comment's "Unsequenced
   * query resend and poll/query serialization" section.
   * `connect/harvester.ts`'s own `STATUS` poll checks this before every
   * tick so it never sends its own query while a foreign one (e.g. a
   * student's `send-command ID`) is still outstanding on the same link. */
  get hasPendingUnsequencedQuery(): boolean {
    return this.pendingUnsequencedQueries > 0;
  }

  /** The underlying `@robot-console/protocol` `Session` — sequencing
   * state (`seq`/`pendingCount`/...). */
  get session(): Session {
    return this.protocolSession;
  }

  // ---- lifecycle ----

  /** Open the transport (via {@link ByteStream.open}) and, if given, run
   * the {@link LineLinkOptions.preamble} hook — bounded by
   * `options.timeoutMs` combined with `options.signal`. Never sends
   * `HELLO`, never waits for a banner (see {@link identify}). Rejects
   * only on a transport-level failure or the bound expiring; a link may
   * only be connected once — a second call while not `"idle"` rejects
   * immediately. */
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

  /** Send `HELLO` and wait for the banner reply. Resolves the parsed
   * banner, or `null` if none arrives within `identifyTimeoutMs`, or
   * immediately if not `"connected"` — **never rejects**. A call made
   * while a previous call's wait is still pending shares that wait
   * rather than re-sending `HELLO`. */
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

    // The only place this module sends HELLO -- via Session.connect(),
    // which resets the robot's sequence state in lockstep with the
    // session's own local counter.
    const helloLine = this.protocolSession.connect();
    this.paceWrite(helloLine);

    const banner = await this.pendingIdentify;
    if (banner) {
      this.parsedBanner = banner;
    }
    return banner;
  }

  /** Close the transport. Idempotent — calling it again, or before
   * {@link connect} ever succeeded, is a no-op. Never rejects; {@link
   * onClose} fires once the underlying {@link ByteStream} closes.
   *
   * `reason`, when given, is what {@link onClose} reports -- unless a
   * stream error already recorded one. Without it a deliberate close
   * (e.g. the harvester giving up on a silent robot) reached the
   * reconciler as a bare "transport closed". */
  async close(reason?: Error): Promise<void> {
    if (this.state === "closed" || this.state === "closing") {
      return;
    }
    if (reason !== undefined && this.lastError === undefined) {
      this.lastError = reason;
    }
    if (this.state === "idle") {
      this.state = "closed";
      return;
    }
    this.state = "closing";
    await this.stream.close();
  }

  // ---- sending ----

  /** Send an already-formatted line verbatim (a trailing `\n` is added
   * if missing). Paced like every other write. */
  sendLine(line: string): void {
    this.assertConnected("sendLine");
    this.paceWrite(line.endsWith("\n") ? line : `${line}\n`);
  }

  /** Send one of the 11 id-bearing verbs, sequenced via `Session.send()`.
   * Paced; returns the exact line text sent. */
  sendCommand(verb: string, fields: readonly WireField[] = []): string {
    this.assertConnected("sendCommand");
    const line = this.protocolSession.send(verb, fields);
    this.paceWrite(line);
    // See {@link onQuerySent}. `FUNCS` is one of the id-bearing verbs, so
    // it arrives here rather than at `sendUnsequencedQuery` -- a fix that
    // hooked only the unsequenced path would never fire for the one verb
    // that needs it. (Caught by this change's own regression test, which
    // failed with "FUNCS is one of the 11 id-bearing verbs".)
    this.querySentEmitter.dispatch(verb);
    return line;
  }

  /** Send an unsequenced verb via `Session.sendUnsequenced()`. Paced.
   * Plain and unchanged by 018-009 — no resend, no
   * {@link hasPendingUnsequencedQuery} participation. `connect/harvester.ts`'s
   * own internal bookkeeping sends (its initial `ID` probe, its `STATUS`
   * poll) deliberately keep using this method: they must never gate
   * *themselves* out (a harvester poll's own prior tick still pending
   * would otherwise starve every later tick indefinitely on a link that
   * never answers at all, defeating the missed-poll watchdog). See
   * {@link sendUnsequencedQuery} for the query-with-resend/gate variant
   * `server.ts`'s `send-command` dispatch uses for a student's own
   * unsequenced verb. */
  sendUnsequenced(verb: string, fields: readonly WireField[] = []): string {
    this.assertConnected("sendUnsequenced");
    const line = this.protocolSession.sendUnsequenced(verb, fields);
    this.paceWrite(line);
    return line;
  }

  /** Send an unsequenced verb exactly like {@link sendUnsequenced}, but
   * additionally arms this send's own bounded resend-once-if-unanswered
   * window (see the module doc comment's "Unsequenced query resend"
   * section) — {@link hasPendingUnsequencedQuery} is `true` for that
   * whole window, which `connect/harvester.ts`'s own `STATUS` poll checks
   * before every tick so it never sends its own query while THIS one is
   * still outstanding. For a genuinely foreign, student-originated query
   * — `server.ts`'s `send-command` dispatch for a non-sequenced verb —
   * never for the harvester's own internal bookkeeping sends (see
   * {@link sendUnsequenced}'s own doc comment for why those must stay
   * plain). The returned line text and synchronous contract (send now,
   * return the exact text sent) match {@link sendUnsequenced} exactly;
   * the resend/gate machinery runs entirely in the background. */
  sendUnsequencedQuery(verb: string, fields: readonly WireField[] = []): string {
    this.assertConnected("sendUnsequencedQuery");
    const line = this.protocolSession.sendUnsequenced(verb, fields);
    this.paceWrite(line);
    this.armUnsequencedResend(verb, line);
    // Dispatch *after* the write, so a listener only ever learns about a
    // query that actually went out. See {@link onQuerySent}.
    this.querySentEmitter.dispatch(verb);
    return line;
  }

  /**
   * Subscribe to every verb sent on this link, by either
   * {@link sendCommand} (sequenced) or {@link sendUnsequencedQuery}.
   * Returns an unsubscribe function.
   *
   * This exists for list-valued replies that have **no end-of-list
   * sentinel** -- `FUNCS` above all. The robot answers one `funcs` line
   * per registered verb and nothing marks the last one, so a consumer
   * cannot tell "the start of a second batch" from "more of the first"
   * by looking at replies alone. The only moment that is unambiguous is
   * the moment the request goes out, which is here.
   *
   * Hooking the *send* rather than the first reply is deliberate: it
   * also survives a partial first batch (lines emitted during a run are
   * best-effort and can be dropped), where resetting on first-reply
   * would silently keep stale entries from the previous request.
   */
  onQuerySent(listener: (verb: string) => void): () => void {
    return this.querySentEmitter.on(listener);
  }

  /** Background resend/pending-tracking for one {@link sendUnsequencedQuery}
   * call — see that method's own doc comment and the module doc
   * comment's "Unsequenced query resend" section. Never rejects, never
   * throws; runs entirely in the background (the caller's own
   * `sendUnsequencedQuery` call has already returned by the time this
   * settles). */
  private armUnsequencedResend(verb: string, line: string): void {
    const expectedVerb = expectedReplyVerbFor(verb);
    this.pendingUnsequencedQueries += 1;
    let settled = false;
    const finish = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      unsubscribe();
      this.pendingUnsequencedQueries -= 1;
    };
    const unsubscribe = this.lineEmitter.on((decoded) => {
      if (!settled && decoded.verb === expectedVerb) {
        finish();
      }
    });
    void (async () => {
      await this.scheduler.delay(DEFAULT_UNSEQUENCED_QUERY_RESEND_MS);
      if (settled) {
        return;
      }
      // One bounded resend -- never a second one, per the module doc
      // comment's own invariant. Only while still connected: a closed
      // link has nothing left to resend onto.
      if (this.isOpen) {
        this.paceWrite(line);
      }
      await this.scheduler.delay(DEFAULT_UNSEQUENCED_QUERY_RESEND_MS);
      finish();
    })();
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

  /** Schedule a paced write; a {@link ByteStream.write} callback failure
   * surfaces via {@link onError} instead of being swallowed. */
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
      (err) => this.errorEmitter.dispatch(err),
    );
  }

  // ---- receiving ----

  onLine(listener: LineListener): () => void {
    return this.lineEmitter.on(listener);
  }

  onRawLine(listener: RawLineListener): () => void {
    return this.rawLineEmitter.on(listener);
  }

  /**
   * Subscribe to EVERY inbound raw line this link receives — decoded
   * (`id`/`status`/`ack`/`nack`/...), unrouted, or malformed alike — the
   * moment it is not consumed as a banner reply. Bench defect (team-lead,
   * 2026-09-13, item G): `server.ts`'s student console broadcast used to
   * read only {@link onRawLine}, which fires exclusively for lines
   * `receive()` could not route to a decoded shape (`result.unrouted`) or
   * flagged malformed — so a real, successfully-decoded reply (`id`,
   * `status`, `ack`, `nack`) never reached the console at all, and only
   * unsolicited `DBG:` lines (which `receive()` also can't route) were
   * ever visible. This regressed in the 015-005 server rewrite. `onLine`/
   * `onAckNack`/`onRawLine`'s own existing semantics and call sites
   * (`connector.ts`'s relay preamble depends on `onRawLine` specifically)
   * are unchanged by this addition — this is a fourth, additive tap, not
   * a replacement.
   */
  onInboundLine(listener: RawLineListener): () => void {
    return this.inboundLineEmitter.on(listener);
  }

  onAckNack(listener: AckNackListener): () => void {
    return this.ackNackEmitter.on(listener);
  }

  onError(listener: LinkErrorListener): () => void {
    return this.errorEmitter.on(listener);
  }

  /** Subscribe to the link's own close — see {@link LinkCloseListener}'s
   * doc comment. Returns an unsubscribe function. */
  onClose(listener: LinkCloseListener): () => void {
    return this.closeEmitter.on(listener);
  }

  private attachStreamListeners(): void {
    this.stream.on("data", (chunk) => {
      for (const raw of this.reassembler.push(chunk)) {
        this.handleRawLine(raw);
      }
    });
    this.stream.on("error", (err) => {
      this.lastError = err;
      this.errorEmitter.dispatch(err);
    });
    this.stream.on("close", () => {
      this.handleStreamClose();
    });
  }

  /** Handle one already-reassembled, already-normalized inbound line.
   * While {@link identify} is waiting for a banner ({@link
   * resolveBannerWait} set), the line is first tried against {@link
   * parseBanner} (after {@link stripReceivePrefix}); a match resolves the
   * wait and is consumed here, not dispatched. Any other line — banner
   * wait pending or not — still runs through {@link receive} and
   * dispatches normally, so in-flight acks/nacks are never lost during
   * the wait. */
  private handleRawLine(raw: string): void {
    if (this.resolveBannerWait) {
      const banner = parseBanner(stripReceivePrefix(raw));
      if (banner) {
        this.resolveBannerWait(banner);
        return;
      }
    }

    // Every inbound line that isn't consumed as a banner reply reaches
    // `onInboundLine` -- see that method's own doc comment (item G).
    this.inboundLineEmitter.dispatch(raw);

    // exactOptionalPropertyTypes: only include `onForeign` when configured.
    const result = receive(this.protocolSession, raw, this.onForeign ? { onForeign: this.onForeign } : {});

    // The resend MUST go out before anything else -- protocol.md S8.1.
    for (const resendLine of result.resend) {
      this.paceWrite(resendLine);
    }

    if (result.ackNack) {
      if (result.ackNack.kind === "malformed") {
        // Still reach the console, exactly like any other non-
        // actionable reply-direction oddity.
        this.rawLineEmitter.dispatch(raw);
      } else {
        this.ackNackEmitter.dispatch(result.ackNack);
      }
    }

    if (result.line) {
      this.lineEmitter.dispatch(result.line);
    }
    if (result.unrouted !== undefined) {
      this.rawLineEmitter.dispatch(result.unrouted);
    }
    // result.dropped ("blank" | "tooLong") -- nothing to do.
  }

  /** Fires {@link onClose} exactly once, whether reached via {@link
   * close} or an unsolicited `"close"` event; resolves a pending {@link
   * identify} wait `null` immediately rather than hanging to its
   * timeout. */
  private handleStreamClose(): void {
    if (this.closeNotified) {
      return;
    }
    this.closeNotified = true;
    this.state = "closed";
    this.resolveBannerWait?.(null);
    this.closeEmitter.dispatch(this.lastError);
  }
}
