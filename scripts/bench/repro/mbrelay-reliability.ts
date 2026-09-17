#!/usr/bin/env -S npx tsx
/**
 * mbrelay-reliability.ts — 018-009's required isolated reproduction:
 * bridges to `vevov` and `gopiv` through the real `torture` mbrelay pool
 * using the **host's own production composition** — `LineLink` +
 * `tcpStream` + `RelayCommandPlane`'s preamble via `connect/connector.ts`'s
 * own exported `buildRelayPreamble`, the exact function
 * `connect/relayBridger.ts` calls for every candidate attempt — `--attempts`
 * times each (default 20), and separately measures the raw-TCP
 * equivalent (Layer-1 style: a bare socket, no `LineLink`/`Session`/
 * harvester at all) the same number of times, for direct comparison.
 * Unlike every module under `scripts/bench/layer1/`, this script's own
 * purpose is to exercise host code in isolation — so it deliberately
 * imports the **compiled** `packages/host/dist/` build (`npm run build`
 * is a prerequisite, same as `scripts/bench/layer2/`'s own "tests the
 * shipped host, not source" rule), the same way
 * `scripts/bench/layer1/hidReset.ts` deliberately reaches into host
 * internals for its own one-off reason -- importing `dist/` rather than
 * `src/` also keeps this script inside `scripts/tsconfig.json`'s own
 * `rootDir` (a `.d.ts`-backed import, not a second copy of `packages/host`'s
 * own `.ts` program).
 *
 * ## What this demonstrates
 *
 * Each **host-path** attempt: connect (the full `!ECHO OFF -> !MODE
 * RAW250 -> !CG -> !P 7 -> !GO` command-plane preamble) -> identify
 * (`HELLO`/banner, boot-window retry schedule) -> attach a
 * harvester-shaped `STATUS` poll (every `--statusPollIntervalMs`,
 * default 2000 -- matches `connect/harvester.ts`'s own
 * `DEFAULT_STATUS_POLL_INTERVAL_MS`) -> send exactly one `ID` query and
 * wait up to `--replyTimeoutMs` (default 5000 -- matches
 * `scripts/bench/layer2/pathChecks.ts`'s own `DEFAULT_REPLY_TIMEOUT_MS`)
 * for its `id ...` reply. This is exactly the shape of a student's
 * `send-command ID` racing the harvester's own background poll on the
 * same physical link.
 *
 * `--hostMode` selects which behavior the `ID` send and `STATUS` poll
 * use on the host path:
 *
 *   - `ungated` (default): models the **pre-018-009** host. The `ID`/
 *     `STATUS` lines are written via `LineLink.sendLine()` — the same
 *     wire text `LineLink.sendUnsequenced()` produced before this
 *     ticket's fix, but with none of that method's own (post-fix)
 *     resend/pending-tracking machinery — and the poll fires on its own
 *     schedule with no awareness of whether `ID` is still in flight.
 *   - `gated`: models the **018-009 fix**. `ID`/`STATUS` are sent via
 *     the real, current `LineLink.sendUnsequenced()` (bounded one-time
 *     resend if unanswered), and the poll checks
 *     `LineLink.hasPendingUnsequencedQuery` before every tick, skipping
 *     it while `ID` is still outstanding — verbatim what
 *     `connect/harvester.ts`'s own `pollStatus()` now does.
 *
 * Each **raw-path** attempt is Layer-1 style: a bare `net.Socket` (no
 * `LineLink`, no `Session`, no poll of any kind), running the identical
 * preamble via `@robot-console/protocol`'s own pure line-builders (the
 * same ones `RelayCommandPlane.ts` composes), then one `HELLO` (banner)
 * and one `ID`, each waited on with the same bounds as the host path —
 * the "no collision possible, is there still loss?" control.
 *
 * Every attempt's full transcript (every wire line with its own
 * relative-ms timestamp, including which mode produced it) is captured
 * and written to `--out` (default `mbrelay-reliability-report.json`)
 * alongside a summary table printed to the console — this is the
 * ticket's own required "paste the counts" evidence, kept as a
 * regression artifact for future reference.
 *
 * ## `--interAttemptDelayMs` (live-bench finding)
 *
 * A first run of this script with attempts fired back-to-back (only a
 * 50ms pause after each `close()`) found a *different*, real-hardware
 * failure mode dominating over the ID/STATUS collision this script
 * exists to measure: `# ERROR: no relay available (4 devices, 0 in use,
 * 4 being handed back)` -- the pool's own reply when every physical
 * relay it owns is still recycling from the *previous* client's
 * connection and none is available yet for a new one. `--interAttemptDelayMs`
 * (default 1500) pauses between attempts so this script's own rapid
 * reconnection cadence isn't what's exhausting the pool -- a fixed
 * real-hardware constraint of the shared `torture` pool, orthogonal to
 * (and not fixed by) this ticket's own change.
 *
 * Never sends a motion/drive verb, never flashes firmware -- only ever
 * the documented command-plane preamble plus `HELLO`/`ID`/`STATUS`,
 * exactly like every other module in this harness.
 */
import { writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  nameToRadioAddress,
  parseBanner,
  relayPreambleSteps,
  type RelayPreambleStep,
} from "@robot-console/protocol";

import { LineLink, type ByteStream } from "../../../packages/host/dist/link/LineLink.js";
import { tcpStream } from "../../../packages/host/dist/link/adapters/tcpStream.js";
import { realScheduler } from "../../../packages/host/dist/link/pacing.js";
import {
  DEFAULT_IDENTIFY_BUDGET_MS,
  DEFAULT_IDENTIFY_SCHEDULE_MS,
  identifyWithBootWindowRetry,
} from "../../../packages/host/dist/link/bootWindowIdentify.js";
import { buildRelayPreamble } from "../../../packages/host/dist/connect/connector.js";

// ---------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------

interface CliOptions {
  attempts: number;
  names: string[];
  host: string;
  port: number;
  replyTimeoutMs: number;
  statusPollIntervalMs: number;
  hostMode: "ungated" | "gated";
  interAttemptDelayMs: number;
  outPath: string;
}

function parseArgs(argv: readonly string[]): CliOptions {
  let attempts = 20;
  let names = ["vevov", "gopiv"];
  let host = "torture.local";
  let port = 8760;
  let replyTimeoutMs = 5000;
  let statusPollIntervalMs = 2000;
  let hostMode: "ungated" | "gated" = "ungated";
  let interAttemptDelayMs = 1500;
  let outPath = path.join(process.cwd(), "mbrelay-reliability-report.json");
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = (): string => {
      const value = argv[i + 1];
      if (value === undefined) {
        throw new Error(`${arg} requires a value`);
      }
      i += 1;
      return value;
    };
    if (arg === "--attempts") {
      attempts = Number(next());
    } else if (arg === "--names") {
      names = next().split(",").map((s) => s.trim()).filter(Boolean);
    } else if (arg === "--host") {
      host = next();
    } else if (arg === "--port") {
      port = Number(next());
    } else if (arg === "--replyTimeoutMs") {
      replyTimeoutMs = Number(next());
    } else if (arg === "--statusPollIntervalMs") {
      statusPollIntervalMs = Number(next());
    } else if (arg === "--hostMode") {
      const value = next();
      if (value !== "ungated" && value !== "gated") {
        throw new Error(`--hostMode must be "ungated" or "gated", got "${value}"`);
      }
      hostMode = value;
    } else if (arg === "--interAttemptDelayMs") {
      interAttemptDelayMs = Number(next());
    } else if (arg === "--out") {
      outPath = next();
    } else {
      throw new Error(`unrecognized argument: ${arg}`);
    }
  }
  return { attempts, names, host, port, replyTimeoutMs, statusPollIntervalMs, hostMode, interAttemptDelayMs, outPath };
}

// ---------------------------------------------------------------------
// Shared result shape
// ---------------------------------------------------------------------

interface TranscriptEvent {
  t: number;
  dir: "tx" | "rx" | "info";
  line: string;
}

interface AttemptResult {
  name: string;
  path: "host" | "raw";
  mode?: "ungated" | "gated";
  attempt: number;
  ok: boolean;
  reason: string;
  preambleMs?: number;
  bannerMs?: number;
  idReplyMs?: number;
  transcript: TranscriptEvent[];
}

function nowRel(t0: number): number {
  return Date.now() - t0;
}

// ---------------------------------------------------------------------
// Host path -- real LineLink + tcpStream + buildRelayPreamble, exactly
// as connect/relayBridger.ts composes them for one candidate attempt.
// ---------------------------------------------------------------------

