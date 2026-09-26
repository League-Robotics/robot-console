/**
 * supervisor/cli.ts — argv/env parsing and signal handling behind
 * `bin/robot-console-supervisor.js`. The behaviour itself lives in
 * `supervisor.ts`; this module only turns configuration into
 * {@link SupervisorOptions} and wires SIGINT/SIGTERM to a clean stop.
 *
 * Configuration (flag wins over env, env over default):
 *
 *   --port <n>        ROBOT_CONSOLE_PORT                  4795    public port
 *   --host-port <n>   ROBOT_CONSOLE_HOST_PORT             4796    host child port
 *   --ui-dir <path>   ROBOT_CONSOLE_UI_DIR                packages/ui/dist
 *                     ROBOT_CONSOLE_IDLE_MS               30000
 *                     ROBOT_CONSOLE_HOST_START_TIMEOUT_MS 30000
 *                     ROBOT_CONSOLE_HOST_KILL_TIMEOUT_MS  120000
 *                     ROBOT_CONSOLE_HOST_COMMAND          JSON argv array; default
 *                       [node, bin/robot-console.js, --no-open, --port, <host port>]
 *
 * The host child inherits the supervisor's env (so
 * `ROBOT_CONSOLE_STATE_DIR` and friends pass through) with
 * `ROBOT_CONSOLE_PORT` overridden to the host port -- the public port
 * belongs to the supervisor, and an inherited value would make the host
 * collide with it -- and `ROBOT_CONSOLE_NO_OPEN=1`, since a service must
 * never pop a browser. A custom `ROBOT_CONSOLE_HOST_COMMAND` receives
 * the same env, which is how it learns its port.
 *
 * Every collaborator is injectable through {@link SupervisorCliDeps},
 * the same seam `../cli.ts` uses, so tests never touch real signals'
 * default behaviour or `process.exit`.
 */

import { startSupervisor, defaultHostBin, defaultUiDir, type RunningSupervisor, type SupervisorOptions } from "./supervisor.js";
import { getCliVersion } from "../cliVersion.js";

export interface SupervisorCliDeps {
  startSupervisor?: (options: SupervisorOptions) => Promise<RunningSupervisor>;
  exit?: (code: number) => void;
  log?: (line: string) => void;
  /** Merged over the parsed options (tests: fast backoff, spawn fakes). */
  overrides?: Partial<SupervisorOptions>;
}

export interface SupervisorConfig {
  port: number;
  hostPort: number;
  uiDir: string;
  idleMs: number;
  startTimeoutMs: number;
  killTimeoutMs: number;
  hostCommand: string[];
  hostEnv: NodeJS.ProcessEnv;
}

function flagValue(argv: readonly string[], name: string): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === name) {
      return argv[i + 1];
    }
    if (arg?.startsWith(`${name}=`)) {
      return arg.slice(name.length + 1);
    }
  }
  return undefined;
}

function parseInteger(raw: string | undefined, label: string, fallback: number, min = 0): number {
  if (raw === undefined || raw === "") {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) {
    throw new Error(`${label} must be an integer >= ${min} (got ${JSON.stringify(raw)})`);
  }
  return value;
}

/** Resolve configuration from argv + env; throws a one-line error on
 * invalid input. */
