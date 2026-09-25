/**
 * client.ts — `mbregistryClient`: a JSON-lines client for `mbregistry`
 * (the mbtools device-registry daemon) over a Unix domain socket, a
 * Windows named pipe, or a TCP connection, plus the resolution/spawn
 * fallback from `docs/design/robot-console-integration.md` §4 (mbtools
 * repo) and this sprint's SUC-001.
 *
 * This is sprint 018 ticket 001 — the foundation every other ticket in
 * this sprint (the watcher, the stream adapter) builds on. It owns:
 *
 * - **Resolution** ({@link resolveMbregistryConnection}): the fixed,
 *   never-mixed 5-step order SUC-001 describes — `$ROBOT_CONSOLE_MBREGISTRY`,
 *   the standard client candidates (mirroring mbtools
 *   `registry.paths.client_socket_candidates()`), a previously-spawned
 *   console-owned socket, spawn-on-demand, or a clear "not installed /
 *   too old" failure.
 * - **Wire framing**: newline-delimited JSON, one object per line, via
 *   `link/lineStream.ts`'s {@link LineReassembler} (JSON-lines here, not
 *   the wire's own v6 protocol that class was written for — the framing
 *   discipline is identical, so it is reused rather than re-implemented).
 * - **Typed ops**: `list`/`find`/`lock`/`unlock`/`watch`, typed against
 *   mbtools `docs/design/registry-api.md`'s documented wire shapes, plus
 *   `stream` (mbtools `docs/design/registry-api.md` "Stream sub-protocol")
 *   for the future `mbregistryStream` adapter ticket to build binary
 *   framing on top of.
 *
 * ## Version pinning (Open Question #1, sprint.md — resolved by sprint
 * 018 ticket 006)
 *
 * {@link MIN_MBREGISTRY_VERSION} is now pinned to `0.20260924.7` — the
 * version mbtools sprint 008 closed as (`watch`, lock `label`/`since`,
 * local-socket `stream`, and `--version`/`--ready-json`'s `"version"`
 * field all land there), now on mbtools `main`. `mbregistry --version`
 * prints exactly `mbregistry 0.20260924.7\n` to stdout and exits 0;
 * {@link checkMbregistryVersion} extracts the dotted-numeric token and
 * compares it numerically per component via {@link compareVersions}
 * (these are date-style version numbers, e.g. `0.20260924.7`, not
 * semver — a lexicographic string compare would misorder them). The
 * spawn path ({@link spawnMbregistry}) independently re-checks the
 * `--ready-json` line's own top-level `"version"` key against the same
 * floor, in case a differently-versioned binary is on `$PATH` than the
 * one `checkMbregistryVersion` probed moments earlier (a `--ready-json`
 * with no `"version"` key at all — an older mbregistry — is not treated
 * as a failure there, since {@link checkMbregistryVersion} already
 * gated the binary itself before any spawn was attempted).
 *
 * ## `stream` requires the *locking* connection
 *
 * Per `registry-api.md`, `{"op": "stream", "uid": ...}` requires a
 * `serial`- or `relay`-kind lock already held by *this same connection*.
 * `stream` shipped TCP-remote-API-only at first (sprint 003), then
 * landed on the local Unix socket/pipe too (mbtools 008-004) — so
 * {@link MbregistryClient.stream} now tries a fresh connection to this
 * client's own local endpoint first for a local device (no
 * `remoteEndpoint` argument), falling back to the remote TCP port (the
 * only path before 008-004, and still the only path for a *remote*
 * device — see that method's own doc comment) if the local socket's
 * `stream` request is unrecognized by an older mbregistry. Either way,
 * `lock` then `stream` happen on one dedicated connection, and the raw,
 * post-ack socket is handed back — the `mbregistryStream` adapter
 * (018-003)'s own concern is the binary frame format layered on top of
 * it, not this handshake.
 */

import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import * as net from "node:net";
import { homedir, hostname, tmpdir } from "node:os";
import path from "node:path";

import { LineReassembler } from "../link/lineStream.js";
import { resolveStateDir } from "../store/stateDir.js";

// ---------------------------------------------------------------------------
// Version floor (Open Question #1 — see module doc comment; pinned by
// sprint 018 ticket 006)
// ---------------------------------------------------------------------------

/** Minimum `mbregistry` version robot-console requires — pinned (sprint
 * 018 ticket 006) to the version mbtools sprint 008 closed as
 * (`0.20260924.7`, now on mbtools `main`): `watch`, lock `label`/`since`,
 * local-socket `stream` (mbtools 008-004), and `--version`/`--ready-json`
 * `"version"` all ship at or before this version. Bump this constant
 * (only) if a later mbtools release becomes the new floor. */
export const MIN_MBREGISTRY_VERSION = "0.20260924.7";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** One stable machine-readable reason `mbregistryClient` failed, distinct
 * from the wire protocol's own `code` values (`not_found`/`locked`/...,
 * `registry-api.md`'s "Responses" table) — those surface as {@link
 * MbregistryError.code} too, but the ones below never come off the wire. */
export type MbregistryErrorCode =
  | "not_found"
  | "locked"
  | "not_locked"
  | "invalid_request"
  | "internal_error"
  | "ambiguous_name"
  | "unauthorized"
  | "unreachable"
  | "binary_not_found"
  | "version_too_old"
  | "spawn_timeout"
  | "spawn_exited"
  | "connection_closed";

/** Thrown by every {@link MbregistryClient} method on any failure — a
 * transport failure, a spawn/resolution failure, or an `{"ok": false,
 * ...}` wire response. `code` is the wire's own `code` field when this
 * came from a response; one of the resolution-specific values above
 * otherwise. */
export class MbregistryError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown> | undefined;

  constructor(message: string, code: MbregistryErrorCode | string, details?: Record<string, unknown>) {
    super(message);
    this.name = "MbregistryError";
    this.code = code;
    this.details = details;
  }
}

// ---------------------------------------------------------------------------
// Wire shapes (docs/design/registry-api.md, mbtools repo)
// ---------------------------------------------------------------------------

export type LockKind = "serial" | "relay" | "flash" | "debug";

/** "Lock holder wire shape" — `registry-api.md`. */
export interface LockHolder {
  kind: LockKind;
  pid: number | null;
  label: string | null;
  since: number | null;
  origin?: "remote";
  host?: string | null;
}

/** One `list`/`find` device entry — `registry-api.md`'s `### list`
 * section. Every `store.DeviceRecord` column, plus the four folded-in
 * lock-status fields. Indexable with `[key: string]: unknown` so a field
 * this sprint's mbtools adds later doesn't need this type edited to be
 * readable. */
