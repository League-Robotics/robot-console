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

/** Is `line` the relay's confirmation shape -- a `#`-prefixed comment,
 * per the one captured example this codebase has
 * (`vendor/pxt-nezha-diffdrive/captures/radio-addressing-20260830.md`
 * §4: `# channel: 47 group: 60 mode: RAW250 power: 7`) and
 * `commands.ts`'s own "`#` lines are comments, never commands" contract.
 * Anything else is treated as a rejection -- see the module doc
 * comment's `!CG` bullet for why "unless it looks like the documented
 * success shape, treat it as failure" is the safer default here, given
 * no rejection wire text is captured or documented anywhere in this
 * codebase to match against instead. */
function isConfirmationLine(line: string): boolean {
  return line.trimStart().startsWith("#");
}

/** Wait for the next raw line `subscribe` delivers, or `undefined` if
 * none arrives within `timeoutMs` (raced via `scheduler.delay`, per the
 * module doc comment's second invariant -- this can never hang). Only
 * one call is ever in flight at a time from {@link runRelayCommandPlane}
 * itself. */
function waitForReply(
  subscribe: RelayCommandPlaneOptions["subscribe"],
  scheduler: Scheduler,
  timeoutMs: number,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    const unsubscribe = subscribe((line) => {
      if (settled) {
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

  // !ECHO OFF, !MODE RAW250 -- sent, not gated on a reply (see the
  // module doc comment's "What is, and is not, gated on a reply").
  write(buildEchoOffLine());
  write(buildModeRaw250Line());

  // !CG <channel> <group> -- gated. A rejection (or no reply at all)
  // stops the sequence here: !P and !GO are never sent, so the relay is
  // left in the command plane (invariant 1).
  write(buildSetChannelGroupLine(channel, group));
  const cgReply = await waitForReply(subscribe, scheduler, timeoutMs);
  if (cgReply === undefined) {
    throw new RelayHandshakeError(
      `relay never confirmed !CG ${channel} ${group} within ${timeoutMs}ms -- handshake stopped before !GO, relay left in the command plane`,
    );
  }
  if (!isConfirmationLine(cgReply)) {
    throw new RelayHandshakeError(
      `relay rejected !CG ${channel} ${group} (reply: ${JSON.stringify(cgReply)}) -- handshake stopped before !GO, relay left in the command plane`,
    );
  }

  // !P 7 -- sent, not gated (see above).
  write(buildSetPowerLine());

  // !GO -- gated on presence only (no captured confirmation-reply
  // shape exists to gate on content, per the module doc comment). Never
  // hangs: always races against scheduler.delay (invariant 2).
  write(buildGoLine());
  const goReply = await waitForReply(subscribe, scheduler, timeoutMs);
  if (goReply === undefined) {
    throw new RelayHandshakeError(`relay never confirmed !GO within ${timeoutMs}ms -- handshake timed out`);
  }
}
