/**
 * reconciler.ts — the only component that decides what should be
 * connected (sprint 015 ticket 002; issue
 * `rearch-05-connector-reconciler-harvester-retire-deviceregistry.md`;
 * `docs/design/architecture.md` §8, "Connector and reconciler"). Two
 * halves, deliberately split:
 *
 * - {@link plan}, {@link planUserOpen}, {@link planUserClose} — pure
 *   decision functions: `(rows, ...) => Job[]`, no store or network
 *   access, trivially table-testable in isolation from the executor's
 *   timers/change-feed wiring.
 * - {@link startReconciler} — the thin executor: turns each `Job` into
 *   a call to ticket 001's `connectAndIdentify` (`./connector.js`),
 *   runs on every store change-feed event and a slow (5 s) tick, and
 *   exposes the narrow `requestOpen`/`requestClose` entry point the
 *   server (ticket 005) forwards an explicit user `session-open`/
 *   `session-close` command to.
 *
 * This replaces the six separate policy sites `deviceRegistry.ts` spread
 * its own equivalent decisions across (`syncWifiEndpoints`,
 * `retryWifiAutoConnects`, `autoConnectWifiRobot`, `autoSwitchRadioToWifi`,
 * `requestOpen`'s no-op rules, `pollStatus`'s watchdog) with one pure
 * function plus one executor. Ticket 003 deletes those six; this module
 * does not modify or import `deviceRegistry.ts` at all.
 *
 * ## Automatic connect is usb/wifi/mbserial only — radio/mbrelay never
 *
 * architecture.md §8 lists a five-transport preference order
 * (`usb > wifi > mbserial > radio > mbrelay`) for "the preferred link"
 * a device should be connected over, but its own rule 5 carves radio
 * back out: "Radio bridging is user-initiated only ... the reconciler
 * does not auto-bridge." §7.2 makes the same point about a relay's own
 * link ("There is no auto-opened console session on a relay any more").
 * So {@link plan}'s automatic per-device pass only ever considers
 * `usb`/`wifi`/`mbserial` candidates ({@link AUTO_CONNECT_TRANSPORTS});
 * a `radio`/`mbrelay` link only ever gets a job through
 * {@link planUserOpen} — the explicit "session-open" entry point, fed
 * either by a user click (forwarded by ticket 005's server) or ticket
 * 001's own connect flow. This is this ticket's own design call (not
 * settled anywhere more concretely than the two architecture notes
 * above) — flagged here for whoever wires the relay sweeper (a future
 * ticket) to confirm against real hardware.
 *
 * ## Finding a relay's current child without relying on `relay_leases`
 * alone
 *
 * `connect/connector.ts`'s own doc comment: `board_owner`/`relay_leases`
 * are held only for the duration of a connect *attempt*, released the
 * moment it settles — success included — not for the life of an open
 * session. So `relay_leases` alone only shows a child that is *currently
 * connecting*; once connected, its lease is already gone. `sessions`
 * (one row per currently-open link, held until the link actually
 * closes) covers the other half of the lifecycle. {@link planUserOpen}
 * combines both: a lease whose owner is `session:<linkId>` names an
 * in-flight child; failing that, a link with an open session riding the
 * same physical relay names an established one. Together they cover a
 * relay child across its whole lifecycle (connecting -> connected ->
 * closed), which is why {@link ReconcilerRows} carries both tables.
 *
 * ## `state = 'connecting'` is this module's own write, not the
 * connector's
 *
 * architecture.md §5's state diagram has `connectable --reconciler-->
 * connecting --[connector job]--> connected|failed`, but
 * `connect/connector.ts`'s `attempt()` never writes `'connecting'` --
 * only `'connected'`/`'failed'`. Writing `'connecting'` before calling
 * `connectAndIdentify` is this executor's own job (`runConnect` below),
 * which is also what lets a later `plan()`/`planUserOpen` call (the very
 * next change-feed tick, once that write lands) see the link as already
 * "active" and never re-issue a job for it -- on top of, not instead
 * of, the executor's own `inFlight` set (acceptance criterion 3): the
 * store-visible state covers a job issued by *another* process/instance
 * or a stale rows snapshot, `inFlight` covers same-instance re-entrancy
 * within one `tick()`/`requestOpen` call before that write has even
 * landed.
 */
import { DEFAULT_BACKOFF_CAP_MS, recordFailure, type ConnectedSession, type Connector, type LinkRow } from "./connector.js";
import { toBridgeRequest, type RelayBridger } from "./relayBridger.js";
import type { ReconcilerRows, Store, Transport } from "../store/index.js";

// ---------------------------------------------------------------------
// Job — what plan()/planUserOpen()/planUserClose() decide, and all the
// executor ever acts on.
// ---------------------------------------------------------------------

