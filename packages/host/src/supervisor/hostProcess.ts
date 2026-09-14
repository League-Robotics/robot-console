/**
 * hostProcess.ts — owns exactly one child `robot-console` host process
 * for the supervisor (`supervisor.ts`): spawning it, deciding when it is
 * actually ready (its port accepts TCP connections), and stopping it
 * with SIGTERM followed by SIGKILL after a generous timeout.
 *
 * ## Why readiness is "the port accepts a connection", not a log line
 *
 * The real host prints `listening on ...` once its server is up, but a
 * log-line contract is fragile (and a test double would have to mimic
 * the exact wording). A successful TCP connect to `127.0.0.1:<hostPort>`
 * is the one thing the supervisor actually needs before it can pipe a
 * WebSocket upgrade through, so that is what it waits for.
 *
 * ## Why stopping waits so long before SIGKILL
 *
 * The host's own SIGTERM handler (`cli.ts`'s `installShutdownHandlers`)
 * waits for any in-flight flash to finish before it exits -- killing it
 * mid-write can leave a board without firmware. The default kill timeout
 * is therefore minutes, not seconds; SIGKILL is only the backstop for a
 * host that is genuinely wedged.
 *
 * This module holds no *policy* (when to start, when to stop, whether to
 * restart after a crash) -- `supervisor.ts` decides all of that from the
 * `onExit` callback's `expected` flag.
 */

import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import net from "node:net";
import readline from "node:readline";

export type HostState = "stopped" | "starting" | "running" | "stopping";

export interface HostExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** `Date.now()` at exit. */
  at: number;
  /** `true` when {@link HostProcess.stop} asked for this exit. */
  expected: boolean;
  /** How long the host had been `running` (ms), or `null` if it never
   * became ready. `supervisor.ts` uses this to reset its restart backoff
   * after a long stable run. */
  ranForMs: number | null;
}

export interface HostProcessOptions {
  /** argv, `command[0]` being the executable. */
  command: readonly string[];
  env: NodeJS.ProcessEnv;
  /** Port the host listens on (probed for readiness). */
  port: number;
  /** Address probed for readiness. Defaults to `127.0.0.1`. */
  address?: string;
  /** Delay between readiness probes. Defaults to 100 ms. */
  readyPollMs?: number;
  /** SIGTERM -> SIGKILL grace. Defaults to 120 s (see module doc). */
  killTimeoutMs?: number;
  /** One line of supervisor log output. */
  log: (line: string) => void;
  /** Called on every child exit, expected or not. */
  onExit?: (info: HostExitInfo) => void;
  /** Injectable for tests; defaults to `child_process.spawn`. */
  spawn?: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
  /** Injectable for tests; resolves `true` if a TCP connect succeeds. */
  probe?: (port: number, address: string) => Promise<boolean>;
}

/** One TCP connect attempt, closed immediately on success. */
export function probePort(port: number, address: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: address });
    const done = (ok: boolean) => {
      socket.removeAllListeners();
      socket.on("error", () => undefined);
      socket.destroy();
      resolve(ok);
    };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.setTimeout(1000, () => done(false));
  });
}

export class HostProcess extends EventEmitter {
  private stateValue: HostState = "stopped";
  private child: ChildProcess | null = null;
  private runningSince: number | null = null;
  private stopPromise: Promise<void> | null = null;
  private stopRequested = false;
  private readonly readyPollMs: number;
  private readonly killTimeoutMs: number;
  private readonly address: string;
  private readonly spawnFn: NonNullable<HostProcessOptions["spawn"]>;
  private readonly probeFn: NonNullable<HostProcessOptions["probe"]>;

  constructor(private readonly options: HostProcessOptions) {
    super();
    this.readyPollMs = options.readyPollMs ?? 100;
    this.killTimeoutMs = options.killTimeoutMs ?? 120_000;
    this.address = options.address ?? "127.0.0.1";
    this.spawnFn = options.spawn ?? nodeSpawn;
    this.probeFn = options.probe ?? probePort;
  }

  get state(): HostState {
    return this.stateValue;
  }

  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  private setState(state: HostState): void {
    if (this.stateValue === state) {
      return;
    }
    this.stateValue = state;
    this.emit("state", state);
  }

