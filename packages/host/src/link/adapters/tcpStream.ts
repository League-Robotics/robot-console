/**
 * tcpStream.ts — a {@link ByteStream} adapter over a TCP socket
 * (`net.Socket`), ticket 014-006's real transport for `LineLink.ts`'s
 * `tcp` seam — used both for `MbserialLink`'s direct-to-robot socket and
 * (composed with `RelayCommandPlane`'s `preamble` hook) `MbrelayLink`'s
 * relay socket, unifying what were two separate classes.
 *
 * Fixes two defects `02-host-transport.md` §1/§5/§6 catalogued in the
 * old `MbserialLink`/`MbrelayLink` pair:
 *
 * - **`setNoDelay(true)` always, immediately after connect, before any
 *   write.** `MbserialLink` deliberately left `TCP_NODELAY` unset
 *   (§5.7: "the WiFi transport at a 10ms write cadence, so Nagle adds
 *   40-200ms per line") while `MbrelayLink` set it only for its own
 *   command-plane latency reasons — this adapter is shared by both
 *   former call sites, so it always sets it; there is no longer a
 *   transport-specific judgment call to make here at all.
 * - **`destroy()`, never `end()`, on close.** `end()` waits for a
 *   graceful FIN/ACK exchange — with unflushed writes to a dead peer,
 *   `close()` can hang for minutes on a kernel retransmit (§5's own
 *   "socket.end() instead of destroy()" entry). `destroy()` tears the
 *   socket down immediately instead.
 *
 * `open(signal)` honours an aborting `signal` (LineLink's own
 * `connect({ timeoutMs })` bound, or a caller-supplied one) by
 * destroying the half-open socket and rejecting — the fix for
 * `02-host-transport.md` §5.6's "no connect timeout on ... TCP connect
 * (relies on the OS SYN timeout, 75-130s)".
 *
 * `on()` is called by `LineLink.connect()` *before* `open()` resolves --
 * see `serialStream.ts`'s own doc comment for why listener registration
 * is kept in plain arrays independent of whether a socket exists yet.
 *
 * ## 018-007: dial the resolved IPv4 address, never a raw `.local`
 * hostname
 *
 * Root cause, confirmed against real hardware: `dns.lookup("gopiv.local")`
 * took ~5,013ms on the bench Mac (past `LineLink`'s own 5,000ms connect
 * timeout) despite the robot answering `HELLO` in ~30ms once actually
 * connected by IP; `dns.lookup("loki.local")` (a farm mbserial bridge)
 * returned the IPv6 link-local address `fe80::...` *first*, and
 * `net.connect` by that hostname errored after 338ms with an empty
 * message — macOS's dual-stack resolution path can stall on an absent
 * route, or hand back a dead/unscoped address, before ever trying IPv4.
 * `TcpStreamOptions.ip` (from the link's own stored address —
 * `watchers/mdnsWatcher.ts`'s A-record capture, via `connector.ts`'s
 * `TcpAddress.ip`) is dialed directly when present; when absent (a link
 * observed before this ticket, or one whose service has not
 * re-announced yet), this module resolves one itself via a *bounded*
 * `dns.lookup(host, {family: 4})` — explicit `family: 4` so the
 * IPv6-link-local trap above can never recur, and bounded (default
 * {@link DEFAULT_DNS_LOOKUP_TIMEOUT_MS}, well under `LineLink`'s 5,000ms
 * connect budget) so a slow resolution cannot eat the whole connect
 * attempt the way the raw-hostname path did. Either way, `net.connect`
 * (via `createSocket`) is only ever handed a resolved address — a raw
 * `.local` hostname never reaches it.
 */
import { connect as netConnect } from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";
import type { ByteStream } from "../LineLink.js";

/** The slice of `net.Socket` this module actually uses -- mirrors
 * `MbrelayLink.ts`'s own `TcpSocketLike` seam (the one of the two old
 * classes that already needed `setNoDelay`), so a test can drive this
 * adapter against the same style of fully synthetic fake, or (per the
 * ticket) a real loopback `net.createServer` on an ephemeral port. */
