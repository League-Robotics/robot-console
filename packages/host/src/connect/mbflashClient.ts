/**
 * mbflashClient.ts — a TCP client for the mbdeploy `_mbflash._tcp` flash
 * service (ticket 018-014; `Busboombot/mbdeploy`'s `src/mbdeploy/remote.py`
 * `deploy_over_network` / `server.py` `serve_flash`, the wire protocol
 * this module speaks). Farm robots (`vevov` on `hodr`, `gopiv` on `loki`,
 * `tigez` on `magni`, per the stakeholder's own bench note) have no USB
 * link from this Mac at all, so `flash.ts`'s DAPLink/MSD paths can never
 * reach them — this module is the alternative transport `server.ts`
 * routes a `flash-start` to when the target link is `mbserial`/`wifi`
 * rather than `usb` (see that module's `runFlashTask`).
 *
 * ## The wire protocol
 *
 * One TCP connection, line-framed control messages plus one raw binary
 * payload in the middle:
 *
 *   1. Connect to the service's own `host:port` (from the `services`
 *      table's current `_mbflash._tcp` row — `store/index.ts`'s
 *      `findCurrentMbflashService`).
 *   2. Send `FLASH <nbytes> sha256=<hex>\n` (`nbytes`/`sha256` describe
 *      the hex bytes about to be sent, sha256 computed over the exact
 *      same buffer as `nbytes`).
 *   3. Read one line. `OK send` means "go ahead, send the bytes now";
 *      an `ERR ...` line here (e.g. `ERR busy`) means this attempt is
 *      refused before anything is written.
 *   4. Send the raw hex bytes (`nbytes` of them, no framing).
 *   5. Read lines: `LOG <text>` (progress; call `onProgress` and keep
 *      reading) until a terminal `OK flashed` (success) or `ERR ...`
 *      line (`classifyErrLine`, below, for the documented reasons).
 *
 * `mbflashInfo` speaks the same connection's read-only sibling command
 * (`INFO\n` → `OK {json}`) — used only for identification/diagnostics,
 * never by `server.ts`'s own flash routing (device identity for the
 * capability/routing match comes from the `services` table's TXT `uid`
 * instead — see `findCurrentMbflashService`). Manually verified against
 * a real farm board (`tigez` on `magni.local`, 2026-09-13): `OK
 * {"uid": "...", "board_name": "tigez", "role": "NEZHA2", "port":
 * "/dev/ttyACM0", "connected": true}`.
 *
 * ## Timeouts and the one retry
 *
 * Every line read (`OK send`, each `LOG`/terminal line, and the `INFO`
 * reply) is bounded by {@link DEFAULT_MBFLASH_LINE_TIMEOUT_MS}, and the
 * initial TCP connect by {@link DEFAULT_MBFLASH_CONNECT_TIMEOUT_MS} —
 * `withTimeout` (`lib/withTimeout.ts`, the same helper `flash.ts` uses
 * for its own DAPLink/HID calls) is what enforces both. Known risk
 * (`pxt-nezha-diffdrive` `docs/knowledge/2026-09-02-wifi-transport-tovez.md`):
 * a probe timeout mid-flash can leave the board with no firmware; an
 * immediate retry has always succeeded on the bench. {@link
 * flashOverMbflash} (the only exported entry point `server.ts` calls for
 * an actual flash) automates exactly that: any attempt that fails with
 * `reason: "timeout"` is retried once, and only once — a second timeout
 * is reported with the known "board may be left without firmware" note
 * folded into the failure text, per this ticket's own acceptance
 * criterion. Every other failure reason (a documented `ERR` line, a
 * connection refusal, a malformed reply) is reported on the first
 * attempt with no retry — retrying a definite, already-classified
 * refusal would not change the outcome.
 *
 * ## `.local` hostnames get the same IPv4-first treatment as `tcpStream.ts`
 *
 * `link/adapters/tcpStream.ts`'s own doc comment (018-007) documents a
 * real, confirmed hang: `net.connect`-by-`.local`-hostname on macOS can
 * stall for seconds past any reasonable connect budget, or resolve to a
 * dead/unscoped IPv6 link-local address, before ever trying IPv4. Every
 * farm host this module dials (`hodr.local`, `loki.local`,
 * `magni.local`) is exactly that kind of hostname, so this module
 * applies the identical fix: a bounded `dns.lookup(host, {family: 4})`
 * before ever calling `net.connect`, skipped entirely when `host` is
 * already a dotted-quad IPv4 literal (the common case in this module's
 * own test suite, which dials a real loopback `net.createServer`).
 *
 * ## Failure is a value, not an exception
 *
 * Mirrors `flash.ts`/`releases.ts`'s own convention: {@link
 * flashOverMbflash} and {@link mbflashInfo} always resolve, never
 * reject — a caller (`server.ts`) reports a precise, plain-worded reason
 * rather than catching an uncaught rejection.
 */
