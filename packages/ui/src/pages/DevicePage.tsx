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
 */
import { useParams } from "react-router";
import { useDeviceForLink, useHasSnapshot, useLink } from "../ws/WsProvider";
import { UnknownDevicePage } from "./UnknownDevicePage";
import { RelayPage } from "./RelayPage";
import { RobotPage } from "./RobotPage";
import "./DevicePage.css";

export function DevicePage() {
  const { linkId } = useParams<{ linkId: string }>();
  const hasSnapshot = useHasSnapshot();
  const link = useLink(linkId ?? "");
  const device = useDeviceForLink(linkId);

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

  if (!device) {
    // No `devices` row owns this link -- the direct successor of the
    // old `"unknown"` classification (see this module's own doc
    // comment).
    return <UnknownDevicePage link={link} />;
  }

  switch (device.kind) {
    case "relay":
      return <RelayPage device={device} />;
    case "robot":
      return <RobotPage device={device} link={link} />;
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
