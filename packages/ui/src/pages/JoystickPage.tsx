/**
 * JoystickPage.tsx — `/d/:linkId` for a device that announced itself as
 * a joystick (2026-09-21).
 *
 * ## Deliberately small, and why
 *
 * The stakeholder was explicit about scope: "I don't know what we're
 * going to do with joysticks, but I just want you to recognize them and
 * put them there." So this page does exactly that and stops. It names
 * the board, says what it is, offers a flash, and lets the debug console
 * dock (mounted by `DevicePage`, not here) show its serial traffic.
 *
 * There is no drive pad, no calibration flow, no configuration tab. A
 * joystick is not driveable — it is the thing that *does* the driving,
 * over radio, to a robot that has no idea which joystick is talking to
 * it. Giving this page a robot's tab strip would offer controls that
 * cannot work, which is worse than offering none.
 *
 * ## What it will not show you
 *
 * Almost nothing arrives here at runtime. `Remote-Joystick-Student`
 * emits its banner and otherwise says nothing on serial — it spends its
 * life transmitting over radio, which this console cannot see from a USB
 * link. So an idle-looking console pane under a joystick is correct, not
 * a fault, and the page says so rather than leaving a student watching
 * an empty log wondering what broke.
 *
 * ## Flash options
 *
 * Restricted to joystick firmware, matching what sprint 023 ticket 006
 * did for robots and relays: a device page offers its own kind and
 * nothing else, so nobody turns a working joystick into a robot by
 * reaching for the wrong button on the wrong page.
 */
import { useEffect } from "react";
import type { SnapshotDevice, SnapshotLink } from "@robot-console/host/src/wsMessages.js";
import type { ActiveConsoleTarget } from "./DevicePage";
import { FlashDialog } from "../components/FlashDialog";
import { nameDisplay, roleDisplay } from "../deviceDisplay";
import "./JoystickPage.css";

export interface JoystickPageProps {
  device: SnapshotDevice;
  link: SnapshotLink;
  onActiveTargetChange: (target: ActiveConsoleTarget) => void;
}

export function JoystickPage({ device, link, onActiveTargetChange }: JoystickPageProps) {
  const name = nameDisplay(device).text;

  useEffect(() => {
    onActiveTargetChange({ link, name });
  }, [link, name, onActiveTargetChange]);

  return (
    <section className="joystick-page" aria-label="Joystick">
      <h2 className="joystick-page-name">{name}</h2>
      <p className="joystick-page-role">{roleDisplay(device)}</p>

      <p className="joystick-page-note">
        This is a joystick — it drives a robot over radio. It announces itself here, then talks only to the robot, so
        the debug console below stays quiet while it is running. That is normal.
      </p>

      {/* Its own kind only, exactly as a robot's page offers robot
          firmware and a relay's offers relay firmware. */}
      <FlashDialog link={link} name={name} allowedFirmware={["joystick"]} allowLocalHex={false} />
    </section>
  );
}
