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
 *
 * ## Ticket 018-013: flash calibration firmware, run calx/cala, the
 * robot's own serial log -- moved here from the Calibration tab
 *
 * Commit `f1b0e8d` put a calibration-firmware panel, `cal*` run buttons,
 * and a filtered console on the **Calibration** tab, mis-labelled in its
 * own commit message and doc comments as ticket "018-010" -- 010 was UI
 * truthfulness (link-status text), an unrelated ticket that happened to
 * still be in progress at the same time. This ticket (018-013) owns the
 * feature itself and relocates it here, to the **Configuration** tab,
 * per the stakeholder's explicit placement ("put this as a flash button
 * under the calibration section in the Configuration tab").
 *
 * Additions over the ticket-017-008 shape above:
 *
 *  1. **This page now also takes `link`** (`RobotPage.tsx` threads the
 *     routed link through, the same one `CalibrationPage` already
 *     receives) -- needed to target the right USB link for flashing, run
 *     `calx`/`cala`, and mount the console.
 *  2. **A "Calibration firmware" block** under the "Calibration" panel:
 *     current program/version, whether it's the calibration build
 *     (`isCalibrationProgram`), and a **Flash calibration firmware**
 *     button that sends `flash-start {kind:"release", firmware:"robot"}`
 *     directly for this robot's own USB link -- the calibration program
 *     IS the configured `robot` firmware release, an established fact
 *     (see the ticket), not a separate artifact to pick from a dialog.
 *     Deliberately **not** `FlashDialog`/`FlashControls` (which offer a
 *     relay/robot button pair plus a local-hex uploader inside a modal,
 *     and navigate to "/" on success) -- this is a single-purpose control
 *     that stays on this page and reports its own outcome inline, though
 *     it reuses the same `useFlashProgress`/`flash-result` plumbing and
 *     `PHASE_LABEL`/`FIRMWARE_LABEL` those components use. Flashing
 *     targets the routed `link` when it can itself be flashed
 *     (`canBeFlashed`, a per-link capability read, never a hardcoded
 *     transport string), else the device's own other USB-capable link;
 *     with none, the block says plainly "Plug the robot in over USB to
 *     flash." and shows no button.
 *  3. **Post-flash verification, from the snapshot, never assumed**: once
 *     a `flash-result` for the flashed link arrives, the block reports
 *     "Calibration firmware `<version>` confirmed" only if the *current*
 *     `device.program` (the fresh post-flash/re-identify snapshot -- see
 *     `FlashControls.tsx`'s own doc comment on reidentify-before-result
 *     sequencing) is actually a calibration build; otherwise it names the
 *     program actually reported, or the flash's own error/timeout text.
 *     No optimistic "flashed successfully" line not backed by that
 *     snapshot read.
 *  4. **Two run controls**, "Calibrate X (distance)" and "Calibrate A
 *     (rotation)", mounting the existing `DistanceCalibrationWizard`/
 *     `RotationCalibrationWizard` unchanged (same `RUN calx`/`RUN cala`
 *     dispatch, same `CalibrationReport` parsers) so a run's result folds
 *     into this page's own `calibration` state exactly the way
 *     `CalibrationPage.tsx`'s identical wiring does -- one source of
 *     truth, no second parser for `CALX:`/`CALA:` lines. `FUNCS` is
 *     requested once on mount if this session has no function list yet,
 *     the same deliberate exception to sprint 015 ticket 009's
 *     "panels don't self-probe" rule `CalibrationPage.tsx` already makes
 *     (this page needs to know before the wizards can decide their own
 *     gating).
 *  5. **The full, unfiltered `DeviceConsole`** mounted in the right
 *     column under "Code for your program" -- the same console the Main
 *     tab mounts (`link`/`name`), not a calibration-filtered one (that
 *     stays `CalibrationConsole`'s own job, only ever on the Calibration
 *     tab).
 *
 * `CalibrationPage.tsx` no longer renders its own "Calibration firmware"
 * panel (removed this ticket) -- there is exactly one place to flash
 * calibration firmware now. Its distance/rotation wizards are unchanged
 * and still run their own independent sessions there.
 */
