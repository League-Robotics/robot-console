/**
 * connect/flasher.ts — owns `board_owner = 'flash'` exclusivity and
 * session close-first handoff around one flash operation (sprint 017
 * ticket 003; issue `rearch-14-flash-swd-timeouts-platform-msd-fallback.md`;
 * `docs/design/architecture.md` §4/§8; `sprint.md`'s own Step 3 module
 * table). Sits exactly where `connect/connector.ts` already sits: a
 * small orchestrator that owns the store-facing exclusivity/handoff
 * logic so `flash.ts` itself stays a clean leaf, testable with a fake
 * `dapjs` and no store fixture at all (`sprint.md`'s own Design
 * Rationale, "connect/flasher.ts as a new small module, not inlined
 * ownership logic in flash.ts").
 *
 * ## What this module owns, and what it deliberately does not
 *
 * Per the sprint's own module table: inside is acquiring
 * `board_owner = 'flash'`, closing an open session first, invoking
 * `flash.ts`'s `flash()`, forwarding its `FlashPhase` progress callback
 * (the "`links.flash` phase writes" the table describes — `flash?:
 * {source, phase}` is `SnapshotLink`'s own ephemeral per-link field,
 * per `projection.ts`'s own doc comment it has no store table of its
 * own, so this module's job is simply to keep calling `onProgress`
 * through to whatever the caller does with it, exactly as `flash.ts`
 * itself already does — `server.ts` is what actually holds that
 * ephemeral overlay and broadcasts it), and releasing the owner in a
 * `finally` regardless of outcome. Outside: the DAPLink calls
 * themselves (`flash.ts`'s own job) and re-identification after a
 * successful flash — the freshly-rebooted board re-enumerates over USB
 * like any other attach, so `watchers/usbWatcher.ts`'s existing
 * `updated`/`added` event and `connect/reconciler.ts`'s automatic-
 * connect pass pick it back up on their own, with no special-casing
 * here (this is why the old `reidentifyAfterFlash` copy of the connect
 * sequence was retired, not replaced by anything in this module).
 *
 * ## Session closing via a narrow structural seam, not a `Reconciler` import
 *
 * This module depends only on `store` and `flash.ts` (`sprint.md`'s own
 * Step 3 dependency-direction note) — closing a session is expressed as
 * {@link FlasherSessionCloser}, a one-method structural interface this
 * module defines itself, the same pattern `connect/connector.ts` already
 * uses for its own `HarvesterAttach` seam. `server.ts`/`runtime.ts` wire
 * the real `connect/reconciler.ts`'s `requestClose` into it; this module
 * never imports `reconciler.ts` and gains no new edge to it.
 *
 * ## Why "close first, then acquire" rather than "acquire waits"
 *
 * `connect/connector.ts`'s own doc comment: `board_owner` is held only
 * for the duration of a connect *attempt*, released in that attempt's
 * own `finally` the moment it settles — success included — never for
 * the life of an open session. So a session sitting open on this link
 * does not itself hold `board_owner`; what actually blocks a flash is
 * the *OS transport* the session still has open (the serial port), not
 * the store row. Closing the session first (via
 * `reconciler.requestClose`, a no-op if nothing is open or opening —
 * `connect/reconciler.ts`'s own `planUserClose`) is therefore the real
 * precondition; the acquire-with-retry loop that follows only has to
 * cover the residual race against another concurrent connect attempt or
 * flash for the same board, which is why its default budget is short.
 */
import type { DaplinkDevice } from "../devices.js";
import { flash as defaultFlash, type FlashOptions, type FlashOutcome, type FlashPhase } from "../flash.js";
import { flashViaMbregistry as defaultFlashViaMbregistry, type RemoteFlashTarget } from "../mbregistry/remoteFlash.js";
import type { Store } from "../store/index.js";

/** The exact `board_owner.owner` literal this module acquires/releases
 * -- one of the four values `architecture.md` §4 documents (`'naming' |
 * 'session:<linkId>' | 'flash' | 'sweep'`). Global, not per-link,
 * matching that fixed vocabulary: unlike `connect/connector.ts`'s own
 * `session:<linkId>` owner (one distinct value per session), every
 * flash in this process shares this one literal -- `board_owner` is
 * keyed by `usbSerial` anyway, so two different boards flashing
 * concurrently never collide under one shared owner literal. */
