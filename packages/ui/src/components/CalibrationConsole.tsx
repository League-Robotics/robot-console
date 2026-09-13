/**
 * CalibrationConsole.tsx — ticket 018-013 item 3: "Right below where the
 * code is, put a console where we can see the output from the
 * calibration program" (stakeholder direction, `CalibrationPage.tsx`'s
 * own Calibration tab).
 *
 * Reuses `useLinkLog` (`WsProvider.tsx`) -- the exact same per-link log
 * `DeviceConsole.tsx` reads for its own, unfiltered, view of this link --
 * rather than opening a second WebSocket path or subscribing to some new
 * server-side concept of "calibration traffic". This is a presentation-
 * only filter over the one shared log, the same discipline
 * `DeviceConsole`'s own "Show status polls" toggle already uses.
 *
 * ## What counts as "the calibration program's" traffic
 *
 * - Any report line the firmware itself emits, `<PREFIX>:...` where
 *   `<PREFIX>` is `CAL` followed by any run of letters/digits (`CALX:`,
 *   `CALA:`, and any future calibration routine's own prefix) --
 *   `CalibrationReport.ts`'s own `<PREFIX>:` shape, matched loosely here
 *   since this panel does not know in advance which prefixes a given
 *   robot's firmware uses.
 * - The `RUN <name>` command itself, for any `name` starting with `cal`
 *   -- the `tx` line the host echoes back once it actually writes the
 *   line to the device (`server.ts`), never synthesized by this panel.
 * - The one `ack`/`err` reply immediately following such a line. A
 *   sequenced verb's reply on the wire carries only a bare `<id>`, never
 *   the verb name that provoked it (`protocol.md` S8) -- there is no way
 *   to recognize "this ack/err answers a RUN" from the reply's own text
 *   alone. The one true statement this module can make is positional:
 *   this link has exactly one command in flight at a time (`Session`'s
 *   own pacing), so the entry immediately following a matched `RUN cal*`
 *   tx line is that command's own reply, whatever it says.
 *
 * Everything else on this link -- GET/SET/HELLO/STATUS traffic from the
 * Main tab's `CommandStrip`, e.g. -- is filtered out, even though it
 * lives in the exact same underlying log this panel reads.
 *
 * ## Clear does not touch the shared log
 *
 * `DeviceConsole`'s own "Clear log" empties `logsByLink` for every
 * consumer of this link (its own Main-tab view included) -- calling that
 * here would blank the Main tab's console too. Instead, "Clear" records
 * the next log entry id at click time (`clearedBeforeId`) and the filter
 * also requires `entry.id >= clearedBeforeId` -- the same id-anchored-
 * window technique `DistanceCalibrationWizard`/`RotationCalibrationWizard`
 * already use for their own run-progress windows (`runStartId`), chosen
 * for the same reason: `useLinkLog` is a bounded ring trimmed from the
 * front, so an index-based watermark would drift as old lines are
 * evicted, while an id-based one never does.
 */
import { useEffect, useRef, useState } from "react";
import type { SnapshotLink } from "@robot-console/host/src/wsMessages.js";
import { useLinkLog, type LogEntry } from "../ws/WsProvider";
import "./CalibrationConsole.css";

const REPORT_LINE_PATTERN = /^cal[a-z0-9]*:/i;
const RUN_CAL_TX_PATTERN = /\brun\s+cal\w*\b/i;
const REPLY_PATTERN = /^(ack|err)\b/i;

/**
 * Pure predicate: does `entries[index]` belong on the calibration
 * console -- see this module's doc comment for the three cases this
 * covers. Exported so `CalibrationConsole.test.tsx` can exercise it
 * directly against fixture log slices, mirroring
 * `DistanceCalibrationWizard.tsx`'s own `deriveDistanceCalibrationRun`
 * test discipline.
 */
export function isCalibrationConsoleEntry(entries: readonly LogEntry[], index: number): boolean {
  const entry = entries[index]!;
  const text = entry.line.trim();
  if (REPORT_LINE_PATTERN.test(text)) {
    return true;
  }
  if (entry.direction === "tx" && RUN_CAL_TX_PATTERN.test(text)) {
    return true;
  }
  const previous = entries[index - 1];
  return (
    previous !== undefined &&
    previous.direction === "tx" &&
    RUN_CAL_TX_PATTERN.test(previous.line.trim()) &&
    REPLY_PATTERN.test(text)
  );
}

export interface CalibrationConsoleProps {
  link: SnapshotLink;
}

export function CalibrationConsole({ link }: CalibrationConsoleProps) {
  const log = useLinkLog(link.id);
  const [clearedBeforeId, setClearedBeforeId] = useState(0);
  const logRef = useRef<HTMLDivElement | null>(null);

  const visible = log.filter((entry, index) => entry.id >= clearedBeforeId && isCalibrationConsoleEntry(log, index));

  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [visible.length]);

  function clear(): void {
    const last = log[log.length - 1];
    setClearedBeforeId(last ? last.id + 1 : 0);
  }

  return (
    <section className="calibration-console" aria-label="Calibration output">
      <div className="calibration-console-toolbar">
        <h3>Calibration output</h3>
        <button
          type="button"
          className="calibration-console-clear"
          data-testid="calibration-console-clear"
          onClick={clear}
          disabled={visible.length === 0}
        >
          Clear
        </button>
      </div>
      <div className="calibration-console-log" ref={logRef} data-testid="calibration-console-log">
        {visible.length === 0 ? (
          <p className="calibration-console-empty">No calibration output yet.</p>
        ) : (
          visible.map((entry) => (
            <div
              key={entry.id}
              className={`calibration-console-line calibration-console-line-${entry.direction}`}
              data-testid="calibration-console-line"
            >
              <span className="calibration-console-line-direction" aria-hidden="true">
                {entry.direction === "tx" ? "»" : "«"}
              </span>
              <span className="calibration-console-line-text">{entry.line}</span>
            </div>
          ))
        )}
      </div>
    </section>
  );
}
