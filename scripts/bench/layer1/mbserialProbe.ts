/**
 * mbserialProbe.ts — Layer 1 raw probe for a farm `mbserial` TCP bridge
 * (e.g. `gopiv` via `loki`, `tigez` via `magni`, `vevov` via `hodr`).
 *
 * Per the ticket's own bench facts: these bridges are single-client — a
 * second concurrent client gets `ERR busy` (sometimes only after the
 * bridge resets the connection) rather than a banner, and this harness's
 * whole reason for existing here is to make that distinguishable from a
 * plain timeout or a refused connection, since bench defect 5
 * (sprint.md) is the host *conflating* "busy" with "no banner" today.
 * {@link classifyMbserialHelloReply} is the one place that distinction is
 * made, kept as a pure function (fed a single reply line or `undefined`
 * for a timeout) so it is fully unit-testable against captured bytes —
 * see this module's own test file.
 */
import { parseBanner, parseIdReply, type ParsedBanner } from "@robot-console/protocol";
import { TcpLineSession } from "./tcpLineSession.js";
import type { PathResult, TcpProbeEndpoint } from "./types.js";

/** Bound on waiting for a banner after `HELLO`. Generous relative to the
 * live-bench observed reply latency (low hundreds of ms). */
export const DEFAULT_HELLO_TIMEOUT_MS = 3_000;
/** Bound on waiting for an `id ...` reply after `ID`. */
export const DEFAULT_ID_TIMEOUT_MS = 3_000;

/** What one `HELLO` round trip against an mbserial bridge produced,
 * classified into the shapes this ticket's acceptance criteria requires
 * distinguishing. */
export type MbserialHelloOutcome =
  | { kind: "banner"; banner: ParsedBanner }
  | { kind: "busy" }
  | { kind: "timeout" }
  | { kind: "unparsed"; line: string };

const BUSY_PATTERN = /^ERR\s+busy\s*$/i;

/**
 * Classify a single reply line (or `undefined` for "nothing arrived
 * within the bound") into one of {@link MbserialHelloOutcome}'s shapes.
 * Pure — no I/O, no timers — so it is directly testable against captured
 * wire text.
 */
export function classifyMbserialHelloReply(line: string | undefined): MbserialHelloOutcome {
  if (line === undefined) {
    return { kind: "timeout" };
  }
  if (BUSY_PATTERN.test(line.trim())) {
    return { kind: "busy" };
  }
  const banner = parseBanner(line);
  if (banner) {
    return { kind: "banner", banner };
  }
  return { kind: "unparsed", line };
}

/** Which bucket a failed TCP connect attempt falls into — the ticket
 * asks for `refused` to be reported "distinctly" from a timeout. Pure
 * string classification over the error message `net.connect`/Node
 * itself already produces (`ECONNREFUSED`, or this module's own
 * `TcpLineSession` connect-timeout message). */
export function classifyConnectError(message: string): "refused" | "timeout" | "other" {
  if (/ECONNREFUSED/i.test(message)) {
    return "refused";
  }
  if (/timed out/i.test(message)) {
    return "timeout";
  }
  return "other";
}

export interface MbserialProbeOptions {
  helloTimeoutMs?: number;
  idTimeoutMs?: number;
  connectTimeoutMs?: number;
}

/**
 * Full HELLO/ID round trip against one mbserial bridge over a single
 * TCP connection. `endpoint.ip` must already be resolved (see
 * `dnsResolve.ts`) — this module dials `endpoint.ip`, never
 * `endpoint.host`, per the ticket's own "connect by IP" requirement.
 */
