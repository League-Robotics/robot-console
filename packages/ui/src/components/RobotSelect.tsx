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
export interface RobotSelectProps {
  options: string[];
  value: string;
  onChange: (name: string) => void;
}

export function RobotSelect({ options, value, onChange }: RobotSelectProps) {
  const uniqueOptions = Array.from(new Set(options));
  const empty = uniqueOptions.length === 0;
  return (
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
            {uniqueOptions.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </>
        )}
      </select>
    </label>
  );
}
