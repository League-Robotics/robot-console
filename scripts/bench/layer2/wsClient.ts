/**
 * wsClient.ts — a thin `ws` client speaking the host's own public
 * WebSocket wire contract (`@robot-console/host`'s `wsMessages.ts`,
 * `docs/design/architecture.md` §9) directly: `session-open`,
 * `send-command`, `session-close`, plus the `snapshot`/`line`/`notice`
 * stream a real browser tab receives.
 *
 * Unlike Layer 1 (which deliberately never touches host code, so a
 * host bug can never be masked by sharing its own parser), Layer 2's
 * entire purpose is to exercise the host's own public contract from
 * outside it -- so importing `@robot-console/host`'s exported message
 * *types* here (never its internal orchestration -- no
 * `connect/`, `store/`, or watcher module is ever imported) is the
 * correct boundary for this layer specifically. This mirrors exactly
 * how `packages/ui` itself consumes this same published package; it is
 * not a host-internals shortcut.
 *
 * Matches the pattern sprint 015 ticket 011's own scratch `wsclient.mjs`
 * used live against the real bench (`session-open`/`send-command`
 * over a plain `ws://host:port/` connection, no path segment), now
 * committed and structured rather than thrown away.
 */
import WebSocket from "ws";
import type { ClientMessage, LineMessage, Notice, ServerMessage, Snapshot } from "@robot-console/host";
import type { WireField } from "@robot-console/protocol";

export interface WsClientOptions {
  url: string;
  connectTimeoutMs?: number;
}

export const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;

type SnapshotListener = (snapshot: Snapshot) => void;
type LineListener = (message: LineMessage) => void;
type NoticeListener = (notice: Notice) => void;

/**
 * One open WebSocket connection to a running host, tracking the latest
 * `snapshot` and exposing the client -> server messages Layer 2 needs.
 * Never opens more than one socket; {@link close} is the only way to
 * end it.
 */
export class BenchWsClient {
  private readonly ws: WebSocket;
  private latestSnapshot: Snapshot | undefined;
  private readonly snapshotListeners = new Set<SnapshotListener>();
  private readonly lineListeners = new Set<LineListener>();
  private readonly noticeListeners = new Set<NoticeListener>();
  /** Every notice seen on this connection so far, oldest first --
   * `index.ts`/`pathChecks.ts` filter this by `linkId` for a given
   * check's own report. */
  public readonly notices: Notice[] = [];

  private constructor(ws: WebSocket) {
    this.ws = ws;
    this.ws.on("message", (data: Buffer | ArrayBuffer | Buffer[]) => {
      // Binary frames (the local-hex upload's own ack) are never
      // relevant to this harness -- only ever sent by a client, never
      // received unsolicited, so a Buffer payload with no JSON shape
      // here is simply ignored rather than crashing the client.
      let parsed: ServerMessage;
      try {
        parsed = JSON.parse(data.toString()) as ServerMessage;
      } catch {
        return;
      }
      this.handle(parsed);
    });
  }

