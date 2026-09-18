/**
 * daemon/cli.ts — the `start`/`stop`/`status`/`open` subcommands'
 * decision logic (sprint 021 ticket 003; issue
 * `shared-console-host-daemon-cli-and-discovery.md`; `sprint.md`'s own
 * module table entry for this file).
 *
 * ## No runtime is ever built here -- the pre-spawn probe comes first
 *
 * Ticket 001's own `main()` (`cli.ts`) already builds a full runtime
 * (store + USB/mDNS/firmware watchers) *before* it can discover an
 * `EADDRINUSE` conflict and decide to attach -- see that module's own
 * comment on why `runtime.stop()` closes that window but does not
 * prevent it from opening in the first place (a slow tick could, in
 * principle, still reach out for hardware in the brief gap). This module
 * takes the opposite order for the same reason 021's own issue calls out
 * as the root defect: {@link runStart} probes `GET /api/host-info`
 * (`daemon/daemonInfo.ts`'s {@link probeHostInfo}) *before* importing or
 * constructing anything that could touch a serial port, a USB HID
 * device, or a radio -- the only things this module imports are
 * `daemonInfo.ts` (a pure read/write/probe leaf) and `store/stateDir.ts`
 * (path resolution only). Nothing here can acquire hardware, because
 * nothing here even has a way to try until a real child process is
 * spawned -- and that spawn only happens after the probe has already
 * said "nothing is answering here".
 *
 * ## Detecting a running host without depending on bind failure
 *
 * `sprint.md`'s own Design Rationale ("Bind address: 0.0.0.0") means a
 * fresh `0.0.0.0` bind does **not** conflict with an older, still-running
 * build bound to `127.0.0.1` alone (confirmed empirically in ticket 002)
 * -- Node's default `SO_REUSEADDR` lets both listen. A detection strategy
 * built on `EADDRINUSE` would therefore silently miss exactly the
 * process most likely to already be running on a bench Mac: a
 * pre-ticket-002 `npm run dev`. {@link runStart}/{@link runStatus} never
 * rely on a bind attempt at all -- they always probe
 * `http://127.0.0.1:<DEFAULT_PORT>/api/host-info` first. Loopback HTTP
 * reaches a `127.0.0.1`-only listener and a `0.0.0.0` listener alike, so
 * this one probe is authoritative regardless of which build is actually
 * running. Only if nothing answers does {@link runStart} go on to
 * attempt a spawn -- and if something *does* occupy the port without
 * identifying as robot-console, the spawned child's own existing
 * `PortInUseError`/probe hard-fail (ticket 001, unchanged) is what
 * surfaces the genuine conflict, so this module does not need to
 * duplicate that decision.
 *
 * ## `stop` and session release
 *
 * `stop` sends `SIGTERM` and waits (bounded) for the process to actually
 * exit -- it never reports "stopped" from the mere act of sending a
 * signal. This is what makes it honest about hardware release: sprint
 * 021 ticket 003 also fixed `connect/reconciler.ts`'s own `stop()`
 * (issue `reconciler-stop-leaks-open-sessions.md`) to close every session
 * it still holds, and `cli.ts`'s shutdown handler awaits that (via
 * `runtime.stop()`) *before* calling `exit(0)` -- so a process that has
 * actually exited has, by construction, already released every session
 * it held. If the process does not exit within the bounded wait (a stuck
 * shutdown), {@link runStop} reports that plainly rather than claiming
 * success.
 *
 * ## Boundary
 *
 * Depends on: `daemon/daemonInfo.ts`, `store/stateDir.ts`,
 * `browserOpen.ts` (the `openInChrome` `open`-package wrapper also used
 * by `cli.ts` -- factored out specifically so this module and `cli.ts`
 * can each depend on it without depending on each other, since `cli.ts`
 * imports this module for its own `start`/`stop`/`status`/`open`
 * dispatch). Never imports `runtime.ts`/`server.ts`/`store/index.ts`, or
 * `cli.ts` itself -- everything this module needs to know about the
 * actual host process comes from `daemonInfo.ts` and the `/api/host-info`
 * probe, not from importing the host's own internals into a CLI-only
 * process. `start` spawns `bin/robot-console.js` (unmodified in its own
 * foreground behavior) as a detached child; that child is what actually
 * builds the runtime, in its own process.
 *
 * Every collaborator is injectable via {@link DaemonCliDeps}, mirroring
 * `cli.ts`'s own `CliDeps` seam -- `daemon/cli.test.ts` never spawns a
 * real child process or touches the real filesystem/network.
 */
