/**
 * projection.ts — `buildSnapshot`, the pure read that turns store rows
 * into the one `Snapshot` the wire contract sends (sprint 015 ticket
 * 004; issue `rearch-06-snapshot-wire-contract-and-thin-server.md`;
 * `docs/design/architecture.md` §9, "Wire contract"; sprint.md's own
 * module table: "Inside: `buildSnapshot(store)`, the owned-gate hiding
 * rule, `unassigned` grouping, per-link `capabilities`,
 * `relays[].lease`/`bridging`. Outside: persistence (store), transport
 * (server)."). No I/O beyond reading the store, no wall-clock read, no
 * broadcast-sequence bookkeeping of its own — `seq`/`at` are supplied by
 * the caller ({@link buildSnapshot}'s own parameters; `server.ts`,
 * ticket 005, is what actually increments `seq` per broadcast) so this
 * function stays a pure `(rows, seq, at) -> Snapshot` map, trivially
 * golden-testable: the same rows and the same `seq`/`at` always produce
 * the same {@link Snapshot}.
 *
 * ## What this function does NOT populate
 *
 * {@link SnapshotLink.flash} and {@link SnapshotRelay.bridging} are both
 * ephemeral, server-side in-memory state with no backing store table
 * (architecture.md §4 has no `flash` table, and an in-flight bridging
 * attempt is not a `relay_leases` row — that table only ever holds
 * `"sweep"`/`"session:<linkId>"`). `buildSnapshot` never sets either
 * field; `server.ts` overlays them on top of this function's result
 * before broadcasting.
 *
 * ## The owned gate
 *
 * architecture.md §4: "The projection hides any wifi/mbserial link
 * whose device is not owned." A `wifi`/`mbserial` link whose `deviceId`
 * is `null` (an mDNS observation that never matched a known device) is
 * hidden for the same reason one step further back — there is no device
 * for it to be owned by — and is not placed in {@link
 * Snapshot.unassigned} either, since that list is specifically "USB
 * boards not yet named/identified" (architecture.md §9); a network
 * observation with no device match has nothing displayable about it at
 * all (no port, no serial, no name).
 *
 * ## Radio address resolution
 *
 * Every device gets a concrete `radio.channel`/`radio.group`, even one
 * that has never had an override or a registry hit: the stored value
 * when `devices.radio_source` records where it came from
 * (`"override"`/`"registry"`), otherwise the name-derived default
 * (`nameToRadioAddress`, reported as `source: "derived"`) — see
 * architecture.md's own words, "A derived (channel, group) is a
 * default, not an address," still always a displayable value, never
 * absent. The full `override → registry (non-mutating, cached) →
 * nameToRadioAddress` resolution *order* — i.e. actually consulting the
 * mbrelay registry — is ticket 006's cross-cutting resolver; this
 * function only ever reads what `devices.radio_channel/group/source`
 * already holds (a registry hit, once ticket 006 lands, is expected to
 * be persisted there, same as an override), plus the name-derived
 * fallback for a device with no persisted value at all.
 *
 * The name-derived fallback assumes a well-formed five-letter name --
 * true for every `kind='robot'` row and every grammar-named
 * `kind='relay'` row (`store/index.ts`'s consistency check guarantees
 * it), but not for a `kind='relay'` row with a synthetic negative id
 * (ticket 017-005: an mDNS relay whose instance name doesn't parse as
 * one, e.g. `torture`) -- `nameToRadioAddress` would throw for that
 * name. {@link resolveRadio} checks `device.id < 0` (the same
 * synthetic-id convention `store/index.ts` uses) before calling it, and
 * returns a fixed placeholder instead: this device has no radio
 * identity to derive one for regardless (a relay's own row is never
 * radio-addressed in the UI -- `AppHeader.tsx` gates
 * `RadioAddressDialog`/`WifiCredentialsDialog` on `kind !== "relay"`).
 */