export type Job =
  | { readonly kind: "connect"; readonly linkId: string }
  | { readonly kind: "close"; readonly linkId: string; readonly reason: string }
  | {
      readonly kind: "switchRelayChild";
      readonly relayLinkId: string;
      /** `null` only if a future caller ever asks {@link planUserOpen}
       * to open a relay child with nothing currently occupying that
       * relay -- in practice that case returns a plain `"connect"` job
       * instead (see {@link planUserOpen}), so this is always
       * non-null in a job this module itself ever produces. Typed
       * nullable anyway so the executor's own switch handling does not
       * assume otherwise. */
      readonly closeLinkId: string | null;
      readonly openLinkId: string;
    };

/** Link preference order for {@link plan}'s automatic per-device pass —
 * architecture.md §8 rule 1, minus `radio`/`mbrelay` (see this module's
 * own doc comment, "Automatic connect is usb/wifi/mbserial only"). */
const AUTO_CONNECT_TRANSPORTS: readonly Transport[] = ["usb", "wifi", "mbserial"];

type ReconcilerLinkRow = ReconcilerRows["links"][number];
type ReconcilerDeviceRow = ReconcilerRows["devices"][number];

/** Whether `link` requires `devices.owned` (architecture.md §4: "The
 * projection hides any wifi/mbserial link whose device is not owned,
 * and the reconciler never connects to one" — rule 2 of this ticket's
 * own Description). */
function requiresOwned(transport: Transport): boolean {
  return transport === "wifi" || transport === "mbserial";
}

/** `link.address.relayLinkId` for a `radio`/`mbrelay` link, `null` for
 * every other transport or a malformed address (this module never
 * throws on a bad row -- an unparseable address just means "not part of
 * any relay switch", the connector's own `parseLinkAddress` is what
 * actually enforces the address shape at connect time). */
function relayLinkIdOf(link: ReconcilerLinkRow): string | null {
  if (link.transport !== "radio" && link.transport !== "mbrelay") {
    return null;
  }
  const rec = link.address;
  if (rec === null || typeof rec !== "object") {
    return null;
  }
  const relayLinkId = (rec as Record<string, unknown>).relayLinkId;
  return typeof relayLinkId === "string" ? relayLinkId : null;
}

/** True once a link is closed by an explicit user action and not yet
 * re-asked for (architecture.md §5: "closed_by_user (reconciler will
 * not reopen until asked)") — checked two ways (state and the flag) so
 * either one recorded by a caller is honored. */
function isClosedByUser(link: ReconcilerLinkRow): boolean {
  return link.state === "closed_by_user" || link.userClosed;
}

/** Rule 4: a `failed` link only gets a retry job at/after
 * `next_retry_at`; every other non-`connectable` state (`discovered`,
 * `connecting`, `connected`, `unresponsive`, `stale`, `closed_by_user`)
 * is never a fresh-connect candidate for {@link plan}'s automatic pass. */
function isAutoConnectEligible(link: ReconcilerLinkRow, device: ReconcilerDeviceRow | undefined, now: number): boolean {
  if (isClosedByUser(link)) {
    return false;
  }
  if (requiresOwned(link.transport) && !(device?.owned ?? false)) {
    return false;
  }
  if (link.state === "connectable") {
    return true;
  }
  if (link.state === "failed") {
    return now >= (link.nextRetryAt ?? 0);
  }
  return false;
}

/** Rule 1's "nothing for that device is connected" gate — true if any
 * of `links` is `connected`/`connecting`, or has a currently-open
 * `sessions` row (a session survives its link going `unresponsive`, so
 * this is the more durable of the two signals; checking both catches a
 * job this executor itself just dispatched, before its own
 * `state = 'connecting'` write has landed, same as any other reader of
 * a possibly-stale rows snapshot would see). */
function deviceHasActiveLink(links: readonly ReconcilerLinkRow[], openSessionLinkIds: ReadonlySet<string>): boolean {
  return links.some((link) => link.state === "connected" || link.state === "connecting" || openSessionLinkIds.has(link.id));
}

/**
 * The reconciler's pure decision function: given the current rows and
 * wall-clock `now`, which automatic connect jobs (if any) should run
 * right now. Same `(rows, now)` input always produces the same output —
 * no store or network access, no randomness, no hidden clock read.
 *
 * Implements architecture.md §8 rules 1-4 (this ticket's Description
 * items 1-4): preferred-link-per-device, the `owned` gate, never
 * reopening `closed_by_user`, and `failed` backoff. Rule 5 (relay child
 * switch) and rule 6 (a user-forwarded command's own precedence checks)
 * live in {@link planUserOpen}/{@link planUserClose} — see this
 * module's own doc comment for why.
 */
