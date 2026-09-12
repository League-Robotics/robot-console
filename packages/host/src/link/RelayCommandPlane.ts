/**
 * RelayCommandPlane.ts — drives the relay command-plane handshake
 * (`!ECHO OFF` -> `!MODE RAW250` -> `!CG <ch> <grp>` -> `!P 7` -> `!GO`)
 * to completion over an injected paced-write function and an injected
 * raw-line-subscribe function. Per `sprint.md`'s Step 2/Step 3: a plain
 * orchestrator over `@robot-console/protocol`'s `relay/commands.ts` pure
 * line-builders (ticket 001) — it has no knowledge of *which* transport
 * supplies the write/subscribe pair (a local serial port for
 * `RelayRadioLink`, a TCP socket for `MbrelayLink`), so both transports
 * compose this one module instead of each re-deriving the preamble and
 * its failure handling independently.
 *
 * ## Raw lines, not decoded v6 lines
 *
 * The write/subscribe pair this module is given operates on raw,
 * already-reassembled wire lines (post-`LineReassembler`), **not**
 * `LineLink`'s `LineListener` (`DecodedLine`, produced by `v6/codec.ts`'s
 * `decodeLine`). The relay's own preamble replies (e.g. the live-captured
 * `# channel: 47 group: 60 mode: RAW250 power: 7`) are `#`-prefixed
 * comment text, not v6 protocol lines at all — decoding them would be
 * meaningless before the data plane is even reached. `LineLink` itself
 * mirrors this split: its own `preamble` hook runs against the raw
 * `ByteStream`/`onRawLine`, before `receive()` is ever invoked.
 *
 * ## What is, and is not, gated on a reply
 *
 * Per this ticket's own Description (mirroring `sprint.md`'s Solution
 * section and the reference `vendor/pxt-nezha-diffdrive/tools/link.py`
 * `relay_setup_lines()` carrier, which never inspects a reply for these
 * three lines either): `!ECHO OFF`, `!MODE RAW250`, and `!P 7` are sent
 * via the paced write function and NOT gated on a reply — there is no
 * captured or documented rejection grammar for any of them, and the
 * relay's own persisted-config behavior means they succeed silently.
 * Only two steps are gated, per `sprint.md`'s SUC-003 and this module's
 * two sprint-wide invariants:
 *
 *   - **`!CG <ch> <grp>`** — the one step with a captured wire example
 *     of what success looks like: a `#`-prefixed comment line (`#
 *     channel: 47 group: 60 mode: RAW250 power: 7`,
 *     `vendor/pxt-nezha-diffdrive/captures/radio-addressing-20260830.md`
 *     §4). This module treats **any** `#`-prefixed reply as
 *     confirmation, and treats anything else — a non-`#` reply, or no
 *     reply at all within {@link RelayCommandPlaneOptions.timeoutMs} —
 *     as a rejection. A rejection stops the sequence immediately: `!P 7`
 *     and `!GO` are never sent, and the relay is left in the command
 *     plane, never a partial data-plane state (`sprint.md`'s Problem
 *     section / this module's first invariant below).
 *   - **`!GO`** — no captured example of its confirmation reply exists
 *     anywhere in this codebase, so this module cannot gate on reply
 *     *content* the way it does for `!CG`. It gates on reply
 *     *presence* instead: any reply line at all within {@link
 *     RelayCommandPlaneOptions.timeoutMs} counts as confirmation: no
 *     reply within the timeout is a timeout failure (this module's
 *     second invariant below).
 *
 * ## The two sprint-wide invariants this module exists to enforce
 *
 * (`sprint.md`'s Problem/Solution sections; `commands.ts`'s own doc
 * comment names both as the reason its preamble steps are separate
 * functions rather than one combined call.)
 *
 *   1. **A `!CG` rejection must leave the relay in the command
 *      plane.** {@link runRelayCommandPlane} iterates
 *      `relayPreambleSteps` in order and stops at the first step whose
 *      reply is an error — it never reaches the `!P 7`/`!GO` steps
 *      after a `!CG` rejection.
 *   2. **`!GO` must never hang un-timed-out.** The wait for `!GO`'s
 *      confirmation always races against {@link
 *      RelayCommandPlaneOptions.scheduler}'s `delay()` — it resolves
 *      (successfully or with a timeout failure) no matter what the
 *      relay does or doesn't send back.
 *
 * ## `AbortSignal`, and the individually callable steps (ticket 014-006)
 *
 * Every wait in this module (the sync loop's, and each preamble step's)
 * also races an optional `signal` — {@link runRelayCommandPlane} and
 * every exported step function below accept one. An abort settles the
 * *current* wait immediately (never waiting out its own `timeoutMs`),
 * rejecting with the signal's own abort reason — this is what lets this
 * module double as `LineLink.ts`'s `preamble(stream, signal)` hook: a
 * `LineLink.connect({ timeoutMs, signal })` whose bound expires (or
 * whose caller-supplied signal aborts) while the relay handshake is
 * mid-step stops within that one step, not up to `timeoutMs` later.
 *
 * {@link sync}, {@link setChannelGroup}, and {@link go} are the sync
 * loop and two of the five preamble steps, exported standalone (not just
 * composed inside {@link runRelayCommandPlane}) for the future channel-
 * group sweeper (rearch-10): a caller that wants to confirm the relay is
 * live and retune it can call `sync()` then `setChannelGroup()` without
 * ever calling `go()` — the relay stays in the command plane, exactly
 * the "drive `!CG` without `!GO`" shape rearch-10 needs, expressed here
 * as three ordinary async functions rather than a single combined call
 * that would have to expose a "stop before `!GO`" flag.
 */