import { nameToRadioAddress } from "@robot-console/protocol";
import {
  findCurrentMbflashService,
  type ProjectionDeviceRow,
  type ProjectionFirmwareRow,
  type ProjectionLinkRow,
  type ProjectionRows,
  type ProjectionServiceRow,
  type ProjectionSessionRow,
  type Store,
  type Transport,
} from "./store/index.js";
import type {
  FirmwareAvailability,
  FirmwareKind,
  RadioSourceWire,
  RobotFunction,
  RobotStatus,
  Snapshot,
  SnapshotDevice,
  SnapshotLink,
  SnapshotRelay,
} from "./wsMessages.js";
import path from "node:path";
import { isLocalHexPath } from "./config.js";

const FIRMWARE_KINDS: readonly FirmwareKind[] = ["relay", "robot"];

/** Reads {@link Store.projectionRows} and builds the {@link Snapshot}.
 * `seq`/`at` are the caller's (see this module's own doc comment for
 * why they are parameters, not derived here). */
export function buildSnapshot(store: Store, seq: number, at: number): Snapshot {
  return buildSnapshotFromRows(store.projectionRows(), seq, at);
}

/** Same as {@link buildSnapshot}, but takes already-read rows directly —
 * what `projection.test.ts`'s golden fixtures exercise, so a test never
 * needs a real `Store`/SQLite connection just to seed rows. */
export function buildSnapshotFromRows(rows: ProjectionRows, seq: number, at: number): Snapshot {
  const deviceById = new Map(rows.devices.map((d) => [d.id, d] as const));
  const linkById = new Map(rows.links.map((l) => [l.id, l] as const));
  const sessionByLink = new Map(rows.sessions.map((s) => [s.linkId, s] as const));
  const lastCheckedByDevice = new Map(rows.lastChecked.map((r) => [r.deviceId, r.at] as const));
  const ctx: LinkContext = { deviceById, linkById, sessionByLink, services: rows.services };

  const linksByDevice = new Map<number, ProjectionLinkRow[]>();
  const unassignedLinks: ProjectionLinkRow[] = [];
  for (const link of rows.links) {
    if (link.deviceId !== null) {
      const existing = linksByDevice.get(link.deviceId);
      if (existing) {
        existing.push(link);
      } else {
        linksByDevice.set(link.deviceId, [link]);
      }
    } else if (link.transport === "usb" && link.state !== "stale") {
      // A usb link with no device_id yet is an unnamed/unidentified USB
      // board -- architecture.md §9's `unassigned` list. A non-usb link
      // with no device_id has no device to attach to and nothing
      // displayable of its own; it is simply dropped (see this module's
      // own doc comment, "The owned gate"). A `stale` one (board no
      // longer enumerated) is dropped too -- there is no board to show.
      unassignedLinks.push(link);
    }
  }

  // A device with nothing owned and nothing visible to show (its only
  // link(s) are wifi/mbserial and got hidden by the owned gate above) is
  // dropped from `devices[]` entirely, not shown as an empty card --
  // architecture.md §9's golden-test scenario calls this out explicitly
  // ("an un-owned WiFi robot (absent)"): the owned gate exists to keep an
  // un-owned robot invisible to the UI, and a phantom zero-link card
  // would leak its existence right back. A device that IS owned is
  // always shown, even with zero links right now (e.g. freshly imported
  // from `known-robots.json`, never yet seen this run) -- "known but not
  // currently reachable" is meaningfully different from "not known".
  const devices: SnapshotDevice[] = rows.devices
    .map((device) => buildDevice(device, linksByDevice.get(device.id) ?? [], lastCheckedByDevice.get(device.id) ?? null, ctx))
    .filter((device) => device.owned || device.links.length > 0);

  const unassigned: SnapshotLink[] = unassignedLinks.map((link) => buildLink(link, ctx));

  const relays: SnapshotRelay[] = buildRelays(rows, deviceById);

  const firmwareByKind = new Map(rows.firmware.map((f) => [f.kind, f] as const));
  const firmware = Object.fromEntries(
    FIRMWARE_KINDS.map((kind) => [kind, buildFirmwareAvailability(firmwareByKind.get(kind))] as const),
  ) as Record<FirmwareKind, FirmwareAvailability>;

  return {
    type: "snapshot",
    seq,
    at,
    devices,
    unassigned,
    relays,
    firmware,
    wifi: rows.wifiCredentials ? { ssid: rows.wifiCredentials.ssid, source: "stored" } : { ssid: null, source: null },
    tasks: rows.tasks.map((t) => ({ name: t.name, state: t.state, heartbeatAt: t.heartbeatAt })),
  };
}