export function plan(rows: ReconcilerRows, now: number): Job[] {
  const jobs: Job[] = [];
  const openSessionLinkIds = new Set(rows.sessions.map((session) => session.linkId));

  const linksByDevice = new Map<number, ReconcilerLinkRow[]>();
  for (const link of rows.links) {
    if (link.deviceId === null) {
      continue;
    }
    const existing = linksByDevice.get(link.deviceId);
    if (existing) {
      existing.push(link);
    } else {
      linksByDevice.set(link.deviceId, [link]);
    }
  }

  for (const device of rows.devices) {
    // Ticket 016-001: once a device's kind is known to be `relay`, its own
    // usb link is never an automatic-pass candidate again -- architecture.md
    // §7.2 ("no auto-opened console session on a relay any more"). A
    // freshly-enumerated, not-yet-identified board is never `kind ===
    // 'relay'` yet either way (018-004: `watchers/usbWatcher.ts`'s
    // SWD-naming step now omits `kind` entirely rather than seeding a
    // provisional `'robot'` guess -- a chip id read cannot itself tell a
    // robot from a relay apart -- so a brand-new row instead gets the
    // store's own required-column default, still never `'relay'`), so
    // this guard never blocks that one-time first identify -- only every
    // *subsequent* automatic pass once `connect/connector.ts`'s own
    // identify has corrected `kind` to `'relay'` (or a device already
    // known as a relay from an earlier identify/mDNS discovery, whose
    // `kind` this guard now correctly keeps blocking forever, since
    // `usbWatcher.ts`'s own SWD reads can no longer clobber it back to
    // `'robot'` on a later USB replug -- the exact bug this ticket fixes).
    if (device.kind === "relay") {
      continue;
    }
    const links = linksByDevice.get(device.id) ?? [];
    if (deviceHasActiveLink(links, openSessionLinkIds)) {
      continue;
    }

    let preferred: ReconcilerLinkRow | undefined;
    for (const transport of AUTO_CONNECT_TRANSPORTS) {
      preferred = links.find((link) => link.transport === transport);
      if (preferred) {
        break;
      }
    }
    if (!preferred) {
      continue;
    }
    if (isAutoConnectEligible(preferred, device, now)) {
      jobs.push({ kind: "connect", linkId: preferred.id });
    }
  }

  return jobs;
}

/** The `session:<linkId>` owner convention `connect/connector.ts` itself
 * uses for `board_owner`/`relay_leases` (`const owner =
 * \`session:${link.id}\`;`). `null` for any other owner shape (`'sweep'`,
 * `'naming'`, …) — those never name a link this module would ever need
 * to close. */
function sessionOwnerLinkId(owner: string): string | null {
  const prefix = "session:";
  return owner.startsWith(prefix) ? owner.slice(prefix.length) : null;
}

/** The link (other than `excludeLinkId`) currently occupying the
 * physical relay named by `relayLinkId`, across its whole lifecycle —
 * see this module's own doc comment, "Finding a relay's current child
 * without relying on relay_leases alone". `null` if nothing currently
 * occupies it. */
function currentRelayChildLinkId(rows: ReconcilerRows, relayLinkId: string, excludeLinkId: string): string | null {
  const lease = rows.relayLeases.find((candidate) => candidate.relayLinkId === relayLinkId);
  const leaseChildId = lease ? sessionOwnerLinkId(lease.owner) : null;
  if (leaseChildId !== null && leaseChildId !== excludeLinkId) {
    return leaseChildId;
  }

  const openSessionLinkIds = new Set(rows.sessions.map((session) => session.linkId));
  const sibling = rows.links.find(
    (candidate) => candidate.id !== excludeLinkId && openSessionLinkIds.has(candidate.id) && relayLinkIdOf(candidate) === relayLinkId,
  );
  return sibling ? sibling.id : null;
}

/**
 * The user- (or ticket-001-connect-flow-)forwarded `session-open`
 * counterpart to {@link plan} — same ownership/precedence rules as an
 * automatic job (this ticket's Description: "a user cannot bypass
 * another student's open session on a link that isn't theirs to
 * close"), applied to one explicitly-named `linkId` rather than derived
 * from preference order. Pure: `(rows, linkId)` always produces the
 * same `Job[]`.
 *
 * Differences from {@link plan}'s automatic path, both deliberate:
 * - Every transport is eligible here, including `radio`/`mbrelay` — an
 *   explicit ask is exactly what architecture.md §5 means by "until
 *   asked" for a `closed_by_user` link, and exactly what makes radio
 *   bridging user-initiated rather than automatic (this module's own
 *   doc comment).
 * - `closed_by_user`/backoff are not checked: an explicit ask always
 *   overrides both — a user clicking "reconnect" is not required to
 *   wait out a `failed` link's own backoff window, and re-opening a
 *   `closed_by_user` link is precisely what asking again means.
 *
 * Returns at most one job: a plain `connect` if nothing currently
 * occupies the relay `linkId` would ride (or `linkId` is not a
 * radio/mbrelay link at all), or one `switchRelayChild` bundling the
 * old child's close with the new child's open — never two separately-
 * issued jobs (this ticket's Description item 5).
 */
