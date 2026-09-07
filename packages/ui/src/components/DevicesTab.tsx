/**
 * DevicesTab.tsx — the Devices tab (SUC-001 / UC-001).
 *
 * Renders the live device list served over `WsProvider`'s shared
 * WebSocket connection, and lets the student open or close a link to a
 * device. Per this ticket's scope discipline, this is *all* it does --
 * no flash, calibration, or other future-sprint control surface lives
 * here.
 *
 * Split into a connected `DevicesTab` (reads `useWs()`) and a
 * presentational `DevicesList`/`DeviceCard` so the rendering rules for
 * each device state (normal, unnamed/error, unresponsive, HID-only,
 * reconnecting) can be exercised directly in tests against plain
 * `DeviceListEntry` data, without needing a real or faked socket for
 * every case.
 */
import type { DeviceListEntry } from "@robot-console/host/src/wsMessages.js";
import type { ConnectionStatus } from "../ws/WsProvider";
import { useWs } from "../ws/WsProvider";
import "./DevicesTab.css";

export function DevicesTab() {
  const { status, devices, send } = useWs();

  const openDevice = (deviceId: string) => send({ type: "open", deviceId });
  const closeDevice = (deviceId: string) => send({ type: "close", deviceId });

  return (
    <DevicesList
      status={status}
      devices={devices}
      onOpen={openDevice}
      onClose={closeDevice}
    />
  );
}

export interface DevicesListProps {
  status: ConnectionStatus;
  devices: DeviceListEntry[];
  onOpen: (deviceId: string) => void;
  onClose: (deviceId: string) => void;
}

export function DevicesList({ status, devices, onOpen, onClose }: DevicesListProps) {
  return (
    <section className="devices-tab" aria-label="Devices">
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
            <li key={device.id}>
              <DeviceCard device={device} onOpen={onOpen} onClose={onClose} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

interface DeviceCardProps {
  device: DeviceListEntry;
  onOpen: (deviceId: string) => void;
  onClose: (deviceId: string) => void;
}

function nameDisplay(device: DeviceListEntry): { text: string; flagged: boolean } {
  if (device.name) {
    return { text: device.name, flagged: false };
  }
  if (device.nameError) {
    return { text: "Unnamed device", flagged: true };
  }
  // Detected but naming hasn't resolved (or failed) yet -- an ordinary,
  // momentary state, never shown as an error.
  return { text: "Naming…", flagged: false };
}

function roleDisplay(device: DeviceListEntry): string {
  if (device.role) {
    return device.role;
  }
  if (device.linkError) {
    // No banner reply ever arrived -- per UC-001's error flow, shown as
    // unresponsive rather than assigned a role.
    return "Unresponsive";
  }
  // The common, unalarming case: a board running its own code (or not
  // yet linked) that simply hasn't announced a role. Not an error, not
  // a spinner.
  return "No role announced";
}

function DeviceCard({ device, onOpen, onClose }: DeviceCardProps) {
  const name = nameDisplay(device);
  const role = roleDisplay(device);

  return (
    <article className="device-card" data-testid={`device-${device.id}`}>
      <div className="device-card-header">
        <h3 className={name.flagged ? "device-name device-name-flagged" : "device-name"}>
          {name.text}
        </h3>
        {name.flagged && <span className="device-flag">Unnamed / naming failed</span>}
        {device.linkOpen && <span className="device-linked-pill">Linked</span>}
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
          <dd>{device.port ?? "No serial port"}</dd>
        </div>
        <div>
          <dt>Device ID</dt>
          <dd title={device.serialNumber}>{device.displaySerial}</dd>
        </div>
      </dl>

      {device.linkError && (
        <p className="device-note">Link attempt: {device.linkError}</p>
      )}

      <div className="device-actions">
        {device.linkOpen ? (
          <button
            type="button"
            className="device-button"
            onClick={() => onClose(device.id)}
          >
            Disconnect
          </button>
        ) : device.port ? (
          <button
            type="button"
            className="device-button device-button-primary"
            onClick={() => onOpen(device.id)}
          >
            Connect
          </button>
        ) : (
          <span className="device-hint">No serial port available to connect</span>
        )}
      </div>
    </article>
  );
}
