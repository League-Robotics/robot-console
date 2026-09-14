import { deviceIdToName, nameToValue } from "./naming.js";

/**
 * name <-> radio `(channel, group)`.
 *
 * Normative spec: radio-robot-lib `docs/design/radio-addressing.md`
 * (adopted 2026-09-13), transcribed into
 * `microbit-radio-relay/server/tests/radio-address-vectors.json` and
 * pxt-nezha-diffdrive's `docs/radio-address-vectors.json` (the vendored
 * copy `radioAddress.test.ts` reads). If this file and the spec
 * disagree, the spec wins.
 *
 * ```
 * n       = base5(name)          # name[0] is the MOST significant digit
 * channel = 11 + (n % 73)        # 11 .. 83
 * group   = 15 + (n % 241)       # 15 .. 255
 * ```
 *
 * 73 and 241 are coprime and 73 * 241 > 3125, so every name has a
 * distinct pair. Channels 0-10 and groups 0-14 are never emitted.
 * Replaces the retired 25-channel map (`25 + 2 * (n % 25)`).
 *
 * **Endianness trap**: `zuzuv` is `n = 1`. A reversed (little-endian)
 * encoder produces `vuzuz` for the same input and would pass a sampled
 * table — see the named test and the full-space conformance test in
 * `radioAddress.test.ts`.
 */

const CHANNEL_MIN = 11;
const CHANNEL_COUNT = 73;
const GROUP_MIN = 15;
const GROUP_COUNT = 241;
/** 73^-1 mod 241: the reverse map's multiplier. */
const CHANNEL_COUNT_INVERSE = 208;
const NAME_COUNT = 3125;

/** The radio's own limits: `setFrequencyBand` 0..83, `setGroup` 0..255. */
export const RADIO_CHANNEL_MAX = 83;
export const RADIO_GROUP_MAX = 255;

export interface RadioAddress {
  channel: number;
  group: number;
}

/** Five-letter name -> its base-5 value (re-exported from `naming.ts`). */
export { nameToValue as base5 };

/**
 * Five-letter name -> its default `(channel, group)`. Not necessarily
 * where a robot actually is — see specification.md §6: "A derived
 * (channel, group) is a default, not an address." Callers that need
 * the live location must consult mbrelay's name registry and fall back
 * to this only when the registry is unreachable.
 */
export function nameToRadioAddress(name: string): RadioAddress {
  const n = nameToValue(name);
  return { channel: CHANNEL_MIN + (n % CHANNEL_COUNT), group: GROUP_MIN + (n % GROUP_COUNT) };
}

/** The name value a derived pair decodes to, or -1 when it has none. */
function derivedValue(channel: number, group: number): number {
  if (!Number.isInteger(channel) || !Number.isInteger(group)) return -1;
  if (channel < CHANNEL_MIN || channel > CHANNEL_MIN + CHANNEL_COUNT - 1) return -1;
  if (group < GROUP_MIN || group > GROUP_MIN + GROUP_COUNT - 1) return -1;
  const c = channel - CHANNEL_MIN;
  const g = group - GROUP_MIN;
  const n = c + CHANNEL_COUNT * (((g - c + GROUP_COUNT) * CHANNEL_COUNT_INVERSE) % GROUP_COUNT);
  return n < NAME_COUNT ? n : -1;
}

/**
 * `(channel, group)` -> the one name that derives it, the inverse of
 * `nameToRadioAddress` (the spec's reverse map). Throws for any pair that
 * belongs to no name — most pairs don't, including every hand-dialled
 * `!CG` pair outside 11..83 / 15..255 — and never falls back to a guess.
 */
export function radioAddressToName(channel: number, group: number): string {
  const n = derivedValue(channel, group);
  if (n < 0) {
    throw new Error(`(${channel}, ${group}) is not a derived address`);
  }
  return deviceIdToName(n);
}

/**
 * Is `(channel, group)` a pair some name derives (channel 11..83, group
 * 15..255, and the reverse map lands on a name)? Non-throwing
 * counterpart to {@link radioAddressToName}. This is the DERIVED space;
 * a relay tune or a registry pin must accept any hardware-valid pair —
 * use {@link validateHardwareRadioAddress} for that.
 */
export function validateRadioAddress(channel: number, group: number): boolean {
  return derivedValue(channel, group) >= 0;
}

/**
 * Is `(channel, group)` something the radio can be tuned to (channel
 * 0..83, group 0..255)? A robot pinned in the registry, or moved by hand
 * after a name collision, sits outside the derived space but is still a
 * legal address.
 */
export function validateHardwareRadioAddress(channel: number, group: number): boolean {
  return (
    Number.isInteger(channel) && Number.isInteger(group) &&
    channel >= 0 && channel <= RADIO_CHANNEL_MAX &&
    group >= 0 && group <= RADIO_GROUP_MAX
  );
}