export async function probeMbserial(
  expectedName: string,
  endpoint: TcpProbeEndpoint,
  options: MbserialProbeOptions = {},
): Promise<PathResult> {
  const helloTimeoutMs = options.helloTimeoutMs ?? DEFAULT_HELLO_TIMEOUT_MS;
  const idTimeoutMs = options.idTimeoutMs ?? DEFAULT_ID_TIMEOUT_MS;
  const dialHost = endpoint.ip ?? endpoint.host;

  const connectResult = await TcpLineSession.connect(dialHost, endpoint.port, {
    connectTimeoutMs: options.connectTimeoutMs ?? 5000,
  });
  if (!connectResult.ok) {
    const bucket = classifyConnectError(connectResult.error);
    return {
      path: "mbserial",
      endpoint,
      status: "fail",
      reason: `${bucket}: ${connectResult.error}`,
      transcript: [],
    };
  }

  const session = connectResult.session;
  try {
    const helloWait = session.waitForLine(() => true, helloTimeoutMs);
    session.send("HELLO");
    const helloReply = await helloWait;
    const helloOutcome = classifyMbserialHelloReply(helloReply);

    if (helloOutcome.kind === "busy") {
      return {
        path: "mbserial",
        endpoint,
        status: "fail",
        reason: "ERR busy -- another client already holds this bridge",
        transcript: session.transcript,
      };
    }
    if (helloOutcome.kind === "timeout") {
      return {
        path: "mbserial",
        endpoint,
        status: "fail",
        reason: `timeout waiting ${helloTimeoutMs}ms for a HELLO reply (no banner, not ERR busy either)`,
        transcript: session.transcript,
      };
    }
    if (helloOutcome.kind === "unparsed") {
      return {
        path: "mbserial",
        endpoint,
        status: "fail",
        reason: `unrecognized reply to HELLO: ${JSON.stringify(helloOutcome.line)}`,
        transcript: session.transcript,
      };
    }

    const idWait = session.waitForLine((line) => line.toLowerCase().startsWith("id "), idTimeoutMs);
    session.send("ID");
    const idLine = await idWait;
    if (idLine === undefined) {
      return {
        path: "mbserial",
        endpoint,
        status: "fail",
        reason: `banner received (${helloOutcome.banner.raw}) but no ID reply within ${idTimeoutMs}ms`,
        transcript: session.transcript,
      };
    }
    const idReply = parseIdReply(idLine.trim().split(/\s+/).slice(1));
    const nameMatches = helloOutcome.banner.name === expectedName;
    return {
      path: "mbserial",
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

/**
 * Demonstrate the single-client contention behavior the ticket's own
 * acceptance criteria requires distinguishing from a plain timeout:
 * opens a first connection and waits for its banner (establishing the
 * single client), then opens a second concurrent connection and
 * classifies whatever it receives (or doesn't) within `helloTimeoutMs`.
 * Both connections are closed before returning. This is a diagnostic
 * demonstration, not a pass/fail probe of the device itself — `status`
 * reflects whether contention was actually observed as `"busy"` (`pass`)
 * or something else (`fail`, with the actual outcome as `reason`).
 */
export async function probeMbserialContention(
  endpoint: TcpProbeEndpoint,
  options: MbserialProbeOptions = {},
): Promise<PathResult> {
  const helloTimeoutMs = options.helloTimeoutMs ?? DEFAULT_HELLO_TIMEOUT_MS;
  const dialHost = endpoint.ip ?? endpoint.host;
  const path = "mbserial-contention";

  const first = await TcpLineSession.connect(dialHost, endpoint.port);
  if (!first.ok) {
    return { path, endpoint, status: "fail", reason: `first client failed to connect: ${first.error}`, transcript: [] };
  }
  const firstSession = first.session;
  firstSession.note("first client connecting");
  const firstBannerWait = firstSession.waitForLine(() => true, helloTimeoutMs);
  firstSession.send("HELLO");
  await firstBannerWait;

  const second = await TcpLineSession.connect(dialHost, endpoint.port);
  if (!second.ok) {
    firstSession.close();
    return {
      path,
      endpoint,
      status: "fail",
      reason: `second client failed to connect: ${second.error}`,
      transcript: firstSession.transcript,
    };
  }
  const secondSession = second.session;
  secondSession.note("second client connecting while first is still open");
  const secondReplyWait = secondSession.waitForLine(() => true, helloTimeoutMs);
  secondSession.send("HELLO");
  const secondReply = await secondReplyWait;
  const outcome = classifyMbserialHelloReply(secondReply);

  firstSession.close();
  secondSession.close();

  const combinedTranscript = [...firstSession.transcript, ...secondSession.transcript].sort((a, b) => a.t - b.t);

  return {
    path,
    endpoint,
    status: outcome.kind === "busy" ? "pass" : "fail",
    reason:
      outcome.kind === "busy"
        ? "second client correctly received ERR busy while first client's session was open"
        : `second client did not receive ERR busy (got: ${outcome.kind === "unparsed" ? outcome.line : outcome.kind})`,
    transcript: combinedTranscript,
  };
}
