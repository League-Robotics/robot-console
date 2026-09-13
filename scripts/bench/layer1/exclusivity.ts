/**
 * exclusivity.ts — refuse to run against a bench another process already
 * holds, per sprint 018 ticket 001's own acceptance criteria and the
 * harness issue's "Requires exclusive access to the bench ... detecting
 * holders with `lsof`."
 *
 * Two resource kinds this harness can collide with another process
 * over:
 *   - a **serial device** (e.g. `/dev/cu.usbmodem2121102`) — `lsof
 *     <path>` lists whatever process currently has it open.
 *   - an **established TCP connection** from some other local process to
 *     a bridge/pool/WiFi endpoint this run is about to dial (e.g. a
 *     `node scripts/dev.mjs` already connected to a farm mbserial
 *     bridge) — `lsof -nP -iTCP -sTCP:ESTABLISHED` lists every
 *     established TCP socket on the machine; this module filters that
 *     down to rows whose *remote* address matches one of this run's own
 *     endpoints.
 *
 * `lsof` is injected as a plain `(args) => Promise<string>` (stdout, or
 * `""` when `lsof` found nothing — its own exit code 1 in that case,
 * never thrown here) so every code path is provable against captured
 * real output (this module's own test file) without shelling out in CI.
 *
 * This module never kills, signals, or otherwise touches a holder's
 * process — it only reports who holds what, per the ticket's explicit
 * "Do NOT kill or signal any process."
 */
import { execFile } from "node:child_process";
import type { Holder } from "./types.js";

/** A serial device this run needs exclusive access to. */
export interface SerialResource {
  kind: "serial";
  path: string;
}

/** A TCP endpoint (already resolved to an IP) this run is about to
 * dial. */
export interface TcpResource {
  kind: "tcp";
  host: string;
  port: number;
}

export type ExclusivityResource = SerialResource | TcpResource;

/** Injectable `lsof` runner. Returns raw stdout; an `lsof` invocation
 * that finds nothing exits 1 with empty stdout — real implementations
 * must swallow that specific "not found" exit code and resolve `""`,
 * never reject for it (see {@link realLsofRunner}). Any other failure
 * (lsof missing, a permissions error) does reject, since that is a real
 * inability to check exclusivity, not "nothing is holding this." */
export type LsofRunner = (args: string[]) => Promise<string>;

/**
 * The real `lsof` runner: shells out via `execFile` (no shell
 * interpolation of `args`). `lsof` exits 1 with empty stdout when it
 * finds no matching process for a device path — a completely normal
 * "nobody holds this" result, not a failure — so that specific case
 * resolves `""` rather than rejecting; any other spawn failure (lsof not
 * on `PATH`, a permissions error) still rejects.
 */
export function realLsofRunner(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("lsof", args, { encoding: "utf8" }, (error, stdout) => {
      if (error) {
        // `lsof`'s own "found nothing" exit status is 1, reported here
        // as `error.code === 1` (child_process sets `.code` to the
        // process's exit code, not an errno string, for a plain nonzero
        // exit) -- a completely normal "nobody holds this" result, not
        // a failure. Any other error (lsof missing from PATH, a
        // permissions failure launching it at all) still rejects.
        const exitCode = (error as unknown as { code?: number | string }).code;
        if (exitCode === 1) {
          resolve("");
          return;
        }
        reject(error);
        return;
      }
      resolve(stdout);
    });
  });
}

/** Parse one `lsof <path>` invocation's stdout (header row + zero or
 * more data rows, `COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME`)
 * into holders. Empty stdout (nothing found) parses to `[]`. */
function parseSerialLsofOutput(stdout: string, resource: string): Holder[] {
  const lines = stdout
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
  if (lines.length <= 1) {
    // Header only (or genuinely empty) -- nobody holds this device.
    return [];
  }
  const holders: Holder[] = [];
  for (const row of lines.slice(1)) {
    const cols = row.trim().split(/\s+/);
    const command = cols[0];
    const pid = Number(cols[1]);
    if (command !== undefined && Number.isFinite(pid)) {
      holders.push({ resource, pid, command });
    }
  }
  return holders;
}

/** The `NAME` column's `LOCAL->REMOTE` shape for one established TCP
 * row, e.g. `192.168.1.40:64625->160.79.104.10:443`. `lsof` may append a
 * trailing `(ESTABLISHED)` state qualifier as its own extra whitespace-
 * separated token -- callers strip that before calling this. */
const REMOTE_ADDR_PATTERN = /->([^:\s]+):(\d+)$/;

