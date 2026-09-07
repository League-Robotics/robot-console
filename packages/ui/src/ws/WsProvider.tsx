/**
 * WsProvider.tsx — the one WebSocket connection the UI holds open to
 * `packages/host`'s `server.ts`, per `wsMessages.ts`'s contract.
 *
 * Ticket 010's plan calls for a single shared connection/context that
 * both the Devices tab (this ticket) and the Console tab (ticket 011)
 * consume, rather than each tab opening its own socket. This module is
 * that shared piece: it owns the socket lifecycle (connect, reconnect
 * after an unexpected close, teardown on unmount), keeps the latest
 * `devices` snapshot in React state (the server always sends a full
 * snapshot, never a delta -- see `wsMessages.ts`'s `DevicesMessage`
 * doc comment -- so consumers never need to diff), and offers a small
 * pub/sub surface for `line`/`error` messages that a future Console
 * tab can subscribe to without this module needing to know anything
 * about console-specific rendering.
 *
 * Deliberately out of scope here (per this ticket's scope discipline):
 * anything about *what* the Console tab does with `line` traffic --
 * only the transport is shared, not any console-specific logic.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type {
  ClientMessage,
  DeviceListEntry,
  ErrorMessage,
  LineMessage,
  ServerMessage,
} from "@robot-console/host/src/wsMessages.js";

export type ConnectionStatus = "connecting" | "open" | "closed";

/**
 * The slice of the browser `WebSocket` API this module actually uses.
 * Kept narrow and exported so tests can inject a fully synthetic fake
 * (no real network, no dependence on jsdom implementing `WebSocket`)
 * -- mirrors `deviceRegistry.ts`'s `UsbSerialLinkLike` seam on the host
 * side of this same contract.
 */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(type: string, listener: (event: unknown) => void): void;
  removeEventListener(type: string, listener: (event: unknown) => void): void;
}

const WEBSOCKET_OPEN = 1;

interface WsContextValue {
  status: ConnectionStatus;
  devices: DeviceListEntry[];
  send: (message: ClientMessage) => void;
  onLine: (handler: (message: LineMessage) => void) => () => void;
  onError: (handler: (message: ErrorMessage) => void) => () => void;
}

const WsContext = createContext<WsContextValue | undefined>(undefined);

/** Fixed delay before retrying after an unexpected close. The host
 * process is local and either up or not -- there is no meaningful
 * backoff ladder to tune here, just "keep trying". */
const RECONNECT_DELAY_MS = 1500;

function defaultSocketUrl(): string {
  // Development only: `npm run dev` (scripts/dev.mjs) serves this page
  // from Vite on its own port while the host runs on another, so the
  // page cannot find the host by looking at its own origin. That script
  // `define`s this to the host's real address. A production `vite build`
  // never sets it, so the fallback below -- connect back to whoever
  // served the page, which under `npx robot-console` is the host itself
  // -- remains the only path that ships.
  const configured = import.meta.env.VITE_WS_URL;
  if (typeof configured === "string" && configured !== "") {
    return configured;
  }
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  return `${protocol}://${window.location.host}/`;
}

function defaultSocketFactory(url: string): WebSocketLike {
  return new WebSocket(url) as unknown as WebSocketLike;
}

function isServerMessage(value: unknown): value is ServerMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { type?: unknown }).type === "string"
  );
}

export interface WsProviderProps {
  children: ReactNode;
  /** Override the socket URL (tests only; production always connects
   * back to the host that served this page). */
  url?: string;
  /** Override how a socket is constructed (tests only; production uses
   * the real browser `WebSocket`). */
  socketFactory?: (url: string) => WebSocketLike;
}

export function WsProvider({ children, url, socketFactory }: WsProviderProps) {
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [devices, setDevices] = useState<DeviceListEntry[]>([]);
  const socketRef = useRef<WebSocketLike | null>(null);
  const lineHandlers = useRef(new Set<(message: LineMessage) => void>());
  const errorHandlers = useRef(new Set<(message: ErrorMessage) => void>());

  useEffect(() => {
    let cancelled = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    const makeSocket = socketFactory ?? defaultSocketFactory;
    const resolvedUrl = url ?? defaultSocketUrl();

    function connect() {
      if (cancelled) {
        return;
      }
      setStatus("connecting");
      const socket = makeSocket(resolvedUrl);
      socketRef.current = socket;

      socket.addEventListener("open", () => {
        if (cancelled) {
          return;
        }
        setStatus("open");
      });

      socket.addEventListener("message", (event) => {
        if (cancelled) {
          return;
        }
        const raw = (event as { data?: unknown }).data;
        let parsed: unknown;
        try {
          parsed = JSON.parse(String(raw));
        } catch {
          return;
        }
        if (!isServerMessage(parsed)) {
          return;
        }
        switch (parsed.type) {
          case "devices":
            setDevices(parsed.devices);
            break;
          case "line":
            for (const handler of lineHandlers.current) {
              handler(parsed);
            }
            break;
          case "error":
            for (const handler of errorHandlers.current) {
              handler(parsed);
            }
            break;
        }
      });

      // The subsequent "close" event (browsers always fire close after
      // error on a socket that never opened, or after a mid-session
      // drop) is what drives reconnection below -- nothing extra to do
      // on "error" itself.
      socket.addEventListener("error", () => {});

      socket.addEventListener("close", () => {
        if (cancelled) {
          return;
        }
        // Deliberately does not clear `devices`: a dropped connection
        // should not blank out the last-known list while reconnecting
        // (same "never destabilize the list" requirement the ticket
        // calls for on a per-device basis, applied to the whole-list
        // case too).
        setStatus("closed");
        socketRef.current = null;
        reconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS);
      });
    }

    connect();

    return () => {
      cancelled = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
      }
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, [url, socketFactory]);

  const send = useCallback((message: ClientMessage) => {
    const socket = socketRef.current;
    if (socket && socket.readyState === WEBSOCKET_OPEN) {
      socket.send(JSON.stringify(message));
    }
  }, []);

  const onLine = useCallback((handler: (message: LineMessage) => void) => {
    lineHandlers.current.add(handler);
    return () => {
      lineHandlers.current.delete(handler);
    };
  }, []);

  const onError = useCallback((handler: (message: ErrorMessage) => void) => {
    errorHandlers.current.add(handler);
    return () => {
      errorHandlers.current.delete(handler);
    };
  }, []);

  const value: WsContextValue = { status, devices, send, onLine, onError };

  return <WsContext.Provider value={value}>{children}</WsContext.Provider>;
}

export function useWs(): WsContextValue {
  const ctx = useContext(WsContext);
  if (!ctx) {
    throw new Error("useWs must be called within a WsProvider");
  }
  return ctx;
}