// ---------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------

/** True for the two transports architecture.md §4 gates on `devices.owned`
 * ("The projection hides any wifi/mbserial link whose device is not
 * owned") — mirrors `connect/reconciler.ts`'s own `requiresOwned`,
 * independently declared (this module never imports the reconciler; both
 * are direct readings of the same architecture rule). */
function requiresOwned(transport: Transport): boolean {
  return transport === "wifi" || transport === "mbserial";
}

function buildDevice(
  device: ProjectionDeviceRow,
  ownLinks: readonly ProjectionLinkRow[],
  lastChecked: number | null,
  ctx: LinkContext,
): SnapshotDevice {
  const visibleLinks = ownLinks.filter((link) => !requiresOwned(link.transport) || device.owned);
  return {
    id: device.id,
    name: device.name,
    kind: device.kind,
    role: device.role,
    commonName: device.commonName,
    program: device.program,
    version: device.version,
    owned: device.owned,
    radio: resolveRadio(device),
    lastSeen: device.lastSeen,
    lastChecked,
    links: visibleLinks.map((link) => buildLink(link, ctx)),
  };
}

/** A placeholder `(channel, group)` for a device with no persisted radio
 * fields and no name `nameToRadioAddress` can parse -- see this
 * module's "Radio address resolution" doc comment. Not a valid derived
 * address (`radioAddressToName` would reject `group: 0`, which is
 * outside `[1, 126]`), deliberately: this device has no radio identity
 * at all, so the value must never be mistaken for one. */
const NO_RADIO_IDENTITY = { channel: 0, group: 0 } as const;

function resolveRadio(device: ProjectionDeviceRow): { channel: number; group: number; source: RadioSourceWire } {
  if (device.radioSource !== null && device.radioChannel !== null && device.radioGroup !== null) {
    return { channel: device.radioChannel, group: device.radioGroup, source: device.radioSource };
  }
  if (device.id < 0) {
    // Synthetic-negative-id relay (ticket 017-005) -- its name is not
    // guaranteed to be a well-formed five-letter name, so
    // `nameToRadioAddress` cannot be called at all (see module doc
    // comment).
    return { ...NO_RADIO_IDENTITY, source: "derived" };
  }
  const derived = nameToRadioAddress(device.name);
  return { channel: derived.channel, group: derived.group, source: "derived" };
}

// ---------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------

interface LinkContext {
  readonly deviceById: ReadonlyMap<number, ProjectionDeviceRow>;
  readonly linkById: ReadonlyMap<string, ProjectionLinkRow>;
  readonly sessionByLink: ReadonlyMap<string, ProjectionSessionRow>;
  /** Ticket 018-014: every raw `services` row, so {@link buildLink} can
   * derive `capabilities.flash` for a `mbserial`/`wifi` link via
   * {@link findCurrentMbflashService} without a second store read. */
  readonly services: readonly ProjectionServiceRow[];
}

