/**
 * unhandled.ts — a process-wide `unhandledRejection` backstop (sprint
 * 015 ticket 003; device-model review's `:3819`/`server.ts:430` finding:
 * an unhandled rejection anywhere in the connect/reconciler/harvester
 * pipeline must never crash the whole host process silently). Every
 * component this sprint adds (`connect/connector.ts`, `connect/
 * reconciler.ts`, `connect/harvester.ts`) already wraps its own awaits
 * so a rejection never escapes unhandled in the first place — this
 * module exists as the last-resort net for whatever still slips through
 * (a bug, or code this sprint does not touch), not as a substitute for
 * fixing a leak at its source.
 *
 * Exported as two pieces, deliberately kept separate:
 *
 * - {@link createUnhandledRejectionHandler} — the plain handler
 *   function: logs every rejection unconditionally, and — only when the
 *   rejection carries a `linkId` (see {@link linkIdOf}) — marks that
 *   link `failed` via `Store.setLinkState`, so `connect/reconciler.ts`'s
 *   own backoff schedule retries it instead of leaving it silently
 *   wedged forever.
 * - {@link installUnhandledRejectionBackstop} — wires that handler to
 *   `process.on('unhandledRejection', ...)`. Ticket 005's composition
 *   root calls this once, at real server startup; this module's own test
 *   calls {@link createUnhandledRejectionHandler}'s handler directly and
 *   never this function, so the test process's own global listeners stay
 *   untouched (this ticket's own instruction: "do not register it
 *   globally in tests").
 *
 * ## Carrying a `linkId` on a rejection
 *
 * Deliberately duck-typed rather than requiring every rejection to be an
 * instance of some class this module exports: any rejection reason —a
 * plain `{ linkId, ... }` object, or an `Error` with a `linkId` field
 * attached (`Object.assign(new Error(...), { linkId })`) — is recognized
 * without its caller needing to import anything from this module. A
 * rejection with no `linkId` at all (or a non-string one) is still
 * logged, just never turned into a `setLinkState` call.
 */
import type { Store } from "../store/index.js";

/** `reason.linkId` if `reason` is an object carrying a string `linkId`
 * field, else `undefined` — see the module doc comment's "Carrying a
 * linkId" section. */
function linkIdOf(reason: unknown): string | undefined {
  if (typeof reason !== "object" || reason === null || !("linkId" in reason)) {
    return undefined;
  }
  const value = (reason as { linkId?: unknown }).linkId;
  return typeof value === "string" ? value : undefined;
}

export interface UnhandledRejectionBackstopDeps {
  /** Defaults to `console.error`. */
  log?: (message: string, reason: unknown) => void;
  /** Wall-clock reader for `setLinkState`'s `at`. Defaults to `Date.now`. */
  now?: () => number;
}

/**
 * Build the handler described in the module doc comment, bound to
 * `store`. Never throws — a logging or store failure inside the handler
 * itself would only make a bad situation (an already-unhandled
 * rejection) worse, so both the log call and the store write are
 * best-effort.
 */
export function createUnhandledRejectionHandler(
  store: Store,
  deps: UnhandledRejectionBackstopDeps = {},
): (reason: unknown) => void {
  const log = deps.log ?? ((message: string, reason: unknown) => console.error(message, reason));
  const now = deps.now ?? (() => Date.now());

  return (reason: unknown): void => {
    const linkId = linkIdOf(reason);
    try {
      log(
        linkId !== undefined
          ? `unhandledRejection for link "${linkId}" -- marking it failed`
          : "unhandledRejection with no link id attached -- logged only, no link marked",
        reason,
      );
    } catch {
      // A logging failure must never mask the rejection itself, nor
      // skip the store write below.
    }
    if (linkId === undefined) {
      return;
    }
    try {
      store.setLinkState({
        id: linkId,
        state: "failed",
        at: now(),
        reason: reason instanceof Error ? reason.message : String(reason),
      });
    } catch {
      // The link may no longer exist, or the store may already be
      // closed (e.g. during shutdown) -- either way, this backstop must
      // not itself throw out of a `process.on('unhandledRejection')`
      // callback.
    }
  };
}

/**
 * Wire {@link createUnhandledRejectionHandler}'s handler to
 * `process.on('unhandledRejection', ...)`. Production use only — see
 * the module doc comment. Returns an unregister function.
 */
export function installUnhandledRejectionBackstop(
  store: Store,
  deps: UnhandledRejectionBackstopDeps = {},
): () => void {
  const handler = createUnhandledRejectionHandler(store, deps);
  process.on("unhandledRejection", handler);
  return () => {
    process.off("unhandledRejection", handler);
  };
}