  /** Open a connection and wait for it to be ready. Rejects (never
   * hangs) if the connection fails or does not open within
   * `connectTimeoutMs` (default {@link DEFAULT_CONNECT_TIMEOUT_MS}). */
  static async connect(options: WsClientOptions): Promise<BenchWsClient> {
    const timeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    const ws = new WebSocket(options.url);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        ws.terminate();
        reject(new Error(`connect to ${options.url} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      ws.once("open", () => {
        clearTimeout(timer);
        resolve();
      });
      ws.once("error", (error: Error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    return new BenchWsClient(ws);
  }

  private handle(message: ServerMessage): void {
    if (message.type === "snapshot") {
      this.latestSnapshot = message;
      for (const listener of [...this.snapshotListeners]) {
        listener(message);
      }
    } else if (message.type === "line") {
      for (const listener of [...this.lineListeners]) {
        listener(message);
      }
    } else if (message.type === "notice") {
      this.notices.push(message);
      for (const listener of [...this.noticeListeners]) {
        listener(message);
      }
    }
  }

  /** The most recently received `snapshot`, or `undefined` before the
   * first one has arrived (the host sends one immediately on
   * connect). */
  get snapshot(): Snapshot | undefined {
    return this.latestSnapshot;
  }

  private send(message: ClientMessage): void {
    this.ws.send(JSON.stringify(message));
  }

  sessionOpen(payload: { linkId: string } | { relayLinkId: string; name: string }): void {
    this.send({ type: "session-open", ...payload } as ClientMessage);
  }

  sessionClose(linkId: string): void {
    this.send({ type: "session-close", linkId });
  }

  sendCommand(linkId: string, verb: string, fields?: WireField[]): void {
    this.send({ type: "send-command", linkId, verb, ...(fields !== undefined ? { fields } : {}) });
  }

  /** Resolve with the *next* `snapshot` message received after this
   * call (never the already-latest one) -- the building block
   * {@link waitForSettle} uses to detect "no change for N ms" without
   * needing a fake clock. `undefined` if none arrives within
   * `timeoutMs`. */
  nextSnapshot(timeoutMs: number): Promise<Snapshot | undefined> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.snapshotListeners.delete(listener);
        resolve(undefined);
      }, timeoutMs);
      const listener: SnapshotListener = (snapshot) => {
        clearTimeout(timer);
        this.snapshotListeners.delete(listener);
        resolve(snapshot);
      };
      this.snapshotListeners.add(listener);
    });
  }

  /** Resolve as soon as `predicate` is true of the current snapshot
   * (checked immediately against {@link snapshot} first, then on every
   * new one) -- for "wait until this link is connected", not for
   * settle detection (use {@link nextSnapshot}/{@link waitForSettle}
   * for that). `undefined` if `predicate` never becomes true within
   * `timeoutMs`. */
  waitForSnapshot(predicate: (snapshot: Snapshot) => boolean, timeoutMs: number): Promise<Snapshot | undefined> {
    if (this.latestSnapshot !== undefined && predicate(this.latestSnapshot)) {
      return Promise.resolve(this.latestSnapshot);
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.snapshotListeners.delete(listener);
        resolve(undefined);
      }, timeoutMs);
      const listener: SnapshotListener = (snapshot) => {
        if (predicate(snapshot)) {
          clearTimeout(timer);
          this.snapshotListeners.delete(listener);
          resolve(snapshot);
        }
      };
      this.snapshotListeners.add(listener);
    });
  }

  /** Resolve with the first `rx` `line` on `linkId` matching
   * `predicate`. `undefined` on timeout. */
  waitForLine(linkId: string, predicate: (line: string) => boolean, timeoutMs: number): Promise<string | undefined> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.lineListeners.delete(listener);
        resolve(undefined);
      }, timeoutMs);
      const listener: LineListener = (message) => {
        if (message.linkId === linkId && message.direction === "rx" && predicate(message.line)) {
          clearTimeout(timer);
          this.lineListeners.delete(listener);
          resolve(message.line);
        }
      };
      this.lineListeners.add(listener);
    });
  }

  /** Every notice observed for `linkId` so far, oldest first. */
  noticesFor(linkId: string): Notice[] {
    return this.notices.filter((n) => n.linkId === linkId);
  }

  close(): void {
    this.ws.close();
  }
}

/** The minimal slice of {@link BenchWsClient} {@link waitForSettle}
 * needs -- so it is directly testable against a fully synthetic fake
 * driver, no real socket ever required. */
export interface SettleDriver {
  readonly snapshot: Snapshot | undefined;
  nextSnapshot(timeoutMs: number): Promise<Snapshot | undefined>;
}

export const DEFAULT_SETTLE_STABLE_MS = 5_000;
export const DEFAULT_SETTLE_BOUND_MS = 90_000;

/** A stable, order-independent fingerprint of every link's own
 * transport/state across a snapshot -- the "did anything relevant
 * change" signal {@link waitForSettle} watches. Deliberately narrow:
 * only `transport`/`state`/`id` are compared (not e.g. `lastSeen`,
 * which legitimately ticks on every watcher poll without the link
 * itself having changed in any way this harness cares about). */
export function fingerprintSnapshot(snapshot: Pick<Snapshot, "devices" | "unassigned">): string {
  const rows = [
    ...snapshot.devices.flatMap((device) => device.links.map((link) => `${device.name}|${link.transport}|${link.id}|${link.state}`)),
    ...snapshot.unassigned.map((link) => `unassigned|${link.transport}|${link.id}|${link.state}`),
  ].sort();
  return rows.join("\n");
}

export interface SettleOptions {
  stableForMs?: number;
  boundedMs?: number;
}

export interface SettleResult {
  settled: boolean;
  elapsedMs: number;
  finalSnapshot: Snapshot | undefined;
}

/**
 * Poll `driver` until its snapshot's {@link fingerprintSnapshot} has
 * not changed for `stableForMs` (default {@link DEFAULT_SETTLE_STABLE_MS}),
 * bounded overall at `boundedMs` (default {@link DEFAULT_SETTLE_BOUND_MS})
 * -- matching sprint 015 ticket 011's own live bench precedent for
 * "settled" ("state identical across seq 29 through seq 177").
 *
 * Correct even when no further snapshot ever arrives at all: each loop
 * iteration waits for `min(time left in the bound, time left in the
 * stability window)`, so silence for the full stability window is
 * itself treated as settled, not as a stall this function keeps
 * waiting past the bound to (dis)prove.
 */
export async function waitForSettle(driver: SettleDriver, options: SettleOptions = {}): Promise<SettleResult> {
  const stableForMs = options.stableForMs ?? DEFAULT_SETTLE_STABLE_MS;
  const boundedMs = options.boundedMs ?? DEFAULT_SETTLE_BOUND_MS;
  const start = Date.now();

  let finalSnapshot = driver.snapshot;
  let lastFingerprint = finalSnapshot !== undefined ? fingerprintSnapshot(finalSnapshot) : undefined;
  let lastChangeAt = start;

  for (;;) {
    const now = Date.now();
    const remainingBound = boundedMs - (now - start);
    if (remainingBound <= 0) {
      return { settled: false, elapsedMs: now - start, finalSnapshot };
    }
    const remainingStable = stableForMs - (now - lastChangeAt);
    if (remainingStable <= 0) {
      return { settled: true, elapsedMs: now - start, finalSnapshot };
    }

    const waitMs = Math.min(remainingBound, remainingStable);
    const next = await driver.nextSnapshot(waitMs);
    if (next === undefined) {
      // Either bound is up (loop head will catch it) or the stability
      // window just elapsed with nothing changing -- either way, loop
      // and let the checks above decide which.
      continue;
    }
    finalSnapshot = next;
    const fingerprint = fingerprintSnapshot(next);
    if (fingerprint !== lastFingerprint) {
      lastFingerprint = fingerprint;
      lastChangeAt = Date.now();
    }
  }
}
