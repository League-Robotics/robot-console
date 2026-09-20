/**
 * ConsoleDock.tsx — the one console for a device page (sprint 022
 * ticket 002, SUC-001; sprint.md Architecture §Step 3, module 1).
 *
 * ## Why this exists as its own component
 *
 * Before this sprint the console was six separate mount sites
 * (`ConsolePane` wrapping `DeviceConsole`, once each in `RobotPage`'s
 * Main tab, `RelayPage`, `UnknownDevicePage`, `DriveTab`,
 * `CalibrationPage`, `ConfigurationPage`), each with its own local
 * toolbar state (autoscroll/show-polls/draft) that reset on every tab
 * switch even though the underlying log survives in `WsProvider`
 * (`useLinkLog`). The stakeholder's own word for the result was
 * "visually noisy." `ConsoleDock` exists so there is exactly one place
 * that mounts `DeviceConsole`/`CommandStrip` for a device page,
 * regardless of which tab is showing — a single mount cannot reset on
 * tab switch because it never unmounts across one.
 *
 * `ConsoleDock` itself owns none of that behavior — `DeviceConsole`
 * (log, toolbar, `SequencingIndicator`, send box) and `CommandStrip`
 * (HELLO/ID/VER/STATUS/FUNCS, GET/SET) are rendered here **unchanged**,
 * same props each already takes. This component's only job is to be the
 * one place both are mounted from, plus (as of ticket 003) the chrome
 * around them. It takes `{ link, name }` — "the device currently active
 * for console purposes" — and does not resolve routing or device
 * identity itself; that is its caller's job (`DevicePage.tsx`).
 *
 * ## Ticket 003: collapse/toggle chrome, persisted, with a quiet indicator
 *
 * The stakeholder's own words for the target shape: "let's reformat the
 * console so that it always runs at the bottom, is always full width,
 * and is always toggleable... If I open the toggle button, it opens the
 * bottom section to 10 lines or so. If I click the toggle button again,
 * it collapses it back down." This ticket builds exactly that:
 *
 *  - A bar labelled "Debug Console" is **always** rendered (this is
 *    what makes the dock "never disappear" per SUC-001) with a toggle
 *    control. Collapsed, nothing else renders — no log, no toolbar, no
 *    send box, per this ticket's own Acceptance Criteria.
 *  - Toggling open reveals the unchanged `DeviceConsole`/`CommandStrip`
 *    pair at a persisted (or default, `DEFAULT_DOCK_HEIGHT_PX`) height.
 *  - Open/collapsed state round-trips through `useDockPersistence`
 *    (see that module's own doc comment for why height rides along in
 *    the same stored shape even though nothing here can change it yet
 *    — ticket 004's drag handle is the first writer of `heightPx`).
 *  - The collapsed bar carries a quiet indicator sourced from
 *    `useLinkNotices()` (the same "worth surfacing" mechanism
 *    `FrontPage.tsx` already uses), lit only for a `warn`/`error`-level
 *    notice on *this* link — never a numeric `seq`/`pending` count,
 *    which the stakeholder explicitly called out as visual noise on the
 *    current calibration screen (sprint.md's Design Rationale). A
 *    collapsed console that silently hides a real error would be its
 *    own failure; this is the one thing the collapsed bar is allowed to
 *    say without becoming noisy again.
 *
 * ## Still deliberately incomplete after this ticket
 *
 * No drag-resize (ticket 004), no pop-out window (ticket 005), no
 * route-driven retargeting/teardown for relay bridging (ticket 006).
 * **No per-tab console mount is removed by this ticket** — every page
 * that already renders `ConsolePane`/`CommandStrip` keeps doing so
 * unchanged, so the running app shows both the dock and the old per-tab
 * console at once until ticket 007's single clean removal pass. That is
 * intentional incremental delivery (sprint.md's Migration Concerns), not
 * a defect to fix here.
 */
import { useCallback } from "react";
import type { SnapshotLink } from "@robot-console/host/src/wsMessages.js";
import { DeviceConsole } from "../DeviceConsole";
import { CommandStrip } from "../CommandStrip";
import { useLinkNotices } from "../../ws/WsProvider";
import { useDockPersistence } from "./useDockPersistence";
import "./ConsoleDock.css";

export interface ConsoleDockProps {
  /** The device currently active for console purposes. The caller
   * (`DevicePage.tsx`) resolves this from the route; `ConsoleDock`
   * itself has no opinion about routing or relay bridging. */
  link: SnapshotLink;
  /** Display label passed straight through to `DeviceConsole`/
   * `CommandStrip`'s own "No link open to …" hints. */
  name: string;
}

export function ConsoleDock({ link, name }: ConsoleDockProps) {
  const [{ open, heightPx }, updateDockState] = useDockPersistence();
  const linkNotices = useLinkNotices();
  const notice = linkNotices.get(link.id);
  // Bench defect 010 addendum's `LinkNotice.level` is already
  // `"info" | "warn" | "error"` (`WsProvider.tsx`) -- `"info"` is
  // deliberately excluded here. An `"info"`-level notice (e.g. a
  // routine state change) lighting up the collapsed bar would be
  // exactly the noise the stakeholder asked this indicator to avoid;
  // only `warn`/`error` clears the "worth surfacing while collapsed"
  // bar this ticket sets.
  const showIndicator = notice !== undefined && (notice.level === "warn" || notice.level === "error");

  const toggleOpen = useCallback(() => {
    updateDockState({ open: !open });
  }, [open, updateDockState]);

  return (
    <section className="console-dock" aria-label="Debug console" data-testid="console-dock">
      <div className="console-dock-bar">
        <span className="console-dock-title">Debug Console</span>
        {showIndicator && (
          <span
            className={`console-dock-indicator console-dock-indicator-${notice!.level}`}
            data-testid="console-dock-indicator"
            role="status"
            aria-label={`Debug console has a ${notice!.level}: ${notice!.text}`}
            title={notice!.text}
          />
        )}
        <button
          type="button"
          className="console-dock-toggle"
          data-testid="console-dock-toggle"
          aria-expanded={open}
          onClick={toggleOpen}
        >
          {open ? "Hide ▾" : "Show ▸"}
        </button>
      </div>
      {open && (
        <div className="console-dock-pane" data-testid="console-dock-pane" style={{ height: heightPx }}>
          <DeviceConsole link={link} name={name} />
          <CommandStrip link={link} />
        </div>
      )}
    </section>
  );
}
