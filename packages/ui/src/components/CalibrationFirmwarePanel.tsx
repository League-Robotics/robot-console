/**
 * CalibrationFirmwarePanel.tsx — the "Calibration firmware" flash/verify
 * block, extracted from `ConfigurationPage.tsx` (ticket 018-013) and
 * relocated onto the **Calibration** tab (stakeholder correction,
 * 2026-09-13): "If we have a Calibrate tab, then we don't need
 * calibration under the Configuration tab. You can just put it under
 * Calibrate."
 *
 * The calibration program IS the configured `robot` firmware release --
 * a flashed calibration robot identifies as
 * `id diffdrive calibration-0.20260913.1 …` -- so this panel's Flash
 * button sends `flash-start {kind:"release", firmware:"robot"}` directly
 * for this robot's own USB-flashable link, never a picker. Deliberately
 * **not** `FlashDialog`/`FlashControls` (which offer a relay/robot button
 * pair plus a local-hex uploader inside a modal, and navigate to "/" on
 * success) -- this is a single-purpose control that stays on this tab
 * and reports its own outcome inline, though it reuses the same
 * `useFlashProgress`/`flash-result` plumbing and `PHASE_LABEL`/
 * `FIRMWARE_LABEL` those components use.
 *
 * **Post-flash verification is read from the fresh snapshot, never
 * assumed**: once a `flash-result` for the flashed link arrives, this
 * panel reports "Calibration firmware `<version>` confirmed" only if the
 * *current* `device.program` (the fresh post-flash/re-identify snapshot)
 * is actually a calibration build; otherwise it names the program
 * actually reported, or the flash's own error/timeout text.
 *
 * Flashing targets the routed `link` when it can itself be flashed
 * (`canBeFlashed`, a per-link capability read, never a hardcoded
 * transport string), else the device's own other USB-capable link. With
 * none, the panel says so plainly and shows no button. Ticket 018-014
 * (host-side, concurrent) will make `link.capabilities.flash` true for a
 * farm-hosted robot too via the mbflash TCP service -- this panel does
 * not special-case that, it just keeps reading `canBeFlashed`, so the
 * button lights up on its own once that capability flips; the no-link
 * hint's wording already covers both cases.
 */
import { useEffect, useState } from "react";
import type { SnapshotDevice, SnapshotLink } from "@robot-console/host/src/wsMessages.js";
import { useFirmwareStatus, useFlashProgress, useSendable, useWsActions } from "../ws/WsProvider";
import {
  FIRMWARE_LABEL,
  PHASE_LABEL,
  canBeFlashed,
  firmwareDisabledReason,
  firmwareSourceText,
  isCalibrationProgram,
  programVersionText,
  releaseDisplayName,
} from "../deviceDisplay";
import "./CalibrationPage.css";

export interface CalibrationFirmwarePanelProps {
  device: SnapshotDevice;
  /** The specific link this tab is showing a session for -- flashing
   * targets it directly when it can itself be flashed, else the
   * device's own other USB-capable link. */
  link: SnapshotLink;
}

