/**
 * types.ts — shared JSON shapes for the Layer 1 raw-device bench harness
 * (sprint 018 ticket 001; `sprint.md`'s "Report generator" node in the
 * harness architecture diagram).
 *
 * These types describe exactly the on-disk report shape the ticket
 * specifies — a device x path reachability matrix with a verbatim wire
 * transcript per path — and nothing else. Layers 2/3 (tickets 002-003)
 * read this same shape to decide what to attempt next; this module is
 * the one place its fields are named, so those tickets and this one
 * agree on the contract without re-deriving it.
 */

/** One line of a captured wire transcript. `"tx"`/`"rx"` are bytes
 * actually sent/received (verbatim, no trailing newline); `"info"` is an
 * orchestration note this harness added itself (e.g. "second client
 * connecting to test contention") — never confused with a wire line,
 * always distinguishable by `dir`. */
export interface TranscriptLine {
  /** Milliseconds since this path's probe started. */
  t: number;
  dir: "tx" | "rx" | "info";
  line: string;
}

/** Outcome of one device x path probe. `"skipped"` is reserved for the
 * exclusivity check's `--skip-held` mode — a resource this run refused
 * to touch because another process already holds it, per `reason`. */
export type ProbeStatus = "pass" | "fail" | "skipped";

/** A TCP endpoint this probe dialed. `ip`/`resolveMs` are populated only
 * when the endpoint was reached via a `.local` hostname resolved to an
 * IPv4 address first — see `dnsResolve.ts`'s module doc comment for why
 * this harness never dials a bare `.local` hostname directly. */
export interface TcpProbeEndpoint {
  host: string;
  ip?: string;
  port: number;
  resolveMs?: number;
}

/** A local serial port this probe opened directly (no host process). */
export interface SerialProbeEndpoint {
  serialPath: string;
}

export type ProbeEndpoint = TcpProbeEndpoint | SerialProbeEndpoint;

/** One device x path result. `path` is a free-form label rather than a
 * closed union — `radio-via-mbrelay:<pool>` / `radio-via-usb-relay:<relay>`
 * both carry a pool/relay name that is only known at run time (a bench's
 * mbrelay pool name, discovered over mDNS), so the ticket's own shape
 * uses a templated string, not an enum this module could usefully
 * narrow further. */
export interface PathResult {
  path: string;
  endpoint: ProbeEndpoint;
  status: ProbeStatus;
  reason: string;
  transcript: TranscriptLine[];
}

/** One physical/logical device (a robot, relay, or relay pool) and every
 * path this run attempted to reach it by. */
export interface DeviceEntry {
  name: string;
  kind: "robot" | "relay" | "pool" | "unknown";
  paths: PathResult[];
}

/** One process found holding a resource this harness needed exclusive
 * access to (`exclusivity.ts`). */
export interface Holder {
  /** Human-readable resource description, e.g. a serial path or
   * `host:port`. */
  resource: string;
  pid: number;
  command: string;
}

/** The full Layer 1 report, written as one JSON file. */
export interface Layer1Report {
  startedAt: string;
  finishedAt: string;
  host: { os: string; node: string };
  holders: Holder[];
  devices: DeviceEntry[];
}
