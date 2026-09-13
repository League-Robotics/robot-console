/**
 * RobotPage.tsx — `/d/:linkId` for a `kind: "robot"` device (SUC-001,
 * SUC-003, SUC-004, SUC-006, SUC-007).
 *
 * Sprint 4 shipped a placeholder shell here. Sprint 006 stacked
 * `EstopControl`, `SequencingIndicator`, `DriveControls`, and two other
 * now-retired panels (a status-request button and a raw Get/Set form)
 * alongside `DeviceConsole` into one `max-width: 46rem` column -- three
 * of those (the two retired panels and `DeviceConsole` itself) rendered
 * separate response areas reading the same underlying rx log, producing
 * a "two consoles" effect a stakeholder reported hands-on, and the
 * retired Get/Set panel had a real bug on top of that: its `-1` initial
 * reply watermark matched the endpoint's *entire* rx history before
 * anything was ever sent. Sprint 012's ticket 005 (this revision)
 * replaces that layout:
 *
 * - **Left column**: `StatusPanel` (added out-of-process, 2026-09-09 --
 *   the robot's parsed `status` reply, mounted first so a student sees
 *   the robot's own state before reaching for drive controls),
 *   `DriveControls` (held-direction `WHEELS_V` driving plus, as of
 *   2026-09-10, one-shot fixed-angle `MOVE_X` turns and the merged-in
 *   STOP/E-STOP pad -- see that component's own doc comment),
 *   `SequencingIndicator` (unchanged, read-only view of `Session`'s
 *   reliability state), `FunctionsPanel` (added out-of-process,
 *   2026-09-09 -- the robot's `FUNCS`-discovered, `RUN`-able function
 *   list, mounted below Sequencing), `ChartsPanel` (sprint 9 ticket
 *   004 -- wheel-speed bars and a rolling time-series chart fed by
 *   `useTelemetry`/`useTelemetryHeader`), `PathTracePanel` (sprint 9
 *   ticket 005 -- a top-down plot of the `ox`/`oy` position trail, with
 *   its own client-side-only Clear button, mounted below Charts), and
 *   `DistanceCalibrationWizard` (sprint 011 ticket 003 -- the `calx`
 *   distance-calibration wizard, `FUNCS`-gated per `sprint.md`'s Design
 *   Rationale, mounted below Path trace; see that component's own doc
 *   comment), and `RotationCalibrationWizard` (sprint 011 ticket 004 --
 *   the `cala` rotation-calibration wizard, same `FUNCS`-gating
 *   discipline, mounted below Distance calibration; see that
 *   component's own doc comment).
 * - **Right column**: exactly one `DeviceConsole`, sized to fill the
 *   column's available height (`RobotPage.css` overrides
 *   `DeviceConsole`'s own fixed `max-height` scoped to this column
 *   only -- every other page embedding `DeviceConsole` is unaffected),
 *   with `CommandStrip` beneath it. `CommandStrip` offers
 *   HELLO/ID/VER/STATUS (unsequenced, dispatched via plain
 *   `sendCommand`) and a free-text GET/SET pair (sequenced, dispatched
 *   the same way the retired Get/Set panel did). **No panel renders a
 *   reply area of its own** -- every reply, including `HELLO`'s
 *   host-side refusal, lands in this one `DeviceConsole`.
 * - Sprint 006's separate status-request panel and Get/Set panel, along
 *   with their separate reply areas, are retired outright (deleted, not
 *   deprecated -- both are fully superseded by `CommandStrip` + the
 *   unified console).
 *
 * **STOP/E-STOP moved into `DriveControls`'s pad, `EstopControl.tsx`
 * retired outright (out-of-process, 2026-09-10).** See `DriveControls`'s
 * own doc comment for the full rationale; the `stop-button`/
 * `estop-button`/`estop-clear-button` `data-testid`s are unchanged.
 *
 * **`program`/`version` diagnostics (sprint 011 ticket 002).** Shown
 * verbatim, near the `<h2>` name heading, whenever `device.program` is
 * non-null -- a robot that never answered `ID` (older firmware, or the
 * request timing out) renders nothing extra. Deliberately gated on the
 * *data* being present, never on whether this is a calibration build:
 * a plain robot that did answer `ID` shows the same diagnostics a
 * calibration-classified one does (`deviceDisplay.ts`'s
 * `isCalibrationProgram`) -- this keeps this page's own
 * transport-blindness property good company, nothing here branches on
 * *what kind* of robot this is, only on whether a diagnostic value
 * exists to show.
 *
 * **Transport-blindness is load-bearing, not incidental**: this page
 * and every component it mounts render off `WsProvider`'s hooks/
 * actions only — never a transport-specific link type, a hardcoded
 * transport-kind string, or the link's own transport field.
 * `RobotPage.transportBlind.test.ts` enforces this with a source scan
 * over this file and its children rather than leaving it to review
 * alone, because sprint 7's "same page, no rewrite" claim for a
 * relay-connected robot depends entirely on this property holding.
 *
 * ## Sprint 015 ticket 009: `{ device, link }`, no more probes
 *
 * Migrated off the retired `EndpointListEntry` (`{ endpoint }`). Every
 * caller (`DevicePage.tsx`'s `"robot"` dispatch arm, `RelayPage.tsx`'s
 * connected-child mount) already resolves both a `SnapshotDevice` and
 * the specific `SnapshotLink` it is showing this page for (`useLink`/
 * `useDeviceForLink` in `DevicePage`'s case, `findRelayChild` in
 * `RelayPage`'s), so this page takes both directly rather than picking
 * `device.links[0]` itself -- a device can in principle own more than
 * one link, and the caller, not this page, already knows which one is
 * "the" connectivity link a route or a relay's bridge is showing. Every
 * child that used to read `device.sessionOpen`/`device.robotStatus`/
 * `device.functions` (all fields the retired `EndpointListEntry` carried
 * flat) now reads the equivalent snapshot fields off `link.session`
 * directly (`session.robotStatus`/`session.functions`), and the
 * `StatusPanel`/`CommandStrip`/`DistanceCalibrationWizard`/
 * `RotationCalibrationWizard` panels no longer send their own one-shot
 * `STATUS`/`GET`/`FUNCS` probe on a closed->open transition: the
 * harvester (ticket 003) already probes `ID` once per identify and polls
 * `STATUS` on its own, so a panel re-deriving "ask again on open" from
 * local effect state was duplicating work the host now owns outright.
 */
