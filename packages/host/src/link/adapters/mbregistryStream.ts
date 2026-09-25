/**
 * mbregistryStream.ts — a {@link ByteStream} adapter over an mbregistry
 * `lock` + `stream` session, sprint 018 ticket 003, sibling to
 * `serialStream.ts`/`tcpStream.ts`. Per sprint.md's Design Rationale
 * ("`mbregistryStream` is a new `ByteStream` adapter, not a `LineLink`
 * transport of its own"), this module's only job is `open`/`write`/`on`/
 * `close` over one mbregistry-backed connection, plus the
 * `sendBreak`/`setDtr`/`setRts` reset primitives ticket 006
 * (`relayBridger`) and ticket 004 (the connector's reset paths) call on
 * that same connection — everything else (which device, boot-window
 * identify, failure recording) stays in `LineLink`/the connector,
 * unchanged.
 *
 * `open(signal)` delegates the actual `lock`/`stream` handshake to
 * {@link MbregistryClient.stream} (ticket 001) — which itself already
 * implements the local-socket-first / remote-TCP-fallback policy this
 * ticket's own Description asks for (see that method's doc comment) —
 * and only decides *which* target to pass it via {@link
 * resolveStreamTarget}: a one-place seam so wiring in a device's own
 * remote endpoint (or, later, always preferring a local-socket path once
 * mbtools drops the TCP fallback entirely) never touches this module's
 * `open()` body.
 *
 * Once `stream()` resolves, this module owns the binary framing
 * (`streamFrame.ts`, ported from mbtools `stream_frame.py`) over the raw
 * socket it hands back: `DATA` frames become plain `ByteStream`
 * data/write traffic, and a malformed/oversized frame from the server is
 * degraded to an `onError`/`onClose` pair rather than crashing this
 * adapter (mirrors `stream_frame.py`'s own `FrameError` cases).
 *
 * ## Translating `locked` into a `ByteStream.open()` rejection
 *
 * Per sprint.md's Design Rationale "Consequences": mbregistry's `{"ok":
 * false, "code": "locked", "holder": {...}}` becomes a plain `Error`
 * whose message flows straight into the connector's existing
 * `recordFailure`/`state_reason`/`linkStateText` pipeline — no new UI
 * code. `holder.label` present → `"in use by <label>"`; absent (a
 * registry predating mbtools 008-002) → the plain `"in use"`, never an
 * `undefined` substring (SUC-005). When `holder.since` is also present
 * and old enough to read as stale (a fixed *display* threshold — this
 * module never enforces or times out a lock itself, mbregistry alone
 * decides when a lock is actually dead — SUC-006), the message also
 * names the exact `mbregistry unlock --force <uid>` command and the
 * owning host, with no UI control anywhere that calls it directly.
 */
import type * as net from "node:net";
import type { ByteStream } from "../LineLink.js";
import { MbregistryError, type LockHolder, type LockKind, type MbregistryClient } from "../../mbregistry/client.js";
import {
  FRAME_BREAK,
  FRAME_CLOSE,
  FRAME_DATA,
  FRAME_SET_DTR,
  FRAME_SET_RTS,
  FrameReassembler,
  encodeFrame,
} from "../../mbregistry/streamFrame.js";

/** A fixed *display* threshold for "old enough to call out as stale" —
 * SUC-006 is explicit this is not an enforced timeout (mbregistry alone
 * decides when a lock is actually dead); it only gates whether the
 * `unlock --force` hint is appended to an "in use by <label>" message.
 * Five minutes: long enough that an ordinary in-progress session is
 * never flagged, short enough that a session abandoned minutes ago
 * reads as stale promptly. Mirrors this codebase's existing
 * fixed-threshold-constant convention (`mdnsDiscovery.ts`'s own
 * `DEFAULT_WIFI_STALE_AFTER_MS`). */
export const DEFAULT_STALE_LOCK_AFTER_S = 5 * 60;

/** The minimal slice of an mbregistry device this module needs to open a
 * stream and, on a stale lock, name the right host — deliberately not
 * `RegistryDevice` itself (ticket 004's connector wiring owns mapping
 * the full store row down to this shape; this ticket only fixes the
 * seam's own shape so that mapping has something to target). */
export interface MbregistryStreamDevice {
  /** uid / short_uid / device_name — anything `mbregistry`'s own `lock`/
   * `stream` ops accept, and what a stale-lock hint's own `unlock
   * --force <name>` names. */
  uid: string;
  /** This device's own host (`RegistryDevice.host`), `null`/`undefined`
   * for a device the local mbregistry instance owns directly. Used only
   * as the stale-lock hint's fallback host name when the lock holder's
   * own wire shape doesn't carry one (a same-host holder never does —
   * see `registry-api.md`'s "Lock holder wire shape"). */
  host?: string | null | undefined;
  /**
   * The device's own remote endpoint, when it is known independently of
   * this client's own connected instance — set for a *remote* (peer-
   * owned) device. Left `undefined` for a local device, which resolves
   * through `MbregistryClient.stream`'s own local-socket-first /
   * 127.0.0.1-remote-port fallback instead — see {@link
   * resolveStreamTarget}, the one place this choice is made.
   */
  endpoint?: { host: string; port: number } | undefined;
}

