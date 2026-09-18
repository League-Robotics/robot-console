/**
 * connect/sessionOps.ts — the WS-independent core of `session-open`/
 * `session-close`/`send-command` (sprint 019 ticket 005; SUC-005;
 * `sprint.md`'s "Impact on Existing Components": "`server.ts`'s
 * `session-open`/`session-close`/`send-command`/`flash-start` handler
 * bodies must be extracted into standalone, WS-independent functions
 * ... before `mcp/tools/connect.ts` ... can call them").
 *
 * `server.ts`'s three WS handlers and `mcp/tools/connect.ts`'s three MCP
 * tools both call exactly the functions below -- neither ever
 * reimplements "open a session" / "close a session" / "send a command"
 * a second way. This is what the architecture calls "exactly one
 * implementation of each operation, not two that can drift" (`sprint.md`
 * Step 5).
 *
 * ## What moved here from `server.ts`, and why
 *
 * The `session-open {relayLinkId, name}` bridge-address resolution
 * (`parseChannelGroupAddress`/`parseRegistryLocation`/
 * `resolveRegistryLocationForRelay`/`resolveFleetRegistryLocation`/
 * `resolveBridgeAddress`) moved here verbatim alongside {@link
 * openSession} -- they were only ever used by that one handler, and
 * `mcp/tools/connect.ts`'s `open_session` tool needs the exact same
 * resolution, not a second copy. `usbSerialFromLinkId`/
 * `isValidRadioOverride` stayed in `server.ts`/`radioOverride.ts`
 * respectively -- both are still used by other handlers there
 * (`flash-start`, `radio-override`) that this ticket does not touch.
 *
 * ## Caller identity (SUC-005)
 *
 * {@link openSession} takes an optional {@link SessionIdentity},
 * defaulting to {@link UI_SESSION_IDENTITY}. `server.ts`'s WS handler
 * never passes one (every browser-opened session stays `'ui'`/`null`,
 * unchanged from before this ticket); `mcp/tools/connect.ts`'s
 * `open_session` passes `{origin: "mcp", caller: <clientInfo.name>}`.
 * The identity write ({@link Store.setSessionIdentity}) only fires when
 * `reconciler.requestOpen` actually dispatched a job for this call (no
 * `refusedReason`) -- a *refused* open (e.g. the link is already
 * connected, held by someone else) must never overwrite that someone
 * else's own identity on the session it did not open. `Store
 * .setSessionIdentity` is itself a conditional-change no-op when nothing
 * about the row's identity actually changes (or no row exists at all,
 * e.g. the dispatched job failed to connect) -- see that method's own
 * doc comment -- so the ordinary browser path queues no extra
 * change-feed event / snapshot broadcast beyond what `Store.openSession`
 * itself already queues. This keeps the WS-level behavior byte-for-byte
 * identical to before this ticket (this ticket's own acceptance
 * criterion: "the existing WS-level test suite ... passes unchanged").
 *
 * {@link openSession}'s own return value is deliberately as narrow as
 * `Reconciler.requestOpen`'s (`{linkId, refusedReason?}`) -- exactly
 * what `server.ts`'s WS handler already knew how to turn into a `notice`
 * broadcast before this ticket, so wrapping it changes nothing about
 * that path. A dispatched-but-failed-to-connect job (contention on a
 * shared board/relay, a farm robot's one TCP slot already taken, ...)
 * produces no `refusedReason` here either -- exactly as it did not
 * before this extraction -- since that failure surfaces asynchronously
 * via `links.state`/`stateReason`, not this call's own return value.
 * `mcp/tools/connect.ts`'s `open_session` tool -- which has no later
 * snapshot to read and needs a synchronous, plain-language answer -- is
 * where that extra "did it actually connect" check lives (reading
 * `store.reconcilerRows().sessions`/`store.projectionRows().links` after
 * calling this function), not here; see that module's own doc comment.
 */
