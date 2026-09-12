/**
 * serialStream.ts — a {@link ByteStream} adapter over a USB serial
 * (DAPLink CDC) port, ticket 014-006's real transport for
 * `LineLink.ts`'s `serial` seam. Carries over `UsbSerialLink.ts`'s two
 * hard-won bits of transport-level behavior: the darwin `tty.`/`cu.`
 * callout-path translation via `../../devices.js`'s {@link
 * toCalloutPath} (ticket 014-001 fixed this to be asserted with an
 * injected `platform`, not the real `process.platform`, so it is
 * provable on Linux CI too), and the injectable {@link SerialPortLike}
 * seam so a test never opens a real port. Everything else
 * `UsbSerialLink` used to own itself — write pacing, line reassembly,
 * banner waiting, `HELLO`/session state — now lives in `LineLink.ts`
 * and is not repeated here: this module's only job is open/write/on/
 * close over one real (or faked) port.
 *
 * `open(signal)` honours an aborting `signal` (LineLink's own
 * `connect({ timeoutMs })` bound, or a caller-supplied one) by closing
 * the half-open port and rejecting — the fix for `02-host-transport.md`
 * §5.6/§1's "no connect timeout ... hangs indefinitely", which the old
 * four classes never bounded at all (relying on the OS's own SYN/open
 * timeout).
 *
 * `on()` is called by `LineLink.connect()` *before* `open()` resolves
 * (indeed, before it is even called) — see `LineLink.ts`'s own
 * `attachStreamListeners()`. Listener registration is therefore kept in
 * plain arrays owned by this module, independent of whether a port has
 * been created yet, and replayed onto the real port once `open()`
 * creates one.
 */
import { SerialPort } from "serialport";
import { toCalloutPath } from "../../devices.js";
import type { ByteStream } from "../LineLink.js";

/** DAPLink CDC serial ports always run at this fixed baud rate --
 * mirrors `UsbSerialLink.ts`'s own `BAUD_RATE`. */
const BAUD_RATE = 115200;

/** The slice of `serialport`'s `SerialPort` this module actually uses --
 * identical seam to `UsbSerialLink.ts`'s own `SerialPortLike`, so a test
 * can drive this adapter against the same style of fully synthetic
 * fake. */
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

export interface SerialStreamOptions {
  /** Injectable port factory. Defaults to real `serialport`; tests
   * substitute a fake implementing {@link SerialPortLike}. */
  createPort?: (path: string, options: { baudRate: number }) => SerialPortLike;
  /** Injectable platform, passed straight through to {@link
   * toCalloutPath}. Defaults to `process.platform`; tests substitute
   * `"darwin"`/`"linux"` explicitly -- see `UsbSerialLink.ts`'s own
   * option of the same name for why (ticket 014-001). */
  platform?: NodeJS.Platform;
}

function abortReason(signal: AbortSignal): Error {
  const reason = (signal as { reason?: unknown }).reason;
  return reason instanceof Error ? reason : new Error(String(reason ?? "aborted"));
}

class SerialByteStream implements ByteStream {
  private readonly createPort: (path: string, options: { baudRate: number }) => SerialPortLike;
  private readonly platform: NodeJS.Platform;
  private port: SerialPortLike | undefined;
  private readonly dataListeners: Array<(chunk: Buffer | string) => void> = [];
  private readonly errorListeners: Array<(err: Error) => void> = [];
  private readonly closeListeners: Array<() => void> = [];

  constructor(
    private readonly portPath: string,
    options: SerialStreamOptions,
  ) {
    this.createPort = options.createPort ?? defaultCreatePort;
    this.platform = options.platform ?? process.platform;
  }

  open(signal: AbortSignal): Promise<void> {
    if (signal.aborted) {
      return Promise.reject(abortReason(signal));
    }

    const calloutPath = toCalloutPath(this.portPath, this.platform);
    const port = this.createPort(calloutPath, { baudRate: BAUD_RATE });
    this.port = port;
    for (const listener of this.dataListeners) {
      port.on("data", listener);
    }
    for (const listener of this.errorListeners) {
      port.on("error", listener);
    }
    for (const listener of this.closeListeners) {
      port.on("close", listener);
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      const onAbort = () => {
        if (settled) {
          return;
        }
        settled = true;
        port.close(() => {});
        reject(abortReason(signal));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      port.once("open", () => {
        if (settled) {
          return;
        }
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve();
      });
      port.once("error", (err) => {
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
    if (!this.port) {
      callback(new Error("serialStream: write() called before open() resolved"));
      return;
    }
    this.port.write(bytes, callback);
  }

  on(event: "data", listener: (chunk: Buffer | string) => void): void;
  on(event: "error", listener: (err: Error) => void): void;
  on(event: "close", listener: () => void): void;
  on(event: "data" | "error" | "close", listener: (...args: never[]) => void): void {
    // Defensive -- LineLink registers every listener before open(), but a
    // listener added after the port exists (e.g. a differently-shaped
    // caller) is still wired up rather than silently dropped. Branched
    // per event (rather than one `this.port?.on(event, listener)` call)
    // because `SerialPortLike.on`'s per-event overloads can't be
    // satisfied by a single call carrying the union type `event` has
    // here.
    if (event === "data") {
      const dataListener = listener as (chunk: Buffer | string) => void;
      this.dataListeners.push(dataListener);
      this.port?.on("data", dataListener);
    } else if (event === "error") {
      const errorListener = listener as (err: Error) => void;
      this.errorListeners.push(errorListener);
      this.port?.on("error", errorListener);
    } else {
      const closeListener = listener as () => void;
      this.closeListeners.push(closeListener);
      this.port?.on("close", closeListener);
    }
  }

  close(): Promise<void> {
    const port = this.port;
    if (!port) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      port.close(() => resolve());
    });
  }
}

/** Build a {@link ByteStream} over a USB serial port at `portPath` --
 * see the module doc comment. */
export function serialStream(portPath: string, options: SerialStreamOptions = {}): ByteStream {
  return new SerialByteStream(portPath, options);
}
