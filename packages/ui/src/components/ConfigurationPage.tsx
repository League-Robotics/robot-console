/**
 * ConfigurationPage.tsx — the robot page's Configuration tab (OOP
 * 2026-09-11, stakeholder direction): every value a student's program
 * needs to set for this robot on the left, and the code that sets them
 * on the right.
 *
 *  - **Calibration**: the same per-robot state the Calibration tab's
 *    wizards fill (`CalibrationPage`'s `readCalibrationState`), editable
 *    here too.
 *  - **Wi-Fi**: the host's stored network, asked for with `reveal:
 *    true` so this page shows the password in the field and in the
 *    code line (`diffDrive.setupWifi(ssid, password)`) -- stakeholder
 *    direction: everybody in the room knows it. (The header's Set Wi-Fi
 *    dialog is the only other place it appears.)
 *  - **Radio**: the console's per-name relay address (the same stored
 *    channel/group `RelayPage` reads), emitted as
 *    `diffDrive.setupRadio(channel, group)`.
 */
import { useEffect, useMemo, useState } from "react";
import { nameToRadioAddress } from "@robot-console/protocol";
import type { EndpointListEntry } from "@robot-console/host/src/wsMessages.js";
import { useConnectionStatus, useWifiCredentials, useWifiProvisionResult, useWsActions } from "../ws/WsProvider";
import { readStoredAddress, writeStoredAddress, type RadioAddress } from "../pages/RelayPage";
import {
  calibrationCode,
  deriveCalibration,
  parsePositiveNumber,
  readCalibrationState,
  writeCalibrationState,
  type CalibrationState,
} from "./CalibrationPage";
import { validateWifiInput } from "./WifiCredentialsDialog";
import "./CalibrationPage.css";
import "./ConfigurationPage.css";

export const MASKED_PASSWORD = "••••••••";

export interface ConfigurationCodeInput {
  robotName: string;
  radio: RadioAddress | undefined;
  wifi: { ssid: string; password: string | undefined } | undefined;
  calibration: CalibrationState;
}

function jsString(value: string): string {
  return JSON.stringify(value);
}

/** The one block a student pastes into their program's setup. Exported
 * for `ConfigurationPage.test.tsx`. */
export function configurationCode(input: ConfigurationCodeInput): string {
  const lines: string[] = [`// ${input.robotName} configuration`];
  if (input.radio) {
    lines.push(`diffDrive.setupRadio(${input.radio.channel}, ${input.radio.group})  // radio channel, group`);
  }
  if (input.wifi) {
    const password = input.wifi.password === undefined ? MASKED_PASSWORD : input.wifi.password;
    lines.push(
      `diffDrive.setupWifi(${jsString(input.wifi.ssid)}, ${jsString(password)})` +
        (input.wifi.password === undefined ? "  // password not known to this computer -- fill it in" : ""),
    );
  }
  const calibration = calibrationCode(input.calibration, input.robotName);
  if (calibration !== "") {
    lines.push(...calibration.split("\n").slice(1));
  }
  return lines.length === 1 ? "" : lines.join("\n");
}

export interface ConfigurationPageProps {
  device: EndpointListEntry;
}

