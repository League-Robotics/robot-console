/**
 * DevicesTab.tsx — the Devices tab (SUC-001 / UC-001, and sprint 2's
 * SUC-001..004 flash flow).
 *
 * Renders the live device list served over `WsProvider`'s shared
 * WebSocket connection, lets the student open or close a link to a
 * device, and -- once a connect attempt has failed to identify a board
 * -- offers the two flash-firmware buttons that let a student recover
 * it without a command line.
 *
 * Split into a connected `DevicesTab` (reads `useWs()`) and a
 * presentational `DevicesList`/`DeviceCard` so the rendering rules for
 * each device state (normal, unnamed/error, unresponsive, HID-only,
 * reconnecting, flash buttons visible/disabled/in-progress) can be
 * exercised directly in tests against plain `DeviceListEntry` data,
 * without needing a real or faked socket for every case.
 */
import { useCallback, useEffect, useState } from "react";
import type {
  DeviceListEntry,
  FirmwareAvailability,
  FirmwareKind,
  FlashPhase,
} from "@robot-console/host/src/wsMessages.js";
import type { ConnectionStatus } from "../ws/WsProvider";
import { useWs } from "../ws/WsProvider";
import "./DevicesTab.css";

export function DevicesTab() {
  const { status, devices, firmwareStatus, send, onFlashResult } = useWs();
  const [flashErrors, setFlashErrors] = useState<Record<string, string>>({});

  useEffect(
    () =>
      onFlashResult((message) => {
        setFlashErrors((prev) => {
          if (message.status === "error") {
            return { ...prev, [message.deviceId]: message.message ?? "Flash failed." };
          }
          if (!(message.deviceId in prev)) {
            return prev;
          }
          const next = { ...prev };
          delete next[message.deviceId];
          return next;
        });
      }),
    [onFlashResult],
  );

  const openDevice = (deviceId: string) => send({ type: "open", deviceId });
  const closeDevice = (deviceId: string) => send({ type: "close", deviceId });
  const flashFirmware = useCallback(
    (deviceId: string, firmware: FirmwareKind) => {
      // A fresh click clears any stale error from a previous attempt --
      // the student is trying again, not still looking at the old one.
      setFlashErrors((prev) => {
        if (!(deviceId in prev)) {
          return prev;
        }
        const next = { ...prev };
        delete next[deviceId];
        return next;
      });
      send({ type: "flash-start", deviceId, firmware });
    },
    [send],
  );

  return (
    <DevicesList
      status={status}
      devices={devices}
      firmwareStatus={firmwareStatus}
      flashErrors={flashErrors}
      onOpen={openDevice}
      onClose={closeDevice}
      onFlash={flashFirmware}
    />
  );
}

/** Default per-firmware availability for presentational-only tests (and
 * the connected `DevicesTab` before the very first `devices` snapshot)
 * that don't care about the flash-button disabled state -- matches
 * `WsProvider`'s own pre-snapshot default so a test that omits
 * `firmwareStatus` entirely sees the same "not configured, disabled,
 * no reason shown" state a real client would before connecting. */
const DEFAULT_FIRMWARE_STATUS: Record<FirmwareKind, FirmwareAvailability> = {
  relay: { configured: false },
  robot: { configured: false },
};

export interface DevicesListProps {
  status: ConnectionStatus;
  devices: DeviceListEntry[];
  /** Optional so existing tests that only exercise Connect/Disconnect
   * rendering (unrelated to flashing) don't need to pass it. */
  firmwareStatus?: Record<FirmwareKind, FirmwareAvailability>;
  flashErrors?: Record<string, string>;
  onOpen: (deviceId: string) => void;
  onClose: (deviceId: string) => void;
  onFlash?: (deviceId: string, firmware: FirmwareKind) => void;
}