async function runHostAttempt(
  name: string,
  channel: number,
  group: number,
  host: string,
  port: number,
  replyTimeoutMs: number,
  statusPollIntervalMs: number,
  mode: "ungated" | "gated",
  attempt: number,
): Promise<AttemptResult> {
  const t0 = Date.now();
  const transcript: TranscriptEvent[] = [];
  const note = (line: string): void => {
    transcript.push({ t: nowRel(t0), dir: "info", line });
  };

  const stream: ByteStream = tcpStream(host, port);
  let lineLink: LineLink;
  const preamble = buildRelayPreamble(channel, group, () => lineLink, realScheduler, undefined, undefined);
  lineLink = new LineLink(stream, {
    identifyTimeoutMs: DEFAULT_IDENTIFY_BUDGET_MS,
    connectTimeoutMs: 5000,
    scheduler: realScheduler,
    preamble,
  });

  // Capture every preamble-phase raw line (the `#`-prefixed
  // command-plane replies) -- see RelayCommandPlane.ts's own doc
  // comment for why these arrive via onRawLine during connect().
  lineLink.onRawLine((raw) => transcript.push({ t: nowRel(t0), dir: "rx", line: raw }));
  // Every decoded post-connect reply (id/status/...).
  lineLink.onLine((decoded) => transcript.push({ t: nowRel(t0), dir: "rx", line: `[decoded ${decoded.verb}] ${JSON.stringify(decoded.fields)}` }));

  const connectStart = Date.now();
  try {
    await lineLink.connect({ timeoutMs: 5000 });
  } catch (error) {
    note(`connect failed: ${error instanceof Error ? error.message : String(error)}`);
    return { name, path: "host", mode, attempt, ok: false, reason: "preamble/connect failed", transcript };
  }
  const preambleMs = Date.now() - connectStart;
  note(`connected (preamble) in ${preambleMs}ms`);

  const identifyStart = Date.now();
  const banner = await identifyWithBootWindowRetry(lineLink, DEFAULT_IDENTIFY_SCHEDULE_MS, realScheduler);
  const bannerMs = Date.now() - identifyStart;
  if (!banner) {
    note(`no banner within ${DEFAULT_IDENTIFY_BUDGET_MS}ms`);
    void lineLink.close();
    return { name, path: "host", mode, attempt, ok: false, reason: "no banner", preambleMs, transcript };
  }
  note(`banner in ${bannerMs}ms: ${JSON.stringify(banner)}`);
  if (banner.name !== name) {
    note(`banner named "${banner.name}", expected "${name}"`);
    void lineLink.close();
    return { name, path: "host", mode, attempt, ok: false, reason: `wrong banner name (${banner.name})`, preambleMs, bannerMs, transcript };
  }

  // Harvester-shaped STATUS poll -- mirrors connect/harvester.ts's own
  // attach(): an immediate first tick, then every statusPollIntervalMs.
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  const pollTick = (): void => {
    if (!lineLink.isOpen) {
      return;
    }
    if (mode === "gated" && lineLink.hasPendingUnsequencedQuery) {
      note("STATUS poll skipped (foreign query pending)");
      return;
    }
    note("STATUS poll sent");
    try {
      if (mode === "gated") {
        lineLink.sendUnsequenced("STATUS");
      } else {
        lineLink.sendLine("STATUS");
      }
    } catch {
      // best-effort, matches harvester.ts's own write-failure handling
    }
  };
  pollTick();
  pollTimer = setInterval(pollTick, statusPollIntervalMs);
  pollTimer.unref?.();

  // Wait for the id reply BEFORE sending -- registered first so no
  // reply can arrive before the listener exists (writes are paced,
  // never same-tick).
  const idWaitStart = Date.now();
  const idReplyPromise = new Promise<boolean>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        unsubscribe();
        resolve(false);
      }
    }, replyTimeoutMs);
    const unsubscribe = lineLink.onLine((decoded) => {
      if (!settled && decoded.verb === "id") {
        settled = true;
        clearTimeout(timer);
        unsubscribe();
        resolve(true);
      }
    });
  });
  note(`sending ID (${mode})`);
  if (mode === "gated") {
    // The actual 018-009 fix lives on sendUnsequencedQuery, not the plain
    // sendUnsequenced -- see LineLink.ts's own doc comment ("Unsequenced
    // query resend and poll/query serialization"). This is the method
    // server.ts's send-command dispatch now calls for a student's own
    // non-sequenced verb.
    lineLink.sendUnsequencedQuery("ID");
  } else {
    lineLink.sendLine("ID");
  }
  const idReplied = await idReplyPromise;
  const idReplyMs = Date.now() - idWaitStart;
  note(idReplied ? `id reply matched after ${idReplyMs}ms` : `no id reply within ${replyTimeoutMs}ms`);

  clearInterval(pollTimer);
  void lineLink.close();
  await new Promise((resolve) => setTimeout(resolve, 50));

  return {
    name,
    path: "host",
    mode,
    attempt,
    ok: idReplied,
    reason: idReplied ? `id reply within ${idReplyMs}ms` : `no id reply within ${replyTimeoutMs}ms of send`,
    preambleMs,
    bannerMs,
    idReplyMs,
    transcript,
  };
}

