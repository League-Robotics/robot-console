/**
 * RobotPage.tsx — `/d/:endpointId` for a `robot`-classified endpoint
 * (SUC-001, SUC-003, SUC-004, SUC-006, SUC-007).
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
 *   list, mounted below Sequencing), and `ChartsPanel` (sprint 9 ticket
 *   004 -- wheel-speed bars and a rolling time-series chart fed by
 *   `useTelemetry`/`useTelemetryHeader`; the path-trace panel is
 *   ticket 005's job and not mounted here).
 * - **Right column**: exactly one `DeviceConsole`, sized to fill the
 *   column's available height (`RobotPage.css` overrides
 *   `DeviceConsole`'s own fixed `max-height` scoped to this column
 *   only -- every other page embedding `DeviceConsole` is unaffected),
 *   with `CommandStrip` beneath it. `CommandStrip` offers
 *   HELLO/ID/VER/STATUS (unsequenced, dispatched via plain
 *   `sendCommand`) and a free-text GET/SET pair (sequenced, dispatched
 *   the same way the retired Get/Set panel did). **No panel renders a
 *   reply area of its own** -- every reply, including `HELLO`'s
 *   host-side refusal (`deviceRegistry.ts:945-951`, surfaced via ticket
 *   012-003's error-routing into this same log), lands in this one
 *   `DeviceConsole`.
 * - Sprint 006's separate status-request panel and Get/Set panel, along
 *   with their separate reply areas, are retired outright (deleted, not
 *   deprecated -- both are fully superseded by `CommandStrip` + the
 *   unified console).
 *
 * **STOP/E-STOP moved into `DriveControls`'s pad, `EstopControl.tsx`
 * retired outright (out-of-process, 2026-09-10).** Sprint 006 mounted a
 * separate, always-reachable `EstopControl` here, directly under the
 * `h2` and pinned with `position: sticky` so it stayed visible
 * regardless of scrolling or what else was on screen. The stakeholder's
 * revised spec instead asks for STOP and E-STOP as two stop-sign-icon
 * buttons in the center of `DriveControls`'s 3x3 drive pad, between the
 * four directional buttons -- reachable because the drive pad itself is
 * always on screen in the left column, not because of a sticky
 * position. `EstopControl.tsx`/`.css`/`.test.tsx` are deleted; their
 * tests' intent (unsequenced `ESTOP` on press, reachable regardless of
 * pending sequenced activity, repeated presses harmless, disabled with
 * a hint when no session is open, Clear E-STOP appearing only while
 * `robotStatus.estopped` and sending `SET estop_clear 1` then `STATUS`)
 * now lives in `DriveControls.test.tsx`. The `stop-button`/
 * `estop-button`/`estop-clear-button` `data-testid`s are unchanged, so
 * every other test and any external tooling keyed on them keeps working
 * unmodified.
 *
 * **Transport-blindness is load-bearing, not incidental**: this page
 * and every component it mounts render off `WsProvider`'s hooks/
 * actions only — never a transport-specific link type, a hardcoded
 * transport-kind string, or the endpoint's own transport field.
 * `RobotPage.transportBlind.test.ts` enforces this with a source scan
 * over this file and its children rather than leaving it to review
 * alone, because sprint 7's "same page, no rewrite" claim for a
 * relay-connected robot depends entirely on this property holding.
 */
import type { EndpointListEntry } from "@robot-console/host/src/wsMessages.js";
import { ChartsPanel } from "../components/ChartsPanel";
import { CommandStrip } from "../components/CommandStrip";
import { DeviceConsole } from "../components/DeviceConsole";
import { DriveControls } from "../components/DriveControls";
import { FunctionsPanel } from "../components/FunctionsPanel";
import { SequencingIndicator } from "../components/SequencingIndicator";
import { StatusPanel } from "../components/StatusPanel";
import "./RobotPage.css";

export interface RobotPageProps {
  endpoint: EndpointListEntry;
}

export function RobotPage({ endpoint }: RobotPageProps) {
  return (
    <section className="robot-page" aria-label="Robot device">
      <h2>{endpoint.name ?? endpoint.endpointId}</h2>

      <div className="robot-page-columns">
        <div className="robot-page-column robot-page-column-left">
          <div className="robot-page-panel">
            <h3>Status</h3>
            <StatusPanel device={endpoint} />
          </div>

          <div className="robot-page-panel">
            <h3>Drive</h3>
            <DriveControls device={endpoint} />
          </div>

          <div className="robot-page-panel">
            <h3>Sequencing</h3>
            <SequencingIndicator endpointId={endpoint.endpointId} />
          </div>

          <div className="robot-page-panel">
            <h3>Functions</h3>
            <FunctionsPanel device={endpoint} />
          </div>

          <div className="robot-page-panel" aria-label="Charts">
            <h3>Charts</h3>
            <ChartsPanel endpointId={endpoint.endpointId} />
          </div>
        </div>

        <div className="robot-page-column robot-page-column-right">
          <DeviceConsole device={endpoint} />
          <CommandStrip device={endpoint} />
        </div>
      </div>
    </section>
  );
}
