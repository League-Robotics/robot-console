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
 *    future nested route under `/d/:linkId` — for free, with no
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
 * `App.tsx`), so there is no enclosing `<Route path="/d/:linkId">` for
 * `useParams` to read here. `useMatch("/d/:linkId")` runs
 * `react-router`'s own path-matching engine — the same one
 * `router.tsx`'s route table is built on — directly against the
 * current location regardless of where in the tree it's called from,
 * rather than a second, hand-rolled `location.pathname` regex.
 * `useMatch("/")` (rather than a `location.pathname === "/"` string
 * check) decides back-link visibility for the same reason — one
 * matching engine, used consistently.
 *
 * **The `canBeFlashed` vs. identified-device tension, resolved**:
 * `FlashDialog`'s trigger self-gates on `canBeFlashed`
 * (`link.capabilities.flash`) and offers no trigger for a link that has
 * already identified with a role -- exactly right for its other call
 * sites (the front-page's unassigned-board card, `UnknownDevicePage`),
 * which only ever want the *recovery* flow for a device that hasn't
 * identified yet. But this issue's own stakeholder quote asks for Flash
 * to work on an identified robot or relay too ("When I go into a
 * Micro:bit, I often want to reflash it to something"). Rather than
 * fork a second copy of `FlashDialog`/`FlashControls`' intricate
 * progress/error/local-hex state machine for identified devices (the
 * drift this sprint's `FlashControls` extraction exists to prevent),
 * `FlashDialog` grows one opt-in prop, `forceShow` (default `false`, so
 * its other call sites are byte-for-byte unaffected): this header is
 * the one caller that has *already* made its own decision about whether
 * flashing should be offered right now — present only when a
 * route/link match resolves — so it passes `forceShow` to make that
 * decision stick regardless of `canBeFlashed`'s verdict.
 *
 * ## Sprint 015 ticket 008: `/d/:linkId`, Flash/Set Wi-Fi restored
 *
 * The route param itself is renamed from `:endpointId` to `:linkId`
 * (matching `router.tsx`'s own rename) -- this component resolves the
 * routed link directly (`useLink`) as well as its owning device, if
 * any (`useDeviceForLink`, matching by `linkId` membership in some
 * device's `links[]`). `FlashDialog` is offered for *any* resolvable
 * link (owned or not -- mirrors the pre-ticket-007 "any endpoint"
 * behavior: a board that hasn't identified yet can still be reflashed
 * from here, alongside its own on-page trigger); `RadioAddressDialog`/
 * `WifiCredentialsDialog` need an actual device (a numeric `deviceId`
 * for the former, a name for both), so those two stay gated on `device
 * && device.kind !== "relay"` as they were pending this ticket
 * (`RadioAddressDialog`'s own gate, ticket 006/007) --
 * `FlashDialog`/`WifiCredentialsDialog` were temporarily dropped here by
 * ticket 007 pending this migration; both are back.
 */
import { Link, useMatch } from "react-router";
import { useDeviceForLink, useLink } from "../ws/WsProvider";
import { FlashDialog } from "./FlashDialog";
import { RadioAddressDialog } from "./RadioAddressDialog";
import { WifiCredentialsDialog } from "./WifiCredentialsDialog";
import "./AppHeader.css";

export function AppHeader() {
  const homeMatch = useMatch("/");
  const deviceMatch = useMatch("/d/:linkId");
  const linkId = deviceMatch?.params.linkId;
  const link = useLink(linkId ?? "");
  const device = useDeviceForLink(linkId);
  const name = device?.name ?? link?.label ?? "";

  return (
    <header className="app-header">
      <div className="app-header-bar">
        <h1>robot-console</h1>
        {!homeMatch && (
          <Link to="/" className="app-header-back" aria-label="Back to devices" title="Back to devices">
            <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false">
              <polyline points="15 5 8 12 15 19" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
              <line x1="20" y1="12" x2="8" y2="12" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
            </svg>
          </Link>
        )}
        {link && (
          <div className="app-header-actions">
            {/* Set Radio / Set Wi-Fi for any robot (not a relay) -- see
                RadioAddressDialog/WifiCredentialsDialog. Both need an
                actual identified device (a numeric deviceId, a name),
                so they stay gated on `device` existing -- unlike Flash
                below, which is offered for any resolvable link. */}
            {device && device.kind !== "relay" && (
              <RadioAddressDialog deviceId={device.id} name={device.name} radio={device.radio} triggerClassName="app-header-flash-toggle" />
            )}
            {device && device.kind !== "relay" && (
              <WifiCredentialsDialog
                linkId={link.id}
                linkOpen={link.session !== undefined}
                name={device.name}
                triggerClassName="app-header-flash-toggle"
              />
            )}
            <FlashDialog link={link} name={name} forceShow triggerClassName="app-header-flash-toggle" />
          </div>
        )}
      </div>
    </header>
  );
}