import { connect as netConnect, type Socket } from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";
import { createHash } from "node:crypto";
import { TimeoutError, withTimeout } from "../lib/withTimeout.js";

/** Where the flash service lives -- host/port exactly as stored on the
 * matching `_mbflash._tcp` `services` row (`store/index.ts`'s
 * `ProjectionServiceRow`). */
export interface MbflashTarget {
  host: string;
  port: number;
}

/** Every distinguishable failure reason this module's own protocol
 * reading can classify -- the first six are the documented `ERR ...`
 * lines (module doc comment's "The wire protocol" section); `"timeout"`
 * and `"connection"` are this module's own transport-level failures;
 * `"protocol"` is the fallback for a reply this module cannot make
 * sense of at all (an unrecognized `ERR` line, or any other unexpected
 * line where one of the three documented replies was expected). */
export type MbflashFailureReason =
  | "busy"
  | "relay-refused"
  | "flash-disabled"
  | "sha-mismatch"
  | "short-payload"
  | "auth-required"
  | "timeout"
  | "connection"
  | "protocol";

export interface MbflashSuccess {
  status: "ok";
}

export interface MbflashFailure {
  status: "error";
  reason: MbflashFailureReason;
  /** Plain-worded, safe to show a stakeholder as-is -- ticket 018-014's
   * own requirement. Never a stack trace, never a raw caught `error`
   * object. */
  error: string;
}

export type MbflashOutcome = MbflashSuccess | MbflashFailure;

/** The minimal socket shape this module actually uses -- mirrors
 * `link/adapters/tcpStream.ts`'s own `TcpSocketLike` seam so a fake (or
 * a real loopback `net.createServer`, this module's own test suite's
 * actual choice, matching `mbserialEndToEnd.test.ts`'s precedent) can
 * stand in without a real farm board. */
export interface MbflashSocketLike {
  on(event: "data", listener: (chunk: Buffer) => void): void;
  once(event: "connect", listener: () => void): void;
  once(event: "error", listener: (err: Error) => void): void;
  once(event: "close", listener: () => void): void;
  write(data: Buffer, callback?: (err?: Error | null) => void): boolean;
  setNoDelay(noDelay?: boolean): void;
  destroy(error?: Error): void;
}

/** Injectable `dns.lookup(hostname, {family: 4})` shape -- same contract
 * as `tcpStream.ts`'s own (private) `Ipv4Lookup`, redeclared here rather
 * than imported since that type isn't exported and this is a small,
 * self-contained seam, not a shared dependency. */
export type MbflashIpv4Lookup = (
  hostname: string,
  options: { family: 4 },
) => Promise<{ address: string; family: number }>;

export interface MbflashOptions {
  /** Bound on the initial TCP connect (including any IPv4 resolution it
   * needs first). Defaults to {@link DEFAULT_MBFLASH_CONNECT_TIMEOUT_MS}. */
  connectTimeoutMs?: number;
  /** Bound on every line read (`OK send`, each `LOG`/terminal line, the
   * `INFO` reply). Protocol doc comment's own "~30-90s" range; defaults
   * to {@link DEFAULT_MBFLASH_LINE_TIMEOUT_MS}. */
  lineTimeoutMs?: number;
  /** Bound on the `dns.lookup(host, {family: 4})` fallback, when `host`
   * is not already a dotted-quad IPv4 literal. Defaults to
   * {@link DEFAULT_MBFLASH_DNS_LOOKUP_TIMEOUT_MS}. */
  dnsLookupTimeoutMs?: number;
  /** Injectable `dns.lookup`. Defaults to `node:dns/promises`'s own. */
  lookup?: MbflashIpv4Lookup;
  /** Full override of this module's own connect step. Tests normally
   * don't need this (a real loopback `net.createServer` plus the real
   * default dial is simpler and closer to production — this module's
   * own suite's actual choice); provided purely as an escape hatch. */
  dial?: (host: string, port: number) => Promise<MbflashSocketLike>;
}

