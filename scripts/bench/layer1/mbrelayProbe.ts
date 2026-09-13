/**
 * mbrelayProbe.ts — Layer 1 raw probe for the `mbrelay` radio pool (e.g.
 * `torture:8760`), covering both of the ticket's own required
 * demonstrations:
 *
 *   1. **Command-plane sweep** ({@link runCommandPlaneSweep}): for every
 *      known robot name, tune the pool (`!CG <ch> <grp>`) and send a
 *      pass-through `> HELLO`, recording whether `< device ...` comes
 *      back — this is "ground truth reachability" for every name the
 *      bench knows about (`tovez`/`tigez` are expected to fail here per
 *      this sprint's own Scope section; `vevov`/`gopiv` are expected to
 *      pass). Restores the pool to `!CG 0 10` when done, per the
 *      ticket's own instruction.
 *   2. **Full data-plane handshake** ({@link probeMbrelayDataPlane}): the
 *      complete `!ECHO OFF -> !MODE RAW250 -> !CG -> !P 7 -> !GO ->
 *      HELLO/ID` sequence against one name already confirmed reachable
 *      by the sweep above — the byte-for-byte match to the team-lead's
 *      manually verified sequence the ticket's acceptance criteria
 *      requires.
 *
 * Every line-builder/reply-classifier used here (`buildEchoOffLine`,
 * `relayPreambleSteps`, `classifyRelayReply`, `parseRelayStatusLine`,
 * `buildRadioSendLine`, `parseBanner`) comes from
 * `@robot-console/protocol` — pure wire grammar, not host transport code
 * (see `lineReassembler.ts`'s own doc comment for why that boundary
 * matters here). This module supplies only the orchestration (send,
 * wait, classify, retry) over a real `TcpLineSession`.
 */
import {
  buildQueryLine,
  buildRadioSendLine,
  buildSetChannelGroupLine,
  classifyRelayReply,
  parseBanner,
  parseIdReply,
  parseRelayStatusLine,
  relayPreambleSteps,
  type RelayPreambleStep,
} from "@robot-console/protocol";
import { TcpLineSession } from "./tcpLineSession.js";
import type { PathResult, ProbeStatus, TcpProbeEndpoint, TranscriptLine } from "./types.js";

/** The pool's own "return to defaults" tuning, sent once after every
 * command-plane sweep (ticket instruction: "Restore the pool relay to
 * `!CG 0 10` after command-plane probing"). `(0, 10)` is deliberately
 * built as a raw wire line below, never via
 * `@robot-console/protocol`'s `buildSetChannelGroupLine` -- that
 * builder's `validateRadioAddress` range check (channel odd in
 * [25, 73], group in [1, 126] excluding the reserved value 10) exists to
 * keep a *derived* radio address well-formed, but `(0, 10)` is not a
 * derived address at all -- it's the pool's own idle/default tuning,
 * outside that range on purpose. Confirmed live (2026-09-13 bench):
 * `buildSetChannelGroupLine(0, 10)` throws `RelayCommandError`, exactly
 * because Layer 1 must be able to send a raw wire command the
 * higher-level, business-validated builder correctly refuses. */
const DEFAULT_CHANNEL = 0;
const DEFAULT_GROUP = 10;

function buildRawSetChannelGroupLine(channel: number, group: number): string {
  return `!CG ${channel} ${group}\n`;
}

export const DEFAULT_STEP_TIMEOUT_MS = 3_000;
export const DEFAULT_SWEEP_NAME_TIMEOUT_MS = 2_500;

/** `< <text>` relay pass-through delivery, per `relay/commands.ts`'s own
 * (private) grammar — duplicated here as a small, pure parser rather
 * than reached into (this module already imports that package's own
 * `parseRadioIdReply` equivalent is `id`-specific; this probe's sweep
 * expects a `< device ...` banner-shaped reply instead, which the
 * protocol package has no dedicated parser for). Returns the inner text
 * with the `< ` prefix stripped, or `null` for anything not in that
 * shape. */
export function parseRadioPassthroughReply(line: string): string | null {
  const match = /^<\s?(.*)$/.exec(line.trim());
  return match ? match[1]! : null;
}

/**
 * Classify one command-plane sweep reply (or `undefined` for a timeout)
 * for `expectedName`. Pure — directly testable against captured wire
 * text.
 */