export interface RegistryDevice {
  uid: string;
  short_uid: string;
  port: string | null;
  vid_pid: string | null;
  role: string | null;
  common_name: string | null;
  device_name: string | null;
  serial_payload: string | null;
  raw_announcement: string | null;
  state: string;
  error_note: string | null;
  flash_count: number;
  chip_identity_name: string | null;
  chip_identity_serial: number | null;
  first_seen: number;
  last_seen: number;
  last_probe: number | null;
  lock_kind: LockKind | null;
  lock_pid: number | null;
  lock_label: string | null;
  lock_since: number | null;
  host?: string | null;
  /** `host:port` of the *owning* registry's own remote TCP listener —
   * `null`/absent for a locally-owned row (`host` also `null`/absent),
   * `"<host>:<port>"` for a peer-owned row (mbtools
   * `_api_base.BaseAPIServer._device_to_dict`'s own `d["endpoint"]`,
   * sourced from the `peer` table's `endpoint` column —
   * `docs/design/registry-api.md`'s "Store schema additions for
   * peering"). Sprint 018 ticket 005's own `mbregistry/remoteFlash.ts`
   * is this client's first caller that actually reads it, to dial a
   * remote board's owning instance directly for `send_hex`/`flash`
   * rather than the local instance's own remote port. */
  endpoint?: string | null;
  [key: string]: unknown;
}

/** `watch`'s own event vocabulary — `registry-api.md`'s "Event
 * vocabulary" table. `type` narrows which of the other fields are
 * present; left loose (`[key: string]: unknown`) rather than a
 * discriminated union per type, since a client mostly just needs to
 * read `type` and forward the rest. */
export interface WatchEvent {
  type: "attach" | "detach" | "identity" | "lock_state" | "name_set" | "name_clear" | "peer_up" | "peer_down";
  host: string;
  [key: string]: unknown;
}

interface OkResponse {
  ok: true;
  [key: string]: unknown;
}

interface ErrResponse {
  ok: false;
  code: string;
  error: string;
  [key: string]: unknown;
}

type WireResponse = OkResponse | ErrResponse;

function isWireResponse(value: unknown): value is WireResponse {
  return typeof value === "object" && value !== null && "ok" in value;
}

/** Throws {@link MbregistryError} if `response` is `{"ok": false, ...}`;
 * otherwise returns it narrowed to {@link OkResponse}. Every op below
 * routes its response through this — one place turns the wire's own
 * failure shape into a thrown error. */
function unwrap(response: WireResponse): OkResponse {
  if (!response.ok) {
    throw new MbregistryError(response.error, response.code, response);
  }
  return response;
}

// ---------------------------------------------------------------------------
// Endpoint resolution — mirrors mbtools `registry.paths`
// ---------------------------------------------------------------------------

/** Where a connection goes: a Unix domain socket path, a Windows named
 * pipe (also a `path` — `net.connect({ path })` handles both), or a
 * `host:port` TCP address. */
export type ResolvedEndpoint =
  | { kind: "unix" | "pipe"; path: string }
  | { kind: "tcp"; host: string; port: number };

function endpointDescription(endpoint: ResolvedEndpoint): string {
  return endpoint.kind === "tcp" ? `${endpoint.host}:${endpoint.port}` : endpoint.path;
}

const APP = "mbregistry";

/** Fixed named-pipe path in the Windows `\\.\pipe\` namespace — mirrors
 * mbtools `registry.paths._WINDOWS_PIPE_NAME` exactly (do not re-derive;
 * see this ticket's own Description on drift). */
const WINDOWS_PIPE_NAME = "\\\\.\\pipe\\mbregistry";

function isRoot(): boolean {
  if (process.platform === "win32") {
    return false;
  }
  const getEuid = (process as unknown as { geteuid?: () => number }).geteuid;
  return typeof getEuid === "function" && getEuid() === 0;
}

/** Mirrors mbtools `registry.paths.system_socket_path()`. */
function systemSocketPath(): string {
  if (process.platform === "darwin") {
    return path.join("/var/run", APP, "api.sock");
  }
  return path.join("/run", APP, "api.sock");
}

/** Mirrors mbtools `registry.paths.user_socket_path()`. `homedirFn`
 * defaults to `node:os`'s real `homedir` — a test seam only (mbtools'
 * own darwin branch has no env-var override for this path either; a
 * unit test that needs a fake "user socket" candidate without touching
 * the real developer home directory injects a fake homedir here,
 * mirroring this codebase's existing `now()`-style DI convention rather
 * than re-deriving the platform rule itself). */
function userSocketPath(env: NodeJS.ProcessEnv, homedirFn: () => string = homedir): string {
  if (process.platform === "darwin") {
    return path.join(homedirFn(), "Library", "Application Support", APP, "api.sock");
  }
  const runtime = env.XDG_RUNTIME_DIR;
  if (runtime !== undefined && runtime.length > 0 && existsSync(runtime)) {
    return path.join(runtime, APP, "api.sock");
  }
  return path.join(homedirFn(), ".cache", APP, "api.sock");
}

/** Mirrors mbtools `registry.paths.client_socket_candidates()`: this
 * user's own daemon first, then the system one (root's own order is
 * flipped, matching the Python original), deduplicated when the two
 * happen to coincide. Windows has no Unix socket at all — the single
 * fixed pipe name is the only candidate there. See {@link
 * userSocketPath}'s own doc comment for `homedirFn`. */
export function clientSocketCandidates(
  env: NodeJS.ProcessEnv = process.env,
  homedirFn: () => string = homedir,
): ResolvedEndpoint[] {
  if (process.platform === "win32") {
    return [{ kind: "pipe", path: WINDOWS_PIPE_NAME }];
  }
  const [first, second] = isRoot()
    ? [systemSocketPath(), userSocketPath(env, homedirFn)]
    : [userSocketPath(env, homedirFn), systemSocketPath()];
  const paths = first === second ? [first] : [first, second];
  return paths.map((p) => ({ kind: "unix", path: p }));
}

/** `AF_UNIX`'s `sun_path` length limit — 104 bytes on macOS/BSD, 108 on
 * Linux (ticket 018-010's Description, from a real bench failure: a
 * deeply-nested `$XDG_STATE_HOME` pushed the derived socket path past
 * this, and the spawned mbregistry died immediately with `OSError:
 * AF_UNIX path too long`). Deliberately compared with a little slack
 * below the true limit (which also has to leave room for the trailing
 * NUL the kernel appends) rather than the exact boundary — this only
 * ever needs to decide "derive it normally" vs. "use the short
 * fallback", not shave the last byte off a barely-fitting path. */
