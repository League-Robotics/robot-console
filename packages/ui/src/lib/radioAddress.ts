/**
 * lib/radioAddress.ts — the one client-side check for a `set-radio-
 * override` channel/group pair, shared by `RadioAddressDialog` and
 * `ConfigurationPage`'s Radio panel (ticket 017-008;
 * `docs/reviews/2026-09-11/04-ui.md` §4's "Radio address validation
 * (0-83 / 0-255)" row -- both call sites duplicated the identical
 * `0-83`/`0-255` integer-range check and the identical two error
 * strings).
 *
 * ## Why the hardware range, not `validateRadioAddress`
 *
 * Both `RadioAddressDialog` and `ConfigurationPage` send a
 * `set-radio-override` message -- a user-dialled *override*, not a
 * name-derived address. The host's authority for that message,
 * `packages/host/src/radioOverride.ts`'s `isValidRadioOverride`, checks
 * the raw hardware range (`channel` `0-83`, `group` `0-255`, both
 * integers) because an override may be any address the radio accepts,
 * not only one a five-letter name derives. `validateRadioAddress` checks
 * the narrower derived space (channel `11-83`, group `15-255`, a pair
 * some name derives -- radio-robot-lib `docs/design/radio-addressing.md`)
 * and would wrongly refuse overrides the host accepts.
 *
 * Both this module and the host take the range from
 * `@robot-console/protocol`'s `isHardwareRadioPair` constants, so client
 * and host enforce the identical rule without the browser bundle pulling
 * in the host's server-only module graph. The host handler remains the
 * authority; this only gives the dialogs immediate feedback.
 */
import {
  RADIO_HARDWARE_CHANNEL_MAX,
  RADIO_HARDWARE_CHANNEL_MIN,
  RADIO_HARDWARE_GROUP_MAX,
  RADIO_HARDWARE_GROUP_MIN,
} from "@robot-console/protocol";

/** Raw channel range a user-supplied override may occupy. */
export const RADIO_CHANNEL_MIN = RADIO_HARDWARE_CHANNEL_MIN;
export const RADIO_CHANNEL_MAX = RADIO_HARDWARE_CHANNEL_MAX;
/** Raw group range a user-supplied override may occupy. */
export const RADIO_GROUP_MIN = RADIO_HARDWARE_GROUP_MIN;
export const RADIO_GROUP_MAX = RADIO_HARDWARE_GROUP_MAX;

/**
 * `null` when `(channel, group)` is an acceptable override, else the
 * reason -- checks `channel` first, matching both pre-extraction
 * copies' short-circuit order (a bad channel is reported even when the
 * group is also bad).
 */
export function validateRadioOverrideInput(channel: number, group: number): string | null {
  if (!Number.isInteger(channel) || channel < RADIO_CHANNEL_MIN || channel > RADIO_CHANNEL_MAX) {
    return `Channel must be a whole number from ${RADIO_CHANNEL_MIN} to ${RADIO_CHANNEL_MAX}.`;
  }
  if (!Number.isInteger(group) || group < RADIO_GROUP_MIN || group > RADIO_GROUP_MAX) {
    return `Group must be a whole number from ${RADIO_GROUP_MIN} to ${RADIO_GROUP_MAX}.`;
  }
  return null;
}