  /** Spawn the host if it is `stopped`; a no-op in any other state. */
  start(): void {
    if (this.stateValue !== "stopped") {
      return;
    }
    const [executable, ...args] = this.options.command;
    if (executable === undefined) {
      throw new Error("host command is empty");
    }
    this.stopRequested = false;
    this.runningSince = null;
    this.setState("starting");

    let child: ChildProcess;
    try {
      child = this.spawnFn(executable, args, { env: this.options.env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      this.options.log(`failed to spawn host: ${error instanceof Error ? error.message : String(error)}`);
      this.setState("stopped");
      this.options.onExit?.({ code: null, signal: null, at: Date.now(), expected: false, ranForMs: null });
      return;
    }
    this.child = child;
    this.options.log(`host starting (pid ${child.pid ?? "?"}): ${this.options.command.join(" ")}`);

    for (const stream of [child.stdout, child.stderr]) {
      if (stream) {
        readline.createInterface({ input: stream }).on("line", (line) => this.options.log(`[host] ${line}`));
      }
    }

    // A spawn failure (ENOENT, EACCES) surfaces as "error" and may never
    // produce "exit"; treat both as the one exit.
    let exited = false;
    const onGone = (code: number | null, signal: NodeJS.Signals | null) => {
      if (exited) {
        return;
      }
      exited = true;
      const info: HostExitInfo = {
        code,
        signal,
        at: Date.now(),
        expected: this.stopRequested,
        ranForMs: this.runningSince === null ? null : Date.now() - this.runningSince,
      };
      this.options.log(
        `host ${info.expected ? "stopped" : "exited unexpectedly"} (pid ${child.pid ?? "?"}, ` +
          `${signal ? `signal ${signal}` : `code ${code}`})`,
      );
      if (this.child === child) {
        this.child = null;
        this.runningSince = null;
        this.setState("stopped");
      }
      this.options.onExit?.(info);
    };
    child.once("exit", onGone);
    child.once("error", (error) => {
      this.options.log(`host process error: ${error.message}`);
      onGone(null, null);
    });

    void this.waitForPort(child);
  }

  /** Probe until the port accepts, the child goes away, or a stop is
   * requested. */
  private async waitForPort(child: ChildProcess): Promise<void> {
    while (this.child === child && this.stateValue === "starting") {
      if (await this.probeFn(this.options.port, this.address)) {
        // Re-check: the child may have exited (or been stopped) while
        // the probe was in flight -- then something else answered.
        if (this.child === child && this.stateValue === "starting") {
          this.runningSince = Date.now();
          this.options.log(`host running on ${this.address}:${this.options.port} (pid ${child.pid ?? "?"})`);
          this.setState("running");
        }
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, this.readyPollMs));
    }
  }

  /**
   * SIGTERM the host and resolve once it has exited, escalating to
   * SIGKILL after the kill timeout. Resolves immediately when already
   * stopped; concurrent callers share one stop.
   */
  stop(): Promise<void> {
    const child = this.child;
    if (child === null) {
      return Promise.resolve();
    }
    if (this.stopPromise) {
      return this.stopPromise;
    }
    this.stopRequested = true;
    this.setState("stopping");
    this.options.log(`stopping host (pid ${child.pid ?? "?"})`);
    this.stopPromise = new Promise<void>((resolve) => {
      const killTimer = setTimeout(() => {
        this.options.log(`host did not exit within ${this.killTimeoutMs} ms -- sending SIGKILL`);
        child.kill("SIGKILL");
      }, this.killTimeoutMs);
      const finish = () => {
        clearTimeout(killTimer);
        this.stopPromise = null;
        resolve();
      };
      if (child.exitCode !== null || child.signalCode !== null) {
        finish();
        return;
      }
      child.once("exit", finish);
      child.once("error", finish);
      child.kill("SIGTERM");
    });
    return this.stopPromise;
  }

  /**
   * Resolve `true` as soon as the host is `running`, or `false` after
   * `timeoutMs` (or when `abort` fires). Does not start anything itself
   * -- starting is `supervisor.ts`'s policy.
   */
  waitUntilRunning(timeoutMs: number, abort?: AbortSignal): Promise<boolean> {
    if (this.stateValue === "running") {
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      const cleanup = (result: boolean) => {
        clearTimeout(timer);
        this.off("state", onState);
        abort?.removeEventListener("abort", onAbort);
        resolve(result);
      };
      const onState = (state: HostState) => {
        if (state === "running") {
          cleanup(true);
        }
      };
      const onAbort = () => cleanup(false);
      const timer = setTimeout(() => cleanup(false), timeoutMs);
      this.on("state", onState);
      abort?.addEventListener("abort", onAbort, { once: true });
    });
  }
}
