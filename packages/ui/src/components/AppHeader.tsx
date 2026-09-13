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
 *
 * ## Sprint 015 ticket 009: the disconnected-from-host banner (UC-020)
 *
 * `no-disconnected-from-host-banner-in-the-ui.md` reported that a
 * dropped host connection was invisible: the last-known device list
 * stays on screen (by design, `WsProvider`'s own doc comment -- a drop
 * must not blank it out), so nothing told a student the page was no
 * longer live. This component -- already mounted once, above every
 * route -- is the single place that renders the fix: `useHostConnection()`
 * (ticket 007's `status`/`stale` pair) drives one banner, shown whenever
 * the socket is not `"open"` or the held snapshot is `stale` (a
 * reconnect landed but a fresh snapshot has not yet arrived to confirm
 * what's still true). The wording names which of the two applies
 * (`"connecting"` before the first-ever connect, `"closed"` while
 * reconnecting, open-but-stale immediately after a reconnect) rather
 * than one generic word, so a student mid-reconnect sees that progress
 * is happening, not just that something is wrong.
 *
 * ## Ticket 017-011: connection label + state, Connect/switch when not usable
 *
 * `connectionLabel` moves here (and to `FrontPage.tsx`) from a private
 * function this file used to duplicate -- both now read the one copy in
 * `deviceDisplay.ts`. Below the back-link row, whenever `link` resolves,
 * this header shows `connectionLabel(link)` and either its live state
 * text (`linkStateText`) when the link is usable, or a plain explanation
 * plus a Connect button and (when a sibling link on the same device is
 * usable) a "Use `<label>` instead" route link, when it is not -- see
 * `connectionStatusText`'s own doc comment for the exact two not-usable
 * cases distinguished. Both the Connect button (a `session-open` a
 * student explicitly presses) and the switch link (plain routing) are
 * the only two host-approved ways forward this ticket adds -- no new
 * client-side connection policy.
 *
 * **Extended scope (team-lead, 2026-09-13)**: the original ticket's own
 * "session undefined" gate is generalized to `isLinkUsable` (this
 * sprint's shared usable-link predicate) so this header also catches the
 * bench-reported case of a link that dropped (`unresponsive`/`failed`/
 * `stale`) while its session row is still technically present -- exactly
 * the situation that let `DriveControls` etc. render enabled against an
 * unreachable robot before this sprint's A-F fix.
 */
import { Link, useMatch } from "react-router";
import type { SnapshotDevice, SnapshotLink } from "@robot-console/host/src/wsMessages.js";
import { connectionLabel, isLinkUsable, linkStateText } from "../deviceDisplay";
import { useDeviceForLink, useHostConnection, useLink, useSendable, useWsActions } from "../ws/WsProvider";
import { FlashDialog } from "./FlashDialog";
import { RadioAddressDialog } from "./RadioAddressDialog";
import { WifiCredentialsDialog } from "./WifiCredentialsDialog";
import "./AppHeader.css";

/** The banner's text for each disconnected/stale combination -- `null`
 * when nothing needs saying (`status === "open" && !stale`). Exported
 * for `AppHeader.test.tsx`. */
export function disconnectedBannerText(status: "connecting" | "open" | "closed", stale: boolean): string | null {
  if (status === "connecting") {
    return "Connecting to the host…";
  }
  if (status === "closed") {
    return "Disconnected from the host — reconnecting…";
  }
  if (stale) {
    return "Reconnected — waiting for the latest state…";
  }
  return null;
}

/**
 * The header's connection-state text for a routed link that is NOT
 * usable -- two distinct cases (ticket 017-011, generalized by the
 * extended-scope item C):
 *
 *  - `link.session === undefined`: no session has ever been opened on
 *    this link (or it was explicitly closed) -- the ticket's own
 *    literal text, "No open session on this link".
 *  - `link.session !== undefined` but `link.state !== "connected"`: a
 *    session row is still present, but the link itself dropped
 *    (`unresponsive`/`failed`/`stale`/...) while the student may still
 *    be on this page -- "Not connected over `<label>`: `<reason>`" (the
 *    reason clause omitted when the link carries none).
 *
 * Callers must check {@link isLinkUsable} first; this function's
 * behavior for a usable link is unspecified (it is never called for
 * one -- `AppHeader` renders `linkStateText` instead in that case).
 */
export function connectionStatusText(link: SnapshotLink): string {
  if (link.session === undefined) {
    return "No open session on this link";
  }
  return link.reason ? `Not connected over ${connectionLabel(link)}: ${link.reason}` : `Not connected over ${connectionLabel(link)}`;
}

/** The first sibling link on `device` (other than `link` itself) that is
 * currently usable -- the header's "Use `<label>` instead" target.
 * `undefined` when `device` is absent (an unassigned link has no owning
 * device) or none of its other links are usable right now. */
function usableSiblingLink(device: SnapshotDevice | undefined, link: SnapshotLink): SnapshotLink | undefined {
  return device?.links.find((candidate) => candidate.id !== link.id && isLinkUsable(candidate));
}

export function AppHeader() {
  const homeMatch = useMatch("/");
  const deviceMatch = useMatch("/d/:linkId");
  const linkId = deviceMatch?.params.linkId;
  const link = useLink(linkId ?? "");
  const device = useDeviceForLink(linkId);
  const name = device?.name ?? link?.label ?? "";
  const { status, stale } = useHostConnection();
  const bannerText = disconnectedBannerText(status, stale);
  const { send } = useWsActions();
  const sendable = useSendable();
  const usable = link ? isLinkUsable(link) : false;
  const sibling = link ? usableSiblingLink(device, link) : undefined;

  return (
    <header className="app-header">
      {bannerText && (
        <p className="app-header-banner" role="status" data-testid="disconnected-banner">
          {bannerText}
        </p>
      )}
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
                linkOpen={isLinkUsable(link)}
                name={device.name}
                triggerClassName="app-header-flash-toggle"
              />
            )}
            <FlashDialog link={link} name={name} forceShow triggerClassName="app-header-flash-toggle" />
          </div>
        )}
      </div>
      {link && (
        <div className="app-header-connection" data-testid="app-header-connection">
          <span className="app-header-connection-label">{connectionLabel(link)}</span>
          {usable ? (
            <span className="app-header-connection-state" data-testid="app-header-connection-state">
              {linkStateText(link, undefined, device?.kind)}
            </span>
          ) : (
            <>
              <span className="app-header-connection-state app-header-not-usable" data-testid="app-header-not-usable">
                {connectionStatusText(link)}
              </span>
              <button
                type="button"
                className="app-header-connect"
                data-testid="app-header-connect"
                disabled={!sendable}
                onClick={() => send({ type: "session-open", linkId: link.id })}
              >
                Connect
              </button>
              {sibling && (
                <Link to={`/d/${sibling.id}`} className="app-header-switch-link" data-testid="app-header-switch-link">
                  Use {connectionLabel(sibling)} instead
                </Link>
              )}
            </>
          )}
        </div>
      )}
    </header>
  );
}