import { spawn as nodeSpawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openInChrome } from "../browserOpen.js";
import { resolveDaemonLogFilePath } from "../store/stateDir.js";
import {
  isProcessAlive as defaultIsProcessAlive,
  probeHostInfo as defaultProbeHostInfo,
  readDaemonInfo as defaultReadDaemonInfo,
  removeDaemonInfo as defaultRemoveDaemonInfo,
  type DaemonInfo,
  type HostInfoProbeResult,
} from "./daemonInfo.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** The one port every daemon verb operates against -- `sprint.md`'s own
 * Design Rationale ("the daemon verbs manage exactly one instance,
 * always the default port"): none of `start`/`stop`/`status`/`open`
 * accept or forward a `--port`. Duplicated from `server.ts`'s own
 * `DEFAULT_PORT` (not imported) -- see this module's own doc comment on
 * why `daemon/*` never imports `server.ts`. */
const DEFAULT_PORT = 4795;

/** `packages/host/src/daemon/cli.ts` -> `<repo root>/bin/robot-console.js`
 * -- the same, unmodified foreground entry point `start` spawns
 * detached. Resolved the same module-relative way
 * `store/wifiCredentials.ts`'s own `defaultDotenvPath` resolves the
 * repo's `.env` (four `..` segments: daemon -> src -> host -> packages
 * -> repo root), so it works the same whether this file runs from
 * source (`tsx`) or from `dist/` (the build mirrors this same relative
 * depth). */
function defaultBinPath(): string {
  return path.resolve(__dirname, "../../../../bin/robot-console.js");
}

function buildLocalUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}

/** The LAN-shareable URL a person on a different bench machine can paste
 * into their own browser -- `os.hostname()` is the same `<name>.local`
 * convention `discovery/consoleAdvertiser.ts` already advertises under
 * (ticket 002), and the one identity this same process's own hostname
 * cannot disagree with. Deliberately not `RunningServer.host`/`.url`'s
 * literal `0.0.0.0` -- that is a bind address, not a dialable one (see
 * this module's own doc comment). */
function buildShareableUrl(port: number): string {
  return `http://${os.hostname()}.local:${port}`;
}

/** Builds a `{stateDir?, env}` options bag without an explicit
 * `stateDir: undefined` key -- `exactOptionalPropertyTypes` treats "key
 * present with value `undefined`" as distinct from "key absent", and
 * `daemonInfo.ts`'s own option types (mirroring `store/wifiCredentials.ts`'s
 * convention) declare `stateDir?: string`, not `string | undefined`. */
function fileOptions(stateDir: string | undefined, env: NodeJS.ProcessEnv): { stateDir?: string; env: NodeJS.ProcessEnv } {
  return stateDir !== undefined ? { stateDir, env } : { env };
}

function isRobotConsole(identity: HostInfoProbeResult | undefined): identity is HostInfoProbeResult {
  return identity?.ok === true && identity.service === "robot-console";
}

