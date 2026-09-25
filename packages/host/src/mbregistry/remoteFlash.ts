/**
 * remoteFlash.ts — `flashViaMbregistry`: drives one mbregistry
 * connection's `lock`(`flash`)/`send_hex`/`flash` exchange to
 * completion and resolves a {@link FlashOutcome} (sprint 018 ticket 005;
 * `docs/design/registry-api.md` §"Remote flash and hex staging"; this
 * sprint's SUC-008). Sibling to `client.ts`, but deliberately its own
 * small, one-shot connection rather than a new {@link MbregistryClient}
 * method: `send_hex`/`flash` are remote-TCP-only ops (never the local
 * Unix socket/pipe `client.ts` otherwise prefers), and this module's own
 * connection is used exactly once, for exactly this exchange, then
 * closed — nothing else about it is shared with the client's own
 * long-lived control connection.
 *
 * ## Boundary
 *
 * This module owns the wire protocol and its own TCP connection only —
 * it never decides *which* board/target to flash (`connect/flasher.ts`'s
 * `flashMbregistry` and, above that, `server.ts#runFlashTask` decide
 * that, via `link/adapters/mbregistryStream.ts`'s `resolveFlashTarget`)
 * and never touches `board_owner`/`store` directly (mbregistry's own
 * `flash`-kind lock is the sole exclusivity for this transport, per
 * `connect/connector.ts`'s `resolveExclusivity`'s `Exclusivity.kind:
 * "none"` for `"mbregistry"`).
 *
 * ## Wire choreography
 *
 * One connection, three requests in order:
 *
 * 1. `{"op": "lock", "uid": ..., "kind": "flash", "label"?: ...}`. A
 *    `{"ok": false, "code": "locked", "holder": {...}}` response becomes
 *    a classified `FlashFailure` (`reason: "owner-unavailable"`) whose
 *    message names `holder.label` when present, else the plain "in
 *    use" — mirrors `mbregistryStream.ts`'s own degrade-gracefully rule
 *    for a registry predating mbtools 008-002 (no staleness hint here,
 *    unlike that module: this is a one-shot flash attempt, not a
 *    long-lived session a stale-lock `unlock --force` hint would help
 *    with). Any other lock failure maps to `reason: "flash-failed"`.
 * 2. `{"op": "send_hex", "data": "<base64 hexText>"}` → `hex_path`.
 * 3. `{"op": "flash", "uid": ..., "hex_path": ...}`: zero or more
 *    streamed `{"type": "log", "line": ...}` lines, each mapped to a
 *    {@link FlashPhase} via {@link classifyLogPhase} (a coarse,
 *    best-effort substring classifier — exactly as coarse as `flash.ts`'s
 *    own dapjs-path phase reporting already is) and forwarded through
 *    `onProgress`, then exactly one terminal
 *    `{"type": "result", "ok": ..., "success": ..., "exit_code": ...,
 *    "error": ...}`, mapped to the returned {@link FlashOutcome}.
 *
 * The connection is closed once the terminal line arrives (or on any
 * failure) — mbregistry releases the `flash`-kind lock unconditionally
 * on its own once the attempt concludes (`registry-api.md`: "same
 * 'always release, this is what triggers re-probe' guarantee as the
 * local `flash` op"), so no separate `unlock` call is ever made here.
 *
 * ## Post-flash re-identify: nothing to do here, by design
 *
 * Once this connection closes, the freshly-rebooted board reappears
 * through `mbregistryWatcher`'s own `attach`/`identity` `watch` events
 * and the reconciler's existing automatic-connect pass picks it back
 * up — exactly mirroring `flash.ts`'s own "no special reidentify" note
 * for the USB path, just sourced from mbregistry's watch stream instead
 * of USB re-enumeration. Flagged here, in a doc comment rather than
 * code, precisely so it is not later "discovered" as a missing step.
 *
 * ## Failure is a value, never a thrown/rejected promise
 *
 * Matches `flash.ts`'s own convention: every failure this module can
 * classify (a connect failure, a lock/send_hex/flash wire failure, an
 * unexpected disconnect mid-exchange) resolves to a classified
 * {@link FlashOutcome}, never throws.
 */
