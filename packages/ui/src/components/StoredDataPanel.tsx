/**
 * StoredDataPanel — the Diagnostics tab's "Read stored data" button and
 * what the robot answers: its stored calibration and Wi-Fi networks.
 */
import { useEffect, useMemo, useState } from "react";
import type { SnapshotLink } from "@robot-console/host/src/wsMessages.js";
import { useLinkLog, useSendable, useWsActions } from "../ws/WsProvider";
import { deriveRobotWifiAddress } from "../lib/wifiAddress";
import { deriveStoredData, type StoredDataAnswer } from "./StoredData";

export const STORED_DATA_TIMEOUT_MS = 5000;

function waitingText(answer: StoredDataAnswer, timedOut: boolean, refused: string): string | null {
  if (answer === "answered") {
    return null;
  }
  if (answer === "refused") {
    return refused;
  }
  return timedOut ? "The robot did not answer." : "Waiting for the robot…";
}

function fixed(value: number | undefined, digits: number): string {
  return value === undefined ? "—" : value.toFixed(digits);
}

function runsText(count: number, mean: number | undefined, lo: number | undefined, hi: number | undefined): string {
  if (count === 0) {
    return "none";
  }
  const detail = mean !== undefined && lo !== undefined && hi !== undefined ? ` (mean ${mean}, ${lo} to ${hi})` : "";
  return `${count}${detail}`;
}

export function StoredDataPanel({ link }: { link: SnapshotLink }) {
  const sendable = useSendable();
  const { sendCommand } = useWsActions();
  const log = useLinkLog(link.id);
  const [read, setRead] = useState<{ afterId: number } | null>(null);
  const [timedOut, setTimedOut] = useState(false);

  useEffect(() => {
    if (read === null) {
      return undefined;
    }
    setTimedOut(false);
    const timer = setTimeout(() => setTimedOut(true), STORED_DATA_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [read]);

  const answered = useMemo(() => (read === null ? null : log.filter((entry) => entry.id > read.afterId)), [log, read]);
  const data = useMemo(() => (answered === null ? null : deriveStoredData(answered)), [answered]);
  const wifiAddress = useMemo(() => (answered === null ? undefined : deriveRobotWifiAddress(answered)), [answered]);

  function readStoredData(): void {
    setRead({ afterId: log.length > 0 ? (log[log.length - 1]?.id ?? -1) : -1 });
    sendCommand(link.id, "RUN", ["_calshow"]);
    sendCommand(link.id, "WIFICRED");
    sendCommand(link.id, "RUN", ["_netshow"]);
  }

  const values = data?.calibration.values;
  const runs = data?.calibration.runs;
  const calibrationNote = data && waitingText(data.calibrationAnswer, timedOut, "This robot's program does not report stored calibration.");
  const wifiNote = data && waitingText(data.wifiAnswer, timedOut, "This robot's firmware does not list stored networks.");

  return (
    <section className="diagnostics-stored-data" data-testid="diagnostics-stored-data" aria-label="Stored data">
      <h3>Stored data</h3>
      <button type="button" data-testid="diagnostics-read-stored" disabled={!sendable} onClick={readStoredData}>
        Read stored data
      </button>
      <p className="diagnostics-status-polling-hint">
        Asks the robot what it keeps in persistent memory: its calibration, its Wi-Fi networks and its Wi-Fi address.
        Passwords are never read back.
      </p>

      {data && (
        <>
          <h4>Calibration</h4>
          {calibrationNote && <p data-testid="diagnostics-stored-calibration-note">{calibrationNote}</p>}
          {values && (
            <table className="diagnostics-table" data-testid="diagnostics-stored-calibration">
              <tbody>
                <tr>
                  <th scope="row">Wheel (mm per degree)</th>
                  <td>{values.hasWheel ? values.wheelCalib : "not stored"}</td>
                </tr>
                <tr>
                  <th scope="row">Track width (cm)</th>
                  <td>{values.hasTurn ? values.trackWidthCm : "not stored"}</td>
                </tr>
                <tr>
                  <th scope="row">Rotational slip</th>
                  <td>{values.hasTurn ? values.slip : "not stored"}</td>
                </tr>
                <tr>
                  <th scope="row">Wheel multipliers in use (left, right)</th>
                  <td>
                    {fixed(values.wheelScaleLeft, 3)}, {fixed(values.wheelScaleRight, 3)}
                  </td>
                </tr>
                <tr>
                  <th scope="row">Motor ports in use (left, right)</th>
                  <td>
                    {fixed(values.motorPortLeft, 0)}, {fixed(values.motorPortRight, 0)}
                  </td>
                </tr>
                {runs && (
                  <>
                    <tr>
                      <th scope="row">Wheel runs saved</th>
                      <td>{runsText(runs.wheelRuns, runs.wheelMean, runs.wheelLo, runs.wheelHi)}</td>
                    </tr>
                    <tr>
                      <th scope="row">Turn runs saved</th>
                      <td>{runsText(runs.turnRuns, runs.turnMean, runs.turnLo, runs.turnHi)}</td>
                    </tr>
                  </>
                )}
              </tbody>
            </table>
          )}

          <h4>Wi-Fi address</h4>
          <p data-testid="diagnostics-stored-wifi-address">
            {wifiAddress
              ? `${wifiAddress.ip} (${wifiAddress.stored ? "stored on the robot" : "from the robot's name, nothing stored"})`
              : timedOut
                ? "The robot did not report an address."
                : "Waiting for the robot…"}
          </p>

          <h4>Wi-Fi networks</h4>
          {wifiNote && <p data-testid="diagnostics-stored-wifi-note">{wifiNote}</p>}
          {data.wifiAnswer === "answered" && data.wifi.length === 0 && (
            <p data-testid="diagnostics-stored-wifi-empty">No Wi-Fi network is stored on this robot.</p>
          )}
          {data.wifi.length > 0 && (
            <table className="diagnostics-table" data-testid="diagnostics-stored-wifi">
              <thead>
                <tr>
                  <th>Slot</th>
                  <th>Network</th>
                  <th>Password stored</th>
                </tr>
              </thead>
              <tbody>
                {data.wifi.map((network) => (
                  <tr key={network.slot}>
                    <td>{network.slot}</td>
                    <td>{network.ssid}</td>
                    <td>{network.hasPassword ? "yes" : "no"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </section>
  );
}