export interface TcpSocketLike {
  on(event: "data", listener: (chunk: Buffer) => void): void;
  on(event: "error", listener: (err: Error) => void): void;
  on(event: "close", listener: () => void): void;
  once(event: "connect", listener: () => void): void;
  once(event: "error", listener: (err: Error) => void): void;
  write(data: string, callback?: (err?: Error | null) => void): boolean;
  setNoDelay(noDelay?: boolean): void;
  /** Tears the connection down immediately -- see the module doc
   * comment's `destroy()`-not-`end()` section for why this module never
   * calls `end()`. */
  destroy(error?: Error): void;
}

function defaultCreateSocket(host: string, port: number): TcpSocketLike {
  return netConnect({ host, port }) as unknown as TcpSocketLike;
}

/** Injectable `dns.lookup(hostname, {family: 4})` shape -- matches
 * `node:dns/promises`' own `lookup` signature exactly, so the real one
 * is the default and a test substitutes a fake that resolves/rejects/
 * hangs on demand without a real DNS query anywhere in this module's
 * own suite. */
export type Ipv4Lookup = (hostname: string, options: { family: 4 }) => Promise<{ address: string; family: number }>;

/** Bound for the fallback `dns.lookup(host, {family: 4})`, when no `ip`
 * is given in {@link TcpStreamOptions}. Short enough that a bad/slow
 * resolution does not eat `LineLink`'s own 5,000ms default connect
 * budget -- see the module doc comment's 018-007 section for the live
 * ~5,013ms hang this bound exists to cut off well before it reaches
 * that ceiling. */
export const DEFAULT_DNS_LOOKUP_TIMEOUT_MS = 2_000;

export interface TcpStreamOptions {
  /** Injectable socket factory. Defaults to real `net.connect`; tests
   * substitute a fake implementing {@link TcpSocketLike}, or point it at
   * a real loopback server. */
  createSocket?: (host: string, port: number) => TcpSocketLike;
  /** Resolved IPv4 address to dial directly, when already known
   * (018-007 -- typically the link's own stored `ip`, from
   * `watchers/mdnsWatcher.ts`'s A-record capture). When absent, `open()`
   * resolves one itself via a bounded `dns.lookup(host, {family: 4})`
   * before ever creating a socket -- never a raw `.local` hostname
   * straight to `net.connect`. */
  ip?: string;
  /** Bound for the fallback `dns.lookup`, when no `ip` is given. Defaults
   * to {@link DEFAULT_DNS_LOOKUP_TIMEOUT_MS}. */
  dnsLookupTimeoutMs?: number;
  /** Injectable `dns.lookup`, for tests. Defaults to `node:dns/promises`'
   * own `lookup`. */
  lookup?: Ipv4Lookup;
}

function abortReason(signal: AbortSignal): Error {
  const reason = (signal as { reason?: unknown }).reason;
  return reason instanceof Error ? reason : new Error(String(reason ?? "aborted"));
}

/**
 * Resolves `host` to an IPv4 address, bounded by both `timeoutMs` and
 * `signal` -- whichever comes first. Never lets a slow/hanging
 * resolution outlive either bound; a lookup that eventually settles
 * after this function has already rejected is simply ignored (this
 * module never passes a raw hostname to `net.connect` as a fallback, so
 * there is nothing left for a late resolution to feed into anyway).
 */
function resolveIpv4(host: string, timeoutMs: number, lookup: Ipv4Lookup, signal: AbortSignal): Promise<string> {
  if (signal.aborted) {
    return Promise.reject(abortReason(signal));
  }
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    };
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(new Error(`tcpStream: dns.lookup("${host}", {family: 4}) did not resolve within ${timeoutMs}ms`));
    }, timeoutMs);
    const onAbort = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    lookup(host, { family: 4 }).then(
      (result) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        resolve(result.address);
      },
      (error: unknown) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