export function ConfigurationPage({ device }: ConfigurationPageProps) {
  const robotName = device.name ?? device.endpointId;
  const { send } = useWsActions();
  const stored = useWifiCredentials();
  const provisionResult = useWifiProvisionResult(device.endpointId);

  // Calibration values -- shared with the Calibration tab through localStorage.
  const [calibration, setCalibration] = useState<CalibrationState>(() => readCalibrationState(robotName));
  useEffect(() => {
    writeCalibrationState(robotName, calibration);
  }, [robotName, calibration]);
  const derived = useMemo(() => deriveCalibration(calibration), [calibration]);
  function patchCalibration(patch: { [K in keyof CalibrationState]?: CalibrationState[K] | undefined }): void {
    setCalibration((previous) => {
      const merged: Record<string, unknown> = { ...previous, ...patch };
      for (const key of Object.keys(merged)) {
        if (merged[key] === undefined) {
          delete merged[key];
        }
      }
      return merged as CalibrationState;
    });
  }

  // Radio address -- the console's per-name relay address.
  const [radio, setRadio] = useState<RadioAddress>(
    () => (device.name ? readStoredAddress(device.name) : null) ?? nameToRadioAddress(robotName),
  );
  const [radioDraft, setRadioDraft] = useState({ channel: String(radio.channel), group: String(radio.group) });
  const [radioError, setRadioError] = useState<string | null>(null);
  function saveRadio(): boolean {
    const channel = Number(radioDraft.channel);
    const group = Number(radioDraft.group);
    if (!Number.isInteger(channel) || channel < 0 || channel > 83) {
      setRadioError("Channel must be a whole number from 0 to 83.");
      return false;
    }
    if (!Number.isInteger(group) || group < 0 || group > 255) {
      setRadioError("Group must be a whole number from 0 to 255.");
      return false;
    }
    setRadioError(null);
    const next = { channel, group };
    setRadio(next);
    if (device.name) {
      writeStoredAddress(device.name, next);
    }
    return true;
  }

  // Wi-Fi -- the host's stored network. Asked for once the socket is
  // open (a send before that is dropped), and again on every reconnect.
  const status = useConnectionStatus();
  useEffect(() => {
    if (status === "open") {
      send({ type: "get-wifi-credentials", reveal: true });
    }
  }, [status, send]);
  const [wifiDraft, setWifiDraft] = useState({ ssid: "", password: "" });
  const [wifiSeeded, setWifiSeeded] = useState(false);
  useEffect(() => {
    if (stored && !wifiSeeded) {
      setWifiDraft({ ssid: stored.ssid ?? "", password: stored.password ?? "" });
      setWifiSeeded(true);
    }
  }, [stored, wifiSeeded]);
  const [wifiError, setWifiError] = useState<string | null>(null);
  function saveWifi(): boolean {
    const ssid = wifiDraft.ssid.trim();
    if (ssid === "" && wifiDraft.password === "" && !stored?.ssid) {
      // Nothing entered and nothing held: not an error, just nothing to save.
      setWifiError(null);
      return true;
    }
    const problem = validateWifiInput(ssid, wifiDraft.password, stored?.hasPassword === true && stored.ssid === ssid);
    if (problem) {
      setWifiError(problem);
      return false;
    }
    setWifiError(null);
    send({ type: "set-wifi-credentials", ssid, password: wifiDraft.password });
    send({ type: "get-wifi-credentials", reveal: true });
    return true;
  }

  const [savedNote, setSavedNote] = useState<string | null>(null);
  function saveAll(): void {
    const radioOk = saveRadio();
    const wifiOk = saveWifi();
    writeCalibrationState(robotName, calibration);
    setSavedNote(radioOk && wifiOk ? "Saved." : null);
    if (radioOk && wifiOk) {
      setTimeout(() => setSavedNote(null), 2000);
    }
  }
  const code = useMemo(
    () =>
      configurationCode({
        robotName,
        radio,
        wifi: stored?.ssid ? { ssid: stored.ssid, password: stored.password } : undefined,
        calibration,
      }),
    [robotName, radio, stored, calibration],
  );
  const [copied, setCopied] = useState(false);
  function copy(): void {
    try {
      void navigator.clipboard?.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard unavailable -- the text is selectable either way.
    }
  }

  return (
    <div className="robot-page-columns configuration-page" data-testid="robot-tab-panel-configuration">
      <div className="robot-page-column robot-page-column-left">
        <div className="robot-page-panel" aria-label="Calibration values">
          <h3>Calibration</h3>
          <table className="calibration-table" data-testid="configuration-calibration">
            <tbody>
              <tr>
                <th scope="row">
                  <label htmlFor="configuration-wheel-diameter">Wheel diameter</label>
                </th>
                <td>
                  <input
                    id="configuration-wheel-diameter"
                    type="number"
                    inputMode="decimal"
                    step="0.01"
                    min="1"
                    placeholder="not calibrated"
                    value={calibration.wheelDiameterMm ?? ""}
                    onChange={(event) => {
                      const value = parsePositiveNumber(event.target.value);
                      patchCalibration({ wheelDiameterMm: value, wheelDiameterSource: value === undefined ? undefined : "entered" });
                    }}
                  />{" "}
                  mm
                </td>
              </tr>
              <tr>
                <th scope="row">
                  <label htmlFor="configuration-track-width">Measured track width</label>
                </th>
                <td>
                  <input
                    id="configuration-track-width"
                    type="number"
                    inputMode="decimal"
                    step="0.01"
                    min="1"
                    placeholder="optional"
                    value={calibration.measuredTrackWidthCm ?? ""}
                    onChange={(event) => patchCalibration({ measuredTrackWidthCm: parsePositiveNumber(event.target.value) })}
                  />{" "}
                  cm
                </td>
              </tr>
              <tr>
                <th scope="row">Effective track width</th>
                <td data-testid="configuration-effective-track">
                  {derived.effectiveTrackWidthCm !== undefined ? `${derived.effectiveTrackWidthCm} cm` : "run the rotation calibration"}
                </td>
              </tr>
              <tr>
                <th scope="row">Rotational slip</th>
                <td data-testid="configuration-slip">{derived.rotationalSlip ?? "—"}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div className="robot-page-panel" aria-label="Wi-Fi values">
          <h3>Wi-Fi</h3>
          <table className="calibration-table" data-testid="configuration-wifi">
            <tbody>
              <tr>
                <th scope="row">
                  <label htmlFor="configuration-wifi-ssid">Network name</label>
                </th>
                <td>
                  <input
                    id="configuration-wifi-ssid"
                    data-testid="configuration-wifi-ssid"
                    value={wifiDraft.ssid}
                    autoComplete="off"
                    onChange={(event) => setWifiDraft((draft) => ({ ...draft, ssid: event.target.value }))}
                  />
                </td>
              </tr>
              <tr>
                <th scope="row">
                  <label htmlFor="configuration-wifi-password">Password</label>
                </th>
                <td>
                  <input
                    id="configuration-wifi-password"
                    data-testid="configuration-wifi-password"
                    type="text"
                    value={wifiDraft.password}
                    autoComplete="off"
                    onChange={(event) => setWifiDraft((draft) => ({ ...draft, password: event.target.value }))}
                  />
                </td>
              </tr>
            </tbody>
          </table>
          {wifiError && (
            <p className="credentials-error" role="alert" data-testid="configuration-wifi-error">
              {wifiError}
            </p>
          )}
          <p className="credentials-note">
            {stored?.source === "stored"
              ? "Saved on this computer."
              : stored?.source === "env"
                ? "From this computer's configuration."
                : "No network saved on this computer yet."}
          </p>
        </div>

        <div className="robot-page-panel" aria-label="Radio values">
          <h3>Radio</h3>
          <table className="calibration-table" data-testid="configuration-radio">
            <tbody>
              <tr>
                <th scope="row">
                  <label htmlFor="configuration-radio-channel">Channel</label>
                </th>
                <td>
                  <input
                    id="configuration-radio-channel"
                    data-testid="configuration-radio-channel"
                    inputMode="numeric"
                    value={radioDraft.channel}
                    onChange={(event) => setRadioDraft((draft) => ({ ...draft, channel: event.target.value }))}
                  />
                </td>
              </tr>
              <tr>
                <th scope="row">
                  <label htmlFor="configuration-radio-group">Group</label>
                </th>
                <td>
                  <input
                    id="configuration-radio-group"
                    data-testid="configuration-radio-group"
                    inputMode="numeric"
                    value={radioDraft.group}
                    onChange={(event) => setRadioDraft((draft) => ({ ...draft, group: event.target.value }))}
                  />
                </td>
              </tr>
            </tbody>
          </table>
          {radioError && (
            <p className="credentials-error" role="alert" data-testid="configuration-radio-error">
              {radioError}
            </p>
          )}
          <p className="credentials-note">
            Also the address the console uses for {robotName} through a relay. The robot's own radio address comes
            from this line in its program.
          </p>
        </div>

        {/* One Save and one Write to robot for the whole page (stakeholder
            direction). Save keeps every value on this computer (the host
            for Wi-Fi, this browser for calibration and radio); Write to
            robot sends the Wi-Fi network to the robot's credential slot --
            the one value the robot itself stores. Calibration and radio
            reach the robot through the code on the right. */}
        <div className="robot-page-panel configuration-footer" aria-label="Configuration actions">
          {provisionResult && (
            <p
              className={provisionResult.ok ? "credentials-result credentials-result-ok" : "credentials-error"}
              role="status"
              data-testid="configuration-write-result"
            >
              {provisionResult.message}
            </p>
          )}
          {savedNote && (
            <p className="credentials-result credentials-result-ok" role="status" data-testid="configuration-saved">
              {savedNote}
            </p>
          )}
          <div className="configuration-actions">
            <button type="button" className="calibration-code-copy" data-testid="configuration-save" onClick={saveAll}>
              Save
            </button>
            <button
              type="button"
              data-testid="configuration-write"
              disabled={!device.sessionOpen || !stored?.ssid}
              title={
                device.sessionOpen
                  ? "Write the saved Wi-Fi network to the robot's credential slot 0"
                  : "Open a link to the robot first"
              }
              onClick={() => send({ type: "provision-wifi", endpointId: device.endpointId, slot: 0 })}
            >
              Write to robot
            </button>
          </div>
          <p className="credentials-note">
            Write to robot stores the Wi-Fi network on the robot itself; calibration and radio settings reach it
            through the code on the right.
          </p>
        </div>
      </div>

      <div className="robot-page-column robot-page-column-right">
        <div className="robot-page-panel calibration-code-panel" aria-label="Configuration code">
          <h3>Code for your program</h3>
          {code === "" ? (
            <p className="calibration-code-empty" data-testid="configuration-code-empty">
              Nothing to paste yet.
            </p>
          ) : (
            <>
              <pre className="calibration-code" data-testid="configuration-code">
                {code}
              </pre>
              <div className="configuration-actions">
                <button type="button" className="calibration-code-copy" data-testid="configuration-code-copy" onClick={copy}>
                  {copied ? "Copied" : "Copy"}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