export const FLASH_OWNER = "flash";

/** The narrow slice of `store` this module needs -- see the module doc
 * comment's own dependency-direction note. A real {@link Store}
 * satisfies this structurally; nothing else is required. */
export type FlasherStore = Pick<Store, "acquireBoardOwner" | "releaseBoardOwner">;

/** The narrow, structural session-closing seam this module needs -- see
 * the module doc comment's own section on why this is not a
 * `connect/reconciler.ts` import. A real `Reconciler` (its own
 * `requestClose`) satisfies this structurally. */
export interface FlasherSessionCloser {
  requestClose(linkId: string): Promise<void>;
}

/** Injectable delay for the acquire-retry loop below. Defaults to a
 * real, `unref()`'d `setTimeout` so a pending retry never keeps the
 * process alive on its own; tests substitute an instant/deterministic
 * delay so a contended-owner case does not need to wait out real
 * wall-clock time. */
export type DelayFn = (ms: number) => Promise<void>;

function defaultDelay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    (timer as unknown as { unref?: () => void }).unref?.();
  });
}

export interface FlasherDeps {
  /** See {@link FlasherSessionCloser}. */
  reconciler: FlasherSessionCloser;
  /** Injectable flash orchestration. Defaults to the real
   * `flash.ts#flash` -- tests substitute a fake that resolves/rejects
   * on demand, e.g. to exercise this module's own owner-release
   * guarantee without a real `dapjs`/HID stack. */
  flash?: typeof defaultFlash;
  /** Injectable mbregistry flash orchestration (sprint 018 ticket 005).
   * Defaults to the real `mbregistry/remoteFlash.ts#flashViaMbregistry`
   * — tests substitute a fake that resolves/rejects on demand, mirroring
   * `flash`'s own injection convention. */
  flashViaMbregistry?: typeof defaultFlashViaMbregistry;
  /** Wall-clock reader for the acquire-retry loop's own deadline.
   * Defaults to `Date.now`. */
  now?: () => number;
  /** See {@link DelayFn}. */
  delay?: DelayFn;
}

export interface FlasherOptions {
  /** Total time budget to wait for `board_owner` to free up once the
   * session (if any) has been closed, before giving up. Default
   * {@link DEFAULT_ACQUIRE_TIMEOUT_MS}. */
  acquireTimeoutMs?: number;
  /** Poll interval within that budget. Default
   * {@link DEFAULT_ACQUIRE_POLL_MS}. */
  acquirePollMs?: number;
}

/** See the module doc comment's "close first, then acquire" section for
 * why this default budget only has to cover a residual race, not the
 * common "a session was open" case. */
export const DEFAULT_ACQUIRE_TIMEOUT_MS = 5_000;
export const DEFAULT_ACQUIRE_POLL_MS = 100;

export interface Flasher {
  /**
   * Close any open/opening session on `linkId`, acquire
   * `board_owner = 'flash'` for `usbSerial` (retrying within the
   * configured budget if another owner still holds it), run `flash()`
   * against `device`/`hexText`, and release the owner in a `finally`
   * regardless of outcome. `onProgress` is forwarded to `flash()`
   * unchanged -- see the module doc comment's own "links.flash phase
   * writes" note.
   *
   * Never throws for a failure this module itself classifies (owner
   * never freed within budget comes back as a classified
   * {@link FlashOutcome}, the same "failure is a value" convention
   * `flash.ts` itself already follows) -- but does propagate a
   * rejection from `flash()` or `reconciler.requestClose()` itself,
   * same as calling either directly would.
   */
  flash(
    linkId: string,
    usbSerial: string,
    device: DaplinkDevice,
    hexText: string,
    onProgress: (phase: FlashPhase) => void,
    flashOptions?: FlashOptions,
  ): Promise<FlashOutcome>;