// ---------------------------------------------------------------------
// Raw path -- bare net.Socket, Layer-1 style. No LineLink/Session/poll.
// ---------------------------------------------------------------------

function rawReassemble(): { push(chunk: Buffer): string[] } {
  let buf = "";
  return {
    push(chunk: Buffer): string[] {
      buf += chunk.toString("utf8");
      const lines: string[] = [];
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        lines.push(buf.slice(0, idx).replace(/\r$/, ""));
        buf = buf.slice(idx + 1);
      }
      return lines;
    },
  };
}

async function runRawAttempt(
  name: string,
  channel: number,
  group: number,
  host: string,
  port: number,
  replyTimeoutMs: number,
  attempt: number,
): Promise<AttemptResult> {
  const t0 = Date.now();
  const transcript: TranscriptEvent[] = [];
  const note = (line: string): void => {
    transcript.push({ t: nowRel(t0), dir: "info", line });
  };

  const socket = net.connect({ host, port });
  const reassembler = rawReassemble();
  const lineListeners = new Set<(line: string) => void>();
  socket.on("data", (chunk: Buffer) => {
    for (const line of reassembler.push(chunk)) {
      transcript.push({ t: nowRel(t0), dir: "rx", line });
      for (const listener of [...lineListeners]) {
        listener(line);
      }
    }
  });

  function send(line: string): void {
    transcript.push({ t: nowRel(t0), dir: "tx", line });
    socket.write(`${line}\n`);
  }

  function waitFor(predicate: (line: string) => boolean, timeoutMs: number): Promise<string | undefined> {
    return new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          lineListeners.delete(listener);
          resolve(undefined);
        }
      }, timeoutMs);
      const listener = (line: string): void => {
        if (!settled && predicate(line)) {
          settled = true;
          clearTimeout(timer);
          lineListeners.delete(listener);
          resolve(line);
        }
      };
      lineListeners.add(listener);
    });
  }

  const connected = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), 5000);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.setNoDelay(true);
      resolve(true);
    });
    socket.once("error", (err) => {
      clearTimeout(timer);
      note(`connect error: ${err.message}`);
      resolve(false);
    });
  });
  if (!connected) {
    socket.destroy();
    return { name, path: "raw", attempt, ok: false, reason: "connect failed", transcript };
  }

  const preambleStart = Date.now();
  for (const step of relayPreambleSteps(channel, group) as readonly RelayPreambleStep[]) {
    const wait = waitFor((line) => step.confirms(line), 3000);
    send(step.line.replace(/\n$/, ""));
    const reply = await wait;
    if (reply === undefined) {
      note(`preamble step "${step.label}" timed out`);
      socket.destroy();
      return { name, path: "raw", attempt, ok: false, reason: `preamble step "${step.label}" timed out`, transcript };
    }
  }
  const preambleMs = Date.now() - preambleStart;
  note(`preamble complete in ${preambleMs}ms`);

  const bannerStart = Date.now();
  const bannerWait = waitFor((line) => parseBanner(line) !== null, 3000);
  send("HELLO");
  const bannerLine = await bannerWait;
  const bannerMs = Date.now() - bannerStart;
  if (bannerLine === undefined) {
    note(`no banner within 3000ms`);
    socket.destroy();
    return { name, path: "raw", attempt, ok: false, reason: "no banner", preambleMs, transcript };
  }
  const banner = parseBanner(bannerLine)!;
  note(`banner in ${bannerMs}ms: ${JSON.stringify(banner)}`);
  if (banner.name !== name) {
    socket.destroy();
    return { name, path: "raw", attempt, ok: false, reason: `wrong banner name (${banner.name})`, preambleMs, bannerMs, transcript };
  }

  const idStart = Date.now();
  const idWait = waitFor((line) => line.trim().toLowerCase().startsWith("id "), replyTimeoutMs);
  send("ID");
  const idLine = await idWait;
  const idReplyMs = Date.now() - idStart;
  note(idLine !== undefined ? `id reply after ${idReplyMs}ms: ${idLine}` : `no id reply within ${replyTimeoutMs}ms`);

  socket.destroy();
  await new Promise((resolve) => setTimeout(resolve, 50));

  return {
    name,
    path: "raw",
    attempt,
    ok: idLine !== undefined,
    reason: idLine !== undefined ? `id reply within ${idReplyMs}ms` : `no id reply within ${replyTimeoutMs}ms of send`,
    preambleMs,
    bannerMs,
    idReplyMs,
    transcript,
  };
}