export function classifyRadioSweepReply(
  expectedName: string,
  replyLine: string | undefined,
): { status: ProbeStatus; reason: string } {
  if (replyLine === undefined) {
    return { status: "fail", reason: "timeout: no radio reply (name likely unreachable via this pool)" };
  }
  const inner = parseRadioPassthroughReply(replyLine);
  if (inner === null) {
    return { status: "fail", reason: `reply not in '< ...' pass-through shape: ${JSON.stringify(replyLine)}` };
  }
  const banner = parseBanner(inner);
  if (banner === null) {
    return { status: "fail", reason: `pass-through reply did not parse as a banner: ${JSON.stringify(inner)}` };
  }
  if (banner.name !== expectedName) {
    return { status: "fail", reason: `pass-through banner named "${banner.name}", expected "${expectedName}"` };
  }
  return { status: "pass", reason: `radio pass-through HELLO answered: ${replyLine}` };
}

/** Outcome of sending one command-plane line and waiting for either its
 * own confirmation predicate or an explicit `"error"`-classified
 * rejection — whichever comes first. Distinguishing the two matters here
 * specifically because `relayPreambleSteps`'s own doc comment calls out
 * "a `!CG` rejection must leave the relay in the command plane": this
 * harness must never mistake a rejection for a mere slow confirmation
 * and plow ahead into `!GO` regardless. */
function waitForStepOutcome(
  session: TcpLineSession,
  confirms: (line: string) => boolean,
  label: string,
  timeoutMs: number,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        unsubscribe();
        resolve({ ok: false, reason: `timeout (${timeoutMs}ms) waiting for confirmation of ${label}` });
      }
    }, timeoutMs);
    const unsubscribe = session.onLine((line) => {
      if (settled) {
        return;
      }
      if (confirms(line)) {
        settled = true;
        clearTimeout(timer);
        unsubscribe();
        resolve({ ok: true });
      } else if (classifyRelayReply(line) === "error") {
        settled = true;
        clearTimeout(timer);
        unsubscribe();
        resolve({ ok: false, reason: `relay rejected ${label}: ${line}` });
      }
      // Anything else (the pool's own DEVICE:... relay-identity banner,
      // unrelated chatter) is ignored -- neither confirms nor rejects.
    });
  });
}

async function sendStepAndWait(
  session: TcpLineSession,
  step: RelayPreambleStep,
  timeoutMs: number,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const waiter = waitForStepOutcome(session, step.confirms, step.label, timeoutMs);
  session.sendRaw(step.line);
  return waiter;
}

export interface KnownRadioName {
  name: string;
  channel: number;
  group: number;
}

/**
 * Run the command-plane sweep for every entry in `names` over one
 * already-open `session`: tune to `(channel, group)`, send `> HELLO`,
 * classify the reply. Restores `!CG 0 10` at the end regardless of how
 * individual probes went (best-effort — a failure to confirm the
 * restore step is recorded on the returned map under the reserved key
 * `"__restore__"`, never thrown).
 */
export async function runCommandPlaneSweep(
  session: TcpLineSession,
  names: readonly KnownRadioName[],
  perNameTimeoutMs: number = DEFAULT_SWEEP_NAME_TIMEOUT_MS,
): Promise<Map<string, { status: ProbeStatus; reason: string; transcript: TranscriptLine[] }>> {
  const results = new Map<string, { status: ProbeStatus; reason: string; transcript: TranscriptLine[] }>();

  for (const { name, channel, group } of names) {
    const sliceStart = session.transcript.length;
    const tuneStep: RelayPreambleStep = {
      line: buildSetChannelGroupLine(channel, group),
      label: `!CG ${channel} ${group}`,
      confirms: (line) => {
        const status = parseRelayStatusLine(line);
        return status !== null && status.channel === channel && status.group === group;
      },
    };
    const tuneOutcome = await sendStepAndWait(session, tuneStep, perNameTimeoutMs);
    if (!tuneOutcome.ok) {
      results.set(name, {
        status: "fail",
        reason: `could not tune to ${channel}/${group}: ${tuneOutcome.reason}`,
        transcript: session.transcript.slice(sliceStart),
      });
      continue;
    }

    const replyWait = session.waitForLine((line) => parseRadioPassthroughReply(line) !== null, perNameTimeoutMs);
    session.sendRaw(buildRadioSendLine("HELLO"));
    const reply = await replyWait;
    results.set(name, { ...classifyRadioSweepReply(name, reply), transcript: session.transcript.slice(sliceStart) });
  }

  const restoreSliceStart = session.transcript.length;
  const restoreStep: RelayPreambleStep = {
    line: buildRawSetChannelGroupLine(DEFAULT_CHANNEL, DEFAULT_GROUP),
    label: `!CG ${DEFAULT_CHANNEL} ${DEFAULT_GROUP} (restore)`,
    confirms: (line) => {
      const status = parseRelayStatusLine(line);
      return status !== null && status.channel === DEFAULT_CHANNEL && status.group === DEFAULT_GROUP;
    },
  };
  const restoreOutcome = await sendStepAndWait(session, restoreStep, perNameTimeoutMs);
  if (!restoreOutcome.ok) {
    results.set("__restore__", {
      status: "fail",
      reason: restoreOutcome.reason,
      transcript: session.transcript.slice(restoreSliceStart),
    });
  }

  return results;
}

