/**
 * CalibrationHelp.tsx — the how-to, behind a button.
 *
 * The two wizard panels this page used to carry explained themselves
 * inline: what the eye-shaped field is, how to lay out the iron cross,
 * where to stand the robot, what the transition count meant. That text
 * was correct and is worth keeping, but it was on screen permanently
 * for the benefit of somebody reading it once (stakeholder, 2026-09-19:
 * "you don't have to put the instructions in line, you can have a
 * little help button").
 *
 * So it lives here, opened on demand and closed again. No state worth
 * persisting, no link, no sends -- it is a page of prose.
 */
import { useEffect, useRef } from "react";
import "./CalibrationHelp.css";

export interface CalibrationHelpProps {
  open: boolean;
  onClose: () => void;
}

export function CalibrationHelp({ open, onClose }: CalibrationHelpProps) {
  const closeRef = useRef<HTMLButtonElement | null>(null);

  // Escape closes, and focus lands on Close when it opens -- the two
  // things a keyboard user expects from anything modal, and the reason
  // this is a real dialog rather than a div that looks like one.
  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="calibration-help-backdrop" onClick={onClose} data-testid="calibration-help-backdrop">
      <div
        className="calibration-help"
        role="dialog"
        aria-modal="true"
        aria-label="How to calibrate"
        data-testid="calibration-help"
        onClick={(event) => event.stopPropagation()}
      >
        <h3>How to calibrate</h3>

        <h4>Before you start</h4>
        <p>
          Calibration is two measurements, taken in order. The turn measurement is made by driving the wheels, so it
          only means anything against the wheel that was on the robot at the time — which is why re-running the wheel
          calibration makes you run the turn again.
        </p>

        <h4>1 · Calibrate wheels</h4>
        <p>
          Lay the robot on the eye-shaped field with both lines across its path. Measure the distance between the two
          lines with a tape and type that in — everything the run concludes is scaled by that number, so measure it
          properly once rather than twice.
        </p>
        <p>
          Stand the robot on clear white paper before the first line, square to it, and press Calibrate wheels. It
          drives to the first line, on to the second, and reports the wheel diameter it must have to make those two
          crossings that far apart.
        </p>
        <p>
          Run it more than once if you want a better number. The runs are collected and averaged, and the standard
          deviation tells you whether to believe them: a few hundredths of a millimetre is a good calibration, a few
          tenths means something moved.
        </p>

        <h4>2 · Calibrate turns</h4>
        <p>
          Lay out the alternating iron cross — eight 45° radial wedges — and stand the robot centred on it. Press
          Calibrate turns. It spins in place and counts the wedges going past, which tells it the effective track
          width: the wheel spacing that makes its own turn arithmetic come out right.
        </p>

        <h4>3 · Done</h4>
        <p>
          Done averages what you collected, writes it to the robot, and stores it there so it survives being switched
          off. Paste the code on the right into your program too, so a future reflash does not lose it.
        </p>

        <h4>Measured track width, and why it is optional</h4>
        <p>
          A spin measures <em>one</em> thing: the effective track width. The real distance between the wheel centres
          is something only a caliper can tell you, so if you have not measured it, the robot uses the effective width
          as the track and the rotational slip is 1 by definition.
        </p>
        <p>
          Measure across the wheel centres with a caliper and type it into Measured track width, and the slip becomes
          the ratio of the two — how much the wheels scrub sideways as the robot turns. It is worth doing once per
          chassis; it does not change when you swap a wheel.
        </p>

        <button type="button" className="calibration-help-close" data-testid="calibration-help-close" ref={closeRef} onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}