export function planUserOpen(rows: ReconcilerRows, linkId: string): Job[] {
  const link = rows.links.find((candidate) => candidate.id === linkId);
  if (!link) {
    return [];
  }
  const openSessionLinkIds = new Set(rows.sessions.map((session) => session.linkId));
  if (link.state === "connecting" || openSessionLinkIds.has(link.id)) {
    return []; // already open or opening -- nothing to do
  }
  const device = link.deviceId !== null ? rows.devices.find((candidate) => candidate.id === link.deviceId) : undefined;
  if (requiresOwned(link.transport) && !(device?.owned ?? false)) {
    return [];
  }

  const relayLinkId = relayLinkIdOf(link);
  if (relayLinkId !== null) {
    const currentChildId = currentRelayChildLinkId(rows, relayLinkId, link.id);
    if (currentChildId !== null) {
      return [{ kind: "switchRelayChild", relayLinkId, closeLinkId: currentChildId, openLinkId: link.id }];
    }
  }
  return [{ kind: "connect", linkId: link.id }];
}

/**
 * Bench defect 4 (2026-09-12): a human-readable reason {@link
 * planUserOpen} produced no job for `linkId`, or `undefined` if it would
 * actually produce one. A user-initiated `session-open` that silently
 * does nothing is exactly the "I click the buttons and nothing happens"
 * bench complaint this narrates -- `startReconciler`'s own `requestOpen`
 * (below) surfaces this to `server.ts`, which turns it into a `notice`
 * broadcast the UI already knows how to render on the link's own
 * console log (`WsProvider.tsx`'s `appendNotice`).
 *
 * Deliberately a separate function, not a second return value woven
 * into {@link planUserOpen} itself: that function's own contract (pure,
 * `(rows, linkId) => Job[]`, unit-tested as a table of inputs/outputs
 * throughout this module's own suite) is untouched, so the two
 * functions can never disagree about *whether* a job was produced, only
 * -- when none was -- about *why not*. Narrates the same three branches
 * `planUserOpen` itself refuses on; a link that already has a job
 * coming (a switch, or a plain connect) is not "refused" at all, so
 * this only ever returns a reason for the branches that return `[]`.
 */
export function describeUserOpenRefusal(rows: ReconcilerRows, linkId: string): string | undefined {
  const link = rows.links.find((candidate) => candidate.id === linkId);
  if (!link) {
    return `no such link "${linkId}"`;
  }
  if (link.state === "connecting") {
    return "already connecting";
  }
  const openSessionLinkIds = new Set(rows.sessions.map((session) => session.linkId));
  if (openSessionLinkIds.has(link.id)) {
    return "already open";
  }
  const device = link.deviceId !== null ? rows.devices.find((candidate) => candidate.id === link.deviceId) : undefined;
  if (requiresOwned(link.transport) && !(device?.owned ?? false)) {
    return "this device is not owned yet -- claim it first";
  }
  return undefined;
}

/**
 * The user-forwarded `session-close` counterpart to {@link plan}. Pure:
 * returns a `close` job only if `linkId` is actually open (a session
 * row) or opening (`state = 'connecting'`) — closing a link that is
 * neither is a no-op, not an error, so this returns `[]` rather than
 * throwing.
 */
export function planUserClose(rows: ReconcilerRows, linkId: string): Job[] {
  const link = rows.links.find((candidate) => candidate.id === linkId);
  if (!link) {
    return [];
  }
  const openSessionLinkIds = new Set(rows.sessions.map((session) => session.linkId));
  if (link.state !== "connecting" && !openSessionLinkIds.has(link.id)) {
    return [];
  }
  return [{ kind: "close", linkId, reason: "user-requested" }];
}

// ---------------------------------------------------------------------
// The executor
// ---------------------------------------------------------------------

/** Matches every other long-lived task's own tick in this codebase
 * (`watchers/usbWatcher.ts`, `watchers/mdnsWatcher.ts`) — a slow safety-
 * net poll on top of the change-feed-driven pass, per this ticket's own
 * Description ("runs on every store change-feed event and a slow (5 s)
 * tick"). */
const DEFAULT_TICK_INTERVAL_MS = 5000;

