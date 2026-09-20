/**
 * DevicePage.tsx — `/d/:linkId` (sprint 015 ticket 008, SUC-008;
 * rewritten against the `Snapshot` contract ticket 004/005/007
 * introduced -- issue `rearch-07-ui-renders-snapshot-drops-client-
 * policy.md`).
 *
 * ## Routes on `linkId`, not `endpointId`
 *
 * The retired `EndpointListEntry` folded a device's identity and its
 * one connection into a single flat "endpoint"; under the `Snapshot`
 * contract there is no such merged concept -- only a `linkId` (opaque,
 * `links.id`) that is either owned by a `SnapshotDevice` (inside
 * `devices[].links[]`) or listed bare in `unassigned[]`. So this page
 * now looks the routed id up as a link first (`useLink`), and separately
 * asks which device (if any) owns it (`useDeviceForLink`) -- there is no
 * longer a single "the endpoint" object to read both off of.
 *
 * ## Per-type dispatch, now driven by `device.kind`
 *
 * The old `classification.type` union (`"unknown" | "relay" | "robot" |
 * "calibration"`) no longer exists: `SnapshotDevice.kind` is only ever
 * `"robot" | "relay"` (architecture.md §4; `wsMessages.ts`), because a
 * board that has not yet identified has no `devices` row at all -- it is
 * an `unassigned` link, the direct successor of the old `"unknown"`
 * classification. `"calibration"` was always a `kind: "robot"` device
 * refined by its `program` string (`deviceType.ts`'s
 * `refineForCalibration`, `deviceDisplay.ts`'s `isCalibrationProgram`),
 * never its own dispatch arm -- `RobotPage` stays unaware of the
 * distinction, exactly as before. So the whole dispatch collapses to:
 *
 *  - no device owns this link (`unassigned`) -> `UnknownDevicePage`.
 *  - `device.kind === "relay"` -> `RelayPage`.
 *  - `device.kind === "robot"` -> `RobotPage`.
 *
 * `RobotPage.tsx` is migrated by sprint 015 ticket 009 to `{ device,
 * link }`, so the `"robot"` dispatch arm below passes both the resolved
 * `device` and the routed `link` this page already holds -- no more
 * unresolved-type gap at this call site.
 *
 * This module still owns the deep-link states from ticket 007
 * (SUC-001's alternate flow), unchanged in spirit:
 *
 *  - `!hasSnapshot` -> "Looking for this device…". The first snapshot
 *    is a round trip away from mount (`WsProvider`'s `hasSnapshot`) -- a
 *    bookmark opened before it arrives must not flash "not connected"
 *    for a device that is, in fact, attached.
 *  - `hasSnapshot && !link` -> "This device isn't connected". Deliberately
 *    **not** an auto-redirect: yanking the student away mid-look is
 *    worse than a dead end with a way back (`sprint.md`'s Scope
 *    boundary). The way back itself is `AppHeader`'s job (ticket
 *    012-004), not this module's -- this branch renders only its own
 *    status text.
 *  - `hasSnapshot && link` -> dispatch to the matching per-type page.
 *
 * **The WiFi auto-open effect is deleted, not adapted (this ticket's
 * own Description).** Sprint 10's fix-up had this component send
 * `{ type: "session-open", endpointId }` once on mount and again on
 * every open->closed transition for a `"wifi"`-transport endpoint --
 * transport-branched client connection policy living in a route
 * component (`docs/reviews/2026-09-11/04-ui.md` finding 1, "should be
 * host policy"). The reconciler (ticket 002's `planUserOpen`) now owns
 * that decision entirely: an explicit `session-open` only ever comes
 * from a user action (`RelayPage`'s Connect/Switch, `FrontPage`'s relay
 * quick-connect, a future "open a link" console hint) -- never from this
 * page reacting to a route match or a state transition on its own.
 *
 * ## Sprint 022 ticket 002: the one `ConsoleDock` mount for this route
 *
 * This module now also mounts `ConsoleDock` (see that component's own
 * doc comment) alongside whichever page it dispatches to, fed by the
 * same `link`/`device` this component already resolves. This is
 * additive, relocation-only work: every page dispatched to below still
 * mounts its own `ConsolePane`/`CommandStrip` unchanged, so the console
 * appears twice on screen until sprint 022 ticket 007 deletes the old
 * per-tab mounts.
 *
 * ## Sprint 022 ticket 006: the active console target
 *
 * `ConsoleDock`/`PopupConsoleWindow` are no longer fed this component's
 * own route-derived `link`/`device` directly -- they are fed
 * `activeTarget`, a piece of state this component owns and updates via
 * an `onActiveTargetChange` callback threaded down to whichever child
 * it dispatches to (see this file's own `ActiveConsoleTarget` type).
 * **Why this indirection exists at all, when for two of the three
 * dispatch arms it is a pure no-op:** `RelayPage.tsx` can silently
 * substitute a *different* page for its own content -- when a robot is
 * bridged through a relay, `RelayPage` renders `<RobotPage
 * device={child.device} link={child.link} />`, but this component's own
 * `useLink(linkId)`/`useDeviceForLink(linkId)` above still resolve to
 * the *relay's* link, because the URL never changes when a bridge comes
 * up or drops (`RelayPage`'s own Connect/Disconnect are `session-open`/
 * `session-close` messages, not navigations). The stakeholder was
 * explicit and specific about this when asked directly (sprint 022,
 * 2026-09-20): the console must always show "whatever device I'm
 * showing on the main screen" -- the *bridged robot*, not the relay the
 * URL happens to name. `RobotPage`/`UnknownDevicePage` report their own
 * `link`/`name` as `activeTarget` too, even though that is always
 * exactly what this component's own route resolution would already
 * hand `ConsoleDock` -- not because either of them ever disagrees with
 * the route, but so `RelayPage`'s one genuinely divergent case can share
 * a single mechanism with every other dispatch arm instead of getting
 * its own special-cased wiring bolted on beside it. See `RelayPage.tsx`'s
 * own doc comment for the bridging/idle branch that actually produces
 * the divergence, and `sprint.md`'s Architecture §Step 3 module 4 /
 * Design Rationale for the full decision record (flagged there, still
 * under Open Questions, as a case the stakeholder had not been asked
 * about directly until this ticket).
 *
 * `activeTarget` starts `null` and `target` below falls back to this
 * component's own route-derived default (`routeTarget`) whenever it is
 * -- that fallback only ever covers the one-or-two-render gap before
 * the freshly (re)mounted or freshly re-rendered child's own
 * report-on-change effect has fired for the *current* route; once a
 * child has reported at least once for the current link, `activeTarget`
 * is authoritative and `routeTarget` is never consulted again until the
 * next real change. Navigating to `/` unmounts this whole component
 * (and therefore `ConsoleDock`/`PopupConsoleWindow` beneath it) --
 * `ConsoleDock.tsx`'s own doc comment covers why that unmount must
 * *explicitly* call `close()` on any live popup rather than counting on
 * unmounting to do it implicitly (it does not: a real `window.open`
 * result is a separate browser window with its own lifetime, not
 * something that closes itself just because the React tree that once
 * portaled into it goes away).
 *
 * ## Sprint 022 ticket 003: the dock's own flex column wrapper
 *
 * Per sprint.md's Design Rationale ("the dock takes layout space at the
 * bottom of the page... not a page-covering overlay"): each of the
 * three dispatch arms below now wraps its dispatched page plus
 * `consoleDock` in `.device-page-shell`, a plain flex column. Several
 * pages already put their own controls at the bottom of a column (the
 * Copy button on both code blocks, `CalibrationTable`'s "Start over",
 * `DriveTab`'s `PathTracePanel`) — an overlay would sit on top of those
 * whenever the dock is open; a flex column instead stacks the dock
 * *after* the page content in normal document flow, so opening it can
 * never cover anything, only push it up. `App.tsx`/`main.tsx`/
 * `FrontPage.tsx` need no change, matching that Design Rationale entry:
 * this wrapper lives entirely inside `DevicePage`'s own render, and `/`
 * is never in this component's subtree.
 */
