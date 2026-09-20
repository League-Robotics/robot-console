/**
 * CalibrationPage.tsx — the robot page's Calibration tab (OOP
 * 2026-09-10, stakeholder direction; expanded ticket 018-013; corrected
 * 018-013, stakeholder 2026-09-13).
 *
 * One calibration *state* per robot (persisted per robot name in
 * localStorage), one block of code to paste, and the wizards/run
 * controls feeding that state. The state shape, its undefined-stripping
 * merge, and the derived-value/code-generation math moved to
 * `lib/calibration.ts` (ticket 017-008), shared with
 * `ConfigurationPage.tsx`; the "current calibration" table moved to
 * `components/CalibrationTable.tsx`, shared the same way. See that
 * module's own doc comment for the wheel-diameter/track-width/
 * effective-width/slip relationship this page's wizards feed.
 *
 * ## Ticket 018-013, corrected 2026-09-13: firmware flash lives here too,
 * FUNCS never hides a run
 *
 * `f1b0e8d` put this tab's original flash/run/console shape here under a
 * commit message that mis-cited it as ticket "018-010"; a same-day
 * follow-up pass then moved the flash panel to the Configuration tab.
 * The stakeholder's own correction reverses that move: "If we have a
 * Calibrate tab, then we don't need calibration under the Configuration
 * tab. You can just put it under Calibrate." The root cause of a
 * concrete failure this same pass diagnosed -- a robot with `cala`
 * genuinely registered on the firmware reading as CalX-only -- was a
 * dropped Wi-Fi burst line in `FUNCS`'s own reply, ack included, list
 * incomplete; the fix generalizes to a rule this tab now holds
 * everywhere: **`FUNCS` must never hide or block a calibration run.**
 *
 *  1. **`CalibrationFirmwarePanel`** (`./CalibrationFirmwarePanel.tsx`)
 *     mounts at the top of the left column -- the flash/verify block,
 *     unchanged in behavior, just relocated back here and reading
 *     `device` directly rather than through `ConfigurationPage`.
 *  2. **Both wizards always render**, no `FUNCS`-derived hide/show. A
 *     robot whose `FUNCS` reply is silent on `cala` (dropped over Wi-Fi,
 *     or never asked) still gets a Calibrate A button -- disabling or
 *     hiding it on absent evidence is exactly the failure mode that
 *     produced "only CalX" on a robot that has `cala` right there in its
 *     firmware. Each wizard shows its own non-blocking hint instead (see
 *     `DistanceCalibrationWizard.tsx`/`RotationCalibrationWizard.tsx`).
 *     `FUNCS` is still requested once, on mount, if the session has no
 *     function list yet -- not to gate the two wizards any more, but so
 *     any *other* `cal*` name it lists still gets its own
 *     `GenericCalibrationRun` control below them.
 *  3. **No filtered console on this tab.** `CalibrationConsole.tsx` (a
 *     second, calibration-only view of the same link's log) is retired
 *     outright -- the right column's full, unfiltered `DeviceConsole`
 *     already shows every line, calibration traffic included, and a
 *     second filtered view of the same log added confusion (which
 *     console has the line?) without adding information.
 *  4. **The robot's own reported track width and slip** (`calturn.
 *     result`'s `b`/`tw`/`slip` fields as of OOP 2026-09-18; formerly
 *     `cala`'s `measured b=`/`derived slip=` lines) still update
 *     `CalibrationState.reportedTrackWidthCm`/`robotTrackWidthCm`/
 *     `firmwareSlip`, shown alongside this page's own computed
 *     `rotationalSlip` in `CalibrationTable.tsx` -- see `lib/
 *     calibration.ts`'s own doc comment for why the two slip numbers
 *     are never merged.
 *
 * ## Ticket 018-018: the right column is viewport-bound too
 *
 * The right column now carries `robot-page-column-console`
 * (`RobotPage.css`), the same sticky/viewport-height class the Main
 * tab's column already used -- previously this column had no height
 * bound at all, so a long "Current calibration" table plus a growing
 * console log pushed the send line down and eventually off screen
 * (stakeholder report, 2026-09-14). The "Current calibration" panel
 * NO LONGER carries `robot-page-column-top` (2026-09-19): that class
 * caps a panel at `calc(100vh - ... - 19rem)` to leave room for the
 * console BELOW it in the same column, and the console moved to the
 * left column. Keeping it would have reserved 19rem for a console that
 * is not there, scrolling this table internally for no reason. The old
 * text below describes the arrangement it had then, so it shrinks
 * and scrolls internally before the console log's own floor gives; see
 * `RobotPage.css`'s doc comment on both classes for the full mechanism.
 *
 * **Sprint 022 ticket 007 update**: the console that moved to the left
 * column above has since been deleted outright (superseded by
 * `ConsoleDock`) -- the left column no longer carries
 * `robot-page-column-console` either. This right column was never
 * viewport-bound to begin with (no console ever sat in it), so it is
 * unaffected by that deletion; it is documented here only so a reader
 * following "the console moved to the left column" above does not go
 * looking for it there and find nothing.
 *
 * ## Ticket 022-001: the code block now calls `programCode()`, not
 * `calibrationCode()` directly -- radio and Wi-Fi join calibration
 *
 * The stakeholder: "the Calibration Code for Your Program section
 * should also include Wi-Fi... you should be using the same code for
 * that section as the configuration page." This page already had
 * everything `programCode()` needs for radio (`device.radio`, already a
 * prop); Wi-Fi needed one more thing this page never had: something
 * that actually asks the host for the stored network. `useWifiCredentials()`
 * is a global `WsProvider` hook, callable from anywhere, but the store
 * slice it reads only fills in once *something* sends
 * `get-wifi-credentials` -- previously only `ConfigurationPage.tsx` did,
 * on its own mount. That request moved up to `RobotPage.tsx` (this
 * page's own doc comment doesn't need to explain why twice; see that
 * file's), so a student calibrating without ever opening the
 * Configuration tab still gets a populated (or explicitly masked) Wi-Fi
 * line here. `calibrationCode()` itself -- imported by `programCode.ts`,
 * not by this page any more -- computes exactly what it always did; only
 * this page's call site changed.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { RobotFunction, SnapshotDevice, SnapshotLink } from "@robot-console/host/src/wsMessages.js";
import {
  CALIBRATION_IMAGE_BASELINE_DIAMETER_MM,
  applyCalibrationPatch,
  calibToDiameterMm,
  deriveCalibration,
  readCalibrationState,
  round,
  writeCalibrationState,
  type CalibrationPatch,
  type CalibrationState,
} from "../lib/calibration";
import { useCopied } from "../lib/clipboard";
import { programCode } from "../lib/programCode";
import { isLinkUsable } from "../deviceDisplay";
import { useLinkLog, useSendable, useWifiCredentials, useWsActions } from "../ws/WsProvider";
import { CalibrationFirmwarePanel } from "./CalibrationFirmwarePanel";
import { CalibrationHelp } from "./CalibrationHelp";
import { NewCalibrationPanel } from "./NewCalibrationPanel";
import { deriveCalStoreState } from "./CalibrationStore";
import { CalibrationTable } from "./CalibrationTable";
import "./CalibrationPage.css";

export interface CalibrationPageProps {
  link: SnapshotLink;
  /** The owning device's already-resolved name -- see `RobotPage.tsx`'s
   * doc comment ("Sprint 015 ticket 009") for why the caller resolves
   * both `link` and `name` rather than this page re-deriving them from
   * a retired flat endpoint shape. */
  name: string;
  /** The owning device snapshot -- stakeholder correction 2026-09-13:
   * `CalibrationFirmwarePanel` needs `device.program`/`device.version`/
   * `device.links` for the flash/verify block now mounted here. */
  device: SnapshotDevice;
}

