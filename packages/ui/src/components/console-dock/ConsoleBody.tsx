/**
 * ConsoleBody.tsx — the log-plus-commands layout shared by the docked
 * console and the popped-out window.
 *
 * ## Why this exists (stakeholder, 2026-09-20)
 *
 * Until now both `ConsoleDock`'s open pane and `PopupConsoleWindow`
 * stacked `DeviceConsole` above `CommandStrip` in a plain column, so
 * every open console spent its bottom third on HELLO / ID / VER /
 * STATUS / FUNCS and the GET/SET name-value form. The stakeholder, on
 * seeing it:
 *
 *   "We don't need that most of the time. Let's move that off to a side
 *    menu... let's just move it off to the right side and try to get it
 *    out of the way. Make it compact. We mostly don't need it much."
 *
 * So the commands become a narrow rail on the RIGHT of the log, hidden
 * by default, revealed by a toggle on the dock's own bar. The log —
 * the thing a student actually watches — gets the whole pane back.
 *
 * ## One component, both containers
 *
 * The dock and the popup are mutually exclusive views of one console
 * (`ConsoleDock`'s pop-out collapses the dock; closing the popup
 * restores it), so they must not drift apart in layout. They did not
 * share a component before because there was nothing to share but two
 * children in a row. Now there is a row/rail arrangement, a responsive
 * rule, and a visibility flag, and duplicating that across two files is
 * exactly how the popped-out console ends up looking subtly unlike the
 * docked one.
 *
 * ## Narrow containers
 *
 * A rail beside the log needs horizontal room. The popped-out window
 * opens at 640px and the student can drag it much narrower, and the
 * dock is as wide as the browser. Below `RAIL_MIN_WIDTH_PX` the rail
 * stops being a rail and becomes a row under the log
 * (`ConsoleBody.css`'s container query), rather than squeezing the log
 * into a column too narrow to read a wire line in — the stakeholder's
 * "if the screen is less than... move it off to the right side and try
 * to get it out of the way" read the way it has to be read once the
 * screen is too small for a side at all.
 */
import type { SnapshotLink } from "@robot-console/host/src/wsMessages.js";
import { DeviceConsole } from "../DeviceConsole";
import { CommandStrip } from "../CommandStrip";
import "./ConsoleBody.css";

export interface ConsoleBodyProps {
  link: SnapshotLink;
  /** Display label, passed straight through to `DeviceConsole`. */
  name: string;
  /** Whether the command rail is showing. Owned by the caller (and
   * persisted, see `useDockPersistence`) rather than held here, because
   * the toggle that flips it lives on the dock's own bar, outside this
   * component's subtree. */
  commandsOpen: boolean;
}

export function ConsoleBody({ link, name, commandsOpen }: ConsoleBodyProps) {
  return (
    <div className="console-body" data-testid="console-body">
      <div className="console-body-log">
        <DeviceConsole link={link} name={name} />
      </div>
      {commandsOpen && (
        // `aside`, not a second `section`: this is supplementary to the
        // log next to it, which is the page's actual subject. The
        // accessible name matters more than usual here because the rail
        // is hidden by default -- a screen-reader user who turns it on
        // should hear what arrived.
        <aside className="console-body-commands" aria-label="Commands" data-testid="console-body-commands">
          <CommandStrip link={link} />
        </aside>
      )}
    </div>
  );
}