  /**
   * The `mbregistry`-transport sibling to {@link flash} (sprint 018
   * ticket 005). Closes any open/opening session on `linkId` first — the
   * same `reconciler.requestClose` seam {@link flash} already uses — but
   * never touches `board_owner` (no `acquireBoardOwner`/
   * `releaseBoardOwner` call anywhere in this method): mbregistry's own
   * `flash`-kind lock is the sole exclusivity for this transport,
   * matching `connect/connector.ts`'s `resolveExclusivity`'s
   * `Exclusivity.kind: "none"` for `"mbregistry"` (ticket 004). Once the
   * session is closed, delegates straight to `mbregistry/remoteFlash.ts`'s
   * `flashViaMbregistry` against the already-resolved `target` (this
   * module never decides *which* target — `server.ts#runFlashTask`/
   * `link/adapters/mbregistryStream.ts`'s `resolveFlashTarget` do that).
   * Never throws for a failure `flashViaMbregistry` itself already
   * classifies (same "failure is a value" convention as {@link flash});
   * does propagate a rejection from `reconciler.requestClose` itself.
   */
  flashMbregistry(
    linkId: string,
    uid: string,
    target: RemoteFlashTarget,
    label: string | undefined,
    hexText: string,
    onProgress: (phase: FlashPhase) => void,
  ): Promise<FlashOutcome>;
}

/**
 * Build a {@link Flasher} bound to `store`. See the module doc comment
 * for the full contract; see {@link FlasherDeps}/{@link FlasherOptions}
 * for every injectable seam.
 */
export function createFlasher(store: FlasherStore, deps: FlasherDeps, opts: FlasherOptions = {}): Flasher {
  const reconciler = deps.reconciler;
  const flashFn = deps.flash ?? defaultFlash;
  const flashViaMbregistryFn = deps.flashViaMbregistry ?? defaultFlashViaMbregistry;
  const now = deps.now ?? (() => Date.now());
  const delay = deps.delay ?? defaultDelay;
  const acquireTimeoutMs = opts.acquireTimeoutMs ?? DEFAULT_ACQUIRE_TIMEOUT_MS;
  const acquirePollMs = opts.acquirePollMs ?? DEFAULT_ACQUIRE_POLL_MS;

  /** Retries {@link Store.acquireBoardOwner} until it succeeds or
   * `acquireTimeoutMs` elapses -- see the module doc comment's "close
   * first, then acquire" section for why this loop's budget only has to
   * cover a residual concurrent-attempt race, not the common "a session
   * was open" case (already resolved by this function's own
   * `reconciler.requestClose` call before this ever runs). */
  async function acquireWithRetry(usbSerial: string): Promise<boolean> {
    const deadline = now() + acquireTimeoutMs;
    for (;;) {
      if (store.acquireBoardOwner(usbSerial, FLASH_OWNER, now())) {
        return true;
      }
      if (now() >= deadline) {
        return false;
      }
      await delay(acquirePollMs);
    }
  }

  return {
    async flash(
      linkId: string,
      usbSerial: string,
      device: DaplinkDevice,
      hexText: string,
      onProgress: (phase: FlashPhase) => void,
      flashOptions?: FlashOptions,
    ): Promise<FlashOutcome> {
      await reconciler.requestClose(linkId);

      const acquired = await acquireWithRetry(usbSerial);
      if (!acquired) {
        return {
          status: "error",
          method: "swd",
          reason: "owner-unavailable",
          error:
            `could not acquire board_owner "${FLASH_OWNER}" for usb serial "${usbSerial}" within ` +
            `${acquireTimeoutMs}ms -- another owner still holds it`,
        };
      }

      try {
        return await flashFn(device, hexText, onProgress, flashOptions);
      } finally {
        store.releaseBoardOwner(usbSerial, FLASH_OWNER);
      }
    },

    async flashMbregistry(
      linkId: string,
      uid: string,
      target: RemoteFlashTarget,
      label: string | undefined,
      hexText: string,
      onProgress: (phase: FlashPhase) => void,
    ): Promise<FlashOutcome> {
      await reconciler.requestClose(linkId);
      return flashViaMbregistryFn(target, uid, label, hexText, onProgress);
    },
  };
}