function formatUptime(uptimeMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(uptimeMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

/** A spawned child -- the narrow slice of Node's own `ChildProcess` this
 * module actually uses. */
export interface SpawnedChildLike {
  readonly pid?: number | undefined;
  unref(): void;
}

/** Injectable `spawn` seam. The real default wraps `node:child_process`'s
 * own `spawn`; `daemon/cli.test.ts` always injects a fake here, so no
 * test in that suite ever starts a real child process. */
export interface SpawnOptionsLike {
  detached?: boolean;
  stdio?: Array<number | "ignore" | "inherit">;
  env?: NodeJS.ProcessEnv;
}
export type SpawnFn = (command: string, args: readonly string[], options: SpawnOptionsLike) => SpawnedChildLike;

const defaultSpawn: SpawnFn = (command, args, options) => nodeSpawn(command, [...args], options);

/** Injectable seams for every exported `run*` function here -- mirrors
 * `cli.ts`'s own `CliDeps` convention ("real defaults, fakes in tests").
 * Every field defaults to the real implementation. */
export interface DaemonCliDeps {
  probeHostInfo?: typeof defaultProbeHostInfo;
  readDaemonInfo?: typeof defaultReadDaemonInfo;
  removeDaemonInfo?: typeof defaultRemoveDaemonInfo;
  isProcessAlive?: typeof defaultIsProcessAlive;
  spawn?: SpawnFn;
  /** Sends a signal to a pid. Defaults to `process.kill`. Injectable so
   * `daemon/cli.test.ts` never signals a real process. */
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  /** Opens a local browser. Defaults to {@link openInChrome}. */
  openBrowser?: (url: string) => Promise<void>;
  /** Opens (creating if needed) the daemon log file for the spawned
   * child's stdout/stderr, returning a file descriptor. Defaults to a
   * real, append-mode `fs.openSync`. */
  openLogFd?: (logPath: string) => number;
  closeLogFd?: (fd: number) => void;
  env?: NodeJS.ProcessEnv;
  /** Overrides `daemon.json`'s resolved state directory (forwarded to
   * every real `daemonInfo.ts` default above). Mirrors
   * `DaemonInfoFileOptions.stateDir`. */
  stateDir?: string;
  /** Absolute path to `bin/robot-console.js`. Defaults to
   * {@link defaultBinPath}. Injectable purely so a test could point at a
   * fixture script -- `daemon/cli.test.ts`'s own suite fakes `spawn`
   * itself instead, so this is rarely overridden in practice. */
  binPath?: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Overrides {@link DEFAULT_PORT}. **Never** wired to argv/env/a
   * `--port` flag anywhere -- the daemon verbs' own CLI surface always
   * operates against the one real default port (`sprint.md`'s Design
   * Rationale). This exists solely so `daemon/cli.test.ts`'s own
   * real-process integration test can point a genuine spawned child at a
   * scratch port instead of the actual default port, which a real,
   * already-running `robot-console` (or another test) may currently
   * occupy. */
  port?: number;
  /** Timeout for the pre-spawn/status identity probe. Defaults to 3000. */
  probeTimeoutMs?: number;
  /** Bounded wait for a freshly spawned child to answer `/api/host-info`.
   * Defaults to 10000. */
  readyTimeoutMs?: number;
  readyPollIntervalMs?: number;
  /** Bounded wait for `stop`'s `SIGTERM` to actually end the process.
   * Defaults to 10000. */
  stopTimeoutMs?: number;
  stopPollIntervalMs?: number;
}

interface ResolvedDeps {
  probeHostInfoFn: (url: string, timeoutMs: number) => Promise<HostInfoProbeResult | undefined>;
  readDaemonInfoFn: () => DaemonInfo | undefined;
  removeDaemonInfoFn: () => void;
  isProcessAliveFn: (pid: number) => boolean;
  spawnFn: SpawnFn;
  killFn: (pid: number, signal: NodeJS.Signals) => void;
  openBrowserFn: (url: string) => Promise<void>;
  openLogFdFn: (logPath: string) => number;
  closeLogFdFn: (fd: number) => void;
  env: NodeJS.ProcessEnv;
  stateDir: string | undefined;
  binPath: string;
  port: number;
  nowFn: () => number;
  sleepFn: (ms: number) => Promise<void>;
  probeTimeoutMs: number;
  readyTimeoutMs: number;
  readyPollIntervalMs: number;
  stopTimeoutMs: number;
  stopPollIntervalMs: number;
}

function resolveDeps(deps: DaemonCliDeps): ResolvedDeps {
  const env = deps.env ?? process.env;
  const stateDir = deps.stateDir;
  return {
    probeHostInfoFn: deps.probeHostInfo ?? defaultProbeHostInfo,
    readDaemonInfoFn: () => (deps.readDaemonInfo ?? defaultReadDaemonInfo)(fileOptions(stateDir, env)),
    removeDaemonInfoFn: () => (deps.removeDaemonInfo ?? defaultRemoveDaemonInfo)(fileOptions(stateDir, env)),
    isProcessAliveFn: deps.isProcessAlive ?? defaultIsProcessAlive,
    spawnFn: deps.spawn ?? defaultSpawn,
    killFn: deps.kill ?? ((pid, signal) => process.kill(pid, signal)),
    openBrowserFn: deps.openBrowser ?? openInChrome,
    openLogFdFn: deps.openLogFd ?? ((logPath) => openSync(logPath, "a")),
    closeLogFdFn: deps.closeLogFd ?? ((fd) => closeSync(fd)),
    env,
    stateDir,
    binPath: deps.binPath ?? defaultBinPath(),
    port: deps.port ?? DEFAULT_PORT,
    nowFn: deps.now ?? (() => Date.now()),
    sleepFn: deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    probeTimeoutMs: deps.probeTimeoutMs ?? 3000,
    readyTimeoutMs: deps.readyTimeoutMs ?? 10_000,
    readyPollIntervalMs: deps.readyPollIntervalMs ?? 200,
    stopTimeoutMs: deps.stopTimeoutMs ?? 10_000,
    stopPollIntervalMs: deps.stopPollIntervalMs ?? 200,
  };
}

export type StartOutcome =
  | { outcome: "already-running"; url: string }
  | { outcome: "started"; url: string; pid?: number };

/**
 * `start` -- see the module doc comment's "No runtime is ever built
 * here" and "Detecting a running host" sections for why this probes
 * before doing anything else, and never relies on `EADDRINUSE`.
 *
 * Order: (1) probe `127.0.0.1:<DEFAULT_PORT>/api/host-info` -- a
 * positive identification means a host is already running, so this
 * returns without spawning anything, full stop. (2) If nothing
 * identified, check `daemon.json`: a record naming a pid that is no
 * longer alive is stale -- removed here, and treated as "not running"
 * (acceptance criterion: "killed out from under it ... detects the
 * stale file, removes it, and starts fresh"). A record naming a pid
 * that *is* still alive, despite not answering the probe, is left alone
 * and refuses to spawn -- an ambiguous state (still starting, or hung)
 * this module deliberately does not paper over by risking a second live
 * host on the same port. (3) Spawn `bin/robot-console.js --no-open`
 * detached, stdio appended to `console.log`, `.unref()`d, then poll
 * (bounded) for it to answer the same probe before returning its URL.
 * `--no-open`: a daemon start is not necessarily at a machine with
 * anyone watching (an agent could run it) -- browser-launching stays the
 * dedicated, deliberate job of {@link runOpen}, per the stakeholder's own
 * "additional function to open a browser" phrasing (additional to, not
 * implied by, `start`).
 */
export async function runStart(deps: DaemonCliDeps = {}): Promise<StartOutcome> {
  const d = resolveDeps(deps);
  const localUrl = buildLocalUrl(d.port);

  const identity = await d.probeHostInfoFn(`${localUrl}/api/host-info`, d.probeTimeoutMs);
  if (isRobotConsole(identity)) {
    const url = buildLocalUrl(identity.port ?? d.port);
    console.log(`robot-console: already running at ${url}.`);
    return { outcome: "already-running", url };
  }

  const info = d.readDaemonInfoFn();
  if (info !== undefined) {
    if (!d.isProcessAliveFn(info.pid)) {
      console.log(`robot-console: removing stale daemon-info (pid ${info.pid} is not running).`);
      d.removeDaemonInfoFn();
    } else {
      throw new Error(
        `robot-console: pid ${info.pid} is recorded as running but ${localUrl}/api/host-info did not respond -- ` +
          "not starting a second instance. If it is stuck, run `robot-console stop` or remove its daemon-info " +
          "file and try again.",
      );
    }
  }

  const logPath = resolveDaemonLogFilePath(d.stateDir !== undefined ? { stateDir: d.stateDir } : {}, d.env);
  const logFd = d.openLogFdFn(logPath);
  let child: SpawnedChildLike;
  try {
    child = d.spawnFn(process.execPath, [d.binPath, "--no-open"], {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: d.env,
    });
    child.unref();
  } finally {
    d.closeLogFdFn(logFd);
  }

  const deadline = d.nowFn() + d.readyTimeoutMs;
  for (;;) {
    const readyIdentity = await d.probeHostInfoFn(`${localUrl}/api/host-info`, d.probeTimeoutMs);
    if (isRobotConsole(readyIdentity)) {
      const url = buildLocalUrl(readyIdentity.port ?? d.port);
      console.log(`robot-console: started, listening at ${url}.`);
      return child.pid !== undefined ? { outcome: "started", url, pid: child.pid } : { outcome: "started", url };
    }
    if (d.nowFn() >= deadline) {
      throw new Error(
        `robot-console: start failed -- no response from ${localUrl} within ${d.readyTimeoutMs}ms; check ${logPath} for details.`,
      );
    }
    await d.sleepFn(d.readyPollIntervalMs);
  }
}

export type StopOutcome =
  | { outcome: "not-running" }
  | { outcome: "stopped"; pid: number }
  | { outcome: "timed-out"; pid: number };

/**
 * `stop` -- see the module doc comment's "stop and session release"
 * section for why waiting for the process to actually exit is what
 * makes this honest about hardware release, not merely sending a
 * signal.
 */
export async function runStop(deps: DaemonCliDeps = {}): Promise<StopOutcome> {
  const d = resolveDeps(deps);
  const info = d.readDaemonInfoFn();
  if (info === undefined) {
    console.log("robot-console: not running.");
    return { outcome: "not-running" };
  }
  if (!d.isProcessAliveFn(info.pid)) {
    console.log(`robot-console: not running (removing stale daemon-info; pid ${info.pid} is not running).`);
    d.removeDaemonInfoFn();
    return { outcome: "not-running" };
  }

  d.killFn(info.pid, "SIGTERM");
  const deadline = d.nowFn() + d.stopTimeoutMs;
  while (d.isProcessAliveFn(info.pid) && d.nowFn() < deadline) {
    await d.sleepFn(d.stopPollIntervalMs);
  }

  if (d.isProcessAliveFn(info.pid)) {
    console.warn(
      `robot-console: sent SIGTERM to pid ${info.pid} but it is still running after ${d.stopTimeoutMs}ms -- ` +
        "not removing daemon-info; it may still be holding open sessions. Try again, or investigate the process directly.",
    );
    return { outcome: "timed-out", pid: info.pid };
  }

  // The process actually exited -- `cli.ts`'s own shutdown handler never
  // calls `exit(0)` until `runtime.stop()` (which closes every open
  // session -- see the module doc comment) has resolved, so a gone pid
  // here means the hardware was actually released, not merely that a
  // signal was sent.
  d.removeDaemonInfoFn();
  console.log(`robot-console: stopped (pid ${info.pid}).`);
  return { outcome: "stopped", pid: info.pid };
}

export type StatusOutcome =
  | { outcome: "not-running" }
  | { outcome: "running"; url: string; port: number; uptimeMs?: number };

/**
 * `status` -- probes the default port directly, exactly like
 * {@link runStart}'s own first step (see the module doc comment), so a
 * host with no `daemon.json` at all (an old, pre-ticket-003 build, or one
 * started by hand without ever going through `start`) is still correctly
 * reported as running rather than "not running" for want of a file this
 * module happens to own.
 */
export async function runStatus(deps: DaemonCliDeps = {}): Promise<StatusOutcome> {
  const d = resolveDeps(deps);
  const localUrl = buildLocalUrl(d.port);

  const identity = await d.probeHostInfoFn(`${localUrl}/api/host-info`, d.probeTimeoutMs);
  if (isRobotConsole(identity)) {
    const port = identity.port ?? d.port;
    const url = buildLocalUrl(port);
    const info = d.readDaemonInfoFn();
    const uptimeMs = info !== undefined ? Math.max(0, d.nowFn() - info.startedAt) : undefined;
    console.log(`robot-console: running at ${url}${uptimeMs !== undefined ? ` (up ${formatUptime(uptimeMs)})` : ""}.`);
    return uptimeMs !== undefined ? { outcome: "running", url, port, uptimeMs } : { outcome: "running", url, port };
  }

  const info = d.readDaemonInfoFn();
  if (info !== undefined) {
    console.log(`robot-console: not running (removing stale daemon-info; pid ${info.pid} did not answer).`);
    d.removeDaemonInfoFn();
  } else {
    console.log("robot-console: not running.");
  }
  return { outcome: "not-running" };
}

export type OpenOutcome = { outcome: "not-running" } | { outcome: "opened"; localUrl: string; shareableUrl: string };

/**
 * `open` -- opens a local browser at the running host's own URL (falling
 * back to the OS default if Chrome is not installed, via
 * {@link openInChrome}) and prints a LAN-shareable
 * `http://<hostname>.local:<port>` line any other bench machine can
 * paste into its own browser -- resolving the `RunningServer.host`
 * literal `0.0.0.0` problem the module doc comment describes. Never
 * calls `openBrowser` at all when nothing is running.
 */
export async function runOpen(deps: DaemonCliDeps = {}): Promise<OpenOutcome> {
  const d = resolveDeps(deps);
  const status = await runStatus(deps);
  if (status.outcome !== "running") {
    console.log("robot-console: not running -- run `robot-console start` first.");
    return { outcome: "not-running" };
  }

  const shareableUrl = buildShareableUrl(status.port);
  try {
    await d.openBrowserFn(status.url);
  } catch (error) {
    console.warn(
      `robot-console: could not open a browser automatically (${
        error instanceof Error ? error.message : String(error)
      }) -- open ${status.url} manually.`,
    );
  }
  console.log(`robot-console: share this with another bench machine: ${shareableUrl}`);
  return { outcome: "opened", localUrl: status.url, shareableUrl };
}