/**
 * Decides what target, if any, to pass `MbregistryClient.stream()` for
 * `device` — the ticket's own "one-place change" seam for switching
 * transports later (e.g. if a future mbtools change removes the
 * 127.0.0.1-remote-port fallback for local devices entirely, only this
 * function's body changes). Today: a remote device's own `endpoint` when
 * present, `undefined` otherwise (a local device — `stream()` resolves
 * that itself).
 */
export function resolveStreamTarget(device: MbregistryStreamDevice): { host: string; port: number } | undefined {
  return device.endpoint;
}

/** Where a `flash`/`send_hex` exchange should be sent — either straight
 * to the local mbregistry instance's own Unix socket/pipe (the local
 * `flash` op, `hex_path` already on this shared filesystem — ticket
 * 018-011 finding 2), or to a remote TCP endpoint (the pre-011 remote
 * `send_hex`+`flash` path, unchanged for a peer-owned device or for the
 * fallback case documented on {@link resolveFlashPlan}). */
export type FlashPlan =
  | { kind: "remote"; target: { host: string; port: number } }
  | { kind: "local"; endpoint: { kind: "unix" | "pipe"; path: string } };

/** The slice of {@link MbregistryClient} {@link resolveFlashPlan} needs —
 * deliberately not the whole interface, mirroring this module's existing
 * narrow-Pick convention. */
export interface FlashPlanClient {
  readonly resolvedEndpoint: { kind: "unix" | "pipe" | "tcp"; path?: string; host?: string; port?: number } | undefined;
  readonly remotePort: number | undefined;
}

/**
 * Sprint 018 ticket 005's own extension of {@link resolveStreamTarget},
 * for `send_hex`/`flash`; reworked by ticket 011 finding 2 to fix a bug
 * against a *pre-existing* mbregistry (one this console didn't itself
 * spawn): `MbregistryClient.remotePort` is only ever set when this
 * console's own `connect()` call spawned the instance and read its
 * `--ready-json` line — connecting to an already-running registry (the
 * common case, and exactly what real-bench testing exercised) leaves it
 * `undefined`, so the pre-011 "always go over 127.0.0.1:remotePort for a
 * local device" rule failed immediately with "no remote TCP port known".
 *
 * The fix (per `docs/design/registry-api.md`'s "Remote flash and hex
 * staging" and its local-socket `flash` op entry, both mbtools, read-only
 * reference): the local Unix socket/pipe's own `flash` op takes a
 * `hex_path` already on *this same host's filesystem* — no `send_hex`
 * staging step exists for it (that step exists specifically because a
 * *remote* TCP client has no filesystem this registry process can read
 * directly). A "local device" by definition shares a filesystem with
 * this console's own local mbregistry instance, so `link/adapters/
 * mbregistryStream.ts`'s local-flash caller (`mbregistry/remoteFlash.ts#
 * flashViaLocalSocket`) can write the hex text to a temp file and pass
 * its path straight to the local socket's `flash` op — no remote port
 * needed at all for the common case.
 *
 * Decision tree:
 * - `device.endpoint` set (a remote, peer-owned device — same check
 *   {@link resolveStreamTarget} makes): `{kind: "remote", target:
 *   device.endpoint}`, unchanged from before — connect straight to the
 *   owning peer's remote TCP port, never proxying through the local
 *   instance.
 * - Otherwise (a local device) and this console's own connection is
 *   itself a local Unix socket/pipe (`client.resolvedEndpoint.kind !==
 *   "tcp"` — true whenever mbregistry was resolved via the standard
 *   client-socket-candidates path or a previously-spawned console-owned
 *   socket, i.e. essentially always): `{kind: "local", endpoint:
 *   client.resolvedEndpoint}`.
 * - Otherwise (a local device, but this console's own connection is
 *   itself over TCP — e.g. `$ROBOT_CONSOLE_MBREGISTRY` pointed at a
 *   `host:port`, so there is no local socket to use at all): falls back
 *   to the pre-011 `127.0.0.1:remotePort` path, which still requires
 *   `client.remotePort` to be known (only true if this console itself
 *   spawned that instance) — throws the same descriptive error as before
 *   when it isn't. This is a narrow, documented edge case: a console
 *   connecting to mbregistry over TCP with no remote port of its own has
 *   no way to reach the local `flash` op at all.
 */
