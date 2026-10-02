/**
 * NetworkSettingsPanel.tsx — the Wi-Fi network, the robot's fixed Wi-Fi
 * address and its radio address on the Calibration tab, one row each,
 * with Save, Write to robot and Restart robot.
 *
 * Save keeps the Wi-Fi network on this computer and the radio address in
 * the code block. Write to robot stores the saved Wi-Fi network and the
 * Wi-Fi address on the robot and sends the calibration values. The robot
 * uses a stored network or address from its next restart.
 */
import { useEffect, useMemo, useState } from "react";
import type { SnapshotDevice, SnapshotLink } from "@robot-console/host/src/wsMessages.js";
import { useLinkLog, useSendable, useWifiCredentials, useWifiProvisionResult, useWsActions } from "../ws/WsProvider";
import type { RadioAddress } from "../pages/RelayPage";
import { describeCalibrationWrites, writeCalibration, type CalibrationWrite } from "../lib/calibrationWrite";
import { validateRadioOverrideInput } from "../lib/radioAddress";
import { defaultWifiAddress, deriveRobotWifiAddress, parseWifiAddress } from "../lib/wifiAddress";
import { isLinkUsable } from "../deviceDisplay";
import { AddressSourceChip } from "./AddressSourceChip";
import { WifiCredentialsForm, validateWifiInput } from "./WifiCredentialsForm";
import "./CalibrationTable.css";
import "./NetworkSettingsPanel.css";

export interface NetworkSettingsPanelProps {
  device: SnapshotDevice;
  link: SnapshotLink;
  radio: RadioAddress;
  /** Called with every valid channel/group pair as it is typed. */
  onRadioChange: (radio: RadioAddress) => void;
  /** Called with the network name and password boxes whenever they change. */
  onWifiChange?: (wifi: { ssid: string; password: string }) => void;
  /** Called with the Wi-Fi address box whenever it holds a usable address
   * that is not the robot's default, and with `undefined` otherwise. */
  onAddressChange?: (address: [number, number, number, number] | undefined) => void;
  calibrationWrites: CalibrationWrite[];
}

