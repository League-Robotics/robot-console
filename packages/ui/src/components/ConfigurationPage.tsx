/**
 * ConfigurationPage.tsx — the robot page's Configuration tab (OOP
 * 2026-09-11, stakeholder direction): every value a student's program
 * needs to set for this robot on the left, and the code that sets them
 * on the right.
 *
 *  - **Calibration**: the same per-robot state the Calibration tab's
 *    wizards fill (`CalibrationPage`'s `readCalibrationState`), editable
 *    here too.
 *  - **Wi-Fi**: the host's stored network (`get-wifi-credentials`). The
 *    code line uses the extension's `diffDrive.setupWifi(ssid,
 *    password)`. The password is masked in the code until the student
 *    asks for it, which fetches it from the host for this page only.
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
        (input.wifi.password === undefined ? "  // password hidden -- tick 'Show the Wi-Fi password' to fill it in" : ""),
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
  function saveRadio(): void {
    const channel = Number(radioDraft.channel);
    const group = Number(radioDraft.group);
    if (!Number.isInteger(channel) || channel < 0 || channel > 83) {
      setRadioError("Channel must be a whole number from 0 to 83.");
      return;
    }
    if (!Number.isInteger(group) || group < 0 || group > 255) {
      setRadioError("Group must be a whole number from 0 to 255.");
      return;
    }
    setRadioError(null);
    const next = { channel, group };
    setRadio(next);
    if (device.name) {
      writeStoredAddress(device.name, next);
    }
  }

  // Wi-Fi -- the host's stored network. Asked for once the socket is
  // open (a send before that is dropped), and again on every reconnect.
  const status = useConnectionStatus();
  useEffect(() => {
    if (status === "open") {
      send({ type: "get-wifi-credentials" });
    }
  }, [status, send]);
  const [wifiDraft, setWifiDraft] = useState({ ssid: "", password: "" });
  const [wifiSeeded, setWifiSeeded] = useState(false);
  useEffect(() => {
    if (stored && !wifiSeeded) {
      setWifiDraft({ ssid: stored.ssid ?? "", password: "" });
      setWifiSeeded(true);
    }
  }, [stored, wifiSeeded]);
  const [wifiError, setWifiError] = useState<string | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  function saveWifi(): void {
    const ssid = wifiDraft.ssid.trim();
    const problem = validateWifiInput(ssid, wifiDraft.password, stored?.hasPassword === true && stored.ssid === ssid);
    if (problem) {
      setWifiError(problem);
      return;
    }
    setWifiError(null);
    send({ type: "set-wifi-credentials", ssid, password: wifiDraft.password });
    setWifiDraft({ ssid, password: "" });
    if (showPassword) {
      send({ type: "get-wifi-credentials", reveal: true });
    }
  }
  function toggleShowPassword(next: boolean): void {
    setShowPassword(next);
    send(next ? { type: "get-wifi-credentials", reveal: true } : { type: "get-wifi-credentials" });
  }

  const code = useMemo(
    () =>
      configurationCode({
        robotName,
        radio,
        wifi: stored?.ssid ? { ssid: stored.ssid, password: showPassword ? stored.password : undefined } : undefined,
        calibration,
      }),
    [robotName, radio, stored, showPassword, calibration],
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
                    type="password"
                    value={wifiDraft.password}
                    autoComplete="off"
                    placeholder={stored?.hasPassword && stored.ssid === wifiDraft.ssid.trim() ? "saved — leave blank to keep" : ""}
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
          {provisionResult && (
            <p className={provisionResult.ok ? "credentials-result credentials-result-ok" : "credentials-error"} role="status">
              {provisionResult.message}
            </p>
          )}
          <div className="configuration-actions">
            <button type="button" data-testid="configuration-wifi-save" onClick={saveWifi}>
              Save
            </button>
            <button
              type="button"
              data-testid="configuration-wifi-write"
              disabled={!device.sessionOpen || !stored?.ssid}
              title={device.sessionOpen ? "Write the saved network to the robot's credential slot 0" : "Open a link to the robot first"}
              onClick={() => send({ type: "provision-wifi", endpointId: device.endpointId, slot: 0 })}
            >
              Write to robot
            </button>
          </div>
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
          <div className="configuration-actions">
            <button type="button" data-testid="configuration-radio-save" onClick={saveRadio}>
              Save
            </button>
          </div>
          <p className="credentials-note">
            Also the address the console uses for {robotName} through a relay. The robot's own radio address comes
            from this line in its program.
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
                {stored?.ssid && (
                  <label className="configuration-reveal">
                    <input
                      type="checkbox"
                      data-testid="configuration-reveal-password"
                      checked={showPassword}
                      onChange={(event) => toggleShowPassword(event.target.checked)}
                    />{" "}
                    Show the Wi-Fi password in the code
                  </label>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