class TcpByteStream implements ByteStream {
  private readonly createSocket: (host: string, port: number) => TcpSocketLike;
  private readonly ip: string | undefined;
  private readonly dnsLookupTimeoutMs: number;
  private readonly lookup: Ipv4Lookup;
  private socket: TcpSocketLike | undefined;
  private readonly dataListeners: Array<(chunk: Buffer | string) => void> = [];
  private readonly errorListeners: Array<(err: Error) => void> = [];
  private readonly closeListeners: Array<() => void> = [];

  constructor(
    private readonly host: string,
    private readonly port: number,
    options: TcpStreamOptions,
  ) {
    this.createSocket = options.createSocket ?? defaultCreateSocket;
    this.ip = options.ip;
    this.dnsLookupTimeoutMs = options.dnsLookupTimeoutMs ?? DEFAULT_DNS_LOOKUP_TIMEOUT_MS;
    this.lookup = options.lookup ?? dnsLookup;
  }

  async open(signal: AbortSignal): Promise<void> {
    if (signal.aborted) {
      throw abortReason(signal);
    }

    // 018-007: dial the stored IPv4 address when known; otherwise
    // resolve one ourselves, bounded -- see the module doc comment.
    // Never falls through to dialing `this.host` (a raw `.local`
    // hostname) directly.
    const target = this.ip ?? (await resolveIpv4(this.host, this.dnsLookupTimeoutMs, this.lookup, signal));
    if (signal.aborted) {
      throw abortReason(signal);
    }

    const socket = this.createSocket(target, this.port);
    this.socket = socket;
    for (const listener of this.dataListeners) {
      socket.on("data", listener);
    }
    for (const listener of this.errorListeners) {
      socket.on("error", listener);
    }
    for (const listener of this.closeListeners) {
      socket.on("close", listener);
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      const onAbort = () => {
        if (settled) {
          return;
        }
        settled = true;
        socket.destroy();
        reject(abortReason(signal));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      socket.once("connect", () => {
        if (settled) {
          return;
        }
        settled = true;
        signal.removeEventListener("abort", onAbort);
        // Always, immediately after connect, before any write -- see the
        // module doc comment.
        socket.setNoDelay(true);
        resolve();
      });
      socket.once("error", (err) => {
        if (settled) {
          return;
        }
        settled = true;
        signal.removeEventListener("abort", onAbort);
        reject(err);
      });
    });
  }

  write(bytes: string, callback: (err?: Error | null) => void): void {
    if (!this.socket) {
      callback(new Error("tcpStream: write() called before open() resolved"));
      return;
    }
    this.socket.write(bytes, callback);
  }

  on(event: "data", listener: (chunk: Buffer | string) => void): void;
  on(event: "error", listener: (err: Error) => void): void;
  on(event: "close", listener: () => void): void;
  on(event: "data" | "error" | "close", listener: (...args: never[]) => void): void {
    // See `serialStream.ts`'s own `on()` doc comment for why this is
    // branched per event rather than one call with the union `event`.
    if (event === "data") {
      const dataListener = listener as (chunk: Buffer | string) => void;
      this.dataListeners.push(dataListener);
      this.socket?.on("data", dataListener);
    } else if (event === "error") {
      const errorListener = listener as (err: Error) => void;
      this.errorListeners.push(errorListener);
      this.socket?.on("error", errorListener);
    } else {
      const closeListener = listener as () => void;
      this.closeListeners.push(closeListener);
      this.socket?.on("close", closeListener);
    }
  }

  close(): Promise<void> {
    // destroy(), not end() -- see the module doc comment. Fire-and-
    // forget, exactly like `__fixtures__/FakeByteStream.ts`'s own
    // close(): the actual "close" event (already wired above, whether
    // from LineLink or a direct caller) is what notifies a listener,
    // not this promise's resolution.
    this.socket?.destroy();
    return Promise.resolve();
  }
}

/** Build a {@link ByteStream} over a TCP socket to `host`/`port` -- see
 * the module doc comment. */
export function tcpStream(host: string, port: number, options: TcpStreamOptions = {}): ByteStream {
  return new TcpByteStream(host, port, options);
}
