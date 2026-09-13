#!/usr/bin/env -S npx tsx
/**
 * index.ts — Layer 3 entry point: start a real host (same shipped
 * binary Layer 2 uses, `bin/robot-console.js`, against a fresh seeded
 * state dir) serving the real production-built UI
 * (`packages/ui/dist`), drive it in headless Chrome (`playwright-core`)
 * for every path Layer 2 attempted, and write one JSON report.
 *
 * Run with `npm run bench:layer3 -- --layer2 <path> --out <path>
 * [--port <n>] [--screenshot-dir <dir>]`, or directly: `npx tsx
 * scripts/bench/layer3/index.ts`. See `scripts/bench/README.md`.
 *
 * ## Why this starts its own host rather than reusing Layer 2's
 *
 * Layer 2's own `index.ts` kills the host process it starts in a
 * `finally` the moment that script's own `main()` returns -- by the
 * time a separate `bench:layer3` invocation runs, that process is
 * already gone. This module instead starts a fresh instance of the
 * exact same shipped binary Layer 2 uses (`bin/robot-console.js
 * --no-open`, seeded the same way from a read-only copy of
 * `known-robots.json`), which is what the ticket's own "the production
 * UI served by the host Layer 2 starts" instruction means in practice
 * for two separately-runnable CLI scripts: the same *kind* of host
 * (shipped build, fresh seeded state, `--no-open`), not literally one
 * surviving OS process shared across two script invocations -- each
 * layer staying independently runnable is this harness's own
 * established design principle (`README.md`'s Module map section).
 *
 * ## Which paths this drives
 *
 * Every path Layer 2's own report marked as attempted (`layer2.status
 * !== "skipped"`) -- Layer 2 already resolved which of Layer 1's
 * reachable paths are real "a robot reached over this transport" rows
 * (`targetForPath`'s own filtering, e.g. never a relay pool's own
 * status-check row) via its own JSON, so Layer 3 reads *that* report
 * rather than re-deriving the same filter a second time.
 */
import { existsSync, mkdirSync, copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

import { defaultKnownRobotsPath } from "../layer1/knownNames.js";
import { BenchWsClient, waitForSettle } from "../layer2/wsClient.js";
import type { Layer2Report } from "../layer2/types.js";
import { checkPath } from "./uiDriver.js";
import type { Layer3Report } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../..");

interface CliOptions {
  layer2Path: string;
  outPath: string;
  port: number;
  stateDir: string;
  screenshotDir: string;
}

const DEFAULT_PORT = 4798;

function parseArgs(argv: readonly string[]): CliOptions {
  let layer2Path = path.join(process.cwd(), "bench-layer2-report.json");
  let outPath = path.join(process.cwd(), "bench-layer3-report.json");
  let port = DEFAULT_PORT;
  let stateDir: string | undefined;
  let screenshotDir: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--layer2") {
      layer2Path = argv[++i] ?? layer2Path;
    } else if (arg === "--out") {
      outPath = argv[++i] ?? outPath;
    } else if (arg === "--port") {
      const value = Number(argv[++i]);
      if (Number.isInteger(value)) {
        port = value;
      }
    } else if (arg === "--state-dir") {
      stateDir = argv[++i];
    } else if (arg === "--screenshot-dir") {
      screenshotDir = argv[++i];
    }
  }
  return {
    layer2Path,
    outPath,
    port,
    stateDir: stateDir ?? path.join(os.tmpdir(), `bench-layer3-state-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`),
    screenshotDir: screenshotDir ?? path.join(path.dirname(outPath), `bench-layer3-screenshots-${Date.now()}`),
  };
}

/** Every device x path row Layer 2 actually attempted (`status !==
 * "skipped"`), regardless of whether Layer 2 itself passed or failed --
 * a Layer-2 failure is exactly the kind of row Layer 3 must still
 * check (per this ticket's own "a path failing Layer 2 or 3 is a
 * defect" framing: Layer 3 is independent evidence, not gated on
 * Layer 2 having passed). */
function targetsFromLayer2(layer2: Layer2Report): Array<{ device: string; path: string; deviceKind: string }> {
  const targets: Array<{ device: string; path: string; deviceKind: string }> = [];
  for (const device of layer2.devices) {
    for (const entry of device.paths) {
      if (entry.layer2.status === "skipped") {
        continue;
      }
      // 018-004: threaded through so `uiDriver.ts`'s `checkPath` can
      // probe a relay-kind target with `HELLO` instead of `ID` (a relay
      // has no `ID` verb) -- see that module's own doc comment.
      targets.push({ device: device.name, path: entry.path, deviceKind: device.kind });
    }
  }
  return targets;
}