// ---------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  console.log(
    `[repro] host=${opts.host}:${opts.port} names=${opts.names.join(",")} attempts=${opts.attempts} hostMode=${opts.hostMode} replyTimeoutMs=${opts.replyTimeoutMs} statusPollIntervalMs=${opts.statusPollIntervalMs} interAttemptDelayMs=${opts.interAttemptDelayMs}`,
  );

  const results: AttemptResult[] = [];

  for (const name of opts.names) {
    const { channel, group } = nameToRadioAddress(name);
    console.log(`[repro] ${name}: ch${channel}/grp${group}`);

    for (let attempt = 1; attempt <= opts.attempts; attempt++) {
      const result = await runHostAttempt(
        name,
        channel,
        group,
        opts.host,
        opts.port,
        opts.replyTimeoutMs,
        opts.statusPollIntervalMs,
        opts.hostMode,
        attempt,
      );
      results.push(result);
      console.log(`[repro] host  ${name} #${attempt}/${opts.attempts} (${opts.hostMode}) -> ${result.ok ? "PASS" : "FAIL"} (${result.reason})`);
      // 018-009 live-bench finding: the pool answers a connection with
      // "# ERROR: no relay available (... being handed back)" if a new
      // connection lands before a just-closed one's relay has finished
      // recycling -- a fixed real-hardware constraint of the pool
      // itself, unrelated to this ticket's ID/STATUS-collision target.
      // This pause keeps that a rare, real-hardware event rather than
      // this script's own self-inflicted contention.
      await new Promise((resolve) => setTimeout(resolve, opts.interAttemptDelayMs));
    }

    for (let attempt = 1; attempt <= opts.attempts; attempt++) {
      const result = await runRawAttempt(name, channel, group, opts.host, opts.port, opts.replyTimeoutMs, attempt);
      results.push(result);
      console.log(`[repro] raw   ${name} #${attempt}/${opts.attempts} -> ${result.ok ? "PASS" : "FAIL"} (${result.reason})`);
      await new Promise((resolve) => setTimeout(resolve, opts.interAttemptDelayMs));
    }
  }

  // ---- Summary --------------------------------------------------------
  function tally(path: "host" | "raw", name: string): { pass: number; total: number } {
    const rows = results.filter((r) => r.path === path && r.name === name);
    return { pass: rows.filter((r) => r.ok).length, total: rows.length };
  }

  console.log("\n=== Summary ===");
  console.log(`hostMode: ${opts.hostMode}`);
  for (const name of opts.names) {
    const host = tally("host", name);
    const raw = tally("raw", name);
    console.log(`${name}: host ${host.pass}/${host.total} pass -- raw ${raw.pass}/${raw.total} pass`);
  }

  writeFileSync(
    opts.outPath,
    JSON.stringify({ options: opts, results }, null, 2),
    "utf8",
  );
  console.log(`\n[repro] wrote ${opts.outPath}`);
}

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  main().catch((error: unknown) => {
    console.error("[repro] fatal error:", error);
    process.exitCode = 1;
  });
}

export { main, parseArgs };