const AF_UNIX_PATH_LIMIT = process.platform === "darwin" ? 104 : 108;

/** Short, deterministic hash of `stateDir`, keying the too-long-path
 * fallback socket location (below) so the same console instance (same
 * state dir) always derives the same fallback path — required by
 * resolution step 3 (`resolveMbregistryConnection`'s "this console's own
 * previously-spawned instance" check): a second launch against the same
 * state dir must find the first launch's spawned instance there. */
function shortStateDirHash(stateDir: string): string {
  return createHash("sha256").update(stateDir).digest("hex").slice(0, 16);
}

/** The state-dir-derived socket path, or — when that path would exceed
 * {@link AF_UNIX_PATH_LIMIT} — a short, deterministic fallback path
 * under the system temp dir instead (ticket 018-010, fix (a)). The
 * fallback's containing directory is created mode `0700` (owner-only):
 * unlike the state dir itself, a temp-dir path is otherwise a
 * predictable, world-visible location any local user could pre-create
 * and race to hijack the socket at. */
function consoleOwnedUnixSocketPath(stateDir: string): string {
  const derived = path.join(stateDir, "mbregistry", "api.sock");
  if (derived.length < AF_UNIX_PATH_LIMIT) {
    return derived;
  }
  const dir = path.join(tmpdir(), `robot-console-mbregistry-${shortStateDirHash(stateDir)}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return path.join(dir, "api.sock");
}

/** This console's own previously-spawned instance, per the ticket
 * Description's step 3 — `<console-state>/mbregistry/api.sock` (or the
 * too-long-path fallback {@link consoleOwnedUnixSocketPath} derives
 * instead), or the fixed Windows pipe name (mbtools has no per-instance
 * pipe naming without `--pipe`, which this module does not pass — a
 * known limitation shared with mbtools itself as of this ticket; see
 * `robot-console-integration.md` §5 item 4). {@link spawnMbregistry} and
 * this resolution step both call this same function, so a socket
 * spawned via the fallback path is still found here on a later launch
 * against the same state dir. */
export function consoleOwnedEndpoint(env: NodeJS.ProcessEnv = process.env): ResolvedEndpoint {
  if (process.platform === "win32") {
    return { kind: "pipe", path: WINDOWS_PIPE_NAME };
  }
  return { kind: "unix", path: consoleOwnedUnixSocketPath(resolveStateDir({}, env)) };
}

/** `<console-state>/mbregistry/devices.db` — the spawned instance's own
 * `--db`. */
export function consoleOwnedDbPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateDir({}, env), "mbregistry", "devices.db");
}

/** Parses `$ROBOT_CONSOLE_MBREGISTRY`: a socket path, a Windows pipe
 * name, or `host:port`. A bare `host:port` is recognized by a trailing
 * `:<digits>` with no `/` in the host part (a filesystem path never
 * looks like that); anything else is treated as a socket/pipe path
 * as-is. */
export function parseEndpointSpec(spec: string): ResolvedEndpoint {
  if (spec.startsWith("\\\\.\\pipe\\")) {
    return { kind: "pipe", path: spec };
  }
  const lastColon = spec.lastIndexOf(":");
  if (lastColon > 0) {
    const host = spec.slice(0, lastColon);
    const portStr = spec.slice(lastColon + 1);
    const port = Number(portStr);
    if (!host.includes("/") && portStr.length > 0 && Number.isInteger(port) && port > 0 && port < 65536) {
      return { kind: "tcp", host, port };
    }
  }
  return { kind: process.platform === "win32" ? "pipe" : "unix", path: spec };
}

/** Parses a `"<host>:<port>"` string — {@link RegistryDevice.endpoint}'s
 * own wire shape for a peer-owned device — into `{host, port}`, or
 * `undefined` for `null`/`undefined`/a malformed value (never throws;
 * sprint 018 ticket 005's `mbregistry/remoteFlash.ts` caller treats an
 * unparseable endpoint the same as "no endpoint" — the local-instance
 * fallback, {@link resolveFlashTarget} in `link/adapters/
 * mbregistryStream.ts`, then applies). IPv6 hosts are not a case this
 * needs to handle: `registry-api.md`'s peer endpoints are always
 * `record_peer_seen`'s own `f"{address}:{remote_port}"`, itself built
 * from IPv4 mDNS/`--peer` addresses only, per that module's own doc
 * comment. */
export function parseHostPort(spec: string | null | undefined): { host: string; port: number } | undefined {
  if (spec === null || spec === undefined || spec.length === 0) {
    return undefined;
  }
  const lastColon = spec.lastIndexOf(":");
  if (lastColon <= 0) {
    return undefined;
  }
  const host = spec.slice(0, lastColon);
  const port = Number(spec.slice(lastColon + 1));
  if (host.length === 0 || !Number.isInteger(port) || port <= 0 || port >= 65536) {
    return undefined;
  }
  return { host, port };
}

// ---------------------------------------------------------------------------
// Transport — one JSON-lines connection over any ResolvedEndpoint
// ---------------------------------------------------------------------------

/** Injectable in place of `net.connect` for tests that want a fake
 * socket; production code never overrides this. */
export type ConnectFn = (endpoint: ResolvedEndpoint) => net.Socket;

const defaultConnect: ConnectFn = (endpoint) => {
  if (endpoint.kind === "tcp") {
    return net.connect({ host: endpoint.host, port: endpoint.port });
  }
  return net.connect({ path: endpoint.path });
};

/** Opens `endpoint`, resolving once connected and rejecting on the
 * first error (a stale/half-open socket from a prior failed attempt is
 * never reused). */
function openSocket(endpoint: ResolvedEndpoint, connect: ConnectFn): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const socket = connect(endpoint);
    const onError = (err: Error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(
        new MbregistryError(
          `could not connect to mbregistry at ${endpointDescription(endpoint)}: ${err.message}`,
          "unreachable",
        ),
      );
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

/**
 * One JSON-lines connection: a strict request/response driver (this
 * protocol never pipelines — `registry-api.md`'s "Framing": "Every
 * non-streaming request gets exactly one JSON response line") that can
 * be switched, permanently, into `watch` event delivery once `watch`'s
 * own ack arrives, per that op's own "leaves ordinary request/response
 * dispatch for the rest of the connection's life" contract.
 */
class JsonLinesConnection {
  private readonly reassembler = new LineReassembler();
  private readonly pending: Array<{ resolve: (v: WireResponse) => void; reject: (e: Error) => void }> = [];
  private watching = false;
  private readonly watchQueue: WatchEvent[] = [];
  private readonly watchWaiters: Array<(v: IteratorResult<WatchEvent>) => void> = [];
  private closed = false;
  private closeError: Error | undefined;

  constructor(readonly socket: net.Socket) {
    socket.on("data", (chunk: Buffer) => this.handleData(chunk));
    socket.on("close", () => this.handleClose(undefined));
    socket.on("error", (err: Error) => this.handleClose(err));
  }

  private handleData(chunk: Buffer): void {
    for (const line of this.reassembler.push(chunk)) {
      if (line.trim().length === 0) {
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (this.watching) {
        this.deliverWatchEvent(parsed as WatchEvent);
      } else if (isWireResponse(parsed)) {
        const waiter = this.pending.shift();
        waiter?.resolve(parsed);
      }
    }
  }

  private deliverWatchEvent(event: WatchEvent): void {
    const waiter = this.watchWaiters.shift();
    if (waiter) {
      waiter({ value: event, done: false });
    } else {
      this.watchQueue.push(event);
    }
  }

  private handleClose(err: Error | undefined): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.closeError = err;
    const closeErr = err ?? new MbregistryError("mbregistry connection closed", "connection_closed");
    for (const waiter of this.pending.splice(0)) {
      waiter.reject(closeErr);
    }
    for (const waiter of this.watchWaiters.splice(0)) {
      waiter({ value: undefined as unknown as WatchEvent, done: true });
    }
  }

  /** Send one request line, and resolve/reject with its one response
   * line — never valid to call again after {@link watch} has been
   * acked, or after {@link detach} has handed the socket off for
   * `stream`. */
  request(op: Record<string, unknown>): Promise<WireResponse> {
    if (this.closed) {
      return Promise.reject(this.closeError ?? new MbregistryError("mbregistry connection closed", "connection_closed"));
    }
    return new Promise((resolve, reject) => {
      this.pending.push({ resolve, reject });
      this.socket.write(JSON.stringify(op) + "\n");
    });
  }

  /** Sends `{"op": "watch"}`, awaits its ack, then switches this
   * connection permanently into event delivery. */
  async *watch(): AsyncIterable<WatchEvent> {
    unwrap(await this.request({ op: "watch" }));
    this.watching = true;
    while (true) {
      if (this.closed && this.watchQueue.length === 0) {
        return;
      }
      const queued = this.watchQueue.shift();
      if (queued !== undefined) {
        yield queued;
        continue;
      }
      const result = await new Promise<IteratorResult<WatchEvent>>((resolve) => {
        this.watchWaiters.push(resolve);
      });
      if (result.done) {
        return;
      }
      yield result.value;
    }
  }

  /** Stops this connection's own line parsing and hands the raw socket
   * back to the caller — used once `stream`'s ack arrives, per
   * `registry-api.md`'s "the connection permanently leaves newline-JSON
   * framing" contract. No further {@link request}/{@link watch} call is
   * ever valid on this connection afterward. */
  detach(): net.Socket {
    this.socket.removeAllListeners("data");
    return this.socket;
  }

  close(): void {
    this.socket.end();
  }
}

// ---------------------------------------------------------------------------
// Binary resolution + version check
// ---------------------------------------------------------------------------

/** A `child_process.spawn`-shaped seam, injectable so tests never spawn
 * a real `mbregistry` binary (per this sprint's Test Strategy
 * constraint) — the default is the real `node:child_process.spawn`. */
export type SpawnFn = typeof nodeSpawn;

/** Compares two dotted-numeric version strings (`"1.2.3"`-style; a
 * missing/non-numeric component is treated as `0`). Returns `-1`, `0`,
 * or `1`, the same convention as `Array.prototype.sort`'s comparator. */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const aParts = a.split(".");
  const bParts = b.split(".");
  const len = Math.max(aParts.length, bParts.length);
  for (let i = 0; i < len; i++) {
    const aNum = Number.parseInt(aParts[i] ?? "0", 10) || 0;
    const bNum = Number.parseInt(bParts[i] ?? "0", 10) || 0;
    if (aNum !== bNum) {
      return aNum < bNum ? -1 : 1;
    }
  }
  return 0;
}

const VERSION_TOKEN_PATTERN = /(\d+(?:\.\d+){1,3})/;

/** Pulls the first semver-shaped token out of `mbregistry --version`'s
 * (or `--version`-alike) output — tolerant of a leading `mbregistry ` /
 * `v` prefix, since the exact banner format is not yet fixed upstream
 * (see this module's own doc comment on Open Question #1). */
export function extractVersion(output: string): string | undefined {
  const match = VERSION_TOKEN_PATTERN.exec(output);
  return match?.[1];
}

/** Resolves the `mbregistry` binary name/path: `$MBREGISTRY_BIN` if set,
 * else the bare command name `"mbregistry"`, letting the OS search
 * `$PATH` itself (matching every other project convention here — no
 * hand-rolled `$PATH` walk). */
export function resolveMbregistryBinary(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.MBREGISTRY_BIN;
  return override !== undefined && override.length > 0 ? override : "mbregistry";
}

/** Runs `<bin> --version`, extracts a version token, and throws {@link
 * MbregistryError} (`"binary_not_found"` or `"version_too_old"`, both
 * naming {@link MIN_MBREGISTRY_VERSION}) unless the binary was found and
 * its reported version is at least the minimum. No spawn (`mbregistry
 * run`) is ever attempted when this throws — SUC-001's acceptance
 * criteria: "no direct-USB fallback is attempted" either. */
export async function checkMbregistryVersion(
  bin: string,
  spawnFn: SpawnFn,
  timeoutMs = 5000,
): Promise<string> {
  let stdout = "";
  let stderr = "";
  const child = await new Promise<ChildProcess | undefined>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawnFn(bin, ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      reject(toNotFoundError(bin, err));
      return;
    }
    const timer = setTimeout(() => {
      child.kill();
      reject(new MbregistryError(`timed out waiting for '${bin} --version'`, "binary_not_found"));
    }, timeoutMs);
    child.once("error", (err) => {
      clearTimeout(timer);
      reject(toNotFoundError(bin, err));
    });
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(child);
    });
  });
  if (child === undefined) {
    throw toNotFoundError(bin);
  }
  const version = extractVersion(stdout) ?? extractVersion(stderr);
  if (version === undefined) {
    throw new MbregistryError(
      `could not determine '${bin}' version (requires mbregistry >= ${MIN_MBREGISTRY_VERSION})`,
      "binary_not_found",
    );
  }
  if (compareVersions(version, MIN_MBREGISTRY_VERSION) < 0) {
    throw new MbregistryError(
      `mbregistry ${version} is older than the required minimum ${MIN_MBREGISTRY_VERSION}`,
      "version_too_old",
      { found: version, required: MIN_MBREGISTRY_VERSION },
    );
  }
  return version;
}

function toNotFoundError(bin: string, cause?: unknown): MbregistryError {
  const causeCode = (cause as { code?: string } | undefined)?.code;
  const reason = causeCode === "ENOENT" || cause === undefined ? "not found" : String((cause as Error).message ?? cause);
  return new MbregistryError(
    `mbregistry ('${bin}') ${reason} on $MBREGISTRY_BIN/$PATH (requires >= ${MIN_MBREGISTRY_VERSION})`,
    "binary_not_found",
  );
}

/** Cap on how much captured stderr a thrown error's own message ever
 * carries — a runaway/binary-garbage child must not blow up an error
 * message without bound. */
const STDERR_TAIL_LIMIT = 4000;

/** Formats captured stderr as an ` -- stderr: <tail>` suffix for an
 * error message (ticket 018-010 fix (b)), or `""` when nothing was
 * captured — the exact tail (last {@link STDERR_TAIL_LIMIT} characters)
 * regardless of *why* the process exited, not just the too-long-socket-
 * path case this ticket started from. */
function stderrTail(stderr: string): string {
  if (stderr.trim().length === 0) {
    return "";
  }
  const tail = stderr.length > STDERR_TAIL_LIMIT ? stderr.slice(-STDERR_TAIL_LIMIT) : stderr;
  return ` -- stderr: ${tail.trim()}`;
}

// ---------------------------------------------------------------------------
// Spawn-on-demand
// ---------------------------------------------------------------------------

/** The one line `mbregistry run --ready-json` prints once every
 * requested listener is bound — `registry-api.md`/
 * `robot-console-integration.md` §5 item 6. */
interface ReadyJson {
  ready: true;
  instance?: string;
  /** Sprint 018 ticket 006: the same dotted-numeric string `mbregistry
   * --version` prints, now also carried on `--ready-json` (mbtools
   * 0.20260924.7+) — absent for an older mbregistry, which is not
   * itself treated as a failure here (see {@link spawnMbregistry}). */
  version?: string;
  socket?: string;
  ports?: Record<string, number>;
}

function isReadyJson(value: unknown): value is ReadyJson {
  return typeof value === "object" && value !== null && (value as { ready?: unknown }).ready === true;
}

/** Short hostname this console's own spawned `--instance <host>-console`
 * uses, mirroring mbtools' own `_short_hostname()` (strip any domain
 * suffix). */
function shortHostname(): string {
  return hostname().split(".")[0] ?? hostname();
}

export interface SpawnMbregistryOptions {
  env: NodeJS.ProcessEnv;
  spawnFn: SpawnFn;
  /** `mbregistry.shareBoards` — flips `--no-peering` off when `true`
   * (Description). Defaults to `false`. */
  shareBoards?: boolean | undefined;
  /** Bound on waiting for the `--ready-json` line. Defaults to 10s —
   * generous for a cold daemon start, still bounded so a hung/broken
   * binary fails the connect rather than hanging robot-console forever. */
  readyTimeoutMs?: number | undefined;
}

export interface SpawnedMbregistry {
  child: ChildProcess;
  endpoint: ResolvedEndpoint;
  remotePort: number | undefined;
  ready: ReadyJson;
}

/** Spawns `mbregistry run` with this console's own resolution-step-4
 * flags (Description), waits for its `--ready-json` line, and resolves
 * the endpoint to connect to from what it reports. `--exit-with-parent`
 * ties the child's lifetime to this process without any explicit
 * teardown here: `spawnFn`'s default `stdio: "pipe"` keeps the child's
 * stdin open only as long as this process is (the pipe's write end
 * closes when this process exits), which is exactly the EOF
 * `--exit-with-parent` watches for. */
export async function spawnMbregistry(options: SpawnMbregistryOptions): Promise<SpawnedMbregistry> {
  const { env, spawnFn, shareBoards = false, readyTimeoutMs = 10_000 } = options;
  const bin = resolveMbregistryBinary(env);
  const socketPath = consoleOwnedEndpoint(env);
  if (socketPath.kind !== "unix" && socketPath.kind !== "pipe") {
    throw new MbregistryError("console-owned endpoint must be a socket or pipe", "internal_error");
  }
  const dbPath = consoleOwnedDbPath(env);
  const instance = `${shortHostname()}-console`;

  const args = [
    "run",
    "--instance",
    instance,
    "--socket",
    socketPath.path,
    "--db",
    dbPath,
    "--remote-port",
    "0",
    "--peer-pub-port",
    "0",
    "--peer-snapshot-port",
    "0",
    "--pool-port",
    "0",
    "--names-port",
    "0",
    "--ready-json",
    "--exit-with-parent",
  ];
  if (!shareBoards) {
    args.push("--no-peering");
  }

  const child = spawnFn(bin, args, { env, stdio: ["pipe", "pipe", "pipe"] });

  const ready = await new Promise<ReadyJson>((resolve, reject) => {
    let settled = false;
    let stderr = "";
    const reassembler = new LineReassembler();
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new MbregistryError("timed out waiting for mbregistry --ready-json", "spawn_timeout"));
    }, readyTimeoutMs);

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      for (const line of reassembler.push(chunk)) {
        if (line.trim().length === 0) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }
        if (isReadyJson(parsed)) {
          settle(() => resolve(parsed));
          return;
        }
      }
    });
    // Ticket 018-010 fix (b): capture stderr the whole time we're
    // waiting for --ready-json, so an exit-before-ready failure below
    // can report *why* -- previously this was read (Node buffers an
    // unlistened stream internally) but never surfaced, so the only way
    // to learn what actually happened was to re-run the spawn by hand
    // outside the console.
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", (err) => {
      settle(() => reject(toNotFoundError(bin, err)));
    });
    child.once("exit", (code) => {
      settle(() =>
        reject(
          new MbregistryError(
            `mbregistry exited before reporting ready (code ${String(code)})${stderrTail(stderr)}`,
            "spawn_exited",
          ),
        ),
      );
    });
  });

  // Sprint 018 ticket 006: re-verify the *spawned* instance's own
  // reported version against the same floor `checkMbregistryVersion`
  // already gated the binary against, above -- belt-and-braces against a
  // `$PATH`/`$MBREGISTRY_BIN` race between that check and this spawn. No
  // `"version"` key at all (an mbregistry older than 0.20260924.7) is
  // not itself a failure here -- checkMbregistryVersion already turned
  // that away before any spawn was attempted.
  if (ready.version !== undefined && compareVersions(ready.version, MIN_MBREGISTRY_VERSION) < 0) {
    child.kill();
    throw new MbregistryError(
      `spawned mbregistry ${ready.version} is older than the required minimum ${MIN_MBREGISTRY_VERSION}`,
      "version_too_old",
      { found: ready.version, required: MIN_MBREGISTRY_VERSION },
    );
  }

  const endpoint: ResolvedEndpoint =
    ready.socket !== undefined
      ? { kind: socketPath.kind, path: ready.socket }
      : socketPath;
  const remotePort = ready.ports?.remote;

  return { child, endpoint, remotePort, ready };
}

// ---------------------------------------------------------------------------
// Resolution — the fixed, never-mixed 5-step order (SUC-001)
// ---------------------------------------------------------------------------

const ENV_VAR = "ROBOT_CONSOLE_MBREGISTRY";

export interface ResolveDeps {
  env: NodeJS.ProcessEnv;
  connect: ConnectFn;
  spawnFn: SpawnFn;
  shareBoards?: boolean | undefined;
  /** Bound on each liveness probe (steps 2/3) before moving to the next
   * candidate/step. Defaults to 500ms. */
  livenessTimeoutMs?: number | undefined;
  spawnReadyTimeoutMs?: number | undefined;
  versionCheckTimeoutMs?: number | undefined;
  /** Test seam only — see {@link userSocketPath}'s own doc comment. */
  homedirFn?: (() => string) | undefined;
}

export interface ResolvedConnection {
  endpoint: ResolvedEndpoint;
  socket: net.Socket;
  /** Set only when this call spawned a new instance — the remote TCP
   * port it reported, for {@link MbregistryClient.stream}. */
  remotePort?: number | undefined;
  spawned: boolean;
  /** Set only when this call spawned a new instance — the handle
   * {@link MbregistryClient.close} terminates, so a spawned instance
   * does not outlive an in-process `runtime.stop()` (it would otherwise
   * only die via `--exit-with-parent` on this whole process's own exit,
   * never on a graceful stop that keeps the process running -- e.g. an
   * attach-then-stop in `cli.ts`, or a dev-server restart). */
  child?: ChildProcess | undefined;
}

/** Tries to open `endpoint` and confirm it is a live mbregistry by
 * sending `list`. Returns the open, verified socket, or `undefined` if
 * either the connect or the liveness check failed (the socket is
 * cleaned up either way — never leaked back to the caller). */
async function tryLiveEndpoint(endpoint: ResolvedEndpoint, connect: ConnectFn, timeoutMs: number): Promise<net.Socket | undefined> {
  let socket: net.Socket;
  try {
    socket = await withTimeout(openSocket(endpoint, connect), timeoutMs);
  } catch {
    return undefined;
  }
  const conn = new JsonLinesConnection(socket);
  try {
    unwrap(await withTimeout(conn.request({ op: "list" }), timeoutMs));
    return socket;
  } catch {
    socket.destroy();
    return undefined;
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new MbregistryError("timed out", "unreachable")), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * Resolves a live mbregistry connection following SUC-001's fixed order,
 * never mixing steps:
 *
 * 1. `$ROBOT_CONSOLE_MBREGISTRY`, if set — connect there and never spawn,
 *    even if it turns out to be unreachable (that surfaces as a thrown
 *    {@link MbregistryError} instead of falling through to step 2).
 * 2. The standard client candidates ({@link clientSocketCandidates}),
 *    each confirmed live with a `list` call.
 * 3. This console's own previously-spawned socket ({@link
 *    consoleOwnedEndpoint}), same liveness confirmation.
 * 4. Locate the binary and check its version ({@link
 *    checkMbregistryVersion}) — throws (no spawn attempted) if missing
 *    or too old.
 * 5. Spawn ({@link spawnMbregistry}) and connect to what it reports.
 */
export async function resolveMbregistryConnection(deps: ResolveDeps): Promise<ResolvedConnection> {
  const {
    env,
    connect,
    spawnFn,
    shareBoards,
    livenessTimeoutMs = 500,
    spawnReadyTimeoutMs,
    versionCheckTimeoutMs,
    homedirFn = homedir,
  } = deps;

  // Step 1: explicit override — never spawn, never fall through.
  const override = env[ENV_VAR];
  if (override !== undefined && override.length > 0) {
    const endpoint = parseEndpointSpec(override);
    const socket = await openSocket(endpoint, connect);
    return { endpoint, socket, spawned: false };
  }

  // Step 2: standard candidates.
  for (const endpoint of clientSocketCandidates(env, homedirFn)) {
    const socket = await tryLiveEndpoint(endpoint, connect, livenessTimeoutMs);
    if (socket !== undefined) {
      return { endpoint, socket, spawned: false };
    }
  }

  // Step 3: this console's own previously-spawned instance.
  const consoleEndpoint = consoleOwnedEndpoint(env);
  const consoleSocket = await tryLiveEndpoint(consoleEndpoint, connect, livenessTimeoutMs);
  if (consoleSocket !== undefined) {
    return { endpoint: consoleEndpoint, socket: consoleSocket, spawned: false };
  }

  // Step 4: binary + version check — no spawn attempted if this throws.
  const bin = resolveMbregistryBinary(env);
  await checkMbregistryVersion(bin, spawnFn, versionCheckTimeoutMs);

  // Step 5: spawn.
  const spawnedInfo = await spawnMbregistry({
    env,
    spawnFn,
    shareBoards,
    readyTimeoutMs: spawnReadyTimeoutMs,
  });
  const socket = await openSocket(spawnedInfo.endpoint, connect);
  return {
    endpoint: spawnedInfo.endpoint,
    socket,
    remotePort: spawnedInfo.remotePort,
    spawned: true,
    child: spawnedInfo.child,
  };
}

// ---------------------------------------------------------------------------
// Public client
// ---------------------------------------------------------------------------

export interface MbregistryClientDeps {
  env?: NodeJS.ProcessEnv | undefined;
  connect?: ConnectFn | undefined;
  spawnFn?: SpawnFn | undefined;
  shareBoards?: boolean | undefined;
  livenessTimeoutMs?: number | undefined;
  spawnReadyTimeoutMs?: number | undefined;
  versionCheckTimeoutMs?: number | undefined;
  /** Test seam only — see {@link userSocketPath}'s own doc comment. */
  homedirFn?: (() => string) | undefined;
}

export interface MbregistryClient {
  /** Runs {@link resolveMbregistryConnection} and opens the control
   * connection every other method uses. Must be called (and awaited)
   * before any other method. */
  connect(): Promise<ResolvedEndpoint>;
  /** Closes the control connection. Idempotent. */
  close(): void;
  list(): Promise<RegistryDevice[]>;
  find(uid: string): Promise<RegistryDevice>;
  lock(uid: string, kind: LockKind, label?: string): Promise<void>;
  unlock(uid: string): Promise<boolean>;
  /** `{"op": "watch"}` — an async iterable of every event from here on
   * (change-only, no snapshot on connect — call {@link list} first for
   * that). Ends when the connection closes. */
  watch(): AsyncIterable<WatchEvent>;
  /**
   * Performs `lock` then `stream` on one dedicated connection —
   * `registry-api.md`'s own precondition that both must come from the
   * *same* connection — and resolves to the raw, post-ack socket for a
   * binary-framing layer (ticket 018-003's `mbregistryStream` adapter)
   * to take over; `unlockAndClose()` releases the lock by closing that
   * connection.
   *
   * `remoteEndpoint` omitted (a local device, per `mbregistryStream`'s
   * own `resolveStreamTarget`): if this client's own {@link
   * resolvedEndpoint} is a local Unix socket/pipe, a fresh connection to
   * that *same* local endpoint is tried first (mbtools 008-004 added
   * `stream` there too, per ticket 018-003's coordinator note — no extra
   * TCP hop, no dependency on knowing this instance's own remote port).
   * That attempt falls back to the remote TCP port ({@link remotePort}
   * on `127.0.0.1`, the only path before 008-004) if the local socket's
   * own `stream` request comes back `invalid_request` — the shape an
   * older mbregistry that predates 008-004 gives an unrecognized op (the
   * lock it took first is released before falling back, so nothing is
   * left dangling). `remoteEndpoint` present (a remote device) always
   * goes straight to that host's own remote TCP port — a peer's local
   * socket is never reachable from here.
   *
   * `leftover`: any raw bytes that arrived immediately after `stream`'s
   * own ack line, in the very same chunk — the caller (`mbregistryStream`)
   * must feed these into its own frame decoder before anything else the
   * socket's `"data"` event later delivers; see `client.ts`'s own
   * `performStreamHandshake` doc comment for why this exists (never
   * silently dropped or corrupted by a JSON-line string decode).
   */
  stream(
    uid: string,
    kind: Extract<LockKind, "serial" | "relay">,
    remoteEndpoint?: { host: string; port: number },
    label?: string,
  ): Promise<{ socket: net.Socket; unlockAndClose: () => void; leftover: Buffer }>;
  /** Set once {@link connect} resolves. */
  readonly resolvedEndpoint: ResolvedEndpoint | undefined;
  /** Set once {@link connect} resolves, only when this call spawned a
   * new instance and it reported a remote port. */
  readonly remotePort: number | undefined;
}

function buildLockOp(uid: string, kind: LockKind, label: string | undefined): Record<string, unknown> {
  const op: Record<string, unknown> = { op: "lock", uid, kind };
  if (label !== undefined) {
    op.label = label;
  }
  return op;
}

/** The result of a successful `lock` + `stream` handshake — see {@link
 * performStreamHandshake}'s own doc comment for why `leftover` exists. */
interface StreamHandshakeResult {
  socket: net.Socket;
  unlockAndClose: () => void;
  leftover: Buffer;
}

/** `stream` came back `invalid_request` (an older mbregistry that
 * predates 008-004 doesn't recognize the op at all) — the caller's cue
 * to fall back to the remote TCP port. The lock this attempt took has
 * already been released and its connection closed. */
interface StreamHandshakeFallback {
  fallback: true;
}

/** Reads exactly one raw wire line (up to and not including the first
 * `0x0A` byte) off `socket`, via a temporary listener installed and torn
 * down within this call — used only for the one line that matters most,
 * `stream`'s own ack, whose exact byte boundary decides where JSON
 * framing ends and binary framing begins (see {@link
 * performStreamHandshake}). Resolves with that line (`utf8`-decoded —
 * safe, since the protocol guarantees this one line is itself valid
 * JSON/UTF-8) and `leftover`: whatever raw bytes arrived immediately
 * after it, in the very same chunk — untouched, as a `Buffer`, never
 * routed through any string decode that could corrupt binary payload. */
function readRawLine(socket: net.Socket): Promise<{ line: string; leftover: Buffer }> {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const cleanup = () => {
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
    };
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      const newlineIndex = buffer.indexOf(0x0a);
      if (newlineIndex >= 0) {
        cleanup();
        resolve({ line: buffer.subarray(0, newlineIndex).toString("utf8"), leftover: buffer.subarray(newlineIndex + 1) });
      }
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const onClose = () => {
      cleanup();
      reject(new MbregistryError("mbregistry connection closed", "connection_closed"));
    };
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("close", onClose);
  });
}

/**
 * Performs `lock` then `stream` on `socket`/`conn` (already open, not
 * yet used for anything) and hands back the raw post-ack socket — or a
 * {@link StreamHandshakeFallback} marker if `stream` is unrecognized on
 * this transport.
 *
 * **The handoff race this function exists to close** (flagged in this
 * ticket's own Approach and `registry-api.md`'s "Client synchronization
 * requirement"): once `stream`'s ack is sent, the server may write its
 * first binary frame immediately after — nothing prevents the OS/network
 * stack from coalescing that ack line and the frame bytes that follow it
 * into one TCP segment, delivered to this client as a single `"data"`
 * event. `JsonLinesConnection`'s own line reassembler decodes through a
 * JS string, which is lossy for arbitrary binary payload and, worse,
 * has no way to hand back "the bytes after the line" once `detach()` is
 * called — they would simply be discarded, silently corrupting or
 * dropping a session's very first frame. So this function never lets
 * `JsonLinesConnection` see the `stream` request at all: it detaches
 * *right after* `lock`'s own response (a point at which, by protocol,
 * the server has nothing left to say until we write again — safe to stop
 * string-based parsing there), writes the `stream` request line to the
 * raw socket itself, and reads its ack back via {@link readRawLine},
 * which never routes anything past that one line's own terminating
 * newline through a string at all.
 */
async function performStreamHandshake(
  conn: JsonLinesConnection,
  uid: string,
  kind: LockKind,
  label: string | undefined,
): Promise<StreamHandshakeResult | StreamHandshakeFallback> {
  unwrap(await conn.request(buildLockOp(uid, kind, label)));
  const rawSocket = conn.detach();
  rawSocket.write(JSON.stringify({ op: "stream", uid }) + "\n");
  const { line, leftover } = await readRawLine(rawSocket);
  const response = JSON.parse(line) as WireResponse;
  if (!response.ok) {
    if (response.code === "invalid_request") {
      rawSocket.write(JSON.stringify({ op: "unlock", uid }) + "\n");
      rawSocket.end();
      return { fallback: true };
    }
    throw new MbregistryError(response.error, response.code, response);
  }
  return { socket: rawSocket, unlockAndClose: () => rawSocket.end(), leftover };
}

function isFallback(result: StreamHandshakeResult | StreamHandshakeFallback): result is StreamHandshakeFallback {
  return "fallback" in result;
}

/** {@link MbregistryClient.stream}'s local-socket-first attempt (mbtools
 * 008-004) — a fresh connection to `endpoint` (this client's own
 * resolved local Unix socket/pipe), `lock` then `stream` on it via
 * {@link performStreamHandshake}. Returns `undefined` when that reports
 * a {@link StreamHandshakeFallback} — the caller falls back to the
 * remote TCP port unchanged. Any other failure (`locked`, `not_found`,
 * ...) propagates, and the attempt's own socket is always torn down on
 * any failure path (never left dangling). */
async function tryLocalSocketStream(
  endpoint: ResolvedEndpoint,
  connect: ConnectFn,
  uid: string,
  kind: LockKind,
  label: string | undefined,
): Promise<StreamHandshakeResult | undefined> {
  const socket = await openSocket(endpoint, connect);
  const conn = new JsonLinesConnection(socket);
  try {
    const result = await performStreamHandshake(conn, uid, kind, label);
    return isFallback(result) ? undefined : result;
  } catch (err) {
    socket.destroy();
    throw err;
  }
}

/**
 * Builds an {@link MbregistryClient}. Every external effect
 * (environment, the socket transport, `child_process.spawn`) is
 * injectable via `deps`, mirroring this codebase's `ConnectorDeps`/
 * `UsbWatcherDeps` convention — production code supplies none of them
 * and gets the real environment/`net`/`child_process`.
 */
export function createMbregistryClient(deps: MbregistryClientDeps = {}): MbregistryClient {
  const env = deps.env ?? process.env;
  const connect = deps.connect ?? defaultConnect;
  const spawnFn = deps.spawnFn ?? nodeSpawn;

  let controlConnection: JsonLinesConnection | undefined;
  let resolvedEndpoint: ResolvedEndpoint | undefined;
  let remotePort: number | undefined;
  let spawnedChild: ChildProcess | undefined;

  async function connectClient(): Promise<ResolvedEndpoint> {
    const resolved = await resolveMbregistryConnection({
      env,
      connect,
      spawnFn,
      shareBoards: deps.shareBoards,
      livenessTimeoutMs: deps.livenessTimeoutMs,
      spawnReadyTimeoutMs: deps.spawnReadyTimeoutMs,
      versionCheckTimeoutMs: deps.versionCheckTimeoutMs,
      homedirFn: deps.homedirFn,
    });
    controlConnection = new JsonLinesConnection(resolved.socket);
    resolvedEndpoint = resolved.endpoint;
    remotePort = resolved.remotePort;
    spawnedChild = resolved.child;
    return resolved.endpoint;
  }

  function requireConnection(): JsonLinesConnection {
    if (controlConnection === undefined) {
      throw new MbregistryError("mbregistryClient.connect() was not called", "connection_closed");
    }
    return controlConnection;
  }

  return {
    connect: connectClient,
    close(): void {
      controlConnection?.close();
      // A spawned instance is otherwise only tied to this process's own
      // exit (`--exit-with-parent`, watching this process's stdin-pipe
      // EOF) -- a graceful `close()` with the process still running
      // (`runtime.stop()`) would otherwise leak it. Closing its stdin
      // triggers that same `--exit-with-parent` EOF for a clean exit;
      // `kill()` is the backstop if it doesn't take.
      if (spawnedChild !== undefined) {
        spawnedChild.stdin?.end();
        spawnedChild.kill();
      }
    },
    async list(): Promise<RegistryDevice[]> {
      const response = unwrap(await requireConnection().request({ op: "list" }));
      return response.devices as RegistryDevice[];
    },
    async find(uid: string): Promise<RegistryDevice> {
      const response = unwrap(await requireConnection().request({ op: "find", uid }));
      return response.device as RegistryDevice;
    },
    async lock(uid: string, kind: LockKind, label?: string): Promise<void> {
      const op: Record<string, unknown> = { op: "lock", uid, kind };
      if (label !== undefined) {
        op.label = label;
      }
      unwrap(await requireConnection().request(op));
    },
    async unlock(uid: string): Promise<boolean> {
      const response = unwrap(await requireConnection().request({ op: "unlock", uid }));
      return response.released as boolean;
    },
    watch(): AsyncIterable<WatchEvent> {
      return requireConnection().watch();
    },
    async stream(
      uid: string,
      kind: Extract<LockKind, "serial" | "relay">,
      remoteEndpoint?: { host: string; port: number },
      label?: string,
    ): Promise<{ socket: net.Socket; unlockAndClose: () => void; leftover: Buffer }> {
      if (remoteEndpoint === undefined && resolvedEndpoint !== undefined && resolvedEndpoint.kind !== "tcp") {
        const local = await tryLocalSocketStream(resolvedEndpoint, connect, uid, kind, label);
        if (local !== undefined) {
          return local;
        }
      }
      const target = remoteEndpoint ?? (remotePort !== undefined ? { host: "127.0.0.1", port: remotePort } : undefined);
      if (target === undefined) {
        throw new MbregistryError("no remote endpoint known for stream() — pass one explicitly", "internal_error");
      }
      const socket = await openSocket({ kind: "tcp", host: target.host, port: target.port }, connect);
      const conn = new JsonLinesConnection(socket);
      try {
        const result = await performStreamHandshake(conn, uid, kind, label);
        if (isFallback(result)) {
          // The remote TCP API has supported `stream` since sprint 003 --
          // an `invalid_request` here means this mbregistry is far older
          // than robot-console's own MIN_MBREGISTRY_VERSION floor, not a
          // case to silently swallow.
          throw new MbregistryError("mbregistry's remote API does not support the 'stream' op", "invalid_request");
        }
        return result;
      } catch (err) {
        socket.destroy();
        throw err;
      }
    },
    get resolvedEndpoint(): ResolvedEndpoint | undefined {
      return resolvedEndpoint;
    },
    get remotePort(): number | undefined {
      return remotePort;
    },
  };
}
