/**
 * DevicePage.tsx — `/d/:endpointId`, a thin shell (ticket 007,
 * SUC-001) that ticket 008 fills in with per-type dispatch
 * (`classification.type`: `unknown` -> `UnknownDevicePage`, `relay` ->
 * `RelayPage`, `robot` -> `RobotPage`).
 *
 * This ticket's job is only to prove the route exists and reads the
 * right endpoint via `useEndpoint(endpointId)`, and to get the
 * deep-link states right (SUC-001's alternate flow):
 *
 *  - `!hasSnapshot` -> "Looking for this device…". The first
 *    `endpoints` snapshot is a round trip away from mount
 *    (`WsProvider`'s `hasSnapshot`, ticket 006) -- a bookmark opened
 *    before it arrives must not flash "not connected" for a device
 *    that is, in fact, attached.
 *  - `hasSnapshot && !endpoint` -> "This device isn't connected",
 *    with an explicit link back to `/`. Deliberately **not** an
 *    auto-redirect: yanking the student away mid-look is worse than a
 *    dead end with a way back (see `sprint.md`'s Scope boundary --
 *    the one exception, post-flash navigation, is ticket 008's own
 *    call, not this one's).
 *  - `hasSnapshot && endpoint` -> a minimal found-it stub; ticket 008
 *    replaces this with the real per-type page content.
 *
 * The same rule (render inline, never redirect) is what keeps this
 * page correct when an *open* device disappears out from under the
 * student -- there is no effect here that reacts to `endpoint` going
 * from present to absent by navigating anywhere.
 */
import { Link, useParams } from "react-router";
import { useEndpoint, useHasSnapshot } from "../ws/WsProvider";
import "./DevicePage.css";

export function DevicePage() {
  const { endpointId } = useParams<{ endpointId: string }>();
  const hasSnapshot = useHasSnapshot();
  const endpoint = useEndpoint(endpointId ?? "");

  if (!hasSnapshot) {
    return (
      <section className="device-page" aria-label="Device">
        <p className="device-page-status" role="status">
          Looking for this device…
        </p>
      </section>
    );
  }

  if (!endpoint) {
    return (
      <section className="device-page" aria-label="Device">
        <p className="device-page-status" role="status">
          This device isn't connected.
        </p>
        <Link to="/" className="device-page-back">
          Back to devices
        </Link>
      </section>
    );
  }

  return (
    <section className="device-page" aria-label="Device">
      {/* Ticket 008 replaces this stub with per-type dispatch
          (unknown/relay/robot) and the embedded `DeviceConsole`. */}
      <p>Device found: {endpoint.name ?? endpoint.endpointId}</p>
    </section>
  );
}
