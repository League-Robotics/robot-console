/**
 * DevicePage.tsx — `/d/:endpointId` (ticket 007, SUC-001), now with
 * ticket 008's per-type dispatch filled in: `classification.type`
 * `"relay"` -> `RelayPage`, `"robot"` -> `RobotPage`, and a `default`
 * arm -> `UnknownDevicePage` covering both `"unknown"` and any
 * classification `type` this client doesn't recognize. That `default`
 * arm is the actual mechanism behind the "a fourth device type is
 * purely additive" contract (`wsMessages.ts`'s module doc comment) --
 * `normalizeDeviceType` (ticket 001, `protocol/deviceType.ts`) is what
 * guarantees the *value* reaching here is already safe, but this
 * switch's `default` is what a client actually does with it.
 *
 * This module still owns the deep-link states from ticket 007
 * (SUC-001's alternate flow), unchanged:
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
 *    the one exception, post-flash navigation, is `FlashControls`'
 *    own call (mounted from `UnknownDevicePage`, and from
 *    `FrontPage.tsx`'s card, ticket 012-002), not this module's).
 *  - `hasSnapshot && endpoint` -> dispatch to the matching per-type
 *    page below.
 *
 * The same rule (render inline, never redirect) is what keeps this
 * page correct when an *open* device disappears out from under the
 * student -- there is no effect here that reacts to `endpoint` going
 * from present to absent by navigating anywhere.
 */
import { Link, useParams } from "react-router";
import { useEndpoint, useHasSnapshot } from "../ws/WsProvider";
import { UnknownDevicePage } from "./UnknownDevicePage";
import { RelayPage } from "./RelayPage";
import { RobotPage } from "./RobotPage";
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

  switch (endpoint.classification.type) {
    case "relay":
      return <RelayPage endpoint={endpoint} />;
    case "robot":
      return <RobotPage endpoint={endpoint} />;
    default:
      // Covers "unknown" and, per the module doc comment, any type
      // string this client build doesn't recognize.
      return <UnknownDevicePage endpoint={endpoint} />;
  }
}
