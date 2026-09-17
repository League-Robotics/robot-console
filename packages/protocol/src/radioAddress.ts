import { deviceIdToName, nameToValue, NAME_SPACE } from "./naming.js";

/**
 * name <-> default `(channel, group)`, the 73-channel map.
 *
 * Normative spec: radio-robot-lib `docs/design/radio-addressing.md`
 * (`RobotProjects/radio-robot-lib/docs/design/radio-addressing.md`). If
 * this module and that document disagree, the document wins. The spec's
 * vectors and digests are copied into `radio-address-vectors.json` next
 * to this file and checked over the whole 3125-name space by
 * `radioAddress.test.ts`. Reference implementation:
 * `microbit-radio-relay/server/src/mbrelay/naming.py`.
 *
 * ```
 * normalize: trim ASCII whitespace; map A-Z to a-z
 * n        = base5(name)          # name[0] is the MOST significant digit
 * channel  = 11 + (n % 73)        # 11 .. 83
 * group    = 15 + (n % 241)       # 15 .. 255
 *
 * reverse: reject unless 11 <= channel <= 83 and 15 <= group <= 255
 *          c = channel - 11; g = group - 15
 *          n = c + 73 * (((g - c + 241) * 208) % 241)   # 208 = 73^-1 mod 241
 *          reject unless n < 3125
 * ```
 *
 * The vendored `vendor/pxt-nezha-diffdrive/docs/radio-addressing.md`
 * still describes the retired 25-channel map and is NOT normative here.
 *
 * A derived pair is a default, not where a robot really is: a robot's
 * build bakes in its own pair, and registry pins or stored overrides win
 * over this (see specification.md §3.2).
 *
 * **Endianness trap**: `zuzuv` is `n = 1`. A reversed (little-endian)
 * encoder produces `vuzuz` for the same input and would pass a sampled
 * table, which is why the test checks the full-space digest.
 */

const CHANNEL_MIN = 11;
const CHANNEL_MAX = 83;
const CHANNEL_COUNT = 73;
const GROUP_MIN = 15;
const GROUP_MAX = 255;
const GROUP_COUNT = 241;
/** 73 * 208 = 15184 = 63 * 241 + 1, so 208 is 73's inverse mod 241. */
const CHANNEL_COUNT_INVERSE = 208;

/** Hardware channel range the micro:bit radio and the relay's `!CG`
 * accept (`# error: usage !CG <ch 0-83> <group 0-255>`). Wider than the
 * name-derived space: an override or a registry pin may be any of these. */
export const RADIO_HARDWARE_CHANNEL_MIN = 0;
export const RADIO_HARDWARE_CHANNEL_MAX = 83;
/** Hardware group range (`setGroup`'s 0-255). */
export const RADIO_HARDWARE_GROUP_MIN = 0;
export const RADIO_HARDWARE_GROUP_MAX = 255;

export interface RadioAddress {
  channel: number;
  group: number;
}

/** Five-letter name -> its base-5 value (re-exported from `naming.ts`). */
export { nameToValue as base5 };

const ASCII_WHITESPACE = /^[ \t\r\n\f\v]+|[ \t\r\n\f\v]+$/g;

/**
 * The spec's name normalization: trim ASCII whitespace and map `A-Z` to
 * `a-z`, nothing more. `"VEVOV"` and `" vevov "` both become `"vevov"`.
 * Does not validate; {@link nameToRadioAddress} does.
 */