import { useEffect, useMemo, useState } from "react";
import { nameToRadioAddress } from "@robot-console/protocol";
import type { SnapshotDevice, SnapshotLink } from "@robot-console/host/src/wsMessages.js";
import {
  useConnectionStatus,
  useFirmwareStatus,
  useFlashProgress,
  useSendable,
  useWifiCredentials,
  useWifiProvisionResult,
  useWsActions,
} from "../ws/WsProvider";
import type { RadioAddress } from "../pages/RelayPage";
import {
  CALIBRATION_IMAGE_BASELINE_DIAMETER_MM,
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
import { FIRMWARE_LABEL, PHASE_LABEL, canBeFlashed, firmwareDisabledReason, isCalibrationProgram, isLinkUsable } from "../deviceDisplay";
import { AddressSourceChip } from "./AddressSourceChip";
import { CalibrationTable } from "./CalibrationTable";
import { DeviceConsole } from "./DeviceConsole";
import {
  DistanceCalibrationWizard,
  deriveBaselineDiameterMm,
  deriveWheelDiameterMm,
  type DistanceCalibrationRun,
} from "./DistanceCalibrationWizard";
import {
  RotationCalibrationWizard,
  reportedTrackWidthCm,
  robotReportedSlip,
  type RotationCalibrationRun,
} from "./RotationCalibrationWizard";
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
  /** The specific link this page is showing a session for -- the routed
   * link `RobotPage.tsx` already resolves for every other tab (ticket
   * 018-013: this page now targets it directly for flashing/running
   * calibration rather than only reading `device.links` for Wi-Fi). */
  link: SnapshotLink;
}