/** `calwheels`/`calturn` get their stakeholder-specified labels
 * verbatim; any other `cal*` name `FUNCS` reports is labelled from its
 * own suffix -- ticket 018-013's own required truth: "do not guess a
 * third verb" (now doubly true after two renames in one day, OOP
 * 2026-09-18: `calx`/`cala` -> `calj`/`calc` -> `calwheels`/`calturn`). */
export function calibrationFunctionLabel(name: string): string {
  if (name === "calwheels") {
    return "Calibrate wheels (distance)";
  }
  if (name === "calturn") {
    return "Calibrate turn (rotation)";
  }
  return `Calibrate ${name.slice(3)}`;
}

interface GenericCalibrationRunProps {
  link: SnapshotLink;
  name: string;
}

/** A run control for a `cal*` function this page has no dedicated wizard
 * for -- one button, gated exactly like `FunctionsPanel.tsx`'s own Go
 * button (`isLinkUsable` + `useSendable`), dispatching a bare
 * `RUN <name>` with no arguments. Its output (any `<NAME_PREFIX>:` lines
 * the firmware emits, plus the RUN's own ack/err) shows up in
 * `CalibrationConsole` below, not inline here -- this control's only job
 * is to send the run. */
function GenericCalibrationRun({ link, name }: GenericCalibrationRunProps) {
  const sendable = useSendable();
  const linkOpen = isLinkUsable(link) && sendable;
  const { sendCommand } = useWsActions();
  const label = calibrationFunctionLabel(name);

  return (
    <div className="calibration-generic-run" aria-label={label}>
      <span className="calibration-generic-run-label">{label}</span>
      <button
        type="button"
        className="calibration-generic-run-go"
        data-testid={`calibration-run-${name}`}
        disabled={!linkOpen}
        onClick={() => sendCommand(link.id, "RUN", [name])}
      >
        Run
      </button>
      {!linkOpen && (
        <p className="calibration-generic-run-hint" data-testid={`calibration-run-${name}-hint`} role="status">
          Open a link to this robot to run {name}.
        </p>
      )}
    </div>
  );
}