/** Parse one `lsof -nP -iTCP -sTCP:ESTABLISHED` invocation's stdout,
 * keeping only rows whose *remote* address matches one of `endpoints`
 * (already-resolved IP + port -- this module does no hostname matching
 * of its own). */
function parseTcpLsofOutput(stdout: string, endpoints: readonly TcpResource[]): Holder[] {
  const lines = stdout
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
  if (lines.length <= 1) {
    return [];
  }
  const holders: Holder[] = [];
  for (const row of lines.slice(1)) {
    const cols = row.trim().split(/\s+/);
    const command = cols[0];
    const pid = Number(cols[1]);
    // The NAME field is always the last token unless lsof appended a
    // trailing "(STATE)" qualifier as its own token, e.g. "(ESTABLISHED)".
    const last = cols[cols.length - 1];
    const nameField = last !== undefined && /^\(.*\)$/.test(last) ? cols[cols.length - 2] : last;
    if (command === undefined || !Number.isFinite(pid) || nameField === undefined) {
      continue;
    }
    const match = REMOTE_ADDR_PATTERN.exec(nameField);
    if (!match) {
      continue;
    }
    const remoteHost = match[1]!;
    const remotePort = Number(match[2]);
    const hit = endpoints.find((endpoint) => endpoint.host === remoteHost && endpoint.port === remotePort);
    if (hit) {
      holders.push({ resource: `${hit.host}:${hit.port}`, pid, command });
    }
  }
  return holders;
}

/**
 * Find every process (other than `selfPid`) holding any of `resources`
 * — a serial device already open, or an established TCP connection to
 * one of this run's own dial targets. Issues one `lsof <path>` call per
 * serial resource and, if any TCP resources are given, exactly one
 * `lsof -nP -iTCP -sTCP:ESTABLISHED` call shared across all of them
 * (cheaper than one call per endpoint, and `lsof` has no per-remote-
 * address filter of its own).
 */
export async function findHolders(
  resources: readonly ExclusivityResource[],
  runLsof: LsofRunner = realLsofRunner,
  selfPid: number = process.pid,
): Promise<Holder[]> {
  const holders: Holder[] = [];

  const serialResources = resources.filter((r): r is SerialResource => r.kind === "serial");
  for (const resource of serialResources) {
    const stdout = await runLsof([resource.path]);
    holders.push(...parseSerialLsofOutput(stdout, resource.path));
  }

  const tcpResources = resources.filter((r): r is TcpResource => r.kind === "tcp");
  if (tcpResources.length > 0) {
    const stdout = await runLsof(["-nP", "-iTCP", "-sTCP:ESTABLISHED"]);
    holders.push(...parseTcpLsofOutput(stdout, tcpResources));
  }

  return holders.filter((holder) => holder.pid !== selfPid);
}

/** One resource this run decided not to touch because {@link findHolders}
 * reported it held, in `--skip-held` mode. */
export interface SkippedResource {
  resource: string;
  reason: string;
}

/** The two outcomes an exclusivity check can produce, once `--skip-held`
 * is factored in. `refuse: true` means the harness must print
 * {@link describeHolders}'s message and exit without probing anything;
 * `refuse: false` in `--skip-held` mode still carries `skipped` entries
 * a caller uses to mark the corresponding device/path rows `"skipped"`. */
export interface ExclusivityOutcome {
  holders: Holder[];
  refuse: boolean;
  skipped: SkippedResource[];
}

/**
 * Decide whether to refuse, given `holders` and whether `--skip-held`
 * was passed. Default (no flag): any holder at all means refuse. With
 * `--skip-held`: never refuse — instead, every held resource is reported
 * back as `skipped` (`"held by pid <pid> (<command>)"`) so the caller
 * marks just that resource's device/path row `"skipped"` and probes
 * everything else normally.
 */
export function evaluateExclusivity(holders: readonly Holder[], skipHeld: boolean): ExclusivityOutcome {
  if (!skipHeld) {
    return { holders: [...holders], refuse: holders.length > 0, skipped: [] };
  }
  return {
    holders: [...holders],
    refuse: false,
    skipped: holders.map((h) => ({ resource: h.resource, reason: `held by pid ${h.pid} (${h.command})` })),
  };
}

/** Human-readable refusal message naming every holder — printed verbatim
 * by `index.ts` when {@link ExclusivityOutcome.refuse} is `true`. */
export function describeHolders(holders: readonly Holder[]): string {
  return holders.map((h) => `${h.resource} held by pid ${h.pid} (${h.command})`).join("\n");
}
