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
 *   `DriveControls` (unchanged, `WHEELS_V`-only per
 *   `vendor/radio-robot-lib/docs/design/motion-api.md`),
 *   `SequencingIndicator` (unchanged, read-only view of `Session`'s
 *   reliability state), `FunctionsPanel` (added out-of-process,
 *   2026-09-09 -- the robot's `FUNCS`-discovered, `RUN`-able function
 *   list, mounted below Sequencing), and a stubbed, empty charts
 *   placeholder -- charts themselves are future work (`sprint.md`'s
 *   Scope), this column only reserves and labels their eventual spot.
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
 * **`EstopControl` is mounted here unconditionally, directly under the
 * page's `h2`, and -- critically -- as a sibling of the two-column grid
 * below, not nested inside either column.** This is structural, not
 * cosmetic: `EstopControl.css` pins it via
 * `position: sticky; top: 0`, which depends on the *document* being its
 * nearest scrolling ancestor (per that file's own doc comment). The
 * right column now scrolls independently to hold `DeviceConsole` to a
 * bounded height (see `RobotPage.css`) -- if `EstopControl` were nested
 * inside that column, its nearest scrolling ancestor would silently
 * become the column instead of the document, breaking the sticky
 * pinning sprint 006 built this control to have. Keeping it a sibling
 * of `.robot-page-columns` (never a descendant of either column's own
 * scroll container) is what keeps `EstopControl.css` needing no
 * *layout* change to stay pinned, and is asserted structurally, not
 * just visually, by `RobotPage.test.tsx`.
 *
 * **Sized and positioned per stakeholder feedback (2026-09-08):** a
 * full-width e-stop bar read as disproportionate once the page was in
 * real use ("it's ridiculous"). `EstopControl.css` now sizes the
 * control to its own content and left-aligns it (`align-self:
 * flex-start`), so it renders as a small control sitting just above
 * `DriveControls` in the left column rather than spanning the page.
 * It stays a DOM sibling of `.robot-page-columns` -- moving it into the
 * left column's own markup was considered and rejected, since that
 * column is a bounded, internally-scrolling container (see
 * `RobotPage.css`) and would silently break the sticky pinning above.
 * Smaller and visually adjacent to the drive controls, still
 * unconditionally reachable with no scrolling: that combination is the
 * point of keeping the DOM position and the CSS sizing as two
 * independent decisions.
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
import { CommandStrip } from "../components/CommandStrip";
import { DeviceConsole } from "../components/DeviceConsole";
import { DriveControls } from "../components/DriveControls";
import { EstopControl } from "../components/EstopControl";
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

      <EstopControl device={endpoint} />

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

          <div className="robot-page-panel robot-page-charts-placeholder" aria-label="Charts">
            <h3>Charts</h3>
            <p className="robot-page-charts-placeholder-text">
              Telemetry charts are not built yet -- this space is reserved for a future sprint.
            </p>
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