export function resolveFlashPlan(device: MbregistryStreamDevice, client: FlashPlanClient): FlashPlan {
  const remote = resolveStreamTarget(device);
  if (remote !== undefined) {
    return { kind: "remote", target: remote };
  }
  const resolvedEndpoint = client.resolvedEndpoint;
  if (resolvedEndpoint !== undefined && resolvedEndpoint.kind !== "tcp" && resolvedEndpoint.path !== undefined) {
    return { kind: "local", endpoint: { kind: resolvedEndpoint.kind, path: resolvedEndpoint.path } };
  }
  if (client.remotePort === undefined) {
    throw new Error(
      `mbregistry: no local socket and no remote TCP port known for local device "${device.uid}" -- ` +
        "flash requires either the local instance's own socket or its own remote port, and neither was available",
    );
  }
  return { kind: "remote", target: { host: "127.0.0.1", port: client.remotePort } };
}

/** A {@link ByteStream} with sprint 018's reset primitives added —
 * ticket 006 (`relayBridger`) and the connector's own reset paths call
 * these on the same locked connection instead of opening a second one
 * (sprint.md Design Rationale). */
export interface MbregistryResettableStream extends ByteStream {
  /** Sends a `BREAK` frame (client → server; no payload) — the server
   * asserts a fixed-duration serial break on its own local port. */
  sendBreak(): Promise<void>;
  /** Sends a `SET_DTR` frame with a one-byte `0x00`/`0x01` payload. */
  setDtr(value: boolean): Promise<void>;
  /** Sends a `SET_RTS` frame with a one-byte `0x00`/`0x01` payload. */
  setRts(value: boolean): Promise<void>;
}

export interface MbregistryStreamOptions {
  /** An already-`connect()`ed {@link MbregistryClient} (ticket 001). */
  client: MbregistryClient;
  /** `serial` for a direct board session, `relay` for a relay board —
   * defaults to `"serial"`. */
  kind?: Extract<LockKind, "serial" | "relay">;
  /** This console's own identity (instance name / `"robot-console"`),
   * sent as `lock`'s own `label` — display-only, per `registry-api.md`.
   */
  label?: string;
  /** Test seam: replaces `Date.now`, so a stale-lock test never waits on
   * a real clock. Defaults to `Date.now`. */
  now?: () => number;
  /** Test seam: overrides {@link DEFAULT_STALE_LOCK_AFTER_S}. */
  staleAfterS?: number;
}

function abortReason(signal: AbortSignal): Error {
  const reason = (signal as { reason?: unknown }).reason;
  return reason instanceof Error ? reason : new Error(String(reason ?? "aborted"));
}

/** Builds the "in use[ by <label>][, stale — ...]" message SUC-005/
 * SUC-006 specify, from a `locked` response's own `holder` (absent
 * entirely for a registry too old to send one at all). */
function formatLockedMessage(
  device: MbregistryStreamDevice,
  holder: LockHolder | undefined,
  now: () => number,
  staleAfterS: number,
): string {
  const label = holder?.label;
  if (label === null || label === undefined) {
    return "in use";
  }
  let message = `in use by ${label}`;
  const since = holder?.since;
  if (since !== null && since !== undefined && now() / 1000 - since >= staleAfterS) {
    const owningHost = holder?.host ?? device.host ?? "this host";
    message += ` -- stale; run \`mbregistry unlock --force ${device.uid}\` on ${owningHost}`;
  }
  return message;
}

class MbregistryByteStream implements MbregistryResettableStream {
  private readonly reassembler = new FrameReassembler();
  private readonly dataListeners: Array<(chunk: Buffer | string) => void> = [];
  private readonly errorListeners: Array<(err: Error) => void> = [];
  private readonly closeListeners: Array<() => void> = [];
  private socket: net.Socket | undefined;
  private unlockAndCloseFn: (() => void) | undefined;
  private closed = false;

  constructor(
    private readonly device: MbregistryStreamDevice,
    private readonly client: MbregistryClient,
    private readonly kind: Extract<LockKind, "serial" | "relay">,
    private readonly label: string | undefined,
    private readonly now: () => number,
    private readonly staleAfterS: number,
  ) {}

  open(signal: AbortSignal): Promise<void> {
    if (signal.aborted) {
      return Promise.reject(abortReason(signal));
    }

    const target = resolveStreamTarget(this.device);
    const streamPromise = this.client.stream(this.device.uid, this.kind, target, this.label);

    return new Promise((resolve, reject) => {
      let settled = false;
      const onAbort = () => {
        if (settled) {
          return;
        }
        settled = true;
        reject(abortReason(signal));
        // The handshake may still be in flight -- if it lands after all,
        // release the lock it just took rather than leaving it dangling.
        streamPromise.then((result) => result.unlockAndClose()).catch(() => {});
      };
      signal.addEventListener("abort", onAbort, { once: true });

      streamPromise.then(
        (result) => {
          if (settled) {
            return;
          }
          settled = true;
          signal.removeEventListener("abort", onAbort);
          this.attach(result);
          resolve();
        },
        (err: unknown) => {
          if (settled) {
            return;
          }
          settled = true;
          signal.removeEventListener("abort", onAbort);
          reject(this.translateError(err));
        },
      );
    });
  }