export function CalibrationPage({ link, name, device }: CalibrationPageProps) {
  const robotName = name;
  const [state, setState] = useState<CalibrationState>(() => readCalibrationState(robotName));
  useEffect(() => {
    writeCalibrationState(robotName, state);
  }, [robotName, state]);

  const derived = useMemo(() => deriveCalibration(state), [state]);

  // The robot's own `calshow` store (profile calibration-0.20260919.4) --
  // see `CalibrationStorePanel.tsx`'s own doc comment for why this is
  // the one input the generated code below needs that this session's
  // own wizard runs can never provide: a student who calibrated from
  // the robot's own A/B menu, with no computer attached, has a
  // `CalibrationState` that is entirely empty in this browser.
  const log = useLinkLog(link.id);
  const calStoreState = useMemo(() => deriveCalStoreState(log), [log]);
  const calStoreValues = calStoreState.values;

  // Ticket 022-001: the same global Wi-Fi store `ConfigurationPage.tsx`
  // reads -- `RobotPage.tsx` is what actually requests it now (see this
  // file's own doc comment), so this page only ever reads what's
  // already there, exactly like `ConfigurationPage.tsx` does.
  const stored = useWifiCredentials();

  const code = useMemo(
    () =>
      programCode({
        robotName,
        radio: device.radio,
        wifi: stored?.ssid ? { ssid: stored.ssid, password: stored.password } : undefined,
        calibration: state,
        calibrationOptions: { calStore: calStoreValues, firmwareProfile: device.program },
      }),
    [robotName, device.radio, stored, state, calStoreValues, device.program],
  );
  const { copied, copy } = useCopied();

  // Named here (not only in the pasted snippet's own comments) per this
  // ticket's own requirement: a student reading the page, not just the
  // code, should see which calibration is still missing and that
  // running it replaces the default the snippet is using meanwhile.
  // Gated on `calStoreValues !== undefined` -- until `calshow` has
  // actually answered, this page has no evidence either calibration is
  // missing (only that this browser's own session hasn't measured it),
  // so it says nothing rather than guessing.
  const stillMissing: string[] = [];
  if (calStoreValues !== undefined) {
    if (state.wheelDiameterMm === undefined && !calStoreValues.hasWheel) {
      stillMissing.push("wheel calibration");
    }
    if (derived.trackWidthCm === undefined && state.firmwareSlip === undefined && !calStoreValues.hasTurn) {
      stillMissing.push("rotation calibration");
    }
  }

  const sendable = useSendable();
  const linkOpen = isLinkUsable(link) && sendable;
  const { sendCommand } = useWsActions();
  const functions: RobotFunction[] | undefined = link.session?.functions ?? undefined;
  const functionsUnknown = functions === undefined;

  // Ticket 018-013: this tab specifically needs the function list before
  // it can decide which run controls to draw, so (unlike every other
  // panel `RobotPage` mounts since sprint 015 ticket 009) it asks once,
  // on open, if nothing has asked yet this session.
  useEffect(() => {
    if (functionsUnknown && linkOpen) {
      sendCommand(link.id, "FUNCS");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fires again only when "do we have a list yet" flips, or the link/openness identity changes
  }, [link.id, linkOpen, functionsUnknown]);

  // Stakeholder correction (2026-09-13): `FUNCS` must never hide or
  // block a calibration run -- both wizards below always render,
  // regardless of what this list does or doesn't contain (a dropped
  // Wi-Fi burst line can make a genuinely-registered `cala` vanish from
  // the ack'd reply). This list only ever adds a control now, never
  // removes one: any *other* `cal*` name it reports gets its own
  // `GenericCalibrationRun` below the two dedicated wizards.
  // Deduped: a duplicated FUNCS entry must never render two identical
  // controls. `connect/harvester.ts` resets the list per request now
  // (26c5d57), but a host running an older build still accumulates, and
  // a doubled row here is both ugly and a colliding React key.
  const calFunctionNames = useMemo(
    () => [...new Set((functions ?? []).map((fn) => fn.name).filter((n) => n.startsWith("cal")))],
    [functions],
  );
  // `calwheels`/`calturn` have dedicated wizards. `calshow`/`calclear`
  // are plumbing the page already drives for itself -- `calshow` is sent
  // on connect and behind the store panel's Refresh, `calclear` behind
  // its confirmed Clear button. Rendering them again as bare "Run"
  // controls gave the page two ways to do the same thing, one of them
  // unlabelled and unguarded: a stray click on a generic "Calibrate
  // clear / Run" would wipe a student's stored calibration with no
  // confirmation at all.
  // `calsave` joins this set for the same reason `calclear` is in it:
  // rendered generically it becomes a button labelled "Calibrate save"
  // (calibrationFunctionLabel just drops the `cal` prefix), which means
  // nothing to anybody and writes the robot's stored calibration on a
  // stray click. The New Calibration panel's Done button is the only
  // thing that should ever send it.
  const HANDLED_CAL_FUNCTIONS = new Set(["calwheels", "calturn", "calshow", "calclear", "calsave"]);
  const extraCalFunctionNames = calFunctionNames.filter((n) => !HANDLED_CAL_FUNCTIONS.has(n));

  function update(patch: CalibrationPatch): void {
    setState((previous) => applyCalibrationPatch(previous, patch));
  }

  // A terminal wizard run changes what `calshow` would now report (a
  // succeeded run stores a fresh value and bumps its run count; a
  // failed one still bumps nothing but is worth reconfirming) -- asking
  // again immediately keeps `CalibrationStorePanel` honest without
  // waiting on its own manual Refresh button.
  function refreshCalStore(): void {
    if (isLinkUsable(link) && sendable) {
      sendCommand(link.id, "RUN", ["calshow"]);
    }
  }

  const [helpOpen, setHelpOpen] = useState(false);

  // ASK THE ROBOT WHAT IT IS RUNNING, as soon as the link is up.
  // `CalibrationStorePanel` used to own this request; with that panel
  // gone (stakeholder, 2026-09-19: "we don't need to know that it's
  // stored calibration -- it's part of current calibration") the page
  // sends it, because a robot this browser never measured has no other
  // source for its own numbers.
  const askedOnRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!isLinkUsable(link) || !sendable) {
      askedOnRef.current = undefined;
      return;
    }
    if (askedOnRef.current === link.id) return;
    askedOnRef.current = link.id;
    sendCommand(link.id, "RUN", ["calshow"]);
  }, [link, sendable, sendCommand]);

  // SEED THE TABLE FROM THE ROBOT'S OWN STORE, once, and only into
  // fields this session has nothing for -- a value measured in this
  // browser is fresher than the one the robot booted with and must not
  // be overwritten by a late `calshow` reply.
  //
  // Reconstructing the four-row view from what `calstore` keeps: the
  // store holds the TRACK width and the slip, and effective = track /
  // slip. A stored slip of exactly 1 means nobody ever entered a
  // caliper measurement (that is what a slip of 1 IS -- see
  // `deriveCalibration`), so the track width is left blank rather than
  // filled with a number the robot only ever derived.
  const seededRef = useRef(false);
  useEffect(() => {
    if (calStoreValues === undefined || seededRef.current) return;
    seededRef.current = true;
    const patch: CalibrationPatch = {};
    if (calStoreValues.hasWheel && state.wheelDiameterMm === undefined) {
      patch.wheelDiameterMm = calibToDiameterMm(calStoreValues.wheelCalib);
      patch.wheelDiameterSource = "distance-calibration";
    }
    if (calStoreValues.hasTurn && state.reportedTrackWidthCm === undefined && calStoreValues.slip > 0) {
      const effectiveCm = round(calStoreValues.trackWidthCm / calStoreValues.slip, 3);
      patch.reportedTrackWidthCm = effectiveCm;
      // No rescale: the stored effective width is already denominated
      // in the stored wheel.
      patch.reportedWithDiameterMm = patch.wheelDiameterMm ?? state.wheelDiameterMm;
      if (calStoreValues.slip !== 1 && state.measuredTrackWidthCm === undefined) {
        patch.measuredTrackWidthCm = calStoreValues.trackWidthCm;
      }
    }
    if (Object.keys(patch).length > 0) update(patch);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- seeds once, from the first calshow reply
  }, [calStoreValues]);

  return (
    <div className="robot-page-columns calibration-page" data-testid="robot-tab-panel-calibration">
      {/* Sprint 022 ticket 007: no more console on the left. Until this
          ticket, a run's own lines landed in a `ConsolePane` mounted
          below these two panels (stakeholder, 2026-09-19: "console on
          the left, the things you act on on the right") -- kept
          alongside the already-working `ConsoleDock` for four tickets so
          the dock could be proven live before this copy was deleted
          (sprint.md's Migration Concerns). That proof is done: a run's
          output now shows up in the one dock every device page already
          has, and this column drops `robot-page-column-console`'s
          viewport binding along with the console it used to leave room
          for -- the firmware panel and the calibration flow below just
          take their own natural height now. */}
      <div className="robot-page-column robot-page-column-left">
        <CalibrationFirmwarePanel device={device} link={link} />

        <NewCalibrationPanel link={link} state={state} onPatch={update} onStoreChanged={refreshCalStore} />
      </div>

      <div className="robot-page-column robot-page-column-right">
        {extraCalFunctionNames.map((fnName) => (
          <GenericCalibrationRun key={fnName} link={link} name={fnName} />
        ))}

        <div className="robot-page-panel" aria-label="Current calibration">
          <h3>
            Current calibration
            <button
              type="button"
              className="calibration-help-button"
              data-testid="calibration-help-open"
              onClick={() => setHelpOpen(true)}
            >
              How to calibrate
            </button>
          </h3>
          <CalibrationTable variant="calibration" state={state} derived={derived} onPatch={update} />
          <button
            type="button"
            className="calibration-reset"
            data-testid="calibration-reset"
            onClick={() => setState({})}
            disabled={Object.keys(state).length === 0}
          >
            Start over
          </button>
        </div>

        <div className="robot-page-panel calibration-code-panel" aria-label="Calibration code">
          <h3>Code for your program</h3>
          {stillMissing.length > 0 && (
            <p className="calibration-code-missing" data-testid="calibration-code-missing" role="status">
              Still missing: {stillMissing.join(" and ")} — the code below uses the firmware's compiled default until
              you run {stillMissing.length > 1 ? "them" : "it"}.
            </p>
          )}
          {code === "" ? (
            <p className="calibration-code-empty" data-testid="calibration-code-empty">
              Nothing to paste yet — press Start to calibrate.
            </p>
          ) : (
            <>
              <pre className="calibration-code" data-testid="calibration-code">
                {code}
              </pre>
              <button
                type="button"
                className="calibration-code-copy"
                data-testid="calibration-code-copy"
                onClick={() => copy(code)}
              >
                {copied ? "Copied" : "Copy"}
              </button>
            </>
          )}
        </div>
      </div>

      <CalibrationHelp open={helpOpen} onClose={() => setHelpOpen(false)} />
    </div>
  );
}
