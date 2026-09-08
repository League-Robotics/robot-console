/**
 * AppHeader.tsx — route-aware app header (ticket 012-004, SUC-003/
 * SUC-004), mounted once in `App.tsx` above `<AppRoutes />` as a
 * sibling of the route tree, not a descendant of it.
 *
 * Closes out this sprint's two remaining stakeholder issues:
 *
 *  - **Back-to-devices link**
 *    (`device-page-needs-a-back-button-to-the-device-list.md`): before
 *    this ticket, each `DevicePage.tsx` branch made its own decision
 *    about whether to render a way back to `/`, and the `!hasSnapshot`
 *    loading branch — the actual dead end the issue is about — had
 *    none at all. Living here instead means there is exactly one
 *    render path for the link, so it covers all five device-page
 *    states (loading, not-connected, relay, robot, unknown) — and any
 *    future nested route under `/d/:endpointId` — for free, with no
 *    per-branch special-casing. `DevicePage.tsx`'s own not-connected
 *    `<Link>` is removed by this ticket; this component is now the
 *    single source of the back control (see this sprint's Design
 *    Rationale, "AppHeader, not a shared per-page chrome wrapper").
 *  - **Flash top-menu entry**
 *    (`flash-controls-unreachable-for-silent-boards-and-missing-from-
 *    every-device-page.md`, defect 3): a way to reflash *any*
 *    resolvable device from one stable screen position, not just the
 *    ones `FlashControls`' own `canBeFlashed` gate already covers on
 *    `UnknownDevicePage`/the front-page card.
 *
 * **Why `useMatch`, not `useParams`**: this component sits outside
 * `DevicePage`'s route element (a sibling of `<AppRoutes />` in
 * `App.tsx`), so there is no enclosing `<Route path="/d/:endpointId">`
 * for `useParams` to read here. `useMatch("/d/:endpointId")` runs
 * `react-router`'s own path-matching engine — the same one
 * `router.tsx`'s route table is built on — directly against the
 * current location regardless of where in the tree it's called from,
 * rather than a second, hand-rolled `location.pathname` regex. The
 * resolved `endpointId` is then fed into `useEndpoint`, the same
 * `WsProvider`-backed hook `DevicePage.tsx` itself uses, so this
 * component introduces no second way of reading endpoint state.
 * `useMatch("/")` (rather than a `location.pathname === "/"` string
 * check) decides back-link visibility for the same reason — one
 * matching engine, used consistently.
 *
 * **The `canBeFlashed` vs. identified-device tension, resolved**:
 * `FlashControls` self-gates on `canBeFlashed` (`role === null`) and
 * renders `null` for a device that has already identified — exactly
 * right for its other call sites (the front-page card,
 * `UnknownDevicePage`), which only ever want the *recovery* flow for a
 * device that hasn't identified yet. But this issue's own stakeholder
 * quote asks for Flash to work on an identified robot or relay too
 * ("When I go into a Micro:bit, I often want to reflash it to
 * something"). Rather than fork a second copy of `FlashControls`'
 * intricate progress/error/local-hex state machine for identified
 * devices (the drift this sprint's `FlashControls` extraction exists
 * to prevent — see this sprint's Design Rationale), `FlashControls`
 * grows one new opt-in prop, `forceShow` (default `false`, so its
 * three existing call sites are byte-for-byte unaffected): this header
 * is the one caller that has *already* made its own decision about
 * whether flashing should be offered right now — present only when a
 * route/endpoint match resolves, gated behind an explicit confirmation
 * for an identified device — by the time it renders `FlashControls`,
 * so it passes `forceShow` to make that decision stick regardless of
 * `canBeFlashed`'s verdict.
 *
 * **Confirmation step**: reflashing a device that has already
 * identified (`relay`/`robot`) is more destructive than recovering a
 * silent, unflashed one (this sprint's Design Rationale), so clicking
 * Flash for an identified device first asks via a plain
 * `window.confirm()` — the simplest implementation satisfying "an
 * explicit confirmation step" for this first cut, chosen over a
 * bespoke in-page dialog. Its exact wording/UX is flagged in
 * `sprint.md`'s Open Questions for stakeholder sign-off once this is
 * in front of them. An `unknown` device (not yet identified) skips the
 * confirmation and opens `FlashControls` directly, matching the flow
 * `UnknownDevicePage` already has today.
 */
import { useEffect, useState } from "react";
import { Link, useMatch } from "react-router";
import { useEndpoint } from "../ws/WsProvider";
import { canBeFlashed } from "../deviceDisplay";
import { FlashControls } from "./FlashControls";
import "./AppHeader.css";

export function AppHeader() {
  const homeMatch = useMatch("/");
  const deviceMatch = useMatch("/d/:endpointId");
  const endpointId = deviceMatch?.params.endpointId;
  const endpoint = useEndpoint(endpointId ?? "");

  const [flashOpen, setFlashOpen] = useState(false);

  // A Flash panel opened for one device must not silently carry over
  // to the next -- reset whenever the matched endpointId changes
  // (including transitions to/from no match at all).
  useEffect(() => {
    setFlashOpen(false);
  }, [endpointId]);

  const handleFlashClick = () => {
    if (!endpoint) {
      return;
    }
    if (!canBeFlashed(endpoint)) {
      // Identified device (relay/robot) -- see this module's doc
      // comment's confirmation-step decision. Declining leaves
      // FlashControls unopened (SUC-003's acceptance criteria).
      const confirmed = window.confirm(
        `Reflash "${endpoint.name ?? endpoint.endpointId}"? This will interrupt whatever it's currently running.`,
      );
      if (!confirmed) {
        return;
      }
    }
    setFlashOpen(true);
  };

  return (
    <header className="app-header">
      <div className="app-header-bar">
        <h1>robot-console</h1>
        {!homeMatch && (
          <Link to="/" className="app-header-back">
            Back to devices
          </Link>
        )}
        {endpoint && (
          <button
            type="button"
            className="app-header-flash-toggle"
            aria-expanded={flashOpen}
            onClick={handleFlashClick}
          >
            Flash
          </button>
        )}
      </div>
      {endpoint && flashOpen && (
        <div className="app-header-flash-panel">
          {/* `forceShow` -- see this module's doc comment's
              `canBeFlashed` reconciliation -- makes FlashControls
              render for an identified (relay/robot) device too,
              which its own default gate would otherwise suppress. */}
          <FlashControls endpoint={endpoint} forceShow />
        </div>
      )}
    </header>
  );
}
