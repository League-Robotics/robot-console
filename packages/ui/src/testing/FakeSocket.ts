/**
 * FakeSocket.ts — a fully synthetic {@link WebSocketLike} for driving
 * `WsProvider` in tests without real network I/O or depending on jsdom
 * implementing `WebSocket` itself.
 *
 * Ticket 006: this was duplicated verbatim in `DevicesTab.test.tsx` and
 * `ConsoleTab.test.tsx`. Routing (ticket 007) adds more test files that
 * need the exact same fake, so this is the one shared copy every
 * `WsProvider`-driving test imports instead of re-declaring its own.
 */
import type { WebSocketLike } from "../ws/WsProvider";

export class FakeSocket implements WebSocketLike {
  readyState = 0;
  sent: string[] = [];
  private listeners = new Map<string, Set<(event: unknown) => void>>();

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  send(data: string): void {
    this.sent.push(data);
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
