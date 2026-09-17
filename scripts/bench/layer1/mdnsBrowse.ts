/**
 * mdnsBrowse.ts — browse the four service types Layer 1 cares about
 * (`_mbserial._tcp`, `_mbrelay._tcp`, `_robotlink._tcp`,
 * `_robotlink._udp`) for a bounded window, using `bonjour-service`
 * directly.
 *
 * This module calls `bonjour-service` itself rather than importing
 * `packages/host/src/discovery/mdnsDiscovery.ts`'s `createBonjourBackend`
 * — that function is host-internal orchestration (its own re-query/
 * aging/liveness bookkeeping this harness has no use for); `bonjour-
 * service` itself is the third-party npm package both modules are
 * ultimately built on, and using it directly here keeps Layer 1
 * independent of any bug in the host's own backend wrapper, per this
 * ticket's plan.
 *
 * `_robotlink._udp` is browsed and reported, per the ticket's own
 * instruction, but is not itself dialed by any Layer 1 probe (WiFi
 * robots are reached over the `_tcp` advertisement's address — see
 * `wifiProbe.ts`).
 */
import Bonjour from "bonjour-service";

export type DiscoveredServiceType = "mbserial-tcp" | "mbrelay-tcp" | "robotlink-tcp" | "robotlink-udp";

export interface DiscoveredService {
  type: DiscoveredServiceType;
  /** mDNS instance name — for `mbserial-tcp` this *is* the robot's
   * five-letter name directly; for `robotlink-*` prefer
   * {@link wifiNameFromTxt} instead. */
  name: string;
  host: string;
  port: number;
  txt?: Record<string, string>;
}

/** Parse a TXT `registry=<port>` field into a port number. `undefined`
 * for an absent/malformed field — never throws. Pure, directly
 * testable; mirrors `mdnsWatcher.ts`'s own (duplicated, not imported —
 * host-internals boundary) `parseRegistryPort`. */
export function parseRegistryPort(raw: string | undefined): number | undefined {
  if (raw === undefined || !/^\d+$/.test(raw.trim())) {
    return undefined;
  }
  const parsed = Number.parseInt(raw, 10);
  return parsed > 0 && parsed <= 65535 ? parsed : undefined;
}

/** A `_robotlink.*` service's TXT `name` field is the robot's actual
 * five-letter name — the mDNS instance string itself is a human label
 * ("gopiv robot link"), per `discovery/mdnsDiscovery.ts`'s own
 * live-verified doc comment. Falls back to the raw instance name only
 * when TXT is absent entirely. */
export function wifiNameFromTxt(service: Pick<DiscoveredService, "name" | "txt">): string {
  return service.txt?.name ?? service.name;
}

const SPECS: ReadonlyArray<{ type: "mbserial" | "mbrelay" | "robotlink"; protocol: "tcp" | "udp"; label: DiscoveredServiceType }> = [
  { type: "mbserial", protocol: "tcp", label: "mbserial-tcp" },
  { type: "mbrelay", protocol: "tcp", label: "mbrelay-tcp" },
  { type: "robotlink", protocol: "tcp", label: "robotlink-tcp" },
  { type: "robotlink", protocol: "udp", label: "robotlink-udp" },
];

/** Default browse window — generous relative to the mDNS re-query
 * interval, per the ticket's own "~4s" instruction. Sufficient for
 * `_mbserial._tcp`/`_mbrelay._tcp` (Avahi-based farm/pool responders,
 * which answer a fresh PTR query near-instantly — verified live). */
export const DEFAULT_BROWSE_WINDOW_MS = 4_000;

