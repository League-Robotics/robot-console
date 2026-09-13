#!/usr/bin/env -S npx tsx
/**
 * index.ts — Layer 1 entry point: run every raw-device probe (USB
 * serial, mbserial TCP, WiFi `_robotlink`, the mbrelay radio pool)
 * against whatever the bench currently has attached/advertised, with no
 * host process involved, and write one JSON reachability report.
 *
 * Run with `npm run bench:layer1 -- [--skip-held] [--out <path>]`, or
 * directly: `npx tsx scripts/bench/layer1/index.ts`. See
 * `scripts/bench/README.md` for the full usage/exclusivity contract.
 *
 * ## Order of operations
 *
 * 1. Enumerate USB DAPLink ports and browse mDNS (`_mbserial._tcp`,
 *    `_mbrelay._tcp`, `_robotlink._tcp`/`_udp`) for
 *    {@link DEFAULT_BROWSE_WINDOW_MS}.
 * 2. Resolve every `.local` host to its IPv4 address first
 *    (`dnsResolve.ts`) — this harness never dials a bare hostname.
 * 3. Run the exclusivity check (`exclusivity.ts`) against every serial
 *    path and resolved TCP endpoint this run is about to touch. Default:
 *    refuse outright, naming every holder, if any resource is held.
 *    `--skip-held`: never refuse — instead mark just the held
 *    resources' device/path rows `"skipped"` and probe everything else.
 * 4. Probe USB boards directly (banner-only identity, per the ticket's
 *    own escape hatch — see `usbProbe.ts`'s module doc comment).
 * 5. Probe every mbserial bridge and WiFi robot mDNS discovered.
 * 6. Run the mbrelay pool's command-plane sweep across every known name
 *    (known-robots.json plus every name seen on mDNS/USB this run), then
 *    the full data-plane handshake against whichever of those names the
 *    sweep found reachable.
 * 7. Write the JSON report and print a compact summary table.
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

import { resolveIPv4, normalizeHostname } from "./dnsResolve.js";
import { describeHolders, evaluateExclusivity, findHolders, realLsofRunner, type ExclusivityResource } from "./exclusivity.js";
import {
  browseServices,
  parseRegistryPort,
  wifiNameFromTxt,
  DEFAULT_BROWSE_WINDOW_MS,
  DEFAULT_ROBOTLINK_BROWSE_WINDOW_MS,
} from "./mdnsBrowse.js";
import { readKnownRobotNames } from "./knownNames.js";
import { listDaplinkPorts, probeUsb, toCalloutPath } from "./usbProbe.js";
import { probeMbserial, probeMbserialContention } from "./mbserialProbe.js";
import { probeWifi } from "./wifiProbe.js";
import { FRIENDLY_NAME_PATTERN, namesNeedingWifiLookup, WIFI_ROBOTLINK_PORT } from "./wifiNameLookup.js";
import {
  probeMbrelayDataPlane,
  probeMbrelayStatus,
  runCommandPlaneSweep,
  type KnownRadioName,
} from "./mbrelayProbe.js";
import { TcpLineSession } from "./tcpLineSession.js";
import { resolveRadioAddress } from "./registry.js";
import { nameToRadioAddress } from "@robot-console/protocol";
import { attemptSilentRelayHidReset } from "./hidReset.js";
import type { DeviceEntry, Layer1Report, PathResult, TcpProbeEndpoint } from "./types.js";

interface CliOptions {
  skipHeld: boolean;
  outPath: string;
  /** 018-003 opt-in: try one DAPLink vendor-command HID reset
   * (`hidReset.ts`) against any USB device that never produced a banner
   * at all, even after `usbProbe.ts`'s own break-reset retry -- e.g.
   * `vevav`, live-verified silent through one break during the 018-002
   * bench run. Never on by default -- resetting a physical board is a
   * stronger action than anything else this harness does unprompted. */
  hidResetSilentRelays: boolean;
}

function parseArgs(argv: readonly string[]): CliOptions {
  let skipHeld = false;
  let outPath = path.join(process.cwd(), "bench-layer1-report.json");
  let hidResetSilentRelays = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--skip-held") {
      skipHeld = true;
    } else if (argv[i] === "--hid-reset-silent-relays") {
      hidResetSilentRelays = true;
    } else if (argv[i] === "--out") {
      const next = argv[i + 1];
      if (next === undefined) {
        throw new Error("--out requires a path argument");
      }
      outPath = next;
      i += 1;
    }
  }
  return { skipHeld, outPath, hidResetSilentRelays };
}

