#!/usr/bin/env -S npx tsx
/**
 * index.ts — Layer 2 entry point: start a real host against a fresh,
 * seeded state directory, wait for its watchers to settle, then for
 * every path ticket 001's Layer 1 report marked reachable, run
 * `session-open` -> `send-command {verb: "ID"}` -> assert a matching
 * `line` rx -> `session-close` over the host's own WebSocket contract,
 * plus the three card-truthfulness assertions read directly from the
 * live snapshot.
 *
 * Run with `npm run bench:layer2 -- --state-dir <dir> --out <path>
 * [--layer1 <path>] [--port <n>] [--skip-held]`, or directly: `npx tsx
 * scripts/bench/layer2/index.ts`. See `scripts/bench/README.md`.
 *
 * ## Which host binary this runs
 *
 * `node bin/robot-console.js --port <port> --no-open` -- the exact same
 * compiled entry point (`packages/host/dist/`, produced by `npm run
 * build`) a student's `npx robot-console` runs, not a `tsx`-from-source
 * shortcut. This is a deliberate choice: Layer 2 exists to prove the
 * *shipped* host's own WebSocket contract works against the real bench,
 * not merely that its TypeScript source does -- a gap between the two
 * (a stale `dist/`, a build-only bug) is exactly the kind of thing this
 * layer should be able to catch. `npm run build` is therefore a
 * documented prerequisite this script does not run for the caller
 * (kept fast and explicit, matching Layer 1's own "you already ran
 * mDNS discovery" posture) -- {@link main} fails fast with a clear
 * message if `packages/host/dist/cli.js` is missing.
 *
 * ## Order of operations
 *
 * 1. Read ticket 001's Layer 1 report JSON (`--layer1`).
 * 2. Run the exclusivity check (`layer1/exclusivity.ts`, reused
 *    directly) against every resource a Layer-1-reachable path touches.
 *    Same default-refuse / `--skip-held` contract as Layer 1.
 * 3. Prepare a fresh state dir: `--state-dir` if given (created if it
 *    does not exist), else a fresh directory under `os.tmpdir()`.
 *    `known-robots.json` is copied in from the real state dir
 *    (`resolveKnownRobotsFilePath()`'s own default location) if it
 *    exists -- the *real* file is only ever read, never written to or
 *    truncated in place.
 * 4. Spawn the host (see above), captured stdout/stderr for diagnostics,
 *    waiting for it to accept the WebSocket connection this run then
 *    uses for everything else.
 * 5. Wait for the snapshot stream to settle (`wsClient.ts`'s
 *    `waitForSettle`), recording which Layer-1-reachable paths' links
 *    never appeared at all.
 * 6. For each Layer-1-reachable path not marked `skipped` by step 2:
 *    `pathChecks.ts`'s `checkPath`.
 * 7. Run the three truthfulness assertions (`truthfulness.ts`) against
 *    the final snapshot, using every device with a Layer 1 `mbserial`/
 *    `wifi` path row as the "currently advertised" set (Layer 1's own
 *    mDNS discovery already gates whether such a row exists at all --
 *    see that ticket's `index.ts`).
 * 8. Write the JSON report; kill the host process this run started
 *    (never any other process) in a `finally`.
 */
import { writeFileSync, readFileSync, existsSync, mkdirSync, copyFileSync } from "node:fs";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describeHolders, evaluateExclusivity, findHolders, realLsofRunner, type ExclusivityResource } from "../layer1/exclusivity.js";
import { defaultKnownRobotsPath } from "../layer1/knownNames.js";
import type { Layer1Report, PathResult } from "../layer1/types.js";
import { BenchWsClient, waitForSettle } from "./wsClient.js";
import { checkPath, closeSiblingLinks, describeTarget, resolveOpenPayload, skippedCheck, type Layer2Target } from "./pathChecks.js";
import { runTruthfulnessAssertions, type AssertableDevice } from "./truthfulness.js";
import { auditDatabase, copyDatabaseForAudit } from "./auditDb.js";
import type { Layer2DeviceEntry, Layer2PathEntry, Layer2Report } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../..");

