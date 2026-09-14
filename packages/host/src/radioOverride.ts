/**
 * radioOverride.ts — validation for a user-supplied radio address
 * override, plus the one cross-cutting `override -> registry -> derived`
 * resolver every consumer of a device's radio address is meant to share
 * (sprint 015 ticket 006; issue `rearch-08-radio-address-overrides-in-host-db.md`;
 * `docs/design/architecture.md` §2/§9; SUC-007).
 *
 * ## Why this validation is wider than `validateRadioAddress`
 *
 * `@robot-console/protocol`'s `validateRadioAddress` restricts to the
 * *derived* address space (channel 11–83, group 15–255, and a pair some
 * name actually derives, per radio-robot-lib's
 * `docs/design/radio-addressing.md`). A user-dialled override is not
 * limited to that space: an instructor may want any hardware-valid
 * address, not only one a five-letter name could derive. So
 * {@link isValidRadioOverride} checks the raw hardware range instead
 * (`channel` `0–83`, `group` `0–255`, both integers), using protocol's
 * `isHardwareRadioPair`, the same check the relay `!CG`/`!CGT` builders
 * use. `server.ts`'s `set-radio-override` handler is its caller.
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
import {
  isHardwareRadioPair,
  RADIO_HARDWARE_CHANNEL_MAX,
  RADIO_HARDWARE_CHANNEL_MIN,
  RADIO_HARDWARE_GROUP_MAX,
  RADIO_HARDWARE_GROUP_MIN,
} from "@robot-console/protocol";
import { resolveRobotAddress, type RegistryLocation, type ResolveRobotAddressOptions, type ResolvedAddress } from "./mbrelayRegistry.js";
import type { RadioSource } from "./store/index.js";
import type { RadioSourceWire } from "./wsMessages.js";

/** Raw channel range a user-supplied override may occupy — wider than
 * the derived-address space (see module doc comment). Re-exported from
 * protocol's single hardware-range definition. */
export const RADIO_CHANNEL_MIN = RADIO_HARDWARE_CHANNEL_MIN;
export const RADIO_CHANNEL_MAX = RADIO_HARDWARE_CHANNEL_MAX;
/** Raw radio group range a user-supplied override may occupy — wider
 * than the derived-address space (see module doc comment); groups below
 * 15, including `0` and the relay's `10`, are legal here. */
export const RADIO_GROUP_MIN = RADIO_HARDWARE_GROUP_MIN;
export const RADIO_GROUP_MAX = RADIO_HARDWARE_GROUP_MAX;

/**
 * Is `(channel, group)` a legal user-supplied radio override? Both must
 * be integers within the raw hardware range — `channel` in
 * `[0, 83]`, `group` in `[0, 255]`. The one range check every
 * `set-radio-override` handler call runs before writing anything (this
 * ticket's own acceptance criterion: invalid input is rejected with a
 * `notice`, never persisted).
 */
export function isValidRadioOverride(channel: number, group: number): boolean {
  return isHardwareRadioPair(channel, group);
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