import * as net from "node:net";
import { LineReassembler } from "../link/lineStream.js";
import type { FlashOutcome, FlashPhase } from "../flash.js";

/** Where `send_hex`/`flash` are sent — always a concrete TCP endpoint,
 * resolved by the caller (`link/adapters/mbregistryStream.ts`'s
 * `resolveFlashTarget`) before this module is ever invoked; see the
 * module doc comment. */
export interface RemoteFlashTarget {
  host: string;
  port: number;
}

/** Injectable in place of `net.connect`, mirroring `client.ts`'s own
 * `ConnectFn` convention — production code never overrides this; tests
 * substitute a fake TCP server on `127.0.0.1` (per this sprint's Test
 * Strategy: no real mbregistry anywhere in this suite). */
export type RemoteFlashConnectFn = (target: RemoteFlashTarget) => net.Socket;

function defaultConnect(target: RemoteFlashTarget): net.Socket {
  return net.connect({ host: target.host, port: target.port });
}

export interface RemoteFlashDeps {
  connect?: RemoteFlashConnectFn;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function flashFailure(error: string): FlashOutcome {
  return { status: "error", method: "mbregistry", reason: "flash-failed", error };
}

function ownerUnavailable(error: string): FlashOutcome {
  return { status: "error", method: "mbregistry", reason: "owner-unavailable", error };
}

/** Builds the "in use[ by <label>]" message a `locked` `lock` response
 * maps to — see the module doc comment's point 1. `holder` is `undefined`
 * for a registry too old to send one at all, same as
 * `mbregistryStream.ts`'s own `formatLockedMessage`. */
function formatLockedMessage(holder: { label?: unknown } | undefined): string {
  const label = holder?.label;
  return label === null || label === undefined || label === "" ? "in use" : `in use by ${String(label)}`;
}

/** Classifies one `flash` op's streamed log line into a {@link
 * FlashPhase} — a coarse, best-effort substring match (module doc
 * comment's point 3): `"eras*"` → `"erasing"`, `"program"`/`"writ*"` →
 * `"writing"`, `"reset*"` → `"resetting"`, anything else → `"writing"`
 * (the most common/longest-running phase, and the same default a
 * classifier with no better signal should fall back to). */
export function classifyLogPhase(line: string): FlashPhase {
  const lower = line.toLowerCase();
  if (lower.includes("eras")) {
    return "erasing";
  }
  if (lower.includes("program") || lower.includes("writ")) {
    return "writing";
  }
  if (lower.includes("reset")) {
    return "resetting";
  }
  return "writing";
}

/** Opens one raw TCP socket to `target`, resolving once connected. */
function openSocket(target: RemoteFlashTarget, connect: RemoteFlashConnectFn): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const socket = connect(target);
    const onError = (err: Error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(err);
    };
    const onConnect = () => {
      if (settled) return;
      settled = true;
      socket.off("error", onError);
      resolve(socket);
    };
    socket.once("error", onError);
    socket.once("connect", onConnect);
  });
}

/** A tiny newline-JSON line reader over one socket — every request this
 * module sends gets exactly one response line for `lock`/`send_hex`,
 * and zero-or-more `log` lines then one terminal `result` line for
 * `flash` (module doc comment's own choreography); {@link nextLine}
 * reads them one at a time, in order, which this exchange's own strict
 * request-then-response(es) shape never needs anything more concurrent
 * than. */
class FlashWire {
  private readonly reassembler = new LineReassembler();
  private readonly lineQueue: string[] = [];
  private readonly waiters: Array<{ resolve: (line: string) => void; reject: (err: Error) => void }> = [];
  private closed = false;
  private closeError: Error | undefined;

