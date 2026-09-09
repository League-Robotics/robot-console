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
 * its failure handling independently (the same discipline
 * `LineRouter.ts` already applies to ack/nack arithmetic).
 *
 * ## Raw lines, not decoded v6 lines
 *
 * The write/subscribe pair this module is given operates on raw,
 * already-reassembled wire lines (post-`LineReassembler` — the `< `
 * receive-prefix strip from `lineStream.ts` already applies
 * unconditionally, per `sprint.md`'s Solution section), **not**
 * `link/Link.ts`'s `LineListener` (`DecodedLine`, produced by
 * `v6/codec.ts`'s `decodeLine`). The relay's own preamble replies (e.g.
 * the live-captured `# channel: 47 group: 60 mode: RAW250 power: 7`) are
 * `#`-prefixed comment text, not v6 protocol lines at all — decoding
 * them through `decodeLine`/`LineRouter` would be meaningless before the
 * data plane is even reached. This mirrors `UsbSerialLink`'s own
 * pre-data-plane idiom: while {@link Link.identify} is waiting for a
 * `HELLO` banner reply, `UsbSerialLink#handleLine` inspects raw lines
 * directly instead of routing them through `LineRouter` — the same
 * "raw lines before the data plane, decoded lines after" split applies
 * here, one phase earlier.
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
 *      plane.** {@link runRelayCommandPlane} never calls {@link
 *      buildGoLine} (or {@link buildSetPowerLine}) after a `!CG`
 *      rejection — there is no path from a rejected `!CG` to `!GO`.
 *   2. **`!GO` must never hang un-timed-out.** The wait for `!GO`'s
 *      confirmation always races against {@link
 *      RelayCommandPlaneOptions.scheduler}'s `delay()` — it resolves
 *      (successfully or with a timeout failure) no matter what the
 *      relay does or doesn't send back.
 */

import {
  buildEchoOffLine,
  buildGoLine,
  buildModeRaw250Line,
  buildSetChannelGroupLine,
  buildSetPowerLine,
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

/** The raw-line write/subscribe pair this module is driven over -- see
 * the module doc comment's "Raw lines, not decoded v6 lines" section for
 * why these are plain strings, not `link/Link.ts`'s `LineListener`. */
export interface RelayCommandPlaneOptions {
  /** How long to wait for the relay to answer each `?` sync probe
   * before sending another (default 500ms), and how many probes to send
   * before giving up (default 16, i.e. 8s -- a DAP reset + boot). */
  syncRetryMs?: number;
  syncAttempts?: number;
  /** Send one already-formatted wire line (trailing `\n` included, as
   * every `commands.ts` builder already produces). Expected to be paced
   * exactly like every other write the owning transport makes (e.g.
   * `UsbSerialLink`'s own `paceWrite`) -- this module has no pacing
   * logic of its own and trusts the caller's write function to provide
   * it. */
  write: (line: string) => void;
  /** Subscribe to every raw, already-reassembled inbound line arriving
   * while the handshake is in progress. Returns an unsubscribe
   * function. This module subscribes and unsubscribes once per gated
   * step ({@link buildSetChannelGroupLine}'s reply, then {@link
   * buildGoLine}'s) -- never more than one listener registered at a
   * time. */
  subscribe: (listener: (line: string) => void) => () => void;
  /** Radio channel for `!CG <channel> <group>`. */
  channel: number;
  /** Radio group for `!CG <channel> <group>`. */
  group: number;
  /** ms to wait for the `!CG` confirmation reply, and separately for
   * the `!GO` confirmation reply, before failing that step. Default
   * {@link DEFAULT_HANDSHAKE_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Injectable delay primitive (`link/pacing.ts`'s `Scheduler` --
   * reused rather than inventing a second timing abstraction). Defaults
   * to real timers ({@link realScheduler}); tests substitute a fake so
   * the `!GO`-timeout path is provable with no real wall-clock delay
   * (`sprint.md`'s Test Strategy). */
  scheduler?: Scheduler;
}



/**
 * Run the full relay command-plane handshake to completion: `!ECHO OFF`
 * -> `!MODE RAW250` -> `!CG <channel> <group>` -> `!P 7` -> `!GO`, in
 * order, over `options.write`/`options.subscribe`. Resolves once `!GO`
 * has been sent and its confirmation reply observed (see the module doc
 * comment for what "confirmation" means for `!GO`) -- the caller can
 * treat that as "the data plane is now live" and stop routing inbound
 * lines to this module's raw-line subscription (`RelayRadioLink`
 * switches its own dispatch at exactly that point).
 *
 * Rejects with a {@link RelayHandshakeError} on either handshake failure
 * mode: a `!CG` rejection or unconfirmed reply (no `!GO` ever sent -- the
 * relay is left in the command plane), or an unconfirmed `!GO` (timeout).
 * Never resolves partially and never hangs -- see the module doc
 * comment's two invariants.
 */
export async function runRelayCommandPlane(options: RelayCommandPlaneOptions): Promise<void> {
  const { write, subscribe, channel, group } = options;
  const timeoutMs = options.timeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
  const scheduler = options.scheduler ?? realScheduler;
  const syncRetryMs = options.syncRetryMs ?? DEFAULT_SYNC_RETRY_MS;
  const syncAttempts = options.syncAttempts ?? DEFAULT_SYNC_ATTEMPTS;

  // OOP 2026-09-09 -- every step below waits for ITS OWN reply, and
  // nothing else counts. Measured on relay vitut: the relay answers
  // every command with a `#` line (`!ECHO OFF` -> `# echo: OFF`,
  // `!MODE RAW250` -> `# mode: RAW250`, `!CG c g` / `!P n` / `?` ->
  // `# channel: c group: g mode: RAW250 power: n`, `!GO` -> `# entering
  // data plane`, a bad `!CG` -> `# error: usage ...`). The previous
  // version wrote the first three commands back to back and took "the
  // next line" as the `!CG` confirmation -- which was really the
  // `!ECHO OFF` reply -- and then "any line" as the `!GO` confirmation,
  // which was the `!MODE` reply. After a DAP reset the relay's boot text
  // satisfied both gates before it had processed a single command, and
  // it was left in the command plane answering `# error: unknown
  // command` to every robot verb. Hence: (1) a sync step that sends `?`
  // until the relay answers, so a still-booting relay is waited for
  // rather than talked past; (2) one command in flight at a time, each
  // matched against its specific reply, with stray boot text, `DBG:`
  // radio chatter and stale replies ignored.

  let synced = false;
  for (let attempt = 0; attempt < syncAttempts && !synced; attempt++) {
    write(QUERY_LINE);
    const reply = await waitForMatch(subscribe, scheduler, syncRetryMs, isStatusLine);
    synced = reply !== undefined;
  }
  if (!synced) {
    throw new RelayHandshakeError(
      `relay never answered \`?\` after ${syncAttempts} attempts (${syncAttempts * syncRetryMs}ms) -- not in its command plane, or still booting`,
    );
  }

  await step(write, subscribe, scheduler, timeoutMs, buildEchoOffLine(), "!ECHO OFF", /^#\s*echo:\s*OFF\b/i);
  await step(write, subscribe, scheduler, timeoutMs, buildModeRaw250Line(), "!MODE RAW250", /^#\s*mode:\s*RAW250\b/i);
  await step(
    write,
    subscribe,
    scheduler,
    timeoutMs,
    buildSetChannelGroupLine(channel, group),
    `!CG ${channel} ${group}`,
    new RegExp(`^#\\s*channel:\\s*${channel}\\s+group:\\s*${group}\\b`, "i"),
  );
  await step(write, subscribe, scheduler, timeoutMs, buildSetPowerLine(), "!P 7", /\bpower:\s*7\b/i);
  await step(write, subscribe, scheduler, timeoutMs, buildGoLine(), "!GO", /^#\s*entering data plane\b/i);
}

/** `?` -- the relay's own status query (`!HELP`: "show channel/group/
 * mode/power"), answered with the same `# channel: ... power: ...` line
 * `!CG`/`!P` confirm with. Used as the sync probe: it changes nothing. */
const QUERY_LINE = "?\n";
const DEFAULT_SYNC_RETRY_MS = 500;
const DEFAULT_SYNC_ATTEMPTS = 16;

function isStatusLine(line: string): boolean {
  return /^#\s*channel:\s*\d+\s+group:\s*\d+/i.test(line);
}

function isErrorLine(line: string): boolean {
  return /^#\s*error\b/i.test(line.trimStart());
}

/** Write one command and wait for the reply that matches `expect`. A
 * `# error: ...` line in the meantime is a rejection of THIS command
 * (the relay answers in order, one reply per command); any other line
 * (boot text, `DBG:` chatter, a stale earlier reply) is ignored. */
async function step(
  write: RelayCommandPlaneOptions["write"],
  subscribe: RelayCommandPlaneOptions["subscribe"],
  scheduler: Scheduler,
  timeoutMs: number,
  line: string,
  label: string,
  expect: RegExp,
): Promise<void> {
  write(line);
  const reply = await waitForMatch(subscribe, scheduler, timeoutMs, (candidate) => expect.test(candidate) || isErrorLine(candidate));
  if (reply === undefined) {
    throw new RelayHandshakeError(
      `relay never confirmed ${label} within ${timeoutMs}ms -- handshake stopped, relay left in the command plane`,
    );
  }
  if (isErrorLine(reply)) {
    throw new RelayHandshakeError(
      `relay rejected ${label} (reply: ${JSON.stringify(reply)}) -- handshake stopped, relay left in the command plane`,
    );
  }
}

/** Wait for the first line satisfying `match`, or `undefined` if none
 * arrives within `timeoutMs` (raced via `scheduler.delay` -- never
 * hangs). Non-matching lines are ignored, not consumed as answers. */
function waitForMatch(
  subscribe: RelayCommandPlaneOptions["subscribe"],
  scheduler: Scheduler,
  timeoutMs: number,
  match: (line: string) => boolean,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    const unsubscribe = subscribe((line) => {
      if (settled || !match(line)) {
        return;
      }
      settled = true;
      unsubscribe();
      resolve(line);
    });
    void scheduler.delay(timeoutMs).then(() => {
      if (settled) {
        return;
      }
      settled = true;
      unsubscribe();
      resolve(undefined);
    });
  });
}
