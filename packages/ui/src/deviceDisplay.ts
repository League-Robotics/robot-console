/**
 * deviceDisplay.ts — presentational helpers for rendering a
 * `SnapshotDevice`/`SnapshotLink` (sprint 015 ticket 007: migrated off
 * the retired `EndpointListEntry`), shared across the front page and
 * every per-device page.
 *
 * ## Ticket 007: device/link split
 *
 * `EndpointListEntry` folded a device's identity, its one connection,
 * and that connection's session state into one flat object -- `name`
 * could be `null` (naming not yet resolved or failed), and
 * `sessionError` doubled as an "unresponsive" signal. Under the new
 * `Snapshot` contract, `devices[]` only ever lists an *identified*
 * device (`SnapshotDevice.name` is always a resolved string --
 * `devices.name`, `deviceIdToName(id)`, never absent); a board that
 * hasn't identified yet has no device row at all, and shows up in
 * `Snapshot.unassigned` as a bare `SnapshotLink` with no name to
 * display -- so `nameDisplay`'s old "flagged"/"Naming…" states have no
 * device-level equivalent any more. `roleDisplay`'s old
 * `sessionError`-driven "Unresponsive" case moves the same way: link
 * reachability (`state`/`reason`) is now a per-`SnapshotLink` concept,
 * rendered by `FrontPage.tsx`'s own `linkStatusText`, not folded into a
 * device's role text.
 */
import type { FirmwareAvailability, FirmwareKind, FlashPhase, SnapshotDevice, SnapshotLink } from "@robot-console/host/src/wsMessages.js";

/** A device's display name. `SnapshotDevice.name` is always a resolved
 * string (see this module's doc comment), so this is never anything
 * but that name -- the `{ text, flagged }` shape is kept (rather than
 * returning a bare string) only so a future caller that still expects
 * this wrapper (ticket 008/009's per-device pages) doesn't need to
 * change its own destructuring, not because `flagged` can ever be
 * `true` for an identified device any more. */
export function nameDisplay(device: SnapshotDevice): { text: string; flagged: boolean } {
  return { text: device.name, flagged: false };
}

/** A device's role text: the announced `role`, or a calm "not yet
 * announced" placeholder. The old `sessionError`-driven "Unresponsive"
 * branch has no device-level equivalent -- see this module's doc
 * comment. */
export function roleDisplay(device: SnapshotDevice): string {
  return device.role ?? "No role announced";
}

/** Whether `device.program` marks it as a calibration build --
 * `SnapshotDevice` carries `program`/`version` directly (no
 * `classification.type` field any more; that concept was folded into
 * `kind: "robot" | "relay"` plus these two strings), so this is now a
 * simple prefix check rather than a read of a pre-computed
 * classification. Mirrors the pre-ticket-007 `classification.type ===
 * "calibration"` rule (a program name prefixed `calibration-`). */
export function isCalibrationProgram(program: string | null): boolean {
  return program !== null && program.startsWith("calibration-");
}

/** Whether a link is eligible for the flash controls -- now a direct
 * read of the host-computed `SnapshotLink.capabilities.flash`
 * (`projection.ts`: true for any `usb` link, regardless of whether its
 * owning device has identified) rather than a UI-side `role === null`
 * guess. Renamed input only (`link`, not `device`) -- flashability is a
 * per-link capability under the new contract, since a device can have
 * several links (only its `usb` one is ever flashable) and an
 * unidentified board (no device at all) is still flashable. */
export function canBeFlashed(link: SnapshotLink): boolean {
  return link.capabilities.flash;
}

/** Turn one firmware's live availability into either `null` (button
 * enabled) or a short, student-facing explanation of why it isn't --
 * never a hardcoded flag, always derived from the live
 * `firmwareStatus` the server polls and pushes (see `WsProvider`'s
 * `firmwareStatus` doc comment). Phrased as what the student should do
 * next -- not an engineer-facing error code. */
export function firmwareDisabledReason(availability: FirmwareAvailability | undefined): string | null {
  if (!availability || !availability.configured) {
    return "Not set up for this classroom yet — ask your instructor.";
  }
  if (availability.available) {
    return null;
  }
  switch (availability.reason) {
    case "not-yet-checked":
      // Poll hasn't completed yet -- must read as "still loading", not
      // "broken" or "permanently unavailable".
      return "Checking whether this firmware is available…";
    case "no-releases":
      return "No build has been published yet — ask your instructor when one's ready.";
    case "tag-not-found":
    case "no-asset":
      return "The configured build can't be found — ask your instructor to check the setup.";
    case "network":
      return "Couldn't check for firmware just now — try again in a moment.";
    default:
      return "This firmware isn't available right now.";
  }
}

/**
 * The instructor-facing counterpart to {@link firmwareDisabledReason}
 * (out-of-process, 2026-09-08): a diagnosable failure -- which repo/tag
 * was checked, and `releases.ts`'s specific `resolveRelease` message
 * (e.g. `"release v0.20260909.1 is missing MICROBIT.hex"`) -- for
 * whoever is troubleshooting *why* a build isn't showing up, since
 * {@link firmwareDisabledReason}'s calm, deliberately generic student
 * text ("ask your instructor") is not that.
 *
 * Returns `null` whenever there is nothing more specific to add than the
 * student-facing line already says: firmware not configured at all, a
 * live (`available: true`) firmware, or the pre-poll `"not-yet-checked"`
 * placeholder (never ran a real check, so it has no diagnostic detail).
 * Callers should render this *alongside*, never *instead of*,
 * {@link firmwareDisabledReason}'s text -- see this module's own doc
 * comment and `FlashControls.tsx`'s disclosure for where it's shown.
 */
export function firmwareDiagnosticDetail(availability: FirmwareAvailability | undefined): string | null {
  if (!availability || !availability.configured || availability.available) {
    return null;
  }
  if (availability.message === undefined) {
    return null;
  }
  return `Checked ${availability.repoUrl} (tag: ${availability.tag}): ${availability.message}`;
}

/** Student-facing label for a configured release firmware kind. */
export const FIRMWARE_LABEL: Record<FirmwareKind, string> = {
  relay: "relay",
  robot: "robot",
};

/** Student-facing label for one stage of an in-flight flash. */
export const PHASE_LABEL: Record<FlashPhase, string> = {
  fetching: "downloading",
  verifying: "verifying",
  erasing: "erasing",
  writing: "writing",
  resetting: "resetting",
  reidentifying: "waiting for the board to come back",
};