import { isSequencedVerb, type WireField } from "@robot-console/protocol";
import type { ConnectedSession } from "./connector.js";
import type { Reconciler, ReconcilerSessions } from "./reconciler.js";
import { resolveDeviceRadio, type DeviceRadioOverride } from "../radioOverride.js";
import { resolveRobotAddress, type RegistryLocation } from "../mbrelayRegistry.js";
import { UI_SESSION_IDENTITY, type ProjectionLinkRow, type SessionIdentity, type Store } from "../store/index.js";

/** The narrow slice of {@link Store} `openSession`/`closeSession` need --
 * mirrors `mcp/tools/inspect.ts`'s `InspectStore` narrowing convention,
 * widened just enough for the one write ({@link Store.setSessionIdentity})
 * and the reads the relay-bridge resolution needs. `sendCommand`/
 * `requireSession` below need no store access at all (everything they
 * touch reaches the link through an already-resolved {@link
 * ConnectedSession}). */
export type SessionOpsStore = Pick<Store, "projectionRows" | "upsertLink" | "setSessionIdentity">;

/** The narrow slice of {@link Reconciler} `openSession`/`closeSession`
 * need. */
export interface SessionOpsReconciler {
  requestOpen(linkId: string): Promise<{ refusedReason?: string }>;
  requestClose(linkId: string): Promise<void>;
}

export interface SessionOpsDeps {
  readonly store: SessionOpsStore;
  readonly reconciler: SessionOpsReconciler;
}

/** `open_session`'s two accepted shapes -- a direct link, or a named
 * robot bridged over a relay. Mirrors the WS `session-open` message's
 * own two variants (`wsMessages.ts`) exactly, since both this function
 * and that message ultimately mean the same request. */
export type OpenSessionParams = { readonly linkId: string } | { readonly relayLinkId: string; readonly name: string };

export interface OpenSessionResult {
  /** The link a session was (or would have been) opened on -- for
   * `{relayLinkId, name}`, the derived radio child link id, so a caller
   * that only had the robot's name now has the link id every other read
   * (`reconcilerRows`/`projectionRows`) keys on. */
  readonly linkId: string;
  /** Set exactly when {@link Reconciler.requestOpen} produced no job at
   * all (already open, not owned, unknown link, ...) -- see that
   * method's own doc comment. Absent otherwise, whether or not the
   * dispatched job itself went on to connect successfully. */
  readonly refusedReason?: string;
}

/** Parses just the `{channel, group}` fields off an already-JSON-parsed
 * `ProjectionLinkRow.address` -- used to detect whether a `links(radio)`
 * row for this exact (name, relay) pair already carries a resolved
 * (sighted) address, rather than re-deriving a fresh one. Never throws
 * on a malformed/missing shape. */
function parseChannelGroupAddress(address: unknown): { channel: number; group: number } | undefined {
  if (typeof address !== "object" || address === null) {
    return undefined;
  }
  const rec = address as Record<string, unknown>;
  return typeof rec.channel === "number" && typeof rec.group === "number" ? { channel: rec.channel, group: rec.group } : undefined;
}

/** Parses `{host, registryPort}` off an already-JSON-parsed mbrelay
 * `ProjectionLinkRow.address` -- the location `resolveDeviceRadio`'s own
 * `registry` option needs to reach mbrelay's name registry over HTTP.
 * Only an `_mbrelay._tcp` pool's own link row ever carries a
 * `registryPort` -- a local `usb` relay's address never does. Never
 * throws. */
function parseRegistryLocation(address: unknown): RegistryLocation | undefined {
  if (typeof address !== "object" || address === null) {
    return undefined;
  }
  const rec = address as Record<string, unknown>;
  return typeof rec.host === "string" && typeof rec.registryPort === "number" ? { host: rec.host, port: rec.registryPort } : undefined;
}