export function ConfigurationPage({ device, link }: ConfigurationPageProps) {
  const robotName = device.name;
  const { send, sendCommand, onFlashResult } = useWsActions();
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
  const openLink = device.links.find((candidate) => isLinkUsable(candidate));
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

  // Ticket 018-013: which link actually gets flashed -- the routed link
  // itself when it can be (`canBeFlashed` reads `link.capabilities.flash`,
  // true only for a `usb` link; never a hardcoded transport string here),
  // else the device's own other USB-capable link, if any.
  const flashLink = canBeFlashed(link) ? link : device.links.find((candidate) => canBeFlashed(candidate));
  const firmwareStatus = useFirmwareStatus();
  const robotFirmwareReason = firmwareDisabledReason(firmwareStatus.robot);
  const flashProgress = useFlashProgress(flashLink?.id ?? "");
  const [flashOutcome, setFlashOutcome] = useState<
    { status: "ok" | "error"; message?: string | undefined; reidentify?: "timeout" | undefined } | undefined
  >(undefined);

  useEffect(() => {
    if (!flashLink) {
      return undefined;
    }
    const linkId = flashLink.id;
    return onFlashResult((message) => {
      if (message.linkId !== linkId) {
        return;
      }
      setFlashOutcome({ status: message.status, message: message.message, reidentify: message.reidentify });
    });
  }, [flashLink, onFlashResult]);

  function flashCalibrationFirmware(): void {
    if (!flashLink || !sendable || robotFirmwareReason !== null || flashProgress) {
      return;
    }
    setFlashOutcome(undefined);
    send({ type: "flash-start", linkId: flashLink.id, source: { kind: "release", firmware: "robot" } });
  }

  // Ticket 018-013: the calx/cala run controls below need to know
  // whether the robot's own FUNCS reply lists them before they can
  // decide their own gating -- the same deliberate exception to sprint
  // 015 ticket 009's "panels don't self-probe" rule `CalibrationPage.tsx`
  // already makes, requested once on mount if nothing has asked yet this
  // session.
  const functions = link.session?.functions ?? undefined;
  const functionsUnknown = functions === undefined;
  const linkOpen = isLinkUsable(link) && sendable;
  useEffect(() => {
    if (functionsUnknown && linkOpen) {
      sendCommand(link.id, "FUNCS");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fires again only when "do we have a list yet" flips, or the link/openness identity changes
  }, [link.id, linkOpen, functionsUnknown]);

  // Ticket 018-013: fold a calx/cala run's result into this page's own
  // `calibration` state -- identical wiring to `CalibrationPage.tsx`'s
  // `handleDistanceRun`/`handleRotationRun`, so both tabs read/write the
  // same per-robot state through one shared merge (`applyCalibrationPatch`)
  // rather than each tab owning a second copy of this logic.
  function handleDistanceRun(run: DistanceCalibrationRun | undefined): void {
    if (run?.kind !== "succeeded") {
      return;
    }
    const diameter = deriveWheelDiameterMm(run.events, run.snippet);
    if (diameter === undefined) {
      return;
    }
    patchCalibration({ wheelDiameterMm: diameter, wheelDiameterSource: "distance-calibration" });
    const baseline = deriveBaselineDiameterMm(run.events);
    if (baseline !== undefined && calibration.reportedWithDiameterMm === undefined) {
      patchCalibration({ reportedWithDiameterMm: baseline });
    }
  }

  function handleRotationRun(run: RotationCalibrationRun | undefined): void {
    if (run?.kind === "succeeded") {
      const reported = reportedTrackWidthCm(run);
      if (reported !== undefined) {
        patchCalibration({ reportedTrackWidthCm: reported, reportedWithDiameterMm: CALIBRATION_IMAGE_BASELINE_DIAMETER_MM });
      }
      const slip = robotReportedSlip(run);
      if (slip !== undefined) {
        patchCalibration({ robotReportedSlip: slip });
      }
      return;
    }
    if (run?.kind === "failed") {
      // A failed re-verification must not leave a width or slip standing.
      patchCalibration({ reportedTrackWidthCm: undefined, robotReportedSlip: undefined });
    }
  }

  const rotationBlocked = calibration.wheelDiameterMm === undefined;

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

          <div className="calibration-firmware-panel" aria-label="Calibration firmware">
            <h4>Calibration firmware</h4>
            {isCalibrationProgram(device.program) ? (
              <p data-testid="configuration-firmware-running">
                Calibration firmware {device.version ?? "unknown"} is running.
              </p>
            ) : (
              <p data-testid="configuration-firmware-not-running">Program: {device.program ?? "unknown"}</p>
            )}

            {!flashLink ? (
              <p className="calibration-firmware-usb-hint" data-testid="configuration-firmware-usb-required" role="status">
                Plug the robot in over USB to flash.
              </p>
            ) : flashProgress ? (
              <p className="device-flash-progress" role="status" data-testid="configuration-flash-progress">
                Flashing {FIRMWARE_LABEL.robot}: {PHASE_LABEL[flashProgress.phase]}…
              </p>
            ) : (
              <>
                <button
                  type="button"
                  className="device-button"
                  data-testid="configuration-flash-calibration"
                  disabled={!sendable || robotFirmwareReason !== null}
                  title={robotFirmwareReason ?? undefined}
                  onClick={flashCalibrationFirmware}
                >
                  Flash calibration firmware
                </button>
                {robotFirmwareReason && <p className="device-flash-hint">{robotFirmwareReason}</p>}
              </>
            )}

            {flashOutcome &&
              !flashProgress &&
              (flashOutcome.status === "error" ? (
                <p className="device-note device-note-error" role="alert" data-testid="configuration-flash-result">
                  {flashOutcome.message ?? "Flash failed."}
                </p>
              ) : flashOutcome.reidentify === "timeout" ? (
                <p className="device-note" role="status" data-testid="configuration-flash-result">
                  Flashed. Waiting for the board to come back…
                </p>
              ) : isCalibrationProgram(device.program) ? (
                <p className="credentials-result credentials-result-ok" role="status" data-testid="configuration-flash-result">
                  Calibration firmware {device.version ?? "unknown"} confirmed.
                </p>
              ) : (
                <p className="device-note device-note-error" role="alert" data-testid="configuration-flash-result">
                  Flashed, but the robot reports program {device.program ?? "unknown"} — not the calibration build.
                </p>
              ))}
          </div>

          <div className="configuration-calibration-run" aria-label="Run calibration">
            <h4>Run calibration</h4>
            {!linkOpen && (
              <p className="calibration-functions-hint" data-testid="configuration-run-calibration-disconnected" role="status">
                Not connected — open a link to this robot to run calibration.
              </p>
            )}
            {linkOpen && functionsUnknown && (
              <p className="calibration-functions-hint" data-testid="configuration-functions-checking" role="status">
                Checking which calibration functions this robot supports…
              </p>
            )}
            <div aria-label="Distance calibration">
              <h5>Calibrate X (distance)</h5>
              <DistanceCalibrationWizard link={link} onRun={handleDistanceRun} />
            </div>
            <div aria-label="Rotation calibration">
              <h5>Calibrate A (rotation)</h5>
              <RotationCalibrationWizard
                link={link}
                onRun={handleRotationRun}
                disabled={rotationBlocked}
                disabledReason="Run the distance calibration first — the rotation run needs the wheel diameter."
              />
            </div>
          </div>
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

        <DeviceConsole link={link} name={robotName} />
      </div>
    </div>
  );
}
