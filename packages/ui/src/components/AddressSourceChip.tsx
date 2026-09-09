/**
 * AddressSourceChip.tsx — a small, persistent inline chip that discloses
 * where a relay-mediated endpoint's `(channel, group)` address came from
 * (sprint 8 ticket 006 / SUC-006).
 *
 * ## Prop shape (deliberately narrower than `EndpointListEntry`)
 *
 * This component takes the four fields it actually reads --
 * {@link AddressSourceChipProps.addressSource}, {@link
 * AddressSourceChipProps.viaRelay} (channel/group only), {@link
 * AddressSourceChipProps.transport} (a defensive `mbserial` guard, see
 * below), {@link AddressSourceChipProps.registryWasConsidered}, and
 * {@link AddressSourceChipProps.failoverTrail} -- rather than the full
 * `EndpointListEntry`. A caller (`RelayPage`, ticket 005) passes these
 * straight through from an entry's own fields of the same names; this
 * component never reaches into `EndpointListEntry` itself, so it has no
 * `WsProvider` dependency and is fully testable against fixture props
 * alone, per the ticket.
 *
 * ## The neutral/warning decision rule (`sprint.md`'s Solution)
 *
 * The chip is styled **neutrally** whenever the source is trustworthy or
 * the registry was never in the picture at all, and as a **warning**
 * only when a registry existed for this resolution attempt but did not
 * give an authoritative answer:
 *
 *   - `"config"` / `"registry"` — the registry (or its configured
 *     override) actually knew. Neutral.
 *   - `"explicit"` — the user typed the address on the relay page
 *     themselves; nothing to warn about. Neutral.
 *   - `"local-derived"` with no registry ever discovered
 *     (`registryWasConsidered: false`) — the *normal* local-USB-relay
 *     classroom path (no `mbrelay` daemon on the LAN at all), not an
 *     exceptional one. Neutral. Text: `derived (no registry)`, matching
 *     `sprint.md`'s own example.
 *   - `"local-derived"` with a registry that *was* discovered but the
 *     resolution attempt still fell back (`registryWasConsidered: true`,
 *     e.g. an unreachable/timed-out registry) — surfaced as prominently
 *     as `"derived"` below, because this failure mode is identical to
 *     the registry simply not knowing. Warning.
 *   - `"derived"` — the registry replied but only echoed back our own
 *     just-made guess, i.e. it *did* reply, so a registry was always
 *     "considered" for this outcome. Warning.
 *
 * Getting this rule backwards (warning when it should be neutral, or
 * vice versa) is exactly the alarm-fatigue-vs-silence failure mode this
 * sprint's design exists to avoid -- see `sprint.md`'s Solution section,
 * "Fallback disclosure, tuned against alarm fatigue".
 *
 * The chip is **never silent** for a relay-mediated, non-`mbserial`
 * session that is open: a caller with no `addressSource` for such an
 * endpoint is itself a bug elsewhere (mirrors `sprint.md`'s "the chip
 * must never be silent" / spec §6, UC-004) -- but *this* component's own
 * degrade-safely case is simpler: no `addressSource` prop at all (or an
 * `mbserial` `transport`) renders nothing, since there is nothing to
 * disclose (`mbserial` has no address-source concept -- sprint 007's
 * Design Rationale). Mounting decisions for a real endpoint are ticket
 * 005's job (`RelayPage`), not this component's.
 */
import type { AddressSource, EndpointTransport, FailoverTrailEntry } from "@robot-console/host/src/wsMessages.js";
import "./AddressSourceChip.css";

