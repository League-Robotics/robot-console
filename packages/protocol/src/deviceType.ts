/**
 * deviceType.ts — classify a parsed banner into a {@link DeviceType}.
 *
 * This is the one place "what kind of thing is this endpoint" gets
 * decided. Everything downstream (the UI's per-type page dispatch,
 * `wsMessages.ts`'s `EndpointListEntry.classification`) reads the
 * result of {@link classifyBanner} rather than re-deriving a type from
 * a raw banner itself ("classifying a banner into a device type" is its
 * own reason to change, independent of banner *parsing* or the wire
 * contract).
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
 * own design decisions): the banner *dialect* (the space form is
 * converging on the colon form, so
 * it is not a stable signal), the serial's radix, the OS port path, or
 * whether an HID/MSD volume is present. `dialect` is still carried on
 * {@link DeviceClassification} for diagnostics/logging only -- it must
 * never grow a `switch` of its own.
 *
 * ## The `ID`-verb calibration signal
 *
 * A calibration robot and a student robot emit the **identical** banner
 * (`device NEZHA2 robot <name> <serial>`) -- the banner alone can never
 * distinguish them, and no firmware change is needed to fix that: the
 * separately-issued `ID` verb already carries the distinction, and has
 * all along. Its reply's grammar is `id <product> <program> <version>
 * <name>`; `program` is `calibration-<version>` on the calibration
 * build, the build's own name (e.g. `tovez`) otherwise. {@link
 * parseIdReply} parses that reply's fields (pure, no I/O); {@link
 * refineForCalibration} is the **one place** the `calibration-` prefix
 * is matched -- see its own doc comment for why this is a second,
 * independent signal layered on after {@link classifyBanner} rather
 * than folded into it. A robot that never answers `ID` (older firmware,
 * a request that times out, or a build without the verb) simply never
 * has this refinement applied, and stays classified `"robot"` -- the
 * host module that issues the `ID` request and harvests the reply owns
 * that timing, not this file. A wire-level `classification.type` value
 * of `"calibration"` is one of the values a host/UI-side coercion
 * treats as recognized now, exactly as `"relay"`/`"robot"` always have
 * been -- an older client talking to a newer host still degrades safely
 * for any value it doesn't recognize.
 */
import type { BannerDialect, ParsedBanner } from "./banner.js";

/** Every device type this client can classify a banner into. A future
 * addition here must go through a host/UI-side coercion (never grow
 * this union out from under an older, already-shipped client without
 * one). `"calibration"` is never produced by {@link classifyBanner}
 * itself (the banner cannot distinguish a calibration robot from a
 * student one) -- only {@link refineForCalibration}, applied after a
 * matching `ID` reply, ever narrows a `"robot"` classification to
 * `"calibration"`. */
export type DeviceType = "unknown" | "relay" | "robot" | "calibration";

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
  /** The `ID` reply's raw `program` field (e.g. `"calibration-0.20260907.2"`,
   * `"tovez"`), preserved verbatim -- `null` until (and unless) an `ID`
   * reply has ever been received for this endpoint; `classifyBanner`
   * itself never sets this to anything but `null`, since a banner alone
   * carries no `ID`-verb signal. See {@link refineForCalibration}. */
  program: string | null;
  /** The `ID` reply's raw `version` field, preserved verbatim -- `null`
   * under the same condition as {@link program}. */
  version: string | null;
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
    return { type: "unknown", role: null, commonName: null, dialect: null, evidence: "none", program: null, version: null };
  }

  const commonName = banner.commonName.toLowerCase();
  if (commonName === "relay") {
    return {
      type: "relay",
      role: banner.role,
      commonName: banner.commonName,
      dialect: banner.dialect,
      evidence: "common-name",
      program: null,
      version: null,
    };
  }
  if (commonName === "robot") {
    return {
      type: "robot",
      role: banner.role,
      commonName: banner.commonName,
      dialect: banner.dialect,
      evidence: "common-name",
      program: null,
      version: null,
    };
  }

  if (RELAY_ROLES.has(banner.role)) {
    return {
      type: "relay",
      role: banner.role,
      commonName: banner.commonName,
      dialect: banner.dialect,
      evidence: "role",
      program: null,
      version: null,
    };
  }
  if (ROBOT_ROLES.has(banner.role)) {
    return {
      type: "robot",
      role: banner.role,
      commonName: banner.commonName,
      dialect: banner.dialect,
      evidence: "role",
      program: null,
      version: null,
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
    program: null,
    version: null,
  };
}

/** One robot's `ID` reply, parsed positionally from the wire's `id
 * <product> <program> <version> <name>` fields -- see the module doc
 * comment's "The `ID`-verb calibration signal" section. `product` and
 * `name` are carried for completeness (a caller may want them for
 * display) even though only `program`/`version` feed {@link
 * refineForCalibration}. */
export interface IdReply {
  readonly product: string;
  readonly program: string;
  readonly version: string;
  readonly name: string;
}

/** Parse a decoded `id` reply's fields into an {@link IdReply}. `null`
 * if fewer than the four expected positional fields are present -- this
 * module never guesses at a partial or malformed reply; a caller sees
 * `null` and simply does not refine the classification, which stays
 * whatever {@link classifyBanner} already produced. The vocabulary of
 * `product`/`program`/`name` values is not controlled by this project,
 * so no field here is validated against an allowlist -- only counted. */
export function parseIdReply(fields: readonly string[]): IdReply | null {
  const [product, program, version, name] = fields;
  if (product === undefined || program === undefined || version === undefined || name === undefined) {
    return null;
  }
  return { product, program, version, name };
}

/** Matches an `ID` reply's `program` field naming the calibration build
 * -- the **one place** this project matches on the `calibration-`
 * prefix (per the linked issue's own design caution: match the prefix,
 * not an exact version string, and keep the match in exactly one
 * place). Deliberately a prefix match, not equality: the calibration
 * build's `program` embeds its own version
 * (`calibration-0.20260907.2`), which churns on every calibration
 * release. */
const CALIBRATION_PROGRAM_PREFIX = /^calibration-/;

/**
 * Refine a `"robot"` {@link DeviceClassification} using a parsed `ID`
 * reply -- the second, independent signal layered on after {@link
 * classifyBanner}, never folded into it (the `ID` round trip is a
 * separate request a host module sends after a banner already
 * classified the endpoint as a plain robot; {@link classifyBanner}
 * itself has no access to it and stays banner-only).
 *
 * `program` matching {@link CALIBRATION_PROGRAM_PREFIX} narrows `type`
 * to `"calibration"`; anything else -- including a near-miss like
 * `"calib-test"` that merely resembles the prefix -- leaves `type`
 * alone. Only ever narrows a `"robot"` classification: called with a
 * `"relay"`/`"unknown"` classification (which should not happen, since
 * `ID` is only ever sent after a `"robot"` identify) returns it
 * unchanged rather than misclassifying a non-robot as `"calibration"`.
 * `program`/`version` are always set verbatim from the
 * reply, regardless of whether the prefix matched -- they are
 * diagnostics, preserved for display exactly like {@link
 * DeviceClassification.role} is from the banner.
 */
export function refineForCalibration(classification: DeviceClassification, idReply: IdReply): DeviceClassification {
  return {
    ...classification,
    type:
      classification.type === "robot" && CALIBRATION_PROGRAM_PREFIX.test(idReply.program)
        ? "calibration"
        : classification.type,
    program: idReply.program,
    version: idReply.version,
  };
}

