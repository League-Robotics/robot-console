/**
 * lib/programCode.ts — the one function that generates the complete
 * "Code for your program" block a student pastes into MakeCode: radio
 * setup, Wi-Fi setup (or a masked placeholder), and every calibration
 * line, for one robot (sprint 022 ticket 001).
 *
 * Moved out of `ConfigurationPage.tsx`, which used to hold the only
 * copy of this logic (unexported, as `configurationCode`), while
 * `CalibrationPage.tsx` called `calibrationCode()` from `lib/
 * calibration.ts` directly for a strictly smaller block -- no radio, no
 * Wi-Fi. The stakeholder's own words: "we're going to make the
 * Calibration Code for Your Program section always include all of the
 * code for the program... you should be using the same code for that
 * section as the configuration page." A pure function with no React
 * import and no store access of its own (unlike `configurationCode`'s
 * old home inside a page component) is what makes that literally true
 * rather than aspirationally true: `CalibrationPage.tsx` and
 * `ConfigurationPage.tsx` both import this exact module now, so there
 * is only one function left to call -- the two pages can no longer
 * drift into two different outputs the way a page-local
 * `configurationCode` and a page-local direct `calibrationCode()` call
 * previously could (and had). It lives in `lib/`, not `components/`,
 * for the same reason `lib/calibration.ts` already does: a value two
 * components must agree on belongs in a module neither of them owns,
 * testable on its own with no DOM/mount required -- see
 * `programCode.test.ts`. The two call sites that depend on this
 * module's output agreeing are exactly those two pages.
 *
 * `calibrationCode()` in `lib/calibration.ts` is an unmodified
 * dependency -- this module never recomputes what it already knows how
 * to compute (the wheel/track/slip precedence, the `calshow`-store
 * fallback tiers, the firmware-measured-vs-locally-derived-slip
 * distinction that module's own doc comment insists on never merging).
 * It only ever splices that output in, exactly as `configurationCode`
 * always did. Per this ticket's own scope: no change to what
 * `calibrationCode()` itself computes.
 */
import {
  calibrationCode,
  type CalibrationCodeOptions,
  type CalibrationState,
} from "./calibration";

/** Shown in place of a real password whenever the caller has a stored
 * network but hasn't asked the host to reveal it -- moved verbatim from
 * `ConfigurationPage.tsx`, unchanged. */
export const MASKED_PASSWORD = "••••••••";

/** A JSON-quoted JS string literal. Exported now (it was a private,
 * unexported helper inside `ConfigurationPage.tsx` before this move) so
 * this module's own callers -- and its own test file -- can reach it
 * the same way they reach `MASKED_PASSWORD`, rather than one moved
 * export and one left stranded. */
export function jsString(value: string): string {
  return JSON.stringify(value);
}

export interface ProgramCodeInput {
  robotName: string;
  /** The device's own radio address. Both call sites read
   * `device.radio` here -- deliberately typed as a plain `{ channel,
   * group }` shape rather than importing `RadioAddress` from
   * `pages/RelayPage.tsx`, so this module (a `lib/` pure function per
   * its own doc comment) takes no dependency on a page component. */
  radio: { channel: number; group: number } | undefined;
  wifi: { ssid: string; password: string | undefined } | undefined;
  calibration: CalibrationState;
  /** Forwarded verbatim to `calibrationCode()` -- see that function's
   * own `CalibrationCodeOptions` doc comment for what `calStore`/
   * `firmwareProfile` mean. Only `CalibrationPage` supplies this: it
   * has a `calshow`-derived store to fall back on for a robot this
   * browser session never itself measured. `ConfigurationPage` has
   * never plumbed a `calStore`, and leaving this `undefined` (rather
   * than passing an explicit empty object) on its call site keeps its
   * behavior byte-for-byte what it already was before this move --
   * `calibrationCode`'s own "haven't asked yet" branch is keyed on
   * `options?.calStore === undefined`, never invented for a page that
   * never asks. */
  calibrationOptions?: CalibrationCodeOptions;
}

/** The one block a student pastes into their program's setup -- radio,
 * Wi-Fi, and calibration, for one robot. Renamed from the
 * `configurationCode` it replaces (ticket 022-001; the name now belongs
 * to what it generates -- "the program's code" -- not to which tab used
 * to be its only caller). Both `CalibrationPage.tsx` and
 * `ConfigurationPage.tsx` call this one function for what they display,
 * per sprint 022's Architecture §3 module 5 / SUC-005. */
export function programCode(input: ProgramCodeInput): string {
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
  const calibration = calibrationCode(input.calibration, input.robotName, input.calibrationOptions);
  if (calibration !== "") {
    // Drop calibrationCode's own header line -- see this module's own
    // doc comment for why: one program, one header comment, this
    // module's own (`// <name> configuration`) rather than two stacked
    // comments for what is, after this ticket, one program. This splice
    // predates this module (it lived in `ConfigurationPage.tsx`'s own
    // `configurationCode` before the move) and is preserved verbatim,
    // unchanged in behavior.
    lines.push(...calibration.split("\n").slice(1));
  }
  return lines.length === 1 ? "" : lines.join("\n");
}
