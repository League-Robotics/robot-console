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
 * ## Ticket 018-013, corrected 2026-09-13: the firmware flash/run pieces
 * live on the Calibration tab, not here
 *
 * Commit `f1b0e8d` put a calibration-firmware panel, `cal*` run buttons,
 * and a filtered console on the Calibration tab, mis-labelled as ticket
 * "018-010". A same-day follow-up pass moved that feature here, to the
 * Configuration tab, reading its own placement text ("put this as a
 * flash button under the calibration section in the Configuration tab")
 * literally. The stakeholder's own same-day correction reverses that:
 * "If we have a Calibrate tab, then we don't need calibration under the
 * Configuration tab. You can just put it under Calibrate. Also, we still
 * need flash." So this page no longer renders a "Calibration firmware"
 * block or calx/cala run buttons, and no longer requests `FUNCS` -- all
 * of that (see `CalibrationPage.tsx`'s own doc comment) lives on the
 * Calibration tab now, including the flash button. This page still
 * takes `link` -- not for flashing/running any more, only to mount the
 * unfiltered `DeviceConsole` in the right column, unchanged from ticket
 * 018-013's own addition. Otherwise this page keeps only what
 * ticket-017-008 already gave it: the Calibration *values* table (shared
 * per-robot state, editable here too), Wi-Fi, Radio, the footer actions,
 * and the generated code block.
 *
 * ## Ticket 018-018: the right column is viewport-bound too
 *
 * The right column now carries `robot-page-column-console`
 * (`RobotPage.css`), the same sticky/viewport-height class the Main
 * tab's column already used -- previously it had no height bound, so
 * the generated-code block plus a growing console log could push the
 * send line off screen (stakeholder report, 2026-09-14). The code
 * block above the console also carries `robot-page-column-top`, so it
 * shrinks and scrolls internally before the console log's own floor
 * gives; see `RobotPage.css`'s doc comment on both classes.
 *
 * ## Ticket 022-001: `configurationCode`/`MASKED_PASSWORD`/`jsString`
 * moved to `lib/programCode.ts` (renamed `programCode`)
 *
 * This page used to be the only caller of `configurationCode`, defined
 * locally and unexported apart from a test-only export. The stakeholder
 * wants the Calibration tab's own "Code for your program" block to be
 * this exact function's output too (radio + Wi-Fi + calibration, not
 * calibration alone), which meant it could no longer live inside a page
 * component only `ConfigurationPage` renders -- see `lib/programCode.ts`'s
 * own doc comment for the full reasoning. This page also no longer owns
 * the `get-wifi-credentials` request effect: it moved to `RobotPage.tsx`
 * (the nearest common ancestor of this tab and the Calibration tab) so
 * a student who calibrates without ever opening this tab still sees a
 * populated Wi-Fi line -- see `RobotPage.tsx`'s own doc comment.
 */
import { useEffect, useMemo, useState } from "react";
import { nameToRadioAddress } from "@robot-console/protocol";
import type { SnapshotDevice, SnapshotLink } from "@robot-console/host/src/wsMessages.js";
import { useSendable, useWifiCredentials, useWifiProvisionResult, useWsActions } from "../ws/WsProvider";
import type { RadioAddress } from "../pages/RelayPage";
import {
  applyCalibrationPatch,
  deriveCalibration,
  readCalibrationState,
  writeCalibrationState,
  type CalibrationPatch,
  type CalibrationState,
} from "../lib/calibration";
import {
  buildCalibrationWrites,
  describeCalibrationWrites,
  writeCalibration,
} from "../lib/calibrationWrite";
import { useCopied } from "../lib/clipboard";
import { programCode } from "../lib/programCode";
import { validateRadioOverrideInput } from "../lib/radioAddress";
import { isLinkUsable } from "../deviceDisplay";
import { AddressSourceChip } from "./AddressSourceChip";
import { CalibrationTable } from "./CalibrationTable";
import { ConsolePane } from "./ConsolePane";
import { WifiCredentialsForm, validateWifiInput } from "./WifiCredentialsForm";
import "./CalibrationTable.css";
import "./ConfigurationPage.css";

export interface ConfigurationPageProps {
  device: SnapshotDevice;
  /** The specific link this page is showing a session for -- the routed
   * link `RobotPage.tsx` already resolves for every other tab. Used here
   * only to mount the unfiltered `DeviceConsole` in the right column
   * (ticket 018-013); flashing and running calx/cala moved to the
   * Calibration tab (stakeholder correction, 2026-09-13). */
  link: SnapshotLink;
}

export function ConfigurationPage({ device, link }: ConfigurationPageProps) {
  const robotName = device.name;
  const { send, sendCommand } = useWsActions();
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

  // Wi-Fi -- the host's stored network. Ticket 022-001: the
  // `get-wifi-credentials` request itself moved up to `RobotPage.tsx`
  // (fires once per robot session, open or reconnect, regardless of
  // which tab is active) -- this page only reads the resulting global
  // store slice (`stored`, above) now, same as `CalibrationPage.tsx`
  // does.
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
  // Ticket 2026-09-19: calibration is writable over the wire now.
  // `wheel_diameter` (ordinal 40) and `track_width` (41) landed in
  // nezha-diffdrive alongside the `rotational_slip` (16) that was
  // already there, so the three values this page has always been able
  // to EDIT can finally be SENT -- see `lib/calibrationWrite.ts`, which
  // owns the cm->mm conversion the track-width field needs.
  const calibrationWrites = useMemo(
    () => buildCalibrationWrites(calibration, derived),
    [calibration, derived],
  );
  const [calibrationNote, setCalibrationNote] = useState<string | null>(null);

  // One button, both jobs, because the page has one "Write to robot"
  // (stakeholder direction) and a student who pressed it means "put
  // what is on this page onto the robot". Wi-Fi still goes through the
  // host's own provisioning message; calibration goes straight out as
  // SETs on this link. Either half is skipped when it has nothing to
  // say, so a page with only calibration filled in writes calibration
  // and does not report a Wi-Fi failure it never attempted.
  function writeToRobot(): void {
    if (!openLink || !sendable) return;
    if (stored?.ssid) {
      send({ type: "provision-wifi", linkId: openLink.id, slot: 0 });
    }
    if (calibrationWrites.length > 0) {
      writeCalibration(sendCommand, openLink.id, calibrationWrites);
      setCalibrationNote(`Sent ${describeCalibrationWrites(calibrationWrites)}.`);
    } else {
      setCalibrationNote(null);
    }
  }

  const code = useMemo(
    () =>
      programCode({
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
              disabled={!openLink || !sendable || (!stored?.ssid && calibrationWrites.length === 0)}
              title={
                !sendable
                  ? "Disconnected from the host"
                  : !openLink
                    ? "Open a link to the robot first"
                    : !stored?.ssid && calibrationWrites.length === 0
                      ? "Nothing to write yet -- enter a calibration value or a Wi-Fi network"
                      : "Write the calibration values and the saved Wi-Fi network to the robot"
              }
              onClick={writeToRobot}
            >
              Write to robot
            </button>
          </div>
          <p className="credentials-note">
            Write to robot sends the calibration values and stores the Wi-Fi network on the robot itself.
            Calibration sent this way lasts until the robot is power-cycled -- paste the code on the right into the
            program to make it stick. Radio settings reach the robot only through that code.
          </p>
        </div>
      </div>

      <div className="robot-page-column robot-page-column-right robot-page-column-console">
        <div className="robot-page-panel calibration-code-panel robot-page-column-top" aria-label="Configuration code">
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

        <ConsolePane link={link} name={robotName} />
      </div>
    </div>
  );
}