function buildLink(link: ProjectionLinkRow, ctx: LinkContext): SnapshotLink {
  const session = ctx.sessionByLink.get(link.id);
  const hasSession = session !== undefined;
  const isConnecting = link.state === "connecting";
  const device = link.deviceId !== null ? ctx.deviceById.get(link.deviceId) : undefined;

  const result: SnapshotLink = {
    id: link.id,
    transport: link.transport,
    label: buildLabel(link),
    state: link.state,
    reason: link.stateReason,
    since: link.stateSince,
    lastSeen: link.lastSeen,
    nextRetryAt: link.nextRetryAt,
    capabilities: {
      open: !hasSession && !isConnecting && (!requiresOwned(link.transport) || (device?.owned ?? false)),
      close: hasSession || isConnecting,
      // Ticket 018-014: a usb link can always be flashed (unchanged);
      // a mbserial/wifi link can be flashed too, but only once its
      // device currently advertises `_mbflash._tcp` (a farm robot's
      // mbdeploy daemon) -- radio/mbrelay links never get this (the
      // flash service is dialed directly, never through a relay).
      flash:
        link.transport === "usb" ||
        ((link.transport === "mbserial" || link.transport === "wifi") &&
          device !== undefined &&
          findCurrentMbflashService(ctx.services, device) !== undefined),
      provisionWifi: hasSession,
    },
  };

  const via = buildVia(link, ctx);
  if (via !== undefined) {
    result.via = via;
  }
  if (session !== undefined) {
    result.session = {
      seq: session.seq ?? 0,
      pending: session.pending ?? 0,
      lastDone: session.lastDone,
      lastDoneReason: session.lastDoneReason,
      robotStatus: (session.robotStatus as RobotStatus | null | undefined) ?? null,
      functions: (session.functions as RobotFunction[] | null | undefined) ?? null,
      // Sprint 018 ticket 010 (SUC-007): when this session last actually
      // answered something -- see `store/index.ts`'s own
      // `ProjectionSessionRow.answeredAt` doc comment and
      // `deviceDisplay.ts`'s `isLinkAnswering`, the "Linked" criterion
      // this field exists for.
      answeredAt: session.answeredAt,
    };
  }
  return result;
}

/** Parses an address's `relayLinkId`/`channel`/`group` fields off the raw
 * (already-JSON-parsed) `unknown` value connector.ts's own doc comment
 * defines for `radio`/`mbrelay` links (`{ relayLinkId, channel, group }`).
 * Never throws on a malformed/missing shape — an address this module
 * cannot make sense of just means no `via` is reported, mirroring
 * `connect/reconciler.ts`'s own `relayLinkIdOf`'s "never throws on a bad
 * row" discipline. */
function parseRelayAddress(address: unknown): { relayLinkId: string; channel: number; group: number } | undefined {
  if (typeof address !== "object" || address === null) {
    return undefined;
  }
  const rec = address as Record<string, unknown>;
  const relayLinkId = rec.relayLinkId;
  const channel = rec.channel;
  const group = rec.group;
  if (typeof relayLinkId !== "string" || typeof channel !== "number" || typeof group !== "number") {
    return undefined;
  }
  return { relayLinkId, channel, group };
}

function buildVia(link: ProjectionLinkRow, ctx: LinkContext): SnapshotLink["via"] {
  if (link.transport !== "radio" && link.transport !== "mbrelay") {
    return undefined;
  }
  const parsed = parseRelayAddress(link.address);
  if (parsed === undefined) {
    return undefined;
  }
  const relayLink = ctx.linkById.get(parsed.relayLinkId);
  const relayDevice = relayLink?.deviceId !== null && relayLink?.deviceId !== undefined ? ctx.deviceById.get(relayLink.deviceId) : undefined;
  const owningDevice = link.deviceId !== null ? ctx.deviceById.get(link.deviceId) : undefined;
  return {
    relayLinkId: parsed.relayLinkId,
    relayName: relayDevice?.name ?? parsed.relayLinkId,
    channel: parsed.channel,
    group: parsed.group,
    addressSource: owningDevice?.radioSource ?? "derived",
  };
}

function addressField(address: unknown, key: string): unknown {
  return typeof address === "object" && address !== null ? (address as Record<string, unknown>)[key] : undefined;
}

/** Builds {@link SnapshotLink.label} -- a short human-readable summary of
 * a link's transport and address. Not otherwise specified beyond
 * architecture.md §9's single illustrative example
 * (`"USB · /dev/cu.usbmodem… · ID 1a2b"`); this is `projection.ts`'s own
 * design call for a concrete, deterministic format (display text only,
 * never parsed by a client — see the module doc comment on {@link
 * Snapshot.devices}'s own `links`). */
function buildLabel(link: ProjectionLinkRow): string {
  switch (link.transport) {
    case "usb": {
      const path = addressField(link.address, "path");
      return `USB · ${typeof path === "string" ? path : "unknown port"}`;
    }
    case "wifi":
      return `WiFi · ${hostPort(link.address)}`;
    case "mbserial":
      return `mbserial · ${hostPort(link.address)}`;
    case "radio":
      return `Radio · ${channelGroup(link.address)}`;
    case "mbrelay":
      // The relay's own connectivity link to its host (mdnsWatcher.ts's
      // `handleMbrelay`: address is `{ host, port, registryPort }`, the
      // same shape as `wifi`/`mbserial` -- never a `{ channel, group }`
      // radio address, so `channelGroup` here always produced junk
      // ("mbrelay · ch?/grp?", bench defect, team-lead walk 017-012).
      return `mbrelay · ${hostPort(link.address)}`;
    default: {
      const exhaustive: never = link.transport;
      return String(exhaustive);
    }
  }
}