async function waitForHostReady(url: string, boundedMs: number): Promise<void> {
  const deadline = Date.now() + boundedMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const client = await BenchWsClient.connect({ url, connectTimeoutMs: 1_000 });
      client.close();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error(`host at ${url} never accepted a WebSocket connection within ${boundedMs}ms (last error: ${lastError instanceof Error ? lastError.message : String(lastError)})`);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const startedAt = new Date();

  const distCliPath = path.join(REPO_ROOT, "packages", "host", "dist", "cli.js");
  if (!existsSync(distCliPath)) {
    console.error(`[bench:layer3] ${distCliPath} does not exist -- run "npm run build" first (Layer 3 tests the shipped host, not source).`);
    process.exitCode = 1;
    return;
  }
  const uiDistIndex = path.join(REPO_ROOT, "packages", "ui", "dist", "index.html");
  if (!existsSync(uiDistIndex)) {
    console.error(`[bench:layer3] ${uiDistIndex} does not exist -- run "npm run vite:build -w @robot-console/ui" first (Layer 3 drives the real production build, not a dev server).`);
    process.exitCode = 1;
    return;
  }
  if (!existsSync(options.layer2Path)) {
    console.error(`[bench:layer3] Layer 2 report not found at ${options.layer2Path} -- run "npm run bench:layer2" first, or pass --layer2 <path>.`);
    process.exitCode = 1;
    return;
  }
  const layer2: Layer2Report = JSON.parse(readFileSync(options.layer2Path, "utf8"));
  const targets = targetsFromLayer2(layer2);
  if (targets.length === 0) {
    console.log("[bench:layer3] no non-skipped paths in the Layer 2 report -- nothing to drive. Writing an empty report.");
  }

  mkdirSync(options.stateDir, { recursive: true });
  mkdirSync(options.screenshotDir, { recursive: true });
  const realKnownRobotsPath = defaultKnownRobotsPath();
  if (existsSync(realKnownRobotsPath)) {
    copyFileSync(realKnownRobotsPath, path.join(options.stateDir, "known-robots.json"));
    console.log(`[bench:layer3] seeded ${options.stateDir}/known-robots.json from ${realKnownRobotsPath} (read-only copy)`);
  }

  const binPath = path.join(REPO_ROOT, "bin", "robot-console.js");
  const baseUrl = `http://127.0.0.1:${options.port}/`;
  const wsUrl = `ws://127.0.0.1:${options.port}/`;
  // 018-005 Step 0b: `--no-sweep` -- same reasoning as `layer2/index.ts`'s
  // own host spawn: this harness host must never run its own relay
  // sweeper, or it races Layer 1's own raw probes (or another harness
  // host instance) against the identical physical relay.
  console.log(`[bench:layer3] starting host: node ${binPath} --port ${options.port} --no-open --no-sweep (ROBOT_CONSOLE_STATE_DIR=${options.stateDir})`);
  const child: ChildProcessByStdio<null, Readable, Readable> = spawn(
    process.execPath,
    [binPath, "--port", String(options.port), "--no-open", "--no-sweep"],
    {
      env: { ...process.env, ROBOT_CONSOLE_STATE_DIR: options.stateDir },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let hostOutput = "";
  child.stdout.on("data", (chunk: Buffer) => (hostOutput += chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => (hostOutput += chunk.toString()));

  const results: Layer3Report["results"] = [];
  try {
    await waitForHostReady(wsUrl, 20_000);
    console.log(`[bench:layer3] host accepted a WebSocket connection at ${wsUrl}`);

    // Wait for the snapshot stream to settle before driving any page --
    // same detector Layer 2 uses (`wsClient.ts`'s `waitForSettle`,
    // "unchanged for 5s, bounded at 90s"). Live-verified necessary on
    // this ticket's own first full run: Layer 2's own settle took
    // 32751ms on this bench, and a fixed short grace period here left
    // some cards not yet fully identified (no Connect button, no open
    // arrow -- neither, since the link was still `connecting`) by the
    // time the browser's first page load ran.
    const settleClient = await BenchWsClient.connect({ url: wsUrl });
    console.log("[bench:layer3] waiting for the snapshot stream to settle (unchanged for 5s, bounded at 90s)...");
    const settle = await waitForSettle(settleClient, { stableForMs: 5_000, boundedMs: 90_000 });
    console.log(`[bench:layer3] settle: ${settle.settled ? "settled" : "NOT settled (bound reached)"} after ${settle.elapsedMs}ms`);
    settleClient.close();

    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
      for (const target of targets) {
        console.log(`[bench:layer3] checking ${target.device} / ${target.path}...`);
        const result = await checkPath(page, baseUrl, target, { screenshotDir: options.screenshotDir });
        console.log(`[bench:layer3] ${target.device} / ${target.path} -> ${result.status} (${result.reason})`);
        results.push(result);
      }
    } finally {
      await browser.close();
    }
  } finally {
    // Kill only the host process this run started -- never any other
    // process, same discipline as every other layer in this harness.
    child.kill("SIGTERM");
  }

  const finishedAt = new Date();
  const report: Layer3Report = {
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    host: { os: `${os.platform()} ${os.release()}`, node: process.version },
    baseUrl,
    screenshotDir: options.screenshotDir,
    results,
  };
  writeFileSync(options.outPath, JSON.stringify(report, null, 2), "utf8");
  console.log(`[bench:layer3] wrote report to ${options.outPath}`);
  printSummaryTable(report);
  if (results.some((r) => r.status !== "pass")) {
    console.error("[bench:layer3] host output for diagnostics:\n" + hostOutput.slice(-4000));
  }
}

function printSummaryTable(report: Layer3Report): void {
  console.log("\ndevice           path                              status    reason");
  console.log("-".repeat(100));
  for (const r of report.results) {
    console.log(`${r.device.padEnd(16)} ${r.path.padEnd(33)} ${r.status.padEnd(9)} ${r.reason.slice(0, 80)}`);
  }
}

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  main().catch((error: unknown) => {
    console.error("[bench:layer3] fatal error:", error);
    process.exitCode = 1;
  });
}

export { main, parseArgs, targetsFromLayer2 };