/** The registry location for `relayLinkId`'s own mbrelay pool, if any --
 * looked up fresh from the store on every bridge attempt rather than
 * cached, since a discovered pool's `registryPort` can change. */
function resolveRegistryLocationForRelay(store: SessionOpsStore, relayLinkId: string): RegistryLocation | undefined {
  const relayLink = store.projectionRows().links.find((candidate) => candidate.id === relayLinkId);
  return relayLink ? parseRegistryLocation(relayLink.address) : undefined;
}

/** Any discovered mbrelay pool's registry location, preferring a pool
 * whose own link is not stale. The fleet shares one name registry, so a
 * USB radio bridge -- which has no registry of its own -- asks the same
 * one a pool would. `undefined` when no pool has ever been discovered. */
function resolveFleetRegistryLocation(store: SessionOpsStore): RegistryLocation | undefined {
  const pools = store.projectionRows().links.filter((link) => link.transport === "mbrelay");
  const ordered = [...pools.filter((link) => link.state !== "stale"), ...pools.filter((link) => link.state === "stale")];
  for (const pool of ordered) {
    const location = parseRegistryLocation(pool.address);
    if (location !== undefined) {
      return location;
    }
  }
  return undefined;
}

/**
 * The radio address a `{relayLinkId, name}` bridge dials, in this order:
 * the device's stored override; mbrelay's name registry, whenever one
 * answers; the address already on this (robot, bridge) pair's own link
 * row; the name-derived default. See `sprint.md`'s own Design
 * Rationale / bench-defect history for why this order (a registry
 * answer outranks a possibly-stale sighted row).
 */
async function resolveBridgeAddress(
  name: string,
  override: DeviceRadioOverride,
  rowAddress: { channel: number; group: number } | undefined,
  registry: RegistryLocation | undefined,
): Promise<{ channel: number; group: number }> {
  if (override.radioSource === "override" && override.radioChannel !== null && override.radioGroup !== null) {
    return { channel: override.radioChannel, group: override.radioGroup };
  }
  if (registry !== undefined) {
    const resolved = await resolveRobotAddress(name, registry);
    if (resolved.outcome !== "local-derived") {
      return { channel: resolved.channel, group: resolved.group };
    }
  }
  return rowAddress ?? (await resolveDeviceRadio(name, override));
}

/** Resolves `{relayLinkId, name}` to a concrete child `links` row (radio
 * address included), upserting that row if needed, and returns the
 * child's own link id -- the id every subsequent `requestOpen`/session
 * read keys on. Split out of {@link openSession} only for readability;
 * has no meaning as its own operation. */
async function resolveRelayChildLinkId(store: SessionOpsStore, relayLinkId: string, name: string): Promise<string> {
  // Found by name, not by recomputing a numeric device id from it:
  // `devices.id` is the chip's own `FICR.DEVICEID[1]`, and many
  // different ids can decode to the same five-letter name -- see
  // `wsMessages.ts`'s own doc comment.
  const existingDevice = store.projectionRows().devices.find((candidate) => candidate.name === name);
  const override: DeviceRadioOverride = existingDevice
    ? { radioChannel: existingDevice.radioChannel, radioGroup: existingDevice.radioGroup, radioSource: existingDevice.radioSource }
    : { radioChannel: null, radioGroup: null, radioSource: null };
  const childLinkId = `radio-${name}-via-${relayLinkId}`;
  // If this exact (name, relay) pair's own `links` row already exists,
  // its own `address` is the channel/group already confirmed reachable
  // -- reuse it rather than re-deriving a fresh one (sprint 016 ticket
  // 004, SUC-004).
  const existingLink = store.projectionRows().links.find((candidate) => candidate.id === childLinkId);
  const sightedAddress = existingLink ? parseChannelGroupAddress(existingLink.address) : undefined;
  const registry = resolveRegistryLocationForRelay(store, relayLinkId) ?? resolveFleetRegistryLocation(store);
  const { channel, group } = await resolveBridgeAddress(name, override, sightedAddress, registry);
  // The named robot's own device row, when known, owns the child link
  // from the first attempt -- so a failed bridge shows on that robot's
  // card instead of on a link no card lists.
  store.upsertLink({
    id: childLinkId,
    transport: "radio",
    address: { relayLinkId, channel, group },
    ...(existingDevice ? { deviceId: existingDevice.id } : {}),
    at: Date.now(),
  });
  return childLinkId;
}