function tcpResourceKey(ip: string, port: number): string {
  return `${ip}:${port}`;
}

class DeviceRegistry {
  private readonly devices = new Map<string, DeviceEntry>();

  get(name: string, kind: DeviceEntry["kind"]): DeviceEntry {
    let entry = this.devices.get(name);
    if (!entry) {
      entry = { name, kind, paths: [] };
      this.devices.set(name, entry);
    } else if (entry.kind === "unknown" && kind !== "unknown") {
      entry.kind = kind;
    }
    return entry;
  }

  addPath(name: string, kind: DeviceEntry["kind"], result: PathResult): void {
    this.get(name, kind).paths.push(result);
  }

  all(): DeviceEntry[] {
    return [...this.devices.values()].sort((a, b) => a.name.localeCompare(b.name));
  }
}

function skippedResult(path: string, endpoint: PathResult["endpoint"], reason: string): PathResult {
  return { path, endpoint, status: "skipped", reason, transcript: [] };
}

/**
 * Derive a USB device's report name/kind from its probe result. Pure —
 * directly testable independent of any real port.
 *
 * Classification is derived **only** from an actual captured banner
 * line (an `"rx"` transcript entry), never from `result.reason`'s own
 * human-readable prose: 018-002's break-reset retry path deliberately
 * says "relay may be parked in the data plane" in its *failure* reason
 * (speculating about why no banner arrived at all), which would
 * otherwise false-positive this device as `kind: "relay"` via a naive
 * substring match on "relay" even though no banner — confirming
 * nothing — was ever received. Caught live on the 2026-09-13 bench
 * evidence run for exactly this reason before this fix.
 */
