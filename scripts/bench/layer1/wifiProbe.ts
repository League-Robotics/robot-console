/**
 * wifiProbe.ts — Layer 1 raw probe for a WiFi-reachable robot
 * (`_robotlink._tcp`/`_udp`, port 7654, e.g. `gopiv`, `vevov`).
 *
 * Per the ticket's own bench facts: the banner line arrives **twice**
 * after `HELLO` (this module only ever waits for the first), and
 * `DBG:wifi ...` lines interleave with real protocol traffic — both are
 * firmware quirks this probe must tolerate rather than treat as
 * failures, since that tolerance is exactly what the host itself is
 * also required to do (sprint.md's WiFi/mbserial transport fix, ticket
 * 007). {@link isDebugLine}/{@link classifyWifiHelloReply} are kept pure
 * so this tolerance is directly unit-testable against captured wire
 * text, independent of any real socket.
 */
import { parseBanner, parseIdReply, type ParsedBanner } from "@robot-console/protocol";
import { TcpLineSession } from "./tcpLineSession.js";
import type { PathResult, TcpProbeEndpoint } from "./types.js";

export const DEFAULT_HELLO_TIMEOUT_MS = 4_000;
export const DEFAULT_ID_TIMEOUT_MS = 4_000;

/** `DBG:wifi ...` (and any other `DBG:`-prefixed) chatter interleaves
 * with real protocol lines on this transport — never a banner or an ID
 * reply, always ignorable. */
export function isDebugLine(line: string): boolean {
  return /^DBG:/i.test(line);
}

export type WifiHelloOutcome =
  | { kind: "banner"; banner: ParsedBanner }
  | { kind: "timeout" }
  | { kind: "unparsed"; line: string };

/** Classify the first non-`DBG:` line received after `HELLO`. A second
 * banner line (the documented duplicate) is never consulted by this
 * function at all — the caller only ever waits for the first
 * non-debug line, so the duplicate is simply never read, not
 * "tolerated" by any special-case here. */
export function classifyWifiHelloReply(line: string | undefined): WifiHelloOutcome {
  if (line === undefined) {
    return { kind: "timeout" };
  }
  const banner = parseBanner(line);
  if (banner) {
    return { kind: "banner", banner };
  }
  return { kind: "unparsed", line };
}

export interface WifiProbeOptions {
  helloTimeoutMs?: number;
  idTimeoutMs?: number;
  connectTimeoutMs?: number;
}

/**
 * Full HELLO/ID round trip against one WiFi robot over a single TCP
 * connection. `endpoint.ip` must already be resolved — dials the IP,
 * never the `.local` hostname, per the ticket's own bench facts (a bare
 * hostname connect on this transport is the exact ~5s-hang defect this
 * sprint's later tickets fix in the host).
 */
export async function probeWifi(
  expectedName: string,
  endpoint: TcpProbeEndpoint,
  options: WifiProbeOptions = {},
): Promise<PathResult> {
  const helloTimeoutMs = options.helloTimeoutMs ?? DEFAULT_HELLO_TIMEOUT_MS;
  const idTimeoutMs = options.idTimeoutMs ?? DEFAULT_ID_TIMEOUT_MS;
  const dialHost = endpoint.ip ?? endpoint.host;

  const connectResult = await TcpLineSession.connect(dialHost, endpoint.port, {
    connectTimeoutMs: options.connectTimeoutMs ?? 5000,
  });
  if (!connectResult.ok) {
    return {
      path: "wifi",
      endpoint,
      status: "fail",
      reason: `connect failed: ${connectResult.error}`,
      transcript: [],
    };
  }

  const session = connectResult.session;
  try {
    const helloWait = session.waitForLine((line) => !isDebugLine(line), helloTimeoutMs);
    session.send("HELLO");
    const helloReply = await helloWait;
    const helloOutcome = classifyWifiHelloReply(helloReply);

    if (helloOutcome.kind === "timeout") {
      return {
        path: "wifi",
        endpoint,
        status: "fail",
        reason: `timeout waiting ${helloTimeoutMs}ms for a non-DBG HELLO reply`,
        transcript: session.transcript,
      };
    }
    if (helloOutcome.kind === "unparsed") {
      return {
        path: "wifi",
        endpoint,
        status: "fail",
        reason: `unrecognized reply to HELLO: ${JSON.stringify(helloOutcome.line)}`,
        transcript: session.transcript,
      };
    }

    const idWait = session.waitForLine(
      (line) => !isDebugLine(line) && line.toLowerCase().startsWith("id "),
      idTimeoutMs,
    );
    session.send("ID");
    const idLine = await idWait;
    if (idLine === undefined) {
      return {
        path: "wifi",
        endpoint,
        status: "fail",
        reason: `banner received (${helloOutcome.banner.raw}) but no ID reply within ${idTimeoutMs}ms`,
        transcript: session.transcript,
      };
    }
    const idReply = parseIdReply(idLine.trim().split(/\s+/).slice(1));
    const nameMatches = helloOutcome.banner.name === expectedName;
    return {
      path: "wifi",
      endpoint,
      status: nameMatches ? "pass" : "fail",
      reason: nameMatches
        ? `banner + ID matched (${helloOutcome.banner.raw} / ${idReply ? idLine : "unparsed id reply"})`
        : `banner named "${helloOutcome.banner.name}", expected "${expectedName}"`,
      transcript: session.transcript,
    };
  } finally {
    session.close();
  }
}
