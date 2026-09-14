/**
 * radioOverride.ts — validation for a user-supplied radio address
 * override, plus the one cross-cutting `override -> registry -> derived`
 * resolver every consumer of a device's radio address is meant to share
 * (sprint 015 ticket 006; issue `rearch-08-radio-address-overrides-in-host-db.md`;
 * `docs/design/architecture.md` §2/§9; SUC-007).
 *
 * ## Why this validation is wider than `@robot-console/protocol`'s own
 *
 * `@robot-console/protocol`'s `validateRadioAddress` restricts to the
 * *derived* address space (channel in `[11, 83]`, group in `[15, 255]`,
 * and only pairs some name decodes to) — the space `nameToRadioAddress`
 * can actually produce. A user-dialled override is not limited to that
 * space: an instructor may want any hardware-valid nRF24 address, not
 * only one a five-letter name could derive. So this module's own
 * {@link isValidRadioOverride} checks the raw hardware range instead
 * (`channel` `0–83`, `group` `0–255`, both integers) — the one place
 * that range check lives; `server.ts`'s `set-radio-override` handler is
 * this ticket's only caller, per the ticket's own "host-side, in one
 * place" instruction.
 *
 * ## The resolver
 *
 * {@link resolveDeviceRadio} is the `override -> registry -> derived`
 * order `projection.ts`'s own doc comment describes as "ticket 006's
 * cross-cutting resolver": a stored override always wins; otherwise
 * `mbrelayRegistry.ts`'s `resolveRobotAddress` is consulted (non-mutating
 * from this module's perspective, and already cached by that module's
 * own short TTL cache — see its doc comment); otherwise the name-derived
 * default. `resolveRobotAddress`'s three registry-side outcomes
 * (`"config"`/`"registry"` — an actual hit — vs. `"derived"` — the
 * registry replied but only just derived it on this request — vs.
 * `"local-derived"` — unreachable) collapse to the two the DB schema and
 * wire contract actually distinguish (`RadioSource`/`RadioSourceWire`
 * have no `"config"` slot of their own): `"config"`/`"registry"` both
 * become `"registry"`; `"derived"`/`"local-derived"` both become
 * `"derived"`. Never throws — `resolveRobotAddress` already guarantees
 * that.
 *
 * This resolver is not yet wired into any production call site as of
 * this ticket (`server.ts`'s `session-open` still answers "not supported
 * yet" for the `{relayLinkId, name}` bridging shape that would need it —
 * see that handler's own comment) — it exists here, validated directly
 * against a unit test with no live mbrelay, so a future ticket that adds
 * that bridging path has one resolver to call rather than reinventing
 * the order.
 */
import { resolveRobotAddress, type RegistryLocation, type ResolveRobotAddressOptions, type ResolvedAddress } from "./mbrelayRegistry.js";
import type { RadioSource } from "./store/index.js";
import type { RadioSourceWire } from "./wsMessages.js";

/** Raw nRF24 channel range a user-supplied override may occupy — wider
 * than the derived-address space (see module doc comment). */
export const RADIO_CHANNEL_MIN = 0;
export const RADIO_CHANNEL_MAX = 83;
/** Raw radio group/address-byte range a user-supplied override may
 * occupy — wider than the derived-address space (see module doc
 * comment); unlike the derived space, group `0` and the "reserved" `10`
 * are both legal here. */
export const RADIO_GROUP_MIN = 0;
export const RADIO_GROUP_MAX = 255;

/**
 * Is `(channel, group)` a legal user-supplied radio override? Both must
 * be integers within the raw hardware range — `channel` in
 * `[0, 83]`, `group` in `[0, 255]`. The one range check every
 * `set-radio-override` handler call runs before writing anything (this
 * ticket's own acceptance criterion: invalid input is rejected with a
 * `notice`, never persisted).
 */
export function isValidRadioOverride(channel: number, group: number): boolean {
  return (
    Number.isInteger(channel) &&
    channel >= RADIO_CHANNEL_MIN &&
    channel <= RADIO_CHANNEL_MAX &&
    Number.isInteger(group) &&
    group >= RADIO_GROUP_MIN &&
    group <= RADIO_GROUP_MAX
  );
}

/** The slice of a `devices` row {@link resolveDeviceRadio} needs — a
 * structural subset of `store/index.ts`'s `ProjectionDeviceRow`, named
 * independently so a caller can pass either that row shape or a plain
 * literal (e.g. from a unit test with no real `Store`). */
export interface DeviceRadioOverride {
  readonly radioChannel: number | null;
  readonly radioGroup: number | null;
  readonly radioSource: RadioSource;
}

export interface ResolveDeviceRadioOptions {
  /** Where mbrelay's name registry lives, if known — forwarded verbatim
   * to `resolveRobotAddress`. Omit when no relay/registry has been
   * discovered yet; the resolver still returns a usable (derived)
   * result. */
  registry?: RegistryLocation;
  /** Injectable registry lookup — defaults to the real
   * {@link resolveRobotAddress}. Tests substitute a fake so this
   * module's own ordering (override always wins, registry consulted
   * only otherwise) is provable with no live mbrelay (this ticket's own
   * acceptance criterion). */
  resolveRegistry?: (
    name: string,
    registry: RegistryLocation | undefined,
    options?: ResolveRobotAddressOptions,
  ) => Promise<ResolvedAddress>;
  /** Forwarded verbatim to {@link resolveRegistry} (or the real
   * `resolveRobotAddress` when not overridden) — lets a caller inject
   * its own fetch/scheduler/cache the same way a direct
   * `resolveRobotAddress` call would. */
  registryOptions?: ResolveRobotAddressOptions;
}

/** A device's radio address, fully resolved, plus which of the wire's
 * three outcomes produced it — see {@link RadioSourceWire}. */
export interface ResolvedDeviceRadio {
  channel: number;
  group: number;
  source: RadioSourceWire;
}

/**
 * Resolve `name`'s radio address in the one order every consumer shares:
 * a stored {@link DeviceRadioOverride} wins outright; otherwise consult
 * mbrelay's name registry; otherwise the name-derived default. See the
 * module doc comment for the outcome-collapsing rule and why this is
 * not yet wired into a production call site.
 */
export async function resolveDeviceRadio(
  name: string,
  override: DeviceRadioOverride,
  options: ResolveDeviceRadioOptions = {},
): Promise<ResolvedDeviceRadio> {
  if (override.radioSource === "override" && override.radioChannel !== null && override.radioGroup !== null) {
    return { channel: override.radioChannel, group: override.radioGroup, source: "override" };
  }

  const resolveRegistry = options.resolveRegistry ?? resolveRobotAddress;
  const resolved = await resolveRegistry(name, options.registry, options.registryOptions);
  const source: RadioSourceWire = resolved.outcome === "config" || resolved.outcome === "registry" ? "registry" : "derived";
  return { channel: resolved.channel, group: resolved.group, source };
}