export function normalizeRadioName(name: string): string {
  return name.replace(ASCII_WHITESPACE, "").replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

/**
 * Five-letter name -> its default `(channel, group)`. Not necessarily
 * where a robot actually is -- see specification.md §6: "A derived
 * (channel, group) is a default, not an address." Callers that need
 * the live location consult an override or mbrelay's name registry
 * first. Throws for anything that is not a name after normalization.
 */
export function nameToRadioAddress(name: string): RadioAddress {
  const n = nameToValue(normalizeRadioName(name));
  return { channel: CHANNEL_MIN + (n % CHANNEL_COUNT), group: GROUP_MIN + (n % GROUP_COUNT) };
}

/** The spec's reverse map, or `null` when the pair belongs to no name. */
function reverseToValue(channel: number, group: number): number | null {
  if (!Number.isInteger(channel) || channel < CHANNEL_MIN || channel > CHANNEL_MAX) {
    return null;
  }
  if (!Number.isInteger(group) || group < GROUP_MIN || group > GROUP_MAX) {
    return null;
  }
  const c = channel - CHANNEL_MIN;
  const g = group - GROUP_MIN;
  const n = c + CHANNEL_COUNT * ((((g - c + GROUP_COUNT) * CHANNEL_COUNT_INVERSE) % GROUP_COUNT));
  return n < NAME_SPACE ? n : null;
}

/**
 * `(channel, group)` -> the one name that derives it, the inverse of
 * `nameToRadioAddress`. Port of `mbrelay/naming.py`'s `radio_to_name()`.
 * Throws for any pair that belongs to no name: out of 11-83 / 15-255, or
 * in range but with `n >= 3125` (most pairs, e.g. 11/16). Never guesses.
 */
export function radioAddressToName(channel: number, group: number): string {
  if (!Number.isInteger(channel) || channel < CHANNEL_MIN || channel > CHANNEL_MAX) {
    throw new Error(`channel ${channel} is not a derived address`);
  }
  if (!Number.isInteger(group) || group < GROUP_MIN || group > GROUP_MAX) {
    throw new Error(`group ${group} is not a derived address`);
  }
  const n = reverseToValue(channel, group);
  if (n === null) {
    throw new Error(`${channel}/${group} belongs to no name`);
  }
  return deviceIdToName(n);
}

/**
 * Non-throwing counterpart to {@link radioAddressToName}: is
 * `(channel, group)` the derived address of some name (channel 11-83,
 * group 15-255, and the reverse map gives `n < 3125`)?
 *
 * This is the name-derived space only. To check whether a relay may be
 * tuned to a pair (an override, a registry pin), use
 * {@link isHardwareRadioPair} instead.
 */
export function validateRadioAddress(channel: number, group: number): boolean {
  return reverseToValue(channel, group) !== null;
}

/**
 * The spec's canonical full-space form, one line per name for
 * `n = 0..3124` in order (mirrors `mbrelay/naming.py`'s `canonical_form`).
 * Version 2 (D2, the gate):
 * `<name>,<channel>,<group>,<decode(name)>,<reverse(channel,group)>\n`.
 * Version 1 (D1, forward only): `<name>,<channel>,<group>\n`. Its sha256
 * is the cross-repo contract; `tools/radio-address-dump` prints it.
 */
export function radioAddressCanonicalForm(version: 1 | 2 = 2): string {
  const lines: string[] = [];
  for (let n = 0; n < NAME_SPACE; n++) {
    const name = deviceIdToName(n);
    const { channel, group } = nameToRadioAddress(name);
    if (version === 1) {
      lines.push(`${name},${channel},${group}\n`);
    } else {
      const decoded = nameToValue(normalizeRadioName(name));
      const reversed = nameToValue(radioAddressToName(channel, group));
      lines.push(`${name},${channel},${group},${decoded},${reversed}\n`);
    }
  }
  return lines.join("");
}

/**
 * Is `(channel, group)` a pair the radio hardware accepts: integer
 * channel 0-83 and integer group 0-255? This is the one definition of
 * that range. Relay tunes (`!CG`/`!CGT`), host overrides and the UI's
 * override form all use it, because a robot may sit on any such pair
 * (a registry pin, a hand-set override, a board flashed before the map
 * changed), not only on a name-derived one.
 */
export function isHardwareRadioPair(channel: number, group: number): boolean {
  return (
    Number.isInteger(channel) &&
    channel >= RADIO_HARDWARE_CHANNEL_MIN &&
    channel <= RADIO_HARDWARE_CHANNEL_MAX &&
    Number.isInteger(group) &&
    group >= RADIO_HARDWARE_GROUP_MIN &&
    group <= RADIO_HARDWARE_GROUP_MAX
  );
}