/**
 * A minimal, non-mutating "is the pool itself alive" probe: connect,
 * send `?`, wait for a status reply. Used once per discovered pool to
 * give the pool its own `"pool"`-kind device row in the report,
 * independent of any particular robot name's reachability through it.
 * Never sends `!CG`/`!GO` — no tuning, no data-plane entry, nothing that
 * would affect a concurrent probe against this same pool.
 */
export async function probeMbrelayStatus(
  poolName: string,
  endpoint: TcpProbeEndpoint,
  options: { connectTimeoutMs?: number; timeoutMs?: number } = {},
): Promise<PathResult> {
  const path = `radio-via-mbrelay:${poolName}`;
  const dialHost = endpoint.ip ?? endpoint.host;
  const connectResult = await TcpLineSession.connect(dialHost, endpoint.port, {
    connectTimeoutMs: options.connectTimeoutMs ?? 5000,
  });
  if (!connectResult.ok) {
    return { path, endpoint, status: "fail", reason: `connect failed: ${connectResult.error}`, transcript: [] };
  }
  const session = connectResult.session;
  try {
    const wait = session.waitForLine((line) => parseRelayStatusLine(line) !== null, options.timeoutMs ?? 3_000);
    session.sendRaw(buildQueryLine());
    const reply = await wait;
    return {
      path,
      endpoint,
      status: reply !== undefined ? "pass" : "fail",
      reason: reply !== undefined ? `pool answered '?' with: ${reply}` : "no status reply to '?' within timeout",
      transcript: session.transcript,
    };
  } finally {
    session.close();
  }
}

export interface MbrelayDataPlaneOptions {
  connectTimeoutMs?: number;
  /** Bound on each command-plane preamble step's confirmation. Default
   * {@link DEFAULT_STEP_TIMEOUT_MS}. */
  stepTimeoutMs?: number;
  /** Delay between each post-`!GO` send. Default
   * {@link DEFAULT_STEP_SPACING_MS}. */
  stepSpacingMs?: number;
  /** Max alternating HELLO/ID sends before giving up on whichever of
   * the two never got a reply. Default 6 (3 of each). */
  maxSends?: number;
}

/** Delay between each post-`!GO` send in {@link probeMbrelayDataPlane},
 * matching the team-lead's own manually verified live-bench timing
 * (`HELLO` at +3000ms, `ID` at +6000ms, a second `HELLO` at +9000ms,
 * each reply arriving 30-40ms after its *own* send — but, critically,
 * the reply to the *first* `HELLO` was sometimes only ever delivered
 * after `ID` was sent, not within any bounded wait on `HELLO` alone).
 * See this function's own doc comment for why sends are spaced on a
 * fixed schedule rather than each gated on the previous reply. */
