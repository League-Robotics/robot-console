/**
 * RobotPage.tsx — `/d/:endpointId` for a `robot`-classified endpoint
 * (SUC-001, SUC-003, SUC-004, SUC-006).
 *
 * Sprint 4 shipped a placeholder shell here ("drive controls and live
 * telemetry aren't built yet"). This ticket (006/005) replaces it with
 * the real control surface: `DriveControls` (`WHEELS_V`-only, per
 * `vendor/radio-robot-lib/docs/design/motion-api.md` — see that
 * component's own doc comment for why), `StatusPanel` (unsequenced
 * `STATUS`), `GetSetPanel` (raw `GET`/`SET`, no named presets — no
 * config field table exists to build one from), and
 * `SequencingIndicator` (read-only view of `Session`'s reliability
 * state, unit-tested since sprint 1 but never before wired to a UI).
 * `DeviceConsole` stays embedded exactly as sprint 4 left it — this
 * ticket adds structured controls above it, it does not replace the
 * raw line console.
 *
 * `EstopControl` (ticket 006) is mounted here unconditionally, directly
 * under the header and above every other panel — not nested inside
 * `DriveControls` or any panel that could hide it. It renders
 * regardless of which panel below it is open or mid-interaction, and
 * its own CSS keeps it pinned to the top of the viewport as the page
 * scrolls, so it stays visible even once `DeviceConsole`'s log has
 * grown past a screenful. See `EstopControl.tsx`'s own doc comment for
 * why sending it is never gated on `sequencing`/pending state, and why
 * "a real robot stops" is a hardware-deferred claim its tests do not
 * make.
 *
 * **Transport-blindness is load-bearing, not incidental**: this page
 * and every component it mounts render off `WsProvider`'s hooks/
 * actions only — never a transport-specific link type, a hardcoded
 * transport-kind string, or the endpoint's own transport field.
 * `RobotPage.transportBlind.test.ts` enforces this with a source scan
 * over this file and its ticket-005 children rather than leaving it to
 * review alone, because sprint 7's "same page, no rewrite" claim for a
 * relay-connected robot depends entirely on this property holding.
 */
import type { EndpointListEntry } from "@robot-console/host/src/wsMessages.js";
import { DeviceConsole } from "../components/DeviceConsole";
import { DriveControls } from "../components/DriveControls";
import { EstopControl } from "../components/EstopControl";
import { GetSetPanel } from "../components/GetSetPanel";
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

      <SequencingIndicator endpointId={endpoint.endpointId} />

      <div className="robot-page-panel">
        <h3>Drive</h3>
        <DriveControls device={endpoint} />
      </div>

      <div className="robot-page-panel">
        <h3>Status</h3>
        <StatusPanel device={endpoint} />
      </div>

      <div className="robot-page-panel">
        <h3>Get / Set</h3>
        <GetSetPanel device={endpoint} />
      </div>

      <div className="robot-page-panel">
        <DeviceConsole device={endpoint} />
      </div>
    </section>
  );
}