import {
  buildGoLine,
  buildQueryLine,
  buildSetChannelGroupLine,
  classifyRelayReply,
  parseRelayStatusLine,
  relayPreambleSteps,
  type RelayPreambleStep,
} from "@robot-console/protocol";
import { realScheduler, type Scheduler } from "./pacing.js";

/** Default time to wait for the `!CG` confirmation reply, and
 * separately for the `!GO` confirmation reply, before treating either
 * as failed. Mirrors `UsbSerialLink`'s `DEFAULT_OPEN_TIMEOUT_MS`
 * pattern (`link/UsbSerialLink.ts`) -- same order of magnitude, same
 * "configurable, real default" shape. */
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 3000;

/** Raised by {@link runRelayCommandPlane} for either handshake failure
 * mode -- a `!CG` rejection/timeout, or a `!GO` timeout. `message`
 * is diagnosable text a caller (`RelayRadioLink.connect()`) can surface
 * directly; see the module doc comment's two invariants for what
 * distinguishes the two causes. */
export class RelayHandshakeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RelayHandshakeError";
  }
}

/** The raw-line write/subscribe pair every function in this module is
 * driven over -- see the module doc comment's "Raw lines, not decoded v6
 * lines" section for why these are plain strings, not `LineLink`'s own
 * `LineListener`. */
export interface RelayLinkIO {
  /** Send one already-formatted wire line (trailing `\n` included, as
   * every `commands.ts` builder already produces). Expected to be paced
   * exactly like every other write the owning transport makes (e.g.
   * `UsbSerialLink`'s own `paceWrite`) -- this module has no pacing
   * logic of its own and trusts the caller's write function to provide
   * it. */
  write: (line: string) => void;
  /** Subscribe to every raw, already-reassembled inbound line arriving
   * while the handshake is in progress. Returns an unsubscribe
   * function. This module subscribes and unsubscribes once per
   * preamble step -- never more than one listener registered at a
   * time. */
  subscribe: (listener: (line: string) => void) => () => void;
}

/** Common options every exported step function (and {@link
 * runRelayCommandPlane}) shares beyond {@link RelayLinkIO} -- see the
 * module doc comment's "`AbortSignal`, and the individually callable
 * steps" section for `signal`. */
