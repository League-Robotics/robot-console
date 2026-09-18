/**
 * rconsole/cli.ts — the `rconsole` command's own argv dispatch.
 *
 * `rconsole` is the installable front door for the robot console
 * (stakeholder request, 2026-09-18, out of process). It owns no logic of
 * its own beyond composition: every verb delegates to `daemon/cli.ts`'s
 * `runStart`/`runStop`/`runStatus`/`runOpen`, which sprint 021 ticket 003
 * already built and tested. This module exists to give those verbs a
 * short, memorable name, a default action, a help screen, and an
 * `agent` command.
 *
 * ## Why a bare `rconsole` starts the daemon and then opens the UI
 *
 * The stakeholder's own framing: "If I just run our console, it'll start
 * the host daemon if it doesn't exist and then open up the user
 * interface." That is deliberately *not* what `rconsole start` does on
 * its own — `daemon/cli.ts`'s `runStart` stays browser-free because a
 * daemon start is not necessarily at a machine with anyone watching (an
 * agent may run it). The bare invocation is the human-at-a-keyboard
 * path, so it composes the two: ensure a host, then open a browser.
 *
 * Because `runStart` probes before spawning anything (see that module's
 * "No runtime is ever built here" section), the bare invocation is safe
 * to run repeatedly — a second `rconsole` attaches to the running host
 * rather than racing it for serial ports, relay leases, or board
 * ownership. That property is the whole point of sprint 021 and must not
 * be weakened here: this module must never spawn a host by any route
 * other than `runStart`.
 */
import { runStart, runStop, runStatus, runOpen, type DaemonCliDeps } from "../daemon/cli.js";
import { AGENT_INSTRUCTIONS } from "./agentInstructions.js";

/** What {@link runRconsole} decided to do, for tests and for callers that
 * want to set an exit code without re-parsing stdout. */
export type RconsoleOutcome =
  | { outcome: "help" }
  | { outcome: "agent" }
  | { outcome: "started"; url: string }
  | { outcome: "already-running"; url: string }
  | { outcome: "stopped" }
  | { outcome: "stop-failed"; reason: string }
  | { outcome: "status"; running: boolean }
  | { outcome: "opened"; localUrl: string }
  | { outcome: "not-running" }
  | { outcome: "unknown-command"; command: string };

export interface RconsoleDeps extends DaemonCliDeps {
  /** Where help/agent text goes. Defaults to `console.log`. */
  readonly write?: (line: string) => void;
}

export const HELP_TEXT = `rconsole — the robot console

Usage:
  rconsole                 Start the host daemon if it isn't running,
                           then open the user interface.
  rconsole start           Start the host daemon. Does nothing (and says
                           so) if one is already running. No browser.
  rconsole stop            Stop the host daemon and release its robots.
  rconsole status          Report whether a host is running, and where.
  rconsole ui              Open the user interface for a running host.
  rconsole agent           Print instructions for an AI agent.
  rconsole help            Print this message.

Notes:
  There is only ever one host. Running rconsole again attaches to the
  host already running rather than starting a second one — two hosts on
  one bench fight over the same serial ports and relay leases.

  The host binds to every interface, so anyone who can reach this
  machine on the network can use it, including to drive robots and flash
  firmware. There is no authentication.
`;

function line(deps: RconsoleDeps): (text: string) => void {
  return deps.write ?? ((text: string) => console.log(text));
}

/** Strip the deps this module adds before handing them to `daemon/cli.ts`. */
function daemonDeps(deps: RconsoleDeps): DaemonCliDeps {
  const { write: _write, ...rest } = deps;
  return rest;
}

/**
 * The default action: ensure a host exists, then open the UI at it.
 *
 * `runStart` already prints its own "started"/"already running" line and
 * already refuses to spawn a second host, so this adds no double-start
 * logic of its own — it simply opens afterwards. If `runStart` could not
 * produce a host, `runOpen` is not called: opening a browser at nothing
 * is worse than saying plainly that nothing is running.
 */
async function runDefault(deps: RconsoleDeps): Promise<RconsoleOutcome> {
  const start = await runStart(daemonDeps(deps));
  const opened = await runOpen(daemonDeps(deps));
  if (opened.outcome === "not-running") {
    return { outcome: "not-running" };
  }
  return start.outcome === "already-running"
    ? { outcome: "already-running", url: start.url }
    : { outcome: "started", url: start.url };
}

/**
 * Dispatch one `rconsole` invocation. `argv` is the argument list with
 * the node binary and script path already removed.
 */
export async function runRconsole(
  argv: readonly string[] = [],
  deps: RconsoleDeps = {},
): Promise<RconsoleOutcome> {
  const out = line(deps);
  const command = argv[0];

  if (command === undefined) {
    return await runDefault(deps);
  }

  switch (command) {
    case "help":
    case "--help":
    case "-h": {
      out(HELP_TEXT);
      return { outcome: "help" };
    }
    case "agent": {
      out(AGENT_INSTRUCTIONS);
      return { outcome: "agent" };
    }
    case "start": {
      const result = await runStart(daemonDeps(deps));
      return result.outcome === "already-running"
        ? { outcome: "already-running", url: result.url }
        : { outcome: "started", url: result.url };
    }
    case "stop": {
      const result = await runStop(daemonDeps(deps));
      return result.outcome === "stopped"
        ? { outcome: "stopped" }
        : { outcome: "stop-failed", reason: result.outcome };
    }
    case "status": {
      const result = await runStatus(daemonDeps(deps));
      return { outcome: "status", running: result.outcome === "running" };
    }
    // `ui` is the stakeholder's own word for this ("Starting the user
    // interface"); `open` is kept as an alias so muscle memory from
    // `robot-console open` (sprint 021 ticket 003) still works.
    case "ui":
    case "open": {
      const result = await runOpen(daemonDeps(deps));
      return result.outcome === "not-running"
        ? { outcome: "not-running" }
        : { outcome: "opened", localUrl: result.localUrl };
    }
    default: {
      out(`rconsole: unknown command "${command}"\n`);
      out(HELP_TEXT);
      return { outcome: "unknown-command", command };
    }
  }
}