export interface ReconcilerDeps {
  /** Ticket 001's connector — the only thing the executor ever calls to
   * actually open a link, for every transport except a radio/mbrelay
   * child when {@link bridger} is supplied (see that field's own doc
   * comment). */
  connector: Connector;
  /** Ticket 016-002's relay bridger. When supplied, a `connect`/
   * `switchRelayChild` job whose link is `radio`/`mbrelay`-transport is
   * dispatched through `bridger.bridge()` instead of
   * `connector.connectAndIdentify()` — the reset-before-every-candidate
   * fix for the Linux failover bug (sprint.md's own Design Rationale:
   * "relayBridger.ts is a new sibling module to connector.ts"). Optional
   * and falls back to `connector` when omitted, so every existing test
   * that only ever supplies `connector` (this module's own suite,
   * exercising `connector.ts`'s still-unchanged single-candidate
   * radio/mbrelay path directly) keeps working unmodified; production
   * wiring (`runtime.ts`) always supplies a real one. */
  bridger?: RelayBridger;
  /** Wall-clock reader passed to every {@link plan}/backoff check.
   * Defaults to `Date.now`. */
  now?: () => number;
  /** Overrides {@link DEFAULT_TICK_INTERVAL_MS} — tests only. */
  tickIntervalMs?: number;
  /** Cap on the exponential backoff {@link recordFailure} computes when
   * this executor's own dead-transport reaping (bench defect 010
   * addendum, "dead transport leaves session, blocks reconnect") records
   * a failure -- same knob as `connect/connector.ts`'s own
   * `ConnectorOptions.backoffCapMs`. Defaults to
   * {@link DEFAULT_BACKOFF_CAP_MS}. */
  backoffCapMs?: number;
}

/** Read-only view of the executor's own currently-open sessions — the
 * narrow seam ticket 005's server uses to reach "the open session's
 * link" for a given `linkId` (`send-command`, raw `line`, `provision-
 * wifi`, and flash's own teardown-before-write step), rather than
 * reaching into the executor's private `sessions` map directly. Only
 * ever reflects sessions *this* executor instance itself opened (see
 * {@link startReconciler}'s own `sessions` doc comment) — a session
 * opened by another process/instance is not reachable through this. */
export interface ReconcilerSessions {
  get(linkId: string): ConnectedSession | undefined;
  /** Every currently-open session this executor holds, for a caller
   * (`server.ts`) that needs to notice a session it has not seen before
   * -- e.g. to wire a fresh per-session subscription exactly once. */
  values(): IterableIterator<ConnectedSession>;
}

export interface Reconciler {
  /** The narrow entry point the server (ticket 005) forwards an
   * explicit user `session-open` command to (or ticket 001's own
   * connect flow, per this module's doc comment) — same precedence
   * rules as an automatic job, see {@link planUserOpen}. Resolves once
   * every job it dispatched has settled (never rejects).
   *
   * Bench defect 4 (2026-09-12): the resolved value's `refusedReason`
   * is set (via {@link describeUserOpenRefusal}) exactly when this call
   * produced no job at all — `server.ts`'s own `session-open` handler
   * turns a set `refusedReason` into a `notice` broadcast, so a refused
   * open is never silent to the student at the console. Absent when a
   * job was actually dispatched (successfully or not — a dispatched
   * job's own failure already surfaces via `links.state = 'failed'`
   * and the snapshot it produces, not this return value). */
  requestOpen(linkId: string): Promise<{ refusedReason?: string }>;
  /** The `session-close` counterpart — see {@link planUserClose}. */
  requestClose(linkId: string): Promise<void>;
  /** See {@link ReconcilerSessions}. */
  readonly sessions: ReconcilerSessions;
  /** Stops the change-feed subscription and the slow tick. Does not
   * close any already-open session -- mirrors every watcher's own
   * `stop()` contract (`watchers/usbWatcher.ts`), which likewise leaves
   * already-open links alone. */
  stop(): void;
}

/** Builds the `LinkRow` shape `connector.ts`'s `connectAndIdentify`
 * expects out of a {@link ReconcilerRows} link — same fields, different
 * (typed, camelCase) source. */
function toConnectorLinkRow(link: ReconcilerRows["links"][number]): LinkRow {
  // `deviceId` threaded through (item E, team-lead 2026-09-13) so
  // `connector.ts`'s host-identity cross-check can compare a banner's
  // own serial against the deviceId a `usb` link's row already carries
  // from SWD naming -- see `LinkRow.deviceId`'s own doc comment.
  return { id: link.id, transport: link.transport, address: link.address, deviceId: link.deviceId };
}

/**
 * Builds the thin executor described in this module's own doc comment:
 * subscribes to `store.onChange`, runs an unref'd {@link
 * DEFAULT_TICK_INTERVAL_MS} tick, and turns every `Job` {@link plan}/
 * {@link planUserOpen}/{@link planUserClose} produce into exactly one
 * `connector.connectAndIdentify`/link-close call — see
 * {@link Reconciler} for the entry points this returns.
 */