export interface AddressSourceChipProps {
  /** Which resolution outcome produced the address currently in use.
   * `undefined` means "nothing to disclose" -- the chip renders
   * nothing. Mirrors `EndpointListEntry.addressSource`. */
  addressSource?: AddressSource;
  /** The `(channel, group)` currently in use -- only the two fields this
   * chip renders, out of `EndpointListEntry.viaRelay`'s full shape. */
  viaRelay?: { channel: number; group: number };
  /** Defensive `mbserial` guard: `EndpointListEntry.addressSource` is
   * already only ever populated for a non-`mbserial` transport
   * (`wsMessages.ts`), so a real caller following that contract never
   * triggers this branch -- it exists so this component degrades safely
   * even if it is ever handed one anyway, per the ticket's acceptance
   * criteria. */
  transport?: EndpointTransport;
  /** Was a registry service ever discovered/attempted for this
   * resolution, regardless of whether it answered authoritatively? This
   * is distinct from `addressSource` itself: two different resolution
   * histories both produce `"local-derived"` -- no registry ever
   * discovered on the LAN at all (the ordinary classroom path,
   * `registryWasConsidered: false`) vs. a registry that was discovered
   * but the resolution attempt still fell back to a local guess
   * (`registryWasConsidered: true`, e.g. it timed out) -- and only the
   * second is a warning. Defaults to `false` (nothing considered), the
   * neutral-favoring default matching the ordinary classroom path. */
  registryWasConsidered?: boolean;
  /** Every candidate `RelayConnectionCoordinator.ts` abandoned before
   * reaching the address currently in use -- mirrors
   * `EndpointListEntry.failoverTrail`. Rendered as plain visible text
   * when non-empty, never behind a disclosure control (per the ticket:
   * this sprint's design treats silence as its own failure mode).
   * Defaults to `[]` (nothing to report). */
  failoverTrail?: FailoverTrailEntry[];
}

type ChipVariant = "neutral" | "warning";

interface ChipPresentation {
  variant: ChipVariant;
  /** The text after the "·" separator, e.g. "derived (no registry)". */
  sourceText: string;
}

/** The neutral/warning decision rule, isolated as a pure function so the
 * five outcomes (see this module's own doc comment) are each covered by
 * exactly one branch here, with no rendering concerns mixed in. */
function presentationFor(addressSource: AddressSource, registryWasConsidered: boolean): ChipPresentation {
  switch (addressSource) {
    case "config":
      return { variant: "neutral", sourceText: "from config" };
    case "registry":
      return { variant: "neutral", sourceText: "confirmed by registry" };
    case "explicit":
      return { variant: "neutral", sourceText: "entered by you" };
    case "derived":
      return { variant: "warning", sourceText: "derived (registry echoed guess)" };
    case "local-derived":
      return registryWasConsidered
        ? { variant: "warning", sourceText: "derived (registry unreachable)" }
        : { variant: "neutral", sourceText: "derived (no registry)" };
  }
}

/** Renders `failoverTrail` as one line of plain visible text -- e.g.
 * `gave up on relay-a (no reply), tried relay-b (timeout)` -- never
 * behind a disclosure. The first abandoned candidate reads "gave up
 * on"; every candidate after it reads "tried", chaining the whole
 * sequence of abandoned attempts into one sentence. */
function formatFailoverTrail(trail: FailoverTrailEntry[]): string {
  return trail
    .map((entry, index) =>
      index === 0 ? `gave up on ${entry.name} (${entry.reason})` : `tried ${entry.name} (${entry.reason})`,
    )
    .join(", ");
}

export function AddressSourceChip({
  addressSource,
  viaRelay,
  transport,
  registryWasConsidered = false,
  failoverTrail = [],
}: AddressSourceChipProps) {
  // Nothing to disclose: no source at all, or (defensively) an
  // `mbserial` transport, which has no address-source concept -- see
  // this module's own doc comment.
  if (!addressSource || transport === "mbserial") {
    return null;
  }

  const { variant, sourceText } = presentationFor(addressSource, registryWasConsidered);
  const addressText = viaRelay ? `ch ${viaRelay.channel} / grp ${viaRelay.group}` : null;

  return (
    <div
      className={`address-source-chip address-source-chip-${variant}`}
      data-testid="address-source-chip"
      data-variant={variant}
    >
      <span className="address-source-chip-text">
        Address{addressText ? `: ${addressText}` : ""} · {sourceText}
      </span>
      {failoverTrail.length > 0 && (
        <span className="address-source-chip-trail" data-testid="address-source-chip-trail">
          {formatFailoverTrail(failoverTrail)}
        </span>
      )}
    </div>
  );
}