import { useCallback, useState } from "react";
import { useParams } from "react-router";
import type { SnapshotLink } from "@robot-console/host/src/wsMessages.js";
import { useDeviceForLink, useHasSnapshot, useLink } from "../ws/WsProvider";
import { UnknownDevicePage } from "./UnknownDevicePage";
import { RelayPage } from "./RelayPage";
import { RobotPage } from "./RobotPage";
import { ConsoleDock } from "../components/console-dock/ConsoleDock";
import "./DevicePage.css";

/**
 * The "active console target" `ConsoleDock`/`PopupConsoleWindow` are
 * fed -- see this module's own doc comment, "Sprint 022 ticket 006,"
 * for the full reasoning. Exported so `RobotPage.tsx`/`RelayPage.tsx`/
 * `UnknownDevicePage.tsx` share this exact shape for their
 * `onActiveTargetChange` prop rather than each declaring an
 * equivalent-but-separately-typed inline object literal.
 */
export interface ActiveConsoleTarget {
  link: SnapshotLink;
  name: string;
}

export function DevicePage() {
  const { linkId } = useParams<{ linkId: string }>();
  const hasSnapshot = useHasSnapshot();
  const link = useLink(linkId ?? "");
  const device = useDeviceForLink(linkId);

  // Sprint 022 ticket 006: see this module's own doc comment section of
  // the same name for the full reasoning. Declared unconditionally,
  // above every early return below, like every other hook in this
  // component.
  const [activeTarget, setActiveTarget] = useState<ActiveConsoleTarget | null>(null);
  const handleActiveTargetChange = useCallback((target: ActiveConsoleTarget) => {
    setActiveTarget(target);
  }, []);

  if (!hasSnapshot) {
    return (
      <section className="device-page" aria-label="Device">
        <p className="device-page-status" role="status">
          Looking for this device…
        </p>
      </section>
    );
  }

  if (!link) {
    return (
      <section className="device-page" aria-label="Device">
        <p className="device-page-status" role="status">
          This device isn't connected.
        </p>
      </section>
    );
  }

  // The route's own default target: correct on its own for the
  // `UnknownDevicePage`/`RobotPage` dispatch arms below in every case
  // (their own `onActiveTargetChange` report is a no-op relative to
  // this), and correct for the `RelayPage` arm only while no child is
  // bridged. `target` immediately below is what actually reaches
  // `ConsoleDock` -- see this module's own doc comment, "Sprint 022
  // ticket 006," for why `activeTarget` must win once a child has
  // reported at least once for the current route.
  const routeTarget: ActiveConsoleTarget = { link, name: device?.name ?? link.label };
  const target = activeTarget ?? routeTarget;
  const consoleDock = <ConsoleDock link={target.link} name={target.name} />;

  if (!device) {
    // No `devices` row owns this link -- the direct successor of the
    // old `"unknown"` classification (see this module's own doc
    // comment).
    return (
      <div className="device-page-shell">
        <UnknownDevicePage link={link} onActiveTargetChange={handleActiveTargetChange} />
        {consoleDock}
      </div>
    );
  }

  switch (device.kind) {
    case "relay":
      return (
        <div className="device-page-shell">
          <RelayPage device={device} onActiveTargetChange={handleActiveTargetChange} />
          {consoleDock}
        </div>
      );
    case "robot":
      return (
        <div className="device-page-shell">
          <RobotPage device={device} link={link} onActiveTargetChange={handleActiveTargetChange} />
          {consoleDock}
        </div>
      );
    default: {
      // `SnapshotDevice.kind` is a closed `"robot" | "relay"` union today
      // (wsMessages.ts) -- this arm exists only so a future third kind
      // fails loudly here (a tsc error on the `never` assignment) rather
      // than silently falling through to nothing rendered.
      const exhaustive: never = device.kind;
      throw new Error(`DevicePage: unrecognized device kind ${String(exhaustive)}`);
    }
  }
}