export const DEFAULT_MBFLASH_CONNECT_TIMEOUT_MS = 5_000;
export const DEFAULT_MBFLASH_LINE_TIMEOUT_MS = 60_000;
export const DEFAULT_MBFLASH_DNS_LOOKUP_TIMEOUT_MS = 2_000;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const IPV4_LITERAL_PATTERN = /^\d{1,3}(\.\d{1,3}){3}$/;

/** Resolves `host` to an address `net.connect` can dial directly and
 * connects, bounded by `deps.connectTimeoutMs` end to end (resolution
 * included) -- see the module doc comment's own ".local hostnames"
 * section. The socket is destroyed before this rejects on any failure
 * (connect error or timeout), never left half-open for the caller to
 * clean up. */
async function defaultDial(
  host: string,
  port: number,
  deps: { lookup: MbflashIpv4Lookup; dnsLookupTimeoutMs: number; connectTimeoutMs: number },
): Promise<MbflashSocketLike> {
  const address = IPV4_LITERAL_PATTERN.test(host)
    ? host
    : (await withTimeout(deps.lookup(host, { family: 4 }), deps.dnsLookupTimeoutMs, `dns.lookup(${host})`)).address;

  const socket: Socket = netConnect({ host: address, port });
  try {
    await withTimeout(
      new Promise<void>((resolve, reject) => {
        let settled = false;
        socket.once("connect", () => {
          if (settled) return;
          settled = true;
          resolve();
        });
        socket.once("error", (err) => {
          if (settled) return;
          settled = true;
          reject(err);
        });
      }),
      deps.connectTimeoutMs,
      `mbflash connect ${address}:${port}`,
    );
  } catch (error) {
    socket.destroy();
    throw error;
  }
  socket.setNoDelay(true);
  return socket as unknown as MbflashSocketLike;
}

/** Buffers incoming bytes into `\n`-terminated lines and hands them out
 * one at a time via {@link nextLine}, bridging the socket's own
 * event-based `data`/`close` into a simple pull API the protocol
 * functions below can `await` in a straight line. A trailing `\r` (if
 * present) is stripped, tolerant of either line ending. */
class MbflashLineChannel {
  private buffer = "";
  private readonly waiters: Array<{ resolve: (line: string) => void; reject: (err: Error) => void }> = [];
  private failure: Error | undefined;

  constructor(socket: MbflashSocketLike) {
    socket.on("data", (chunk) => {
      this.buffer += chunk.toString("utf-8");
      this.drain();
    });
    socket.once("close", () => {
      this.fail(this.failure ?? new Error("mbflash: connection closed before a reply line arrived"));
    });
  }

  private drain(): void {
    while (this.waiters.length > 0) {
      const idx = this.buffer.indexOf("\n");
      if (idx === -1) {
        return;
      }
      const line = this.buffer.slice(0, idx).replace(/\r$/, "");
      this.buffer = this.buffer.slice(idx + 1);
      this.waiters.shift()?.resolve(line);
    }
  }

  /** Rejects every currently-pending (and any future) {@link nextLine}
   * call with `error` -- called on a socket `error`/`close` event. */
  fail(error: Error): void {
    this.failure = error;
    const pending = this.waiters.splice(0, this.waiters.length);
    for (const waiter of pending) {
      waiter.reject(error);
    }
  }

  nextLine(): Promise<string> {
    if (this.failure) {
      return Promise.reject(this.failure);
    }
    const idx = this.buffer.indexOf("\n");
    if (idx !== -1) {
      const line = this.buffer.slice(0, idx).replace(/\r$/, "");
      this.buffer = this.buffer.slice(idx + 1);
      return Promise.resolve(line);
    }
    return new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }
}

