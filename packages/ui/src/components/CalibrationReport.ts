/**
 * CalibrationReport.ts — a shared, pure parser for the `CALX:`/`CALA:`
 * prefixed report lines `nezha-robot-template`'s `calx`/`cala` routines
 * emit via `emitLine()` (ticket 003, SUC-003/SUC-004; see `sprint.md`'s
 * Design Rationale, "one shared `CalibrationReport.ts` parser, not two
 * independent per-wizard parsers").
 *
 * Both routines are fully autonomous and self-reporting (confirmed
 * reading `test/calibratex.ts`/`test/calibratea.ts` in the template
 * repo): they stream plain, unprefixed-by-any-wire-verb text lines --
 * not `SET`/`GET` traffic, no `#id` -- that `deviceRegistry.ts`'s
 * `handleInboundLine` already echoes into the endpoint's ordinary rx
 * log verbatim ("every line is still echoed to `onLine`"), the same
 * log `useEndpointLog` exposes and `CommandStrip` already reads for its
 * `GET`-reply harvesting.
 *
 * Both routines' report lines share one shape: `<PREFIX>:<event>`,
 * where `<event>` is either `apply <snippet>` (the terminal, literal
 * MakeCode line to paste -- e.g. `CALX:apply
 * diffDrive.setWheelCalibration(0.7912)`), `fail <reason>` (the routine
 * gave up -- e.g. `CALX:fail no start line within 60cm`), or anything
 * else, treated as an opaque progress event carrying its own raw
 * remainder text (`begin ...`, `start line found`,
 * `measured=...`, `calib=...`, `diameter=...`, and `cala`'s own
 * CW/CCW/re-verify narration). This module deliberately does not parse
 * `calx`'s or `cala`'s measurement numbers out of a progress event's
 * text -- see `sprint.md`'s Design Rationale for why over-generalizing
 * this parser to extract fields nothing yet needs structured would be
 * speculative generality; each wizard renders a progress event's raw
 * text as-is.
 *
 * **The snippet is never computed here.** `parseCalibrationLine`
 * extracts an `apply` line's remainder verbatim (after stripping only
 * the `apply ` marker) -- it is always the firmware's own text, never
 * reconstructed from `calib=`/`diameter=` progress events.
 *
 * A line that does not start with `<PREFIX>:` at all (any interleaved
 * noise -- an unrelated debug line, an `ack`/`err` reply to the `RUN`
 * command itself, blank text) returns `undefined`, "not a calibration
 * line" -- callers tolerate this silently, exactly like
 * `CommandStrip`'s `GET_REPLY_PATTERN` harvesting tolerates an
 * unrecognized reply shape.
 */

/** Which routine's report-line vocabulary a call site is parsing --
 * `"CALX"` for the distance wizard (this ticket), `"CALA"` for the
 * rotation wizard (ticket 004). Not `calx`-specific: this module
 * accepts the prefix as a parameter. */
export type CalibrationPrefix = "CALX" | "CALA";

/**
 * One parsed `<PREFIX>:`-line event:
 *  - `"apply"` -- the terminal line; `snippet` is the firmware's own
 *    text verbatim, with only the leading `apply ` marker stripped.
 *  - `"fail"` -- the routine gave up; `reason` is the remainder after
 *    `fail ` (or `""` for a bare `<PREFIX>:fail` with no reason text).
 *  - `"progress"` -- anything else following the prefix; `text` is the
 *    raw remainder, unmodified, for the caller to render as-is.
 */
export type CalibrationEvent =
  | { kind: "progress"; text: string }
  | { kind: "apply"; snippet: string }
  | { kind: "fail"; reason: string };

const APPLY_MARKER = "apply ";
const FAIL_MARKER = "fail ";

/**
 * Parse one rx-log line against `prefix`'s `<PREFIX>:` shape. Returns
 * `undefined` for anything not starting with that exact marker
 * (leading/trailing whitespace on the line itself is tolerated, mirroring
 * `GET_REPLY_PATTERN`'s `trimStart()` discipline in `CommandStrip.tsx`) --
 * this is "not a calibration line", never an error.
 */
export function parseCalibrationLine(prefix: CalibrationPrefix, line: string): CalibrationEvent | undefined {
  const trimmed = line.trim();
  const marker = `${prefix}:`;
  if (!trimmed.startsWith(marker)) {
    return undefined;
  }
  const remainder = trimmed.slice(marker.length);
  if (remainder.startsWith(APPLY_MARKER)) {
    return { kind: "apply", snippet: remainder.slice(APPLY_MARKER.length) };
  }
  if (remainder === "apply") {
    // A bare "apply" with no snippet text at all -- treat as an empty
    // snippet rather than falling through to "progress", since the
    // caller must never confuse a (malformed) terminal line with an
    // ordinary progress event.
    return { kind: "apply", snippet: "" };
  }
  if (remainder.startsWith(FAIL_MARKER)) {
    return { kind: "fail", reason: remainder.slice(FAIL_MARKER.length) };
  }
  if (remainder === "fail") {
    return { kind: "fail", reason: "" };
  }
  return { kind: "progress", text: remainder };
}
