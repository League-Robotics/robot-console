/**
 * clearDeadProcessState.ts — the every-open reset for ticket 018-010's
 * own bench-evidenced defect: `board_owner`/`relay_leases`/`sessions`
 * rows, and a `links.state` of `connecting`/`connected`, all describe
 * something only a *running* process can be doing right now (holding a
 * physical port, bridging a robot through a relay, having an open
 * session, being mid-connect-attempt) — but all four are plain SQLite
 * rows that outlive the process that wrote them across a crash or
 * restart.
 *
 * ## Bench evidence
 *
 * The stakeholder copied his own running `console.sqlite` for the
 * team-lead's truthfulness check (`018-010`'s own acceptance-evidence
 * copy) while `node scripts/dev.mjs` was still live. The copy carried a
 * `relay_leases` row `{owner: "sweep"}` for `vitut` from that still-
 * running process; a *second*, freshly-started host, opened against the
 * copy with `--no-sweep` (its own sweeper never runs, so it can never
 * have written that row itself), rendered `vitut`'s card "idle ·
 * sweeping (slow)" — a lease genuinely held by a process this host is
 * not, and can never release the normal way (`releaseRelayLease`'s own
 * conditional-owner check would have this second process's own identity
 * as `owner`, never `"sweep"`, so it can never come around to release a
 * lease it never acquired).
 *
 * The same class of leftover row can block more than display text: a
 * `board_owner`/`relay_leases` row surviving a crash keeps the *next*
 * process's own `acquireBoardOwner`/`acquireRelayLease` calls failing
 * (wrong current owner) indefinitely — a physical port or relay a real
 * student is standing in front of, permanently reported busy, until
 * someone manually clears the database file. A `links.state` of
 * `connecting`/`connected` left over the same way is worse than a
 * display bug: `connect/reconciler.ts`'s own `deviceHasActiveLink`/
 * `isAutoConnectEligible` treat *both* states as "this device already
 * has a connection", so a stale one there means the reconciler will
 * never again attempt to (re)connect that device automatically — not
 * merely mislabeled, structurally stuck.
 *
 * ## The rule
 *
 * Run once per `openStore` call (this module's only caller), before any
 * watcher/reconciler starts (`openStore`'s own doc comment): every
 * `board_owner` row is released (by its own current `owner`, whatever
 * that is — see {@link Store.deadProcessStateRows}' own doc comment for
 * why no finer "is this one actually dead" check is needed), every
 * `relay_leases` row likewise, every `sessions` row is closed, and every
 * `links` row currently `connecting` or `connected` is reset to
 * `connectable` (`connect/reconciler.ts`'s own idiom for "known, eligible
 * for a fresh auto-connect attempt" — see its `setLinkState({...,
 * state: "connectable", reason: "relay-identified-idle"})` at the idle-
 * relay transition this mirrors) with reason `"process-restarted"`.
 * Idempotent: a store with none of these rows left (the overwhelmingly
 * common case — a clean shutdown, or simply "nothing was open when the
 * process last ran") finds nothing to change.
 *
 * ## What this deliberately does NOT touch
 *
 * `settings` rows keyed `relaySweepFast:<relayLinkId>`
 * (`Store.deadProcessStateRows`' sibling, `fastSweepByRelayLinkId` —
 * `projection.ts`'s `buildRelays`) are a *capability* the sweeper
 * feature-detected once ("does this relay's firmware answer the
 * non-persisting `!CGT` fast-sweep tune"), not a claim about anything
 * currently in progress — unlike `relay_leases.owner === "sweep"`
 * (which *is* exactly that claim, and is what actually drove the
 * bench-evidenced "idle · sweeping (slow)" text), a relay's own
 * hardware capability does not stop being true just because the
 * process that detected it stopped running. Clearing it here would only
 * force a pointless re-detection on the next sweep with no truthfulness
 * gain, so it is left alone.
 */
import type { Store } from "../index.js";

/**
 * Runs the dead-process-state reset against `store` — see this module's
 * own doc comment for the exact rule. `now` is the timestamp the
 * released links' own `state_since` is set to (defaults to `Date.now()`
 * for every real caller; injectable so a test can pin it).
 */
export function clearDeadProcessState(store: Store, now: number = Date.now()): void {
  const rows = store.deadProcessStateRows();

  for (const { usbSerial, owner } of rows.boardOwners) {
    store.releaseBoardOwner(usbSerial, owner);
  }
  for (const { relayLinkId, owner } of rows.relayLeases) {
    store.releaseRelayLease(relayLinkId, owner);
  }
  for (const { linkId } of rows.openSessions) {
    store.closeSession(linkId);
  }
  for (const { id } of rows.liveLinks) {
    store.setLinkState({ id, state: "connectable", at: now, reason: "process-restarted" });
  }
}
