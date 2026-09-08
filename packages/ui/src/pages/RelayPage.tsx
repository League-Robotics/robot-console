/**
 * RelayPage.tsx — `/d/:endpointId` for a `relay`-classified endpoint
 * (SUC-006).
 *
 * A minimal shell this sprint, per `sprint.md`'s Scope ("the relay
 * page's robot dropdown behavior" is explicitly out of scope until
 * sprint 5's roster exists) and Success Criteria (no attached board
 * classifies as `relay` today -- see
 * `flash-succeeds-but-board-never-announces.md` -- so this page is
 * only exercisable against a fixture `EndpointListEntry` this sprint).
 * Shows a header and a robot-name dropdown that is present but
 * intentionally empty: a real, routable destination today (not hidden,
 * not an error) rather than a fake control that appears to do
 * something it can't -- the dropdown is disabled with an explicit
 * "not set up yet" option instead of silently accepting a selection
 * that goes nowhere. Sprint 7 populates connected/not-connected
 * behavior for the relay itself; sprint 5 populates the dropdown from
 * the remembered-robot roster.
 *
 * Embeds `DeviceConsole` so the raw line console (SUC-007) is reachable
 * here exactly as it is on every other per-device page.
 */
import type { EndpointListEntry } from "@robot-console/host/src/wsMessages.js";
import { DeviceConsole } from "../components/DeviceConsole";
import "./RelayPage.css";

export interface RelayPageProps {
  endpoint: EndpointListEntry;
}

export function RelayPage({ endpoint }: RelayPageProps) {
  return (
    <section className="relay-page" aria-label="Relay device">
      <h2>{endpoint.name ?? endpoint.endpointId}</h2>
      <p className="relay-page-hint">
        This is a relay. Once robots are set up for this classroom (a later sprint), you'll pick
        one here to connect through it.
      </p>
      <label className="relay-robot-picker">
        <span>Robot</span>
        <select data-testid="relay-robot-select" disabled defaultValue="">
          <option value="">No robots set up yet</option>
        </select>
      </label>
      <DeviceConsole device={endpoint} />
    </section>
  );
}
