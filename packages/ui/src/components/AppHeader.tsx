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
 *    ones `FlashDialog`'s own `canBeFlashed` gate already covers on
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
 * `FlashDialog`'s trigger self-gates on `canBeFlashed` (`role === null`)
 * and offers no trigger for a device that has already identified --
 * exactly right for its other call sites (the front-page card,
 * `UnknownDevicePage`), which only ever want the *recovery* flow for a
 * device that hasn't identified yet. But this issue's own stakeholder
 * quote asks for Flash to work on an identified robot or relay too
 * ("When I go into a Micro:bit, I often want to reflash it to
 * something"). Rather than fork a second copy of `FlashDialog`/
 * `FlashControls`' intricate progress/error/local-hex state machine for
 * identified devices (the drift this sprint's `FlashControls`
 * extraction exists to prevent — see this sprint's Design Rationale),
 * `FlashDialog` grows one opt-in prop, `forceShow` (default `false`, so
 * its other call sites are byte-for-byte unaffected): this header is
 * the one caller that has *already* made its own decision about whether
 * flashing should be offered right now — present only when a
 * route/endpoint match resolves — so it passes `forceShow` to make that
 * decision stick regardless of `canBeFlashed`'s verdict.
 *
 * **Confirmation step, removed (out-of-process work, 2026-09-08)**:
 * this used to gate opening `FlashControls` for an identified device
 * behind a `window.confirm()`. Now that the whole flow runs inside
 * `FlashDialog`'s popup modal -- itself a deliberate, dismissible
 * surface the student has to explicitly open and look at before
 * anything is sent -- a second, blocking native confirmation on top of
 * it earned nothing but an extra click. `FlashDialog` shows an in-modal
 * warning line instead when opened for an identified device (via
 * `forceShow`); see its own doc comment. An `unknown` device (not yet
 * identified) opens the dialog directly with no warning line, matching
 * the flow `UnknownDevicePage` already has today.
 */
import { Link, useMatch } from "react-router";
import { useEndpoint } from "../ws/WsProvider";
import { FlashDialog } from "./FlashDialog";
import "./AppHeader.css";

export function AppHeader() {
  const homeMatch = useMatch("/");
  const deviceMatch = useMatch("/d/:endpointId");
  const endpointId = deviceMatch?.params.endpointId;
  const endpoint = useEndpoint(endpointId ?? "");

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
          <FlashDialog
            endpoint={endpoint}
            forceShow
            triggerClassName="app-header-flash-toggle"
          />
        )}
      </div>
    </header>
  );
}
