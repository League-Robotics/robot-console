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
 */
import { connect as netConnect } from "node:net";
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

export interface TcpStreamOptions {
  /** Injectable socket factory. Defaults to real `net.connect`; tests
   * substitute a fake implementing {@link TcpSocketLike}, or point it at
   * a real loopback server. */
  createSocket?: (host: string, port: number) => TcpSocketLike;
}

function abortReason(signal: AbortSignal): Error {
  const reason = (signal as { reason?: unknown }).reason;
  return reason instanceof Error ? reason : new Error(String(reason ?? "aborted"));
}

class TcpByteStream implements ByteStream {
  private readonly createSocket: (host: string, port: number) => TcpSocketLike;
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
  }

  open(signal: AbortSignal): Promise<void> {
    if (signal.aborted) {
      return Promise.reject(abortReason(signal));
    }

    const socket = this.createSocket(this.host, this.port);
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
