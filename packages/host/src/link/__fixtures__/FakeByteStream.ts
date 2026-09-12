/**
 * FakeByteStream.ts — a fully synthetic {@link ByteStream} test harness.
 * Drives `LineLink.test.ts`'s entire core suite with no real serial/TCP
 * I/O at all; ticket 014-006's real adapters (serial/TCP) are expected
 * to build their own open/close/write tests on this same fixture (see
 * `LineLink.ts`'s own module doc comment).
 *
 * Every knob a test needs is a plain method or field, not a hand-rolled
 * `EventEmitter`: `emitData`/`emitError`/`emitClose` simulate inbound
 * activity; `resolveOpen`/`rejectOpen` control what a pending `open()`
 * call does; `writes` records every `write()` call, in order, so a test
 * can assert exactly what went out over the wire and in what sequence
 * (e.g. a nack's resend line landing before a later queued write).
 */
import type { ByteStream } from "../LineLink.js";

export interface FakeByteStreamWriteCall {
  readonly bytes: string;
  readonly callback: (err?: Error | null) => void;
}

export class FakeByteStream implements ByteStream {
  readonly writes: FakeByteStreamWriteCall[] = [];
  openCallCount = 0;
  closeCallCount = 0;
  lastOpenSignal: AbortSignal | undefined;

  /** Set to have the NEXT `write()` call fail its callback with this
   * error instead of succeeding. Cleared after that one use. */
  nextWriteError: Error | undefined;

  /** When `true`, `write()` records the call but never invokes its
   * callback -- lets a test assert `WritePacer`'s scheduling order
   * before any write "completes". */
  holdWrites = false;

  private readonly dataListeners: Array<(chunk: Buffer | string) => void> = [];
  private readonly errorListeners: Array<(err: Error) => void> = [];
  private readonly closeListeners: Array<() => void> = [];
  private openResolve: (() => void) | undefined;
  private openReject: ((err: Error) => void) | undefined;
  private closeRequested = false;
  private closeEmitted = false;

  open(signal: AbortSignal): Promise<void> {
    this.openCallCount++;
    this.lastOpenSignal = signal;
    return new Promise<void>((resolve, reject) => {
      if (signal.aborted) {
        reject(this.abortReason(signal));
        return;
      }
      this.openResolve = resolve;
      this.openReject = reject;
      signal.addEventListener(
        "abort",
        () => {
          this.openReject?.(this.abortReason(signal));
          this.openResolve = undefined;
          this.openReject = undefined;
        },
        { once: true },
      );
    });
  }

  private abortReason(signal: AbortSignal): Error {
    const reason = (signal as { reason?: unknown }).reason;
    return reason instanceof Error ? reason : new Error(String(reason ?? "aborted"));
  }

  /** Resolve the currently pending `open()` call successfully. */
  resolveOpen(): void {
    this.openResolve?.();
    this.openResolve = undefined;
    this.openReject = undefined;
  }

  /** Reject the currently pending `open()` call. */
  rejectOpen(err: Error): void {
    this.openReject?.(err);
    this.openResolve = undefined;
    this.openReject = undefined;
  }

  write(bytes: string, callback: (err?: Error | null) => void): void {
    this.writes.push({ bytes, callback });
    if (this.holdWrites) {
      return;
    }
    const err = this.nextWriteError;
    this.nextWriteError = undefined;
    queueMicrotask(() => callback(err ?? null));
  }

  on(event: "data", listener: (chunk: Buffer | string) => void): void;
  on(event: "error", listener: (err: Error) => void): void;
  on(event: "close", listener: () => void): void;
  on(event: "data" | "error" | "close", listener: (...args: never[]) => void): void {
    if (event === "data") {
      this.dataListeners.push(listener as (chunk: Buffer | string) => void);
    } else if (event === "error") {
      this.errorListeners.push(listener as (err: Error) => void);
    } else {
      this.closeListeners.push(listener as () => void);
    }
  }

  close(): Promise<void> {
    this.closeCallCount++;
    if (this.closeRequested) {
      return Promise.resolve();
    }
    this.closeRequested = true;
    // Mirrors a real transport (serialport / net.Socket): "close" fires
    // once the underlying resource actually closes, asynchronously,
    // whether that closure was requested (this call) or unsolicited
    // (emitClose() below, simulating a peer disconnect / device yank).
    queueMicrotask(() => this.emitClose());
    return Promise.resolve();
  }

  /** Simulate inbound bytes arriving on the stream. */
  emitData(chunk: Buffer | string): void {
    for (const listener of this.dataListeners) {
      listener(chunk);
    }
  }

  /** Simulate a transport-level error. Does not itself close the
   * stream -- pair with `emitClose()` if the error is meant to be
   * fatal, exactly as a real socket reports `"error"` then `"close"`. */
  emitError(err: Error): void {
    for (const listener of this.errorListeners) {
      listener(err);
    }
  }

  /** Simulate the underlying transport closing. Idempotent, mirroring a
   * real stream's own single `"close"` event. */
  emitClose(): void {
    if (this.closeEmitted) {
      return;
    }
    this.closeEmitted = true;
    for (const listener of this.closeListeners) {
      listener();
    }
  }
}