function writeAll(socket: MbflashSocketLike, data: string | Buffer): Promise<void> {
  const buf = typeof data === "string" ? Buffer.from(data, "utf-8") : data;
  return new Promise((resolve, reject) => {
    socket.write(buf, (err) => (err ? reject(err) : resolve()));
  });
}

/** Classifies one `ERR ...` line into the documented reason it names
 * (module doc comment's "The wire protocol" section), or `"protocol"`
 * for any `ERR` text this module does not recognize -- matched
 * leniently (case-insensitively, `ERR` prefix stripped and trimmed)
 * rather than one exact-string comparison per reason, since the daemon
 * is not this codebase's own and its exact casing/whitespace is not
 * independently guaranteed. */
function classifyErrLine(line: string): { reason: MbflashFailureReason; error: string } {
  const rest = line.replace(/^ERR\s*/i, "").trim();
  const lower = rest.toLowerCase();
  if (lower === "busy") {
    return {
      reason: "busy",
      error: `mbflash reported "${line}" -- another client already holds this board's flash service`,
    };
  }
  if (lower.startsWith("relay refused")) {
    return { reason: "relay-refused", error: `mbflash reported "${line}"` };
  }
  if (lower === "flash disabled") {
    return {
      reason: "flash-disabled",
      error: `mbflash reported "${line}" -- flashing is disabled on this board's mbdeploy daemon`,
    };
  }
  if (lower.includes("sha256 mismatch")) {
    return { reason: "sha-mismatch", error: `mbflash reported "${line}"` };
  }
  if (lower === "short payload") {
    return {
      reason: "short-payload",
      error: `mbflash reported "${line}" -- fewer bytes arrived than the FLASH command declared`,
    };
  }
  if (lower === "auth required") {
    return {
      reason: "auth-required",
      error: `mbflash reported "${line}" -- this board's flash service requires authentication this client does not send`,
    };
  }
  return { reason: "protocol", error: `mbflash reported an unrecognized error: "${line}"` };
}

interface ResolvedMbflashDeps {
  dial: (host: string, port: number) => Promise<MbflashSocketLike>;
  lineTimeoutMs: number;
}

function resolveDeps(options: MbflashOptions): ResolvedMbflashDeps {
  const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_MBFLASH_CONNECT_TIMEOUT_MS;
  const lineTimeoutMs = options.lineTimeoutMs ?? DEFAULT_MBFLASH_LINE_TIMEOUT_MS;
  const dnsLookupTimeoutMs = options.dnsLookupTimeoutMs ?? DEFAULT_MBFLASH_DNS_LOOKUP_TIMEOUT_MS;
  const lookup = options.lookup ?? dnsLookup;
  const dial = options.dial ?? ((host, port) => defaultDial(host, port, { lookup, dnsLookupTimeoutMs, connectTimeoutMs }));
  return { dial, lineTimeoutMs };
}

/** One full connect-`FLASH`-send-bytes-read-until-terminal attempt --
 * see the module doc comment's "The wire protocol" section. Never
 * throws: every failure (a classified `ERR` line, a malformed/
 * unexpected reply, a connect/read timeout, or a transport-level
 * connection error) comes back as a {@link MbflashOutcome}. The socket
 * is always destroyed before this resolves, whichever way the attempt
 * ends. */
async function attemptFlashOnce(
  target: MbflashTarget,
  hexBytes: Buffer,
  sha256Hex: string,
  onProgress: (logText: string) => void,
  deps: ResolvedMbflashDeps,
): Promise<MbflashOutcome> {
  let socket: MbflashSocketLike | undefined;
  try {
    socket = await deps.dial(target.host, target.port);
    const channel = new MbflashLineChannel(socket);
    socket.once("error", (err) => channel.fail(err));

    await writeAll(socket, `FLASH ${hexBytes.length} sha256=${sha256Hex}\n`);
    const firstLine = await withTimeout(channel.nextLine(), deps.lineTimeoutMs, "mbflash FLASH reply");
    if (firstLine !== "OK send") {
      if (/^ERR/i.test(firstLine)) {
        return { status: "error", ...classifyErrLine(firstLine) };
      }
      return { status: "error", reason: "protocol", error: `unexpected reply to FLASH: "${firstLine}"` };
    }

    await writeAll(socket, hexBytes);

    for (;;) {
      const line = await withTimeout(channel.nextLine(), deps.lineTimeoutMs, "mbflash flash progress");
      if (line.startsWith("LOG")) {
        onProgress(line);
        continue;
      }
      if (line === "OK flashed") {
        return { status: "ok" };
      }
      if (/^ERR/i.test(line)) {
        return { status: "error", ...classifyErrLine(line) };
      }
      return { status: "error", reason: "protocol", error: `unexpected line during flash: "${line}"` };
    }
  } catch (error) {
    if (error instanceof TimeoutError) {
      return { status: "error", reason: "timeout", error: error.message };
    }
    return { status: "error", reason: "connection", error: `mbflash: ${errorMessage(error)}` };
  } finally {
    socket?.destroy();
  }
}

