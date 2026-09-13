/**
 * truthfulness.ts — the three card-truthfulness assertions ticket
 * 018-002 requires, read directly from a host `Snapshot` (no UI
 * needed): no link is `stale`/absent while its underlying service is
 * currently advertised; no device has `kind: "robot"` while its
 * role/banner history says relay; exactly one `devices` row per device
 * name (no duplicates).
 *
 * Each assertion is a pure function over a narrow, structural slice of
 * `@robot-console/host`'s own `SnapshotDevice`/`SnapshotLink` shape
 * (never the full 30-field type) so a unit test fixture only needs the
 * handful of fields each assertion actually reads -- no live host, no
 * real snapshot, ever required to exercise this module. `index.ts`
 * calls these against the real, live snapshot and `advertisedNames`
 * derived from Layer 1's own mDNS discovery (see that module's own
 * doc comment for why that is the right "currently advertised" set).
 *
 * Every assertion reports **one result per device**, never a single
 * whole-run pass/fail -- the ticket's own acceptance criterion.
 */

/** The handful of `SnapshotLink` fields these assertions read. */
export interface AssertableLink {
  id: string;
  transport: string;
  state: string;
  reason: string | null;
}

/** The handful of `SnapshotDevice` fields these assertions read. */
export interface AssertableDevice {
  name: string;
  kind: string;
  role: string | null;
  links: readonly AssertableLink[];
}

export type AssertionName = "no-stale-while-advertised" | "no-relay-as-robot" | "one-row-per-name";

export interface AssertionResult {
  assertion: AssertionName;
  device: string;
  pass: boolean;
  reason: string;
}

/** A relay's own banner `role` token, per `wire_handler.cpp`'s banner
 * dialects (`DEVICE:RADIOBRIDGE:...` and its `RADIORELAY` sibling seen
 * in the wild) -- mirrors `layer1/usbProbe.ts`'s own `isRelayBanner`
 * pattern in miniature (duplicated, not imported -- same
 * host-internals boundary this whole harness keeps throughout). */
const RELAY_ROLE_PATTERN = /^RADIO(BRIDGE|RELAY)$/i;

/** A link's own `state`/`reason` reads as "stale" for this assertion's
 * purpose either because the store literally marked it `state:
 * "stale"`, or because its `reason` text says so in prose (a link that
 * is technically in some other state but whose most recent notice was
 * "Not seen since ..." is exactly as untruthful to a viewer as one the
 * store marked `stale` outright). */
function isStaleLike(link: AssertableLink): boolean {
  return link.state === "stale" || /not seen since/i.test(link.reason ?? "");
}

/**
 * "No link is `stale`/absent while its underlying service is currently
 * advertised." Only evaluated for devices in `advertisedNames` (the set
 * Layer 1's own mDNS discovery reported as currently up) -- a device
 * with no service advertised at all has nothing to be untruthful
 * about, so it is simply not asserted on here, not silently marked
 * "pass" for an unrelated reason. Reports one result per advertised
 * device.
 */
export function assertNoStaleWhileAdvertised(
  devices: readonly AssertableDevice[],
  advertisedNames: ReadonlySet<string>,
): AssertionResult[] {
  const results: AssertionResult[] = [];
  for (const device of devices) {
    if (!advertisedNames.has(device.name)) {
      continue;
    }
    const staleLinks = device.links.filter(isStaleLike);
    results.push(
      staleLinks.length === 0
        ? {
            assertion: "no-stale-while-advertised",
            device: device.name,
            pass: true,
            reason: `no stale/"Not seen since" link found while ${device.name}'s mDNS service is currently advertised`,
          }
        : {
            assertion: "no-stale-while-advertised",
            device: device.name,
            pass: false,
            reason: `link(s) ${staleLinks.map((l) => `${l.id} (${l.state}${l.reason ? `, "${l.reason}"` : ""})`).join(", ")} look stale while ${device.name}'s mDNS service is currently advertised`,
          },
    );
  }
  return results;
}

/**
 * "No device has `kind: 'robot'` while its role/banner history says
 * relay." Reports one result per device (not only failures), so a
 * clean run is visible in the report, not just silent.
 */
export function assertNoRelayAsRobot(devices: readonly AssertableDevice[]): AssertionResult[] {
  return devices.map((device) => {
    const roleLooksLikeRelay = device.role !== null && RELAY_ROLE_PATTERN.test(device.role);
    const misclassified = device.kind === "robot" && roleLooksLikeRelay;
    return {
      assertion: "no-relay-as-robot",
      device: device.name,
      pass: !misclassified,
      reason: misclassified
        ? `device "${device.name}" is recorded kind:"robot" but its own role ("${device.role}") is a relay banner role`
        : `kind ("${device.kind}") is consistent with role (${device.role === null ? "none" : `"${device.role}"`})`,
    };
  });
}

/**
 * "Exactly one `devices` row per device name (no duplicates)." Reports
 * one result per distinct name, not per row -- two rows sharing a name
 * is one finding about that name, not two.
 */
export function assertOneRowPerName(devices: readonly AssertableDevice[]): AssertionResult[] {
  const counts = new Map<string, number>();
  for (const device of devices) {
    counts.set(device.name, (counts.get(device.name) ?? 0) + 1);
  }
  const results: AssertionResult[] = [];
  for (const [name, count] of counts) {
    results.push({
      assertion: "one-row-per-name",
      device: name,
      pass: count === 1,
      reason: count === 1 ? `exactly one devices row for "${name}"` : `${count} devices rows share the name "${name}" -- expected exactly one`,
    });
  }
  return results;
}

/** Run all three assertions and concatenate their per-device results,
 * in the fixed order the ticket lists them. */
export function runTruthfulnessAssertions(
  devices: readonly AssertableDevice[],
  advertisedNames: ReadonlySet<string>,
): AssertionResult[] {
  return [
    ...assertNoStaleWhileAdvertised(devices, advertisedNames),
    ...assertNoRelayAsRobot(devices),
    ...assertOneRowPerName(devices),
  ];
}
