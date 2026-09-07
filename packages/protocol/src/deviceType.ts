/**
 * deviceType.ts — classify a parsed banner into a {@link DeviceType}.
 *
 * This is the one place "what kind of thing is this endpoint" gets
 * decided. Everything downstream (the UI's per-type page dispatch,
 * `wsMessages.ts`'s `EndpointListEntry.classification`) reads the
 * result of {@link classifyBanner} rather than re-deriving a type from
 * a raw banner itself -- see `sprint.md`'s Step 2 responsibility list
 * ("classifying a banner into a device type" is its own reason to
 * change, independent of banner *parsing* or the wire contract).
 *
 * ## Precedence, and why `commonName` outranks `role`
 *
 * 1. No banner at all -> `"unknown"`, `evidence: "none"`.
 * 2. `commonName` (case-insensitively) is `"relay"` or `"robot"` -> that
 *    type, `evidence: "common-name"`.
 * 3. Otherwise, `role` against a small allowlist (`RADIORELAY`/
 *    `RADIOBRIDGE` -> relay, `NEZHA2` -> robot) -> that type,
 *    `evidence: "role"`.
 * 4. Otherwise -> `"unknown"`, `evidence: "unrecognized"`, with `role`
 *    (and `commonName`/`dialect`) preserved verbatim from the banner so
 *    the UI can say something like "Unknown device (announced
 *    `ROBOTV7`)" instead of just "unknown".
 *
 * `commonName` is checked first because `role` is the firmware
 * *family* token and already churns across firmware revisions
 * (`RADIOBRIDGE` superseded `RADIORELAY` -- see `banner.ts`'s own doc
 * comment), while `commonName` is the human-oriented device *class* and
 * changes far less often. A misclassification here lands on
 * `"unknown"`, whose page offers a recovery flash -- a benign failure,
 * not a wrong-page problem.
 *
 * Deliberately **not** used as discriminators (per the roadmap issue's
 * design decisions, carried into `sprint.md`'s Design Rationale): the
 * banner *dialect* (the space form is converging on the colon form, so
 * it is not a stable signal), the serial's radix, the OS port path, or
 * whether an HID/MSD volume is present. `dialect` is still carried on
 * {@link DeviceClassification} for diagnostics/logging only -- it must
 * never grow a `switch` of its own.
 *
 * ## Why a fourth type is purely additive
 *
 * A calibration-robot type is blocked upstream (`wire_handler.cpp`
 * hardcodes `NEZHA2` for every robot build today) and is deliberately
 * not modeled here. {@link normalizeDeviceType} is the mechanism that
 * keeps a future fourth wire value from breaking an older client: any
 * string this module doesn't recognize coerces to `"unknown"` rather
 * than being passed through or rejected, so a client built against
 * today's two-type union degrades gracefully against a newer host.
 */
import type { BannerDialect, ParsedBanner } from "./banner.js";

/** Every device type this client can classify a banner into. See the
 * module doc comment for why a future addition here must go through
 * {@link normalizeDeviceType} rather than growing this union out from
 * under an older, already-shipped client. */
export type DeviceType = "unknown" | "relay" | "robot";

/** Which signal (if any) produced a {@link DeviceClassification}'s
 * `type`, for diagnostics -- never branched on by the UI. `"none"`: no
 * banner was available at all. `"common-name"`: the banner's
 * `commonName` matched directly. `"role"`: no `commonName` match, but
 * the banner's `role` matched the allowlist. `"unrecognized"`: a
 * banner was present but matched neither -- `type` is `"unknown"` and
 * `role`/`commonName`/`dialect` are preserved verbatim for display. */
export type ClassificationEvidence = "none" | "common-name" | "role" | "unrecognized";

/** The result of classifying one banner (or the absence of one). Every
 * field except `type`/`evidence` mirrors the source `ParsedBanner`
 * verbatim (or `null` when there was none) -- this module never
 * rewrites or normalizes a role/commonName/dialect value, only reads
 * it to decide `type`. */
export interface DeviceClassification {
  /** The classified device type. Always `"unknown"` when {@link evidence}
   * is `"none"` or `"unrecognized"`. */
  type: DeviceType;
  /** The banner's raw role token (e.g. `"RADIOBRIDGE"`, `"ROBOTV7"`),
   * preserved verbatim -- `null` only when there was no banner at all.
   * Kept even when `type` is `"unknown"` so the UI can show *what* the
   * device announced, not just that it wasn't recognized. */
  role: string | null;
  /** The banner's raw `commonName` (e.g. `"relay"`, `"robot"`),
   * preserved verbatim -- `null` only when there was no banner at all. */
  commonName: string | null;
  /** Which banner grammar matched -- diagnostics only, per the module
   * doc comment; `null` only when there was no banner at all. */
  dialect: BannerDialect | null;
  /** Which signal produced `type` -- see this type's own doc comment. */
  evidence: ClassificationEvidence;
}

/** Role tokens that classify as `"relay"` even though their
 * `commonName` didn't match directly (checked only after the
 * `commonName` check above misses -- see the module doc comment for
 * why `commonName` outranks this). */
const RELAY_ROLES = new Set(["RADIORELAY", "RADIOBRIDGE"]);

/** Role tokens that classify as `"robot"` -- see {@link RELAY_ROLES}'s
 * doc comment. */
const ROBOT_ROLES = new Set(["NEZHA2"]);

/**
 * Classify a parsed banner (or its absence) into a {@link
 * DeviceClassification}, per the module doc comment's precedence rule.
 */
export function classifyBanner(banner: ParsedBanner | null): DeviceClassification {
  if (!banner) {
    return { type: "unknown", role: null, commonName: null, dialect: null, evidence: "none" };
  }

  const commonName = banner.commonName.toLowerCase();
  if (commonName === "relay") {
    return {
      type: "relay",
      role: banner.role,
      commonName: banner.commonName,
      dialect: banner.dialect,
      evidence: "common-name",
    };
  }
  if (commonName === "robot") {
    return {
      type: "robot",
      role: banner.role,
      commonName: banner.commonName,
      dialect: banner.dialect,
      evidence: "common-name",
    };
  }

  if (RELAY_ROLES.has(banner.role)) {
    return {
      type: "relay",
      role: banner.role,
      commonName: banner.commonName,
      dialect: banner.dialect,
      evidence: "role",
    };
  }
  if (ROBOT_ROLES.has(banner.role)) {
    return {
      type: "robot",
      role: banner.role,
      commonName: banner.commonName,
      dialect: banner.dialect,
      evidence: "role",
    };
  }

  // Neither commonName nor role matched -- unknown, but never silently:
  // role/commonName/dialect are preserved verbatim so the UI can show
  // what the device actually announced.
  return {
    type: "unknown",
    role: banner.role,
    commonName: banner.commonName,
    dialect: banner.dialect,
    evidence: "unrecognized",
  };
}

/**
 * Coerce an arbitrary string (e.g. a `classification.type` value read
 * off the wire) to a {@link DeviceType}, treating anything this client
 * doesn't recognize as `"unknown"`. This is the mechanism that makes a
 * future fourth wire-level type purely additive: an older client
 * talking to a newer host degrades a value it has never heard of to
 * `"unknown"` instead of crashing or mis-rendering.
 */
export function normalizeDeviceType(value: string): DeviceType {
  return value === "relay" || value === "robot" ? value : "unknown";
}