export function startReconciler(store: Store, deps: ReconcilerDeps): Reconciler {
  const now = deps.now ?? (() => Date.now());
  const tickIntervalMs = deps.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS;
  const backoffCapMs = deps.backoffCapMs ?? DEFAULT_BACKOFF_CAP_MS;

  /** linkIds with a connect attempt currently in flight -- acceptance
   * criterion 3: "never re-issues a job already in flight for the same
   * link", on top of (not instead of) the store's own `'connecting'`
   * state (see this module's doc comment). */
  const inFlight = new Set<string>();
  /** Established sessions this executor itself opened, so a later
   * `close`/`switchRelayChild` job has something to call `.close()` on.
   * Only this executor's own `runConnect` ever populates or clears
   * this -- a session opened by some other process is not something
   * this instance can close directly (it can still ask the store to
   * mark it `closed_by_user`, which is all `runClose` does when it
   * finds no local session). */
  const sessions = new Map<string, ConnectedSession>();
  let stopped = false;

  /** Ticket 016-001: the one place a relay's one-time identify returns to
   * idle -- see this module's own doc comment on why the executor (not
   * `connect/connector.ts`) owns this step: `connector.ts`'s
   * `connectAndIdentify` contract stays "identify, open a session, mark
   * connected" for every transport alike (unchanged, still covered by
   * `connector.test.ts`'s own relay-identify case); it is this executor's
   * `runConnect` that notices the resolved session's own
   * `classification.type === 'relay'` and immediately closes what
   * `connector.ts` just opened, leaving no `sessions` row and the link
   * back in `connectable` rather than `connected`. `relay_leases` is
   * never involved here (a relay's *own* usb link uses `board_owner`
   * exclusivity, already released by `connector.ts`'s own `finally`
   * before this ever runs) -- only a `radio`/`mbrelay` *child* link
   * touches `relay_leases`, untouched by this ticket. The link state
   * this settles on is `connectable` (with a reason), not a new state
   * name -- architecture.md §5's machine already treats `connectable` as
   * "idle, eligible" and this ticket's own `device.kind === 'relay'`
   * guard above is what keeps `plan()` from ever treating that
   * `connectable` relay link as an automatic-connect candidate again, so
   * no new state was needed to satisfy "never re-identified over a
   * data-plane port" (Step 7 open question 2). */
  async function returnRelayToIdle(session: ConnectedSession): Promise<void> {
    await session.link.close();
    store.closeSession(session.linkId);
    store.setLinkState({ id: session.linkId, state: "connectable", at: now(), reason: "relay-identified-idle" });
  }

  /** Ticket 016-002: a radio/mbrelay child link's connect goes through
   * the relay bridger (reset before every candidate) when one is
   * supplied — see {@link ReconcilerDeps.bridger}'s own doc comment. */
  function connectLink(link: LinkRow, signal: AbortSignal): Promise<ConnectedSession> {
    if (deps.bridger && (link.transport === "radio" || link.transport === "mbrelay")) {
      // toBridgeRequest() parses `link.address` synchronously and can
      // throw on a malformed row -- caught and converted to a rejection
      // so this is never an uncaught synchronous throw out of
      // runConnect(), matching connector.connectAndIdentify()'s own
      // "always a rejection, never a throw" contract.
      try {
        return deps.bridger.bridge(toBridgeRequest(link), signal);
      } catch (error) {
        return Promise.reject(error);
      }
    }
    return deps.connector.connectAndIdentify(link, signal);
  }

  /**
   * Bench defect 010 addendum (2026-09-13, "dead transport leaves
   * session, blocks reconnect"): the reconciler is the single owner of
   * session teardown (this module's own doc comment) -- reached here via
   * one `LineLink.onClose` subscription taken the moment `runConnect`
   * starts tracking a session, so *every* way a live link can die (a
   * genuine transport close, or `harvester.ts`'s own missed-poll `fail()`
   * now also closing the link -- see that function's own doc comment)
   * converges on this one cleanup: drop the local reference, close the
   * store's `sessions` row, close the `LineLink` itself (idempotent --
   * already closed in every real case this fires from, but this module
   * makes no assumption about that), and record a `failed` state with
   * backoff fields so {@link plan}'s `isAutoConnectEligible` has
   * something to retry (architecture.md §5's own state diagram draws
   * exactly this edge, `unresponsive --> failed`; `unresponsive` alone is
   * never auto-connect-eligible, which is what let this defect linger
   * forever once a watcher's own later `connectable` write raced past a
   * still-open `sessions` row).
   *
   * `sessions.get(linkId) !== session` guards against a session this
   * call no longer owns: `runClose`/`runSwitch` (or a fresh `runConnect`
   * replacing this same linkId) may have already deleted or replaced the
   * map entry before this listener ever fires -- reacting anyway would
   * double-close or reap the wrong session.
   */
  function reapDeadSession(linkId: string, session: ConnectedSession, reason: Error | undefined): void {
    if (sessions.get(linkId) !== session) {
      return;
    }
    sessions.delete(linkId);
    try {
      store.closeSession(linkId);
      void session.link.close();
      recordFailure(store, linkId, reason ? reason.message : "transport closed", now(), backoffCapMs);
    } catch {
      // Best-effort past this point: a lingering `LineLink`'s own
      // `onClose` can fire well after `stop()` was called (which
      // deliberately leaves an already-open session alone -- this
      // module's own doc comment) and the owning store closed out from
      // under it (process shutdown; a test's own teardown order --
      // confirmed live in `mbserialEndToEnd.test.ts`, where destroying
      // the fake robot's socket races the harness's own `store.close()`
      // a few lines later). Nothing further to reconcile once the store
      // itself is gone; this must never become an uncaught exception
      // thrown out of a raw socket "close" event handler.
    }
  }

  function runConnect(linkId: string): Promise<void> {
    if (inFlight.has(linkId)) {
      return Promise.resolve();
    }
    const raw = store.reconcilerRows().links.find((candidate) => candidate.id === linkId);
    if (!raw) {
      return Promise.resolve();
    }
    inFlight.add(linkId);
    store.setLinkState({ id: linkId, state: "connecting", at: now() });
    const controller = new AbortController();
    return connectLink(toConnectorLinkRow(raw), controller.signal)
      .then(
        (session) => {
          if (session.classification.type === "relay") {
            return returnRelayToIdle(session);
          }
          sessions.set(linkId, session);
          session.link.onClose((reason) => reapDeadSession(linkId, session, reason));
          return undefined;
        },
        () => {
          // The connector already records `links.state = 'failed'` with
          // backoff fields on any failure -- nothing further to do here,
          // and this must never become an unhandled rejection.
        },
      )
      .finally(() => {
        inFlight.delete(linkId);
      });
  }

  async function runClose(linkId: string, reason: string): Promise<void> {
    const session = sessions.get(linkId);
    sessions.delete(linkId);
    if (session) {
      await session.link.close();
    }
    // `sessions` holds one row per currently-*open* link (store/index.ts's
    // own doc comment) -- a close always removes it, whether or not this
    // executor instance itself held the `ConnectedSession` above (e.g. a
    // link opened by an earlier process run).
    store.closeSession(linkId);
    store.setLinkState({ id: linkId, state: "closed_by_user", at: now(), reason, userClosed: true });
  }

  /** Rule 5: one job, close-then-open, never two separately-issued jobs
   * -- `runClose` is awaited before `runConnect` starts so the old
   * child's physical port is actually released first (its own
   * `board_owner`/`relay_leases` exclusivity is already gone by the
   * time it is `connected` -- see this module's doc comment -- so the
   * real reason to wait is the underlying transport, not the DB row). */
  async function runSwitch(job: Extract<Job, { kind: "switchRelayChild" }>): Promise<void> {
    if (job.closeLinkId) {
      await runClose(job.closeLinkId, "relay-switch");
    }
    await runConnect(job.openLinkId);
  }

  function dispatch(job: Job): Promise<void> {
    switch (job.kind) {
      case "connect":
        return runConnect(job.linkId);
      case "close":
        return runClose(job.linkId, job.reason);
      case "switchRelayChild":
        return runSwitch(job);
      default: {
        const exhaustive: never = job;
        return Promise.reject(new Error(`reconciler: unrecognized job kind "${String(exhaustive)}"`));
      }
    }
  }

  function tick(): void {
    if (stopped) {
      return;
    }
    const rows = store.reconcilerRows();
    for (const job of plan(rows, now())) {
      void dispatch(job);
    }
  }

  /** Ticket 017-010 bench defect 5 ("send-command finds reconciler-
   * opened sessions"): a `sessions` row is durable proof of an open link
   * only *within* one executor's own lifetime — {@link
   * deviceHasActiveLink}'s own doc comment already says as much ("a
   * session survives its link going unresponsive", the more durable of
   * the two signals it checks). It is not proof across a process
   * restart: no `ConnectedSession`/`LineLink` can be reconstituted from
   * the database, so this executor's own {@link sessions} Map is always
   * empty right here — before the first {@link tick} — while
   * `console.sqlite`'s `sessions` table can still carry rows an *earlier*
   * process opened and never explicitly closed (killed, or crashed).
   *
   * Left alone, that mismatch is exactly the 2026-09-12 bench defect:
   * `mbserial-vevov` sat `unresponsive` (the harvester's missed-poll
   * watchdog writes `links.state` only — see `harvester.ts`'s own `fail`
   * — it does not, and should not, touch `sessions`, since a session
   * surviving `unresponsive` *within* a live process is exactly the
   * point) with its old `sessions` row still in place from the process
   * before this one. `plan`'s "device already has an active link" gate
   * and `planUserOpen`'s "already open" refusal both read that row and
   * treat the device as connected forever, refusing every future
   * auto-reconnect and every explicit user Connect — while `server.ts`'s
   * `requireSession` (reading *this* executor's own empty {@link
   * sessions} Map, correctly) threw `link "mbserial-vevov" has no open
   * session` on every `send-command`/`line`/`provision-wifi`. The UI
   * panels that gate on `link.session !== undefined`
   * (`CommandStrip.tsx`, `DeviceConsole.tsx`) kept showing the link as
   * usable — including its last-known, now-frozen `STATUS` reply — since
   * that field only reflects the row's mere presence, never which
   * process actually holds the connection; this is also why the "no open
   * session" notice repeated on every click, not once — nothing ever
   * told the UI to stop trying.
   *
   * Run once, here, before the first {@link tick}: every `sessions` row
   * inherited from before this executor started (all of them, at this
   * point — {@link sessions} cannot yet hold anything of its own) is
   * closed, and its link returned to `connectable` — not
   * `closed_by_user`, since nothing here is a user's own request to stop
   * — so the very next `tick()` picks it back up as an ordinary
   * auto-connect candidate, exactly as if it had never connected before
   * this process started. This is what makes `sessions` one registry
   * again: present in the store if and only if present in *this*
   * executor's own Map, from boot onward — every later mutation
   * (`runConnect`/`runClose`) already keeps the two in lockstep, so nothing
   * but this startup gap needed closing.
   *
   * (Two processes deliberately sharing one state dir at the same time
   * is not a configuration this project supports — architecture.md's own
   * "one host owns the store" — so this does not attempt to distinguish
   * "stale, left by a dead process" from "some other live process's own
   * session" any further than that.) */
  function clearInheritedSessions(): void {
    for (const session of store.reconcilerRows().sessions) {
      store.closeSession(session.linkId);
      store.setLinkState({
        id: session.linkId,
        state: "connectable",
        at: now(),
        reason: "stale-session-cleared-at-startup",
      });
    }
  }

  /**
   * Bench defect 010 addendum, fix item 2: `describeUserOpenRefusal`
   * must not say "already open" when the stored link state is not
   * actually `connected` (or `connecting`, already mid-attempt) --
   * {@link clearInheritedSessions} above only ever runs once, at
   * construction, for a session inherited from a *previous* process;
   * this is its runtime counterpart, run on every {@link requestOpen}
   * call, for a session left behind *during* this process's own
   * lifetime by a dead transport `reapDeadSession` has not yet reached
   * (or a watcher's own `removed` handling closing the store's row
   * directly -- see `watchers/usbWatcher.ts`'s own doc comment) while
   * this executor's local {@link sessions} map still holds a reference.
   *
   * `planUserOpen`/`describeUserOpenRefusal` stay pure (this module's own
   * doc comment: no store or network access) -- this executor clears the
   * stale row *before* ever calling either, so by the time they run, the
   * row already reflects "nothing open here", and a user's Connect is
   * never refused for a link that is not actually connected. */
  function clearStaleSession(rows: ReconcilerRows, linkId: string): ReconcilerRows {
    const link = rows.links.find((candidate) => candidate.id === linkId);
    if (!link || link.state === "connected" || link.state === "connecting") {
      return rows;
    }
    const hasSession = rows.sessions.some((candidate) => candidate.linkId === linkId);
    if (!hasSession) {
      return rows;
    }
    const local = sessions.get(linkId);
    if (local) {
      sessions.delete(linkId);
      void local.link.close();
    }
    store.closeSession(linkId);
    return store.reconcilerRows();
  }

  clearInheritedSessions();
  const unsubscribe = store.onChange(() => tick());
  const timer: ReturnType<typeof setInterval> = setInterval(tick, tickIntervalMs);
  timer.unref?.();
  tick();

  return {
    async requestOpen(linkId: string): Promise<{ refusedReason?: string }> {
      const rows = clearStaleSession(store.reconcilerRows(), linkId);
      const jobs = planUserOpen(rows, linkId);
      if (jobs.length === 0) {
        const refusedReason = describeUserOpenRefusal(rows, linkId);
        return refusedReason !== undefined ? { refusedReason } : {};
      }
      for (const job of jobs) {
        await dispatch(job);
      }
      return {};
    },
    async requestClose(linkId: string): Promise<void> {
      const rows = store.reconcilerRows();
      for (const job of planUserClose(rows, linkId)) {
        await dispatch(job);
      }
    },
    sessions: {
      get(linkId: string): ConnectedSession | undefined {
        return sessions.get(linkId);
      },
      values(): IterableIterator<ConnectedSession> {
        return sessions.values();
      },
    },
    stop(): void {
      if (stopped) {
        return;
      }
      stopped = true;
      unsubscribe();
      clearInterval(timer);
    },
  };
}
