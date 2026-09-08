/**
 * FrontPage.tsx — the front page (`/`, SUC-001), replacing the old
 * flat Devices tab as the console's landing page.
 *
 * Lists every endpoint from `WsProvider`'s live snapshot
 * (`useEndpoints`) as a card; the card *is* the navigation affordance
 * into that endpoint's own page (`/d/:endpointId`) -- a real
 * `react-router` `Link`, so middle-click/keyboard/screen-reader
 * navigation all work, not a `<div onClick>`.
 *
 * Rendering carries over the old flat Devices tab's `DeviceCard` states
 * verbatim (naming pending, flagged/unnamed, unresponsive, HID-only/no
 * serial port, linked pill) via the shared `nameDisplay`/`roleDisplay`
 * helpers (`../deviceDisplay.ts`) -- this is a presentation move, not a
 * redesign of what's shown. What's dropped: the inline
 * Connect/Disconnect and flash-firmware controls `DeviceCard` owned
 * before this sprint. Flash moved to the per-device page
 * (`UnknownDevicePage.tsx`, ticket 008); a manual Connect/Disconnect
 * did **not** move anywhere -- `deviceRegistry.ts` already opens a
 * session automatically on attach (`resolveNameAndOpen`), and
 * `DeviceConsole`'s "open a link" hint (ticket 008) covers the one
 * remaining case that matters, reopening a session that failed to
 * identify, right where the student is already looking to send a
 * line. This component takes no `onOpen`/`onClose`/`onFlash` callbacks
 * because the front page never performed those actions directly
 * itself (`DeviceCard` did). The old `DevicesTab.tsx`/`ConsoleTab.tsx`
 * components ticket 008 redistributed from are deleted, not kept
 * around unrouted.
 *
 * Split into a connected `FrontPage` (reads `WsProvider`'s selectors)
 * and a presentational `EndpointsList`/`EndpointCard`, mirroring the
 * old Devices tab's own split, so the list states can be exercised
 * directly in tests against plain `EndpointListEntry` fixtures.
 */
import { Link } from "react-router";
import type { EndpointListEntry } from "@robot-console/host/src/wsMessages.js";
import type { ConnectionStatus } from "../ws/WsProvider";
import { useConnectionStatus, useEndpoints } from "../ws/WsProvider";
import { nameDisplay, roleDisplay } from "../deviceDisplay";
import "./FrontPage.css";

export function FrontPage() {
  const status = useConnectionStatus();
  const devices = useEndpoints();
  return <EndpointsList status={status} devices={devices} />;
}

export interface EndpointsListProps {
  status: ConnectionStatus;
  devices: EndpointListEntry[];
}

export function EndpointsList({ status, devices }: EndpointsListProps) {
  return (
    <section className="front-page" aria-label="Devices">
      {status !== "open" && (
        <p className="connection-banner" role="status">
          {status === "connecting"
            ? "Connecting to robot-console…"
            : "Lost connection to robot-console — reconnecting…"}
        </p>
      )}
      {devices.length === 0 ? (
        <p className="devices-empty">
          No devices detected yet. Plug a micro:bit into a USB port.
        </p>
      ) : (
        <ul className="devices-list">
          {devices.map((device) => (
            <li key={device.endpointId}>
              <EndpointCard device={device} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** One endpoint's card -- the whole card is a `Link` to its device
 * page, per the "an arrow on the box, or maybe you just click the
 * box" stakeholder note (`sprint.md`'s SUC-001): the student can click
 * anywhere on it, not just a small affordance inside it. */
function EndpointCard({ device }: { device: EndpointListEntry }) {
  const name = nameDisplay(device);
  const role = roleDisplay(device);

  return (
    <Link
      to={`/d/${device.endpointId}`}
      className="device-card"
      data-testid={`device-${device.endpointId}`}
    >
      <div className="device-card-header">
        <h3 className={name.flagged ? "device-name device-name-flagged" : "device-name"}>
          {name.text}
        </h3>
        {name.flagged && <span className="device-flag">Unnamed / naming failed</span>}
        {device.sessionOpen && <span className="device-linked-pill">Linked</span>}
      </div>

      {name.flagged && device.nameError && (
        <p className="device-note">{device.nameError.message}</p>
      )}

      <dl className="device-fields">
        <div>
          <dt>Role</dt>
          <dd>{role}</dd>
        </div>
        <div>
          <dt>Port</dt>
          <dd>{device.usb?.port ?? "No serial port"}</dd>
        </div>
        <div>
          <dt>Device ID</dt>
          <dd title={device.usb?.serialNumber}>{device.usb?.displaySerial}</dd>
        </div>
      </dl>

      {device.sessionError && (
        <p className="device-note">Link attempt: {device.sessionError}</p>
      )}
    </Link>
  );
}
