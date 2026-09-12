/**
 * lineClass.ts — the one rx-line style classifier (ticket 017-007;
 * `docs/reviews/2026-09-11/04-ui.md` §4, "Console line classification
 * (`classifyLine`)"), moved here from `DeviceConsole.tsx`'s own former
 * local copy (its original doc comment: "worth reflecting in the
 * display" list).
 *
 * This never hides or filters a line -- every line the host forwarded is
 * still shown by whatever renders it -- it only picks which style class
 * to draw a line with (comment / debug / error / ack / plain data).
 *
 * **Not the same job as `CommandStrip.tsx`'s `GET_REPLY_PATTERN` or
 * `DistanceCalibrationWizard.tsx`'s `RUN_ERR_REPLY_PATTERN`.** Both of
 * those are their own narrow, purpose-specific prefix matches over the
 * same rx text -- `GET_REPLY_PATTERN` captures a field *name* out of a
 * `get <name> <value>` reply (this classifier has no notion of
 * "capture a name"), and `RUN_ERR_REPLY_PATTERN` deliberately matches
 * only a bare `err` reply to a `RUN` command, never `nack` (unlike this
 * classifier's `"error"` kind, which loosely matches `err` *or* `nack`
 * for display purposes). Routing either of those two through this
 * classifier's `"error"` kind would silently broaden what they match
 * (a `nack` line now also read as a rejected `RUN`) -- a real behavior
 * change this ticket's "pure extraction, parity not redesign" mandate
 * forbids. They stay their own regexes; this module is only the one
 * true duplicate (`DeviceConsole`'s own line-style classification).
 */

export type LineKind = "comment" | "debug" | "error" | "ack" | "data";

/** Presentation-only classification of a raw line. */
export function classifyLine(line: string): LineKind {
  const text = line.trimStart();
  if (text.startsWith("#")) {
    return "comment";
  }
  if (text.startsWith("DBG:")) {
    return "debug";
  }
  if (/^(err|nack)\b/i.test(text)) {
    return "error";
  }
  if (/^ack\b/i.test(text)) {
    return "ack";
  }
  return "data";
}
