/**
 * RobotPage.tsx — `/d/:endpointId` for a `robot`-classified endpoint
 * (SUC-006).
 *
 * A minimal shell this sprint: drive controls and live telemetry are
 * sprints 6 and 8's work, per `sprint.md`'s Scope. Adding placeholder
 * buttons or gauges that don't do anything would be a false affordance
 * (this ticket's own instruction: state what's coming, don't fake it),
 * so this page just says so and otherwise embeds `DeviceConsole` --
 * the raw line console (SUC-007) is reachable here exactly as it is on
 * every other per-device page, and is the only way to talk to a robot
 * from this page until sprint 6 lands drive controls.
 *
 * No attached board classifies as `robot` today (see
 * `flash-succeeds-but-board-never-announces.md`), so this page is only
 * exercisable against a fixture `EndpointListEntry` this sprint.
 */
import type { EndpointListEntry } from "@robot-console/host/src/wsMessages.js";
import { DeviceConsole } from "../components/DeviceConsole";
import "./RobotPage.css";

export interface RobotPageProps {
  endpoint: EndpointListEntry;
}

export function RobotPage({ endpoint }: RobotPageProps) {
  return (
    <section className="robot-page" aria-label="Robot device">
      <h2>{endpoint.name ?? endpoint.endpointId}</h2>
      <p className="robot-page-hint">
        Drive controls and live telemetry aren't built yet — they're coming in a later sprint.
        For now, use the console below to talk to this robot directly.
      </p>
      <DeviceConsole device={endpoint} />
    </section>
  );
}
