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
 * same props each already takes. This component's only job, for now, is
 * to be the one place both are mounted from. It takes `{ link, name }`
 * — "the device currently active for console purposes" — and does not
 * resolve routing or device identity itself; that is its caller's job
 * (`DevicePage.tsx`).
 *
 * ## Deliberately incomplete: relocation only (ticket 002)
 *
 * This ticket is scoped to *relocation only*, per sprint.md's Migration
 * Concerns and this ticket's own Description:
 *
 *  - No collapse/toggle chrome yet (ticket 003) — this always renders
 *    open, at a fixed default height set by `ConsoleDock.css`.
 *  - No drag-resize (ticket 004), no pop-out window (ticket 005), no
 *    route-driven retargeting/teardown for relay bridging (ticket 006).
 *  - **No per-tab console mount is removed by this ticket.** Every page
 *    that already renders `ConsolePane`/`CommandStrip` keeps doing so
 *    unchanged, so the running app shows both the new dock *and* the
 *    old per-tab console at once for several tickets. That is
 *    intentional incremental delivery (verify the dock live before
 *    ticket 007 deletes the old mounts in one clean pass), not a defect
 *    to fix here.
 */
import type { SnapshotLink } from "@robot-console/host/src/wsMessages.js";
import { DeviceConsole } from "../DeviceConsole";
import { CommandStrip } from "../CommandStrip";
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
  return (
    <section className="console-dock" aria-label="Debug console" data-testid="console-dock">
      <DeviceConsole link={link} name={name} />
      <CommandStrip link={link} />
    </section>
  );
}