/**
 * Opens a session for `params` through the same reconciler/connector
 * path a browser's `session-open` has always used -- see the module doc
 * comment. `identity` defaults to {@link UI_SESSION_IDENTITY}; an MCP
 * caller passes `{origin: "mcp", caller: <name>}`.
 */
export async function openSession(deps: SessionOpsDeps, params: OpenSessionParams, identity: SessionIdentity = UI_SESSION_IDENTITY): Promise<OpenSessionResult> {
  const linkId = "linkId" in params ? params.linkId : await resolveRelayChildLinkId(deps.store, params.relayLinkId, params.name);
  const { refusedReason } = await deps.reconciler.requestOpen(linkId);
  if (refusedReason === undefined) {
    // Only when this call itself actually dispatched a job -- never
    // overwrite an existing session's identity just because someone else
    // already holds it (module doc comment's "Caller identity" section).
    deps.store.setSessionIdentity(linkId, identity);
    return { linkId };
  }
  return { linkId, refusedReason };
}

/** Closes the session on `linkId` through the same reconciler path a
 * browser's `session-close` has always used. */
export async function closeSession(deps: Pick<SessionOpsDeps, "reconciler">, linkId: string): Promise<void> {
  await deps.reconciler.requestClose(linkId);
}

/** The link a `links.stateReason` value would explain, for a caller
 * (`mcp/tools/connect.ts`) that wants a plain-language reason a
 * dispatched-but-unopened session failed to connect. Returns `undefined`
 * when the link is not currently known at all. */
export function findLinkStateReason(store: SessionOpsStore, linkId: string): string | undefined {
  const link: ProjectionLinkRow | undefined = store.projectionRows().links.find((candidate) => candidate.id === linkId);
  return link?.stateReason ?? undefined;
}

/** The narrow slice of {@link Reconciler.sessions} {@link
 * requireSession}/`send-command` need. */
export type SessionOpsSessions = Pick<ReconcilerSessions, "get">;

/** Looks up `linkId`'s open session, throwing the same plain error
 * `server.ts`'s WS `send-command`/`line`/`provision-wifi` handlers have
 * always thrown for one that is not open. */
export function requireSession(sessions: SessionOpsSessions, linkId: string): ConnectedSession {
  const session = sessions.get(linkId);
  if (!session) {
    throw new Error(`link "${linkId}" has no open session`);
  }
  return session;
}

/**
 * Sends `verb`/`fields` on `session`'s own link -- the same sequenced-vs-
 * unsequenced dispatch `server.ts`'s WS `send-command` handler has always
 * used, WS-independent (returns the raw line actually transmitted rather
 * than broadcasting it itself; `server.ts`'s own wrapper still does that,
 * and still does its own `noteStudentStatus` bookkeeping -- both are
 * server-local, WS-console concerns this function has no reason to know
 * about). Throws for `HELLO`, which has no disciplined resync path on
 * this seam (see `server.ts`'s own historical doc comment on this
 * check).
 */
export function sendCommand(session: ConnectedSession, verb: string, fields: readonly WireField[] = []): string {
  if (verb.toUpperCase() === "HELLO") {
    throw new Error('"HELLO" cannot be sent via send-command -- close and reopen the link instead');
  }
  return isSequencedVerb(verb) ? session.link.sendCommand(verb, fields) : session.link.sendUnsequencedQuery(verb, fields);
}
