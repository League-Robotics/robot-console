/**
 * relayLeaseRevocation.ts — the shared in-process seam that lets a
 * student's bridge signal a running sweep to stop, without
 * `connect/relayBridger.ts` and `watchers/relaySweeper.ts` importing each
 * other (sprint 016 ticket 003; `sprint.md`'s Architecture Step 3 module
 * table, "relay lease revocation" row, and Step 6's own Design Rationale
 * entry, "the sweep-takeover handshake is a small in-process seam, not a
 * `relay_leases` schema column").
 *
 * ## Why a `Map<relayLinkId, AbortController>`, not a schema column
 *
 * `store.acquireRelayLease` already refuses to acquire a lease a
 * different owner holds — it never "steals" one. A student's
 * `session-open` needs the *sweeper itself* to notice and stop, not the
 * database to silently reassign ownership out from under a running probe
 * loop. Polling a `revoke_requested`-style column for a signal that only
 * ever needs to reach code already running in this same Node process
 * (architecture.md §2: "long-lived async tasks in one process, no
 * `worker_threads`") would add a poll interval and a schema column for
 * something an `AbortController` already does instantly and for free —
 * see sprint.md's own Design Rationale for the fuller alternatives
 * analysis. This seam has no persistence and is rebuilt fresh on every
 * host restart: a sweep running at the moment of a crash simply is not
 * running at restart, no different from any other in-process task's own
 * restart behavior.
 *
 * ## Register / lookup / clear — not "revoke" itself
 *
 * This module deliberately exposes only the three primitives named
 * above, not an opinionated "revoke and wait" call: {@link
 * RelayLeaseRevocation.register} (`watchers/relaySweeper.ts`, for the
 * duration of each probe pass), {@link RelayLeaseRevocation.get} (a
 * future bridge, ticket 004, to find and `.abort()` a running sweep's
 * controller directly — `AbortController.abort()` and the "wait for
 * handback" polling of `relay_leases` itself are that ticket's own
 * choreography, not this module's), and {@link
 * RelayLeaseRevocation.clear} (the sweeper again, once its pass ends —
 * success, failure, or abort alike). Keeping this module to the three
 * primitives, rather than a combined "revoke" convenience, is deliberate:
 * this ticket (016-003) only needs the sweeper's own register/deregister
 * half proven independently of any bridge — see this module's own test
 * file — and ticket 004 is free to compose `get()` + `.abort()` + its own
 * lease-release wait however its own handback-timing acceptance criteria
 * need, without this module guessing at that shape first.
 *
 * ## One controller per relay at a time
 *
 * `register` overwrites whatever was previously registered for a given
 * `relayLinkId` — only one sweep pass is ever running per relay at a
 * time (the sweeper's own per-relay loop, one pass after another, never
 * two concurrently), so this is never a real collision in practice.
 * {@link RelayLeaseRevocation.clear} only removes the mapping if the
 * controller passed in is still the one currently registered — a stale
 * `finally` block from an *earlier* pass can never clobber a *newer*
 * pass's own registration for the same relay.
 */

/** The shared seam itself — see the module doc comment for the full
 * contract. */
export interface RelayLeaseRevocation {
  /** Register `controller` as the currently-running sweep pass for
   * `relayLinkId`, replacing whatever was registered before. */
  register(relayLinkId: string, controller: AbortController): void;
  /** The `AbortController` currently registered for `relayLinkId`, or
   * `undefined` if no sweep pass is running against it right now. */
  get(relayLinkId: string): AbortController | undefined;
  /** Deregister `controller` for `relayLinkId` — a no-op if a *different*
   * controller is currently registered there (see the module doc
   * comment's "one controller per relay at a time" section). */
  clear(relayLinkId: string, controller: AbortController): void;
}

/**
 * Build a fresh, empty {@link RelayLeaseRevocation}. `runtime.ts`
 * constructs exactly one instance per running host and shares it between
 * `watchers/relaySweeper.ts` and (ticket 004) `connect/relayBridger.ts` —
 * two independent modules coordinating through one small piece of shared
 * in-process state, not through each other.
 */
export function createRelayLeaseRevocation(): RelayLeaseRevocation {
  const controllers = new Map<string, AbortController>();

  return {
    register(relayLinkId: string, controller: AbortController): void {
      controllers.set(relayLinkId, controller);
    },
    get(relayLinkId: string): AbortController | undefined {
      return controllers.get(relayLinkId);
    },
    clear(relayLinkId: string, controller: AbortController): void {
      if (controllers.get(relayLinkId) === controller) {
        controllers.delete(relayLinkId);
      }
    },
  };
}