  constructor(private readonly socket: net.Socket) {
    socket.on("data", (chunk: Buffer) => {
      for (const line of this.reassembler.push(chunk)) {
        if (line.trim().length === 0) {
          continue;
        }
        const waiter = this.waiters.shift();
        if (waiter) {
          waiter.resolve(line);
        } else {
          this.lineQueue.push(line);
        }
      }
    });
    socket.on("close", () => this.handleClose());
    socket.on("error", (err: Error) => this.handleClose(err));
  }

  private handleClose(err?: Error): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.closeError = err;
    const closeErr = err ?? new Error("mbregistry connection closed before the flash exchange finished");
    for (const waiter of this.waiters.splice(0)) {
      waiter.reject(closeErr);
    }
  }

  nextLine(): Promise<string> {
    const queued = this.lineQueue.shift();
    if (queued !== undefined) {
      return Promise.resolve(queued);
    }
    if (this.closed) {
      return Promise.reject(this.closeError ?? new Error("mbregistry connection closed before the flash exchange finished"));
    }
    return new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }

  write(op: Record<string, unknown>): void {
    this.socket.write(JSON.stringify(op) + "\n");
  }

  close(): void {
    this.socket.end();
  }
}

/**
 * Drives `lock`(`flash`)/`send_hex`/`flash` against `target` for `uid`
 * to completion — see the module doc comment for the full wire
 * choreography and failure classification. Never throws/rejects; every
 * failure resolves to a classified {@link FlashOutcome}.
 */
export async function flashViaMbregistry(
  target: RemoteFlashTarget,
  uid: string,
  label: string | undefined,
  hexText: string,
  onProgress: (phase: FlashPhase) => void,
  deps: RemoteFlashDeps = {},
): Promise<FlashOutcome> {
  const connect = deps.connect ?? defaultConnect;

  let socket: net.Socket;
  try {
    socket = await openSocket(target, connect);
  } catch (err) {
    return flashFailure(`could not connect to mbregistry at ${target.host}:${target.port}: ${errorMessage(err)}`);
  }

  const wire = new FlashWire(socket);
  try {
    const lockOp: Record<string, unknown> = { op: "lock", uid, kind: "flash" };
    if (label !== undefined) {
      lockOp.label = label;
    }
    wire.write(lockOp);
    const lockResponse = JSON.parse(await wire.nextLine()) as Record<string, unknown>;
    if (lockResponse.ok !== true) {
      if (lockResponse.code === "locked") {
        return ownerUnavailable(formatLockedMessage(lockResponse.holder as { label?: unknown } | undefined));
      }
      return flashFailure(String(lockResponse.error ?? `mbregistry refused to lock "${uid}" for flashing`));
    }

    wire.write({ op: "send_hex", data: Buffer.from(hexText, "utf8").toString("base64") });
    const sendHexResponse = JSON.parse(await wire.nextLine()) as Record<string, unknown>;
    if (sendHexResponse.ok !== true) {
      return flashFailure(String(sendHexResponse.error ?? "mbregistry rejected send_hex"));
    }
    const hexPath = sendHexResponse.hex_path;
    if (typeof hexPath !== "string") {
      return flashFailure('mbregistry\'s send_hex response is missing a string "hex_path"');
    }

    wire.write({ op: "flash", uid, hex_path: hexPath });
    for (;;) {
      const parsed = JSON.parse(await wire.nextLine()) as Record<string, unknown>;
      if (parsed.type === "log") {
        onProgress(classifyLogPhase(String(parsed.line ?? "")));
        continue;
      }
      if (parsed.type === "result") {
        if (parsed.ok === false || parsed.success === false) {
          return flashFailure(String(parsed.error ?? "mbregistry flash failed"));
        }
        return { status: "ok", method: "mbregistry" };
      }
      // An unrecognized streamed shape is well-formed JSON this module
      // simply has no use for -- not a decode error -- so it is
      // silently ignored rather than treated as fatal, mirroring
      // `mbregistryStream.ts`'s own "unrecognized frame type" handling.
    }
  } catch (err) {
    return flashFailure(errorMessage(err));
  } finally {
    wire.close();
  }
}