export function parseSupervisorConfig(argv: readonly string[], env: NodeJS.ProcessEnv): SupervisorConfig {
  const port = parseInteger(flagValue(argv, "--port") ?? env.ROBOT_CONSOLE_PORT, "port", 4795);
  const hostPort = parseInteger(flagValue(argv, "--host-port") ?? env.ROBOT_CONSOLE_HOST_PORT, "host port", 4796, 1);
  if (port === hostPort) {
    throw new Error(`public port and host port are both ${port}; set ROBOT_CONSOLE_HOST_PORT to a different port`);
  }
  const uiDir = flagValue(argv, "--ui-dir") ?? (env.ROBOT_CONSOLE_UI_DIR || defaultUiDir());
  const idleMs = parseInteger(env.ROBOT_CONSOLE_IDLE_MS, "ROBOT_CONSOLE_IDLE_MS", 30_000);
  const startTimeoutMs = parseInteger(env.ROBOT_CONSOLE_HOST_START_TIMEOUT_MS, "ROBOT_CONSOLE_HOST_START_TIMEOUT_MS", 30_000, 1);
  const killTimeoutMs = parseInteger(env.ROBOT_CONSOLE_HOST_KILL_TIMEOUT_MS, "ROBOT_CONSOLE_HOST_KILL_TIMEOUT_MS", 120_000, 1);

  let hostCommand: string[];
  const rawCommand = env.ROBOT_CONSOLE_HOST_COMMAND;
  if (rawCommand) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawCommand);
    } catch {
      parsed = undefined;
    }
    if (!Array.isArray(parsed) || parsed.length === 0 || !parsed.every((part) => typeof part === "string")) {
      throw new Error("ROBOT_CONSOLE_HOST_COMMAND must be a non-empty JSON array of strings");
    }
    hostCommand = parsed as string[];
  } else {
    hostCommand = [process.execPath, defaultHostBin(), "--no-open", "--port", String(hostPort)];
  }

  const hostEnv: NodeJS.ProcessEnv = { ...env, ROBOT_CONSOLE_PORT: String(hostPort), ROBOT_CONSOLE_NO_OPEN: "1" };

  return { port, hostPort, uiDir, idleMs, startTimeoutMs, killTimeoutMs, hostCommand, hostEnv };
}

/** `--version`/`-V` from argv (sprint 026 ticket 001): print the
 * version and exit, never starting the supervisor or its host child. */
function hasVersionFlag(argv: readonly string[]): boolean {
  return argv.includes("--version") || argv.includes("-V");
}

/** What {@link main} did, for `bin/robot-console-supervisor.js` and for
 * tests. `bin/robot-console-supervisor.js` itself ignores this (it only
 * awaits {@link main} for its rejection, printing a message and exiting
 * non-zero on failure) -- the discriminant exists so a `--version` call
 * can return without ever constructing a {@link RunningSupervisor}. */
export type SupervisorCliOutcome =
  | { readonly outcome: "version"; readonly version: string }
  | { readonly outcome: "started"; readonly supervisor: RunningSupervisor; readonly uninstall: () => void };

/**
 * Start the supervisor and install SIGINT/SIGTERM handlers that stop it
 * (and therefore the host) before exiting 0. Resolves once listening;
 * rejects (e.g. the public port is taken) with a one-line message that
 * `bin/robot-console-supervisor.js` prints before exiting non-zero.
 * Returns the running supervisor and an unregister function for the
 * signal handlers (tests).
 *
 * `--version`/`-V` (sprint 026 ticket 001) is checked before
 * `parseSupervisorConfig` -- and therefore before {@link startSupervisor}
 * and its host child -- ever runs, so it is unaffected by, and cannot
 * trigger, any of that parsing's own validation errors.
 */
export async function main(
  argv: readonly string[] = [],
  env: NodeJS.ProcessEnv = process.env,
  deps: SupervisorCliDeps = {},
): Promise<SupervisorCliOutcome> {
  if (hasVersionFlag(argv)) {
    const version = getCliVersion();
    console.log(`robot-console-supervisor ${version}`);
    return { outcome: "version", version };
  }

  const config = parseSupervisorConfig(argv, env);
  const start = deps.startSupervisor ?? startSupervisor;
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const log = deps.log ?? ((line: string) => console.log(`robot-console-supervisor: ${line}`));

  const supervisor = await start({ ...config, log, ...deps.overrides });

  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    log(`received ${signal}, stopping host and exiting`);
    try {
      await supervisor.close();
    } finally {
      exit(0);
    }
  };
  const onSigint = (): void => void shutdown("SIGINT");
  const onSigterm = (): void => void shutdown("SIGTERM");
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);

  return {
    outcome: "started",
    supervisor,
    uninstall: () => {
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
    },
  };
}
