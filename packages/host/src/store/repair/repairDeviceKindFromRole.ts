/**
 * repairDeviceKindFromRole.ts — the one-time, idempotent repair for
 * ticket 018-010's own bench-evidenced data defect: a device row whose
 * announced `role` is a relay-only firmware token (`RADIOBRIDGE`/
 * `RADIORELAY` — `@robot-console/protocol`'s `deviceType.ts`'s own
 * `classifyBanner`, the single authority for what these tokens mean)
 * while its own `kind` column still says `"robot"`.
 *
 * ## Bench evidence
 *
 * The stakeholder's real `console.sqlite` carries `vevav` — `kind:
 * "robot"`, `role: "RADIOBRIDGE"` — next to `vitut`, a hardware-
 * identical RADIOBRIDGE relay correctly stored as `kind: "relay"`,
 * `role: "RADIOBRIDGE"`. `vevav`'s front-page card, as a result, used
 * every ROBOT-shaped rule this sprint's own shared text module applies:
 * "the robot didn't answer when we said hello — check the USB cable or
 * that it's powered on" for its own no-answer failure (ticket 018-010's
 * item 5), when the correct text — once `kind` reads `"relay"` — is
 * "the relay didn't answer … it may be parked in the data plane; unplug
 * and replug it to reset" (`deviceDisplay.ts`'s own `RELAY_NO_ANSWER_
 * ADVICE`).
 *
 * `connect/connector.ts`'s own successful-identify path always writes
 * `kind`/`role` together, atomically, from the exact same
 * `classifyBanner` result (`kind: classification.type === "relay" ?
 * "relay" : "robot"`, `role: banner.role`) — so this specific
 * inconsistency can never arise from a *current* write; it is
 * necessarily leftover from either an older code path (predating that
 * atomic write) or a hand-edited/imported row. Regardless of exact
 * origin, the fix is the same shape as `mergeDuplicateDeviceRows.ts`
 * (018-006) and `repairRadioLinkDeviceAssociation.ts` (018-010's other
 * repair): find every row this invariant disagrees with, once, at
 * `openStore`, and correct it.
 *
 * ## The rule
 *
 * A device whose `role` is one of {@link RELAY_ONLY_ROLES} — role
 * tokens `classifyBanner` only ever maps to `type: "relay"` — but whose
 * own `kind` is not already `"relay"` has its `kind` promoted to
 * `"relay"`. Never the reverse (a `kind: "relay"` row is never demoted,
 * whatever its `role` — `role` can legitimately be `null`, e.g. a relay
 * discovered only via mDNS with no banner identify yet, and this repair
 * has no business guessing at that case). Never a role this repair
 * cannot classify with full confidence: `classifyBanner`'s own
 * precedence checks a banner's `commonName` *before* falling back to
 * `role` (a device could in principle announce a relay-shaped role
 * token with a `commonName` that overrides it) — `commonName` is not a
 * persisted `devices` column, so this repair only acts on the two role
 * tokens that are, in this codebase's actual fielded firmware, never
 * used by anything but relay firmware; it does not attempt to
 * reconstruct `classifyBanner`'s full precedence from a `devices` row
 * alone.
 */
import type { Store } from "../index.js";

/** Role tokens `@robot-console/protocol`'s `deviceType.ts`'s own
 * `classifyBanner` maps to `type: "relay"` via its role-based fallback
 * (`RELAY_ROLES`, not exported from that module — duplicated here by
 * name rather than imported, matching this file's own sibling repair's
 * duplication of `radioChildLinkName` for the same "avoid a needless
 * cross-package/runtime-cycle dependency for two constant strings"
 * reasoning). Kept in sync by name with that module's own set. */
const RELAY_ONLY_ROLES = new Set(["RADIORELAY", "RADIOBRIDGE"]);

interface DeviceRowForRepair {
  id: number;
  kind: string;
  role: string | null;
}

function toDeviceRowForRepair(row: Record<string, unknown>): DeviceRowForRepair {
  const role = row.role;
  return { id: Number(row.id), kind: String(row.kind), role: role === null || role === undefined ? null : String(role) };
}

/**
 * Runs the one-time device-kind-from-role repair against `store` — see
 * this module's own doc comment for the exact rule. Idempotent: once
 * every relay-role row already reads `kind: "relay"`, a later call finds
 * nothing left to change.
 */
export function repairDeviceKindFromRole(store: Store): void {
  const devices = store.snapshotRows().devices.map(toDeviceRowForRepair);
  for (const device of devices) {
    if (device.kind === "relay" || device.role === null) {
      continue;
    }
    if (RELAY_ONLY_ROLES.has(device.role)) {
      store.setDeviceKind(device.id, "relay");
    }
  }
}