interface CliOptions {
  stateDir: string;
  outPath: string;
  layer1Path: string;
  port: number;
  skipHeld: boolean;
  /** 018-003: path to a **real** `console.sqlite` to audit (a copy is
   * made into scratch before it is ever opened -- see `auditDb.ts`'s
   * own doc comment). `undefined` when `--audit-db` was not passed --
   * the audit is entirely optional and independent of the rest of this
   * run. */
  auditDbPath: string | undefined;
}

const DEFAULT_PORT = 4799;

function parseArgs(argv: readonly string[]): CliOptions {
  let stateDir: string | undefined;
  let outPath = path.join(process.cwd(), "bench-layer2-report.json");
  let layer1Path = path.join(process.cwd(), "bench-layer1-report.json");
  let port = DEFAULT_PORT;
  let skipHeld = false;
  let auditDbPath: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--state-dir") {
      stateDir = argv[++i];
    } else if (arg === "--out") {
      outPath = argv[++i] ?? outPath;
    } else if (arg === "--layer1") {
      layer1Path = argv[++i] ?? layer1Path;
    } else if (arg === "--port") {
      const value = Number(argv[++i]);
      if (Number.isInteger(value)) {
        port = value;
      }
    } else if (arg === "--skip-held") {
      skipHeld = true;
    } else if (arg === "--audit-db") {
      auditDbPath = argv[++i];
    }
  }
  return {
    stateDir: stateDir ?? mkTempStateDir(),
    outPath,
    layer1Path,
    port,
    skipHeld,
    auditDbPath,
  };
}

