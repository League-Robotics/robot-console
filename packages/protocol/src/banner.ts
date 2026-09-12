/**
 * banner.ts — parse a device's boot/announcement banner line.
 *
 * Both dialects below are live on the fleet **simultaneously** and must
 * both parse. The spec (docs/design/specification.md §3.3) mandates the
 * colon form for every device class, and there is an open upstream issue
 * (vendor/radio-robot-lib) to converge the robot firmware onto it, but
 * until that lands a parser that only accepts the colon form cannot
 * identify a robot at all. Do not narrow this to one dialect.
 *
 * Colon form (relays, and the spec-mandated form generally):
 *   DEVICE:<role>:<common_name>:<device_name>:<serial>
 *   DEVICE:RADIOBRIDGE:relay:getez:1779042496
 *
 * Space form (what robot firmware emits today; lowercase sentinel):
 *   device <role> <common_name> <device_name> <serial>
 *   device NEZHA2 robot vevov 1198504156
 *
 * Both dialects carry the same five logical fields in the same order —
 * only the sentinel case and the delimiter differ.
 *
 * Serial-encoding trap: `serial` is always the same physical value (the
 * nRF `FICR.DEVICEID[1]`), but different firmware families print it in
 * different bases:
 *   - `RADIOBRIDGE` (current C++ relay firmware)   -> decimal
 *   - `RADIORELAY`  (legacy MakeCode relay firmware) -> hexadecimal
 *   - `NEZHA2`      (robot firmware, space form)    -> decimal
 * The radix is looked up **by role**, explicitly, below — never inferred
 * from the digit string itself (a hex value can look like a valid
 * decimal number, e.g. "123456"). An unrecognized role token falls back
 * to decimal, since that is the direction the spec is converging on; new
 * firmware families are expected to follow the current convention unless
 * they say otherwise.
 *
 * `device_name` (the five-letter friendly name) — not `serial` — is the
 * more stable join key across firmware/dialects, since it is the same
 * string regardless of which base a given firmware happens to print the
 * serial in.
 *
 * `name` is derivable from `serial` (spec §2.2: the name *is* a base-5
 * encoding of `FICR.DEVICEID[1]`, the same register `serial` decodes),
 * so a well-formed banner's two fields must always agree —
 * {@link bannerNameMatchesSerial} is the free, pure check for that.
 */

import { deviceIdToName } from "./naming.js";

/** Serial radix, keyed by role token. See the module doc for why this is
 * an explicit per-role lookup rather than an inferred/assumed base. */
const SERIAL_RADIX_BY_ROLE: Readonly<Record<string, 10 | 16>> = {
  RADIOBRIDGE: 10,
  RADIORELAY: 16,
  NEZHA2: 10,
};

/** Radix used for any role token not present in {@link SERIAL_RADIX_BY_ROLE}. */
const DEFAULT_SERIAL_RADIX: 10 | 16 = 10;

/** Which banner grammar matched. */
export type BannerDialect = "colon" | "space";

/**
 * A banner line parsed into its shared logical shape, regardless of
 * which dialect matched. Downstream code (UsbSerialLink, server.ts)
 * should branch on this shape, never on which grammar/regex matched.
 */
export interface ParsedBanner {
  /**
   * Role / device-type token, e.g. "RADIOBRIDGE", "RADIORELAY", "NEZHA2".
   * Unrecognized roles are preserved verbatim rather than rejected — new
   * firmware families are expected to show up here over time.
   */
  role: string;
  /** Human-oriented device class from the banner, e.g. "relay", "robot". */
  commonName: string;
  /**
   * Five-letter device name. The stable join key across dialects and
   * firmware families, since it does not depend on serial radix.
   */
  name: string;
  /** Serial number (nRF `FICR.DEVICEID[1]`), decoded per-role radix. */
  serial: number;
  /** Which banner grammar matched. */
  dialect: BannerDialect;
  /** The banner line exactly as it arrived (no trailing newline), so a
   * console can show the `HELLO` reply verbatim. */
  raw: string;
}

/** Loose serial token: hex digits, since decimal digits are a subset. The
 * radix used to interpret them is chosen by role, not by this match. */
const SERIAL_TOKEN = /^[0-9A-Fa-f]+$/;

const COLON_FORM =
  /^DEVICE:([^:\s]+):([^:\s]+):([^:\s]+):([^:\s]+)$/;

const SPACE_FORM =
  /^device (\S+) (\S+) (\S+) (\S+)$/;

function radixForRole(role: string): 10 | 16 {
  return SERIAL_RADIX_BY_ROLE[role] ?? DEFAULT_SERIAL_RADIX;
}

function buildBanner(
  role: string,
  commonName: string,
  name: string,
  serialToken: string,
  dialect: BannerDialect,
  raw: string,
): ParsedBanner | null {
  if (!SERIAL_TOKEN.test(serialToken)) {
    return null;
  }
  const serial = Number.parseInt(serialToken, radixForRole(role));
  if (!Number.isFinite(serial)) {
    return null;
  }
  return { role, commonName, name, serial, dialect, raw };
}

/**
 * Parse a single banner line, trying both live dialects.
 *
 * Returns `null` — a clear "not a banner" result — for any line matching
 * neither grammar, rather than attempting a partial/garbage parse.
 */
export function parseBanner(line: string): ParsedBanner | null {
  const colonMatch = COLON_FORM.exec(line);
  if (colonMatch) {
    // Non-null assertions are safe here: COLON_FORM has exactly four
    // required (non-optional) capture groups, so a successful match
    // always populates indices 1-4.
    return buildBanner(
      colonMatch[1]!,
      colonMatch[2]!,
      colonMatch[3]!,
      colonMatch[4]!,
      "colon",
      line,
    );
  }

  const spaceMatch = SPACE_FORM.exec(line);
  if (spaceMatch) {
    // Same reasoning as above: SPACE_FORM has four required groups.
    return buildBanner(
      spaceMatch[1]!,
      spaceMatch[2]!,
      spaceMatch[3]!,
      spaceMatch[4]!,
      "space",
      line,
    );
  }

  return null;
}

/**
 * Does `banner.name` match `banner.serial`, per the name's own
 * definition (spec §2.2: `name = deviceIdToName(FICR.DEVICEID[1])`, and
 * `serial` is that same register, already decoded to the correct radix
 * by {@link parseBanner})? A mismatch is a free, pure signal that
 * something is wrong with a banner's own two fields — most commonly a
 * serial printed/decoded in the wrong radix (a hex value silently reads
 * as valid decimal digits) — without needing any second source of
 * truth to compare against.
 */
export function bannerNameMatchesSerial(banner: ParsedBanner): boolean {
  return deviceIdToName(banner.serial) === banner.name;
}
