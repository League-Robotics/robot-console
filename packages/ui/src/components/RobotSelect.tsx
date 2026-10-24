/**
 * RobotSelect.tsx — the robot-name picker (ticket 017-007; moved here
 * out of `RelayPage.tsx`, which owned it as a page-acting-as-library
 * module -- `docs/reviews/2026-09-11/04-ui.md` §4/§6, "`RobotSelect` +
 * `buildRobotOptions` exported from a *page*"). Shared by both of
 * `RelayPage.tsx`'s connect bars (not-connected and connected) via
 * `components/RelayConnectControls.tsx`'s own `"page"` variant.
 *
 * Every `kind: "robot"` device's name, host order sorted (no separate
 * "remembered vs. discovered" distinction any more; that whole roster/
 * discovery side-list pair is retired along with `EndpointsMessage`, see
 * `wsMessages.ts`'s module doc comment). Empty-roster case renders a
 * disabled placeholder option plus a hint rather than an empty, silently
 * unusable `<select>`.
 *
 * **De-duplicated defensively (ticket 017-010, bench defect "the same
 * robot appears twice", 2026-09-13)**: `options` de-dupes by name before
 * rendering. Every known caller already de-dupes its own `robotOptions`
 * list too (`FrontPage.tsx`/`RelayPage.tsx`), but an unmerged
 * `known-robots.json` placeholder sharing a name with its real,
 * currently-linked device is exactly the shape that would otherwise
 * offer the same robot name twice in this picker — this component does
 * not trust every caller to have already caught that.
 */
import { MAX_RADIO_CHANNEL, MAX_RADIO_GROUP, RAW_RADIO_OPTION_VALUE, parseRawRadioAddress } from "../lib/radioConnect";

export interface RawAddressText {
  channel: string;
  group: string;
}

export interface RobotSelectProps {
  options: string[];
  value: string;
  onChange: (name: string) => void;
  /** Passing both enables the leading "Channel/group" option. */
  rawAddress?: RawAddressText;
  onRawAddressChange?: (address: RawAddressText) => void;
}

export function RobotSelect({ options, value, onChange, rawAddress, onRawAddressChange }: RobotSelectProps) {
  const uniqueOptions = Array.from(new Set(options));
  const rawEnabled = rawAddress !== undefined && onRawAddressChange !== undefined;
  const empty = uniqueOptions.length === 0 && !rawEnabled;
  const rawSelected = rawEnabled && value === RAW_RADIO_OPTION_VALUE;
  const rawInvalid = rawSelected && parseRawRadioAddress(rawAddress.channel, rawAddress.group) === undefined;
  return (
    <>
      <label className="relay-robot-picker">
        <span>Robot</span>
        <select
          data-testid="relay-robot-select"
          value={value}
          disabled={empty}
          onChange={(event) => onChange(event.target.value)}
        >
          {empty ? (
            <option value="" disabled>
              No robots known yet — connect one over USB once
            </option>
          ) : (
            <>
              <option value="">Choose a robot…</option>
              {rawEnabled && <option value={RAW_RADIO_OPTION_VALUE}>Channel/group</option>}
              {uniqueOptions.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </>
          )}
        </select>
      </label>
      {rawSelected && (
        <span className="relay-raw-address" data-testid="relay-raw-address">
          <label>
            <span>Channel</span>
            <input
              type="number"
              inputMode="numeric"
              min={0}
              max={MAX_RADIO_CHANNEL}
              step={1}
              data-testid="relay-raw-channel"
              value={rawAddress.channel}
              aria-invalid={parseRawRadioAddress(rawAddress.channel, "0") === undefined}
              onChange={(event) => onRawAddressChange({ ...rawAddress, channel: event.target.value })}
            />
          </label>
          <label>
            <span>Group</span>
            <input
              type="number"
              inputMode="numeric"
              min={0}
              max={MAX_RADIO_GROUP}
              step={1}
              data-testid="relay-raw-group"
              value={rawAddress.group}
              aria-invalid={parseRawRadioAddress("0", rawAddress.group) === undefined}
              onChange={(event) => onRawAddressChange({ ...rawAddress, group: event.target.value })}
            />
          </label>
          {rawInvalid && (
            <span className="relay-raw-address-hint" role="alert" data-testid="relay-raw-invalid">
              Channel 0–{MAX_RADIO_CHANNEL}, group 0–{MAX_RADIO_GROUP}
            </span>
          )}
        </span>
      )}
    </>
  );
}
