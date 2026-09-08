/**
 * FakeSocket.ts — a fully synthetic {@link WebSocketLike} for driving
 * `WsProvider` in tests without real network I/O or depending on jsdom
 * implementing `WebSocket` itself.
 *
 * Ticket 006: this was duplicated verbatim in `DevicesTab.test.tsx` and
 * `ConsoleTab.test.tsx`. Routing (ticket 007) adds more test files that
 * need the exact same fake, so this is the one shared copy every
 * `WsProvider`-driving test imports instead of re-declaring its own.
 *
 * Ticket 008 adds `sentBinary`: the local-hex upload's one binary frame
 * (`sendBinary` on `WsActions`) is captured separately from `sent` so
 * every existing string-equality assertion against `sent` (a JSON
 * message per entry) is unaffected by this addition.
 */
import type { WebSocketLike } from "../ws/WsProvider";

export class FakeSocket implements WebSocketLike {
  readyState = 0;
  sent: string[] = [];
  sentBinary: Uint8Array[] = [];
  private listeners = new Map<string, Set<(event: unknown) => void>>();

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  send(data: string | ArrayBufferLike | ArrayBufferView): void {
    if (typeof data === "string") {
      this.sent.push(data);
      return;
    }
    const bytes = ArrayBuffer.isView(data)
      ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      : new Uint8Array(data);
    this.sentBinary.push(bytes);
  }

  close(): void {
    this.readyState = 3;
    this.emit("close", {});
  }

  emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }

  emitOpen(): void {
    this.readyState = 1;
    this.emit("open", {});
  }

  emitMessage(data: unknown): void {
    this.emit("message", { data: JSON.stringify(data) });
  }
}