import { useState } from "react";
import type { SnapshotDevice, SnapshotLink } from "@robot-console/host/src/wsMessages.js";
import { isCalibrationProgram, nameDisplay } from "../deviceDisplay";
import { CalibrationPage } from "../components/CalibrationPage";
import { ChartsPanel } from "../components/ChartsPanel";
import { CommandStrip } from "../components/CommandStrip";
import { ConfigurationPage } from "../components/ConfigurationPage";
import { DeviceConsole } from "../components/DeviceConsole";
import { DriveControls } from "../components/DriveControls";
import { DriveTab } from "../components/DriveTab";
import { FunctionsPanel } from "../components/FunctionsPanel";
import { PathTracePanel } from "../components/PathTracePanel";
import { StatusPanel } from "../components/StatusPanel";
import "./RobotPage.css";

export interface RobotPageProps {
  device: SnapshotDevice;
  /** The specific link this page is showing a session for -- the
   * routed link (`DevicePage`) or the relay's bridged child link
   * (`RelayPage`). See this module's doc comment ("Sprint 015 ticket
   * 009") for why the caller, not this page, resolves it. */
  link: SnapshotLink;
}

/** OOP 2026-09-10: the robot page is split into tabs next to the
 * robot's name (stakeholder direction): Main (status, drive, console),
 * Drive (`DriveTab`: the pad alone, plus cursor keys and a gamepad),
 * Calibration (`CalibrationPage`: both wizards feeding one code block
 * -- only offered for a calibration-classified robot), and Functions & charts (functions and the drive pad on one side,
 * charts and the path trace on the other). Sequencing state moved into the console's
 * own header (`DeviceConsole`) rather than a page panel. */
export type RobotTab = "main" | "drive" | "calibration" | "functions" | "configuration";

export function RobotPage({ device, link }: RobotPageProps) {
  const hasCalibration = isCalibrationProgram(device.program);
  const [selectedTab, setSelectedTab] = useState<RobotTab>("main");
  const tab: RobotTab = selectedTab === "calibration" && !hasCalibration ? "main" : selectedTab;
  const tabs: Array<{ id: RobotTab; label: string }> = [
    { id: "main", label: "Main" },
    { id: "drive", label: "Drive" },
    ...(hasCalibration ? [{ id: "calibration" as const, label: "Calibration" }] : []),
    { id: "functions", label: "Functions & charts" },
    { id: "configuration", label: "Configuration" },
  ];

  return (
    <section className="robot-page" aria-label="Robot device">
      <div className="robot-page-title-row">
        <h2>{nameDisplay(device).text}</h2>
        <div className="robot-page-tabs" role="tablist" aria-label="Robot pages">
          {tabs.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="tab"
              aria-selected={tab === entry.id}
              className={tab === entry.id ? "robot-page-tab robot-page-tab-active" : "robot-page-tab"}
              data-testid={`robot-tab-${entry.id}`}
              onClick={() => setSelectedTab(entry.id)}
            >
              {entry.label}
            </button>
          ))}
        </div>
      </div>

      {device.program !== null && (
        <p className="robot-page-diagnostics" data-testid="robot-page-diagnostics">
          Program: {device.program}
          {" · "}
          Version: {device.version}
        </p>
      )}

      {tab === "main" && (
        <div className="robot-page-columns" data-testid="robot-tab-panel-main">
          <div className="robot-page-column robot-page-column-left">
            <div className="robot-page-panel">
              <StatusPanel link={link} />
            </div>

            <div className="robot-page-panel">
              <h3>Drive</h3>
              <DriveControls link={link} />
            </div>
          </div>

          <div className="robot-page-column robot-page-column-right robot-page-column-console">
            <DeviceConsole link={link} name={device.name} />
            <CommandStrip link={link} />
          </div>
        </div>
      )}

      {tab === "drive" && <DriveTab link={link} />}

      {tab === "calibration" && <CalibrationPage link={link} name={device.name} />}

      {tab === "configuration" && <ConfigurationPage device={device} />}

      {tab === "functions" && (
        <div className="robot-page-columns" data-testid="robot-tab-panel-functions">
          <div className="robot-page-column robot-page-column-left">
            <div className="robot-page-panel">
              <h3>Functions</h3>
              <FunctionsPanel link={link} name={device.name} />
            </div>
            {/* OOP 2026-09-10: the drive pad rides along on this tab too,
                so a student can drive while watching functions/charts. */}
            <div className="robot-page-panel">
              <h3>Drive</h3>
              <DriveControls link={link} />
            </div>
          </div>
          <div className="robot-page-column robot-page-column-right">
            <div className="robot-page-panel" aria-label="Charts">
              <h3>Charts</h3>
              <ChartsPanel linkId={link.id} />
            </div>
            <div className="robot-page-panel" aria-label="Path trace">
              <h3>Path trace</h3>
              <PathTracePanel linkId={link.id} />
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
