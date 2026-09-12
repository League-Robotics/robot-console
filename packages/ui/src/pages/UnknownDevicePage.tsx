/**
 * UnknownDevicePage.tsx — `/d/:linkId` for a link with no owning device
 * (sprint 015 ticket 008; SUC-002, SUC-003, SUC-004), including
 * `DevicePage`'s own "no device owns this link" dispatch arm -- the
 * direct successor of the retired `"unknown"` classification (a board
 * that has not yet identified has no `devices` row at all under the
 * `Snapshot` contract; it is listed bare in `Snapshot.unassigned`
 * instead -- see `DevicePage.tsx`'s own doc comment).
 *
 * This is the page that gets real exercise on the current bench: every
 * attached micro:bit classifies as unidentified today (no board
 * announces after a flash -- `flash-succeeds-but-board-never-
 * announces.md`), so this is where a student actually goes to recover a
 * device.
 *
 * A thin wrapper (ticket 012-002, migrated to the `Snapshot` contract by
 * ticket 008): header, the link's own failure reason (when its state is
 * `failed`/`unresponsive`), the shared `FlashDialog` (which decides for
 * itself, via `canBeFlashed`, whether it offers a "Flash" trigger at
 * all), and `DeviceConsole`. This page owns no flash logic of its own --
 * the release/local-hex flows, progress rendering, and post-flash
 * navigation all live in `../components/FlashControls.tsx`, run inside
 * the popup modal `../components/FlashDialog.tsx` owns, shared with the
 * front-page card and the app header's Flash entry.
 */
import type { SnapshotLink } from "@robot-console/host/src/wsMessages.js";
import { FlashDialog } from "../components/FlashDialog";
import { DeviceConsole } from "../components/DeviceConsole";
import "./UnknownDevicePage.css";

export interface UnknownDevicePageProps {
  link: SnapshotLink;
}

export function UnknownDevicePage({ link }: UnknownDevicePageProps) {
  const showReason = (link.state === "failed" || link.state === "unresponsive") && link.reason;

  return (
    <section className="unknown-device-page" aria-label="Unknown device">
      <h2>{link.label}</h2>

      {showReason && <p className="device-note">Link attempt: {link.reason}</p>}

      <FlashDialog link={link} name={link.label} />

      <DeviceConsole link={link} name={link.label} />
    </section>
  );
}