export interface RelayStepOptions extends RelayLinkIO {
  /** ms to wait for this step's confirmation reply before failing it.
   * Default {@link DEFAULT_HANDSHAKE_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Injectable delay primitive (`link/pacing.ts`'s `Scheduler` --
   * reused rather than inventing a second timing abstraction). Defaults
   * to real timers ({@link realScheduler}); tests substitute a fake so
   * the `!GO`-timeout path is provable with no real wall-clock delay
   * (`sprint.md`'s Test Strategy). */
  scheduler?: Scheduler;
  /** Aborts the current wait immediately -- see the module doc
   * comment's `AbortSignal` section. Optional; omitted entirely, this
   * module behaves exactly as it did before ticket 014-006. */
  signal?: AbortSignal;
}

/** Options for {@link sync} -- the `?` probe loop, factored out of
 * {@link RelayStepOptions} because it retries on its own schedule
 * (`syncRetryMs`/`syncAttempts`) rather than failing after one
 * `timeoutMs` wait. */
export interface RelaySyncOptions extends RelayLinkIO {
  /** How long to wait for the relay to answer each `?` sync probe
   * before sending another (default 500ms), and how many probes to send
   * before giving up (default 16, i.e. 8s -- a DAP reset + boot). */
  syncRetryMs?: number;
  syncAttempts?: number;
  scheduler?: Scheduler;
  signal?: AbortSignal;
}

/** Options for {@link runRelayCommandPlane} -- {@link RelaySyncOptions}
 * and {@link RelayStepOptions} combined, plus the radio address every
 * preamble step past `sync` needs. */
export interface RelayCommandPlaneOptions extends RelayLinkIO {
  syncRetryMs?: number;
  syncAttempts?: number;
  /** Radio channel for `!CG <channel> <group>`. */
  channel: number;
  /** Radio group for `!CG <channel> <group>`. */
  group: number;
  timeoutMs?: number;
  scheduler?: Scheduler;
  signal?: AbortSignal;
}

/**
 * Run the full relay command-plane handshake to completion: `!ECHO OFF`
 * -> `!MODE RAW250` -> `!CG <channel> <group>` -> `!P 7` -> `!GO`, in
 * order, over `options.write`/`options.subscribe`. Resolves once `!GO`
 * has been sent and its confirmation reply observed (see the module doc
 * comment for what "confirmation" means for `!GO`) -- the caller can
 * treat that as "the data plane is now live" and stop routing inbound
 * lines to this module's raw-line subscription (`RelayRadioLink`
 * switches its own dispatch at exactly that point). Suitable as-is for
 * `LineLink.ts`'s `preamble(stream, signal)` hook: pass `stream`'s raw-
 * line write/subscribe pair and the `signal` `LineLink.connect()` hands
 * the hook straight through as `options.signal`.
 *
 * Rejects with a {@link RelayHandshakeError} on either handshake failure
 * mode: a `!CG` rejection or unconfirmed reply (no `!GO` ever sent -- the
 * relay is left in the command plane), or an unconfirmed `!GO` (timeout).
 * Rejects with `options.signal`'s own abort reason if it fires mid-step
 * (see the module doc comment's `AbortSignal` section) -- within that
 * one step, never waiting out the rest of its `timeoutMs`. Never
 * resolves partially and never hangs -- see the module doc comment's two
 * invariants.
 */
