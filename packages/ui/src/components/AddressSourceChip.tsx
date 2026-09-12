/**
 * AddressSourceChip.tsx — a small, persistent inline chip that discloses
 * where a device's `(channel, group)` radio address came from (sprint 8
 * ticket 006 / SUC-006).
 *
 * ## Sprint 015 ticket 008: reads `device.radio` from the snapshot
 *
 * The pre-rearch version took four fields lifted off the retired
 * `EndpointListEntry` (`addressSource`, `viaRelay`, `transport` as an
 * `mbserial` guard, `registryWasConsidered`, `failoverTrail`) --
 * `RelayPage.ts`'s own five-outcome `AddressSource` model
 * (`"config"|"registry"|"explicit"|"derived"|"local-derived"`), plus a
 * client-reconstructed "was a registry ever discovered" fact and a
 * per-attempt failover trail. That whole model is retired: the wire
 * contract now reports exactly one three-way {@link RadioSourceWire}
 * per device (`"override"|"registry"|"derived"`, `wsMessages.ts`'s
 * `SnapshotDevice.radio.source`), always already resolved
 * `override -> registry -> derived` host-side
 * (`radioOverride.ts`'s `resolveDeviceRadio`) -- there is no
 * "registry replied but only echoed a guess" vs. "no registry ever
 * discovered" distinction left for this chip to make on its own
 * (`registryWasConsidered`), and no per-attempt `failoverTrail` at all
 * (a relay child switch is one reconciler job now, ticket 002 -- not a
 * sequence of abandoned candidates this component would have anything
 * to disclose about). So this component takes exactly one prop, the
 * device's own already-resolved `radio` field, and reads `radio.source`
 * for the decision -- literally `device.radio.source` at every call
 * site (`RelayPage.tsx`'s connected child, `ConfigurationPage.tsx`'s own
 * device), never a value reconstructed client-side.
 *
 * Every outcome is presentation-neutral now (no warning styling): the
 * new model's `"derived"` is architecture.md's own "a default, not a
 * failure" (`wsMessages.ts`'s `SnapshotDevice.radio` doc comment) --
 * unlike the old `"derived"`/one flavor of `"local-derived"`, which
 * meant a registry actually failed to answer authoritatively, this
 * chip has no host-reported signal left to justify an alarm-styled
 * variant, so it does not fabricate one (mirrors
 * `docs/reviews/2026-09-11/04-ui.md` finding 9's own point about not
 * inferring a host-side fact from unrelated data).
 */
import type { RadioSourceWire } from "@robot-console/host/src/wsMessages.js";
import "./AddressSourceChip.css";

export interface AddressSourceChipProps {
  /** The device's already-resolved radio address -- mirrors
   * `SnapshotDevice.radio` exactly, so a caller can pass it straight
   * through with no reshaping. */
  radio: { channel: number; group: number; source: RadioSourceWire };
}

/** Student-facing text for one {@link RadioSourceWire} outcome. Matches
 * `ConfigurationPage.tsx`'s former `radioSourceLabel` wording verbatim --
 * that function is retired in favor of this shared component (this
 * ticket's own acceptance criterion). */
function sourceText(source: RadioSourceWire): string {
  switch (source) {
    case "override":
      return "set for this device";
    case "registry":
      return "confirmed by registry";
    case "derived":
      return "derived from the name";
  }
}

export function AddressSourceChip({ radio }: AddressSourceChipProps) {
  return (
    <div className="address-source-chip" data-testid="address-source-chip">
      <span className="address-source-chip-text">
        Address: ch {radio.channel} / grp {radio.group} · {sourceText(radio.source)}
      </span>
    </div>
  );
}