function mkTempStateDir(): string {
  return path.join(os.tmpdir(), `bench-layer2-state-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
}

/** Resource an exclusivity check cares about, derived from a Layer 1
 * path's own `endpoint` -- reuses the exact same shape/meaning Layer 1
 * itself used to check the same resources before probing them. */
function resourceForEndpoint(endpoint: PathResult["endpoint"]): ExclusivityResource {
  if ("serialPath" in endpoint) {
    return { kind: "serial", path: endpoint.serialPath };
  }
  return { kind: "tcp", host: endpoint.ip ?? endpoint.host, port: endpoint.port };
}

function resourceKey(resource: ExclusivityResource): string {
  return resource.kind === "serial" ? resource.path : `${resource.host}:${resource.port}`;
}

/** Every device x reachable-path row from Layer 1, paired with the
 * {@link Layer2Target} it maps to -- `undefined` when the path is not
 * one of the four transports Layer 2 checks (Layer 1's own
 * `mbserial-contention` demonstration path, or a relay pool's own
 * status-check row, which is not "a robot reached through a relay"). */
function targetForPath(deviceName: string, deviceKind: string, path: PathResult): Layer2Target | undefined {
  if (path.path === "usb") {
    return { kind: "direct", deviceName, transport: "usb", deviceKind };
  }
  if (path.path === "mbserial") {
    return { kind: "direct", deviceName, transport: "mbserial", deviceKind };
  }
  if (path.path === "wifi") {
    return { kind: "direct", deviceName, transport: "wifi", deviceKind };
  }
  const radioMatch = /^radio-via-mbrelay:(.+)$/.exec(path.path);
  if (radioMatch && deviceKind !== "pool") {
    return { kind: "radio", deviceName, relayName: radioMatch[1]! };
  }
  return undefined;
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
    console.error(`[bench:layer2] ${distCliPath} does not exist -- run "npm run build" first (Layer 2 tests the shipped host, not source).`);
    process.exitCode = 1;
    return;
  }

  if (!existsSync(options.layer1Path)) {
    console.error(`[bench:layer2] Layer 1 report not found at ${options.layer1Path} -- run "npm run bench:layer1" first, or pass --layer1 <path>.`);
    process.exitCode = 1;
    return;
  }
  const layer1: Layer1Report = JSON.parse(readFileSync(options.layer1Path, "utf8"));

  // ---- Exclusivity check (reused from Layer 1) -----------------------
  const reachablePaths = layer1.devices.flatMap((device) => device.paths.filter((p) => p.status === "pass").map((path) => ({ device, path })));
  const resources = reachablePaths.map(({ path }) => resourceForEndpoint(path.endpoint));
  const holders = await findHolders(resources, realLsofRunner);
  const outcome = evaluateExclusivity(holders, options.skipHeld);
  if (outcome.refuse) {
    console.error("[bench:layer2] REFUSING to run -- another process already holds a resource this run needs:");
    console.error(describeHolders(outcome.holders));
    console.error("Pass --skip-held to probe everything else and mark these paths 'skipped' instead.");
    process.exitCode = 1;
    return;
  }
  const skippedReasonByResource = new Map(outcome.skipped.map((s) => [s.resource, s.reason]));

  // ---- Prepare the scratch state dir ---------------------------------
  mkdirSync(options.stateDir, { recursive: true });
  const realKnownRobotsPath = defaultKnownRobotsPath();
  if (existsSync(realKnownRobotsPath)) {
    copyFileSync(realKnownRobotsPath, path.join(options.stateDir, "known-robots.json"));
    console.log(`[bench:layer2] seeded ${options.stateDir}/known-robots.json from ${realKnownRobotsPath} (read-only copy -- the real file is never written to)`);
  } else {
    console.log(`[bench:layer2] no known-robots.json found at ${realKnownRobotsPath} -- starting with an empty roster`);
  }

  // ---- Start the host -------------------------------------------------
  // `bin/robot-console.js` -- not `packages/host/dist/cli.js` directly
  // -- is the actual runnable entry point: `cli.js` only *exports*
  // `main`, it never calls it itself (that dynamic import + invocation
  // is `bin/robot-console.js`'s own one job, per its module comment).
  // Spawning `dist/cli.js` directly would load the module and exit
  // immediately with nothing ever listening -- caught live running this
  // exact command by hand while building this ticket.
  const binPath = path.join(REPO_ROOT, "bin", "robot-console.js");
  const url = `ws://127.0.0.1:${options.port}/`;
  // This harness host must never run its own relay sweeper.
  // `watchers/relaySweeper.ts` opens an idle usb relay's port on its own
  // schedule; with it running, this host instance would race Layer 1's
  // own raw probes (or another harness host instance) against the
  // identical physical relay, the exact "sweeper/reconciler opens it
  // intermittently" contention this ticket's own exclusivity hardening
  // (`layer1/exclusivity.ts`) exists to detect when a *stakeholder's*
  // host does it -- this harness must not do it to itself.
  //
  // 018-010: the sweeper now defaults OFF for every caller (`--sweep`/
  // `ROBOT_CONSOLE_ENABLE_SWEEP` is the opt back in) -- `--no-sweep`
  // below is kept only as a harmless, explicit no-op for readability
  // (this spawn's own command line still says exactly what it means:
  // no sweeping), not because it is still what turns the sweeper off.
  console.log(`[bench:layer2] starting host: node ${binPath} --port ${options.port} --no-open --no-sweep (ROBOT_CONSOLE_STATE_DIR=${options.stateDir})`);
  const child: ChildProcessByStdio<null, Readable, Readable> = spawn(
    process.execPath,
    [binPath, "--port", String(options.port), "--no-open", "--no-sweep"],
    {
      env: { ...process.env, ROBOT_CONSOLE_STATE_DIR: options.stateDir },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let hostOutput = "";
  child.stdout.on("data", (chunk: Buffer) => {
    hostOutput += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    hostOutput += chunk.toString();
  });

  let client: BenchWsClient | undefined;
  try {
    await waitForHostReady(url, 20_000);
    console.log(`[bench:layer2] host accepted a WebSocket connection at ${url}`);
    client = await BenchWsClient.connect({ url });

    // ---- Settle ---------------------------------------------------------
    console.log("[bench:layer2] waiting for the snapshot stream to settle (unchanged for 5s, bounded at 90s)...");
    const settle = await waitForSettle(client, { stableForMs: 5_000, boundedMs: 90_000 });
    console.log(`[bench:layer2] settle: ${settle.settled ? "settled" : "NOT settled (bound reached)"} after ${settle.elapsedMs}ms`);

    const finalSnapshot = settle.finalSnapshot ?? client.snapshot;

    // Which reachable paths' targets never got a link in the final
    // snapshot at all -- recorded regardless of what happens next.
    const neverAppeared: string[] = [];
    for (const { device, path } of reachablePaths) {
      const target = targetForPath(device.name, device.kind, path);
      if (target === undefined) {
        continue;
      }
      if (finalSnapshot === undefined) {
        neverAppeared.push(describeTarget(target));
        continue;
      }
      const found =
        target.kind === "direct"
          ? finalSnapshot.devices.some((d) => d.name === target.deviceName && d.links.some((l) => l.transport === target.transport))
          : finalSnapshot.devices.some((d) => d.name === target.relayName && d.links.some((l) => l.transport === "mbrelay"));
      if (!found) {
        neverAppeared.push(describeTarget(target));
      }
    }

    // ---- Per-path checks --------------------------------------------
    const deviceEntries = new Map<string, Layer2DeviceEntry>();
    for (const { device, path } of reachablePaths) {
      const target = targetForPath(device.name, device.kind, path);
      if (target === undefined) {
        continue;
      }
      const resourceKeyForPath = resourceKey(resourceForEndpoint(path.endpoint));
      const skipReason = skippedReasonByResource.get(resourceKeyForPath);

      let layer2Check;
      if (skipReason !== undefined) {
        layer2Check = skippedCheck(skipReason);
      } else {
        // 018-007 Step 0: a radio or wifi check must be able to trust
        // that a matching reply came from the path under test, not a
        // sibling link (e.g. mbserial) also open on the same device --
        // close every other currently-connected link on this device
        // first. Never touches the relay pool's own device row (radio's
        // `relayName` is a different device entirely), and this harness
        // owns a fresh host per run, so nothing closed here is restored.
        if (target.kind === "radio" || (target.kind === "direct" && target.transport === "wifi")) {
          const keepPayload = target.kind === "direct" ? resolveOpenPayload(client.snapshot ?? { devices: [], unassigned: [] }, target) : undefined;
          const keepLinkId = keepPayload && "linkId" in keepPayload ? keepPayload.linkId : undefined;
          const closed = closeSiblingLinks(client, target.deviceName, keepLinkId);
          if (closed.length > 0) {
            console.log(`[bench:layer2] closed sibling link(s) ${closed.join(", ")} on "${target.deviceName}" before checking ${describeTarget(target)}`);
            await new Promise((resolve) => setTimeout(resolve, 750));
          }
        }
        console.log(`[bench:layer2] checking ${describeTarget(target)}...`);
        layer2Check = await checkPath(client, target);
        console.log(`[bench:layer2] ${describeTarget(target)} -> ${layer2Check.status} (${layer2Check.reason})`);
      }

      const entry: Layer2PathEntry = {
        path: path.path,
        layer1: { status: path.status, reason: path.reason },
        layer2: layer2Check,
      };
      const deviceEntry = deviceEntries.get(device.name) ?? { name: device.name, kind: device.kind, paths: [] };
      deviceEntry.paths.push(entry);
      deviceEntries.set(device.name, deviceEntry);
    }

    // ---- Truthfulness assertions --------------------------------------
    const advertisedNames = new Set(
      layer1.devices.filter((d) => d.paths.some((p) => p.path === "mbserial" || p.path === "wifi")).map((d) => d.name),
    );
    const assertableDevices: AssertableDevice[] = (finalSnapshot?.devices ?? []).map((d) => ({
      name: d.name,
      kind: d.kind,
      role: d.role,
      links: d.links.map((l) => ({ id: l.id, transport: l.transport, state: l.state, reason: l.reason })),
    }));
    // 018-003 strengthening: Layer 1's own banner-based classification
    // (`classifyUsbDevice` in `layer1/index.ts`, derived only from an
    // actual captured banner line, never from a device's own possibly-
    // absent snapshot `role`) is threaded into the relay-as-robot
    // assertion so a relay Layer 1 positively identified is still
    // flagged even when the live snapshot's own `role` is `null` (e.g.
    // `vevav`, which never re-banners after the harness's own
    // break-reset).
    const layer1RelayNames = new Set(layer1.devices.filter((d) => d.kind === "relay").map((d) => d.name));
    const assertions = runTruthfulnessAssertions(assertableDevices, advertisedNames, layer1RelayNames);

    // ---- Database audit mode (018-003) --------------------------------
    // Entirely independent of the live host round-trip above: audits a
    // *copy* of a real, accumulated `console.sqlite` (never opened in
    // place -- `auditDb.ts`'s own doc comment) so the truthfulness
    // checks can be verified against real history, not only this run's
    // fresh scratch state dir.
    let auditDb: Layer2Report["auditDb"];
    if (options.auditDbPath !== undefined) {
      const copyDir = path.join(options.stateDir, "audit-db-copy");
      mkdirSync(copyDir, { recursive: true });
      console.log(`[bench:layer2] audit-db: copying ${options.auditDbPath} -> ${copyDir}...`);
      const copiedPath = copyDatabaseForAudit(options.auditDbPath, copyDir);
      const auditReport = auditDatabase(copiedPath);
      auditDb = { sourcePath: options.auditDbPath, ...auditReport };
      console.log(`[bench:layer2] audit-db: ${auditReport.deviceCount} device row(s), ${auditReport.linkCount} link row(s), ${auditReport.findings.length} finding(s)`);
      for (const finding of auditReport.findings) {
        console.log(`[bench:layer2] audit-db finding [${finding.check}] ${finding.device}: ${finding.detail}`);
      }
    }

    const finishedAt = new Date();
    const report: Layer2Report = {
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      host: { os: `${os.platform()} ${os.release()}`, node: process.version },
      hostUnderTest: { command: `node ${binPath} --port ${options.port} --no-open --no-sweep`, port: options.port, stateDir: options.stateDir },
      settle: { settled: settle.settled, elapsedMs: settle.elapsedMs, neverAppeared },
      devices: [...deviceEntries.values()].sort((a, b) => a.name.localeCompare(b.name)),
      assertions,
      ...(auditDb !== undefined ? { auditDb } : {}),
    };

    writeFileSync(options.outPath, JSON.stringify(report, null, 2), "utf8");
    console.log(`[bench:layer2] wrote report to ${options.outPath}`);
    printSummaryTable(report);
  } catch (error) {
    console.error("[bench:layer2] host output so far:\n" + hostOutput);
    throw error;
  } finally {
    client?.close();
    // Kill only the host process this run started -- never any other
    // process (the ticket's own hard constraint, same as Layer 1's
    // exclusivity check never killing a holder).
    child.kill("SIGTERM");
  }
}

function printSummaryTable(report: Layer2Report): void {
  console.log("\ndevice           path                              layer1    layer2    reason");
  console.log("-".repeat(110));
  for (const device of report.devices) {
    for (const p of device.paths) {
      console.log(
        `${device.name.padEnd(16)} ${p.path.padEnd(33)} ${p.layer1.status.padEnd(9)} ${p.layer2.status.padEnd(9)} ${p.layer2.reason.slice(0, 90)}`,
      );
    }
  }
  console.log("\nassertion                     device           pass   reason");
  console.log("-".repeat(110));
  for (const a of report.assertions) {
    console.log(`${a.assertion.padEnd(29)} ${a.device.padEnd(16)} ${String(a.pass).padEnd(6)} ${a.reason.slice(0, 90)}`);
  }
}

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  main().catch((error: unknown) => {
    console.error("[bench:layer2] fatal error:", error);
    process.exitCode = 1;
  });
}

export { main, parseArgs, targetForPath, resourceForEndpoint, resourceKey };