export function NetworkSettingsPanel({
  device,
  link,
  radio,
  onRadioChange,
  onWifiChange,
  onAddressChange,
  calibrationWrites,
}: NetworkSettingsPanelProps) {
  const { send, sendCommand } = useWsActions();
  const sendable = useSendable();
  const stored = useWifiCredentials();
  const linkOpen = isLinkUsable(link);
  const provisionResult = useWifiProvisionResult(linkOpen ? link.id : "");

  const [radioDraft, setRadioDraftState] = useState({ channel: String(radio.channel), group: String(radio.group) });
  const [radioError, setRadioError] = useState<string | null>(null);
  function setRadioDraft(next: { channel: string; group: string }): void {
    setRadioDraftState(next);
    const channel = Number(next.channel);
    const group = Number(next.group);
    if (next.channel.trim() !== "" && next.group.trim() !== "" && validateRadioOverrideInput(channel, group) === null) {
      setRadioError(null);
      onRadioChange({ channel, group });
    }
  }
  function saveRadio(): boolean {
    const problem = validateRadioOverrideInput(Number(radioDraft.channel), Number(radioDraft.group));
    setRadioError(problem);
    return problem === null;
  }

  const [wifiDraft, setWifiDraft] = useState({ ssid: "", password: "" });
  useEffect(() => {
    onWifiChange?.(wifiDraft);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reports the boxes, not the callback's identity
  }, [wifiDraft.ssid, wifiDraft.password]);
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
      setWifiError(null);
      return true;
    }
    const problem = validateWifiInput(ssid, wifiDraft.password, stored?.hasPassword === true && stored.ssid === ssid);
    setWifiError(problem);
    if (problem) {
      return false;
    }
    send({ type: "set-wifi-credentials", ssid, password: wifiDraft.password });
    send({ type: "get-wifi-credentials", reveal: true });
    return true;
  }

  const log = useLinkLog(link.id);
  const reported = useMemo(() => deriveRobotWifiAddress(log), [log]);
  const defaultAddress = defaultWifiAddress(device.name);
  const [addressDraft, setAddressDraft] = useState<string | undefined>(undefined);
  const addressText = addressDraft ?? reported?.ip ?? defaultAddress ?? "";
  const address = parseWifiAddress(addressText);
  const addressError = addressText.trim() !== "" && address === null ? "Enter an address like 10.55.29.48." : null;
  const addressIsDefault = address !== null && address.join(".") === defaultAddress;
  const addressKey = address === null || addressIsDefault ? "" : address.join(".");
  useEffect(() => {
    onAddressChange?.(addressKey === "" ? undefined : (addressKey.split(".").map(Number) as [number, number, number, number]));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reports the box, not the callback's identity
  }, [addressKey]);
  useEffect(() => {
    if (linkOpen && sendable) {
      sendCommand(link.id, "RUN", ["netshow"]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- asks once per opened link
  }, [linkOpen, sendable, link.id]);
  const addressToWrite = addressDraft !== undefined && address !== null && address.join(".") !== reported?.ip;

  const [savedNote, setSavedNote] = useState<string | null>(null);
  function saveAll(): void {
    if (!sendable) {
      return;
    }
    const radioOk = saveRadio();
    const wifiOk = saveWifi();
    setSavedNote(radioOk && wifiOk ? "Saved." : null);
    if (radioOk && wifiOk) {
      setTimeout(() => setSavedNote(null), 2000);
    }
  }

  const [calibrationNote, setCalibrationNote] = useState<string | null>(null);
  function writeToRobot(): void {
    if (!linkOpen || !sendable) return;
    if (stored?.ssid) {
      send({ type: "provision-wifi", linkId: link.id, slot: 0 });
    }
    if (addressToWrite && address !== null) {
      if (addressIsDefault) {
        sendCommand(link.id, "RUN", ["netclear"]);
      } else {
        sendCommand(link.id, "RUN", ["netset", ...address.map(String)]);
      }
    }
    if (calibrationWrites.length > 0) {
      writeCalibration(sendCommand, link.id, calibrationWrites);
      setCalibrationNote(`Sent ${describeCalibrationWrites(calibrationWrites)}.`);
    } else {
      setCalibrationNote(null);
    }
  }

  const nothingToWrite = !stored?.ssid && calibrationWrites.length === 0 && !addressToWrite;

  return (
    <div className="robot-page-panel network-settings" aria-label="Wi-Fi and radio">
      <h3>Wi-Fi and radio</h3>
      <WifiCredentialsForm
        variant="tab"
        ssid={wifiDraft.ssid}
        password={wifiDraft.password}
        onSsidChange={(value) => setWifiDraft((draft) => ({ ...draft, ssid: value }))}
        onPasswordChange={(value) => setWifiDraft((draft) => ({ ...draft, password: value }))}
        stored={stored}
        error={wifiError}
      />

      <table className="calibration-table" data-testid="configuration-address">
        <tbody>
          <tr>
            <th scope="row">Wi-Fi address</th>
            <td>
              <input
                data-testid="configuration-wifi-address"
                aria-label="Wi-Fi address"
                className="network-settings-address"
                inputMode="decimal"
                value={addressText}
                onChange={(event) => setAddressDraft(event.target.value)}
              />{" "}
              <span className="credentials-note" data-testid="configuration-wifi-address-note">
                {reported
                  ? `Robot uses ${reported.ip} (${reported.stored ? "stored on the robot" : "from its name"}).`
                  : defaultAddress
                    ? `Default for ${device.name}: ${defaultAddress}.`
                    : ""}
              </span>
            </td>
          </tr>
        </tbody>
      </table>

      <table className="calibration-table" data-testid="configuration-radio">
        <tbody>
          <tr>
            <th scope="row">Radio</th>
            <td>
              <label className="network-settings-field" htmlFor="configuration-radio-channel">
                Channel{" "}
                <input
                  id="configuration-radio-channel"
                  data-testid="configuration-radio-channel"
                  className="network-settings-number"
                  inputMode="numeric"
                  value={radioDraft.channel}
                  onChange={(event) => setRadioDraft({ ...radioDraft, channel: event.target.value })}
                />
              </label>
              <label className="network-settings-field" htmlFor="configuration-radio-group">
                Group{" "}
                <input
                  id="configuration-radio-group"
                  data-testid="configuration-radio-group"
                  className="network-settings-number"
                  inputMode="numeric"
                  value={radioDraft.group}
                  onChange={(event) => setRadioDraft({ ...radioDraft, group: event.target.value })}
                />
              </label>
              <AddressSourceChip radio={device.radio} />
            </td>
          </tr>
        </tbody>
      </table>
      {addressError && (
        <p className="credentials-error" role="alert" data-testid="configuration-wifi-address-error">
          {addressError}
        </p>
      )}
      {radioError && (
        <p className="credentials-error" role="alert" data-testid="configuration-radio-error">
          {radioError}
        </p>
      )}

      {provisionResult && (
        <p
          className={provisionResult.ok ? "credentials-result credentials-result-ok" : "credentials-error"}
          role="status"
          data-testid="configuration-write-result"
        >
          {provisionResult.message}
        </p>
      )}
      {calibrationNote && (
        <p className="credentials-result credentials-result-ok" role="status" data-testid="configuration-calibration-written">
          {calibrationNote}
        </p>
      )}
      {savedNote && (
        <p className="credentials-result credentials-result-ok" role="status" data-testid="configuration-saved">
          {savedNote}
        </p>
      )}
      <div className="network-settings-actions">
        <button type="button" data-testid="configuration-save" disabled={!sendable} onClick={saveAll}>
          Save
        </button>
        <button
          type="button"
          data-testid="configuration-write"
          disabled={!linkOpen || !sendable || nothingToWrite}
          title={
            !sendable
              ? "Disconnected from the host"
              : !linkOpen
                ? "Open a link to the robot first"
                : nothingToWrite
                  ? "Nothing to write yet -- enter a calibration value or a Wi-Fi network"
                  : "Write the calibration values and the saved Wi-Fi network to the robot"
          }
          onClick={writeToRobot}
        >
          Write to robot
        </button>
        <button
          type="button"
          data-testid="configuration-restart"
          disabled={!linkOpen || !sendable}
          title="Restart the robot so it uses its stored Wi-Fi network and address"
          onClick={() => sendCommand(link.id, "RUN", ["reboot"])}
        >
          Restart robot
        </button>
      </div>
      <p className="credentials-note">
        Write to robot sends the calibration values and stores the Wi-Fi network and Wi-Fi address on the robot,
        which uses them from its next restart. The robot never asks the network for an address: it uses the one
        here, 10.55.group.channel from its name unless you change it. The radio address reaches the robot only
        through the code below.
      </p>
    </div>
  );
}