/**
 * Extra budget given to `_robotlink._tcp`/`_udp` specifically, on top of
 * {@link DEFAULT_BROWSE_WINDOW_MS}, before giving up.
 *
 * Root-caused live, 2026-09-13 (018-002 Layer 1 gap #1): a fresh
 * `bonjour-service` browse of `_robotlink._tcp` produced **zero** `up`
 * events within the original 4s window even though `dns-sd -B
 * _robotlink._tcp local.` shows `gopiv`/`vevov` advertising it
 * continuously. Direct instrumentation of the underlying
 * `multicast-dns` socket (bypassing `bonjour-service` entirely) showed
 * why: unlike the farm's Avahi-based `_mbserial`/`_mbrelay` responders
 * (which answer a fresh PTR query within milliseconds), these robots'
 * own mDNS stack does not appear to answer on-demand queries at
 * all — repeated `browser.update()` calls every 5s produced nothing;
 * the only records ever received were the robots' own **unsolicited
 * periodic announcements**, observed live at +23s (`gopiv`) and +50s
 * (`vevov`) into an otherwise-idle 75s capture, each carrying the full
 * PTR+SRV+TXT+A record set in one packet (so once such a packet does
 * arrive, `bonjour-service`'s Browser resolves and emits `up`
 * correctly — the TXT `name=` → robot-name mapping was never the
 * problem; parsing it is exactly what {@link wifiNameFromTxt} already
 * does). `dns-sd`/`dns.lookup` return instantly only because macOS's
 * always-running system `mDNSResponder` already holds these records in
 * its own long-lived cache from announcements it heard before this
 * process even started — a fresh, short-lived browse has no such cache
 * and must simply wait for the next one. This budget is set generously
 * above the ~60s steady-state announce interval `discovery/
 * mdnsDiscovery.ts`'s own doc comment documents, so a fresh Layer 1 run
 * reliably observes at least one announcement per robot. */
export const DEFAULT_ROBOTLINK_BROWSE_WINDOW_MS = 65_000;

/**
 * Browse all four service types for `windowMs` (default
 * {@link DEFAULT_BROWSE_WINDOW_MS}), returning every service seen. Opens
 * and destroys its own `Bonjour` instance (a real multicast socket) —
 * never called from a unit test; this is Layer 1's own live-discovery
 * step, evidenced by the bench run itself, not by fakes.
 *
 * `_robotlink._tcp`/`_udp` gets extra time on top of `windowMs`, up to
 * `robotlinkWindowMs` (default {@link DEFAULT_ROBOTLINK_BROWSE_WINDOW_MS})
 * total, but only if nothing on either robotlink type has appeared yet
 * by the time `windowMs` elapses — see that constant's doc comment for
 * why this extra wait is real and necessary, not a workaround. Every
 * other service type is unaffected: they simply keep listening (for
 * free, on the same sockets) during whatever extra time robotlink ends
 * up needing.
 */
export async function browseServices(
  windowMs: number = DEFAULT_BROWSE_WINDOW_MS,
  robotlinkWindowMs: number = DEFAULT_ROBOTLINK_BROWSE_WINDOW_MS,
): Promise<DiscoveredService[]> {
  const bonjour = new Bonjour();
  const found: DiscoveredService[] = [];
  let sawRobotlink = false;
  const browsers = SPECS.map((spec) => {
    const browser = bonjour.find({ type: spec.type, protocol: spec.protocol });
    browser.on("up", (service) => {
      found.push({
        type: spec.label,
        name: service.name,
        host: service.host,
        port: service.port,
        ...(service.txt !== undefined ? { txt: service.txt as Record<string, string> } : {}),
      });
      if (spec.type === "robotlink") {
        sawRobotlink = true;
      }
    });
    return browser;
  });

  await new Promise<void>((resolve) => setTimeout(resolve, windowMs));

  const extraBudgetMs = Math.max(0, robotlinkWindowMs - windowMs);
  const pollIntervalMs = 1_000;
  let waitedExtraMs = 0;
  while (!sawRobotlink && waitedExtraMs < extraBudgetMs) {
    const step = Math.min(pollIntervalMs, extraBudgetMs - waitedExtraMs);
    await new Promise<void>((resolve) => setTimeout(resolve, step));
    waitedExtraMs += step;
  }

  for (const browser of browsers) {
    browser.stop();
  }
  bonjour.destroy();

  return found;
}
