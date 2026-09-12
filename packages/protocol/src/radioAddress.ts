import { deviceIdToName, nameToValue } from "./naming.js";

/**
 * name -> default `(channel, group)`.
 *
 * Normative spec: `vendor/pxt-nezha-diffdrive/docs/radio-addressing.md`,
 * with the machine-readable contract
 * `vendor/pxt-nezha-diffdrive/docs/radio-address-vectors.json` (see the
 * full-space conformance test in `radioAddress.test.ts`). Direct port
 * of `microbit-radio-relay/server/src/mbrelay/naming.py`:
 *
 * ```
 * n       = base5(name)          # name[0] is the MOST significant digit
 * channel = 25 + 2 * (n % 25)    # 25, 27, ... 73
 * group   = 1 + n // 25          # then: if group >= 10, group += 1
 * ```
 *
 * Group 10 is never emitted — it is microbit-radio-relay's `!C` /
 * button-A/B space — so any group that lands on or past 10 is bumped
 * up by one (per `mbrelay/naming.py`'s `address()`:
 * `if group >= RESERVED_GROUP: group += 1`). This produces groups
 * `1..9` and `11..126`.
 *
 * **Endianness trap**: `zuzuv` is `n = 1`. A reversed (little-endian)
 * encoder produces `vuzuz` for the same input and would pass a sampled
 * table — see the named test and the full-space conformance test in
 * `radioAddress.test.ts`.
 */

const CHANNEL_MIN = 25;
const CHANNEL_MAX = 73;
const CHANNEL_STEP = 2;
const CHANNEL_COUNT = 25;
const GROUP_MIN = 1;
const GROUP_MAX = 126;
const RESERVED_GROUP = 10;

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
  const channel = CHANNEL_MIN + CHANNEL_STEP * (n % CHANNEL_COUNT);
  let group = 1 + Math.floor(n / CHANNEL_COUNT);
  if (group >= RESERVED_GROUP) {
    group += 1;
  }
  return { channel, group };
}

/**
 * `(channel, group)` -> the one name that derives it, the inverse of
 * `nameToRadioAddress`. Port of `mbrelay/naming.py`'s `radio_to_name()`.
 * Throws for any pair outside the derived space (e.g. a hand-dialled
 * `!CG` link, or group 10's reserved button space) — never falls back
 * to a guess.
 */
export function radioAddressToName(channel: number, group: number): string {
  if (channel % 2 === 0 || channel < CHANNEL_MIN || channel > CHANNEL_MAX) {
    throw new Error(`channel ${channel} is not a derived address`);
  }
  if (group === RESERVED_GROUP || group < GROUP_MIN || group > GROUP_MAX) {
    throw new Error(`group ${group} is not a derived address`);
  }
  const g = group > RESERVED_GROUP ? group - 1 : group;
  const n = CHANNEL_COUNT * (g - 1) + (channel - CHANNEL_MIN) / CHANNEL_STEP;
  return deviceIdToName(n);
}

/**
 * Non-throwing counterpart to {@link radioAddressToName}'s own range
 * check: is `(channel, group)` a well-formed *derived* radio address
 * (odd channel in `[25, 73]`, group in `[1, 126]` excluding the
 * reserved `10`)? Exported so a caller that just wants to validate an
 * address before building a `!CG` line, or before persisting a DB row,
 * does not need to wrap a throwing call in try/catch just to get a
 * boolean (`radioAddressToName`/`nameToRadioAddress` stay throwing --
 * they also have real work to do beyond validation, and their callers
 * already expect an exception for a caller-error case).
 */
export function validateRadioAddress(channel: number, group: number): boolean {
  if (!Number.isInteger(channel) || channel % 2 === 0 || channel < CHANNEL_MIN || channel > CHANNEL_MAX) {
    return false;
  }
  if (!Number.isInteger(group) || group === RESERVED_GROUP || group < GROUP_MIN || group > GROUP_MAX) {
    return false;
  }
  return true;
}