export async function runRelayCommandPlane(options: RelayCommandPlaneOptions): Promise<void> {
  const { write, subscribe, channel, group, signal } = options;
  const timeoutMs = options.timeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
  const scheduler = options.scheduler ?? realScheduler;
  const syncRetryMs = options.syncRetryMs ?? DEFAULT_SYNC_RETRY_MS;
  const syncAttempts = options.syncAttempts ?? DEFAULT_SYNC_ATTEMPTS;

  // OOP 2026-09-09 -- every step below waits for ITS OWN reply, and
  // nothing else counts. Measured on relay vitut: the relay answers
  // every command with a `#` line (`!ECHO OFF` -> `# echo: OFF`,
  // `!MODE RAW250` -> `# mode: RAW250`, `!CG c g` / `!P n` / `?` ->
  // `# channel: c group: g mode: RAW250 power: n`, `!GO` -> `# entering
  // data plane`, a bad `!CG` -> `# error: usage ...`). An earlier
  // version wrote the first three commands back to back and took "the
  // next line" as the `!CG` confirmation -- which was really the
  // `!ECHO OFF` reply -- and then "any line" as the `!GO` confirmation,
  // which was the `!MODE` reply. After a DAP reset the relay's boot text
  // satisfied both gates before it had processed a single command, and
  // it was left in the command plane answering `# error: unknown
  // command` to every robot verb. Hence: (1) a sync step that sends `?`
  // until the relay answers, so a still-booting relay is waited for
  // rather than talked past; (2) one command in flight at a time, each
  // matched against its own step's `confirms()` predicate (from
  // `@robot-console/protocol`'s `relayPreambleSteps` -- the reply
  // grammar itself lives there now, not as inline regexes here), with
  // stray boot text, `DBG:` radio chatter and stale replies ignored.

  await sync({
    write,
    subscribe,
    scheduler,
    syncRetryMs,
    syncAttempts,
    // exactOptionalPropertyTypes: only include `signal` when actually
    // given -- explicitly passing `undefined` is a different (and
    // rejected) thing from omitting the property entirely.
    ...(signal !== undefined ? { signal } : {}),
  });

  for (const preambleStep of relayPreambleSteps(channel, group)) {
    await step(write, subscribe, scheduler, timeoutMs, preambleStep, signal);
  }
}

const DEFAULT_SYNC_RETRY_MS = 500;
const DEFAULT_SYNC_ATTEMPTS = 16;

/**
 * Send `?` until the relay answers with a status line, or give up after
 * `syncAttempts` (default {@link DEFAULT_SYNC_ATTEMPTS}, each waiting up
 * to `syncRetryMs` -- default {@link DEFAULT_SYNC_RETRY_MS}). This is
 * {@link runRelayCommandPlane}'s own first phase, exported standalone --
 * see the module doc comment's "individually callable steps" section --
 * so a caller can confirm the relay is in its command plane without also
 * running the rest of the preamble.
 *
 * Rejects with a {@link RelayHandshakeError} if the relay never answers,
 * or with `options.signal`'s abort reason if it fires first.
 */
export async function sync(options: RelaySyncOptions): Promise<void> {
  const { write, subscribe, signal } = options;
  const scheduler = options.scheduler ?? realScheduler;
  const syncRetryMs = options.syncRetryMs ?? DEFAULT_SYNC_RETRY_MS;
  const syncAttempts = options.syncAttempts ?? DEFAULT_SYNC_ATTEMPTS;

  let synced = false;
  for (let attempt = 0; attempt < syncAttempts && !synced; attempt++) {
    if (signal?.aborted) {
      throw abortReason(signal);
    }
    write(buildQueryLine());
    const reply = await waitForMatch(
      subscribe,
      scheduler,
      syncRetryMs,
      (candidate) => classifyRelayReply(candidate) === "status",
      signal,
    );
    synced = reply !== undefined;
  }
  if (!synced) {
    throw new RelayHandshakeError(
      `relay never answered \`?\` after ${syncAttempts} attempts (${syncAttempts * syncRetryMs}ms) -- not in its command plane, or still booting`,
    );
  }
}

/**
 * Send `!CG <channel> <group>` alone and wait for its confirmation --
 * one isolated preamble step, exported standalone (see the module doc
 * comment) so a caller can retune the relay's radio address without
 * running `!ECHO OFF`/`!MODE RAW250`/`!P 7`/`!GO` around it -- the relay
 * stays in the command plane throughout, never reaching the data plane.
 * Rejects with a {@link RelayHandshakeError} on rejection/timeout, or
 * with `options.signal`'s abort reason if it fires first.
 */