export function DevicesList({
  status,
  devices,
  firmwareStatus = DEFAULT_FIRMWARE_STATUS,
  flashErrors = {},
  onOpen,
  onClose,
  onFlash = () => {},
}: DevicesListProps) {
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
              <DeviceCard
                device={device}
                firmwareStatus={firmwareStatus}
                flashError={flashErrors[device.id]}
                onOpen={onOpen}
                onClose={onClose}
                onFlash={onFlash}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

interface DeviceCardProps {
  device: DeviceListEntry;
  firmwareStatus: Record<FirmwareKind, FirmwareAvailability>;
  flashError: string | undefined;
  onOpen: (deviceId: string) => void;
  onClose: (deviceId: string) => void;
  onFlash: (deviceId: string, firmware: FirmwareKind) => void;
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

/** Whether a device has been auto-probed and failed to identify --
 * exactly the state UC-001's error flow leaves it in (a `HELLO` reply
 * never arrived), and the only state that gets a recovery path. Per
 * the sprint architecture: `role === null && linkError !== undefined`
 * only -- never an unprobed device (no `linkError`, no `role`) and
 * never one that identified successfully (`role` set). */
function isFailedIdentify(device: DeviceListEntry): boolean {
  return device.role === null && device.linkError !== undefined;
}

/** Turn one firmware's live availability into either `null` (button
 * enabled) or a short, student-facing explanation of why it isn't --
 * never a hardcoded flag, always derived from the live
 * `firmwareStatus` the server polls and pushes (see `WsProvider`'s
 * `firmwareStatus` doc comment). Phrased as what the student should do
 * next, per this ticket's "explains why, tells them what to do" bar --
 * not an engineer-facing error code. */
function firmwareDisabledReason(availability: FirmwareAvailability | undefined): string | null {
  if (!availability || !availability.configured) {
    return "Not set up for this classroom yet — ask your instructor.";
  }
  if (availability.available) {
    return null;
  }
  switch (availability.reason) {
    case "not-yet-checked":
      // Poll hasn't completed yet -- must read as "still loading", not
      // "broken" or "permanently unavailable".
      return "Checking whether this firmware is available…";
    case "no-releases":
      return "No build has been published yet — ask your instructor when one's ready.";
    case "tag-not-found":
    case "no-asset":
      return "The configured build can't be found — ask your instructor to check the setup.";
    case "network":
      return "Couldn't check for firmware just now — try again in a moment.";
    default:
      return "This firmware isn't available right now.";
  }
}

const FIRMWARE_LABEL: Record<FirmwareKind, string> = {
  relay: "relay",
  robot: "robot",
};

const PHASE_LABEL: Record<FlashPhase, string> = {
  fetching: "downloading",
  verifying: "verifying",
  erasing: "erasing",
  writing: "writing",
  resetting: "resetting",
};

function flashProgressText(status: { firmware: FirmwareKind; phase: FlashPhase }): string {
  return `Flashing ${FIRMWARE_LABEL[status.firmware]} firmware: ${PHASE_LABEL[status.phase]}…`;
}

function DeviceCard({ device, firmwareStatus, flashError, onOpen, onClose, onFlash }: DeviceCardProps) {
  const name = nameDisplay(device);
  const role = roleDisplay(device);
  const showFlashControls = isFailedIdentify(device);
  const relayReason = firmwareDisabledReason(firmwareStatus.relay);
  const robotReason = firmwareDisabledReason(firmwareStatus.robot);

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

        {showFlashControls &&
          (device.flashStatus ? (
            <span className="device-flash-progress" role="status">
              {flashProgressText(device.flashStatus)}
            </span>
          ) : (
            <div className="device-flash-actions">
              <div className="device-flash-control">
                <button
                  type="button"
                  className="device-button"
                  disabled={relayReason !== null}
                  onClick={() => onFlash(device.id, "relay")}
                >
                  Flash relay firmware
                </button>
                {relayReason && <p className="device-flash-hint">{relayReason}</p>}
              </div>
              <div className="device-flash-control">
                <button
                  type="button"
                  className="device-button"
                  disabled={robotReason !== null}
                  onClick={() => onFlash(device.id, "robot")}
                >
                  Flash robot firmware
                </button>
                {robotReason && <p className="device-flash-hint">{robotReason}</p>}
              </div>
            </div>
          ))}
      </div>

      {showFlashControls && !device.flashStatus && flashError && (
        <p className="device-note device-note-error" role="alert">
          {flashError}
        </p>
      )}
    </article>
  );
}