export function CalibrationFirmwarePanel({ device, link }: CalibrationFirmwarePanelProps) {
  const { send, onFlashResult } = useWsActions();
  const sendable = useSendable();

  // Ticket 018-013 / stakeholder correction 2026-09-13: which link
  // actually gets flashed -- the routed link itself when it can be
  // (`canBeFlashed` reads `link.capabilities.flash`, true for a `usb`
  // link and, once ticket 018-014 lands, a farm-hosted `mbflash` link
  // too -- never a hardcoded transport string here), else the device's
  // own other flashable link, if any.
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

  const robotSource = firmwareSourceText(firmwareStatus.robot);
  const robotReleaseTagName = releaseDisplayName(firmwareStatus.robot);
  const robotReleaseName = robotReleaseTagName ?? FIRMWARE_LABEL.robot;
  // Ticket 018-017 (defect found the same day as the flash-modal work):
  // the panel's own "is running"/"confirmed" text must name the
  // firmware release version parsed from `device.program` (e.g.
  // `calibration-0.20260913.1` -> `0.20260913.1`), never
  // `device.version` -- that field is the pxt-nezha-diffdrive *library*
  // version bundled into whatever program is running (moved to the
  // Diagnostics tab as "Library version" by this same ticket), not the
  // calibration release itself. See `deviceDisplay.ts`'s `roleDisplay`
  // doc comment for the identical fix applied to the front-page card.
  const calibrationVersion = device.program !== null ? programVersionText(device.program) : null;

  function flashCalibrationFirmware(): void {
    if (!flashLink || !sendable || robotFirmwareReason !== null || flashProgress) {
      return;
    }
    setFlashOutcome(undefined);
    send({ type: "flash-start", linkId: flashLink.id, source: { kind: "release", firmware: "robot" } });
  }

  return (
    <div className="calibration-firmware-panel" aria-label="Calibration firmware">
      <h4>Calibration firmware</h4>
      {isCalibrationProgram(device.program) ? (
        <p data-testid="calibration-firmware-running">{`Calibration firmware ${calibrationVersion ?? "unknown"} is running.`}</p>
      ) : (
        <p data-testid="calibration-firmware-not-running">Program: {device.program ?? "unknown"}</p>
      )}

      {!flashLink ? (
        <p className="calibration-firmware-usb-hint" data-testid="calibration-firmware-usb-required" role="status">
          Plug the robot in over USB, or put it on a farm host, to flash.
        </p>
      ) : flashProgress ? (
        <p className="device-flash-progress" role="status" data-testid="calibration-flash-progress">
          Flashing {robotReleaseName}: {PHASE_LABEL[flashProgress.phase]}…
        </p>
      ) : (
        <>
          <button
            type="button"
            className="device-button"
            data-testid="calibration-flash-firmware"
            disabled={!sendable || robotFirmwareReason !== null}
            title={robotFirmwareReason ?? undefined}
            onClick={flashCalibrationFirmware}
          >
            Flash calibration firmware
          </button>
          {/* Ticket 018-017: mutually exclusive with the reason
           * paragraph -- "if unavailable, show the plain reason instead"
           * of the source line. */}
          {robotFirmwareReason ? (
            <p className="device-flash-hint">{robotFirmwareReason}</p>
          ) : (
            robotSource && (
              <p className="device-flash-source" data-testid="calibration-flash-source">
                {robotSource.href === null ? (
                  robotSource.repoName
                ) : (
                  <a href={robotSource.href} target="_blank" rel="noreferrer noopener">
                    {robotSource.repoName}
                  </a>
                )}{" "}
                {robotSource.tag} · {robotSource.checkedText}
              </p>
            )
          )}
        </>
      )}

      {flashOutcome &&
        !flashProgress &&
        (flashOutcome.status === "error" ? (
          <p className="device-note device-note-error" role="alert" data-testid="calibration-flash-result">
            {flashOutcome.message ?? "Flash failed."}
          </p>
        ) : flashOutcome.reidentify === "timeout" ? (
          <p className="device-note" role="status" data-testid="calibration-flash-result">
            Flashed {robotReleaseName}. Waiting for the board to come back…
          </p>
        ) : isCalibrationProgram(device.program) ? (
          <p className="credentials-result credentials-result-ok" role="status" data-testid="calibration-flash-result">
            {`Calibration firmware ${calibrationVersion ?? "unknown"} confirmed${robotReleaseTagName ? ` (${robotReleaseTagName})` : ""}.`}
          </p>
        ) : (
          <p className="device-note device-note-error" role="alert" data-testid="calibration-flash-result">
            Flashed, but the robot reports program {device.program ?? "unknown"} — not the calibration build.
          </p>
        ))}
    </div>
  );
}
