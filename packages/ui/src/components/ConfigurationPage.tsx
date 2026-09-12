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
 *  - **Radio**: the device's radio address, emitted as
 *    `diffDrive.setupRadio(channel, group)`.
 *
 * ## Sprint 015 ticket 007: reads `device.radio` from the snapshot
 *
 * Ticket 006 moved radio overrides out of browser `localStorage` and
 * into the host DB (`set-radio-override`), but this panel could not yet
 * read the *result* of that back: `device` was still the retired
 * `EndpointListEntry` (no `radio` field, no numeric `devices.id`).
 * Ticket 007 migrates this page to `SnapshotDevice`, so the panel now
 * seeds its draft from `device.radio` (`override -> registry ->
 * derived`, always a concrete `{channel, group, source}` --
 * `projection.ts`'s own resolution). Saving still only updates this
 * component's own in-memory draft (feeding the code panel on the
 * right) -- it does not itself send `set-radio-override`; use the
 * device page's "Set Radio" dialog (`RadioAddressDialog`) for a
 * durable, host-side override.
 *
 * ## Sprint 015 ticket 008: back onto the shared `AddressSourceChip`
 *
 * Ticket 007's own inline `radioSourceLabel` paragraph was a stand-in
 * for the ticket 006 gap that adapting `AddressSourceChip` to the
 * `Snapshot` contract closed -- this panel now mounts that shared
 * component directly (`<AddressSourceChip radio={device.radio} />`),
 * matching `RelayPage.tsx`'s own connected-child chip, rather than
 * duplicating its wording locally.
 *
 * ## Ticket 017-008: calibration table, Wi-Fi fields, and radio
 * validation shared with the Calibration tab and the two dialogs
 *
 * The calibration merge/derived-value math moved to `lib/calibration.ts`
 * and the "current calibration" table to `components/CalibrationTable.tsx`
 * (shared with `CalibrationPage`); the Wi-Fi ssid/password fields and
 * their validation moved to `components/WifiCredentialsForm.tsx` (shared
 * with `WifiCredentialsDialog`); the radio channel/group range check
 * moved to `lib/radioAddress.ts` (shared with `RadioAddressDialog`) --
 * see each module's own doc comment. This page still owns its own save
 * flow (Save updates the in-memory draft feeding the code panel; Write
 * to robot provisions Wi-Fi) -- only the fields/math/validation
 * themselves are shared, per `04-ui.md` §4.
 */
import { useEffect, useMemo, useState } from "react";
import { nameToRadioAddress } from "@robot-console/protocol";
import type { SnapshotDevice } from "@robot-console/host/src/wsMessages.js";
import {
  useConnectionStatus,
  useSendable,
  useWifiCredentials,
  useWifiProvisionResult,
  useWsActions,
} from "../ws/WsProvider";
import type { RadioAddress } from "../pages/RelayPage";
import {
  applyCalibrationPatch,
  calibrationCode,
  deriveCalibration,
  readCalibrationState,
  writeCalibrationState,
  type CalibrationPatch,
  type CalibrationState,
} from "../lib/calibration";
import { useCopied } from "../lib/clipboard";
import { validateRadioOverrideInput } from "../lib/radioAddress";
import { AddressSourceChip } from "./AddressSourceChip";
import { CalibrationTable } from "./CalibrationTable";
import { WifiCredentialsForm, validateWifiInput } from "./WifiCredentialsForm";
import "./CalibrationPage.css";
import "./CalibrationTable.css";
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
  device: SnapshotDevice;
}

