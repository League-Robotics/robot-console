/**
 * daemon/daemonInfo.ts — read, write, and validate the one on-disk
 * record of "a host is running here" (sprint 021 ticket 003; issue
 * `shared-console-host-daemon-cli-and-discovery.md`; `sprint.md`'s own
 * module table entry for this file).
 *
 * A pure read/write/probe leaf: never spawns or stops a process, never
 * binds a port, and has no dependency on `server.ts`/`runtime.ts`. Used
 * both by the actual host process (`cli.ts`'s `main()`, which writes
 * this file the moment `startServer` resolves and removes it on
 * shutdown, for *every* way the host is started — not only via
 * `daemon/cli.ts`'s own `start`) and by the daemon CLI (`daemon/cli.ts`,
 * which reads and probes it to decide `start`/`stop`/`status`/`open`'s
 * own outcome).
 *
 * `{filePath, stateDir, env}` mirrors `store/wifiCredentials.ts`'s own
 * resolution convention (an explicit `filePath` override, else
 * `store/stateDir.ts`'s `resolveDaemonInfoFilePath`) — no fs injection
 * for the read/write/remove trio, matching that same module's own
 * convention: `daemonInfo.test.ts` exercises them against a real
 * temporary directory, not a faked filesystem. {@link probeHostInfo} is
 * the one function here that touches the network, so it alone accepts
 * an injectable `fetch` — `daemon/cli.test.ts` never calls it for real;
 * `daemonInfo.test.ts`'s own suite is where a fake `fetch` is used
 * directly.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { resolveDaemonInfoFilePath } from "../store/stateDir.js";

/** The on-disk shape of `daemon.json`. `startedAt` is `Date.now()`-style
 * epoch milliseconds, so `status`/`open` can report an uptime without a
 * second field. */
export interface DaemonInfo {
  readonly pid: number;
  readonly host: string;
  readonly port: number;
  readonly startedAt: number;
}

/** Resolution inputs shared by {@link writeDaemonInfo}/{@link readDaemonInfo}/
 * {@link removeDaemonInfo} — mirrors `WifiCredentialsStore`'s own
 * constructor options. */
export interface DaemonInfoFileOptions {
  /** Use this exact path, overriding {@link resolveDaemonInfoFilePath}'s
   * own state-dir resolution entirely. */
  filePath?: string;
  stateDir?: string;
  env?: NodeJS.ProcessEnv;
}

function isDaemonInfo(value: unknown): value is DaemonInfo {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { pid?: unknown }).pid === "number" &&
    typeof (value as { host?: unknown }).host === "string" &&
    typeof (value as { port?: unknown }).port === "number" &&
    typeof (value as { startedAt?: unknown }).startedAt === "number"
  );
}

/** Write `daemon.json`, creating the state directory if it does not yet
 * exist. Called by `cli.ts`'s `main()` immediately after `startServer`
 * resolves (the real, bound `server.port` — see that module's own
 * comment), and by `daemon/cli.ts`'s `runStart` has no need to call this
 * itself: the spawned child process does, via its own `main()` run. */
export function writeDaemonInfo(info: DaemonInfo, options: DaemonInfoFileOptions = {}): void {
  const filePath = resolveDaemonInfoFilePath(options, options.env ?? process.env);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(info, null, 2) + "\n", "utf8");
}

/** Read `daemon.json`. Returns `undefined` if the file is absent,
 * unreadable, or does not parse as a well-formed {@link DaemonInfo} —
 * callers treat all three identically ("no record of a running host"),
 * exactly like `WifiCredentialsStore`'s own `readFile`. */
export function readDaemonInfo(options: DaemonInfoFileOptions = {}): DaemonInfo | undefined {
  const filePath = resolveDaemonInfoFilePath(options, options.env ?? process.env);
  if (!existsSync(filePath)) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
    return isDaemonInfo(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Delete `daemon.json`. A no-op (never throws) if the file is already
 * absent — `runStart`/`runStop`/`runStatus` all call this on a stale
 * record without first checking whether it exists. */
export function removeDaemonInfo(options: DaemonInfoFileOptions = {}): void {
  const filePath = resolveDaemonInfoFilePath(options, options.env ?? process.env);
  try {
    rmSync(filePath, { force: true });
  } catch {
    // Best-effort -- a permissions error here must not crash a shutdown
    // or a `status`/`start` call; the file simply stays until it can be
    // removed (or is overwritten by a fresh `writeDaemonInfo`).
  }
}

/** Is `pid` a currently-live process? `process.kill(pid, 0)` sends no
 * signal, only checks existence/permission -- throws (ESRCH: gone,
 * EPERM: exists but owned by someone else, which this project treats as
 * "alive" since a stale daemon.json is never expected to name a process
 * this same user does not own) exactly as sprint 018's
 * `clearDeadProcessState` already established for the store's own
 * dead-process bookkeeping ("is this PID still real"). */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The shape `GET <url>/api/host-info` (`server.ts`) answers with --
 * same contract `cli.ts`'s own `HostInfoProbeResult` checks for the
 * `EADDRINUSE`-attach decision (ticket 001). Redeclared here rather than
 * imported from `cli.ts`: `daemon/*` depends outward from the
 * composition root, never the other way (`sprint.md`'s own dependency-graph
 * note) -- `cli.ts` importing `daemon/cli.ts` and `daemon/daemonInfo.ts`
 * importing `cli.ts` would be a cycle. */
export interface HostInfoProbeResult {
  readonly ok: boolean;
  readonly service?: string;
  readonly port?: number;
}

function isHostInfoProbeResult(value: unknown): value is HostInfoProbeResult {
  return typeof value === "object" && value !== null && "ok" in value;
}

/** Bounded-timeout default for {@link probeHostInfo} when its own
 * `timeoutMs` is omitted -- generous for a loopback round trip
 * (mirrors `cli.ts`'s own `HOST_INFO_PROBE_TIMEOUT_MS`) while still
 * failing fast against a port nothing is listening on. */
const DEFAULT_PROBE_TIMEOUT_MS = 3000;

/** Injectable `fetch` seam -- {@link probeHostInfo}'s only network
 * dependency. Defaults to the real global `fetch`; `daemonInfo.test.ts`
 * injects a fake here directly (success, timeout, malformed-response
 * cases) so this module's own suite never opens a real socket. */
export interface ProbeHostInfoDeps {
  fetch?: typeof fetch;
}

/** `GET <url>/api/host-info` with a bounded timeout. Returns the parsed
 * `{ok, service, port}` body, or `undefined` for anything that is not a
 * clean, parseable, `ok`-bearing JSON response -- a connection error, a
 * timeout, a non-2xx status, or a body that fails to parse. Never
 * throws. */
export async function probeHostInfo(
  url: string,
  timeoutMs: number = DEFAULT_PROBE_TIMEOUT_MS,
  deps: ProbeHostInfoDeps = {},
): Promise<HostInfoProbeResult | undefined> {
  const fetchFn = deps.fetch ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchFn(url, { signal: controller.signal });
    if (!response.ok) {
      return undefined;
    }
    const data: unknown = await response.json();
    return isHostInfoProbeResult(data) ? data : undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}