export function classifyUsbDevice(
  result: Pick<PathResult, "transcript">,
  fallbackName: string,
): { deviceName: string; kind: DeviceEntry["kind"] } {
  const bannerLine = result.transcript.find((l) => l.dir === "rx")?.line;
  const deviceName = bannerLine?.match(/(?:robot|relay)\s+(\S+)\s+\d/)?.[1] ?? bannerLine?.match(/relay:(\w+):/)?.[1] ?? fallbackName;
  const kind: DeviceEntry["kind"] = bannerLine === undefined ? "unknown" : /relay/i.test(bannerLine) ? "relay" : "robot";
  return { deviceName, kind };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const startedAt = new Date();

  console.log(
    `[bench:layer1] browsing mDNS for ${DEFAULT_BROWSE_WINDOW_MS}ms (up to ${DEFAULT_ROBOTLINK_BROWSE_WINDOW_MS}ms if no _robotlink service has appeared yet -- see mdnsBrowse.ts's doc comment)...`,
  );
  const [daplinkPorts, discovered] = await Promise.all([listDaplinkPorts(), browseServices()]);
  const knownNames = readKnownRobotNames();

  const mbserialServices = discovered.filter((s) => s.type === "mbserial-tcp");
  const mbrelayServices = discovered.filter((s) => s.type === "mbrelay-tcp");
  const wifiServices = discovered.filter((s) => s.type === "robotlink-tcp");
  const wifiUdpServices = discovered.filter((s) => s.type === "robotlink-udp");
  console.log(
    `[bench:layer1] discovered: ${daplinkPorts.length} USB DAPLink port(s), ${mbserialServices.length} mbserial bridge(s), ${mbrelayServices.length} mbrelay pool(s), ${wifiServices.length} WiFi robot(s) (+${wifiUdpServices.length} on _udp, report-only)`,
  );

  // Resolve every .local host to an IPv4 address up front (dnsResolve.ts)
  // -- this is itself bench evidence (a slow/failed resolution here is
  // exactly the host-side hang this sprint's bench facts describe), so
  // every endpoint's resolveMs is carried through to the report even on
  // failure.
  async function resolveEndpoint(host: string, port: number): Promise<TcpProbeEndpoint> {
    const hostname = normalizeHostname(host);
    const { ip, resolveMs, error } = await resolveIPv4(hostname);
    if (error) {
      console.log(`[bench:layer1] resolve ${hostname} FAILED after ${resolveMs}ms: ${error}`);
    } else {
      console.log(`[bench:layer1] resolve ${hostname} -> ${ip} in ${resolveMs}ms`);
    }
    return { host: hostname, port, ...(ip !== undefined ? { ip } : {}), resolveMs };
  }

  const mbserialEndpoints = await Promise.all(
    mbserialServices.map(async (s) => ({ service: s, endpoint: await resolveEndpoint(s.host, s.port) })),
  );
  const mbrelayEndpoints = await Promise.all(
    mbrelayServices.map(async (s) => ({ service: s, endpoint: await resolveEndpoint(s.host, s.port) })),
  );
  const wifiEndpoints = await Promise.all(
    wifiServices.map(async (s) => ({ service: s, endpoint: await resolveEndpoint(s.host, s.port) })),
  );

  // ---- Exclusivity check --------------------------------------------
  // The exclusivity check must ask about the same path `usbProbe.ts`
  // actually opens -- darwin's `cu.` (callout) device, not the `tty.`
  // (dial-in) path `serialport.list()` itself reports. These are
  // *different* device nodes for the same physical port: a process
  // holding the `cu.` path (e.g. `npm run dev`) is invisible to `lsof`
  // on the `tty.` path, so checking the wrong one silently reports
  // "free" for a port that then fails to open with `EBUSY`
  // ("Resource temporarily unavailable ... Cannot lock port") -- this
  // was caught live on the 2026-09-13 bench evidence run for exactly
  // this reason before this fix.
  const serialResources: ExclusivityResource[] = daplinkPorts.map((p) => ({
    kind: "serial" as const,
    path: toCalloutPath(p.path),
  }));
  const tcpResources: ExclusivityResource[] = [
    ...mbserialEndpoints.map(({ endpoint }) => ({ kind: "tcp" as const, host: endpoint.ip ?? endpoint.host, port: endpoint.port })),
    ...mbrelayEndpoints.map(({ endpoint }) => ({ kind: "tcp" as const, host: endpoint.ip ?? endpoint.host, port: endpoint.port })),
    ...wifiEndpoints.map(({ endpoint }) => ({ kind: "tcp" as const, host: endpoint.ip ?? endpoint.host, port: endpoint.port })),
  ];

  const holders = await findHolders([...serialResources, ...tcpResources], realLsofRunner);
  const outcome = evaluateExclusivity(holders, options.skipHeld);

  if (outcome.refuse) {
    console.error("[bench:layer1] REFUSING to run -- another process already holds a resource this run needs:");
    console.error(describeHolders(outcome.holders));
    console.error("Pass --skip-held to probe everything else and mark these resources 'skipped' instead.");
    process.exitCode = 1;
    return;
  }

  const skippedReasonByResource = new Map(outcome.skipped.map((s) => [s.resource, s.reason]));
  if (skippedReasonByResource.size > 0) {
    console.log(`[bench:layer1] --skip-held: ${skippedReasonByResource.size} resource(s) held, skipping just those:`);
    for (const [resource, reason] of skippedReasonByResource) {
      console.log(`  ${resource}: ${reason}`);
    }
  }

  const registry = new DeviceRegistry();

  // ---- USB ------------------------------------------------------------
  for (const port of daplinkPorts) {
    const skipReason = skippedReasonByResource.get(toCalloutPath(port.path));
    const name = port.serialNumber ?? port.path;
    if (skipReason !== undefined) {
      registry.addPath(name, "unknown", skippedResult("usb", { serialPath: toCalloutPath(port.path) }, skipReason));
      continue;
    }
    console.log(`[bench:layer1] usb: probing ${port.path} (serial ${port.serialNumber ?? "?"})...`);
    let result = await probeUsb(port);
    let { deviceName, kind } = classifyUsbDevice(result, name);

    // 018-003 opt-in only: a device that produced no banner at all, even
    // after usbProbe.ts's own break-reset retry, is exactly the state
    // live-verified against vevav -- try one DAPLink vendor HID reset
    // (hidReset.ts) and re-probe once, rather than reporting fail
    // outright. Never runs unless the caller explicitly opted in.
    if (options.hidResetSilentRelays && kind === "unknown") {
      const calloutPath = toCalloutPath(port.path);
      console.log(`[bench:layer1] usb: ${calloutPath} produced no banner -- attempting DAPLink HID reset (--hid-reset-silent-relays)...`);
      const hidReset = await attemptSilentRelayHidReset(calloutPath);
      console.log(`[bench:layer1] usb: HID reset for ${calloutPath} -> ${hidReset.attempted ? (hidReset.ok ? "ok" : "failed") : "not attempted"} (${hidReset.detail})`);
      result = { ...result, transcript: [...result.transcript, { t: result.transcript.at(-1)?.t ?? 0, dir: "info", line: `HID reset attempt: ${hidReset.detail}` }] };
      if (hidReset.ok) {
        console.log(`[bench:layer1] usb: re-probing ${port.path} after HID reset...`);
        const reprobed = await probeUsb(port);
        result = { ...reprobed, transcript: [...result.transcript, ...reprobed.transcript] };
        ({ deviceName, kind } = classifyUsbDevice(result, name));
        console.log(`[bench:layer1] usb: ${port.path} after HID reset -> ${result.status} (${result.reason})`);
      }
    }

    registry.addPath(deviceName, kind, result);
    console.log(`[bench:layer1] usb: ${port.path} -> ${result.status} (${result.reason})`);
  }

  // ---- mbserial ---------------------------------------------------------
  for (const { service, endpoint } of mbserialEndpoints) {
    const key = tcpResourceKey(endpoint.ip ?? endpoint.host, endpoint.port);
    const skipReason = skippedReasonByResource.get(key);
    if (skipReason !== undefined) {
      registry.addPath(service.name, "robot", skippedResult("mbserial", endpoint, skipReason));
      continue;
    }
    console.log(`[bench:layer1] mbserial: probing ${service.name} at ${endpoint.host} (${endpoint.ip})...`);
    const result = await probeMbserial(service.name, endpoint);
    registry.addPath(service.name, "robot", result);
    console.log(`[bench:layer1] mbserial: ${service.name} -> ${result.status} (${result.reason})`);
  }
  // Demonstrate the single-client contention behavior against the first
  // reachable mbserial bridge, per this ticket's own acceptance
  // criteria ("distinguishes ERR busy from a plain timeout").
  const firstFreeMbserial = mbserialEndpoints.find(
    ({ endpoint }) => skippedReasonByResource.get(tcpResourceKey(endpoint.ip ?? endpoint.host, endpoint.port)) === undefined,
  );
  if (firstFreeMbserial) {
    console.log(`[bench:layer1] mbserial: demonstrating single-client contention against ${firstFreeMbserial.service.name}...`);
    const contention = await probeMbserialContention(firstFreeMbserial.endpoint);
    registry.addPath(firstFreeMbserial.service.name, "robot", contention);
    console.log(`[bench:layer1] mbserial contention -> ${contention.status} (${contention.reason})`);
  }

  // ---- WiFi ---------------------------------------------------------
  for (const { service, endpoint } of wifiEndpoints) {
    const name = wifiNameFromTxt(service);
    const key = tcpResourceKey(endpoint.ip ?? endpoint.host, endpoint.port);
    const skipReason = skippedReasonByResource.get(key);
    if (skipReason !== undefined) {
      registry.addPath(name, "robot", skippedResult("wifi", endpoint, skipReason));
      continue;
    }
    console.log(`[bench:layer1] wifi: probing ${name} at ${endpoint.host} (${endpoint.ip})...`);
    const result = await probeWifi(name, endpoint);
    registry.addPath(name, "robot", result);
    console.log(`[bench:layer1] wifi: ${name} -> ${result.status} (${result.reason})`);
  }

  // Only a well-formed five-letter micro:bit name is representable as a
  // radio address at all (`nameToRadioAddress`/`nameToValue` throw for
  // anything else) -- `registry.all()` can also carry a USB board's raw
  // serial number as its "name" (this harness's own fallback, per
  // `usbProbe.ts`'s doc comment, for a board whose banner never arrived)
  // or the mbrelay pool's own name (e.g. "torture", not five letters
  // either). Filtering here, once, is what keeps both the WiFi
  // by-name-lookup step below and the mbrelay sweep further down from
  // crashing on either — caught live on the 2026-09-13 bench evidence
  // run before this fix (`nameToValue` threw on a raw USB serial
  // string).
  const usbNames = registry.all().map((d) => d.name);
  const announcedWifiNames = new Set(wifiEndpoints.map(({ service }) => wifiNameFromTxt(service)));
  const allKnownNames = [...new Set([...knownNames, ...mbserialServices.map((s) => s.name), ...announcedWifiNames, ...usbNames])].filter((name) =>
    FRIENDLY_NAME_PATTERN.test(name),
  );

  // ---- WiFi by name lookup (018-003 Step 0 hardening) -----------------
  // `_robotlink` is a periodic-announcement-only service (mdnsBrowse.ts's
  // own doc comment) -- a robot that hasn't announced again yet within
  // *this* run's browse window is otherwise invisible to Layer 1 even
  // though it is right there on the network, live-verified on
  // 2026-09-13 (gopiv's own `wifi` row went missing on a re-run purely
  // because its next announcement hadn't landed in time). For every
  // known name not already found by mDNS announcement, resolve
  // `<name>.local` directly (bounded, `dnsResolve.ts`'s own
  // `DEFAULT_RESOLVE_TIMEOUT_MS`) and dial port 7654 -- see
  // `wifiNameLookup.ts`'s own module doc comment.
  const lookupCandidates = namesNeedingWifiLookup(allKnownNames, announcedWifiNames);
  if (lookupCandidates.length > 0) {
    console.log(`[bench:layer1] wifi-by-name: checking ${lookupCandidates.length} known name(s) not seen via mDNS announcement: ${lookupCandidates.join(", ")}...`);
  }
  for (const name of lookupCandidates) {
    const hostname = `${name}.local`;
    const { ip, resolveMs, error } = await resolveIPv4(hostname);
    if (ip === undefined) {
      console.log(`[bench:layer1] wifi-by-name: ${name} -> resolve FAILED after ${resolveMs}ms: ${error} (not necessarily a WiFi robot -- no row emitted)`);
      continue;
    }
    const endpoint: TcpProbeEndpoint = { host: hostname, ip, port: WIFI_ROBOTLINK_PORT, resolveMs };
    // Best-effort exclusivity: the main exclusivity check above only
    // covers what mDNS had already discovered by that point. Rather than
    // abort a run that has already probed everything else over a
    // resource discovered only now, a held resource found here is simply
    // skipped (never probed), regardless of --skip-held -- this is
    // strictly more conservative than the main check's refuse mode, not
    // less.
    const holdersHere = await findHolders([{ kind: "tcp", host: ip, port: WIFI_ROBOTLINK_PORT }], realLsofRunner);
    if (holdersHere.length > 0) {
      console.log(`[bench:layer1] wifi-by-name: ${name} -> skipping, held by ${describeHolders(holdersHere)}`);
      continue;
    }
    console.log(`[bench:layer1] wifi-by-name: probing ${name} at ${hostname} (${ip})...`);
    const result = await probeWifi(name, endpoint);
    if (result.status === "pass") {
      registry.addPath(name, "robot", { ...result, reason: `${result.reason} (found by name lookup, not announcement)` });
      console.log(`[bench:layer1] wifi-by-name: ${name} -> pass (found by name lookup, not announcement)`);
    } else {
      console.log(`[bench:layer1] wifi-by-name: ${name} -> ${result.status} (${result.reason}) -- no row emitted, not a confirmed WiFi robot`);
    }
  }

  // ---- mbrelay pool(s) ------------------------------------------------
  for (const { service, endpoint } of mbrelayEndpoints) {
    const poolName = service.name;
    const key = tcpResourceKey(endpoint.ip ?? endpoint.host, endpoint.port);
    const skipReason = skippedReasonByResource.get(key);
    if (skipReason !== undefined) {
      registry.addPath(poolName, "pool", skippedResult(`radio-via-mbrelay:${poolName}`, endpoint, skipReason));
      continue;
    }

    console.log(`[bench:layer1] mbrelay: querying pool status for ${poolName}...`);
    const statusResult = await probeMbrelayStatus(poolName, endpoint);
    registry.addPath(poolName, "pool", statusResult);

    const registryPort = parseRegistryPort(service.txt?.registry);
    const namesWithAddresses: KnownRadioName[] = [];
    for (const name of allKnownNames) {
      const resolved =
        registryPort !== undefined
          ? await resolveRadioAddress(endpoint.ip ?? endpoint.host, registryPort, name)
          : undefined;
      const address = resolved ?? nameToRadioAddress(name);
      namesWithAddresses.push({ name, channel: address.channel, group: address.group });
    }

    console.log(`[bench:layer1] mbrelay: command-plane sweep of ${namesWithAddresses.length} known name(s) via ${poolName}...`);
    const sweepConnect = await TcpLineSession.connect(endpoint.ip ?? endpoint.host, endpoint.port);
    if (!sweepConnect.ok) {
      for (const { name } of namesWithAddresses) {
        registry.addPath(name, "robot", {
          path: `radio-via-mbrelay:${poolName}`,
          endpoint,
          status: "fail",
          reason: `sweep connect failed: ${sweepConnect.error}`,
          transcript: [],
        });
      }
      continue;
    }
    const sweepResults = await runCommandPlaneSweep(sweepConnect.session, namesWithAddresses);
    sweepConnect.session.close();

    const reachableNames: string[] = [];
    for (const { name } of namesWithAddresses) {
      const sweepOutcome = sweepResults.get(name);
      if (!sweepOutcome) {
        continue;
      }
      if (sweepOutcome.status === "pass") {
        reachableNames.push(name);
      }
      registry.addPath(name, "robot", {
        path: `radio-via-mbrelay:${poolName}`,
        endpoint,
        status: sweepOutcome.status,
        reason: sweepOutcome.reason,
        transcript: sweepOutcome.transcript,
      });
      console.log(`[bench:layer1] mbrelay sweep: ${name} -> ${sweepOutcome.status} (${sweepOutcome.reason})`);
    }
    const restoreOutcome = sweepResults.get("__restore__");
    if (restoreOutcome) {
      console.warn(`[bench:layer1] mbrelay: WARNING -- failed to restore default tuning: ${restoreOutcome.reason}`);
    }

    // Full data-plane handshake against every name the sweep found
    // reachable -- the ticket's own required demonstration.
    for (const name of reachableNames) {
      const found = namesWithAddresses.find((n) => n.name === name)!;
      console.log(`[bench:layer1] mbrelay: full data-plane handshake for ${name} (ch${found.channel}/grp${found.group}) via ${poolName}...`);
      const dataPlaneResult = await probeMbrelayDataPlane(poolName, name, endpoint, found.channel, found.group);
      // Replace the sweep-only entry with the fuller demonstration for
      // this name -- both cover the same path label, and the data-plane
      // demonstration is strictly stronger evidence.
      const entry = registry.get(name, "robot");
      const idx = entry.paths.findIndex((p) => p.path === `radio-via-mbrelay:${poolName}`);
      if (idx >= 0) {
        entry.paths[idx] = dataPlaneResult;
      } else {
        entry.paths.push(dataPlaneResult);
      }
      console.log(`[bench:layer1] mbrelay data-plane: ${name} -> ${dataPlaneResult.status} (${dataPlaneResult.reason})`);
    }
  }

  const finishedAt = new Date();
  const report: Layer1Report = {
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    host: { os: `${os.platform()} ${os.release()}`, node: process.version },
    holders: outcome.holders as Layer1Report["holders"],
    devices: registry.all(),
  };

  writeFileSync(options.outPath, JSON.stringify(report, null, 2), "utf8");
  console.log(`[bench:layer1] wrote report to ${options.outPath}`);
  printSummaryTable(report);
}

function printSummaryTable(report: Layer1Report): void {
  console.log("\ndevice           kind      path                              status    reason");
  console.log("-".repeat(100));
  for (const device of report.devices) {
    for (const p of device.paths) {
      console.log(
        `${device.name.padEnd(16)} ${device.kind.padEnd(9)} ${p.path.padEnd(33)} ${p.status.padEnd(9)} ${p.reason.slice(0, 80)}`,
      );
    }
  }
}

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  main().catch((error: unknown) => {
    console.error("[bench:layer1] fatal error:", error);
    process.exitCode = 1;
  });
}

export { main, parseArgs };
