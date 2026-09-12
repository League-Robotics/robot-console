/**
 * keyedMutex.ts — relocated from `deviceRegistry.ts`'s `KeyedMutex`
 * (sprint 015 ticket 001; issue
 * `rearch-05-connector-reconciler-harvester-retire-deviceregistry.md`),
 * with the `.tails` pruning fix the device-model review called out
 * (`docs/reviews/2026-09-11/01-host-device-model.md` §7: "`tails` is
 * never pruned — one entry persists per resource key for the process's
 * lifetime"). The original in `deviceRegistry.ts` is left untouched —
 * ticket 003 deletes that file outright once the old identify paths are
 * retired; this is a fresh copy, not an import, so this ticket does not
 * have to modify the module it is retiring out from under.
 *
 * ## What changed from the original
 *
 * Only the pruning behavior. Everything else — strict per-key
 * serialization, in-order execution, a rejecting task never wedging the
 * next task queued under the same key — is unchanged; see the class doc
 * comment below (carried over near-verbatim) for the full contract.
 *
 * The fix: once a `run()` call's own tail settles, it removes itself
 * from `tails` *if no newer call has since replaced it* (a `===`
 * identity check against what is currently stored under that key). A
 * resource key that is only ever used in bursts — as every real caller
 * in this codebase's connect/reconciler path is: one connect attempt per
 * link, occasionally overlapping, never a steady drip — returns to an
 * empty map between bursts instead of accumulating one entry per key
 * for the process's lifetime (the review's own "worth revisiting if the
 * resource-key space ever grows unbounded" concern, e.g. one entry per
 * ephemeral remote session).
 */

/**
 * Runs async tasks registered under the same `resourceKey` strictly one
 * at a time, in the order {@link run} was called, while tasks under
 * different resource keys run fully concurrently. A task that throws/
 * rejects does not wedge later tasks queued under the same key — the
 * chain always advances regardless of the previous task's outcome; only
 * the caller of that specific {@link run} call observes its rejection.
 *
 * Named for the physical resource it serializes access to (a USB port,
 * a relay's shared port), not for whatever logical caller happens to
 * invoke it — two different endpoints (e.g. two robots behind one
 * relay) can share one `resourceKey` and will still be serialized
 * against each other by this same mechanism, with no per-caller
 * bookkeeping.
 */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<void>>();

  run<T>(resourceKey: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(resourceKey) ?? Promise.resolve();
    const result = previous.then(task);
    // Store a variant that always resolves as the new chain tail, so a
    // rejection from this task never poisons the next queued task under
    // the same key — only `result` (returned to this call's caller)
    // carries the rejection onward.
    const settledTail: Promise<void> = result.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(resourceKey, settledTail);

    // Prune once this call's own tail settles — but only if nothing
    // newer has since taken over `resourceKey`'s slot in the map. If a
    // later `run()` call under the same key already replaced the entry
    // by the time this one settles, deleting it here would drop that
    // newer chain's tail out of the map entirely (a later task under
    // the same key would then wrongly run concurrently with an
    // already-in-flight one instead of queuing behind it).
    void settledTail.then(() => {
      if (this.tails.get(resourceKey) === settledTail) {
        this.tails.delete(resourceKey);
      }
    });

    return result;
  }

  /** Number of resource keys with a tail currently recorded — exposed
   * only so a test can assert the pruning fix actually prunes; not used
   * by any production call site. */
  get size(): number {
    return this.tails.size;
  }
}
