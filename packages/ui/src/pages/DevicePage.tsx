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
 *  - `hasSnapshot && !endpoint` -> "This device isn't connected".
 *    Deliberately **not** an auto-redirect: yanking the student away
 *    mid-look is worse than a dead end with a way back (see
 *    `sprint.md`'s Scope boundary -- the one exception, post-flash
 *    navigation, is `FlashControls`' own call (mounted from
 *    `UnknownDevicePage`, and from `FrontPage.tsx`'s card, ticket
 *    012-002), not this module's). The way back itself is no longer
 *    rendered here -- ticket 012-004's route-aware `AppHeader` is now
 *    the single source of the back-to-devices control for every
 *    device-page state, this one included, so this branch renders
 *    only its own status text.
 *  - `hasSnapshot && endpoint` -> dispatch to the matching per-type
 *    page below.
 *
 * The same rule (render inline, never redirect) is what keeps this
 * page correct when an *open* device disappears out from under the
 * student -- there is no effect here that reacts to `endpoint` going
 * from present to absent by navigating anywhere.
 *
 * **Opening a WiFi endpoint's session (sprint 10 ticket 005 fix-up).**
 * Unlike a USB endpoint (`deviceRegistry.ts` opens a session
 * automatically on attach) or a relay-mediated one (`RelayPage`'s own
 * Connect dropdown), nothing else on the wire ever opens a `"wifi"`
 * endpoint's session on the student's behalf -- the generic
 * `DeviceConsole` "open a link" hint exists but is easy to miss, and the
 * ticket's own acceptance criterion is that navigating here just
 * connects. This is the transport-aware place to do it: `RobotPage`
 * itself must stay transport-blind (see its own module doc comment), so
 * this wrapper -- which already knows `classification.type` for its
 * dispatch below -- also knows `transport`, and sends `{ type:
 * "session-open", endpointId }` for a not-yet-open, not-errored
 * `"wifi"` endpoint: once on mount, and again on every open->closed
 * transition that isn't a reported failure (mirrors `StatusPanel`'s
 * `wasOpenRef` closed->open pattern, run in the opposite direction). A
 * `sessionError` present stops the loop -- that failure is surfaced
 * through the existing error surfaces (`DeviceConsole`'s hint,
 * `RobotPage`'s own "no link" state) instead of retried automatically
 * forever. While the open attempt is in flight, this renders
 * `RobotPage`/`UnknownDevicePage` exactly as it already would for any
 * other not-yet-open endpoint -- no separate loading state.
 */
import { useEffect, useRef } from "react";
import { useParams } from "react-router";
import { useEndpoint, useHasSnapshot, useWsActions } from "../ws/WsProvider";
import { UnknownDevicePage } from "./UnknownDevicePage";
import { RelayPage } from "./RelayPage";
import { RobotPage } from "./RobotPage";
import "./DevicePage.css";

export function DevicePage() {
  const { endpointId } = useParams<{ endpointId: string }>();
  const hasSnapshot = useHasSnapshot();
  const endpoint = useEndpoint(endpointId ?? "");
  const { send } = useWsActions();

  // See this module's own doc comment, "Opening a WiFi endpoint's
  // session". `prevRef` remembers the *previous* render's
  // `(endpointId, sessionOpen)` pair (rather than a bare boolean, unlike
  // `StatusPanel`'s `wasOpenRef`) so navigating directly from one wifi
  // endpoint's page to a different one -- without this component
  // unmounting, since it's the same routed component re-rendered with a
  // new param -- is correctly treated as a fresh mount for the new
  // endpoint rather than a spurious open->closed transition carried over
  // from the old one.
  const prevRef = useRef<{ endpointId: string; sessionOpen: boolean } | null>(null);
  useEffect(() => {
    if (!endpoint || endpoint.transport !== "wifi") {
      prevRef.current = null;
      return;
    }
    const prev = prevRef.current;
    const isFreshMount = prev === null || prev.endpointId !== endpoint.endpointId;
    const transitionedToClosed = !isFreshMount && prev!.sessionOpen && !endpoint.sessionOpen;
    prevRef.current = { endpointId: endpoint.endpointId, sessionOpen: endpoint.sessionOpen };
    if (!endpoint.sessionOpen && !endpoint.sessionError && (isFreshMount || transitionedToClosed)) {
      send({ type: "session-open", endpointId: endpoint.endpointId });
    }
  }, [endpoint?.endpointId, endpoint?.transport, endpoint?.sessionOpen, endpoint?.sessionError, send]);

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