export const DEFAULT_STEP_SPACING_MS = 3_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The full `!ECHO OFF -> !MODE RAW250 -> !CG -> !P 7 -> !GO ->
 * HELLO/ID` handshake against one pool endpoint, tuned to
 * `(channel, group)`, over a fresh connection.
 *
 * ## Why sends are spaced, not reply-gated (live-bench evidence)
 *
 * An earlier version of this function sent `HELLO`, waited (bounded) for
 * its own banner reply, *then* sent `ID` and waited for its own id
 * reply. Live-bench evidence (2026-09-13, this ticket) showed that
 * ordering fails intermittently: the pool sometimes answers a `HELLO`
 * only *after* the next command is sent, not within any bound placed on
 * `HELLO` alone -- so a strictly sequential wait-then-send occasionally
 * times out on `ID` even though a banner (or the id reply itself)
 * arrives moments later, just not attributed to the request that
 * "should" have gotten it. This function instead mirrors the
 * team-lead's own manually verified sequence exactly: send `HELLO`,
 * wait {@link DEFAULT_STEP_SPACING_MS}, send `ID`, wait again, send a
 * second `HELLO`, wait again -- then classify *everything* received
 * across the whole window, regardless of which send a given reply
 * happened to follow. A real timeout (nothing of either shape ever
 * arrives) still fails; this only widens *which* send a genuine reply
 * is allowed to trail.
 */
export async function probeMbrelayDataPlane(
  poolName: string,
  expectedName: string,
  endpoint: TcpProbeEndpoint,
  channel: number,
  group: number,
  options: MbrelayDataPlaneOptions = {},
): Promise<PathResult> {
  const path = `radio-via-mbrelay:${poolName}`;
  const stepTimeoutMs = options.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
  const dialHost = endpoint.ip ?? endpoint.host;

  const connectResult = await TcpLineSession.connect(dialHost, endpoint.port, {
    connectTimeoutMs: options.connectTimeoutMs ?? 5000,
  });
  if (!connectResult.ok) {
    return { path, endpoint, status: "fail", reason: `connect failed: ${connectResult.error}`, transcript: [] };
  }

  const session = connectResult.session;
  try {
    for (const step of relayPreambleSteps(channel, group)) {
      const outcome = await sendStepAndWait(session, step, stepTimeoutMs);
      if (!outcome.ok) {
        return { path, endpoint, status: "fail", reason: outcome.reason, transcript: session.transcript };
      }
    }
    session.note("entered data plane -- HELLO/ID answered unprefixed from here");

    const isBanner = (line: string): boolean => parseBanner(line) !== null;
    const isIdReply = (line: string): boolean => line.toLowerCase().startsWith("id ");

    // Live-bench evidence (2026-09-13, this ticket): over an actual
    // radio link through the pool, any single HELLO or ID send can go
    // unanswered (packet loss on the radio hop, not a protocol error --
    // both verbs were separately observed to get no reply at all across
    // different runs against the same, otherwise-reachable name). This
    // alternates HELLO/ID up to `maxSends` times, stopping as soon as
    // both a banner and an id reply have been seen, so a lossy radio
    // hop gets more than one chance at each verb without extending the
    // wait past what's needed once both have already arrived.
    const stepSpacingMs = options.stepSpacingMs ?? DEFAULT_STEP_SPACING_MS;
    const maxSends = options.maxSends ?? 6;
    const collected: string[] = [];
    const unsubscribe = session.onLine((line) => collected.push(line));
    try {
      for (let i = 0; i < maxSends; i++) {
        if (collected.some(isBanner) && collected.some(isIdReply)) {
          break;
        }
        session.send(i % 2 === 0 ? "HELLO" : "ID");
        await delay(stepSpacingMs);
      }
    } finally {
      unsubscribe();
    }

    const bannerLine = collected.find(isBanner);
    const idLine = collected.find(isIdReply);

    if (bannerLine === undefined || idLine === undefined) {
      return {
        path,
        endpoint,
        status: "fail",
        reason: `data plane reached but handshake incomplete (banner: ${bannerLine ?? "none"}, id: ${idLine ?? "none"})`,
        transcript: session.transcript,
      };
    }

    const banner = parseBanner(bannerLine)!;
    const idReply = parseIdReply(idLine.trim().split(/\s+/).slice(1));
    const nameMatches = banner.name === expectedName;
    return {
      path,
      endpoint,
      status: nameMatches ? "pass" : "fail",
      reason: nameMatches
        ? `full data-plane handshake succeeded (${banner.raw} / ${idReply ? idLine : "unparsed id reply"})`
        : `banner named "${banner.name}", expected "${expectedName}"`,
      transcript: session.transcript,
    };
  } finally {
    session.close();
  }
}