export async function setChannelGroup(channel: number, group: number, options: RelayStepOptions): Promise<void> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
  const scheduler = options.scheduler ?? realScheduler;
  const cgStep: RelayPreambleStep = {
    line: buildSetChannelGroupLine(channel, group),
    label: `!CG ${channel} ${group}`,
    confirms: (reply) => {
      const status = parseRelayStatusLine(reply);
      return status !== null && status.channel === channel && status.group === group;
    },
  };
  await step(options.write, options.subscribe, scheduler, timeoutMs, cgStep, options.signal);
}

/**
 * Send `!GO` alone and wait for its confirmation, handing the relay off
 * to the data plane -- exported standalone for symmetry with {@link
 * sync}/{@link setChannelGroup} (see the module doc comment); a caller
 * reaching for this directly rather than the full {@link
 * runRelayCommandPlane} is responsible for having already run the rest
 * of the preamble itself. Rejects with a {@link RelayHandshakeError} on
 * timeout, or with `options.signal`'s abort reason if it fires first.
 */
export async function go(options: RelayStepOptions): Promise<void> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
  const scheduler = options.scheduler ?? realScheduler;
  const goStep: RelayPreambleStep = {
    line: buildGoLine(),
    label: "!GO",
    confirms: (reply) => classifyRelayReply(reply) === "enteringDataPlane",
  };
  await step(options.write, options.subscribe, scheduler, timeoutMs, goStep, options.signal);
}

/** Write one preamble step's line and wait for the reply that confirms
 * it (`step.confirms`). A `# error: ...` line in the meantime is a
 * rejection of THIS step (the relay answers in order, one reply per
 * command); any other line (boot text, `DBG:` chatter, a stale earlier
 * reply) is ignored. */
async function step(
  write: RelayLinkIO["write"],
  subscribe: RelayLinkIO["subscribe"],
  scheduler: Scheduler,
  timeoutMs: number,
  preambleStep: RelayPreambleStep,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) {
    throw abortReason(signal);
  }
  write(preambleStep.line);
  const reply = await waitForMatch(
    subscribe,
    scheduler,
    timeoutMs,
    (candidate) => preambleStep.confirms(candidate) || classifyRelayReply(candidate) === "error",
    signal,
  );
  if (reply === undefined) {
    throw new RelayHandshakeError(
      `relay never confirmed ${preambleStep.label} within ${timeoutMs}ms -- handshake stopped, relay left in the command plane`,
    );
  }
  if (classifyRelayReply(reply) === "error") {
    throw new RelayHandshakeError(
      `relay rejected ${preambleStep.label} (reply: ${JSON.stringify(reply)}) -- handshake stopped, relay left in the command plane`,
    );
  }
}

function abortReason(signal: AbortSignal): Error {
  const reason = (signal as { reason?: unknown }).reason;
  return reason instanceof Error ? reason : new Error(String(reason ?? "aborted"));
}

/** Wait for the first line satisfying `match`, or `undefined` if none
 * arrives within `timeoutMs` (raced via `scheduler.delay` -- never
 * hangs). Non-matching lines are ignored, not consumed as answers.
 * Also races `signal`, if given: an abort settles this wait immediately
 * with a rejection (the signal's own abort reason) rather than waiting
 * out `timeoutMs` -- this is the "aborts within one step" contract the
 * module doc comment describes. */
function waitForMatch(
  subscribe: RelayLinkIO["subscribe"],
  scheduler: Scheduler,
  timeoutMs: number,
  match: (line: string) => boolean,
  signal?: AbortSignal,
): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortReason(signal));
      return;
    }
    let settled = false;
    const cleanup = () => {
      unsubscribe();
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(abortReason(signal!));
    };
    const unsubscribe = subscribe((line) => {
      if (settled || !match(line)) {
        return;
      }
      settled = true;
      cleanup();
      resolve(line);
    });
    signal?.addEventListener("abort", onAbort, { once: true });
    void scheduler.delay(timeoutMs).then(() => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(undefined);
    });
  });
}