/**
 * Flash `hexBytes` (already fetched/verified — `releases.ts`'s
 * `fetchAndVerifyHex`, exactly as the USB path does; this module never
 * fetches or validates a hex itself) onto the board at `target` over its
 * mbdeploy `_mbflash._tcp` service. `onProgress` is called once per
 * `LOG` line seen while the flash is in progress — `server.ts` uses this
 * to keep `flash-progress`'s phase at `"writing"`.
 *
 * One retry on a mid-flash timeout, per the module doc comment's own
 * "Timeouts and the one retry" section: a first attempt that fails with
 * `reason: "timeout"` is retried once (`onProgress` may fire again
 * during the retry); if the retry also fails, the returned error folds
 * in the known "board may be left without firmware" risk note. Any
 * other failure reason is returned immediately, no retry. Never throws.
 */
export async function flashOverMbflash(
  target: MbflashTarget,
  hexBytes: Buffer,
  onProgress: (logText: string) => void,
  options: MbflashOptions = {},
): Promise<MbflashOutcome> {
  const sha256Hex = createHash("sha256").update(hexBytes).digest("hex");
  const deps = resolveDeps(options);

  const first = await attemptFlashOnce(target, hexBytes, sha256Hex, onProgress, deps);
  if (first.status === "ok" || first.reason !== "timeout") {
    return first;
  }

  const retry = await attemptFlashOnce(target, hexBytes, sha256Hex, onProgress, deps);
  if (retry.status === "ok") {
    return retry;
  }
  return {
    status: "error",
    reason: "timeout",
    error:
      `${retry.error} -- retried once after the first attempt also timed out; a probe timeout mid-flash ` +
      "can leave the board without firmware, so retry once more by hand and check it identifies afterward",
  };
}

/**
 * `INFO\n` -> `OK {json}` -- read-only board identification, per the
 * module doc comment's own protocol section. Not used by `server.ts`'s
 * flash routing (which identifies a device's flash service via the
 * `services` table's TXT `uid` instead); exposed for diagnostics and
 * for this module's own test suite to exercise the full documented
 * protocol, not only the `FLASH` path. Never throws.
 */
export async function mbflashInfo(
  target: MbflashTarget,
  options: MbflashOptions = {},
): Promise<{ ok: true; info: unknown } | { ok: false; error: string }> {
  const deps = resolveDeps(options);
  let socket: MbflashSocketLike | undefined;
  try {
    socket = await deps.dial(target.host, target.port);
    const channel = new MbflashLineChannel(socket);
    socket.once("error", (err) => channel.fail(err));

    await writeAll(socket, "INFO\n");
    const line = await withTimeout(channel.nextLine(), deps.lineTimeoutMs, "mbflash INFO reply");
    if (!line.startsWith("OK ")) {
      return { ok: false, error: `unexpected INFO reply: "${line}"` };
    }
    const jsonText = line.slice("OK ".length);
    try {
      return { ok: true, info: JSON.parse(jsonText) as unknown };
    } catch (error) {
      return { ok: false, error: `INFO reply was not valid JSON: ${errorMessage(error)}` };
    }
  } catch (error) {
    if (error instanceof TimeoutError) {
      return { ok: false, error: error.message };
    }
    return { ok: false, error: `mbflash: ${errorMessage(error)}` };
  } finally {
    socket?.destroy();
  }
}