  private translateError(err: unknown): Error {
    if (err instanceof MbregistryError && err.code === "locked") {
      const holder = (err.details as { holder?: LockHolder } | undefined)?.holder;
      return new Error(formatLockedMessage(this.device, holder, this.now, this.staleAfterS));
    }
    return err instanceof Error ? err : new Error(String(err));
  }

  private attach(result: { socket: net.Socket; unlockAndClose: () => void; leftover: Buffer }): void {
    this.socket = result.socket;
    this.unlockAndCloseFn = result.unlockAndClose;
    result.socket.on("data", (chunk: Buffer) => this.handleData(chunk));
    result.socket.on("error", (err: Error) => this.emitError(err));
    result.socket.on("close", () => this.handleSocketClose());
    // Bytes that arrived in the same chunk as `stream`'s own ack line --
    // see `client.ts`'s `performStreamHandshake` doc comment. Fed through
    // the exact same decode path as any later "data" event, before this
    // method returns, so nothing else can interleave ahead of it.
    if (result.leftover.length > 0) {
      this.handleData(result.leftover);
    }
  }

  private handleData(chunk: Buffer): void {
    let frames;
    try {
      frames = this.reassembler.push(chunk);
    } catch (err) {
      this.emitError(err as Error);
      this.socket?.destroy();
      return;
    }
    for (const frame of frames) {
      if (frame.type === FRAME_DATA) {
        for (const listener of this.dataListeners) {
          listener(frame.payload);
        }
      }
      // CLOSE is observed via the socket's own "close" event, not acted
      // on here. BREAK/SET_DTR/SET_RTS are client -> server only
      // (registry-api.md); an unrecognized type byte from the server is
      // a well-formed frame this adapter simply has no use for -- not a
      // decode error, per stream_frame.py's own contract -- so it is
      // silently ignored rather than treated as fatal.
    }
  }

  private handleSocketClose(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    try {
      this.reassembler.end();
    } catch (err) {
      this.emitError(err as Error);
    }
    for (const listener of this.closeListeners) {
      listener();
    }
  }

  private emitError(err: Error): void {
    for (const listener of this.errorListeners) {
      listener(err);
    }
  }

  write(bytes: string, callback: (err?: Error | null) => void): void {
    if (!this.socket) {
      callback(new Error("mbregistryStream: write() called before open() resolved"));
      return;
    }
    this.socket.write(encodeFrame(FRAME_DATA, Buffer.from(bytes, "utf8")), callback);
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
    const socket = this.socket;
    if (!socket || this.closed) {
      return Promise.resolve();
    }
    // Best-effort -- a server that has already gone away never gets this
    // CLOSE frame, but unlockAndClose() below still tears the connection
    // down and releases the lock either way.
    socket.write(encodeFrame(FRAME_CLOSE), () => {});
    this.unlockAndCloseFn?.();
    return Promise.resolve();
  }

  private sendControlFrame(type: number, payload?: Buffer): Promise<void> {
    const socket = this.socket;
    if (!socket) {
      return Promise.reject(new Error("mbregistryStream: called before open() resolved"));
    }
    return new Promise((resolve, reject) => {
      socket.write(encodeFrame(type, payload), (err) => (err ? reject(err) : resolve()));
    });
  }

  sendBreak(): Promise<void> {
    return this.sendControlFrame(FRAME_BREAK);
  }

  setDtr(value: boolean): Promise<void> {
    return this.sendControlFrame(FRAME_SET_DTR, Buffer.from([value ? 1 : 0]));
  }

  setRts(value: boolean): Promise<void> {
    return this.sendControlFrame(FRAME_SET_RTS, Buffer.from([value ? 1 : 0]));
  }
}

/** Builds a {@link MbregistryResettableStream} (a {@link ByteStream}
 * plus `sendBreak`/`setDtr`/`setRts`) for `device`, backed by an
 * mbregistry `lock` + `stream` session over `options.client` — see the
 * module doc comment. */
export function mbregistryStream(device: MbregistryStreamDevice, options: MbregistryStreamOptions): MbregistryResettableStream {
  return new MbregistryByteStream(
    device,
    options.client,
    options.kind ?? "serial",
    options.label,
    options.now ?? Date.now,
    options.staleAfterS ?? DEFAULT_STALE_LOCK_AFTER_S,
  );
}