export function ConfigurationPage({ device }: ConfigurationPageProps) {
  const robotName = device.name;
  const { send } = useWsActions();
  // Ticket 011 (carried from 009's send-gating sweep): Save (via
  // `saveWifi`) and Write to robot both send over the wire, so both
  // gate on `useSendable()` the same way every other send-capable
  // control in the app now does -- see `WsProvider.tsx`'s own doc
  // comment on `useSendable`.
  const sendable = useSendable();
  const stored = useWifiCredentials();
  // The link currently used for session-scoped actions (Write to robot)
  // -- the first link with an open session, if any. A device can have
  // several links under the new contract; which one "the" session is
  // for a Configuration tab reached via one specific link is ticket
  // 009's own `RobotPage` rewrite to settle precisely -- this mirrors
  // the pre-ticket-007 single-endpoint behavior closely enough in the
  // common case (one open link at a time).
  const openLink = device.links.find((candidate) => candidate.session !== undefined);
  const provisionResult = useWifiProvisionResult(openLink?.id ?? "");

  // Calibration values -- shared with the Calibration tab through localStorage.
  const [calibration, setCalibration] = useState<CalibrationState>(() => readCalibrationState(robotName));
  useEffect(() => {
    writeCalibrationState(robotName, calibration);
  }, [robotName, calibration]);
  const derived = useMemo(() => deriveCalibration(calibration), [calibration]);
  function patchCalibration(patch: CalibrationPatch): void {
    setCalibration((previous) => applyCalibrationPatch(previous, patch));
  }

  // Radio address. Ticket 007: seeded from the snapshot's own
  // `device.radio` (override -> registry -> derived, always concrete --
  // see this module's own doc comment) rather than always the
  // name-derived default. `saveRadio` still only updates this
  // component's own draft (feeding the code panel on the right), not a
  // `set-radio-override` send -- use `RadioAddressDialog` for that.
  const [radio, setRadio] = useState<RadioAddress>(() => ({ channel: device.radio.channel, group: device.radio.group }));
  const [radioDraft, setRadioDraft] = useState({ channel: String(radio.channel), group: String(radio.group) });
  const [radioError, setRadioError] = useState<string | null>(null);
  function saveRadio(): boolean {
    const channel = Number(radioDraft.channel);
    const group = Number(radioDraft.group);
    const problem = validateRadioOverrideInput(channel, group);
    if (problem) {
      setRadioError(problem);
      return false;
    }
    setRadioError(null);
    setRadio({ channel, group });
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
    if (!sendable) {
      return;
    }
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
  const { copied, copy } = useCopied();

  return (
    <div className="robot-page-columns configuration-page" data-testid="robot-tab-panel-configuration">
      <div className="robot-page-column robot-page-column-left">
        <div className="robot-page-panel" aria-label="Calibration values">
          <h3>Calibration</h3>
          <CalibrationTable variant="configuration" state={calibration} derived={derived} onPatch={patchCalibration} />
        </div>

        <div className="robot-page-panel" aria-label="Wi-Fi values">
          <h3>Wi-Fi</h3>
          <WifiCredentialsForm
            variant="tab"
            ssid={wifiDraft.ssid}
            password={wifiDraft.password}
            onSsidChange={(value) => setWifiDraft((draft) => ({ ...draft, ssid: value }))}
            onPasswordChange={(value) => setWifiDraft((draft) => ({ ...draft, password: value }))}
            stored={stored}
            error={wifiError}
          />
        </div>

        <div className="robot-page-panel" aria-label="Radio values">
          <h3>Radio</h3>
          <AddressSourceChip radio={device.radio} />
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
            <button
              type="button"
              className="calibration-code-copy"
              data-testid="configuration-save"
              disabled={!sendable}
              onClick={saveAll}
            >
              Save
            </button>
            <button
              type="button"
              data-testid="configuration-write"
              disabled={!openLink || !stored?.ssid || !sendable}
              title={
                !sendable
                  ? "Disconnected from the host"
                  : openLink
                    ? "Write the saved Wi-Fi network to the robot's credential slot 0"
                    : "Open a link to the robot first"
              }
              onClick={() => openLink && sendable && send({ type: "provision-wifi", linkId: openLink.id, slot: 0 })}
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
                <button
                  type="button"
                  className="calibration-code-copy"
                  data-testid="configuration-code-copy"
                  onClick={() => copy(code)}
                >
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