function hostPort(address: unknown): string {
  const host = addressField(address, "host");
  const port = addressField(address, "port");
  return `${typeof host === "string" ? host : "?"}:${typeof port === "number" ? port : "?"}`;
}

function channelGroup(address: unknown): string {
  const channel = addressField(address, "channel");
  const group = addressField(address, "group");
  return `ch${typeof channel === "number" ? channel : "?"}/grp${typeof group === "number" ? group : "?"}`;
}

// ---------------------------------------------------------------------
// Relays
// ---------------------------------------------------------------------

/** One `{ linkId, lease }` entry per link owned by a `kind: "relay"`
 * device — the relay's own connectivity link (`relay_leases.relay_link_id`
 * references exactly this kind of link, architecture.md §7.2). A relay
 * device also gets its usual {@link SnapshotDevice} entry in {@link
 * Snapshot.devices} (with this same link inside its own `links[]`) --
 * this list exists alongside that, not instead of it, purely to carry
 * lease/bridging status architecture.md §9 keeps separate from the
 * per-link shape every other device's links share. */
function buildRelays(rows: ProjectionRows, deviceById: ReadonlyMap<number, ProjectionDeviceRow>): SnapshotRelay[] {
  const leaseByLink = new Map(rows.relayLeases.map((r) => [r.relayLinkId, r.owner] as const));
  const relays: SnapshotRelay[] = [];
  for (const link of rows.links) {
    if (link.deviceId === null) {
      continue;
    }
    const device = deviceById.get(link.deviceId);
    if (device === undefined || device.kind !== "relay") {
      continue;
    }
    const owner = leaseByLink.get(link.id);
    const lease: "sweep" | "session" | null = owner === undefined ? null : owner === "sweep" ? "sweep" : "session";
    // Ticket 016-007: `null` when no lease-acquisition sync has completed
    // against this link yet (see `SnapshotRelay.sweep`'s own doc comment
    // for why that is a distinct, honest answer from either rate).
    const fastDetected = rows.fastSweepByRelayLinkId.get(link.id);
    const sweep: SnapshotRelay["sweep"] = fastDetected === undefined ? null : { rate: fastDetected ? "fast" : "slow" };
    relays.push({ linkId: link.id, lease, sweep });
  }
  return relays;
}

// ---------------------------------------------------------------------
// Firmware
// ---------------------------------------------------------------------

function buildFirmwareAvailability(row: ProjectionFirmwareRow | undefined): FirmwareAvailability {
  if (row === undefined || row.repo === null || row.tag === null) {
    return { configured: false };
  }
  const available = row.available ?? false;
  const failure = {
    ...(!available && row.reason !== null ? { reason: row.reason } : {}),
    ...(!available && row.message !== null ? { message: row.message } : {}),
  };

  // `firmware.repo` stores verbatim whatever was configured for this
  // kind, so deciding what a stored string *means* is exactly the
  // question `config.ts`'s `isLocalHexPath` already answers when it
  // parses that same string (out-of-process, 2026-09-16). Reusing the
  // one predicate here -- rather than persisting a second discriminator
  // column that could drift out of step with the value it describes --
  // is what guarantees the parse and the projection can never disagree.
  if (isLocalHexPath(row.repo)) {
    return {
      configured: true,
      kind: "local-file",
      hexPath: row.repo,
      fileName: path.basename(row.repo),
      tag: row.tag,
      available,
      checkedAt: row.checkedAt,
      ...failure,
    } as FirmwareAvailability;
  }

  return {
    configured: true,
    repoUrl: row.repo,
    tag: row.tag,
    available,
    checkedAt: row.checkedAt,
    ...failure,
  } as FirmwareAvailability;
}
