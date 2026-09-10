/**
 * wifiRobotGate.ts — the sprint's classroom-privacy gate (sprint 010
 * ticket 002).
 *
 * `discovery/mdnsDiscovery.ts` browses `_robotlink._tcp`/`_robotlink._udp`
 * with no policy at all: it hands back every robot currently advertising
 * on the LAN, unfiltered. Per `sprint.md`'s Problem/Solution sections, a
 * classroom is full of robots advertising over WiFi, radio, and mbdeploy
 * simultaneously, and only a robot this machine has previously identified
 * over USB (sprint 5's `store/knownRobots.ts` roster) may ever be shown
 * or acted on as a WiFi candidate. This module is the one place that
 * decision is made.
 *
 * `gateWifiRobots` is a pure function — no I/O, no dependency beyond its
 * two parameter types — so the negative case (an unrecognized robot is
 * excluded) is directly, trivially unit-testable with no registry or
 * endpoint machinery involved at all. `deviceRegistry.ts` (ticket 003)
 * is the only caller, and it must never read `mdnsDiscovery.ts`'s raw
 * `wifiRobots` list for anything client-visible — only this function's
 * output. That discipline is what makes "an unrecognized robot reaches
 * the wire" a compile-time-checkable absence rather than a UI-level
 * promise — see `sprint.md`'s Design Rationale, "No wire-visible ungated
 * WiFi list."
 */

import type { WifiRobotService } from "../discovery/mdnsDiscovery.js";
import type { KnownRobotRecord } from "../store/knownRobots.js";

/**
 * Filter `discovered` down to only the entries whose `name` matches a
 * record in `roster` — sprint 5's `KnownRobotsStore.list()` output.
 * Order-preserving over `discovered`; a name absent from `roster` is
 * dropped, never merely flagged. Handles an empty roster or an empty
 * discovery list the same way: `[]`, no error.
 */
export function gateWifiRobots(
  discovered: readonly WifiRobotService[],
  roster: readonly KnownRobotRecord[],
): WifiRobotService[] {
  const rosterNames = new Set(roster.map((record) => record.name));
  return discovered.filter((service) => rosterNames.has(service.name));
}
