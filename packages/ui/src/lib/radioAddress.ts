/**
 * lib/radioAddress.ts — the one client-side check for a `set-radio-
 * override` channel/group pair, shared by `RadioAddressDialog` and
 * `ConfigurationPage`'s Radio panel (ticket 017-008;
 * `docs/reviews/2026-09-11/04-ui.md` §4's "Radio address validation
 * (0-83 / 0-255)" row -- both call sites duplicated the identical
 * `0-83`/`0-255` integer-range check and the identical two error
 * strings).
 *
 * ## Why this mirrors `radioOverride.ts`'s range, not
 * `@robot-console/protocol`'s `validateRadioAddress`
 *
 * Both `RadioAddressDialog` and `ConfigurationPage` send a
 * `set-radio-override` message -- a user-dialled *override*, not a
 * name-derived address. The host's own authority for that message,
 * `packages/host/src/radioOverride.ts`'s `isValidRadioOverride`, checks
 * the raw hardware range (`channel` `0-83`, `group` `0-255`, both
 * integers, no oddness or reserved-group constraint) precisely because,
 * per that module's own doc comment, "an instructor may want any
 * hardware-valid nRF24 address, not only one a five-letter name could
 * derive." `@robot-console/protocol`'s `validateRadioAddress` checks a
 * narrower space instead -- the one `nameToRadioAddress` can actually
 * produce (odd channel `25-73`, group `1-126` excluding the reserved
 * `10`). Routing this override input through `validateRadioAddress`
 * would newly reject values the host accepts today (e.g. an even
 * channel, or `group: 10`) -- a real behavior change this ticket's
 * "pure extraction, no behavior change" mandate forbids, and it would
 * silently narrow the very case `isValidRadioOverride`'s own doc
 * comment says the wider range exists for. So this module re-states
 * `radioOverride.ts`'s two constants and its one check instead.
 *
 * ## Why this isn't just imported from `@robot-console/host`
 *
 * `radioOverride.ts` itself imports `mbrelayRegistry.ts` (reaching into
 * `store/index.ts`), which pulls in the host's server-only dependency
 * graph -- unsuitable for a browser bundle. Duplicating the two
 * constants and the one small range check here (rather than the whole
 * module) keeps client and host enforcing the identical rule without
 * sharing that module graph; the host's own `set-radio-override`
 * handler remains the authority regardless -- this only gives the two
 * dialogs immediate feedback before sending anything, same as before.
 */

/** Raw nRF24 channel range a user-supplied override may occupy --
 * mirrors `radioOverride.ts`'s `RADIO_CHANNEL_MIN`/`RADIO_CHANNEL_MAX`. */
export const RADIO_CHANNEL_MIN = 0;
export const RADIO_CHANNEL_MAX = 83;
/** Mirrors `radioOverride.ts`'s `RADIO_GROUP_MIN`/`RADIO_GROUP_MAX`. */
export const RADIO_GROUP_MIN = 0;
export const RADIO_GROUP_MAX = 255;

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
